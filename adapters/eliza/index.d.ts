import type { Plugin, Action, Provider, IAgentRuntime, Memory } from "@elizaos/core";
export declare const findAction: Action;
export declare const callAction: Action;
export declare const aboutAction: Action;
export declare const agent402Provider: Provider;
export declare const agent402Plugin: Plugin;
/** How AGENT402_CALL chose its tool and input; exported for hosts and tests. */
export declare function resolveCallInput(runtime: IAgentRuntime, message: Memory, options: unknown, client: unknown): Promise<{ slug: string; params: Record<string, unknown>; via: "parameters" | "content" | "model" } | { error: string }>;
/** The runtime's rolling-24h paid spend as its client sees it (null before the first call). */
export declare function spendingSummaryFor(runtime: IAgentRuntime): { dailyUsd: number; calls: number; byHost: Record<string, number>; limits: Record<string, number | null> } | null;
/** The default per-call ceiling in USD (AGENT402_MAX_PER_CALL_USD unset). */
export declare const DEFAULT_MAX_PER_CALL_USD: number;
/** The per-call ceiling for a setting value: the default when unset, null for 0 or "off", the default (with one stderr warning) when it does not parse. */
export declare function maxPerCallFrom(raw: string | number | null | undefined, warn?: (message: string) => void): number | null;
export default agent402Plugin;
