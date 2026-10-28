import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_URL: z.url().default("http://localhost:5173"),
  SERVER_URL: z.url().default("http://localhost:3001"),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  // Optional at boot so the app can start and show a helpful message before keys are added.
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  // Empty means "use the provider default" (claude-opus-5-5). Set claude-sonnet-5-5 or claude-haiku-5-5 to trade accuracy for cost.
  AI_MODEL: z.string().default(""),
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
});

export type Env = z.infer<typeof schema>;

/** Validate once at startup so a typo fails loudly here, not deep inside a request. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.PAYPAL_ENV === "live") {
    throw new Error("PAYPAL_ENV=live is not allowed: this project uses the PayPal sandbox only.");
  }
  return parsed.data;
}

/** Which integrations are configured, for /api/health and the setup screen. Never returns the values. */
export function configStatus(env: Env) {
  return {
    paypal: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    ai: Boolean(env.ANTHROPIC_API_KEY),
    paypalEnv: env.PAYPAL_ENV,
  };
}
