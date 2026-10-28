import type { Env } from "../../config/env.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import type { StructuredProvider } from "./types.ts";

export * from "./types.ts";
export { createAnthropicProvider, DEFAULT_MODEL } from "./anthropic.ts";

/** The one place that decides which AI provider the app uses. */
export function createProvider(env: Env): StructuredProvider {
  return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL });
}
