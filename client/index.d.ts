// Type declarations for agent402-client. The runtime is index.js (plain ES
// modules, zero dependencies); these declarations describe its public API.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** An EIP-712 signer (a viem account works). */
export interface TypedDataSigner {
  address: string;
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string> | string;
}

export interface GatewayOptions {
  /** Signer holding a USDC deposit in Circle Gateway. */
  signer: TypedDataSigner;
  /** Chain names or CAIP-2 ids whose batched accepts it may sign (default: any pinned EVM chain). */
  networks?: string[];
  /** Added or replacement GatewayWallet contracts, keyed "eip155:<chainId>". */
  verifyingContracts?: Record<string, string>;
}

export interface OutputValidator {
  /** Stable semantic id; namespaces the cache entry. */
  id: string;
  /** Return false or throw to reject delivery. */
  validate(body: unknown): unknown | Promise<unknown>;
  /** Per-validator bound in ms (default 5000). */
  timeoutMs?: number;
}

/** A job document polled from a slow route's job link. */
export interface JobProgress {
  status?: string;
  state?: string;
  stage?: string;
  progress?: number;
  etaSeconds?: number;
  [key: string]: unknown;
}

export interface Agent402Options {
  /** Default https://agent402.tools */
  baseUrl?: string;
  /** An x402- or MPP-wrapped fetch that pays wallet-only tools. */
  fetch?: FetchLike;
  /** Cache results in memory (default true). */
  cache?: boolean;
  /** Plain fetch (default: global fetch through distrustFetch). */
  fetchImpl?: FetchLike;
  /** A calling package's own product token ("name/version"). */
  userAgent?: string;
  /** Refuse a TLS chain through a distrusted intermediate CA (default true). */
  tlsDistrust?: boolean;
  /** Resend the SDK's own request once on a connection reset (default true). */
  retryResets?: boolean;
  /** Per-call ceiling in USD (default 5; 0, "off" or null turns it off; a malformed value keeps the default and warns). */
  maxPerCallUsd?: number | string | null;
  /** Opt-in rolling-24h ceiling in USD (no cap unless set). */
  dailyLimitUsd?: number | null;
  /** Opt-in rolling-24h ceiling per seller host in USD (no cap unless set). */
  maxPerHostUsd?: number | null;
  /** The @x402/core x402Client your fetch wraps: the caps are then enforced at signing. */
  x402Client?: unknown;
  /** Chains a pre-wrapped fetch pays on (names withNetworkPreference takes). */
  payNetworks?: string[];
  /** A prepaid credits key (a402_...). */
  creditsKey?: string;
  /** Pay the Circle Gateway batched accept where a 402 offers one. */
  gateway?: GatewayOptions | null;
  /** Ceiling on a response body, enforced before parsing (default 32 MB; null disables). */
  maxResponseBytes?: number | null;
  outputValidator?: OutputValidator | null;
  /** Run slow routes as jobs: "auto" (default), true or false. */
  respondAsync?: "auto" | boolean;
  /** Overall wait for a job (default 15 minutes). */
  asyncTimeoutMs?: number;
  onProgress?: ((doc: JobProgress) => void) | null;
  /** How long each request may take (default 120000 ms); null waits as long as the connection stays open. */
  timeoutMs?: number | null;
}

export interface CallOptions {
  idempotencyKey?: string;
  cache?: boolean;
  maxResponseBytes?: number | null;
  outputValidator?: OutputValidator | null;
  respondAsync?: "auto" | boolean;
  asyncTimeoutMs?: number;
  onProgress?: ((doc: JobProgress) => void) | null;
  /** Allow this call to pay up to this many USD: replaces the per-call cap for the call. */
  maxUsd?: number;
  /** Replaces the client's per-request timeout for this call; null waits without one. */
  timeoutMs?: number | null;
}

