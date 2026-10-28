import { createApp } from "./app.ts";
import { loadEnv } from "./config/env.ts";

const env = loadEnv();
createApp(env).listen(env.PORT, () => {
  console.log(`SplitPilot server on http://localhost:${env.PORT} (PayPal ${env.PAYPAL_ENV})`);
});
