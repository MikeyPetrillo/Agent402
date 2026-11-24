// Type declarations for agent402-openclaw/models: the route table read from
// the gateway's /v1/models and the OpenClaw provider config built from it.

/** One model the local proxy can serve, and the gateway route it pays. */
export interface Agent402Route {
  id: string;
  endpoint: string;
  tier: string | null;
  priceUsd: number;
  metered?: boolean;
  maxTokens: number;
  maxInputChars: number;
  stealth: boolean;
}
export type RouteTable = Map<string, Agent402Route>;

/** An OpenClaw `models[]` entry. */
export interface OpenClawModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const AUTO_ID: "auto";
export const METERED_MAX_INPUT_CHARS: number;
export const METERED_MAX_TOKENS: number;
export const OPENCLAW_MIN_INPUT_CHARS: number;
export const PRIMARY_PREFERENCE: string[];

export function stripTrailingSlashes(s: string): string;
/** The route table from a /v1/models document; "metered" (the default) pays explicit models per request. */
export function routesFromCatalog(catalog: unknown, opts?: { pricing?: "metered" | "flat" }): RouteTable;
/** The route OpenClaw should make its primary model, or null when none fits its prompt. */
export function defaultPrimary(routes: RouteTable, opts?: { minInputChars?: number }): Agent402Route | null;
export function openclawModels(routes: RouteTable): OpenClawModel[];
/** An OpenClaw ModelProviderConfig pointing at the local proxy. */
export function providerModelsConfig(baseUrl: string, routes: RouteTable): { baseUrl: string; api: "openai-completions"; models: OpenClawModel[] };