export interface FindResult {
  slug: string;
  name?: string;
  price?: string;
  description?: string;
  example?: unknown;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface WorkflowMatch {
  slug: string;
  title?: string;
  tagline?: string;
  toolSlugs?: string[];
  score?: number;
  url?: string;
  promptName?: string;
  [key: string]: unknown;
}

export interface RouteAnswer {
  query: string;
  include: string;
  count: number;
  sellers: number;
  results: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface TopSellers {
  window: string;
  asOf: string;
  sort: string;
  include: string;
  totalSellers: number;
  results: Array<Record<string, unknown>>;
  warming?: true;
  source: string;
}

export interface SpendingSummary {
  dailyUsd: number;
  calls: number;
  byHost: Record<string, number>;
  heldUsd: number;
  heldCalls: number;
  heldByHost: Record<string, number>;
  limits: { maxPerCallUsd: number | null; dailyLimitUsd: number | null; maxPerHostUsd: number | null };
}

export interface PowChallenge {
  challenge: string;
  difficulty: number;
  token: string;
  [key: string]: unknown;
}

export class Agent402 {
  constructor(opts?: Agent402Options);
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly timeoutMs: number | null;
  find(task: string, opts?: { k?: number }): Promise<FindResult[]>;
  route(task: string, opts?: { k?: number; include?: "all" | "external" | "local"; network?: string }): Promise<RouteAnswer>;
  findWorkflows(task: string, opts?: { k?: number }): Promise<WorkflowMatch[]>;
  getWorkflowPrompt(slug: string, args?: Record<string, unknown>): Promise<{ messages: Array<{ role: string; content: unknown }>; [key: string]: unknown }>;
  topSellers(opts?: { limit?: number; sort?: "usd" | "calls"; include?: "external" | "all" }): Promise<TopSellers>;
  call<T = any>(slug: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  collectJob<T = any>(jobUrl: string, opts?: { timeoutMs?: number; onProgress?: (doc: JobProgress) => void; maxResponseBytes?: number | null }): Promise<T>;
  guardX402Client<C>(client: C): C;
  spendingSummary(): SpendingSummary;
  clearCache(): void;
  static solvePow(pow: PowChallenge): string;
  static solvePowAsync(pow: PowChallenge): Promise<string>;
  static registerBuilderCode(walletAddress: string, opts?: { fetchImpl?: FetchLike }): Promise<{ builderCode: string; walletAddress: string }>;
}
export default Agent402;

export class SpendingLimitError extends Error {
  /** Which cap refused: "maxPerCallUsd", "dailyLimitUsd", "maxPerHostUsd", "knownAsset" or "signing". */
  limit: string;
  slug?: string;
  priceUsd?: number | null;
  cap?: number;
  listPriceUsd?: number;
  spent?: number;
  heldUsd?: number;
  atSigning?: boolean;
  paid?: false | "unknown";
  [key: string]: unknown;
}
export class PaymentRedirectError extends Error {
  slug: string;
  status: number | null;
  location: string | null;
  paid: false;
}
export class ResponseTooLargeError extends Error {
  size: number;
  cap: number;
  slug?: string;
  paid: boolean;
  source?: string;
}
export class OutputValidationError extends Error {
  slug?: string;
  contractId?: string;
  paid: boolean;
  cacheHit: boolean;
}
export class GatewayPendingError extends Error {
  slug: string;
  /** The signed payment: resend it as PAYMENT-SIGNATURE, never a new signature. */
  paymentHeader: string;
  status: 402;
  paid: "unknown";
  retryAfterSeconds: number | null;
}
export class RequestTimeoutError extends Error {
  timeoutMs: number;
  slug: string | null;
  paid: false | "unknown";
}
export class AsyncJobPendingError extends Error {
  jobUrl?: string;
  slug?: string;
  job: unknown;
  mayBeCharged: true;
}

export const DEFAULT_BASE_URL: string;
/** The per-call ceiling a client gets when maxPerCallUsd is not set (USD). */
export const DEFAULT_MAX_PER_CALL_USD: number;
/** The per-call ceiling a maxPerCallUsd value gives: the default when unset or malformed (warns), null when 0, "off" or null. */
export function perCallCeilingOf(value: unknown, warn?: (message: string) => void): number | null;
export const DEFAULT_REQUEST_TIMEOUT_MS: number;
export const DEFAULT_HOST_BLIND_HOLD_MS: number;
export const HOLD_SLACK_MS: number;
export const GATEWAY_KIND_NAME: "GatewayWalletBatched";
export const GATEWAY_MAX_TIMEOUT_SECONDS: number;
export const GATEWAY_VERIFYING_CONTRACTS: Readonly<Record<string, string>>;
export const MAX_POW_DIFFICULTY: number;
export const MAX_POW_TRIES_FACTOR: number;
export const MAX_VALIDITY_SECONDS: number;
export const NETWORK_CAIP2: Readonly<Record<string, string>>;
export const NETWORK_NAMES: Readonly<Record<string, string[]>>;
export const KNOWN_ASSETS: Readonly<Record<string, Array<{ asset: string; decimals: number; symbol: string; name?: string; version?: string }>>>;
export const DISTRUSTED_SPKI_SHA256: Readonly<Record<string, string>>;

/** One x402 payment requirement (an entry of a 402's accepts). */
export interface PaymentAccept {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export function solvePowAsync(pow: { challenge: string; difficulty: number }, opts?: { useWorker?: boolean }): Promise<number>;
export function knownAsset(network: string, asset: string): { asset: string; decimals: number; symbol: string } | null;
export function acceptUsd(accept: PaymentAccept, x402Version?: number): number | null;
export function networkIdsOf(pref: string): string[];
export function quoted402Usd(res: Response): Promise<number | null>;
export function signedValidUntilMs(paymentPayload: unknown, opts?: { maxSeconds?: number; nowMs?: number }): number | null;
export function gatewayAcceptOf(accepts: PaymentAccept[], networks?: string[] | null, verifyingContracts?: Record<string, string>): PaymentAccept | null;
export function signGatewayPayment(accept: PaymentAccept, opts: { signer: TypedDataSigner; resource?: Record<string, unknown>; now?: () => number; nonce?: string; verifyingContracts?: Record<string, string> }): Promise<{ payload: Record<string, unknown>; header: string }>;
export function withNetworkPreference<C>(client: C, networks: string[]): C;
export function withPayeeAllowlist<C>(client: C, payees: string[]): C;
export function distrustFetch(baseFetch?: FetchLike, opts?: { extraSpki?: string[] }): FetchLike;
export function distrustDispatcher(opts?: { extraSpki?: string[] }): Promise<unknown>;
export function distrustCheckServerIdentity(extraSpki?: string[]): (host: string, cert: unknown) => Error | undefined;
export function resetRetryFetch(baseFetch?: FetchLike, opts?: { pauseMs?: number }): FetchLike;
export function isConnectionReset(err: unknown): boolean;

/** The record a signed Agent402-Receipt carries. */
export interface ReceiptRecord {
  v: 1; id: string; iss: string | null; iat: string; method: string; path: string; slug: string | null;
  requestSha256: string; responseSha256: string; priceUsd: string | null; rail: string;
  network: string | null; payer: string | null; settlement: string | null; replay: boolean;
}
export interface ReceiptKey { kid: string; kty: "OKP"; crv: "Ed25519"; alg: "EdDSA"; x: string; status?: string; validFrom: string | null; validUntil: string | null }
export const RECEIPT_HEADER: "Agent402-Receipt";
export const RECEIPT_KEYS_PATH: string;
export function receiptRequestDigest(method: string, pathWithQuery: string, body?: unknown): string;
/** Check an Agent402-Receipt against the published keys (fetched from baseUrl when `keys` is absent). */
export function verifyReceipt(receipt: string, opts?: { keys?: ReceiptKey[]; baseUrl?: string; fetchImpl?: FetchLike; body?: string | Uint8Array; request?: { method: string; path: string; body?: unknown } }): Promise<{ valid: boolean; reason: string | null; kid?: string; record?: ReceiptRecord }>;
/** The tag of the server-sent comment line (`: agent402-receipt <receipt>`) that ends a settled streamed answer with its receipt. */
export const RECEIPT_SSE_COMMENT: "agent402-receipt";
/** Split a streamed answer into the bytes its receipt covers and the receipt (null when it ends with none). */
export function splitStreamedReceipt(streamed: string | Uint8Array): { body: Uint8Array; receipt: string | null };
/** Check the receipt line that ends a streamed answer against the bytes streamed before it (reason "no_stream_receipt" when it carries none). */
export function verifyStreamedReceipt(streamed: string | Uint8Array, opts?: { keys?: ReceiptKey[]; baseUrl?: string; fetchImpl?: FetchLike; request?: { method: string; path: string; body?: unknown } }): Promise<{ valid: boolean; reason: string | null; kid?: string; record?: ReceiptRecord }>;
