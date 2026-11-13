// Arc constants and the Circle /supported parser, dependency-free.
//
// Shared by the payment client (src/circle-facilitator.js) and the rail
// self-heal (scripts/lib/rail-recovered.js, which runs without the package
// install), so "Circle lists Arc" means the same thing to the boot check and
// to the healer that restarts production on it.
import { ADDR, REASON, isObj, lc } from "./circle-shapes.js";

export const ARC_CAIP2 = "eip155:5042";
export const ARC_CHAIN_ID = 5042;
/** Arc native USDC, verified on chain 2026-10-20: decimals() 6,
 *  DOMAIN_SEPARATOR() rebuilds from ("USDC", "2", 5042, asset). */
export const ARC_USDC = Object.freeze({
  asset: "0x3600000000000000000000000000000000000000",
  decimals: 6,
  name: "USDC",
  version: "2",
});
export const CIRCLE_FACILITATOR_BASE = "https://api.circle.com/v1/facilitator/x402";
export const CIRCLE_LABEL = "Circle (Arc)";

/** A reason code we are willing to repeat: lower snake case, bounded. Anything
 *  else (prose, markup, an echoed header) becomes a fixed placeholder. */
export function safeReason(value, fallback = "circle_unrecognized_reason") {
  const s = typeof value === "string" ? value.trim() : "";
  return REASON.test(s) ? s : fallback;
}

/** Every Circle failure: an HTTP status and a reason code, never a body. */
export class CircleResponseError extends Error {
  constructor(op, status, reason) {
    super(`Circle facilitator ${op} failed (${Number(status) || 0}): ${reason}`);
    this.name = "CircleResponseError";
    this.status = Number(status) || 0;
    this.reason = reason;
  }
}

/** The Arc USDC profile: the one network and token the Arc client settles. */
export const ARC_PROFILE = Object.freeze({ caip2: ARC_CAIP2, chainId: ARC_CHAIN_ID, ...ARC_USDC });

/** Extension keys Circle may advertise that are not lower snake case: the
 *  x402 Permit2 gas sponsoring declarations (src/upto-gas-sponsoring.js),
 *  kept only when the answer is read for upto. */
const CAMEL_EXTENSIONS = new Set(["eip2612GasSponsoring", "erc20ApprovalGasSponsoring"]);

/** Reduce a /supported answer to the `exact` kinds of the given USDC profiles
 *  ({ caip2, asset, name, version }), one kind per profile, in profile order.
 *  With `uptoNetworks`, each of those profiles' `upto` kind follows, when
 *  Circle lists it with a facilitator address (the address an upto buyer
 *  signs into its Permit2 witness). Malformed input throws (the boot check
 *  then drops what it guards). */
export function usdcKindsFromSupported(data, profiles, { uptoNetworks = [] } = {}) {
  if (!isObj(data) || !Array.isArray(data.kinds) || data.kinds.length > 500) {
    throw new CircleResponseError("supported", 200, "invalid_supported_shape");
  }
  const found = new Map();
  for (const k of data.kinds) {
    if (!isObj(k) || typeof k.scheme !== "string" || typeof k.network !== "string") {
      throw new CircleResponseError("supported", 200, "invalid_supported_kind");
    }
    if (k.scheme !== "exact") continue;
    const p = profiles.find((x) => x.caip2 === k.network);
    if (!p || found.has(p.caip2)) continue;
    if (k.x402Version !== undefined && k.x402Version !== 2) continue;
    // A listed asset must be the USDC we price in; a kind for any other
    // token on that chain is not one we can settle.
    if (k.asset !== undefined && lc(k.asset) !== lc(p.asset)) continue;
    const extra = isObj(k.extra) ? k.extra : {};
    if (extra.name !== undefined && extra.name !== p.name) continue;
    if (extra.version !== undefined && extra.version !== p.version) continue;
    found.set(p.caip2, { x402Version: 2, scheme: "exact", network: p.caip2, extra: { name: p.name, version: p.version } });
    if (found.size === profiles.length) break;
  }
  const kinds = profiles.map((p) => found.get(p.caip2)).filter(Boolean);
  const upto = new Map();
  for (const k of data.kinds) {
    if (k.scheme !== "upto") continue;
    const p = profiles.find((x) => x.caip2 === k.network);
    if (!p || !uptoNetworks.includes(p.caip2) || upto.has(p.caip2) || !found.has(p.caip2)) continue;
    if (k.x402Version !== undefined && k.x402Version !== 2) continue;
    if (k.asset !== undefined && lc(k.asset) !== lc(p.asset)) continue;
    const extra = isObj(k.extra) ? k.extra : {};
    if (!ADDR.test(String(extra.facilitatorAddress || ""))) continue;
    upto.set(p.caip2, { x402Version: 2, scheme: "upto", network: p.caip2, extra: { name: p.name, version: p.version, facilitatorAddress: extra.facilitatorAddress } });
  }
  for (const p of profiles) if (upto.has(p.caip2)) kinds.push(upto.get(p.caip2));
  const extensions = Array.isArray(data.extensions)
    ? data.extensions.filter((e) => typeof e === "string" && ((uptoNetworks.length && CAMEL_EXTENSIONS.has(e)) || REASON.test(e.replace(/-/g, "_"))) && e.length <= 64)
    : [];
  const signers = {};
  for (const p of profiles) {
    const list = isObj(data.signers) ? data.signers[p.caip2] : null;
    if (Array.isArray(list)) signers[p.caip2] = list.filter((a) => typeof a === "string" && ADDR.test(a)).slice(0, 32);
  }
  return { kinds, extensions, signers };
}

/** Reduce Circle's /supported to the one kind we route here: Arc `exact` on the
 *  Arc USDC asset. Malformed input throws (the boot check then drops Arc). */
export function arcKindsFromSupported(data) {
  return usdcKindsFromSupported(data, [ARC_PROFILE]);
}

/** Arc mainnet and testnet: networks no client but Circle's may claim. */
const ARC_NETWORKS = new Set([ARC_CAIP2, "eip155:5042002"]);
export const isArcNetwork = (n) => ARC_NETWORKS.has(String(n || ""));

/** Strip the Arc networks from a /supported answer (kinds and signers). */
export function stripArcFromSupported(s) {
  if (!isObj(s)) return s;
  const out = { ...s };
  if (Array.isArray(s.kinds)) out.kinds = s.kinds.filter((k) => !isArcNetwork(k?.network));
  if (isObj(s.signers)) out.signers = Object.fromEntries(Object.entries(s.signers).filter(([n]) => !isArcNetwork(n)));
  return out;
}

/** Patch a non-Circle facilitator client so its /supported never lists Arc. */
export function withoutArcKinds(client) {
  if (!client || typeof client.getSupported !== "function" || client.__a402NoArc) return client;
  const orig = client.getSupported.bind(client);
  client.getSupported = async (...args) => stripArcFromSupported(await orig(...args));
  client.__a402NoArc = true;
  return client;
}
