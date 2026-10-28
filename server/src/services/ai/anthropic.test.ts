import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicProvider, DEFAULT_MODEL, toProviderError, validateImages } from "./anthropic.ts";
import { AiProviderError } from "./types.ts";

const Schema = z
  .object({ description: z.string().min(1), totalAmount: z.number().positive() })
  .refine((v) => v.totalAmount < 1_000_000, { message: "amount is implausibly large", path: ["totalAmount"] });

const reply = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ description: "Dinner", totalAmount: 84.5 }) }],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0 },
  _request_id: "req_abc",
  ...over,
});

function fake(response: unknown = reply()) {
  const beta = vi.fn().mockResolvedValue(response);
  const plain = vi.fn().mockResolvedValue(response);
  const client = { beta: { messages: { create: beta } }, messages: { create: plain } } as unknown as Anthropic;
  return { client, beta, plain };
}
const req = { system: "extract", text: "dinner was 84.50", schema: Schema };

describe("extract: success path", () => {
  it("returns validated data, usage and request id", async () => {
    const f = fake();
    const result = await createAnthropicProvider({ client: f.client }).extract(req);
    expect(result).toEqual({
      ok: true,
      data: { description: "Dinner", totalAmount: 84.5 },
      model: "claude-opus-5-5",
      requestId: "req_abc",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0 },
    });
  });

  it("asks for schema-constrained output at low effort, never a forced tool choice", async () => {
    const f = fake();
    await createAnthropicProvider({ client: f.client }).extract(req);
    const params = f.beta.mock.calls[0]![0];
    expect(params.model).toBe(DEFAULT_MODEL);
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema.properties).toHaveProperty("totalAmount");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("thinking");
  });

  it("opts into server-side refusal fallback by default, and can opt out", async () => {
    const on = fake();
    await createAnthropicProvider({ client: on.client }).extract(req);
    expect(on.beta.mock.calls[0]![0]).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(on.plain).not.toHaveBeenCalled();

    const off = fake();
    await createAnthropicProvider({ client: off.client, useFallbacks: false }).extract(req);
    expect(off.plain).toHaveBeenCalledOnce();
    expect(off.beta).not.toHaveBeenCalled();
    expect(off.plain.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
  });

  it("uses a configured model and can omit effort for models without it", async () => {
    const f = fake();
    const p = createAnthropicProvider({ client: f.client, model: "claude-sonnet-5-5", effort: undefined });
    await p.extract(req);
    expect(p.model).toBe("claude-sonnet-5-5");
    const params = f.beta.mock.calls[0]![0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config).not.toHaveProperty("effort");
  });

  it("sends images before the text, as base64 blocks", async () => {
    const f = fake();
    await createAnthropicProvider({ client: f.client }).extract({
      ...req,
      images: [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }],
    });
    const content = f.beta.mock.calls[0]![0].messages[0].content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    expect(content[1]).toEqual({ type: "text", text: "dinner was 84.50" });
  });
});

describe("extract: answers that are not usable", () => {
  it("reports a refusal with its category, without reading content", async () => {
    const f = fake(reply({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] }));
    expect(await createAnthropicProvider({ client: f.client }).extract(req)).toEqual({
      ok: false, reason: "refusal", category: "cyber", requestId: "req_abc",
    });
  });

  it("reports truncation", async () => {
    const f = fake(reply({ stop_reason: "max_tokens" }));
    expect(await createAnthropicProvider({ client: f.client }).extract(req)).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("reports non-JSON text as invalid, keeping the raw reply", async () => {
    const f = fake(reply({ content: [{ type: "text", text: "Sure! Here you go: ..." }] }));
    const r = await createAnthropicProvider({ client: f.client }).extract(req);
    expect(r).toMatchObject({ ok: false, reason: "invalid", raw: "Sure! Here you go: ..." });
  });

  it("applies refinements the API schema cannot express, and returns readable issues for a repair turn", async () => {
    const f = fake(reply({ content: [{ type: "text", text: JSON.stringify({ description: "Villa", totalAmount: 5_000_000 }) }] }));
    const r = await createAnthropicProvider({ client: f.client }).extract(req);
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(r.ok === false && r.reason === "invalid" && r.issues).toMatch(/implausibly large/);
  });

  it("joins multiple text blocks and ignores thinking blocks", async () => {
    const f = fake(reply({
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: '{"description":"Taxi",' },
        { type: "text", text: '"totalAmount":23.4}' },
      ],
    }));
    const r = await createAnthropicProvider({ client: f.client }).extract(req);
    expect(r).toMatchObject({ ok: true, data: { description: "Taxi", totalAmount: 23.4 } });
  });
});

describe("image validation (no network call on bad input)", () => {
  const ok = { mediaType: "image/jpeg" as const, dataBase64: "AAAA" };
  it.each([
    ["too many images", [ok, ok, ok], 2, 1000, /at most 2/],
    ["unsupported type", [{ mediaType: "image/tiff" as never, dataBase64: "AAAA" }], 5, 1000, /JPEG, PNG, GIF or WebP/],
    ["not base64", [{ ...ok, dataBase64: "data:image/png;base64,AAAA" }], 5, 1000, /not valid base64/],
    ["too large", [{ ...ok, dataBase64: "A".repeat(2000) }], 5, 1000, /larger than/],
  ])("rejects %s", (_name, images, maxImages, maxBytes, message) => {
    expect(() => validateImages(images, maxImages, maxBytes)).toThrow(message);
  });

  it("rejects before calling the provider", async () => {
    const f = fake();
    const p = createAnthropicProvider({ client: f.client, maxImages: 0 });
    await expect(p.extract({ ...req, images: [ok] })).rejects.toMatchObject({ kind: "bad_input" });
    expect(f.beta).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  const gen = (status: number) => Anthropic.APIError.generate(status, { error: { type: "x", message: "internal-detail KEY-VALUE-123" } }, `HTTP ${status}`, new Headers({ "request-id": "req_9" }));
  it.each([
    [401, "auth", false], [403, "auth", false], [429, "rate_limit", true],
    [400, "bad_request", false], [500, "server", true], [529, "server", true], [404, "unknown", false],
  ])("HTTP %i becomes kind=%s (retryable=%s)", (status, kind, retryable) => {
    const e = toProviderError(gen(status));
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
    expect(e.status).toBe(status);
  });

  it("never exposes provider text or keys in user-facing messages", () => {
    for (const status of [401, 429, 500]) {
      expect(toProviderError(gen(status)).userMessage).not.toMatch(/internal-detail|KEY-VALUE/);
    }
  });

  it("maps connection errors, timeout first", () => {
    expect(toProviderError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(toProviderError(new Anthropic.APIConnectionError({ message: "ECONNRESET" })).kind).toBe("network");
    expect(toProviderError(new Error("boom")).kind).toBe("unknown");
  });

  it("extract() throws mapped errors from the client", async () => {
    const f = fake();
    f.beta.mockRejectedValue(gen(429));
    await expect(createAnthropicProvider({ client: f.client }).extract(req)).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("refuses to start without credentials", () => {
    expect(() => createAnthropicProvider({})).toThrow(/ANTHROPIC_API_KEY/);
  });
});
