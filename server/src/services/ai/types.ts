import type { z } from "zod";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A receipt photo. `dataBase64` is the raw base64 string: no "data:" prefix, no line breaks. */
export interface ImageInput {
  mediaType: ImageMediaType;
  dataBase64: string;
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Stable instructions (rules, field definitions). */
  system: string;
  /** The untrusted user text. Wrap it in delimiters in the prompt builder, not here. */
  text: string;
  /** Optional receipt photos, sent before the text. */
  images?: ImageInput[];
  /** The shape the answer must have. Full validation, refinements included, runs on the result. */
  schema: S;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type StructuredResult<T> =
  | { ok: true; data: T; model: string; requestId: string | null; usage: Usage }
  /** The provider declined for safety reasons. Do not retry the same input. */
  | { ok: false; reason: "refusal"; category: string | null; requestId: string | null }
  /** Ran out of output tokens before finishing. */
  | { ok: false; reason: "truncated"; requestId: string | null }
  /**
   * The model answered, but not in a shape our schema accepts. `issues` is
   * readable validation text: feed it back in one repair turn.
   */
  | { ok: false; reason: "invalid"; issues: string; raw: string; requestId: string | null };

export type AiErrorKind =
  | "auth" // missing or rejected API key
  | "rate_limit"
  | "timeout"
  | "network"
  | "server" // provider 5xx / overloaded
  | "bad_input" // our own validation of the request (image type, size, count)
  | "bad_request" // provider rejected the request: a bug or unsupported option on our side
  | "unknown";

/** Thrown for failures that are not "the model's answer was unusable". */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "timeout" || this.kind === "network" || this.kind === "server";
  }

  /** Safe to show a user: no keys, no provider text. */
  get userMessage(): string {
    switch (this.kind) {
      case "bad_input":
        return this.message; // our own wording about their upload
      case "rate_limit":
      case "timeout":
      case "network":
      case "server":
        return "The AI service is busy or unreachable. Please try again in a moment.";
      default:
        return "We couldn't read that right now. Please try again later.";
    }
  }
}

/** What the rest of the server depends on. Swap providers by implementing this. */
export interface StructuredProvider {
  readonly name: string;
  readonly model: string;
  extract<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
}
