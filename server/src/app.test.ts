import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./config/env.ts";

describe("app", () => {
  const env = loadEnv({ CLIENT_URL: "http://localhost:5173" });
  const server = createApp(env).listen(0);
  let base = "";
  beforeAll(() => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("reports health and which integrations are configured, without leaking values", async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toEqual({ ok: true, paypal: false, ai: false, paypalEnv: "sandbox" });
  });

  it("sends CORS headers only for the configured client origin", async () => {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("answers unknown routes with JSON 404", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("loadEnv", () => {
  it("refuses live PayPal, because this project is sandbox-only", () => {
    expect(() => loadEnv({ PAYPAL_ENV: "live" })).toThrow(/sandbox only/);
  });
  it("rejects a malformed URL with a readable message", () => {
    expect(() => loadEnv({ CLIENT_URL: "not a url" })).toThrow(/CLIENT_URL/);
  });
});
