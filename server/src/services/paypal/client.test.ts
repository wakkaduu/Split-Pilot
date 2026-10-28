// Run with: npx tsx --test paypal-client.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { PayPalError, createPayPalClient, extractApprovalUrl, formatAmount, toPayPalError } from "./client.ts";

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; throws?: Error };

/** Fake fetch: replies are consumed in order; the last one repeats. */
function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const TOKEN: Reply = { body: { access_token: "TOK1", token_type: "Bearer", expires_in: 32400 } };
const ORDER_OK: Reply = {
  status: 201,
  body: {
    id: "5O190127TN364715T",
    status: "PAYER_ACTION_REQUIRED",
    links: [
      { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" },
      { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "payer-action", method: "GET" },
    ],
  },
};
const ORDER_INPUT = {
  amountMinor: 1250,
  currency: "USD",
  referenceId: "settlement-42",
  description: "Settle trip balance",
  returnUrl: "https://app.example.com/paypal/return",
  cancelUrl: "https://app.example.com/paypal/cancel",
  requestId: "settlement:42",
};
const mk = (replies: Reply[], extra: object = {}) => {
  const ff = fakeFetch(replies);
  const sleeps: number[] = [];
  const client = createPayPalClient({
    clientId: "CID", clientSecret: "s3cr3t-value-xyz", fetch: ff.f, sleep: async (ms) => void sleeps.push(ms), ...extra,
  });
  return { ...ff, sleeps, client };
};
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

test("token request is shaped the way PayPal expects, and is cached", async () => {
  const { client, calls } = mk([TOKEN]);
  assert.equal(await client.getAccessToken(), "TOK1");
  assert.equal(await client.getAccessToken(), "TOK1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
  assert.equal(calls[0]!.init.headers.Authorization, `Basic ${Buffer.from("CID:s3cr3t-value-xyz").toString("base64")}`);
  assert.equal(calls[0]!.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0]!.init.body, "grant_type=client_credentials");
});

test("token is refreshed after it expires (with a one-minute safety margin)", async () => {
  let t = 0;
  const { client, calls } = mk([TOKEN, { body: { access_token: "TOK2", expires_in: 32400 } }], { now: () => t });
  assert.equal(await client.getAccessToken(), "TOK1");
  t = (32400 - 61) * 1000;
  assert.equal(await client.getAccessToken(), "TOK1");
  t = (32400 - 59) * 1000;
  assert.equal(await client.getAccessToken(), "TOK2");
  assert.equal(calls.length, 2);
});

test("concurrent callers share one token request", async () => {
  const { client, calls } = mk([TOKEN]);
  const tokens = await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
  assert.deepEqual(tokens, ["TOK1", "TOK1", "TOK1"]);
  assert.equal(calls.length, 1);
});

test("bad credentials give an auth error that points at the cause and leaks no secret", async () => {
  const { client } = mk([{ status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } }]);
  await assert.rejects(client.getAccessToken(), (e: PayPalError) => {
    assert.equal(e.kind, "auth");
    assert.equal(e.status, 401);
    assert.match(e.message, /PAYPAL_CLIENT_ID/);
    assert.ok(!e.message.includes("s3cr3t-value-xyz") && !e.userMessage.includes("s3cr3t-value-xyz"));
    return true;
  });
});

test("malformed token response is an error, not a crash", async () => {
  const { client } = mk([{ body: { token_type: "Bearer" } }]);
  await assert.rejects(client.getAccessToken(), (e: PayPalError) => e.kind === "server");
});

