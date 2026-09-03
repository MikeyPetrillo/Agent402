// MPP (Machine Payments Protocol) for the EDGE gate - Web Crypto HMAC, no
// node:* imports, so it runs where edge.js runs (Cloudflare Workers, Next.js
// edge middleware, Deno, Bun, Node 20+).
//
// Same design as the Node build's mpp.js: settlement authority stays with the
// operator's x402 verifier, and MPP is pure header translation around it.
//
//   OUTBOUND  the gate's USDC quote (price / network / asset / payTo) becomes
//             ONE HMAC-bound `WWW-Authenticate: Payment` evm/charge challenge
//             on the 402, next to the JSON `accepts` block the x402 path reads.
//             The x402-v2-shaped accept it stands for, plus the resource it
//             was minted for, ride in the challenge's opaque slot so inbound
//             is stateless and byte-exact.
//   INBOUND   an `Authorization: Payment` credential whose challenge id
//             HMAC-verifies, is unexpired and was minted for THIS resource is
//             re-encoded as an x402 v2 PAYMENT-SIGNATURE and handed to the
//             SAME verifyX402 callback the x402 path uses - so an operator who
//             already settles x402 on the edge takes MPP with no new code.
//
// Receipts: the edge gate answers null (allow) and never sees the operator's
// response, so it cannot mirror a Payment-Receipt; `receiptFor(tx)` is
// exported for an operator whose verifier learns the settlement hash.
import {
  META_ACCEPTS_KEY, STABLECOIN_DECIMALS, encodeRequest, challengeIdInput, serializeChallenge, bytesToB64url,
  decodeCredentialHeader, challengeShapeOk, metaFromChallenge, authorizationFromPayload, paymentSignatureFor, receiptFor,
} from "./mpp-codec.js";
export { receiptFor, isMppCredential } from "./mpp-codec.js";

const META_RESOURCE_KEY = "resource";
const te = new TextEncoder();

/** USDC on the chains the CLI names (same table as CLI_NETWORKS, plus the
 *  token address and its EIP-712 domain name, which a facilitator needs to
 *  verify the EIP-3009 signature). Robinhood Chain (USDG) and non-EVM rails
 *  are not MPP evm/charge targets here. */
export const EDGE_USDC = {
  8453: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" },
  42220: { asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", name: "USDC" },
  137: { asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "USD Coin" },
  42161: { asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", name: "USD Coin" },
  10: { asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", name: "USD Coin" },
  43114: { asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", name: "USD Coin" },
  1329: { asset: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", name: "USDC" },
};
const CHAIN_BY_NAME = { base: 8453, celo: 42220, polygon: 137, arbitrum: 42161, optimism: 10, avalanche: 43114, sei: 1329 };

/** "base" | "eip155:8453" -> chain id, or null. */
export function edgeChainId(network) {
  const n = String(network || "").trim().toLowerCase();
  if (CHAIN_BY_NAME[n]) return CHAIN_BY_NAME[n];
  const m = n.match(/^eip155:(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** "$0.001" | "0.001" | 0.001 -> base units at 6 decimals ("1000"), or null. */
export function toBaseUnits(price, decimals = STABLECOIN_DECIMALS) {
  const s = String(price ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null; // sub-unit prices cannot be settled
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
  return units > 0n ? units.toString() : null;
}

async function hmacId(secret, c) {
  const key = await crypto.subtle.importKey("raw", te.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToB64url(await crypto.subtle.sign("HMAC", key, te.encode(challengeIdInput(c))));
}
function constEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Mint the gate's one MPP challenge. Returns { header, accepted } or null when
 * the quote cannot be expressed as evm/charge (unknown chain, non-USDC asset
 * with no `assetAddress`, unparseable price, no secret).
 */
export async function mintEdgeChallenge({ secret, realm, price, network, asset = "USDC", assetAddress, assetName, payTo, resource, ttlSeconds = 300 } = {}) {
  if (!secret || !realm || !payTo || !resource) return null;
  const chainId = edgeChainId(network);
  if (!chainId) return null;
  const known = EDGE_USDC[chainId];
  const token = assetAddress || (String(asset).toUpperCase() === "USDC" && known ? known.asset : null);
  if (!token) return null;
  const amount = toBaseUnits(price);
  if (!amount) return null;
  // Any finite non-zero ttl is honoured (a negative one mints an already-expired
  // challenge - the refusal path tests use it); 0/unset = 300 s.
  const ttl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) !== 0 ? Number(ttlSeconds) : 300;
  const accepted = {
    scheme: "exact",
    network: `eip155:${chainId}`,
    amount,
    asset: token,
    payTo,
    maxTimeoutSeconds: ttl,
    extra: { name: assetName || (assetAddress ? String(asset) : known.name), version: "2" },
  };
  const c = {
    realm,
    method: "evm",
    intent: "charge",
    request: encodeRequest({
      amount,
      currency: token,
      recipient: payTo,
      methodDetails: { chainId, credentialTypes: ["authorization"], decimals: STABLECOIN_DECIMALS },
    }),
    expires: new Date(Date.now() + ttl * 1000).toISOString(),
    opaque: encodeRequest({ [META_ACCEPTS_KEY]: JSON.stringify(accepted), [META_RESOURCE_KEY]: resource }),
  };
  c.id = await hmacId(secret, c);
  return { header: serializeChallenge(c), accepted };
}

/**
 * Validate an MPP credential against our HMAC binding and re-encode it as an
 * x402 v2 PAYMENT-SIGNATURE value. Returns { paymentSignature, accepted,
 * authorization, signature, resource } or null for anything that is not a
 * valid, unexpired, HMAC-bound evm/charge credential of ours.
 */
export async function translateEdgeCredential(authorizationHeader, { secret } = {}) {
  if (!secret) return null;
  const wire = decodeCredentialHeader(authorizationHeader);
  const ch = wire?.challenge;
  if (!challengeShapeOk(ch)) return null;
  if (!constEq(String(ch.id), await hmacId(secret, ch))) return null;
  if (ch.expires && !(Date.parse(ch.expires) > Date.now())) return null;
  const meta = metaFromChallenge(ch);
  let accepted;
  try { accepted = JSON.parse(meta[META_ACCEPTS_KEY]); } catch { return null; }
  if (!accepted || typeof accepted !== "object") return null;
  const auth = authorizationFromPayload(wire.payload);
  if (!auth) return null;
  return { paymentSignature: paymentSignatureFor(accepted, auth), accepted, ...auth, resource: typeof meta[META_RESOURCE_KEY] === "string" ? meta[META_RESOURCE_KEY] : null };
}
