// Type declarations for agent402-mcp. The package is an MCP server run as a
// command (npx agent402-mcp), so it exports no runtime values; these types
// describe its configuration and the structuredContent of the tools it lists,
// for code that drives it through an MCP client.

/** Environment the server reads at start. */
export interface Agent402McpEnv {
  /** Target service (default https://agent402.tools). */
  AGENT402_URL?: string;
  /** Hex private key of a funded EVM wallet (USDC): 64 hex characters, with or without 0x.
   *  Unset, the key `npx agent402-mcp setup` stored in the OS keychain is read. */
  AGENT_KEY?: string;
  /** Where the stored key lives: "auto" (default), "macos", "windows", "secret-tool", "file" or "off". */
  AGENT402_KEY_STORE?: string;
  /** Cap on USD spent per UTC day, kept across restarts (unset or "off" means none). */
  AGENT402_MAX_USD_PER_DAY?: string;
  /** Cap on USD spent per UTC calendar month, kept across restarts (unset or "off" means none). */
  AGENT402_MAX_USD_PER_MONTH?: string;
  /** Folder for spend.json and, without a keychain, the key file (default: the per-user config folder). */
  AGENT402_CONFIG_DIR?: string;
  /** Folder media answers are written to (default ~/Downloads/agent402, else the OS temp folder). */
  AGENT402_OUTPUT_DIR?: string;
  /** "1" returns media answers inline instead of as files. */
  AGENT402_MEDIA_INLINE?: string;
  /** Base58 or JSON byte-array secret key of a funded Solana wallet (USDC). */
  SOLANA_AGENT_KEY?: string;
  /** Comma-separated slugs listed first-class (replaces the default set). */
  AGENT402_TOOLS?: string;
  /** Refuse a single call above this many USD (default "5"; "0" or "off" means none). */
  AGENT402_MAX_PER_CALL?: string;
  /** Optional cap on USD spent this session (no cap unless set; "off" means none). */
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

/** Names this server can list in tools/list; a flagship is listed only when
 *  the server's catalog serves its tool (market.quote, decide.plan and
 *  decide.execute are absent on a server without them). */
export type Agent402McpToolName =
  | "catalog.search" | "catalog.find" | "catalog.call"
  | "payment.info" | "server.describe" | "sellers.list" | "router.execute"
  | "web.search" | "web.answer" | "web.news" | "browser.render"
  | "audio.transcribe" | "memory.read" | "memory.write" | "decide.plan" | "decide.execute"
  | "market.quote";

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
  /** Present while AGENT402_MAX_USD_PER_DAY is set. */
  daily?: SpendCapStatus;
  /** Present while AGENT402_MAX_USD_PER_MONTH is set. */
  monthly?: SpendCapStatus;
  /** The ledger file, while either cap is set. */
  ledger?: string;
  ledgerError?: string;
}
/** A daily or monthly cap: what is spent and left, and when it resets (ISO 8601, UTC). */
export interface SpendCapStatus { capUsd: number; spentUsd: number; leftUsd: number; resetsAt: string; setting: string }
/** A media answer written to a file. */
export interface SavedMedia { savedTo: string; bytes: number; contentType: string }
export interface PaymentInfoResult {
  service: string;
  mode: "usdc" | "credits" | "proof-of-work";
  wallet: string | null;
  /** "AGENT_KEY", the stored key, or null without an EVM key. */
  walletKeySource: string | null;
  mediaOutput: string;
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
