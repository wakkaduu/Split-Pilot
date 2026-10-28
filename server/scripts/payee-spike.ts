/**
 * One-command sandbox experiment: can money reach a different person than the
 * app's own PayPal account? Answers the question in docs/decisions/0001-settlement-money-flow.md.
 *
 *   npm run spike:payee -w server                 # run both experiments
 *   npm run spike:payee -w server -- --only orders
 *   npm run spike:payee -w server -- --only payouts
 *   npm run spike:payee -w server -- --capture ORDER_ID   # after approving the order in the browser
 *
 * Needs, in server/.env (sandbox only, $1.00 per run):
 *   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET   sandbox app credentials
 *   SPIKE_PAYEE_EMAIL       a DIFFERENT sandbox business account (experiment A)
 *   SPIKE_RECIPIENT_EMAIL   a sandbox personal account (experiment B)
 */
import { PayPalError, createPayPalClient } from "../src/services/paypal/client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = flag("--only");
const captureId = flag("--capture");

const { PAYPAL_CLIENT_ID = "", PAYPAL_CLIENT_SECRET = "", SPIKE_PAYEE_EMAIL, SPIKE_RECIPIENT_EMAIL } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in server/.env (sandbox app credentials).");
  process.exit(1);
}
const client = createPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env: "sandbox" });
const run = Date.now();

function report(label: string, err: unknown) {
  if (err instanceof PayPalError) {
    console.log(`  RESULT: FAILED  ${label}`);
    console.log(`    kind=${err.kind} status=${err.status} issue=${err.issue ?? "-"} debug_id=${err.debugId ?? "-"}`);
    console.log(`    ${err.message}`);
  } else {
    console.log(`  RESULT: FAILED  ${label}: ${String(err)}`);
  }
}

async function auth() {
  console.log("\n[0] Credentials");
  try {
    await client.getAccessToken();
    console.log("  RESULT: OK  sandbox token obtained");
    return true;
  } catch (e) {
    report("token request", e);
    return false;
  }
}

async function ordersWithPayee() {
  console.log("\n[A] Orders v2 with purchase_units[].payee = another sandbox business account");
  if (!SPIKE_PAYEE_EMAIL) return console.log("  SKIPPED: set SPIKE_PAYEE_EMAIL");
  try {
    const order = await client.createOrder({
      amountMinor: 100, currency: "USD", referenceId: `spike-${run}`, description: "payee spike",
      returnUrl: "http://localhost:3001/api/paypal/return", cancelUrl: "http://localhost:3001/api/paypal/cancel",
      payeeEmail: SPIKE_PAYEE_EMAIL, requestId: `spike-payee-${run}`,
    });
    console.log(`  RESULT: ORDER CREATED  id=${order.orderId} status=${order.status}`);
    console.log(`  Next: open this URL, approve with a sandbox PERSONAL account, then run:`);
    console.log(`    npm run spike:payee -w server -- --capture ${order.orderId}`);
    console.log(`  ${order.approvalUrl}`);
    console.log("  (Creating the order is not enough to prove it works: capture is where PayPal enforces permissions.)");
  } catch (e) {
    report("create order with payee", e);
    console.log("  If this says NOT_AUTHORIZED / PAYEE_ACCOUNT_*, direct payee payments need platform onboarding: use experiment B.");
  }
}

async function capture(orderId: string) {
  console.log(`\n[A2] Capture ${orderId} and read back who PayPal says was paid`);
  try {
    const result = await client.captureOrder(orderId);
    const order = await client.getOrder(orderId);
    const unit = order?.purchase_units?.[0];
    console.log(`  RESULT: capture ${result.captureStatus} (order ${result.status}) amount=${result.amount} ${result.currency}`);
    console.log(`    payee on the order: ${JSON.stringify(unit?.payee ?? null)}`);
    console.log(`    Compare payee.email_address with SPIKE_PAYEE_EMAIL (${SPIKE_PAYEE_EMAIL ?? "unset"}) and with your app's own business account.`);
  } catch (e) {
    report("capture", e);
  }
}

async function payouts() {
  console.log("\n[B] Payouts API: app's sandbox balance -> a sandbox personal account");
  if (!SPIKE_RECIPIENT_EMAIL) return console.log("  SKIPPED: set SPIKE_RECIPIENT_EMAIL");
  try {
    const batch = await client.sendPayout({
      receiverEmail: SPIKE_RECIPIENT_EMAIL, amountMinor: 100, currency: "USD",
      batchId: `spike-payout-${run}`, note: "SplitPilot payee spike", emailSubject: "SplitPilot spike",
    });
    console.log(`  RESULT: BATCH ACCEPTED  id=${batch.batchId} status=${batch.status}`);
    for (let i = 0; i < 5 && ["PENDING", "PROCESSING"].includes(batch.status); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      batch.status = (await client.getPayout(batch.batchId)).status;
      console.log(`    poll ${i + 1}: ${batch.status}`);
    }
    console.log(`  Final: ${batch.status}. Check the recipient's balance in the sandbox dashboard (Testing tools -> Sandbox accounts).`);
  } catch (e) {
    report("payout", e);
    console.log("  If this says AUTHORIZATION_ERROR / PAYOUTS_NOT_ENABLED, enable Payouts for the sandbox business account/app in the dashboard, then rerun.");
  }
}

if (await auth()) {
  if (captureId) await capture(captureId);
  else {
    if (only !== "payouts") await ordersWithPayee();
    if (only !== "orders") await payouts();
  }
}
