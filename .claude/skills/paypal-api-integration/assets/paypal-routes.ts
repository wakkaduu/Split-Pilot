// Express routes that sit on top of paypal-client.ts.
//
//   POST /api/paypal/orders        { settlementId }  ->  { orderId, approvalUrl }
//   GET  /api/paypal/return?token=ORDER_ID           ->  captures, then redirects to the frontend
//   GET  /api/paypal/cancel?token=ORDER_ID           ->  redirects to the frontend
//
// The browser never supplies an amount. It names a settlement; the server looks
// up what is owed. That is the line between "pay what you were asked" and "pay
// whatever the client claims".

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { PayPalError, formatAmount, type PayPalClient } from "./paypal-client.ts";

export interface Settlement {
  id: string;
  amountMinor: number;
  currency: string;
  description?: string;
}

/** Your persistence layer. Keep the order <-> settlement link in a database. */
export interface PaymentStore {
  getSettlement(id: string): Promise<Settlement | null>;
  linkOrder(settlementId: string, orderId: string): Promise<void>;
  findByOrder(orderId: string): Promise<Settlement | null>;
  markPaid(settlementId: string, info: { orderId: string; captureId: string }): Promise<void>;
  markNeedsReview(settlementId: string, reason: string): Promise<void>;
}

export interface RouteOptions {
  client: Pick<PayPalClient, "createOrder" | "captureOrder">;
  store: PaymentStore;
  /** Public base URL of THIS server, e.g. https://api.example.com (used to build PayPal's return/cancel URLs). */
  serverUrl: string;
  /** Frontend base URL users land on afterwards, e.g. https://app.example.com. */
  appUrl: string;
  brandName?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Map a PayPalError to an HTTP response. Never forwards PayPal's raw text to the browser. */
export function httpStatusFor(err: PayPalError): number {
  switch (err.kind) {
    case "declined":
    case "payer_action":
      return 402;
    case "not_approved":
    case "already_captured":
      return 409;
    case "not_found":
      return 404;
    case "rate_limited":
    case "server":
    case "network":
      return 503;
    default:
      return 502; // config, auth, permission, validation: our integration is at fault, not the user
  }
}

export function createPayPalRouter(opts: RouteOptions): Router {
  const router = express.Router();
  const log = opts.log ?? (() => {});
  const server = opts.serverUrl.replace(/\/+$/, "");
  const app = opts.appUrl.replace(/\/+$/, "");

  router.use(express.json({ limit: "10kb" }));

  router.post("/orders", async (req, res, next) => {
    try {
      const settlementId = req.body?.settlementId;
      if (typeof settlementId !== "string" || !/^[\w-]{1,64}$/.test(settlementId)) {
        return void res.status(400).json({ error: "settlementId is required" });
      }
      const settlement = await opts.store.getSettlement(settlementId);
      if (!settlement) return void res.status(404).json({ error: "unknown settlement" });

      const order = await opts.client.createOrder({
        amountMinor: settlement.amountMinor,
        currency: settlement.currency,
        referenceId: settlement.id,
        description: settlement.description,
        returnUrl: `${server}/api/paypal/return`,
        cancelUrl: `${server}/api/paypal/cancel`,
        brandName: opts.brandName,
        requestId: `settlement:${settlement.id}`, // same settlement -> same PayPal order, even on double-click
      });
      await opts.store.linkOrder(settlement.id, order.orderId);
      log("paypal.order.created", { settlementId: settlement.id, orderId: order.orderId });
      res.status(201).json({ orderId: order.orderId, approvalUrl: order.approvalUrl });
    } catch (err) {
      next(err);
    }
  });

  router.get("/return", async (req, res, next) => {
    const orderId = typeof req.query.token === "string" ? req.query.token : "";
    try {
      const settlement = orderId ? await opts.store.findByOrder(orderId) : null;
      if (!settlement) return void res.redirect(303, `${app}/pay/error?reason=unknown_order`);

      const cap = await opts.client.captureOrder(orderId);
      // Money moved only if the capture itself completed, not just the order.
      if (cap.captureStatus !== "COMPLETED") {
        await opts.store.markNeedsReview(settlement.id, `capture status ${cap.captureStatus}`);
        return void res.redirect(303, `${app}/pay/pending?settlement=${encodeURIComponent(settlement.id)}`);
      }
      // Never trust that the buyer approved the amount we asked for: check what PayPal says it captured.
      const amountOk = cap.currency === settlement.currency && cap.amount === formatAmount(settlement.amountMinor, settlement.currency);
      if (!amountOk) {
        await opts.store.markNeedsReview(settlement.id, `captured ${cap.amount} ${cap.currency}, expected ${settlement.amountMinor} minor ${settlement.currency}`);
        return void res.redirect(303, `${app}/pay/pending?settlement=${encodeURIComponent(settlement.id)}`);
      }
      await opts.store.markPaid(settlement.id, { orderId, captureId: cap.captureId! });
      log("paypal.order.captured", { settlementId: settlement.id, orderId, captureId: cap.captureId, repeat: cap.alreadyCaptured });
      res.redirect(303, `${app}/pay/success?settlement=${encodeURIComponent(settlement.id)}`);
    } catch (err) {
      if (err instanceof PayPalError) {
        log("paypal.capture.failed", { orderId, kind: err.kind, issue: err.issue, debugId: err.debugId });
        // The buyer is on a browser redirect, so send them to a page, not a JSON error.
        return void res.redirect(303, `${app}/pay/error?reason=${encodeURIComponent(err.kind)}`);
      }
      next(err);
    }
  });

  router.get("/cancel", (_req, res) => res.redirect(303, `${app}/pay/cancelled`));

  // JSON error handler for the API routes above.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PayPalError) {
      log("paypal.error", { kind: err.kind, status: err.status, issue: err.issue, debugId: err.debugId, message: err.message });
      const status = httpStatusFor(err);
      if (status === 503) res.setHeader("Retry-After", "5");
      return void res.status(status).json({ error: err.userMessage, kind: err.kind, debugId: err.debugId });
    }
    if (err instanceof SyntaxError) return void res.status(400).json({ error: "invalid JSON" });
    log("paypal.unexpected", { message: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Something went wrong." });
  });

  return router;
}
