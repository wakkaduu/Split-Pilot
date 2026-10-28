import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  AiProviderError,
  type ImageInput,
  type StructuredProvider,
  type StructuredRequest,
  type StructuredResult,
} from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  /** Reasoning depth. Extraction is simple, so "low" keeps it fast and cheap. Set undefined for models without effort support. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Re-run on a fallback model if safety classifiers decline the request,
   * inside the same API call (Claude API only). Default on.
   */
  useFallbacks?: boolean;
  maxImages?: number;
  maxImageBytes?: number;
  /** SDK-level retries for 408/409/429/5xx and connection errors. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Tests inject a fake client. */
  client?: Anthropic;
}

/** Throws AiProviderError(bad_input) so a bad upload never reaches the network. */
export function validateImages(images: readonly ImageInput[], maxImages: number, maxBytes: number): void {
  if (images.length > maxImages) {
    throw new AiProviderError(`Please attach at most ${maxImages} images.`, "bad_input");
  }
  images.forEach((img, i) => {
    if (!MEDIA_TYPES.has(img.mediaType)) {
      throw new AiProviderError(`Image ${i + 1} must be a JPEG, PNG, GIF or WebP.`, "bad_input");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(img.dataBase64)) {
      throw new AiProviderError(`Image ${i + 1} is not valid base64.`, "bad_input");
    }
    const bytes = Math.floor((img.dataBase64.length * 3) / 4);
    if (bytes > maxBytes) {
      throw new AiProviderError(`Image ${i + 1} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, "bad_input");
    }
  });
}

/** Most specific first: connection timeouts are a kind of connection error, which are a kind of API error. */
export function toProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError("request to the AI provider timed out", "timeout");
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError("could not reach the AI provider", "network");
  if (err instanceof Anthropic.APIError) {
    const id = err.requestID ?? null;
    const status = err.status ?? null;
    // Deliberately not including err.message: it can echo request details.
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new AiProviderError(`AI provider rejected the API key (HTTP ${status})`, "auth", status, id);
    }
    if (err instanceof Anthropic.RateLimitError) return new AiProviderError("AI provider rate limit reached", "rate_limit", status, id);
    if (err instanceof Anthropic.BadRequestError) {
      return new AiProviderError(`AI provider rejected the request: ${err.message}`, "bad_request", status, id);
    }
    if (status !== null && status >= 500) return new AiProviderError(`AI provider error (HTTP ${status})`, "server", status, id);
    return new AiProviderError(`AI provider error (HTTP ${status ?? "?"})`, "unknown", status, id);
  }
  return new AiProviderError("unexpected error calling the AI provider", "unknown");
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): StructuredProvider {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const effort = "effort" in opts ? opts.effort : "low";
  const useFallbacks = opts.useFallbacks ?? true;
  const maxImages = opts.maxImages ?? 5;
  const maxImageBytes = opts.maxImageBytes ?? 5 * 1024 * 1024;

  if (!opts.client && !opts.apiKey) {
    throw new AiProviderError("ANTHROPIC_API_KEY is not set", "auth");
  }
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries ?? 3, timeout: opts.timeoutMs ?? 60_000 });

  return {
    name: "anthropic",
    model,

    async extract<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
      const images = req.images ?? [];
      validateImages(images, maxImages, maxImageBytes);

      // Images first, then the text that refers to them.
      const content: Anthropic.ContentBlockParam[] = [
        ...images.map(
          (img): Anthropic.ImageBlockParam => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
          }),
        ),
        { type: "text", text: req.text },
      ];

      // Structured outputs constrain the reply to the schema. Forced tool_choice
      // is not an option: it returns a 400 on the current models.
      const params = {
        model,
        // Thinking tokens count toward this, so leave room beyond the JSON itself.
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        messages: [{ role: "user" as const, content }],
        output_config: { ...(effort ? { effort } : {}), format: zodOutputFormat(req.schema) },
      };

      let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        message = useFallbacks
          ? await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" } as Anthropic.Beta.MessageCreateParamsNonStreaming)
          : await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
      } catch (err) {
        throw toProviderError(err);
      }

      const requestId = (message as { _request_id?: string | null })._request_id ?? null;

      // Always check stop_reason before reading content.
      if (message.stop_reason === "refusal") {
        const category = (message as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? null;
        return { ok: false, reason: "refusal", category, requestId };
      }
      if (message.stop_reason === "max_tokens") return { ok: false, reason: "truncated", requestId };

      const raw = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "invalid", issues: "The reply was not valid JSON.", raw, requestId };
      }
      // The API enforces the JSON Schema; this also applies refinements it cannot express.
      const parsed = req.schema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, reason: "invalid", issues: z.prettifyError(parsed.error), raw, requestId };
      }
      return {
        ok: true,
        data: parsed.data,
        model: message.model,
        requestId,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
