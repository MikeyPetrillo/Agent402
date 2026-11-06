// Shared guards for the scripts that sign payments with a key of ours.
//
// Two rules:
//
// 1. A buyer script built to buy from OUR service pays only our service.
//    `assertOwnPaidTarget` refuses any target whose host is not ours (or a
//    loopback address, for local and offline runs) unless the caller sets
//    ALLOW_EXTERNAL_PAID_TARGET=1, so a mistyped or pasted TARGET_URL never
//    points an uncapped buyer at an outside seller.
//
// 2. A buyer that MAY pay an outside seller prices what it signs from facts of
//    its own, never from the seller's hints. `guardCappedSigning` keeps only
//    accepts on the networks the script registered, in an asset our table
//    knows (client/known-assets.js, so the decimals are the asset's real ones,
//    never `extra.decimals`), paid by an EIP-3009 transfer, whose amount is read
//    from the one field the signer signs for that payload version (`amount` in
//    v2, `maxAmountRequired` in v1); an accept carrying both fields with
//    different values is refused. The selected accept is checked again before
//    signing, and the signed authorization's value is checked against the cap
//    after signing and before anything is sent.
//
//    The same guard caps a buyer that only pays our own service, so a script
//    that turns the library's own spend control off still signs nothing above
//    its stated ceiling. Options beyond the defaults:
//      schemes      the schemes allowed (default ["exact"]); "upto" signs a
//                   Permit2 authorization for at most the accept's amount.
//      extraAssets  { network: [{ asset, decimals }] } for an asset the script
//                   itself names in code (a gated rail not in the shared
//                   table); never read from a challenge.
//    The post-signing value check reads the signed EVM authorization (the
//    EIP-3009 value, or the Permit2 permitted amount). A Solana, Stellar or
//    Algorand payload is a signed transaction with no plaintext amount field;
//    there the selected accept and the payload version are checked again after
//    signing, and the accept was priced from the table before the signer ran.
import { KNOWN_ASSETS, knownAsset } from "../../client/known-assets.js";

/** Every EVM network the shared known-assets table prices. */
export const KNOWN_EVM_NETWORKS = Object.freeze(Object.keys(KNOWN_ASSETS).filter((n) => n.startsWith("eip155:")));

const isEvm = (network) => typeof network === "string" && network.startsWith("eip155:");
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function extraAsset(extraAssets, network, asset) {
  const list = extraAssets?.[network];
  if (!Array.isArray(list) || typeof asset !== "string") return null;
  return list.find((e) => e && typeof e.asset === "string" && Number.isInteger(e.decimals)
    && (EVM_ADDRESS.test(e.asset) && EVM_ADDRESS.test(asset) ? e.asset.toLowerCase() === asset.toLowerCase() : e.asset === asset)) || null;
}

