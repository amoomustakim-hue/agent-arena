/**
 * Client-side access to the FastAPI backend. Browser-only (uses `fetch`
 * against a public URL and native `WebSocket`) — the static war room and
 * reputation pages read files directly instead and never import this.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
export const WS_URL = API_URL.replace(/^http/, "ws");

export interface MarketSummary {
  marketId: string;
  asset: string;
  window: string;
  question: string;
  expiresIn: string;
  hasHeadroom: boolean;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  venue: string;
  trading: string;
  mode: string;
  network: string;
  model: string;
  anthropic: { ready: boolean; source: string; detail?: string };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const getHealth = () => fetch(`${API_URL}/health`).then((r) => json<HealthStatus>(r));

export const listMarkets = (opts: { asset?: string; max?: number } = {}) => {
  const params = new URLSearchParams();
  if (opts.asset) params.set("asset", opts.asset);
  if (opts.max) params.set("max", String(opts.max));
  return fetch(`${API_URL}/markets?${params}`).then((r) => json<{ markets: MarketSummary[] }>(r));
};

export const startCouncil = (marketId: string, budgetCollateral = 300) =>
  fetch(`${API_URL}/council/${marketId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budgetS: budgetCollateral }),
  }).then((r) => json<{ sessionId: string; marketId: string }>(r));

export const proposeTrade = (sessionId: string, budgetCollateral?: number) =>
  fetch(`${API_URL}/council/${sessionId}/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(budgetCollateral ? { budgetCollateral } : {}),
  }).then((r) => json<Record<string, unknown>>(r));

export const settleSession = (sessionId: string) =>
  fetch(`${API_URL}/council/${sessionId}/settle`, { method: "POST" }).then((r) =>
    json<{ sessionId: string; settled: boolean; detail?: string; outcome?: string }>(r),
  );