test("createOrder sends the right body and returns the payer-action link", async () => {
  const { client, calls } = mk([TOKEN, ORDER_OK]);
  const r = await client.createOrder(ORDER_INPUT);
  assert.deepEqual(r, {
    orderId: "5O190127TN364715T",
    status: "PAYER_ACTION_REQUIRED",
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
  });
  const call = calls[1]!;
  assert.equal(call.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders");
  assert.equal(call.init.headers.Authorization, "Bearer TOK1");
  assert.equal(call.init.headers["PayPal-Request-Id"], "settlement:42");
  const b = bodyOf(call);
  assert.equal(b.intent, "CAPTURE");
  assert.deepEqual(b.purchase_units[0].amount, { currency_code: "USD", value: "12.50" });
  assert.equal(b.purchase_units[0].reference_id, "settlement-42");
  assert.equal(b.payment_source.paypal.experience_context.return_url, ORDER_INPUT.returnUrl);
  assert.equal(b.payment_source.paypal.experience_context.user_action, "PAY_NOW");
});

test("zero-decimal currencies and long descriptions are handled", async () => {
  const { client, calls } = mk([TOKEN, ORDER_OK]);
  await client.createOrder({ ...ORDER_INPUT, amountMinor: 1200, currency: "JPY", description: "x".repeat(300) });
  const b = bodyOf(calls[1]!);
  assert.equal(b.purchase_units[0].amount.value, "1200");
  assert.equal(b.purchase_units[0].description.length, 127);
});

test("formatAmount: strings, never floats; rejects bad input", () => {
  assert.equal(formatAmount(1250, "USD"), "12.50");
  assert.equal(formatAmount(5, "USD"), "0.05");
  assert.equal(formatAmount(100000, "EUR"), "1000.00");
  assert.equal(formatAmount(1200, "JPY"), "1200");
  for (const bad of [0, -5, 12.5, Number.NaN, 2 ** 60]) assert.throws(() => formatAmount(bad, "USD"), PayPalError);
  assert.throws(() => formatAmount(100, "usd"), PayPalError);
});

test("extractApprovalUrl: accepts payer-action or approve, refuses foreign hosts and http", () => {
  const link = (href: string, rel: string) => [{ href, rel }];
  assert.equal(extractApprovalUrl(link("https://www.paypal.com/checkoutnow?token=A", "approve")), "https://www.paypal.com/checkoutnow?token=A");
  assert.throws(() => extractApprovalUrl(link("https://evil.example.com/paypal.com", "payer-action")), /unexpected host/);
  assert.throws(() => extractApprovalUrl(link("https://paypal.com.evil.io/x", "payer-action")), /unexpected host/);
  assert.throws(() => extractApprovalUrl(link("http://www.paypal.com/x", "payer-action")), /unexpected host/);
  assert.throws(() => extractApprovalUrl([{ href: "https://www.paypal.com/x", rel: "self" }]), /no payer-action or approve/);
  assert.throws(() => extractApprovalUrl(undefined), PayPalError);
  assert.throws(() => extractApprovalUrl(link("not a url", "approve")), /not a valid URL/);
});

test("createOrder refuses unusable input before touching the network", async () => {
  const { client, calls } = mk([TOKEN, ORDER_OK]);
  await assert.rejects(client.createOrder({ ...ORDER_INPUT, amountMinor: 0 }), PayPalError);
  await assert.rejects(client.createOrder({ ...ORDER_INPUT, returnUrl: "http://app.example.com/r" }), /https/);
  await assert.rejects(client.createOrder({ ...ORDER_INPUT, referenceId: " " }), PayPalError);
  assert.equal(calls.length, 0);
});

test("an expired bearer token (401) is replaced once and the call succeeds", async () => {
  const { client, calls } = mk([
    TOKEN,
    { status: 401, body: { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials" } },
    { body: { access_token: "TOK2", expires_in: 32400 } },
    ORDER_OK,
  ]);
  const r = await client.createOrder(ORDER_INPUT);
  assert.equal(r.orderId, "5O190127TN364715T");
  assert.equal(calls.length, 4);
  assert.equal(calls[3]!.init.headers.Authorization, "Bearer TOK2");
});

test("a second 401 is surfaced, not looped on", async () => {
  const { client, calls } = mk([TOKEN, { status: 401, body: { name: "AUTHENTICATION_FAILURE", message: "no" } }]);
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => e.kind === "auth");
  assert.ok(calls.length <= 5);
});

test("503 is retried with the SAME idempotency key, then succeeds", async () => {
  const { client, calls, sleeps } = mk([TOKEN, { status: 503, text: "<html>busy</html>" }, ORDER_OK]);
  const r = await client.createOrder({ ...ORDER_INPUT, requestId: undefined });
  assert.equal(r.orderId, "5O190127TN364715T");
  const orderCalls = calls.filter((c) => c.url.endsWith("/v2/checkout/orders"));
  assert.equal(orderCalls.length, 2);
  assert.ok(orderCalls[0]!.init.headers["PayPal-Request-Id"]);
  assert.equal(orderCalls[0]!.init.headers["PayPal-Request-Id"], orderCalls[1]!.init.headers["PayPal-Request-Id"]);
  assert.equal(sleeps.length, 1);
});

test("429 honors Retry-After", async () => {
  const { client, sleeps } = mk([TOKEN, { status: 429, headers: { "retry-after": "3" }, body: { name: "RATE_LIMIT_REACHED", message: "slow down" } }, ORDER_OK]);
  await client.createOrder(ORDER_INPUT);
  assert.deepEqual(sleeps, [3000]);
});

test("persistent 5xx gives up after maxRetries and reports kind=server", async () => {
  const { client, calls } = mk([TOKEN, { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: "oops", debug_id: "abc123" } }], { maxRetries: 2 });
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => {
    assert.equal(e.kind, "server");
    assert.equal(e.debugId, "abc123");
    assert.equal(e.retryable, true);
    return true;
  });
  assert.equal(calls.filter((c) => c.url.endsWith("/orders")).length, 3);
});

