// Type declarations for agent402-tollbooth (the Node/Express entry). The
// runtime is index.js (plain ES modules, no dependencies); edge.d.ts types
// the Fetch-API gate at "agent402-tollbooth/edge".

/** The request shape the gate reads (an Express or node:http request). */
export interface TollboothRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  get?(name: string): string | undefined;
  [key: string]: any;
}
/** The response shape the gate writes (an Express response). */
export interface TollboothResponse {
  status(code: number): TollboothResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  [key: string]: any;
}
export type NextFunction = (err?: unknown) => void;
export type Middleware = (req: TollboothRequest, res: TollboothResponse, next: NextFunction) => unknown;

/** Shared single-use record for solved proof-of-work tokens. */
export interface ReplayStore {
  claim(token: string, expiresAtMs: number): boolean | Promise<boolean>;
}

/** Durable counters (sinks.js). */
export interface StatsSink {
  incr(field: string, n?: number): void;
  snapshot(): Record<string, unknown> | Promise<Record<string, unknown>>;
  flush?(): void | Promise<void>;
}

export interface TempoSplit { recipient: string; amount: string }
export interface TempoOptions {
  apiKey: string;
  recipient: string;
  currency?: string;
  currencies?: string[];
  splits?: TempoSplit[];
  decimals?: number;
  chainId?: number;
  apiBaseUrl?: string;
  rpcUrl?: string;
}

export interface TollboothConfig {
  /** Advertised price per request (default "$0.001", or TOLLBOOTH_PRICE). */
  price?: string;
  /** Wallet for the x402 quote (enables the USDC rail). */
  payTo?: string | null;
  /** x402 network (default "base"). */
  network?: string;
  /** Stablecoin symbol in the quote (default "USDC"). */
  asset?: string;
  /** The free proof-of-work rail (default true). */
  pow?: boolean;
  powDifficulty?: number;
  powSecret?: string;
  replayStore?: ReplayStore;
  /** User-agent substrings to charge (default AI_BOTS). */
  botUserAgents?: string[];
  /** Who pays: "bots" (default), "all", or "strict" (listed bots and anything that is not a browser page load). */
  mode?: "bots" | "all" | "strict";
  /** Paths an empty-User-Agent GET or HEAD reads free in "bots" and "strict" modes (a health check). Default ["/healthz", "/health"]; [] for none. */
  healthPaths?: string[];
  charge?: (req: TollboothRequest) => boolean;
  free?: (req: TollboothRequest) => boolean;
  /** Legacy verify-only USDC check. */
  verifyX402?: (req: TollboothRequest, requirements: unknown) => boolean | Promise<boolean>;
  /** An @x402/express paymentMiddleware(...) that owns verify and settle. */
  x402?: Middleware | null;
  /** Accept MPP clients too (default true when x402 is set). */
  mpp?: boolean;
  mppSecret?: string;
  mppNetworks?: number[] | "all";
  /** Native MPP on Tempo, or null to turn it off. */
  tempo?: TempoOptions | null;
  resourceBaseUrl?: string;
  adaptive?: boolean;
  adaptivePerBit?: number;
  maxDifficulty?: number;
  /** Classify and count, never 402. */
  observe?: boolean;
  statsSink?: StatsSink;
  message?: string;
}

export interface ProofOfWork {
  difficulty: number;
  challenge(resource: string, difficulty?: number): Record<string, unknown>;
  verify(solution: string, resource: string): unknown;
  [key: string]: unknown;
}

export interface Tollbooth extends Middleware {
  shouldCharge(req: TollboothRequest): boolean;
  pow: ProofOfWork | null;
  observe: boolean;
  /** In-process counters (sync). */
  stats(): Record<string, unknown>;
  /** Counters from the durable sink. */
  snapshot(): Promise<Record<string, unknown>>;
  flush(): Promise<void>;
}

export function createTollbooth(config?: TollboothConfig): Tollbooth;
export function createProxy(upstream: string, opts?: { maxBody?: number }): (req: TollboothRequest, res: TollboothResponse) => Promise<void>;
export function x402VerifierFromExpress(paymentMiddleware: Middleware, opts?: { timeoutMs?: number }): (req: TollboothRequest, opts?: Record<string, unknown>) => Promise<unknown>;
export function tempoFromEnv(env?: Record<string, string | undefined>): TempoOptions | null;
export function buildCliX402Middleware(env?: Record<string, string | undefined>): Promise<Middleware | null>;
export const CLI_NETWORKS: Readonly<Record<string, string>>;

export const AI_BOTS: string[];
/** The default health paths an empty-User-Agent check reads free. */
export const DEFAULT_HEALTH_PATHS: readonly string[];
export function makeBotMatcher(list?: string[]): (userAgent?: string) => boolean;
export function createPow(opts?: { difficulty?: number; secret?: string; ttlMs?: number; replayStore?: ReplayStore; store?: ReplayStore }): ProofOfWork;
export function leadingZeroBits(buf: Uint8Array): number;

export function memorySink(): StatsSink;
export function kvStatsSink(kv: unknown, opts?: { bucket?: string; ttlSeconds?: number }): StatsSink;
export function httpStatsSink(url: string, opts?: { token?: string; batchMs?: number; fetchImpl?: typeof fetch; allowInsecure?: boolean }): StatsSink;
export function sqliteReplayStore(db: unknown, opts?: { table?: string; pruneEveryMs?: number }): ReplayStore;
export function redisReplayStore(client: unknown, opts?: { prefix?: string }): ReplayStore;

export const DEFAULT_MPP_CHAIN_IDS: number[];
export function challengesFromPaymentRequired(paymentRequiredHeader: string, opts?: { secretKey?: string; realm?: string; chainIds?: number[] | "all" }): string[] | null;
export function translateCredential(authorizationHeader: string, opts?: { secretKey?: string }): unknown;
export function receiptFromPaymentResponse(paymentResponseHeader: string): string | null;

export const TEMPO_MAINNET_CHAIN_ID: number;
export const TEMPO_USDC_E: string;
export const TEMPO_PATHUSD: string;
export function toBaseUnits(price: string | number, decimals?: number): bigint;
export function tempoConfig(cfg?: Partial<TempoOptions>): unknown;
export function mintTempoChallenges(args: { price: string; realm: string; secretKey: string; tempo: unknown }): unknown;
export function parseTempoCredential(authorizationHeader: string): unknown;
export function checkTempoBinding(credential: unknown, args: { secretKey: string; realm: string; price: string; tempo: unknown; now?: number }): unknown;
export function tempoRelay(tempo: unknown): unknown;
