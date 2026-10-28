---
name: paypal-api-integration
description: Builds and reviews the Node.js/TypeScript backend for PayPal REST (sandbox first), centered on a hardened client that fetches and caches OAuth access tokens, creates Orders v2, extracts the approval (payer-action) link for a "Pay with PayPal" button, captures payments, and turns every PayPal failure into a typed error with safe user messages, idempotent retries, and HTTP status mapping, plus the Express routes that tie it together. Use this skill whenever the user mentions PayPal, the PayPal sandbox, access tokens, create order, approval_url or approval link, capture, checkout, "Pay with PayPal" buttons, PayPal webhooks, or wiring payments into a backend route, even if they only say "add payments" or "let users pay each other" in a PayPal project. Also use it to debug PayPal error responses (INSTRUMENT_DECLINED, ORDER_NOT_APPROVED, 401s, debug_id) or to review PayPal code for double-charge and secret-leak risks.
---

# PayPal API integration (Node.js backend)

The happy path is three calls: get a token, create an order, send the buyer to PayPal. Everything that makes it a real integration is what happens when those calls fail, repeat, or arrive twice: expired tokens, a flaky network, a buyer double-clicking, a half-finished approval. This skill's template handles those, so the routes you write stay small.

Start from these tested files (35 tests, strict TypeScript; the routes tests run a real Express server against a fake PayPal client):

- [assets/paypal-client.ts](assets/paypal-client.ts) — tokens, create order, capture, error model
- [assets/paypal-routes.ts](assets/paypal-routes.ts) — Express router: create order, return, cancel
- [assets/paypal-client.test.ts](assets/paypal-client.test.ts), [assets/paypal-routes.test.ts](assets/paypal-routes.test.ts)

Copy and adapt rather than rewriting. Run them with `npx tsx --test` (the routes tests need `express` and `@types/express`).

## The flow

```
browser                    your server                         PayPal
  | POST /api/paypal/orders {settlementId}                         |
  |--------------------------->| look up amount (never from client)|
  |                            |-- token (cached) ---------------->|
  |                            |-- POST /v2/checkout/orders ------>|  PayPal-Request-Id: settlement:42
  |<-- {orderId, approvalUrl} -|<-- 201 links[payer-action] -------|
  | window.location = approvalUrl  ------------------------------>|  buyer logs in, approves
  |<------------------ redirect to /api/paypal/return?token=ORDER --|
  |                            |-- POST .../capture -------------->|
  |<-- 303 to app /pay/success |<-- COMPLETED -------------------|
```

## Decisions that matter, and why

**Tokens.** `POST /v1/oauth2/token` with HTTP Basic (`clientId:secret`) and `grant_type=client_credentials`. PayPal says to reuse the token until it expires, so the client caches it, refreshes a minute early, and lets concurrent requests share one in-flight fetch (otherwise a burst of requests after expiry fires a burst of token calls). A 401 on a normal call drops the cached token and retries once; a second 401 is a real auth problem and is surfaced. Sandbox host is `api-m.sandbox.paypal.com`, live is `api-m.paypal.com`; sandbox and live credentials are different, and the most common "invalid_client" cause is mixing them, which the error message says.

**The approval link.** An order created with `payment_source.paypal.experience_context` (what the template sends) comes back `PAYER_ACTION_REQUIRED` with the link under `rel: "payer-action"`; an order created the older way, with `application_context`, returns `rel: "approve"` and status `CREATED`. `extractApprovalUrl` accepts either, and refuses any URL that is not https on `paypal.com`, so a malformed response can never become an open redirect on your own site. Sources: PayPal's [Orders v2 reference](https://developer.paypal.com/docs/api/orders/sdk/v2/) and [standard checkout flow](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard/). Re-check them if PayPal changes the response shape; the tests fail loudly if no recognizable link is returned.

**Idempotency, so retries cannot double-charge.** PayPal replays the original response when it sees the same `PayPal-Request-Id`. The client retries (network errors, 429, 502/503/504 and 500) only for GETs and for POSTs that carry one; the key is fixed before the first attempt so every retry reuses it. At the route level use a key derived from your own record (`settlement:42`), so a double-click or a client retry returns the same order instead of a second one. Capture uses `capture:<orderId>` for the same reason, and an `ORDER_ALREADY_CAPTURED` response is converted into "read the order and report its state" because by then the money has moved.

**Amounts.** Integers in, decimal strings out. PayPal wants `"value": "12.50"`, and a few currencies (JPY, HUF, TWD) take no decimals. `formatAmount(1250, "USD")` is the only place that formatting happens. Take minor units from the settlement skill's output rather than floats.

**The server decides the price.** The create-order route receives a settlement id, not an amount. If the amount came from the browser, anyone could pay $0.01 for a $500 settlement. After capture, the route compares what PayPal says it captured (amount and currency) to what was expected, and also checks the capture's own status: an order can be `COMPLETED` while its capture is `PENDING`. Only a `COMPLETED` capture for the right amount marks the settlement paid; anything else goes to a review state.

**Errors.** Everything throws `PayPalError` with a `kind` (`auth`, `declined`, `not_approved`, `rate_limited`, `server`, `network`, ...), the PayPal `debugId` (PayPal support asks for it), the `issue` code, and a `userMessage` that is safe to show. Raw PayPal text and anything resembling credentials stay in server logs. Routes map kinds to HTTP statuses (declined 402, not approved 409, outages 503 with `Retry-After`, our own config/auth faults 502 so users are not blamed). The browser-facing `/return` route redirects to a frontend page on failure instead of rendering JSON at someone who just came back from PayPal.

**Secrets.** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox` live in server-side env only. Never give them a `VITE_`/`NEXT_PUBLIC_` prefix, never log request headers, keep `.env` in `.gitignore` and ship `.env.example`. The hackathon repo is public.

## Frontend side

The server returns `{ orderId, approvalUrl }`. A plain redirect needs no PayPal script:

```ts
async function payWithPayPal(settlementId: string) {
  const res = await fetch("/api/paypal/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settlementId }),
  });
  const body = await res.json();
  if (!res.ok) return showError(body.error); // already a safe message
  window.location.assign(body.approvalUrl);
}
```

Disable the button while the request is in flight (the idempotency key makes a double-click harmless, but the user shouldn't wonder). If you want PayPal's official styled button instead, use the JS SDK and have its `createOrder` callback call this same endpoint and return `orderId`; PayPal's brand guidelines apply either way.

## Things to raise with the user

- **Orders collects money into the merchant account behind your REST app; it does not pay another person.** For "A settles up with B", the clean design is: A pays the app's account through Orders, then the app sends B their money with PayPal's Payouts API. Paying an arbitrary third party directly through `purchase_units[].payee` generally needs extra permissions. Confirm the current rules in PayPal's docs before promising either to the user.
- **Webhooks** (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`) are the safety net for a buyer who approves and then closes the tab before returning. Verify their signatures with PayPal's `verify-webhook-signature` endpoint, and make the handler idempotent with the same store used by `/return`. Not needed for a first demo; needed before real use.
- **Sandbox buyers:** to test, approve with a sandbox *personal* account from the developer dashboard, not a real PayPal login. Sandbox responses can differ slightly from live; treat anything surprising as a reason to read `debug_id` rather than to loosen validation.
- **Persistence:** `PaymentStore` in the routes file is an interface on purpose. The order-to-settlement link must survive restarts, because `/return` only gives you the order id.
