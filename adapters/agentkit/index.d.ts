// Type declarations for agent402-action-provider. The runtime is index.js (plain ES
// modules on agent402-client); these declarations describe its public API.
// AgentKit, zod and the wallet provider are typed loosely, so the
// declarations import nothing from those peers.

/** An AgentKit wallet provider (an EVM one that can sign typed data), typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WalletProviderLike = any;

export interface Agent402ActionOptions {
  /** Default "https://agent402.tools". */
  baseUrl?: string;
  /** Fetch used for free discovery and as the base of the paying fetch (default: the global fetch). */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** A zod module (loaded from the host when omitted). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zod?: any;
  /** Ceiling on one paid call in USD (default 5); 0 or "off" turns it off; a value that does not parse keeps the default. */
  maxPerCallUsd?: number | string | null;
  /** Ceiling on rolling 24-hour paid spend in USD (opt-in). */
  dailyLimitUsd?: number | null;
  /** Ceiling on rolling 24-hour paid spend to one seller host in USD (opt-in). */
  maxPerHostUsd?: number | null;
  /** Only pay these payTo addresses (lowercased EVM); anything else is refused before signing. */
  payees?: string[] | null;
  /** A prepaid credits key (a402_...). */
  creditsKey?: string | null;
}

/** One AgentKit action: its zod schema and an invoke that resolves to text. */
export interface Agent402Action {
  name: "agent402_find" | "agent402_call" | "agent402_about";
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(...args: any[]): Promise<string>;
}

/** The default per-call ceiling in USD. */
export const DEFAULT_MAX_PER_CALL_USD: number;
/** The ceiling agent402-client gets for a setting: the default when unset, null for 0 or "off". */
export function resolveMaxPerCallUsd(v: unknown, warn?: (message: string) => void): number | null;
/** The three actions as plain objects. */
export function agent402Actions(opts?: Agent402ActionOptions): Promise<Agent402Action[]>;
/** An AgentKit action provider holding the three actions (needs @coinbase/agentkit). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function agent402ActionProvider(opts?: Agent402ActionOptions): Promise<any>;
/** An x402-paying fetch for an AgentKit wallet provider, or undefined when the provider cannot sign. */
export function payFetchFor(
  walletProvider: WalletProviderLike,
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  opts?: { payees?: string[] | null },
): Promise<((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined>;
