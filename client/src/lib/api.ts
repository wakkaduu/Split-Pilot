export interface Health {
  ok: boolean;
  paypal: boolean;
  ai: boolean;
  paypalEnv: string;
}

/** Thin fetch wrapper: JSON in, JSON out, and a readable Error when the server says no. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const getHealth = () => api<Health>("/api/health");
