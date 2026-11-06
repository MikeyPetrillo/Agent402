// Known payment assets, and the USD value of an x402 accept priced from them.
//
// An x402 "exact" signer signs the accept's raw base-unit amount for the
// accept's `asset`: `amount` under x402 v2, `maxAmountRequired` under v1. A
// spending cap therefore has to price the field the signer of that version
// reads, with the asset's real decimals, and a decimals hint the seller sends
// beside it (for example `extra.decimals`) is not evidence of anything. So the
// price of an accept comes from its challenge's version and this table alone:
// the stablecoins each network settles on the Agent402 rails, with their
// on-chain decimals. An accept whose (network, asset) pair is not in the table,
// or that carries both amount fields with different values, cannot be priced,
// and a buyer with a cap does not sign it. The table is keyed by CAIP-2 ids
// only: a bare v1 network name (for example "base") is not priced.
//
// An entry may also name its token's EIP-712 domain (`name` and `version`,
// read from the token's own name() and version()). An EVM "exact" signer
// signs under the domain the accept's `extra` carries, so for such an entry
// an accept whose `extra.name` or `extra.version` is not exactly the token's
// cannot be priced either, and a buyer with a cap does not sign it.
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
  "eip155:57073": [{ asset: "0x2D270e6886d130D724215A266106e6832161EAEd", decimals: 6, symbol: "USDC", name: "USDC", version: "2" }], // Ink
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
  ink: ["eip155:57073"],
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

/** True when the accept carries the EIP-712 domain the table names for its
 *  asset (`extra.name` and `extra.version`, exactly), or when the entry names
 *  none. */
export function acceptDomainMatches(entry, accept) {
  if (!entry || (entry.name == null && entry.version == null)) return true;
  const extra = accept && typeof accept.extra === "object" && accept.extra ? accept.extra : {};
  return extra.name === entry.name && extra.version === entry.version;
}

/** The base-unit amount the signer of `x402Version` signs for one accept, as
 *  a string of digits: `maxAmountRequired` under v1, `amount` under v2. With
 *  no version, the one field present (or both, when they agree). null when
 *  the field that version signs is missing or not a whole number, when the
 *  version is neither 1 nor 2, and whenever the accept carries both fields
 *  with different values: such an accept means one price to one reader and
 *  another to the next, so it is not priced at all. */
export function acceptAmount(accept, x402Version = undefined) {
  if (!accept || typeof accept !== "object") return null;
  const has = (x) => x != null && x !== "";
  const v2 = accept.amount, v1 = accept.maxAmountRequired;
  if (has(v2) && has(v1) && String(v2) !== String(v1)) return null;
  let raw;
  if (x402Version === 1) raw = v1;
  else if (x402Version === 2) raw = v2;
  else if (x402Version == null) raw = has(v2) ? v2 : v1;
  else return null;
  if (!has(raw) || !/^\d+$/.test(String(raw))) return null;
  return String(raw);
}

/** The USD value of one accept: the base-unit amount its version's signer
 *  signs (acceptAmount) over the KNOWN decimals of its asset. null when the
 *  asset is not known, when the accept names a different EIP-712 domain than
 *  the table's for that asset, or when the amount cannot be read. */
export function acceptUsd(accept, x402Version = undefined) {
  const raw = acceptAmount(accept, x402Version);
  if (raw == null) return null;
  const entry = knownAsset(accept.network, accept.asset);
  if (!entry || !acceptDomainMatches(entry, accept)) return null;
  return Number(raw) / 10 ** entry.decimals;
}

/** The USD values of a 402's accepts: `max` and `min` over the accepts that can
 *  be priced, and `unknown`, the count that cannot. null when there are none. */
