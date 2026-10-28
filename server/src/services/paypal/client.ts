// PayPal REST client for Node 18+ (global fetch, no dependencies).
// Covers: sandbox/live access tokens (cached, refreshed on 401), creating Orders
// v2 with an approval link the frontend can redirect to, and capturing them.
//
// Design rules this file enforces:
//  - one failure type (PayPalError) with a stable `kind`, the PayPal `debugId`
//    for support tickets, and a `userMessage` that is safe to show in a UI
//  - retries only where they cannot double-charge: GETs, and POSTs that carry a
//    PayPal-Request-Id (PayPal replays the original response for a repeated id)
//  - amounts are INTEGER MINOR UNITS in, decimal strings out, never floats
//  - secrets and bearer tokens never appear in errors or logs

import { randomUUID } from "node:crypto";

export type PayPalEnv = "sandbox" | "live";

export type PayPalErrorKind =
  | "config" // missing/invalid credentials or client misuse
  | "auth" // token request or token rejected
  | "permission" // 403: the app lacks a capability
  | "validation" // 400: our request body was wrong
  | "not_found"
  | "not_approved" // capture before the buyer approved
  | "already_captured"
  | "payer_action" // buyer must fix their funding source / retry approval
  | "declined"
  | "rate_limited"
  | "server" // PayPal 5xx or non-JSON gateway error
  | "network" // DNS, connection reset, timeout
  | "unknown";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly kind: PayPalErrorKind,
    readonly status: number | null,
    /** PayPal `debug_id`, quote it when contacting PayPal support. */
    readonly debugId: string | null = null,
    /** PayPal issue code such as INSTRUMENT_DECLINED, when present. */
    readonly issue: string | null = null,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = "PayPalError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server" || this.kind === "network";
  }

  /** Safe for end users: no internals, no credentials, no raw PayPal text. */
  get userMessage(): string {
    switch (this.kind) {
      case "declined":
      case "payer_action":
        return "PayPal could not complete this payment. Please try another funding source.";
      case "not_approved":
        return "The payment was not approved yet. Please return to PayPal and approve it.";
      case "already_captured":
        return "This payment has already been completed.";
      case "rate_limited":
      case "server":
      case "network":
        return "PayPal is temporarily unavailable. Please try again in a moment.";
      default:
        return "We couldn't start this payment. Please try again later.";
    }
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env?: PayPalEnv; // default "sandbox"
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for retry-safe requests only. Default 2. */
  maxRetries?: number;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CreateOrderInput {
  /** Total in minor units (1250 = 12.50). Positive integer. */
  amountMinor: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** Your own id for this payment (a settlement id). Echoed back by PayPal. */
  referenceId: string;
  description?: string;
  /** Where PayPal sends the buyer after approving / cancelling. Must be https (http://localhost allowed in sandbox). */
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
  /**
   * Send the money to this PayPal account instead of the app's own merchant
   * account. Needs special permissions; see docs/decisions/0001-settlement-money-flow.md.
   */
  payeeEmail?: string;
  /**
   * Idempotency key for this logical payment, e.g. `settlement:${id}`. Reusing
   * it makes a repeated call return the original order instead of a new one.
   * If omitted a random one is used, which protects only the internal retries.
   */
  requestId?: string;
}

export interface CreatedOrder {
  orderId: string;
  /** CREATED or PAYER_ACTION_REQUIRED. */
  status: string;
  /** Send the buyer here. Always an https paypal.com URL. */
  approvalUrl: string;
}

export interface CaptureResult {
  orderId: string;
  /** Order status, COMPLETED when the money moved. */
  status: string;
  captureId: string | null;
  /** Status of the capture itself; COMPLETED, PENDING, DECLINED... Check this, not just `status`. */
  captureStatus: string | null;
  /** Decimal string exactly as PayPal reports it, e.g. "12.50". */
  amount: string | null;
  currency: string | null;
  referenceId: string | null;
  /** True when the order had already been captured and we just read its state. */
  alreadyCaptured: boolean;
}

export interface PayoutInput {
  /** Recipient's PayPal email. */
  receiverEmail: string;
  amountMinor: number;
  currency: string;
  /** Your id for this batch, unique for 30 days. Doubles as the idempotency key. */
  batchId: string;
  /** Shown in the recipient's notification. */
  note?: string;
  emailSubject?: string;
}

export interface PayoutBatch {
  batchId: string;
  /** PENDING, PROCESSING, SUCCESS, DENIED, CANCELED... as reported by PayPal. */
  status: string;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Currencies PayPal takes with no decimal places. */
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);

/** 1250,"USD" -> "12.50"; 1200,"JPY" -> "1200". PayPal wants a string, not a number. */
export function formatAmount(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PayPalError(`amountMinor must be a positive integer, got ${String(amountMinor)}`, "config", null);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PayPalError(`currency must be an upper-case ISO 4217 code, got ${String(currency)}`, "config", null);
  }
  if (ZERO_DECIMAL.has(currency)) return String(amountMinor);
  const s = String(amountMinor).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Response parsing helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

interface PayPalLink {
  href?: string;
  rel?: string;
  method?: string;
}

/**
 * The link the buyer must visit. Orders created with `payment_source.paypal`
 * (what createOrder sends) return rel "payer-action"; orders created the older
 * way return rel "approve". Accept either, and refuse any URL that is not
 * https on paypal.com, so a malformed or tampered response can never turn into
 * an open redirect on our own site.
 */
export function extractApprovalUrl(links: unknown): string {
  const list = Array.isArray(links) ? (links as PayPalLink[]) : [];
  const link = list.find((l) => l?.rel === "payer-action") ?? list.find((l) => l?.rel === "approve");
  if (!link?.href) throw new PayPalError("order response has no payer-action or approve link", "unknown", null);
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    throw new PayPalError("approval link is not a valid URL", "unknown", null);
  }
  const hostOk = url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com");
  if (url.protocol !== "https:" || !hostOk) {
    throw new PayPalError(`approval link points at an unexpected host: ${url.hostname}`, "unknown", null);
  }
  return url.toString();
}

