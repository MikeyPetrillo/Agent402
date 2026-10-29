// Known payment assets, and the USD value of an x402 accept priced from them.
//
// An x402 "exact" signer signs the accept's raw base-unit `amount` for the
// accept's `asset`. A spending cap therefore has to price that amount with the
// asset's real decimals, and a decimals hint the seller sends beside it (for
// example `extra.decimals`) is not evidence of anything. So the price of an
// accept comes from this table alone: the stablecoins each network settles on
// the Agent402 rails, with their on-chain decimals. An accept whose
// (network, asset) pair is not in the table cannot be priced, and a buyer with
// a cap does not sign it.
//
// The same file ships in agent402-client, agent402-mcp and agent402-openclaw;
// the parent repo's scripts/test-known-assets.js keeps the copies identical and
// checks the table against the assets the server offers.

/** network (CAIP-2) -> the assets a buyer may price there. */
export const KNOWN_ASSETS = Object.freeze({
  // EVM: USDC (native Circle) unless named otherwise.
  "eip155:8453": [{ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }], // Base
  "eip155:84532": [{ asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" }], // Base Sepolia
  "eip155:137": [{ asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, symbol: "USDC" }], // Polygon
  "eip155:42161": [{ asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, symbol: "USDC" }], // Arbitrum
  "eip155:143": [{ asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, symbol: "USDC" }], // Monad
  "eip155:42220": [{ asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, symbol: "USDC" }], // Celo
  "eip155:43114": [{ asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC" }], // Avalanche
  "eip155:1329": [{ asset: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", decimals: 6, symbol: "USDC" }], // Sei
  "eip155:10": [{ asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, symbol: "USDC" }], // Optimism
  "eip155:5042": [{ asset: "0x3600000000000000000000000000000000000000", decimals: 6, symbol: "USDC" }], // Arc
  "eip155:4663": [{ asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, symbol: "USDG" }], // Robinhood Chain
  // Solana: the USDC mint.
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": [{ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC" }],
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": [{ asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, symbol: "USDC" }], // devnet
  // Stellar: the USDC Stellar Asset Contract (7 decimals on Stellar).
  "stellar:pubnet": [{ asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7, symbol: "USDC" }],
  // Algorand: USDC is ASA 31566704. Mainnet is named by its CAIP-2 id (the
  // first 32 characters of the base64 genesis hash) and, by sellers that
  // predate it, by the full hash.
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k": [{ asset: "31566704", decimals: 6, symbol: "USDC" }],
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": [{ asset: "31566704", decimals: 6, symbol: "USDC" }],
});

/** Chain name -> every network id in the table that names that chain. A
 *  chain spelled two ways on the wire lists both, so a buyer's preference by
 *  name, or by either spelling, matches a seller's accept in the other. */
export const NETWORK_NAMES = Object.freeze({
  base: ["eip155:8453"],
  "base-sepolia": ["eip155:84532"],
  polygon: ["eip155:137"],
  arbitrum: ["eip155:42161"],
  monad: ["eip155:143"],
  celo: ["eip155:42220"],
  avalanche: ["eip155:43114"],
  sei: ["eip155:1329"],
  optimism: ["eip155:10"],
  arc: ["eip155:5042"],
  robinhood: ["eip155:4663"],
  solana: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  "solana-devnet": ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
  stellar: ["stellar:pubnet"],
  algorand: ["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
});

/** The network ids a preference names: a chain name's ids; for an id, every
 *  id of the chain it belongs to (so either spelling matches the other); an
 *  id the table does not know passes through as itself. */
export function networkIdsOf(pref) {
  const p = String(pref || "").trim();
  if (!p) return [];
  const byName = NETWORK_NAMES[p.toLowerCase()];
  if (byName) return [...byName];
  for (const ids of Object.values(NETWORK_NAMES)) if (ids.some((id) => id.toLowerCase() === p.toLowerCase())) return [...ids];
  return [p];
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// EVM addresses compare without case (checksum casing is presentation);
// base58, Stellar and Algorand identifiers compare exactly.
const sameAsset = (a, b) => (EVM_ADDRESS.test(a) && EVM_ADDRESS.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The table entry for (network, asset), or null when it is not a known asset. */
export function knownAsset(network, asset) {
  if (typeof network !== "string" || typeof asset !== "string" || !asset) return null;
  const list = KNOWN_ASSETS[network];
  if (!list) return null;
  return list.find((e) => sameAsset(e.asset, asset)) || null;
}

/** The USD value of one accept: its base-unit amount (`amount` in x402 v2,
 *  `maxAmountRequired` in v1) over the KNOWN decimals of its asset. null when
 *  the asset is not known or the amount is not a whole number of base units. */
export function acceptUsd(accept) {
  if (!accept || typeof accept !== "object") return null;
  const raw = accept.amount ?? accept.maxAmountRequired;
  if (raw == null || !/^\d+$/.test(String(raw))) return null;
  const entry = knownAsset(accept.network, accept.asset);
  if (!entry) return null;
  return Number(raw) / 10 ** entry.decimals;
}

/** The USD values of a 402's accepts: `max` and `min` over the accepts that can
 *  be priced, and `unknown`, the count that cannot. null when there are none. */
export function quoteOf(accepts) {
  if (!Array.isArray(accepts) || !accepts.length) return null;
  let max = null, min = null, unknown = 0;
  for (const a of accepts) {
    const usd = acceptUsd(a);
    if (usd == null) { unknown++; continue; }
    if (max == null || usd > max) max = usd;
    if (min == null || usd < min) min = usd;
  }
  return { max, min, unknown, total: accepts.length };
}

/** Enforce a USD allowance at signing on an @x402/core x402Client.
 *
 *  `allowance()` is the most this buyer may sign for the payment being built
 *  (a per-call cap, a remaining budget, or the smaller of the two; Infinity
 *  for none). A registered policy drops every accept that cannot be priced or
 *  is over the allowance, so the client selects among the ones that fit, and a
 *  hook before payload creation checks the selected accept again and passes
 *  its USD value to `onSign`. A refusal throws (from the policy) or aborts
 *  (from the hook) before any signature exists; `onRefuse` hears why first. */
export function guardSigning(client, { allowance, onSign = null, onRefuse = null }) {
  if (!client || typeof client.registerPolicy !== "function" || typeof client.onBeforePaymentCreation !== "function") {
    throw new TypeError("guardSigning needs an @x402/core x402Client (registerPolicy and onBeforePaymentCreation)");
  }
  if (typeof allowance !== "function") throw new TypeError("guardSigning needs an allowance() function");
  const refuse = (detail) => { try { onRefuse?.(detail); } catch { /* the refusal stands */ } return detail; };
  client.registerPolicy((version, accepts) => {
    const cap = allowance();
    const kept = accepts.filter((a) => { const usd = acceptUsd(a); return usd != null && usd <= cap; });
    if (!kept.length) {
      const q = quoteOf(accepts);
      const d = refuse({ reason: q && q.min != null ? "over-allowance" : "unknown-asset", priceUsd: q ? q.min : null, allowanceUsd: cap });
      throw new Error(d.reason === "unknown-asset"
        ? "spending guard: no payment option is in a known asset, so none can be priced; nothing was signed"
        : `spending guard: the cheapest payment option asks $${d.priceUsd}, above the $${cap} this buyer may sign; nothing was signed`);
    }
    return kept;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const usd = acceptUsd(r);
    const cap = allowance();
    if (usd == null) {
      refuse({ reason: "unknown-asset", priceUsd: null, allowanceUsd: cap });
      return { abort: true, reason: "spending guard: the selected payment option is not in a known asset; nothing was signed" };
    }
    if (usd > cap) {
      refuse({ reason: "over-allowance", priceUsd: usd, allowanceUsd: cap });
      return { abort: true, reason: `spending guard: the selected payment option asks $${usd}, above the $${cap} this buyer may sign; nothing was signed` };
    }
    onSign?.(usd, r);
    return undefined;
  });
  return client;
}