export function quoteOf(accepts, x402Version = undefined) {
  if (!Array.isArray(accepts) || !accepts.length) return null;
  let max = null, min = null, unknown = 0;
  for (const a of accepts) {
    const usd = acceptUsd(a, x402Version);
    if (usd == null) { unknown++; continue; }
    if (max == null || usd > max) max = usd;
    if (min == null || usd < min) min = usd;
  }
  return { max, min, unknown, total: accepts.length };
}

// The longest a signed payment may stay redeemable. An EVM "exact" signer
// sets validBefore (EIP-3009) or deadline (Permit2) to the moment of signing
// plus the accept's maxTimeoutSeconds, and the signed payload is a bearer
// claim until then, so a seller that quotes years gets an authorization it
// could redeem for years and a held amount that never stops counting. Honest
// accepts ask for minutes (Agent402's own ask 300 s); a day admits every
// one of them. An accept that asks for longer is dropped before selection,
// and a payload signed past it is refused before it is sent.
export const MAX_VALIDITY_SECONDS = 24 * 3600;
// Signing reads the clock a moment before the check after it does.
const VALIDITY_CLOCK_SLACK_SECONDS = 60;

/** True when an accept asks for a validity window past MAX_VALIDITY_SECONDS.
 *  An accept with no readable maxTimeoutSeconds is left to the check of what
 *  was signed (signedValidityProblem). */
export function acceptValidityTooLong(accept, maxSeconds = MAX_VALIDITY_SECONDS) {
  const raw = accept?.maxTimeoutSeconds;
  if (raw == null || raw === "") return false;
  const n = Number(raw);
  return !Number.isFinite(n) || n > maxSeconds;
}

/** The expiry a signed payload carries, in unix seconds: an EIP-3009
 *  `authorization.validBefore` or a Permit2 `deadline`. null when the payload
 *  names none (a Solana transaction, an unknown scheme). NaN when it names
 *  one that is not a whole number of seconds. */
export function signedExpirySeconds(paymentPayload) {
  const p = paymentPayload?.payload;
  const v = p?.authorization?.validBefore ?? p?.permit2Authorization?.deadline;
  if (v == null) return null;
  return /^\d{1,15}$/.test(String(v)) ? Number(v) : NaN;
}

/** Why a created payment payload stays redeemable for too long, or null: its
 *  expiry is past `nowMs` plus `maxSeconds` (and a minute of clock slack), or
 *  it names an expiry that cannot be read. */
export function signedValidityProblem(paymentPayload, { maxSeconds = MAX_VALIDITY_SECONDS, nowMs = Date.now() } = {}) {
  const exp = signedExpirySeconds(paymentPayload);
  if (exp == null) return null;
  if (!Number.isFinite(exp)) return "the signed authorization's expiry cannot be read";
  const left = exp - Math.floor(nowMs / 1000);
  if (left > maxSeconds + VALIDITY_CLOCK_SLACK_SECONDS) return `the signed authorization stays valid for ${left} seconds, past the ${maxSeconds}-second ceiling`;
  return null;
}

/** Enforce a USD allowance at signing on an @x402/core x402Client.
 *
 *  `allowance()` is the most this buyer may sign for the payment being built
 *  (a per-call cap, a remaining budget, or the smaller of the two; Infinity
 *  for none). A registered policy drops every accept that cannot be priced or
 *  is over the allowance, so the client selects among the ones that fit, and a
 *  hook before payload creation checks the selected accept again and passes
 *  its USD value to `onSign`. An accept asking for a validity window past
 *  MAX_VALIDITY_SECONDS is dropped and refused the same way. A refusal throws
 *  (from the policy) or aborts (from the hook) before any signature exists;
 *  `onRefuse` hears why first. */