test("non-JSON gateway error (HTML 502) becomes a server error, not a JSON parse crash", async () => {
  const { client } = mk([TOKEN, { status: 502, text: "<html>Bad Gateway</html>" }], { maxRetries: 0 });
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => e.kind === "server" && e.status === 502);
});

test("400 validation errors are not retried and keep PayPal's field details", async () => {
  const { client, calls } = mk([TOKEN, {
    status: 400,
    body: { name: "INVALID_REQUEST", message: "Request is not well-formed", debug_id: "d1",
      details: [{ field: "/purchase_units/@reference_id=='x'/amount/value", issue: "CURRENCY_NOT_SUPPORTED", description: "nope" }] },
  }]);
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => {
    assert.equal(e.kind, "validation");
    assert.equal(e.issue, "CURRENCY_NOT_SUPPORTED");
    assert.equal(e.debugId, "d1");
    assert.equal(e.retryable, false);
    assert.equal(e.details.length, 1);
    return true;
  });
  assert.equal(calls.filter((c) => c.url.endsWith("/orders")).length, 1);
});

test("network failure is retried, then reported as kind=network", async () => {
  const { client, calls } = mk([TOKEN, { throws: new TypeError("fetch failed") }], { maxRetries: 1 });
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => e.kind === "network" && e.retryable);
  assert.equal(calls.filter((c) => c.url.endsWith("/orders")).length, 2);
});

test("a timeout is reported as a network error", async () => {
  const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const { client } = mk([TOKEN, { throws: err }], { maxRetries: 0 });
  await assert.rejects(client.createOrder(ORDER_INPUT), (e: PayPalError) => e.kind === "network" && /timed out/.test(e.message));
});

const CAPTURED = {
  status: 201,
  body: {
    id: "5O190127TN364715T", status: "COMPLETED",
    purchase_units: [{ reference_id: "settlement-42", payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "12.50" } }] } }],
  },
};

test("captureOrder returns a flat summary and uses an idempotency key", async () => {
  const { client, calls } = mk([TOKEN, CAPTURED]);
  const r = await client.captureOrder("5O190127TN364715T");
  assert.deepEqual(r, {
    orderId: "5O190127TN364715T", status: "COMPLETED", captureId: "CAP1", captureStatus: "COMPLETED",
    amount: "12.50", currency: "USD", referenceId: "settlement-42", alreadyCaptured: false,
  });
  assert.equal(calls[1]!.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture");
  assert.equal(calls[1]!.init.headers["PayPal-Request-Id"], "capture:5O190127TN364715T");
});

test("capturing an already-captured order reads its state instead of failing", async () => {
  const { client } = mk([
    TOKEN,
    { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "x", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } },
    { status: 200, body: CAPTURED.body },
  ]);
  const r = await client.captureOrder("5O190127TN364715T");
  assert.equal(r.alreadyCaptured, true);
  assert.equal(r.captureId, "CAP1");
});

test("capturing before approval is a clear not_approved error", async () => {
  const { client } = mk([TOKEN, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "x", debug_id: "d2", details: [{ issue: "ORDER_NOT_APPROVED" }] } }]);
  await assert.rejects(client.captureOrder("5O190127TN364715T"), (e: PayPalError) => e.kind === "not_approved" && /approve/i.test(e.userMessage));
});

test("a declined funding source is kind=declined with a safe user message", async () => {
  const { client } = mk([TOKEN, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "internal detail", details: [{ issue: "INSTRUMENT_DECLINED" }] } }]);
  await assert.rejects(client.captureOrder("5O190127TN364715T"), (e: PayPalError) => {
    assert.equal(e.kind, "declined");
    assert.ok(!e.userMessage.includes("internal detail"));
    return true;
  });
});

