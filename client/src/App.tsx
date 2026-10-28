import { useEffect, useState } from "react";
import { getHealth, type Health } from "./lib/api.ts";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">SplitPilot</h1>
      <p className="text-slate-600">Paste a trip chat or receipt, settle up with PayPal.</p>
      <section aria-live="polite" className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-900/5">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">Setup status</h2>
        {error && <p role="alert" className="mt-2 text-sm text-danger-700">Server unreachable: {error}</p>}
        {!error && !health && <p className="mt-2 text-sm text-slate-500">Checking server…</p>}
        {health && (
          <ul className="mt-2 space-y-1 text-sm">
            <li>PayPal sandbox keys: {health.paypal ? "configured" : "missing (server/.env)"}</li>
            <li>AI key: {health.ai ? "configured" : "missing (server/.env)"}</li>
          </ul>
        )}
      </section>
    </main>
  );
}
