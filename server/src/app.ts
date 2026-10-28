import cors from "cors";
import express from "express";
import { configStatus, type Env } from "./config/env.ts";

/** Built separately from listen() so tests can mount it without opening a port. */
export function createApp(env: Env) {
  const app = express();
  app.disable("x-powered-by");

  // Browsers only call us from the React app, so allow exactly that origin.
  app.use(cors({ origin: env.CLIENT_URL }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ...configStatus(env) });
  });

  // Route modules mount here as they are built:
  //   app.use("/api/expenses", expensesRouter(...));
  //   app.use("/api/settlements", settlementsRouter(...));
  //   app.use("/api/paypal", createPayPalRouter(...));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}
