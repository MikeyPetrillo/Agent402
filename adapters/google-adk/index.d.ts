// Type declarations for agent402-google-adk. The runtime is index.js (plain ES modules,
// no dependencies); these declarations describe its public API. The
// framework objects it returns are typed loosely, so the declarations import
// nothing from the framework (an optional peer).

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Agent402ToolOptions {
  /** Default "https://agent402.tools". */
  baseUrl?: string;
  /** An x402-wrapped fetch that pays wallet-only tools. */
  fetch?: FetchLike;
  /** Plain fetch for unpaid lookups (default: the global fetch). */
  fetchImpl?: FetchLike;
  /** Ceiling on one paid call in USD, checked on the tool's listed price before the payment fetch runs (default 5; 0, "off" or null turns it off). */
  maxPerCallUsd?: number | string | null;
  /** Opt-in rolling 24-hour total for paid calls, in USD. */
  dailyLimitUsd?: number | null;
}

/** A framework-agnostic tool: a JSON Schema and a plain async execute. */
export interface Agent402ToolSpec {
  name: "agent402_find" | "agent402_route" | "agent402_call" | "agent402_about";
  description: string;
  parametersJsonSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  execute(input: Record<string, unknown>): Promise<unknown>;
}

/** Thrown before anything is paid when a spending cap refuses a call. */
export interface SpendingLimitError extends Error {
  name: "SpendingLimitError";
  code: "SPENDING_LIMIT";
  limit: "maxPerCallUsd" | "dailyLimitUsd";
  slug: string;
  priceUsd?: number;
  cap?: number;
  spent?: number;
}

/** The default per-call ceiling in USD (agent402-client's default). */
export const DEFAULT_MAX_PER_CALL_USD: number;
/** The largest proof-of-work difficulty, in bits, this package solves. */
export const MAX_POW_DIFFICULTY: number;

/** The four meta tools as framework-agnostic specs. */
export function agent402ToolSpecs(opts?: Agent402ToolOptions): Agent402ToolSpec[];

/** A Google ADK FunctionTool, typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdkFunctionTool = any;

/** The four meta tools as ADK FunctionTools (needs @google/adk and zod). */
export function agent402Tools(opts?: Agent402ToolOptions): Promise<AdkFunctionTool[]>;

export default agent402Tools;