test("bad order ids are rejected before any request (no path injection)", async () => {
  const { client, calls } = mk([TOKEN, CAPTURED]);
  for (const id of ["", "../../v1/payments", "abc def", "x".repeat(80)]) {
    await assert.rejects(client.captureOrder(id), (e: PayPalError) => e.kind === "validation");
  }
  assert.equal(calls.length, 0);
});

test("missing credentials fail at construction; live env uses the live host", async () => {
  assert.throws(() => createPayPalClient({ clientId: "", clientSecret: "s" }), PayPalError);
  const { client, calls } = mk([TOKEN], { env: "live" });
  await client.getAccessToken();
  assert.equal(calls[0]!.url, "https://api-m.paypal.com/v1/oauth2/token");
});

test("toPayPalError tolerates empty and odd bodies", () => {
  assert.equal(toPayPalError(500, null).kind, "server");
  assert.equal(toPayPalError(404, {}).kind, "not_found");
  assert.equal(toPayPalError(403, { name: "NOT_AUTHORIZED" }).kind, "permission");
  assert.equal(toPayPalError(418, "teapot").kind, "unknown");
});

test("createOrder can name a payee account", async () => {
  const { client, calls } = mk([TOKEN, ORDER_OK]);
  await client.createOrder({ ...ORDER_INPUT, payeeEmail: "maya@example.com" });
  assert.deepEqual(bodyOf(calls[1]!).purchase_units[0].payee, { email_address: "maya@example.com" });
  const none = mk([TOKEN, ORDER_OK]);
  await none.client.createOrder(ORDER_INPUT);
  assert.equal(bodyOf(none.calls[1]!).purchase_units[0].payee, undefined);
});

const PAYOUT_OK: Reply = {
  status: 201,
  body: { batch_header: { payout_batch_id: "FYXMPQTX4JC9N", batch_status: "PENDING", sender_batch_header: { sender_batch_id: "pay-1" } } },
};

test("sendPayout posts a one-item EMAIL batch with the batch id as idempotency key", async () => {
  const { client, calls } = mk([TOKEN, PAYOUT_OK]);
  const r = await client.sendPayout({ receiverEmail: "maya@example.com", amountMinor: 1250, currency: "USD", batchId: "pay-1", note: "Trip" });
  assert.deepEqual(r, { batchId: "FYXMPQTX4JC9N", status: "PENDING" });
  assert.equal(calls[1]!.url, "https://api-m.sandbox.paypal.com/v1/payments/payouts");
  assert.equal(calls[1]!.init.headers["PayPal-Request-Id"], "pay-1");
  const b = bodyOf(calls[1]!);
  assert.equal(b.sender_batch_header.sender_batch_id, "pay-1");
  assert.deepEqual(b.items[0], {
    recipient_type: "EMAIL", receiver: "maya@example.com", amount: { currency: "USD", value: "12.50" },
    sender_item_id: "pay-1", note: "Trip",
  });
});

test("sendPayout validates input before any request and retries 503 with the same batch id", async () => {
  const bad = mk([TOKEN, PAYOUT_OK]);
  await assert.rejects(bad.client.sendPayout({ receiverEmail: "not-an-email", amountMinor: 100, currency: "USD", batchId: "b" }), PayPalError);
  await assert.rejects(bad.client.sendPayout({ receiverEmail: "a@b.co", amountMinor: 0, currency: "USD", batchId: "b" }), PayPalError);
  assert.equal(bad.calls.length, 0);

  const { client, calls } = mk([TOKEN, { status: 503, text: "busy" }, PAYOUT_OK]);
  await client.sendPayout({ receiverEmail: "a@b.co", amountMinor: 100, currency: "USD", batchId: "dup-1" });
  const posts = calls.filter((c) => c.url.endsWith("/payouts"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.init.headers["PayPal-Request-Id"], posts[1]!.init.headers["PayPal-Request-Id"]);
});

test("getPayout reports the batch status", async () => {
  const { client } = mk([TOKEN, { body: { batch_header: { batch_status: "SUCCESS" } } }]);
  assert.deepEqual(await client.getPayout("FYXMPQTX4JC9N"), { batchId: "FYXMPQTX4JC9N", status: "SUCCESS" });
});
