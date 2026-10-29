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

/** Reduce Circle's /supported to the one kind we route here: Arc `exact` on the
 *  Arc USDC asset. Malformed input throws (the boot check then drops Arc). */
export function arcKindsFromSupported(data) {
  if (!isObj(data) || !Array.isArray(data.kinds) || data.kinds.length > 500) {
    throw new CircleResponseError("supported", 200, "invalid_supported_shape");
  }
  const kinds = [];
  for (const k of data.kinds) {
    if (!isObj(k) || typeof k.scheme !== "string" || typeof k.network !== "string") {
      throw new CircleResponseError("supported", 200, "invalid_supported_kind");
    }
    if (k.scheme !== "exact" || k.network !== ARC_CAIP2) continue;
    if (k.x402Version !== undefined && k.x402Version !== 2) continue;
    // A listed asset must be the Arc USDC we price in; a kind for any other
    // token on Arc is not one we can settle.
    if (k.asset !== undefined && lc(k.asset) !== lc(ARC_USDC.asset)) continue;
    const extra = isObj(k.extra) ? k.extra : {};
    if (extra.name !== undefined && extra.name !== ARC_USDC.name) continue;
    if (extra.version !== undefined && extra.version !== ARC_USDC.version) continue;
    kinds.push({ x402Version: 2, scheme: "exact", network: ARC_CAIP2, extra: { name: ARC_USDC.name, version: ARC_USDC.version } });
    break;
  }
  const extensions = Array.isArray(data.extensions)
    ? data.extensions.filter((e) => typeof e === "string" && REASON.test(e.replace(/-/g, "_")) && e.length <= 64)
    : [];
  const signers = {};
  const arcSigners = isObj(data.signers) ? data.signers[ARC_CAIP2] : null;
  if (Array.isArray(arcSigners)) signers[ARC_CAIP2] = arcSigners.filter((a) => typeof a === "string" && ADDR.test(a)).slice(0, 32);
  return { kinds, extensions, signers };
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
