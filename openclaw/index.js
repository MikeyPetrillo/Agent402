// OpenClaw plugin entry (listed in package.json "openclaw.extensions").
// register() is what OpenClaw's loader calls - several times per gateway start
// (discovery, activation, per session), so registration is idempotent and the
// proxy is started once as a plugin service.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildProvider, setActiveProxy, setCachedRoutes, DEFAULT_PORT, PLUGIN_ID } from "./provider.js";
import { startProxy, loadRoutes, DEFAULT_UPSTREAM } from "./proxy.js";
import { stripTrailingSlashes } from "./models.js";

export const STATE_DIR = () => join(process.env.AGENT402_OPENCLAW_HOME || join(homedir(), ".openclaw"), "agent402");
export const CREDITS_KEY_FILE = () => join(STATE_DIR(), "credits.key");
export const WALLET_KEY_FILE = () => join(STATE_DIR(), "wallet.key");

/** Wallet key precedence: plugin config > env > ~/.openclaw/agent402/wallet.key
 *  (the wallet `setup` generates when no payment method exists yet). Only a
 *  well-formed 0x + 64 hex key counts; anything else is "no wallet". */
export function resolveWalletKey(pluginConfig = {}) {
  const cands = [
    typeof pluginConfig.walletKey === "string" ? pluginConfig.walletKey.trim() : "",
    (process.env.AGENT402_WALLET_KEY || "").trim(),
  ];
  try { if (existsSync(WALLET_KEY_FILE())) cands.push(readFileSync(WALLET_KEY_FILE(), "utf8").trim()); } catch { /* unreadable */ }
  return cands.find((k) => /^0x[0-9a-fA-F]{64}$/.test(k)) || null;
}

