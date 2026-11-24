// Type declarations for agent402-model-provider, the OpenClaw model provider
// plugin. The runtime is index.js (plain ES modules); these declarations
// describe its public API. The x402 packages it can pay with are optional
// peers and are typed loosely here.
import type { ProxyOptions, RunningProxy } from "./proxy.js";
import type { OpenClawModel } from "./models.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The plugin's config block in OpenClaw. */
export interface Agent402PluginConfig {
  walletKey?: string;
  creditsKey?: string;
  /** Ceiling on one paid call in USD (default 5); 0 or "off" turns it off. */
  maxPerCallUsd?: number | string;
  allowUncappedPayments?: boolean | string;
  baseRpc?: string;
  port?: number;
  upstream?: string;
  pricing?: "metered" | "flat";
}

/** One accept of an x402 402 answer. */
export interface PaymentAccept {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  [key: string]: unknown;
}

export interface KnownAsset { asset: string; decimals: number; symbol: string; name?: string; version?: string }
export const KNOWN_ASSETS: Readonly<Record<string, KnownAsset[]>>;
export const MAX_VALIDITY_SECONDS: number;
/** The base-unit amount the signer of `x402Version` signs for one accept, or null. */
export function acceptAmount(accept: PaymentAccept, x402Version?: number): string | null;
/** The USD value of one accept over the known decimals of its asset, or null. */
export function acceptUsd(accept: PaymentAccept, x402Version?: number): number | null;
/** Why a created payment payload stays redeemable too long, or null. */
export function signedValidityProblem(paymentPayload: unknown, opts?: { maxSeconds?: number; nowMs?: number }): string | null;
/** Why a signed payment does not match the priced option or the cap, or null. */
export function signedPaymentProblem(paymentPayload: unknown, requirements: PaymentAccept, x402Version: number, cap?: number): Promise<string | null>;

export const STATE_DIR: () => string;
export const CREDITS_KEY_FILE: () => string;
export const WALLET_KEY_FILE: () => string;
export function resolveWalletKey(pluginConfig?: Agent402PluginConfig): string | null;
export function resolveCreditsKey(pluginConfig?: Agent402PluginConfig): string | null;

export const USDC_BASE: string;
export const BASE_CAIP2: string;
export const DEFAULT_BASE_RPC: string;
export const PERMIT2_READY_MIN: bigint;
/** The default per-call ceiling in USD. */
export const DEFAULT_MAX_PER_CALL_USD: number;
export function uncappedAcknowledged(pluginConfig?: Agent402PluginConfig): boolean;
/** Kept for callers of earlier releases; always false. */
export const uncappedRefused: () => false;
/** The per-call ceiling in USD; Infinity when turned off. */
export function maxPerCallUsd(pluginConfig?: Agent402PluginConfig): number;
/** A one-line warning when the configured ceiling does not parse, else null. */
export function maxPerCallProblem(pluginConfig?: Agent402PluginConfig): string | null;
/** Which accept to pay; throws (nothing signed) when it is over the ceiling or cannot be priced. */
export function selectAccept(accepts: PaymentAccept[], opts?: { preferUpto?: boolean; maxUsd?: number; x402Version?: number }): PaymentAccept | undefined;
export function uptoReady(allowance: unknown): boolean;
/** An x402-paying fetch for the configured wallet key, or null (no key, or the optional x402 packages are missing). */
export function resolvePayFetch(pluginConfig?: Agent402PluginConfig, log?: (message: string) => void): Promise<FetchLike | null>;

/** The OpenClaw provider registration. */
export interface Agent402Provider {
  id: string;
  label: string;
  docsPath: string;
  aliases: string[];
  envVars: string[];
  readonly models: { baseUrl: string; api: "openai-completions"; models: OpenClawModel[] };
  auth: unknown[];
}
export function buildProvider(opts?: { port?: number }): Agent402Provider;
export function startProxy(opts?: ProxyOptions): Promise<RunningProxy>;

/** The OpenClaw plugin object (its loader calls register). */
export interface Agent402Plugin {
  id: string;
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any): void;
}
export const plugin: Agent402Plugin;
export default plugin;