const ISSUE_KIND: Record<string, PayPalErrorKind> = {
  ORDER_NOT_APPROVED: "not_approved",
  ORDER_ALREADY_CAPTURED: "already_captured",
  INSTRUMENT_DECLINED: "declined",
  PAYER_ACTION_REQUIRED: "payer_action",
  TRANSACTION_REFUSED: "declined",
  PAYER_CANNOT_PAY: "declined",
  RATE_LIMIT_REACHED: "rate_limited",
};

/** Turn a non-2xx PayPal response (parsed JSON or null) into a PayPalError. */
export function toPayPalError(status: number, body: any, debugHeader: string | null = null): PayPalError {
  const debugId: string | null = body?.debug_id ?? debugHeader ?? null;
  const details: unknown[] = Array.isArray(body?.details) ? body.details : [];
  const issue: string | null = (details as any[]).find((d) => typeof d?.issue === "string")?.issue ?? null;
  // Token endpoint errors look like {error, error_description}; REST errors like {name, message, details}.
  const code: string = body?.name ?? body?.error ?? "UNKNOWN";
  const text: string = body?.message ?? body?.error_description ?? `HTTP ${status}`;
  const message = `PayPal ${status} ${code}${issue ? ` (${issue})` : ""}: ${text}`;

  let kind: PayPalErrorKind;
  if (issue && ISSUE_KIND[issue]) kind = ISSUE_KIND[issue];
  else if (status === 401) kind = "auth";
  else if (status === 403) kind = "permission";
  else if (status === 404) kind = "not_found";
  else if (status === 429) kind = "rate_limited";
  else if (status >= 500) kind = "server";
  else if (status === 400 || status === 422) kind = "validation";
  else kind = "unknown";
  return new PayPalError(message, kind, status, debugId, issue, details);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BASE_URL: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

const ORDER_ID = /^[A-Za-z0-9-]{8,40}$/;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function createPayPalClient(config: PayPalConfig) {
  if (!config.clientId?.trim() || !config.clientSecret?.trim()) {
    throw new PayPalError("PayPal clientId and clientSecret are required", "config", null);
  }
  const env: PayPalEnv = config.env ?? "sandbox";
  const base = BASE_URL[env];
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxRetries = config.maxRetries ?? 2;
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<{ res: Response; text: string }> {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return { res, text: await res.text() };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new PayPalError(timedOut ? `PayPal request timed out after ${timeoutMs}ms` : "could not reach PayPal", "network", null);
    }
  }

  const parse = (text: string): any => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  async function fetchToken(): Promise<string> {
    const { res, text } = await send(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = parse(text);
    if (!res.ok) {
      const err = toPayPalError(res.status, body);
      // A 401 here almost always means wrong or mismatched credentials; say so.
      if (res.status === 401) {
        throw new PayPalError(
          `${err.message}. Check PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET and that they belong to the ${env} environment`,
          "auth", 401, err.debugId, err.issue, err.details,
        );
      }
      throw err;
    }
    if (typeof body?.access_token !== "string" || typeof body?.expires_in !== "number") {
      throw new PayPalError("token response was missing access_token or expires_in", "server", res.status);
    }
    // Refresh a minute early so a token never expires mid-request.
    cached = { token: body.access_token, expiresAt: now() + Math.max(0, body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  /** Cached token; concurrent callers share one in-flight request. */
  function getAccessToken(): Promise<string> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.token);
    inflight ??= fetchToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; requestId?: string } = {},
  ): Promise<any> {
    // A POST is only safe to repeat if PayPal can de-duplicate it.
    const retrySafe = method === "GET" || Boolean(opts.requestId);
    let attempt = 0;
    let refreshedToken = false;
    for (;;) {
      const token = await getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

      let result: { res: Response; text: string };
      try {
        result = await send(`${base}${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (err) {
        if (retrySafe && attempt < maxRetries) {
          await sleep(backoff(attempt++));
          continue;
        }
        throw err;
      }

      const { res, text } = result;
      if (res.ok) {
        const body = parse(text);
        if (body === null) throw new PayPalError("PayPal returned a success status with an unreadable body", "server", res.status);
        return body;
      }
      if (res.status === 401 && !refreshedToken) {
        // Token expired or revoked early: drop it and try once with a fresh one.
        cached = null;
        refreshedToken = true;
        continue;
      }
      if (RETRY_STATUS.has(res.status) && retrySafe && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
        attempt++;
        continue;
      }
      throw toPayPalError(res.status, parse(text), res.headers.get("paypal-debug-id"));
    }
  }

  const backoff = (attempt: number) => 250 * 2 ** attempt + Math.floor(Math.random() * 100);

  const assertOrderId = (id: string) => {
    if (!ORDER_ID.test(id)) throw new PayPalError(`invalid PayPal order id: ${String(id).slice(0, 50)}`, "validation", null);
  };

  function summarizeCapture(order: any, alreadyCaptured: boolean): CaptureResult {
    const unit = order?.purchase_units?.[0];
    const cap = unit?.payments?.captures?.[0];
    return {
      orderId: String(order?.id ?? ""),
      status: String(order?.status ?? "UNKNOWN"),
      captureId: cap?.id ?? null,
      captureStatus: cap?.status ?? null,
      amount: cap?.amount?.value ?? null,
      currency: cap?.amount?.currency_code ?? null,
      referenceId: unit?.reference_id ?? null,
      alreadyCaptured,
    };
  }

  async function getOrder(orderId: string): Promise<any> {
    assertOrderId(orderId);
    return request("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const value = formatAmount(input.amountMinor, input.currency);
    if (!input.referenceId?.trim()) throw new PayPalError("referenceId is required", "config", null);
    for (const [name, url] of [["returnUrl", input.returnUrl], ["cancelUrl", input.cancelUrl]] as const) {
      const ok = /^https:\/\//.test(url ?? "") || (env === "sandbox" && /^http:\/\/localhost(:\d+)?\//.test(url ?? ""));
      if (!ok) throw new PayPalError(`${name} must be an https URL`, "config", null);
    }
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId.slice(0, 256),
          // PayPal rejects over-long text outright, so trim instead of failing a payment.
          ...(input.description ? { description: input.description.slice(0, 127) } : {}),
          amount: { currency_code: input.currency, value },
          ...(input.payeeEmail ? { payee: { email_address: input.payeeEmail } } : {}),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            ...(input.brandName ? { brand_name: input.brandName.slice(0, 127) } : {}),
          },
        },
      },
    };
    // Fixed for the whole call, so internal retries reuse it.
    const requestId = input.requestId ?? randomUUID();
    const order = await request("POST", "/v2/checkout/orders", { body, requestId });
    if (typeof order?.id !== "string") throw new PayPalError("order response had no id", "server", null);
    return { orderId: order.id, status: String(order.status), approvalUrl: extractApprovalUrl(order.links) };
  }

  async function captureOrder(orderId: string, opts: { requestId?: string } = {}): Promise<CaptureResult> {
    assertOrderId(orderId);
    try {
      const order = await request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        body: {},
        requestId: opts.requestId ?? `capture:${orderId}`,
      });
      return summarizeCapture(order, false);
    } catch (err) {
      // A buyer double-clicking, or a retried return URL, lands here. The money
      // already moved, so report the real state instead of surfacing a failure.
      if (err instanceof PayPalError && err.kind === "already_captured") {
        return summarizeCapture(await getOrder(orderId), true);
      }
      throw err;
    }
  }

  /** Send money from the app's PayPal balance to a PayPal email (Payouts API). One recipient per batch. */
  async function sendPayout(input: PayoutInput): Promise<PayoutBatch> {
    const value = formatAmount(input.amountMinor, input.currency);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.receiverEmail ?? "")) {
      throw new PayPalError("receiverEmail is not a valid email address", "config", null);
    }
    if (!input.batchId?.trim()) throw new PayPalError("batchId is required", "config", null);
    const body = {
      sender_batch_header: {
        sender_batch_id: input.batchId,
        email_subject: (input.emailSubject ?? "You have a payment").slice(0, 255),
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: input.receiverEmail,
          amount: { currency: input.currency, value },
          sender_item_id: input.batchId,
          ...(input.note ? { note: input.note.slice(0, 4000) } : {}),
        },
      ],
    };
    // Repeating a batch id is how PayPal de-duplicates, which makes retries safe.
    const res = await request("POST", "/v1/payments/payouts", { body, requestId: input.batchId });
    const id = res?.batch_header?.payout_batch_id;
    if (typeof id !== "string") throw new PayPalError("payout response had no payout_batch_id", "server", null);
    return { batchId: id, status: String(res.batch_header.batch_status ?? "UNKNOWN") };
  }

  async function getPayout(payoutBatchId: string): Promise<PayoutBatch> {
    assertOrderId(payoutBatchId);
    const res = await request("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
    return { batchId: payoutBatchId, status: String(res?.batch_header?.batch_status ?? "UNKNOWN") };
  }

  return { getAccessToken, createOrder, captureOrder, getOrder, sendPayout, getPayout };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
