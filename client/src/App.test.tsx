import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App.tsx";

afterEach(() => vi.restoreAllMocks());

it("shows which integrations still need keys", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, paypal: false, ai: true, paypalEnv: "sandbox" })),
  );
  render(<App />);
  expect(await screen.findByText(/PayPal sandbox keys: missing/)).toBeInTheDocument();
  expect(screen.getByText(/AI key: configured/)).toBeInTheDocument();
});

it("shows a readable error when the server is down", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("connection refused");
});