export function guardSigning(client, { allowance, onSign = null, onRefuse = null }) {
  if (!client || typeof client.registerPolicy !== "function" || typeof client.onBeforePaymentCreation !== "function") {
    throw new TypeError("guardSigning needs an @x402/core x402Client (registerPolicy and onBeforePaymentCreation)");
  }
  if (typeof allowance !== "function") throw new TypeError("guardSigning needs an allowance() function");
  const refuse = (detail) => { try { onRefuse?.(detail); } catch { /* the refusal stands */ } return detail; };
  client.registerPolicy((version, accepts) => {
    const cap = allowance();
    const priced = accepts.filter((a) => { const usd = acceptUsd(a, version); return usd != null && usd <= cap; });
    const kept = priced.filter((a) => !acceptValidityTooLong(a));
    if (!kept.length && priced.length) {
      const d = refuse({ reason: "validity", priceUsd: null, allowanceUsd: cap, detail: `every payment option it may sign asks to stay valid for more than ${MAX_VALIDITY_SECONDS} seconds` });
      throw new Error(`spending guard: ${d.detail}; nothing was signed`);
    }
    if (!kept.length) {
      const q = quoteOf(accepts, version);
      const d = refuse({ reason: q && q.min != null ? "over-allowance" : "unknown-asset", priceUsd: q ? q.min : null, allowanceUsd: cap });
      throw new Error(d.reason === "unknown-asset"
        ? "spending guard: no payment option is in a known asset, so none can be priced; nothing was signed"
        : `spending guard: the cheapest payment option asks $${d.priceUsd}, above the $${cap} this buyer may sign; nothing was signed`);
    }
    return kept;
  });
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
    const usd = acceptUsd(r, paymentRequired?.x402Version);
    const cap = allowance();
    if (usd == null) {
      refuse({ reason: "unknown-asset", priceUsd: null, allowanceUsd: cap });
      return { abort: true, reason: "spending guard: the selected payment option is not in a known asset; nothing was signed" };
    }
    if (usd > cap) {
      refuse({ reason: "over-allowance", priceUsd: usd, allowanceUsd: cap });
      return { abort: true, reason: `spending guard: the selected payment option asks $${usd}, above the $${cap} this buyer may sign; nothing was signed` };
    }
    if (acceptValidityTooLong(r)) {
      const d = refuse({ reason: "validity", priceUsd: usd, allowanceUsd: cap, detail: `the selected payment option asks to stay valid for ${r.maxTimeoutSeconds} seconds, past the ${MAX_VALIDITY_SECONDS}-second ceiling` });
      return { abort: true, reason: `spending guard: ${d.detail}; nothing was signed` };
    }
    onSign?.(usd, r);
    return undefined;
  });
  guardSignedAmount(client, { allowance, onRefuse: refuse });
  return client;
}

// The token programs a Solana "exact" payment moves its asset through, and
// the TransferChecked instruction's tag.
const SOLANA_TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const TRANSFER_CHECKED = 12;

/** The amount a Solana payment transaction moves: its one token-program
 *  instruction, which must be a TransferChecked, read as base units and
 *  decimals. Decoded with @solana/kit, the peer every Solana x402 signer
 *  already loads. null when the transaction cannot be read or does not hold
 *  exactly that one transfer. */
async function solanaTransferOf(transaction) {
  if (typeof transaction !== "string" || !transaction) return null;
  try {
    const kit = await import("@solana/kit");
    const tx = kit.getTransactionDecoder().decode(kit.getBase64Encoder().encode(transaction));
    const msg = kit.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = msg.staticAccounts || [];
    const ixs = msg.version === 1
      ? (msg.instructionHeaders || []).map((h, i) => ({ program: keys[h.programAccountIndex], data: msg.instructionPayloads?.[i]?.instructionData }))
      : (msg.instructions || []).map((ix) => ({ program: keys[ix.programAddressIndex], data: ix.data }));
    const token = ixs.filter((ix) => SOLANA_TOKEN_PROGRAMS.has(String(ix.program)));
    if (token.length !== 1) return null;
    const d = token[0].data;
    if (!d || d.length !== 10 || d[0] !== TRANSFER_CHECKED) return null;
    let amount = 0n;
    for (let i = 8; i >= 1; i--) amount = (amount << 8n) | BigInt(d[i]);
    return { amount: amount.toString(), decimals: d[9] };
  } catch {
    return null;
  }
}

