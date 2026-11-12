// Permit2 gas sponsorship on the `upto` accepts, and which networks may
// offer `upto` at all. Both are default-off operator switches.
//
// An upto payment moves the buyer's tokens through the canonical Permit2
// contract, so the buyer's wallet must first approve Permit2 once, an
// on-chain transaction that needs the chain's gas token. The x402 gas
// sponsoring extensions let a facilitator submit that approval for the buyer:
//   eip2612GasSponsoring        the buyer signs an EIP-2612 permit (off chain)
//                               and the facilitator submits it with the settle.
//   erc20ApprovalGasSponsoring  the buyer signs a raw approve() transaction and
//                               the facilitator broadcasts it before the settle.
// The server declares a key in PaymentRequired.extensions (top level, a
// sibling of `accepts`): @x402/evm's upto client signs the permit only when
// `context.extensions[key]` is present and its Permit2 allowance is short
// (@x402/evm dist/esm/chunk-DIAR36YQ.mjs trySignEip2612PermitExtension;
// spec: x402-foundation/x402 specs/extensions/eip2612_gas_sponsoring.md).
// A facilitator advertises the keys it honors in its /supported answer's
// top-level `extensions` list.
//
// Money: sponsorship moves who pays the approval's gas (the facilitator), not
// what the buyer pays. The settled amount is still the metered override,
// capped at the signed Permit2 ceiling (the quote); the permit approves
// Permit2, never us.
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
  EIP2612_GAS_SPONSORING,
  ERC20_APPROVAL_GAS_SPONSORING,
} from "@x402/extensions";

export const GAS_SPONSORING_KEYS = Object.freeze([EIP2612_GAS_SPONSORING.key, ERC20_APPROVAL_GAS_SPONSORING.key]);

const DECLARE = {
  [EIP2612_GAS_SPONSORING.key]: declareEip2612GasSponsoringExtension,
  [ERC20_APPROVAL_GAS_SPONSORING.key]: declareErc20ApprovalGasSponsoringExtension,
};

/** Networks that may offer upto only when listed by name: "all" never adds
 *  them. Arc settles through its own facilitator (Circle), which reads the
 *  same switch to decide whether it lists upto at all. */
export const UPTO_EXPLICIT_ONLY = Object.freeze(["eip155:5042"]);

/** The upto networks the operator asked for (X402_UPTO_NETWORKS: a CSV of
 *  CAIP-2 ids, or "all"), restricted to `evmCaip2`. Unset is []. A list keeps
 *  its own order (the order the 402 offers upto in); "all" keeps evmCaip2's. */
export function uptoNetworksWanted(env = process.env, evmCaip2 = []) {
  const raw = String(env.X402_UPTO_NETWORKS || "").trim();
  if (!raw) return [];
  if (raw.toLowerCase() === "all") return evmCaip2.filter((c) => !UPTO_EXPLICIT_ONLY.includes(c));
  const listed = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return listed.filter((c, i) => evmCaip2.includes(c) && listed.indexOf(c) === i);
}

/** True when X402_UPTO_NETWORKS names `caip2` itself. */
export function uptoListedByName(caip2, env = process.env) {
  return String(env.X402_UPTO_NETWORKS || "").split(",").map((x) => x.trim()).includes(caip2);
}

/** The sponsoring keys the operator asked for (X402_UPTO_GAS_SPONSORING):
 *  unset or "off" is none; "on" is eip2612GasSponsoring (USDC implements
 *  EIP-2612, so a USDC buyer needs nothing else); otherwise a CSV of key
 *  names, which is how erc20ApprovalGasSponsoring is added. */
export function gasSponsoringWanted(env = process.env) {
  const raw = String(env.X402_UPTO_GAS_SPONSORING || "").trim();
  if (!raw || raw.toLowerCase() === "off") return [];
  if (raw.toLowerCase() === "on") return [EIP2612_GAS_SPONSORING.key];
  const listed = raw.split(",").map((x) => x.trim());
  return GAS_SPONSORING_KEYS.filter((k) => listed.includes(k));
}

/**
 * Which keys to declare. The declaration is one per 402 (not per accept), so
 * a key is declared only when the facilitator that settles EVERY upto network
 * advertises it: a buyer that signs a permit for a facilitator that does not
 * honor it would be served and then refused at settle.
 *
 * @param wanted      keys the operator asked for
 * @param uptoCaip2   the networks upto is offered on
 * @param extensionsByNetwork  Map caip2 -> the /supported `extensions` list of
 *                    the first routing client that advertises upto there
 * @returns {{ keys: string[], refused: Array<{ key: string, networks: string[] }> }}
 */
export function gasSponsoringKeys(wanted, uptoCaip2, extensionsByNetwork) {
  const keys = [], refused = [];
  if (!wanted.length || !uptoCaip2.length) return { keys, refused };
  for (const key of wanted) {
    const missing = uptoCaip2.filter((c) => {
      const list = extensionsByNetwork.get(c);
      return !Array.isArray(list) || !list.includes(key);
    });
    if (missing.length) refused.push({ key, networks: missing });
    else keys.push(key);
  }
  return { keys, refused };
}

/** The PaymentRequired.extensions entries for `keys`: the SDK helper's
 *  `info` (description and version), without its JSON `schema`. The client
 *  reads only the key's presence, a facilitator validates the client's info
 *  against its own copy of the schema, and the core's echo check compares
 *  `info` only, while the schema would add about a kilobyte per key to a
 *  challenge header that a buyer echoes back and that already sits near the
 *  16 KB response-header budget on the /v1 routes
 *  (scripts/test-challenge-size.js). */
export function gasSponsoringDeclarations(keys) {
  const out = {};
  for (const k of keys) {
    if (!DECLARE[k]) continue;
    const { info } = DECLARE[k]()[k];
    out[k] = { info: { ...info } };
  }
  return out;
}

/** A /v1 gateway route priced per request (a metered or model-priced tier):
 *  the routes whose upto settle meters usage under the quote, and so the
 *  only routes where upto buys a buyer anything over exact. */
export function isMeteredGatewayRoute(item) {
  return /^v1-/.test(String(item?.slug || "")) && (typeof item?.quote === "function" || typeof item?.tierQuote === "function");
}
