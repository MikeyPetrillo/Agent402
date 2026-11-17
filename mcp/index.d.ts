// Type declarations for agent402-mcp. The package is an MCP server run as a
// command (npx agent402-mcp), so it exports no runtime values; these types
// describe its configuration and the structuredContent of the tools it lists,
// for code that drives it through an MCP client.

/** Environment the server reads at start. */
export interface Agent402McpEnv {
  /** Target service (default https://agent402.tools). */
  AGENT402_URL?: string;
  /** Hex private key of a funded EVM wallet (USDC). */
  AGENT_KEY?: string;
  /** Base58 or JSON byte-array secret key of a funded Solana wallet (USDC). */
  SOLANA_AGENT_KEY?: string;
  /** Comma-separated slugs listed first-class (replaces the default set). */
  AGENT402_TOOLS?: string;
  /** Refuse a single call above this many USD (default "4"; "off" disables). */
  AGENT402_MAX_PER_CALL?: string;
  /** Cap on USD spent this session (default "25"; "off" disables). */
  AGENT402_BUDGET?: string;
  /** A prepaid credits key (a402_...). */
  AGENT402_CREDITS_KEY?: string;
  /** "1" lists router.execute and sellers.list without a wallet. */
  AGENT402_SHOW_ROUTER?: string;
  /** Restrict and order the chains paid on, e.g. "base,solana" or "eip155:4663". */
  AGENT402_NETWORKS?: string;
  /** "auto" (default), "off" or "always": run slow routes as jobs. */
  AGENT402_ASYNC?: string;
  /** Overall wait for a job in ms. */
  AGENT402_ASYNC_TIMEOUT_MS?: string;
}

/** Names this server lists in tools/list. */
export type Agent402McpToolName =
  | "catalog.search" | "catalog.find" | "catalog.call"
  | "payment.info" | "server.describe" | "sellers.list" | "router.execute"
  | "web.search" | "web.answer" | "web.news" | "browser.render" | "market.quote"
  | "audio.transcribe" | "memory.read" | "memory.write" | "decide.plan" | "decide.execute";

/** catalog.search arguments. `limit` is clamped to 1..25 (default 10). */
export interface CatalogSearchArgs { query: string; limit?: number }
export interface CatalogSearchHit {
  slug: string;
  method: string;
  path: string;
  price: string;
  payment: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface CatalogSearchResult {
  results: CatalogSearchHit[];
  workflows?: Array<{ slug: string; title?: string; tagline?: string; toolCount: number; promptName: string; score: number }>;
  workflowsUsage?: string;
  usage?: string;
  message?: string;
}

/** catalog.find arguments. `limit` is clamped to 1..25 (default 5). */
export interface CatalogFindArgs { task: string; limit?: number }
export interface CatalogFindMatch {
  slug: string;
  name?: string;
  price?: string;
  description?: string;
  example?: unknown;
  required?: string[];
  inputSchema?: Record<string, unknown>;
  callWith: { name: "catalog.call"; arguments: { slug: string; params: Record<string, unknown> } };
}
export interface CatalogFindResult {
  task: string;
  matches: CatalogFindMatch[];
  results: CatalogFindMatch[];
  workflows?: unknown[];
  usage: string;
}

/** catalog.call arguments: `params` is an object, or a JSON string of one. */
export interface CatalogCallArgs { slug: string; params?: Record<string, unknown> | string }
export interface CatalogCallResult<T = unknown> { slug: string; result: T }

/** router.execute arguments. */
export interface RouterExecuteArgs { task: string; params?: Record<string, unknown> | string; maxUsd?: number }

export interface SpendControls {
  maxPerCallUsd: number | "unlimited";
  sessionBudgetUsd: number | "unlimited";
  spentThisSessionUsd: number;
  heldThisSessionUsd: number;
  remainingUsd: number | "unlimited";
}
export interface PaymentInfoResult {
  service: string;
  mode: "usdc" | "credits" | "proof-of-work";
  wallet: string | null;
  solanaWallet: string | null;
  network: string;
  networks?: unknown;
  tools: number;
  payableWithCompute: number;
  walletOnly: number;
  workflows: number;
  credits: Record<string, unknown>;
  spendControls: SpendControls | string;
  note: string;
  install: Record<string, unknown>;
  positioning: string;
  ecosystem: string;
}

export interface SellersListArgs { limit?: number; sort?: "usd" | "calls"; include?: "external" | "all"; wire?: "x402" | "mpp" }
export interface SellersListResult {
  window: string | null;
  asOf: string | null;
  sort: string;
  include: string;
  totalSellers: number;
  results: Array<Record<string, unknown> & { untrustedContent?: true }>;
  containsUntrustedContent?: true;
  note?: string;
  source: string;
  wire?: "mpp";
}
