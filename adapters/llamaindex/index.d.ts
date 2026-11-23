// Type declarations for agent402-llamaindex. The runtime is index.js (plain ES modules on
// agent402-client); these declarations describe its public API.
import type { Agent402, FetchLike } from "agent402-client";

export interface Agent402ToolOptions {
  /** Default "https://agent402.tools". */
  baseUrl?: string;
  /** Only these slugs (recommended: every tool is a definition the model reads). */
  slugs?: string[];
  /** Only the tools that run free with proof of work (default true). */
  freeOnly?: boolean;
  /** An x402- or MPP-wrapped fetch that pays wallet-only tools. */
  fetch?: FetchLike;
  /** Spending caps passed to agent402-client: one paid call (default 5; 0 or "off" turns it off). */
  maxPerCallUsd?: number | string | null;
  /** Rolling 24-hour total for paid calls (opt-in). */
  dailyLimitUsd?: number | null;
  /** Rolling 24-hour total per seller host (opt-in). */
  maxPerHostUsd?: number | null;
  /** The @x402/core x402Client the fetch wraps, so the caps hold on the payment that is signed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  x402Client?: any;
}

export type ExecuteOptions = Omit<Agent402ToolOptions, "slugs" | "freeOnly">;

/** Runs a tool by its tool name (or slug) and resolves to its JSON answer. */
export type Agent402Execute = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

/** A LlamaIndex.TS function tool, typed loosely (llamaindex is a peer). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LlamaIndexTool = any;

/** Agent402 tools as LlamaIndex.TS function tools, the client, and an executor (needs llamaindex). */
export function agent402Tools(opts?: Agent402ToolOptions): Promise<{ client: Agent402; tools: LlamaIndexTool[]; execute: Agent402Execute }>;

/** An executor for a tool list built another way. */
export function agent402Execute(opts?: ExecuteOptions): Agent402Execute;

export default agent402Tools;
