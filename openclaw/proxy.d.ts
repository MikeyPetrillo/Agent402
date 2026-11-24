// Type declarations for agent402-openclaw/proxy: the local OpenAI- and
// Anthropic-compatible proxy that pays each call.
import type { RouteTable } from "./models.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_UPSTREAM: string;
export const PKG_VERSION: string;
export const MESSAGES_UPSTREAM_PATH: string;

export interface ProxyOptions {
  /** Default "https://agent402.tools". */
  upstream?: string;
  /** A prepaid credits key (a402_...). */
  creditsKey?: string | null;
  /** An x402-paying fetch for wallet payment. */
  payFetch?: FetchLike | null;
  /** Plain fetch (tests inject one). */
  fetch?: FetchLike;
  /** 0 = an ephemeral port. */
  port?: number;
  /** Default 127.0.0.1 (loopback only: anyone who can reach the port spends the key). */
  host?: string;
  /** Pre-loaded routes; else read from the upstream. */
  routes?: RouteTable | null;
  /** "metered" (default): explicit models pay per-request quotes; "flat": home tiers. */
  pricing?: "metered" | "flat";
  log?: (message: string) => void;
}

export interface RunningProxy {
  baseUrl: string;
  port: number;
  mode: "credits" | "x402" | "unpaid";
  upstream: string;
  pricing: "metered" | "flat";
  stats(): { requests: number; forwarded: number; errors: number; startedAt: string };
  /** Reread /v1/models; resolves to the model count. */
  refreshModels(): Promise<number>;
  close(): Promise<void>;
}

export function startProxy(opts?: ProxyOptions): Promise<RunningProxy>;
export function loadRoutes(upstream: string, fetchImpl?: FetchLike, opts?: { pricing?: "metered" | "flat" }): Promise<RouteTable>;
/** An upstream refusal carrying an x402 offer, in the OpenAI error shape; null for any other body. */
export function refusalAsOpenAIError(status: number, doc: unknown): { error: { message: string; type: string; code: string | null }; [key: string]: unknown } | null;
/** The same refusal in the Anthropic error shape; null for any other body. */
export function refusalAsAnthropicError(status: number, doc: unknown): { type: "error"; error: { type: string; message: string }; [key: string]: unknown } | null;