const OWN_HOSTS = new Set(["agent402.tools", "www.agent402.tools"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when `url` names our own service or a loopback address. */
export function isOwnPaidTarget(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return true;
  return u.protocol === "https:" && OWN_HOSTS.has(host);
}

/** Exit (or throw, with `throwOnRefuse`) unless `url` is ours or the explicit
 *  override is set. Returns the url. */
export function assertOwnPaidTarget(url, script, { env = process.env, throwOnRefuse = false } = {}) {
  if (isOwnPaidTarget(url)) return url;
  if (String(env.ALLOW_EXTERNAL_PAID_TARGET || "").trim() === "1") {
    console.warn(`${script}: paying ${url}, which is not our service (ALLOW_EXTERNAL_PAID_TARGET=1)`);
    return url;
  }
  const msg = `${script}: refusing to pay ${JSON.stringify(String(url))}: not our service. Set ALLOW_EXTERNAL_PAID_TARGET=1 to pay another origin.`;
  if (throwOnRefuse) throw new Error(msg);
  console.error(msg);
  process.exit(2);
}

/** The base-unit amount the exact signer signs for `accept` under payload
 *  version `version`, as a BigInt, or a refusal reason string. */
export function signedAtomicOf(version, accept) {
  if (!accept || typeof accept !== "object") return "no accept";
  const has = (k) => accept[k] !== undefined && accept[k] !== null;
  if (has("amount") && has("maxAmountRequired") && String(accept.amount) !== String(accept.maxAmountRequired)) {
    return "amount and maxAmountRequired differ";
  }
  const raw = Number(version) === 1 ? accept.maxAmountRequired : Number(version) === 2 ? accept.amount : undefined;
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return "unreadable amount";
  return BigInt(String(raw));
}

/** The cap in the asset's base units (floor), from the asset's real decimals. */
function capAtomic(maxUsd, decimals) {
  const [whole, frac = ""] = maxUsd.toFixed(decimals).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

/** Check one accept: { ok: true, atomic, entry, cap } or { ok: false, reason }. */
export function checkAccept(version, accept, { maxUsd, networks, schemes = ["exact"], extraAssets = null }) {
  const capUsd = typeof maxUsd === "function" ? maxUsd() : maxUsd;
  if (!(Number.isFinite(capUsd) && capUsd > 0)) return { ok: false, reason: `no positive cap (${capUsd})` };
  if (!accept || !schemes.includes(accept.scheme)) return { ok: false, reason: `scheme ${accept?.scheme} not allowed` };
  if (!networks.includes(accept.network)) return { ok: false, reason: `network ${accept.network} not registered` };
  const method = accept.extra?.assetTransferMethod;
  const allowedMethod = !isEvm(accept.network) ? undefined : accept.scheme === "upto" ? "permit2" : "eip3009";
  if (method !== undefined && method !== allowedMethod) return { ok: false, reason: `transfer method ${method} not allowed` };
  const entry = knownAsset(accept.network, accept.asset) || extraAsset(extraAssets, accept.network, accept.asset);
  if (!entry) return { ok: false, reason: "asset not in the known-assets table" };
  const atomic = signedAtomicOf(version, accept);
  if (typeof atomic === "string") return { ok: false, reason: atomic };
  const cap = capAtomic(capUsd, entry.decimals);
  if (atomic > cap) return { ok: false, reason: `${atomic} base units over the cap (${cap} at ${entry.decimals} decimals)` };
  return { ok: true, atomic, entry, cap };
}

/** The amount a signed EVM payload authorizes, as a digit string, or null. */
export function signedEvmValueOf(paymentPayload) {
  const p = paymentPayload?.payload;
  const v = p?.authorization?.value ?? p?.permit2Authorization?.permitted?.amount;
  return v !== undefined && v !== null && /^\d+$/.test(String(v)) ? String(v) : null;
}

/** Install the capped-signing guard on an @x402/core x402Client. `maxUsd` is
 *  a number, or a function read at every check (a per-purchase cap). */
export function guardCappedSigning(client, { maxUsd, networks, schemes = ["exact"], extraAssets = null, log = console.error }) {
  if (typeof maxUsd !== "function" && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error(`cap must be a positive number, got ${maxUsd}`);
  if (!Array.isArray(networks) || !networks.length) throw new Error("guardCappedSigning needs the registered networks");
  const opts = { maxUsd, networks, schemes, extraAssets };
  client.registerPolicy((version, reqs) => reqs.filter((r) => {
    const c = checkAccept(version, r, opts);
    if (!c.ok) log(`refusing accept ${r?.scheme}/${r?.network}: ${c.reason}`);
    return c.ok;
  }));
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    const c = checkAccept(paymentRequired?.x402Version, selectedRequirements, opts);
    if (!c.ok) return { abort: true, reason: `selected accept refused: ${c.reason}` };
    return undefined;
  });
  client.onAfterPaymentCreation(async ({ paymentRequired, selectedRequirements, paymentPayload }) => {
    const c = checkAccept(paymentRequired?.x402Version, selectedRequirements, opts);
    if (!c.ok) throw new Error(`signed payment refused before sending: ${c.reason}`);
    if (Number(paymentPayload?.x402Version) !== Number(paymentRequired?.x402Version)) throw new Error("signed payment refused before sending: payload version differs from the challenge");
    if (!isEvm(selectedRequirements?.network)) return;
    const value = signedEvmValueOf(paymentPayload);
    if (value === null) throw new Error("signed payment refused before sending: no readable authorization value");
    if (BigInt(value) !== c.atomic || BigInt(value) > c.cap) {
      throw new Error(`signed payment refused before sending: authorization value ${value} is not the checked ${c.atomic} under the cap ${c.cap}`);
    }
  });
  return client;
}

/** A per-accept cap in USD from an env variable, or the default. Exits (or
 *  throws, with `throwOnRefuse`) on a value that is not a positive number, so
 *  a typo never pays uncapped. */
export function capFromEnv(name, fallback, { env = process.env, script = name, throwOnRefuse = false } = {}) {
  const raw = env[name];
  const v = raw === undefined || String(raw).trim() === "" ? fallback : Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  const msg = `${script}: ${name} must be a positive number, got ${JSON.stringify(raw)}; not paying`;
  if (throwOnRefuse) throw new Error(msg);
  console.error(msg);
  process.exit(2);
}