/** The base-unit amount a created x402 payment payload commits the buyer to,
 *  read from what was signed: an EVM EIP-3009 `authorization.value`, an EVM
 *  Permit2 `permitted.amount`, or a Solana transaction's transfer. Returns
 *  `{ amount, decimals? }`, `{ unchecked: true }` for a network whose payload
 *  this reader does not decode (neither EVM nor Solana), or null when an EVM or
 *  Solana payload holds no amount it can read. */
export async function signedAmountOf(paymentPayload, network) {
  const p = paymentPayload?.payload;
  const net = String(network || "");
  if (net.startsWith("eip155:")) {
    const vals = [p?.authorization?.value, p?.permit2Authorization?.permitted?.amount].filter((x) => x != null);
    if (vals.length !== 1 || !/^\d+$/.test(String(vals[0]))) return null;
    return { amount: BigInt(String(vals[0])).toString() };
  }
  if (net.startsWith("solana:")) return solanaTransferOf(p?.transaction);
  return { unchecked: true };
}

/** Check a created payment payload against the accept it was built for,
 *  before it is sent: the amount that was signed must be the amount the
 *  allowance was checked against (acceptAmount under the challenge's
 *  version), in the known asset's decimals, and within `cap`. Returns null
 *  when it holds, else why not. */
export async function signedPaymentProblem(paymentPayload, requirements, x402Version, cap = Infinity) {
  const expected = acceptAmount(requirements, x402Version);
  const entry = knownAsset(requirements?.network, requirements?.asset);
  if (expected == null) return "the selected payment option's amount cannot be read";
  const signed = await signedAmountOf(paymentPayload, requirements?.network);
  if (signed == null) return "the signed payment's amount cannot be read";
  if (signed.unchecked) return null;
  if (signed.amount !== BigInt(expected).toString()) return `the signed amount (${signed.amount}) differs from the priced amount (${expected})`;
  if (signed.decimals != null && entry && signed.decimals !== entry.decimals) return "the signed transfer's decimals differ from the known asset's";
  if (Number.isFinite(cap)) {
    if (!entry) return "the selected payment option is not in a known asset";
    const usd = Number(signed.amount) / 10 ** entry.decimals;
    if (usd > cap) return `the signed amount asks ${usd}, above the ${cap} this buyer may sign`;
  }
  return null;
}

/** Refuse to send a payment payload whose signed amount is not the one the
 *  allowance passed, or whose expiry is past MAX_VALIDITY_SECONDS from now
 *  (signedValidityProblem): registered after payload creation, so the check
 *  reads what was actually signed, and a throw here stops the payment-aware
 *  fetch before the payload leaves the process. guardSigning registers it; a
 *  client with its own selector (and no guardSigning) can register it alone. */
export function guardSignedAmount(client, { allowance = () => Infinity, onRefuse = null } = {}) {
  if (!client || typeof client.onAfterPaymentCreation !== "function") {
    throw new TypeError("guardSignedAmount needs an @x402/core x402Client (onAfterPaymentCreation)");
  }
  client.onAfterPaymentCreation(async ({ paymentRequired, selectedRequirements: r, paymentPayload }) => {
    const cap = allowance();
    const amountProblem = await signedPaymentProblem(paymentPayload, r, paymentRequired?.x402Version, cap);
    const problem = amountProblem || signedValidityProblem(paymentPayload);
    if (!problem) return;
    try { onRefuse?.({ reason: amountProblem ? "signed-amount" : "signed-validity", priceUsd: null, allowanceUsd: cap, detail: problem }); } catch { /* the refusal stands */ }
    throw new Error(`spending guard: ${problem}; the payment was not sent`);
  });
  return client;
}
