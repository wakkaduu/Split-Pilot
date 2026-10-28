// Run with: npx tsx --test paypal-routes.test.ts   (needs express and @types/express installed)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { PayPalError } from "./paypal-client.ts";
import { createPayPalRouter, type PaymentStore, type Settlement } from "./paypal-routes.ts";

// Servers are closed in after() so a failing assertion cannot leave the runner hanging.
const openServers: (() => void)[] = [];
after(() => openServers.forEach((close) => close()));

const S: Settlement = { id: "s1", amountMinor: 1250, currency: "USD", description: "Trip" };

function harness(clientOverrides: object = {}, storeOverrides: Partial<PaymentStore> = {}) {
  const state = { linked: [] as string[], paid: [] as string[], review: [] as string[], createArgs: null as any };
  const store: PaymentStore = {
    getSettlement: async (id) => (id === "s1" ? S : null),
    linkOrder: async (_s, o) => void state.linked.push(o),
    findByOrder: async (o) => (o === "ORDER12345" ? S : null),
    markPaid: async (id) => void state.paid.push(id),
    markNeedsReview: async (_id, why) => void state.review.push(why),
    ...storeOverrides,
  };
  const client = {
    createOrder: async (a: any) => ((state.createArgs = a), { orderId: "ORDER12345", status: "PAYER_ACTION_REQUIRED", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345" }),
    captureOrder: async () => ({ orderId: "ORDER12345", status: "COMPLETED", captureId: "CAP1", captureStatus: "COMPLETED", amount: "12.50", currency: "USD", referenceId: "s1", alreadyCaptured: false }),
    ...clientOverrides,
  };
  const app = express();
  app.use("/api/paypal", createPayPalRouter({ client: client as any, store, serverUrl: "https://api.test", appUrl: "https://app.test" }));
  return new Promise<{ base: string; state: typeof state; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => {
      openServers.push(() => { srv.closeAllConnections(); srv.close(); });
      resolve({ base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/paypal`, state, close: () => {} });
    });
  });
}
const post = (base: string, body: unknown) =>
  fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => fetch(url, { redirect: "manual" });

test("POST /orders returns an approval URL, and the amount comes from the server, not the client", async () => {
  const h = await harness();
  const r = await post(h.base, { settlementId: "s1", amount: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { orderId: "ORDER12345", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345" });
  assert.equal(h.state.createArgs.amountMinor, 1250);
  assert.equal(h.state.createArgs.requestId, "settlement:s1");
  assert.equal(h.state.createArgs.returnUrl, "https://api.test/api/paypal/return");
  assert.deepEqual(h.state.linked, ["ORDER12345"]);
  h.close();
});

test("POST /orders validates input and unknown settlements", async () => {
  const h = await harness();
  assert.equal((await post(h.base, {})).status, 400);
  assert.equal((await post(h.base, { settlementId: "../x" })).status, 400);
  assert.equal((await post(h.base, { settlementId: "nope" })).status, 404);
  const bad = await fetch(`${h.base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 400);
  h.close();
});

test("PayPal failures become JSON with a safe message, a status, and the debug id", async () => {
  const h = await harness({ createOrder: async () => { throw new PayPalError("PayPal 422 internal secret detail", "declined", 422, "dbg9", "INSTRUMENT_DECLINED"); } });
  const r = await post(h.base, { settlementId: "s1" });
  assert.equal(r.status, 402);
  const j: any = await r.json();
  assert.equal(j.kind, "declined");
  assert.equal(j.debugId, "dbg9");
  assert.ok(!JSON.stringify(j).includes("internal secret detail"));
  h.close();
});

test("outages map to 503 with Retry-After; integration faults to 502; surprises to 500", async () => {
  for (const [err, status] of [
    [new PayPalError("x", "network", null), 503],
    [new PayPalError("x", "auth", 401), 502],
    [new Error("boom"), 500],
  ] as const) {
    const h = await harness({ createOrder: async () => { throw err; } });
    const r = await post(h.base, { settlementId: "s1" });
    assert.equal(r.status, status);
    if (status === 503) assert.equal(r.headers.get("retry-after"), "5");
    assert.ok(!(await r.text()).includes("boom"));
    h.close();
  }
});

test("GET /return captures, marks paid, and redirects to the frontend", async () => {
  const h = await harness();
  const r = await get(`${h.base}/return?token=ORDER12345&PayerID=XYZ`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "https://app.test/pay/success?settlement=s1");
  assert.deepEqual(h.state.paid, ["s1"]);
  h.close();
});

test("GET /return with an unknown order never captures", async () => {
  let captured = false;
  const h = await harness({ captureOrder: async () => { captured = true; } });
  const r = await get(`${h.base}/return?token=OTHERORDER1`);
  assert.equal(r.headers.get("location"), "https://app.test/pay/error?reason=unknown_order");
  assert.equal((await get(`${h.base}/return`)).headers.get("location"), "https://app.test/pay/error?reason=unknown_order");
  assert.equal(captured, false);
  h.close();
});

test("a capture that is not COMPLETED, or for the wrong amount, is held for review and NOT marked paid", async () => {
  const pending = { orderId: "ORDER12345", status: "COMPLETED", captureId: "CAP1", captureStatus: "PENDING", amount: "12.50", currency: "USD", referenceId: "s1", alreadyCaptured: false };
  const h1 = await harness({ captureOrder: async () => pending });
  const r1 = await get(`${h1.base}/return?token=ORDER12345`);
  assert.equal(r1.headers.get("location"), "https://app.test/pay/pending?settlement=s1");
  assert.deepEqual(h1.state.paid, []);
  assert.equal(h1.state.review.length, 1);
  h1.close();

  const h2 = await harness({ captureOrder: async () => ({ ...pending, captureStatus: "COMPLETED", amount: "1.25" }) });
  const r2 = await get(`${h2.base}/return?token=ORDER12345`);
  assert.equal(r2.headers.get("location"), "https://app.test/pay/pending?settlement=s1");
  assert.deepEqual(h2.state.paid, []);
  assert.match(h2.state.review[0], /expected/);
  h2.close();
});

test("capture errors redirect the buyer to an error page instead of showing JSON", async () => {
  const h = await harness({ captureOrder: async () => { throw new PayPalError("x", "not_approved", 422); } });
  const r = await get(`${h.base}/return?token=ORDER12345`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "https://app.test/pay/error?reason=not_approved");
  h.close();
});

test("GET /cancel redirects to the frontend", async () => {
  const h = await harness();
  const r = await get(`${h.base}/cancel?token=ORDER12345`);
  assert.equal(r.headers.get("location"), "https://app.test/pay/cancelled");
  h.close();
});
