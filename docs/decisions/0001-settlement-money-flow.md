# 0001: How settlement money moves

**Status:** proposed. Needs one sandbox experiment to confirm (below).

## The problem

SplitPilot works out that *Alex owes Maya $24.50*. A PayPal Order created by our app pays into the merchant account behind our PayPal app, not into Maya's account. If we only use Orders, the demo shows Alex paying and Maya receiving nothing.

## What the PayPal docs say

| Fact | Source | Confidence |
|---|---|---|
| An Order's `purchase_units[].payee` can name a merchant by `email_address` or `merchant_id`. | [Orders v2 payee](https://developer.paypal.com/api/orders/v2/definitions/payee) | read in docs |
| Paying other merchants in one order is documented as a **limited-release** commerce-platform feature, and its examples use real `merchant_id`s. | [Multi-merchant payments](https://developer.paypal.com/limited-release/commerce-platform/accept-payments/standard/customize/accept-multi-merchant-payments/) | read in docs |
| Payouts API: `POST /v1/payments/payouts` with `sender_batch_header` and `items[]` (`recipient_type: EMAIL`, `receiver`, `amount`). A `sender_batch_id` reused within 30 days is rejected, and a 5xx response is safe to retry with the same id. | [Payouts reference](https://developer.paypal.com/api/payments.payouts-batch/v1/payouts-post) | read in docs |
| In the sandbox, the default business account sends payouts and a personal account receives them. | [Payouts set-up](https://developer.paypal.com/payouts/use-payouts/set-up) | read in docs |
| Payouts can be tested in the sandbox without verification, and may need the Payouts permission enabled. | a third-party guide only | **unconfirmed** |

## Options

| | Flow | Pros | Cons |
|---|---|---|---|
| **A. Orders with `payee`** | Alex pays Maya directly. | One API, true peer-to-peer. | Probably needs platform onboarding and permissions a hackathon app does not have. Unverified. |
| **B. Collect, then Payout** | Alex pays the app's business account through an Order. After the capture is verified, the app pays Maya from that balance with the Payouts API. | Uses two real PayPal APIs; works with plain sandbox accounts; Maya's money moves automatically. | The app briefly holds funds. In real life that is money transmission and needs licensing or a platform product. Fine for a sandbox demo, and the README should say so. |
| **C. Orders only** | Alex pays the app account; the ledger marks it settled. | Simplest. | Maya is not actually paid. Weak demo. |

## Recommendation

**B**, with A tried first because it costs one API call to find out. Payouts must only be triggered after our own verification of the capture (status `COMPLETED`, amount and currency match), and with `batchId` derived from our payment id so a retry cannot pay twice.

## The experiment

```bash
# server/.env needs sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET,
# SPIKE_PAYEE_EMAIL (a second sandbox BUSINESS account) and
# SPIKE_RECIPIENT_EMAIL (a sandbox PERSONAL account)
npm run spike:payee -w server
```

It runs experiment A (creates an order naming the other business account as payee, prints the approval link; after approving, `-- --capture ORDER_ID` captures it and prints who PayPal says was paid) and experiment B (sends $1.00 through Payouts and polls the batch status). Each prints `RESULT:` lines with PayPal's `debug_id` on failure.

| Result | Decision |
|---|---|
| A captures and `payee` shows the other account | Use A. |
| A is rejected (e.g. authorization or payee errors), B reaches `SUCCESS` | Use B. |
| Both fail | Debug with the `debug_id`s; fall back to C and say so honestly in the README and video. |

## Not yet known

- Whether Payouts is enabled for a fresh sandbox app without extra steps.
- The exact error PayPal returns for experiment A on a plain app.