/** Credits key precedence: plugin config > env > ~/.openclaw/agent402/credits.key. */
export function resolveCreditsKey(pluginConfig = {}) {
  const fromCfg = typeof pluginConfig.creditsKey === "string" ? pluginConfig.creditsKey.trim() : "";
  if (fromCfg) return fromCfg;
  const fromEnv = (process.env.AGENT402_CREDITS_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try { if (existsSync(CREDITS_KEY_FILE())) return readFileSync(CREDITS_KEY_FILE(), "utf8").trim(); } catch { /* unreadable */ }
  return null;
}

// x402 wallet payment - optional (peer deps) and, when the wallet has a
// Permit2 allowance, METERED: the `upto` scheme authorizes a CEILING (the
// per-request quote) and the gateway settles actual usage plus a markup, the way a
// per-token router bills. Without the allowance it pays `exact` (the quote).
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CAIP2 = "eip155:8453";
export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
// Permit2 approvals are max-uint by convention; anything this large is "approved".
export const PERMIT2_READY_MIN = 10n ** 12n; // 1,000,000 USDC (6 decimals): a real approval, not dust

/** Which 402 accept to pay: upto on Base when the client can (settle-actual),
 *  else exact on Base, else the first the client supports. Pure. */
/** Per-call ceiling in USD, enforced in the accept selector so an over-cap quote
 *  is refused BEFORE anything is signed. @x402/core 2.23+ ships a $1
 *  pegged-assets default on every client; this package turns that off (it would
 *  refuse USDG and gave an opaque vendor error on any metered turn over $1) and
 *  carries its own ceiling under its own name. The default is $2, the gateway's
 *  own metered quote cap (GATEWAY_METERED_MAX_QUOTE_USD), so no call the gateway
 *  would serve is refused here while a runaway quote still stops at the wallet.
 *  `maxPerCallUsd` in the plugin config or AGENT402_MAX_PER_CALL_USD; `0`/`off`
 *  disables; a malformed value reads as the default, never as off. */
export const DEFAULT_MAX_PER_CALL_USD = 2;
export function maxPerCallUsd(pluginConfig = {}) {
  const raw = String(pluginConfig.maxPerCallUsd ?? process.env.AGENT402_MAX_PER_CALL_USD ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PER_CALL_USD;
}
/** Dollar value of an accept's quote: `amount` (v2) or `maxAmountRequired` (v1)
 *  in base units over the asset's `extra.decimals` (USDC on Base: 6). Unknown
 *  shape reads as null, and null is REFUSED under a finite ceiling: a quote we
 *  cannot read is not one we sign. */
export function acceptUsd(accept) {
  const raw = accept?.amount ?? accept?.maxAmountRequired;
  if (raw == null || !/^\d+$/.test(String(raw))) return null;
  const dec = Number(accept?.extra?.decimals ?? 6);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return null;
  return Number(raw) / 10 ** dec;
}
export function selectAccept(accepts, { preferUpto = true, maxUsd = Infinity } = {}) {
  const list = Array.isArray(accepts) ? accepts : [];
  const pick = (preferUpto && list.find((a) => a?.scheme === "upto" && a?.network === BASE_CAIP2))
    || list.find((a) => a?.scheme === "exact" && a?.network === BASE_CAIP2) || list[0];
  if (pick && Number.isFinite(maxUsd)) {
    const usd = acceptUsd(pick);
    if (usd == null || usd > maxUsd) {
      throw new Error(`agent402-openclaw: quote ${usd == null ? "unreadable" : `$${usd}`} exceeds the per-call ceiling $${maxUsd} (maxPerCallUsd / AGENT402_MAX_PER_CALL_USD; 0 disables)`);
    }
  }
  return pick;
}
export const uptoReady = (allowance) => { try { return BigInt(allowance ?? 0) >= PERMIT2_READY_MIN; } catch { return false; } };

export async function resolvePayFetch(pluginConfig = {}, log = () => {}) {
  const pk = resolveWalletKey(pluginConfig);
  if (!pk) return null;
  try {
    const [{ wrapFetchWithPayment, x402Client }, { privateKeyToAccount }, { toClientEvmSigner }, { registerExactEvmScheme }] = await Promise.all([
      import("@x402/fetch"), import("viem/accounts"), import("@x402/evm"), import("@x402/evm/exact/client"),
    ]);
    const account = privateKeyToAccount(pk);
    const signer = toClientEvmSigner(account);
    // Upto needs a Permit2 allowance on USDC (one approval transaction, ever).
    let upto = false;
    try {
      const [{ UptoEvmScheme, getPermit2AllowanceReadParams }, { createPublicClient, http }, { base }] = await Promise.all([import("@x402/evm/upto/client"), import("viem"), import("viem/chains")]);
      const pub = createPublicClient({ chain: base, transport: http((pluginConfig.baseRpc || process.env.AGENT402_BASE_RPC || DEFAULT_BASE_RPC).trim()) });
      const allowance = await pub.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDC_BASE, ownerAddress: account.address }));
      upto = uptoReady(allowance);
      const maxUsd = maxPerCallUsd(pluginConfig);
      const client = new x402Client((v, accepts) => selectAccept(accepts, { preferUpto: upto, maxUsd }));
      client.setSpendControls?.(false); // the vendor default ($1, pegged assets only) would refuse USDG and any quote over $1; selectAccept enforces our own maxPerCallUsd (same $1 default) instead
      registerExactEvmScheme(client, { signer });
      if (upto) client.register(BASE_CAIP2, new UptoEvmScheme(signer));
      log(upto
        ? `[agent402-openclaw] x402 wallet ${account.address}: paying actual usage (upto, Permit2 allowance present) on Base; exact elsewhere`
        : `[agent402-openclaw] x402 wallet ${account.address}: paying the per-request quote (exact). To pay actual usage instead, run \`agent402-openclaw permit2-approve\` once (one USDC approval transaction on Base; needs a little ETH for gas)`);
      return wrapFetchWithPayment(fetch, client);
    } catch (e) {
      // The allowance read or the upto scheme failed: exact still works.
      log(`[agent402-openclaw] upto unavailable (${String(e?.message || e).slice(0, 120)}) - paying exact`);
      const client = new x402Client((v, accepts) => selectAccept(accepts, { preferUpto: false, maxUsd: maxPerCallUsd(pluginConfig) }));
      client.setSpendControls?.(false); // the vendor default ($1, pegged assets only) would refuse USDG and any quote over $1; selectAccept enforces our own maxPerCallUsd (same $1 default) instead
      registerExactEvmScheme(client, { signer });
      return wrapFetchWithPayment(fetch, client);
    }
  } catch (e) {
    log(`[agent402-openclaw] x402 wallet payment unavailable (${e?.message || e}); install @x402/fetch @x402/evm viem, or use a credits key`);
    return null;
  }
}

let started = null;
let registeredOnce = false;

const plugin = {
  id: PLUGIN_ID,
  name: "Agent402",
  description: "Agent402 model provider: routed + explicit models at a flat per-call price, paid by card or USDC.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const port = Number(cfg.port) || DEFAULT_PORT;
    const upstream = stripTrailingSlashes(cfg.upstream || process.env.AGENT402_UPSTREAM || DEFAULT_UPSTREAM);
    const pricing = String(cfg.pricing || process.env.AGENT402_PRICING || "metered").toLowerCase() === "flat" ? "flat" : "metered";
    const log = (m) => api.logger?.info?.(m);
    api.registerProvider(buildProvider({ port }));
    if (!registeredOnce) {
      registeredOnce = true;
      api.registerService({
        id: "agent402-proxy",
        start: async () => {
          if (started) return;
          const creditsKey = resolveCreditsKey(cfg);
          const payFetch = creditsKey ? null : await resolvePayFetch(cfg, log);
          try { setCachedRoutes(await loadRoutes(upstream, fetch, { pricing })); } catch (e) { log(`[agent402-openclaw] could not read ${upstream}/v1/models yet: ${e?.message || e}`); }
          started = await startProxy({ upstream, creditsKey, payFetch, port, pricing, log });
          setActiveProxy(started);
          if (started.mode === "unpaid") log("[agent402-openclaw] no payment configured: run `agent402-openclaw setup` (card credits key) - paid calls will answer 402 until then");
        },
        stop: async () => { if (started) { await started.close(); started = null; setActiveProxy(null); } },
      });
    }
  },
};

export default plugin;
export { plugin, buildProvider, startProxy };
