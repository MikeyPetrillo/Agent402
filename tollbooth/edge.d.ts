// Type declarations for agent402-tollbooth/edge: the gate built on Web Crypto
// and the Fetch API (Cloudflare Workers, Next.js middleware, Deno, Bun).

import type { ReplayStore, StatsSink } from "./index.js";
export type { ReplayStore, StatsSink } from "./index.js";

export interface EdgeTollboothConfig {
  price?: string;
  payTo?: string | null;
  network?: string;
  asset?: string;
  pow?: boolean;
  powDifficulty?: number;
  /** Stable HMAC secret for proof-of-work tokens (required on the edge). */
  secret?: string;
  /** Single-use replay backend (for example a KV wrapper). */
  store?: ReplayStore;
  /** Verifies a USDC payment: (request, requirements) => boolean. Without it no USDC quote is offered. */
  verifyX402?: ((request: Request, requirements: unknown) => boolean | Promise<boolean>) | null;
  mpp?: boolean;
  mppAssetAddress?: string;
  mppAssetName?: string;
  mppRealm?: string;
  botUserAgents?: string[];
  /** Who pays: "bots" (default), "all", or "strict" (listed bots and anything that is not a browser page load). */
  mode?: "bots" | "all" | "strict";
  /** Paths an empty-User-Agent GET or HEAD reads free in "bots" and "strict" modes (a health check), matched exactly on the raw request path with the query aside; a path with a "%" escape or a "." or ".." segment never matches. Default ["/healthz", "/health"]; [] for none. */
  healthPaths?: string[];
  charge?: (request: Request) => boolean;
  free?: (request: Request) => boolean;
  resourceBaseUrl?: string;
  observe?: boolean;
  statsSink?: StatsSink;
  message?: string;
}

/** Returns a 402 Response when the client must pay, or null to let it through. */
export interface EdgeTollbooth {
  (request: Request): Promise<Response | null>;
  observe: boolean;
  stats(): Record<string, unknown>;
  snapshot(): Promise<Record<string, unknown>>;
  flush(): Promise<void>;
}

export interface EdgeProofOfWork {
  difficulty: number;
  challenge(resource: string): Promise<Record<string, unknown>>;
  verify(solution: string, resource: string): Promise<unknown>;
}

export function createEdgeTollbooth(config?: EdgeTollboothConfig): EdgeTollbooth;
export function createEdgePow(opts: { secret: string; difficulty?: number; ttlMs?: number; store?: ReplayStore }): EdgeProofOfWork;
export function memorySink(): StatsSink;
export function kvStatsSink(kv: unknown, opts?: { bucket?: string; ttlSeconds?: number }): StatsSink;
export function httpStatsSink(url: string, opts?: { token?: string; batchMs?: number; fetchImpl?: typeof fetch; allowInsecure?: boolean }): StatsSink;
/** The default health paths an empty-User-Agent check reads free. */
export const DEFAULT_HEALTH_PATHS: readonly string[];
