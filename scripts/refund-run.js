#!/usr/bin/env node
// Repay the refund ledger - every buyer who was charged and got nothing.
//
//   DRY RUN (default):  AGENT402_OPERATOR_TOKEN=… node scripts/refund-run.js
//   LIVE:               REFUND_LIVE=true … node scripts/refund-run.js
//
// Reads owed rows from /__operator/refunds.json, pays each buyer back ON THE
// CHAIN THEY PAID ON, and marks the row paid with the outbound tx. Designed to
// run from the dispatch-only refund.yml workflow, where the spending keys live
// (Actions secrets, never Railway, never local) - the production server can
// record debts but can never send money.
//
// SAFETY MODEL - money leaves a wallet here, so every rule is explicit:
//   * DRY RUN BY DEFAULT. A live run requires REFUND_LIVE=true.
//   * recipient = the ledger row's verified payer, verbatim. Addresses are
//     never case-folded (base58/base32 rails are case-sensitive) and never
//     derived from anything but the row.
//   * amount = the row's priceUsd exactly - a refund, not a gesture.
//   * the ASSET comes from our own live 402: the accepts entry for that
//     network names the exact token buyers pay with, so we refund in the same
//     token, with no hand-maintained address table to rot.
//   * caps: per-refund (REFUND_MAX_EACH_USD, default $0.25) and per-run
//     (REFUND_MAX_TOTAL_USD, default $2). Over-cap rows are HELD and listed,
//     never silently skipped.
//   * synthetic rows (canary/heartbeat self-harm) are held by default -
//     refunding our own burner is churn. REFUND_INCLUDE_SYNTHETIC=true opts in.
//   * a buyer who disconnected (http 499) on a route whose effect outlives the
//     answer (hasLastingEffect in src/hangup-forgiveness.js: the route-execute
//     tiers, memory writes, attest, feedback) is held for review by default:
//     the effect was delivered before the socket closed. A reviewer who has
//     read those rows releases them with REFUND_INCLUDE_LASTING_HANGUPS=true.
//   * a disconnect booked because the hang-up forgiveness budget was spent
//     (a repeat hang-up: payer, IP or service budget), or one recorded before
//     the reason was stored, is held the same way; REFUND_INCLUDE_REPEAT_HANGUPS
//     =true releases them.
//   * a chain without an implemented sender or a configured key HOLDS its
//     rows and says so. The debt stays on the ledger; nothing is written off.
//   * marking paid requires the outbound tx hash, enforced server-side too.
//   * a row is claimed (owed -> sending) before anything is broadcast, so a
//     crash after the send leaves it in `sending`, which no later run claims:
//     a rerun never sends it again. The server refuses the claim of a row
//     that is void, or whose evidence carries a void mark (a Tempo push
//     transfer claimed for the request it paid), so a voided debt is never sent.
//   * what a send needs is read BEFORE the claim (prepare: balances, the
//     payer's token account, and on EVM chains the gas estimate against the
//     wallet's native balance), so a wallet that cannot pay leaves the row
//     owed. A send that still fails before anything is broadcast (building,
//     signing, or a node refusing the bytes for lack of funds) releases the
//     claimed row back to owed with the reason as its note; a failure after
//     the broadcast leaves it `sending` for a human, as before.
//   * Tempo and Solana repayments are also proven OUTBOUND before the row is
//     marked paid: the same on-chain check (src/payment-verify.js) is run on
//     the refund itself, from our sending wallet to the payer, for at least
//     the amount. A send that cannot be proven yet stays `sending` for a
//     human; it is never re-sent.
//
// Chain support: EVM rails (one key, REFUND_EVM_KEY), Stellar
// (REFUND_STELLAR_SECRET, classic payment + "agent402 refund" memo), Algorand
// (REFUND_ALGORAND_MNEMONIC, ASA transfer + note), Tempo (REFUND_TEMPO_KEY, a
// TIP-20 transferWithMemo in the currency the buyer paid with, read from the
// payment itself and limited to the currencies our live challenge offers) and
// Solana (REFUND_SOLANA_KEY, an SPL USDC transfer + memo to the payer's
// existing USDC account).

import { createHash, createHmac } from "node:crypto";
import { hasLastingEffect } from "../src/hangup-forgiveness.js";
import { EVM_RPCS } from "../src/evm-rpcs.js";

// This repo is PUBLIC, so every Actions log is world-readable. The project's
// standing rule for buyer identities is "counts only, never addresses - a
// per-day roster of who pays us is a customer list", and it is enforced on
// /revenue. A refund run would otherwise print the full roster (wallet, amount,
// tool, settle evidence) on the DRY-RUN path too, since the plan is printed
// before the live check. So logs carry a stable non-reversible tag; the
// operator resolves it to the address privately via /__operator/refunds.json,
// which is already token-gated.
// KEYED, not plain sha256. Every wallet that has ever paid us is enumerable
// from the chain (~200 distinct buyers), so an unsalted digest over that set is
// trivially CONFIRMABLE: hash each candidate, match 8 hex chars, and the public
// log identifies the buyer again. Non-reversible is not the property we need -
// unconfirmable is. The operator token is already in this job's env, keeps the
// tag stable across an operator's runs, and is not something a reader has.
const TAG_KEY = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
const tag = (a) => {
  if (!a) return "?";
  const h = TAG_KEY
    ? createHmac("sha256", TAG_KEY).update(String(a)).digest("hex")
    : createHash("sha256").update(String(a)).digest("hex");
  return `payer:${h.slice(0, 8)}`;
};

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const TOKEN = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
const LIVE = /^(1|true|yes)$/i.test((process.env.REFUND_LIVE || "").trim());
// Caps come from free-text workflow_dispatch inputs, so they MUST be parsed
// rather than coerced. Number("$2") is NaN, and every `x > NaN` is false - so a
// malformed cap did not clamp, it DISAPPEARED. Measured: a "$2" run cap sent 40
// refunds totalling $10 where "2" sent 8 totalling $2. That fails OPEN, in the
// one direction this pipeline must never fail, on a single fat-fingered
// dispatch. Refuse to run instead.
function capUsd(raw, dflt, name) {
  const v = Number(String(raw ?? "").trim() || dflt);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)} - refusing to run rather than sending with no cap`);
  }
  return v;
}
const MAX_EACH = capUsd(process.env.REFUND_MAX_EACH_USD, "0.25", "REFUND_MAX_EACH_USD");
const MAX_TOTAL = capUsd(process.env.REFUND_MAX_TOTAL_USD, "2", "REFUND_MAX_TOTAL_USD");
// One wallet's share of a run. Bounds the sponsored-gas griefing loop below.
const MAX_PER_PAYER = capUsd(process.env.REFUND_MAX_PER_PAYER_USD, "0.5", "REFUND_MAX_PER_PAYER_USD");
// Optional dust floor: refunds smaller than this cost more to send than they
// repay. Default 0 (off) - a real debt is owed however small, and holding one
// silently is exactly what this pipeline exists to prevent. Set it only when
// gas genuinely outweighs the debt, and the held rows say so out loud.
const MIN_REFUND = capUsd(process.env.REFUND_MIN_USD, "0", "REFUND_MIN_USD");
const ONLY_CHAIN = (process.env.REFUND_ONLY_CHAIN || "").trim(); // optional CAIP-2 filter

// Public RPCs for the EVM rails we can refund on (src/evm-rpcs.js, shared
// with the settle path). Overridable per chain via REFUND_RPC_<id> (e.g.
// REFUND_RPC_8453). A chain with no RPC entry holds its rows - refusing loudly
// beats broadcasting through a guessed endpoint.
export { EVM_RPCS };

// The sales ledger records SHORT chain names ("base", "solana"); settle
// receipts record CAIP-2 ("eip155:8453"). Debts minted by the charged-failure
// detector carry the receipt form; debts minted by the 2026-09-01 backfill
// carried the ledger form, and familyOf + the accepts lookup both key on
// CAIP-2 - so four provably-owed Base rows were held "unsupported network
// base". Normalize the known short names at intake. Values verified against
// our own live 402 accepts, not typed from memory.
const CAIP2_BY_SHORT_NAME = {
  base: "eip155:8453", optimism: "eip155:10", polygon: "eip155:137",
  arbitrum: "eip155:42161", celo: "eip155:42220", avalanche: "eip155:43114",
  sei: "eip155:1329", monad: "eip155:143", robinhood: "eip155:4663",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  // MPP on Tempo books its debts under the short name (src/server.js,
  // src/tempo-push-debts.js).
  tempo: "eip155:4217",
  stellar: "stellar:pubnet",
  algorand: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
};
// The ledger can also carry the display label (src/stats.js CAIP2_NAMES), which
// names the token for a non-USDC rail: "robinhood (USDG)". The suffix is not
// part of the chain's name, so it is dropped before the lookup; without this
// every Robinhood debt was held "unsupported network robinhood (USDG)".
export function normalizeNetwork(network) {
  const n = String(network || "").trim();
  const short = n.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
  return CAIP2_BY_SHORT_NAME[short] || CAIP2_BY_SHORT_NAME[n.toLowerCase()] || n;
}

export const TEMPO_NETWORK = "eip155:4217";
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TEMPO_RPC = () => (process.env.REFUND_TEMPO_RPC || process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz").trim();
const SOLANA_RPC = () => (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();

export function familyOf(network) {
  const n = String(network || "");
  // Tempo is an EVM chain id, but its own family: TIP-20 tokens, fees paid in
  // a stablecoin, its own sender. Never the generic EVM sender.
  if (n === TEMPO_NETWORK) return "tempo";
  if (n.startsWith("eip155:")) return "evm";
  if (n.startsWith("solana:")) return "solana";
  if (n.startsWith("stellar:")) return "stellar";
  if (n.startsWith("algorand:")) return "algorand";
  return "unknown";
}

// The status the serving code books a disconnect under (recordHangupDebt in
// src/server.js). A debt recorded on it is a buyer who left before the first
// byte; every other status is an answer that failed.
export const HANGUP_STATUS = 499;
export const LASTING_HANGUP_HOLD =
  "disconnected after a route whose effect was already delivered - review, then set include_lasting_hangups to repay";

// A disconnect that was not forgiven because a forgiveness BUDGET was spent
// (src/hangup-forgiveness.js): this wallet, this IP, or the whole service had
// already abandoned its window's worth of runs. That is what a repeat hang-up
// looks like - leave before the answer, get charged, get refunded, repeat - so
// repaying one is a reviewer's decision, the same as a lasting-effect
// disconnect. A disconnect booked before the reason was stored (hangupReason
// NULL) cannot be told apart from one, so it is held the same way; a
// disconnect whose ticket was granted but lost the race to a settle already in
// flight, or that never had a ticket, is an ordinary debt.
export const REPEAT_HANGUP_REASONS = Object.freeze(["payer budget", "ip budget", "global budget"]);
export const REPEAT_HANGUP_HOLD =
  "disconnected past the hang-up forgiveness budget (or before the reason was recorded) - review, then set include_repeat_hangups to repay";

/** A disconnect booked because a forgiveness budget was spent, or one whose
 *  reason predates the column (see planRefunds). */
export function isRepeatHangup(row) {
  if (Number(row?.httpStatus) !== HANGUP_STATUS) return false;
  const reason = typeof row?.hangupReason === "string" ? row.hangupReason.trim() : "";
  return !reason || REPEAT_HANGUP_REASONS.includes(reason);
}

/** A disconnect on a route whose effect outlives the answer (see planRefunds). */
export function isLastingEffectHangup(row) {
  return Number(row?.httpStatus) === HANGUP_STATUS && hasLastingEffect(row?.slug);
}

/**
 * Pure planner: decide what to send and what to hold, with reasons. Exported
 * for the offline test - the dangerous mistakes (skipping caps, refunding the
 * canary, silently dropping an unsupported chain) all live here.
 */
export function planRefunds(rawRows, {
  maxEachUsd = MAX_EACH,
  maxTotalUsd = MAX_TOTAL,
  maxPerPayerUsd = MAX_PER_PAYER,
  minRefundUsd = MIN_REFUND,
  onlyChain = "",
  includeSynthetic = false,
  includeLastingHangups = false,
  includeRepeatHangups = false,
  senders = {},              // family -> truthy when a key+implementation exists
} = {}) {
  // Normalized ONCE at intake so familyOf, the accepts lookup and the row the
  // sender receives all agree on the CAIP-2 form.
  const rows = (rawRows || []).map((r) => ({ ...r, network: normalizeNetwork(r.network) }));
  // Comparisons are written `!(x <= cap)` rather than `x > cap` so that a NaN
  // cap HOLDS the row instead of waving it through - NaN makes every `>` false.
  const send = [];
  const held = {}; // reason -> rows
  const hold = (reason, row) => { (held[reason] ||= []).push(row); };
  let total = 0;
  const perPayer = new Map();   // payer -> usd already planned this run
  for (const row of rows) {
    if (row.status && row.status !== "owed") continue;
    if (onlyChain && row.network !== onlyChain) { hold("filtered by chain", row); continue; }
    if (row.synthetic && !includeSynthetic) { hold("synthetic (our own canary - opt in to refund it)", row); continue; }
    // A disconnect on a route whose effect outlives the answer: the handler
    // had already acted (a purchase from an outside seller on our wallet, a
    // memory write, an attestation, a stored verdict) when the socket closed,
    // the same reason the serving side never forgives these hang-ups. Repaying
    // one is a reviewer's decision, so these rows stay owed, are listed in
    // their own bucket, and are repaid only when the run opts in. Held before
    // the caps, so they take no share of this run's budget.
    if (!includeLastingHangups && isLastingEffectHangup(row)) { hold(LASTING_HANGUP_HOLD, row); continue; }
    // A repeat hang-up (the forgiveness budget was spent) is held the same
    // way and for the same reason: each refund would turn the next abandoned
    // run into a free one. Also before the caps.
    if (!includeRepeatHangups && !isLastingEffectHangup(row) && isRepeatHangup(row)) { hold(REPEAT_HANGUP_HOLD, row); continue; }
    if (!row.payer) { hold("no payer recorded - resolve manually (void with a note)", row); continue; }
    const usd = Number(row.priceUsd) || 0;
    if (usd <= 0) { hold("zero amount - void with a note", row); continue; }
    if (!(usd <= maxEachUsd)) { hold(`over per-refund cap $${maxEachUsd}`, row); continue; }
    const family = familyOf(row.network);
    if (family === "unknown") { hold(`unsupported network ${row.network}`, row); continue; }
    if (!senders[family]) { hold(`no sender/key for ${family} - debt stays on the ledger`, row); continue; }
    if (usd < minRefundUsd) { hold(`below the dust floor $${minRefundUsd} - costs more in gas than it repays; batch or void with a note`, row); continue; }
    // PER-PAYER BOUND. Gas is sponsored for buyers on the EVM rails, so a
    // griefer can pay $0.001, force a charged-failure, take the $0.001 back
    // and lose nothing - while WE pay gas on every refund. Each debt is real
    // and each refund is correct, so the answer is not to refuse them: it is
    // to bound how much one wallet can extract per run, making the loop
    // visible (rows pile up, held, under that payer) instead of draining a
    // burner one sponsored call at a time.
    const already = perPayer.get(row.payer) || 0;
    if (!(already + usd <= maxPerPayerUsd)) { hold(`per-payer cap $${maxPerPayerUsd} reached for this wallet - review before repaying more`, row); continue; }
    if (!(total + usd <= maxTotalUsd)) { hold(`deferred - run total would exceed $${maxTotalUsd}`, row); continue; }
    perPayer.set(row.payer, already + usd);
    total += usd;
    send.push(row);
  }
  return { send, held, totalUsd: Number(total.toFixed(6)) };
}

/**
 * Our Tempo offer, read from the tempo challenges in a live 402's
 * WWW-Authenticate header: the recipient (our Tempo payTo) and every currency
 * offered. Null unless every tempo challenge names the same recipient on
 * Tempo mainnet. The accepts-shaped entry the verifier and sender read.
 */
export async function parseTempoOffer(wwwAuthenticate) {
  const header = String(wwwAuthenticate || "");
  if (!/method="tempo"/.test(header)) return null;
  const { Challenge } = await import("mppx");
  const parts = header.split(/,\s*(?=Payment\s)/);
  const tempo = [];
  for (const part of parts) {
    try { const c = Challenge.deserialize(part.trim()); if (c?.method === "tempo") tempo.push(c.request || {}); } catch { /* another scheme */ }
  }
  if (!tempo.length) return null;
  const recipients = new Set(tempo.map((r) => String(r.recipient || "").toLowerCase()));
  if (recipients.size !== 1) return null;
  const payTo = tempo[0].recipient;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payTo))) return null;
  if (tempo.some((r) => r.methodDetails?.chainId != null && Number(r.methodDetails.chainId) !== 4217)) return null;
  const assets = [...new Set(tempo.map((r) => String(r.currency || "")).filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c)))];
  if (!assets.length) return null;
  return { network: TEMPO_NETWORK, payTo, asset: assets[0], assets };
}

/** Fetch our own live 402 and index the accepts by network - the asset source. */
async function liveAcceptsByNetwork() {
  let www = "";
  const accepts402 = async (path, body) => {
    const res = await fetch(`${TARGET}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.status !== 402) throw new Error(`expected a 402 from ${TARGET}${path}, got ${res.status}`);
    if (!www) www = res.headers.get("www-authenticate") || "";
    const hdr = res.headers.get("payment-required");
    if (!hdr) throw new Error("402 carried no payment-required header");
    return JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts || [];
  };
  const byNet = {};
  for (const a of await accepts402("/api/hash", { text: "refund-run" })) if (!byNet[a.network]) byNet[a.network] = a;
  // A rail the sub-cent route does not offer right now (Algorand, while the
  // facilitator's sponsored sub-cent allowance is spent - src/avm-sponsorship.js)
  // is still read from a one-cent route, so its debts stay payable instead of
  // holding for want of an asset id. Same treasury payTo, same asset.
  try {
    for (const a of await accepts402("/api/solidity-scan", {})) if (!byNet[a.network]) byNet[a.network] = a;
  } catch { /* the sub-cent accepts above are the floor */ }
  // Tempo is offered over MPP, not in the x402 accepts: its payTo and
  // currencies come from the same 402's tempo challenges.
  try { const t = await parseTempoOffer(www); if (t && !byNet[TEMPO_NETWORK]) byNet[TEMPO_NETWORK] = t; } catch { /* no Tempo offer: its rows hold unverified */ }
  return byNet;
}

// payTo is per-SLUG, not per-network. The self-funding routes (route-execute,
// and the explorer-data tools until their 2026-09-22 retirement) settle to the
// SPENDING wallet, not the treasury,
// so verifying every row against /api/hash's treasury payTo made those debts
// permanently unverifiable - and they are the routes most likely to
// charged-fail, since they spend upstream for the buyer's request. Probing the
// row's own route is the precise fix; accepting any wallet WE control on that
// network is the safe one, and it needs no slug->route map to drift.
export function ourPayToSet(accepts, env = process.env) {
  // CASE MATTERS ON EVERY RAIL BUT EVM. The first version lowercased every
  // address, which is correct for EVM and DESTROYS base32 (Algorand) and
  // base58 (Solana): the indexer returns
  // C7IIHG7SPLPZ...BEE2OY2XIE and a folded copy never matches it, so every
  // Algorand and Solana debt would have been held forever. Same rule the rest
  // of the codebase states repeatedly (src/payer.js, src/revenue-ledger.js):
  // lowercase EVM only, preserve everything else verbatim.
  const norm = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? String(a).toLowerCase() : String(a));
  const set = new Map();   // network -> Set(payTo, EVM-folded only)
  for (const [net, a] of Object.entries(accepts || {})) {
    if (a?.payTo) set.set(net, new Set([norm(a.payTo)]));
  }
  for (const [key, nets] of [
    ["X402_UPSTREAM_BUYER_ADDRESS", Object.keys(accepts || {}).filter((n) => n.startsWith("eip155:"))],
    ["ALGORAND_UPSTREAM_BUYER_ADDRESS", Object.keys(accepts || {}).filter((n) => n.startsWith("algorand:"))],
  ]) {
    const v = (env[key] || "").trim();
    if (!v) continue;
    for (const n of nets) {
      if (!set.has(n)) set.set(n, new Set());
      set.get(n).add(norm(v));
    }
  }
  return set;
}

// ---- chain senders (each returns the outbound tx id) ----

// The memo an EVM refund carries. ERC-20 transfer() has no memo argument, so
// the text rides as a UTF-8 suffix after the ABI-encoded arguments: the token
// ignores trailing calldata, and explorers show it under the transaction's
// input data (Basescan decodes it as UTF-8). Names the settlement it repays
// when the row holds a real transaction hash (public on chain already).
export function refundMemo(row) {
  const ev = String(row?.evidence || "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(ev) ? `agent402 refund for ${ev}` : "agent402 refund";
}
export function refundMemoHex(row) {
  return "0x" + Buffer.from(refundMemo(row), "utf8").toString("hex");
}

const decimalsCache = new Map();

/**
 * A send failure that cannot have moved money: raised while the transaction
 * was being built, estimated or signed (`preBroadcast` is set on it there), or
 * a node's refusal to accept the signed transaction for lack of funds, which
 * never reaches a mempool. Only such a failure may hand a claimed row back to
 * owed (executeRefunds); anything later, a broadcast that timed out or a
 * receipt that never came, stays `sending` for a human.
 */
export function isPreBroadcastFailure(e) {
  if (!e || typeof e !== "object") return false;
  if (e.preBroadcast === true) return true;
  const texts = [];
  for (let x = e, i = 0; x && typeof x === "object" && i < 6; x = x.cause, i++) texts.push(`${x.name || ""} ${x.shortMessage || ""} ${x.message || ""}`);
  return /InsufficientFundsError|exceeds the balance of the account|insufficient funds/i.test(texts.join(" "));
}
const markPreBroadcast = (e) => { if (e && typeof e === "object") { try { e.preBroadcast = true; } catch { /* frozen */ } } return e; };

async function evmClientFor(row) {
  const { createWalletClient, http, publicActions, defineChain } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const id = Number(String(row.network).split(":")[1]);
  const rpc = (process.env[`REFUND_RPC_${id}`] || EVM_RPCS[row.network] || "").trim();
  if (!rpc) throw new Error(`no RPC for ${row.network}`);
  const account = privateKeyToAccount(process.env.REFUND_EVM_KEY.trim());
  const chain = defineChain({ id, name: row.network, nativeCurrency: { name: "n", symbol: "n", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  // viem's default retry (3 tries, 150 ms) gives up inside a public RPC's 429
  // window. Re-sending the same signed raw transaction is idempotent.
  const client = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 5, retryDelay: 1000 }) }).extend(publicActions);
  return { client, account };
}
const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

/** Reads before the claim for an EVM refund: the token and its decimals, the
 *  transfer data, the gas the transfer needs and the wallet's NATIVE balance
 *  to pay it. The refund wallet holds the stablecoin on every chain it refunds
 *  and the chain's own coin only where someone put it there, so a chain with
 *  no gas refused the send after the claim and left the row `sending` for a
 *  human. A refusal here leaves the row owed. */
export async function prepareEvm(row, accepts, { clientFor = evmClientFor } = {}) {
  const token = accepts?.asset;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(token))) throw new Error(`no ERC-20 asset in live accepts for ${row.network} (nothing was claimed or sent)`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(row.payer))) throw new Error(`payer is not an EVM address (${tag(row.payer)}; nothing was claimed or sent)`);
  const { client, account } = await clientFor(row);
  // Read decimals from the token itself - assuming 6 and being wrong about a
  // future asset would refund a millionth (or a million times) the debt.
  const decKey = `${row.network}:${String(token).toLowerCase()}`;
  if (!decimalsCache.has(decKey)) decimalsCache.set(decKey, await client.readContract({ address: token, abi: ERC20, functionName: "decimals" }));
  const decimals = decimalsCache.get(decKey);
  const amount = BigInt(Math.round(row.priceUsd * 10 ** Number(decimals)));
  const { encodeFunctionData, concat } = await import("viem");
  // The payer is encoded lowercased: the ledger records addresses as the
  // credential spelled them, and a mixed-case spelling that is not a checksum
  // is refused by the encoder.
  const data = concat([encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [String(row.payer).toLowerCase(), amount] }), refundMemoHex(row)]);
  const gas = await client.estimateGas({ account, to: token, data });
  const fees = await client.estimateFeesPerGas().catch(async () => ({ gasPrice: await client.getGasPrice() }));
  const perGas = BigInt(fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  const need = gas * perGas;
  const native = await client.getBalance({ address: account.address });
  if (native < need) throw new Error(`the refund wallet holds too little of the native coin on ${row.network} to pay for gas (nothing was claimed or sent)`);
  return { client, account, token, amount, data, gas, native, need };
}

async function sendEvm(row, accepts, prep) {
  const p = prep?.client ? prep : await prepareEvm(row, accepts);
  const { client, token, data, gas } = p;
  // Build and sign first: a failure here never left this process, so it is
  // marked pre-broadcast and the executor hands the row back to owed.
  let serialized;
  try {
    const request = await client.prepareTransactionRequest({ to: token, data, gas });
    serialized = await client.signTransaction(request);
  } catch (e) { throw markPreBroadcast(e); }
  // The broadcast itself. A node that refuses the signed bytes for lack of
  // funds never admitted them to its pool, so that refusal is pre-broadcast
  // too; any other failure here may have been broadcast and is not.
  let hash;
  try { hash = await client.sendRawTransaction({ serializedTransaction: serialized }); }
  catch (e) { throw isPreBroadcastFailure(e) ? markPreBroadcast(e) : e; }
  // Wait for it to land before the next send picks a nonce: a load-balanced
  // public RPC can hand back a stale pending nonce. A slow receipt is not a
  // failure; the hash is broadcast and goes in the ledger either way.
  try { await client.waitForTransactionReceipt({ hash, timeout: 60_000 }); }
  catch (e) { console.warn(`      receipt wait for a sent refund: ${(e?.message || String(e)).slice(0, 120)}`); }
  return hash;
}

async function sendStellar(row) {
  const sdk = await import("@stellar/stellar-sdk");
  const { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE } = sdk.default || sdk;
  const server = new Horizon.Server("https://horizon.stellar.org");
  const kp = Keypair.fromSecret(process.env.REFUND_STELLAR_SECRET.trim());
  const usdc = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: row.payer, asset: usdc, amount: row.priceUsd.toFixed(7) }))
    .addMemo(Memo.text("agent402 refund"))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}

async function sendAlgorand(row) {
  const algosdk = (await import("algosdk")).default;
  const account = algosdk.mnemonicToSecretKey(process.env.REFUND_ALGORAND_MNEMONIC.trim());
  const client = new algosdk.Algodv2("", "https://mainnet-api.4160.nodely.dev", "");
  const params = await client.getTransactionParams().do();
  // algosdk v3 field names. v2 used from/to and returned { txId }; this file
  // was written against v2 while v3.6 is installed, so the builder threw
  // "Address must not be null or undefined" on EVERY Algorand refund - and it
  // threw AFTER the row was claimed, stranding the debt in `sending` with no
  // path back. Verified against the installed SDK: from/to throws,
  // sender/receiver builds.
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr, receiver: row.payer, amount: Math.round(row.priceUsd * 1e6),
    assetIndex: 31566704, // USDC ASA
    note: new TextEncoder().encode("agent402 refund"),
    suggestedParams: params,
  });
  const signed = txn.signTxn(account.sk);
  const res = await client.sendRawTransaction(signed).do();
  // v3 returns `txid`. Reading the v2 name gave undefined, which would have
  // been waited on and then written to the ledger as the string "undefined" -
  // a hole in the one field the ledger treats as proof of repayment.
  const txid = res?.txid || res?.txId;
  if (typeof txid !== "string" || !txid.trim()) {
    throw new Error("Algorand broadcast returned no transaction id - MONEY MAY HAVE LEFT; resolve this row by hand");
  }
  await algosdk.waitForConfirmation(client, txid, 20);
  return txid;
}

// ---- Tempo -------------------------------------------------------------------
// The bytes32 memo a Tempo refund carries (TIP-20 transferWithMemo).
export function tempoRefundMemo() {
  const b = Buffer.alloc(32);
  Buffer.from("agent402 refund", "utf8").copy(b);
  return `0x${b.toString("hex")}`;
}

/** Reads before the claim: the token is the one the payment moved (proof.token,
 *  one of our live Tempo currencies), the amount is the debt in its decimals,
 *  and the sending wallet must hold it. A refusal here leaves the row owed. */
async function prepareTempo(row, proof, accepts) {
  const { createPublicClient, http, isAddress } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { tempo } = await import("viem/tempo/chains");
  const offered = new Set((accepts?.assets || []).map((a) => String(a).toLowerCase()));
  const token = String(proof?.token || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !offered.has(token.toLowerCase())) throw new Error("the paid Tempo token is not one our live challenge offers (nothing was claimed or sent)");
  if (!isAddress(String(row.payer))) throw new Error(`payer is not an EVM address (${tag(row.payer)})`);
  const decimals = Number(proof.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("token decimals unreadable (nothing was claimed or sent)");
  const amount = BigInt(Math.round(Number(row.priceUsd) * 10 ** decimals));
  if (amount <= 0n) throw new Error("zero amount (nothing was claimed or sent)");
  const key = process.env.REFUND_TEMPO_KEY.trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const pub = createPublicClient({ chain: tempo, transport: http(TEMPO_RPC()) });
  const bal = await pub.readContract({ address: token, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] });
  if (bal < amount) throw new Error(`the Tempo refund wallet holds too little of the paid token (nothing was claimed or sent)`);
  return { from: account.address, token, amount, asset: token, rpcUrl: TEMPO_RPC() };
}

async function sendTempo(row, prep) {
  const { createWalletClient, http, encodeFunctionData } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { tempo } = await import("viem/tempo/chains");
  const { Abis } = await import("viem/tempo");
  const { prepareTransactionRequest, signTransaction, sendRawTransaction } = await import("viem/actions");
  const key = process.env.REFUND_TEMPO_KEY.trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const wallet = createWalletClient({ account, chain: tempo, transport: http(prep.rpcUrl) });
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [row.payer, prep.amount, tempoRefundMemo()] });
  // Prepared, not hand-rolled (scripts/fund-tempo-fee-payer.js): Tempo
  // transactions are type 0x76 with the fee paid in a stablecoin, here the
  // same token the refund is sent in.
  const prepared = await prepareTransactionRequest(wallet, { account, chainId: tempo.id, calls: [{ to: prep.token, data }], feeToken: prep.token });
  const serialized = await signTransaction(wallet, prepared);
  return sendRawTransaction(wallet, { serializedTransaction: serialized });
}

// ---- Solana ------------------------------------------------------------------
// The same discipline as scripts/solana-refund-send.js: USDC only, the
// destination must already hold a USDC account (a payer of USDC on Solana
// has one), integer base units, our own signer on the memo.
const SOLANA_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
async function solanaRpc(method, params) {
  const r = await fetch(SOLANA_RPC(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${String(j.error.message || "error").slice(0, 120)}`);
  return j.result;
}
async function solanaSigner() {
  const kit = await import("@solana/kit");
  const raw = process.env.REFUND_SOLANA_KEY.trim();
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
  return { kit, signer: await kit.createKeyPairSignerFromBytes(bytes) };
}
async function prepareSolana(row, proof, accepts) {
  const mint = String(accepts?.asset || "");
  if (mint !== SOLANA_USDC_MINT) throw new Error("our live Solana accept is not USDC (nothing was claimed or sent)");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(row.payer))) throw new Error(`payer is not a Solana address (${tag(row.payer)})`);
  const decimals = Number.isInteger(Number(proof?.decimals)) ? Number(proof.decimals) : 6;
  const amount = BigInt(Math.round(Number(row.priceUsd) * 10 ** decimals));
  if (amount <= 0n) throw new Error("zero amount (nothing was claimed or sent)");
  const { signer } = await solanaSigner();
  const from = String(signer.address);
  const accountsOf = async (owner) => (await solanaRpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }])).value || [];
  const [srcAccts, dstAccts] = await Promise.all([accountsOf(from), accountsOf(row.payer)]);
  if (!srcAccts.length) throw new Error("the Solana refund wallet holds no USDC account (nothing was claimed or sent)");
  if (!dstAccts.length) throw new Error(`the payer holds no USDC account (${tag(row.payer)}; nothing was claimed or sent)`);
  if (BigInt(srcAccts[0].account.data.parsed.info.tokenAmount.amount) < amount) throw new Error("the Solana refund wallet holds too little USDC (nothing was claimed or sent)");
  const lamports = await solanaRpc("getBalance", [from]);
  if (Number(lamports?.value ?? lamports) < 1_000_000) throw new Error("the Solana refund wallet holds too little SOL for the fee (nothing was claimed or sent)");
  return { from, asset: mint, amount, source: srcAccts[0].pubkey, destination: dstAccts[0].pubkey };
}
async function sendSolana(row, prep) {
  const { kit, signer } = await solanaSigner();
  const { getTransferInstruction } = await import("@solana-program/token");
  const rpcClient = kit.createSolanaRpc(SOLANA_RPC());
  const { value: blockhash } = await rpcClient.getLatestBlockhash({ commitment: "confirmed" }).send();
  const instructions = [
    getTransferInstruction({ source: kit.address(prep.source), destination: kit.address(prep.destination), authority: signer, amount: prep.amount }),
    { programAddress: kit.address(SOLANA_MEMO_PROGRAM), accounts: [{ address: signer.address, role: kit.AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode("agent402 refund") },
  ];
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayerSigner(signer, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await kit.signTransactionMessageWithSigners(message);
  const sig = kit.getSignatureFromTransaction(signed);
  // Re-sending the same signed bytes is the same transaction: it cannot pay twice.
  await solanaRpc("sendTransaction", [kit.getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  return String(sig);
}

// Families whose refund is proven on chain before the row is marked paid.
export const OUTBOUND_PROOF_FAMILIES = Object.freeze(["tempo", "solana"]);

/**
 * Prove a sent refund on chain with the same check the inbound proof uses,
 * reversed: from our sending wallet to the payer, at least the amount, in the
 * token sent. Polled, because a transaction can be a block behind the answer.
 */
export async function proveRefundSent(row, tx, prep, { verify, attempts = 10, delayMs = 3000, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = { verified: false, reason: "not checked" };
  for (let i = 0; i < attempts; i++) {
    last = await verify({
      network: row.network, payer: prep.from, amountUsd: row.priceUsd, tx, createdAt: Date.now(),
      acceptsFor: () => ({ payTo: row.payer, asset: prep.asset, assets: [prep.asset] }),
      payToSetFor: () => [row.payer],
      rpcFor: () => prep.rpcUrl || null,
    });
    if (last.verified) return last;
    if (i < attempts - 1) await pause(delayMs);
  }
  return last;
}

/**
 * Pay each planned row: prove the inbound payment, read what the send needs
 * (a refusal there leaves the row owed), CLAIM it, send, prove the send on
 * chain where the family requires it, then mark it paid. Every step is
 * injected so the order is tested with stubs; main() wires the real ones.
 * A claimed row whose send failed BEFORE anything was broadcast
 * (isPreBroadcastFailure) is released back to owed through `release`, with
 * the reason as its note, so the next run retries it; any other failure after
 * the claim leaves the row `sending` for a human.
 * Returns { ok, failed, unverified, stuck, released }.
 */
export async function executeRefunds(rows, {
  verifyInbound, claim, send, markPaid,
  prepare = async () => null,
  prove = async () => ({ verified: false, reason: "no outbound verifier" }),
  release = null,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
} = {}) {
  let ok = 0, failed = 0, unverified = 0, stuck = 0, released = 0;
  for (const row of rows || []) {
    let claimedRow = false; // this run holds the row's claim (set once the claim succeeds)
    try {
      // PROVE THE PAYMENT BEFORE REPAYING IT. The debt was recorded on the
      // facilitator's success:true, which is unforgeable by a buyer but not
      // guaranteed true - a facilitator can be wrong, and this week it was, in
      // the opposite direction (Stellar reported failure for transfers that
      // confirmed). So the same payer, our payTo, and at least the amount must
      // be confirmed on-chain before anything leaves. Fails closed: an
      // unverifiable row is HELD, still owed, never paid and never written off.
      const proof = await verifyInbound(row);
      if (!proof?.verified) {
        await pause(1500);
        log.warn(`HOLD  #${row.id} $${row.priceUsd} -> ${tag(row.payer)}: UNVERIFIED - ${proof?.reason || "no proof"}`);
        unverified++;
        continue;
      }
      log.log(`      #${row.id} inbound payment confirmed on-chain`);
      // Reads that can refuse (balances, the payer's token account) run
      // before the claim, so a refusal leaves the row owed for the next run.
      const prep = await prepare(row, proof);
      // CLAIM BEFORE SENDING. Verification proves we were paid; it can never
      // prove we have not already refunded, and it stays true forever. So the
      // row is moved to `sending` first: a crash between broadcast and
      // mark-paid leaves it stuck there for a human instead of being re-sent
      // by the next run. Losing the claim race means another runner has it,
      // or the row is no longer owed (paid, or void).
      const claimed = await claim(row.id);
      if (!claimed) {
        log.warn(`HOLD  #${row.id}: could not claim (already sending, resolved or voided, or another run has it)`);
        unverified++;
        continue;
      }
      claimedRow = true;
      const tx = await send(row, proof, prep);
      if (OUTBOUND_PROOF_FAMILIES.includes(familyOf(row.network))) {
        const out = await prove(row, tx, prep, proof);
        if (!out?.verified) {
          log.error(`STUCK #${row.id}: sent, but the refund is not proven on chain yet (${out?.reason || "no proof"}) - the row stays 'sending', is never re-sent, and is resolved by hand from the sending wallet's history`);
          stuck++;
          continue;
        }
        log.log(`      #${row.id} refund confirmed on-chain`);
      }
      await markPaid(row.id, String(tx));
      log.log(`PAID  #${row.id} $${row.priceUsd} -> ${tag(row.payer)}  (tx in the ledger, not this log)`);
      ok++;
      await pause(1500);
    } catch (e) {
      const msg = (e?.shortMessage || e?.message || String(e)).slice(0, 160);
      // A claimed row whose send failed before anything was broadcast cannot
      // have moved money, so it goes back to owed with the reason as its note
      // and the next run retries it. Only that class is released here.
      if (claimedRow && typeof release === "function" && isPreBroadcastFailure(e)) {
        let back = false;
        try { back = await release(row.id, `refund-run: released, the send failed before broadcast (${msg.slice(0, 100)})`); }
        catch (re) { log.error(`      release of #${row.id} failed: ${(re?.message || String(re)).slice(0, 120)}`); }
        if (back) {
          log.error(`FAIL  #${row.id}: ${msg}`);
          log.error(`      -> released back to owed: nothing was broadcast; the next run retries it once the wallet can pay`);
          failed++; released++;
          continue;
        }
      }
      // If the failure came after the claim, the row is now stuck in `sending`
      // and will NOT be retried automatically - that is deliberate. Whether the
      // money left is exactly what a human must check before releasing it.
      log.error(`FAIL  #${row.id}: ${msg}`);
      log.error(`      -> if this row is now 'sending', check the chain before resolving it; it will not auto-retry`);
      failed++;
    }
  }
  return { ok, failed, unverified, stuck, released };
}

/**
 * Plan, print, and (live only) execute. A dry run prints the plan and returns
 * before any step that reads a chain or touches the ledger.
 */
export async function refundRun({ rows, totals = {}, live = false, planOptions = {}, deps = {}, log = console } = {}) {
  log.log(`refund-run against ${TARGET} - ledger: ${JSON.stringify(totals)}`);
  const plan = planRefunds(rows, planOptions);
  // Each line names the response status the debt was recorded on, so a
  // reviewer reading the dry run can tell a failed answer from a buyer who
  // disconnected (499) before approving a live run.
  const what = (r) => `${r.slug}${r.httpStatus ? `, http ${r.httpStatus}` : ""}${r.hangupReason ? `, ${r.hangupReason}` : ""}`;
  for (const [reason, held] of Object.entries(plan.held)) {
    log.log(`\nHELD (${reason}): ${held.length}`);
    for (const r of held) log.log(`   #${r.id} ${r.network} $${r.priceUsd} -> ${tag(r.payer)} (${what(r)})`);
  }
  log.log(`\nTO SEND: ${plan.send.length} refund(s), $${plan.totalUsd} total`);
  for (const r of plan.send) log.log(`   #${r.id} ${r.network} $${r.priceUsd} -> ${tag(r.payer)} (${what(r)})`);
  if (!live) { log.log("\nDRY RUN - no money moved. Set REFUND_LIVE=true to execute."); return { plan, executed: false }; }
  if (!plan.send.length) { log.log("nothing to send."); return { plan, executed: false }; }
  const result = await executeRefunds(plan.send, { ...(await (typeof deps === "function" ? deps(plan) : deps)), log });
  log.log(`\ndone: ${result.ok} paid, ${result.failed} failed (${result.released || 0} released back to owed), ${result.unverified} held unverified, ${result.stuck} sent and awaiting proof (all unpaid rows remain owed or sending)`);
  return { plan, executed: true, result };
}

// A ledger write, retried only on 429. The server's limiter answers 429
// before the handler touches the ledger, so a 429 means nothing was written
// and resending is safe. Any other failure is returned as-is: a network error or a 5xx may
// have landed, and guessing there is how a row gets resolved twice.
export async function ledgerUpdate(body, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4 } = {}) {
  for (let i = 1; ; i++) {
    const res = await fetchImpl(`${TARGET}/__operator/refunds/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || i >= attempts) return res;
    const wait = Math.min(120, Math.max(1, Number(res.headers?.get?.("retry-after")) || 60));
    console.warn(`      ledger ${body.action} #${body.id}: HTTP 429, retrying in ${wait}s (${i}/${attempts - 1})`);
    await sleep(wait * 1000);
  }
}

// true when this run owns the row. 409 is the server's "not updated" answer:
// another runner holds it or it is resolved. Anything else is not a lost race
// and must not be logged as one.
async function claimForSend(id) {
  const res = await ledgerUpdate({ id, action: "claim", note: "refund-run: claimed before broadcast" });
  if (res.ok) return true;
  if (res.status === 409) return false;
  throw new Error(`claim failed for row ${id}: HTTP ${res.status} (nothing was sent)`);
}

async function markPaid(id, tx) {
  const res = await ledgerUpdate({ id, action: "paid", tx });
  if (!res.ok) throw new Error(`mark-paid failed for row ${id}: HTTP ${res.status}`);
}

// Hand a claimed row back to owed (the server's "release" action, note
// required). Only executeRefunds calls it, and only for a send that failed
// before anything was broadcast.
async function releaseClaim(id, note) {
  const res = await ledgerUpdate({ id, action: "release", note });
  if (res.ok) return true;
  throw new Error(`release failed for row ${id}: HTTP ${res.status} (the row stays sending)`);
}

async function main() {
  if (!TOKEN) { console.error("AGENT402_OPERATOR_TOKEN is required"); process.exit(2); }
  const senders = {
    evm: !!(process.env.REFUND_EVM_KEY || "").trim(),
    stellar: !!(process.env.REFUND_STELLAR_SECRET || "").trim(),
    algorand: !!(process.env.REFUND_ALGORAND_MNEMONIC || "").trim(),
    tempo: !!(process.env.REFUND_TEMPO_KEY || "").trim(),
    solana: !!(process.env.REFUND_SOLANA_KEY || "").trim(),
  };
  const res = await fetch(`${TARGET}/__operator/refunds.json?status=owed`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) { console.error(`refunds.json HTTP ${res.status}`); process.exit(2); }
  const { refunds, totals } = await res.json();

  // The real steps, built only for a live run with something to send.
  const deps = async () => {
    const accepts = await liveAcceptsByNetwork();
    const payToSets = ourPayToSet(accepts);
    const { verifyInboundPayment } = await import("../src/payment-verify.js");
    const { confirmStellarTransfer } = await import("../src/stellar-confirm.js");
    const rpcFor = (n) => (n === TEMPO_NETWORK ? TEMPO_RPC() : (process.env[`REFUND_RPC_${String(n).split(":")[1]}`] || EVM_RPCS[n] || "").trim() || null);
    return {
      verifyInbound: (row) => verifyInboundPayment({
        network: row.network, payer: row.payer, amountUsd: row.priceUsd,
        tx: row.evidence, createdAt: row.createdAt,
        acceptsFor: (n) => accepts[n],
        payToSetFor: (n) => payToSets.get(n) || [],
        rpcFor,
        stellarConfirm: confirmStellarTransfer,
      }),
      claim: claimForSend,
      release: releaseClaim,
      prepare: (row, proof) => {
        const family = familyOf(row.network);
        if (family === "tempo") return prepareTempo(row, proof, accepts[row.network]);
        if (family === "solana") return prepareSolana(row, proof, accepts[row.network]);
        if (family === "evm") return prepareEvm(row, accepts[row.network]);
        return null;
      },
      send: (row, proof, prep) => {
        const family = familyOf(row.network);
        if (family === "evm") return sendEvm(row, accepts[row.network], prep);
        if (family === "stellar") return sendStellar(row);
        if (family === "algorand") return sendAlgorand(row);
        if (family === "tempo") return sendTempo(row, prep);
        if (family === "solana") return sendSolana(row, prep);
        throw new Error(`no sender for ${family}`);
      },
      prove: (row, tx, prep) => proveRefundSent(row, tx, { ...prep, rpcUrl: prep?.rpcUrl || rpcFor(row.network) }, { verify: verifyInboundPayment }),
      markPaid,
    };
  };

  const out = await refundRun({
    rows: refunds, totals, live: LIVE, deps,
    planOptions: {
      onlyChain: ONLY_CHAIN,
      maxPerPayerUsd: MAX_PER_PAYER,
      minRefundUsd: MIN_REFUND,
      includeSynthetic: /^(1|true|yes)$/i.test(process.env.REFUND_INCLUDE_SYNTHETIC || ""),
      includeLastingHangups: /^(1|true|yes)$/i.test((process.env.REFUND_INCLUDE_LASTING_HANGUPS || "").trim()),
      includeRepeatHangups: /^(1|true|yes)$/i.test((process.env.REFUND_INCLUDE_REPEAT_HANGUPS || "").trim()),
      senders,
    },
  });
  if (!out.executed) return;
  const { failed, unverified, stuck } = out.result;
  // A run where everything was HELD used to exit 0 and read as green. A whole
  // class being systematically unverifiable is exactly what that hides.
  process.exit(failed || unverified || stuck ? 1 : 0);
}

// Importing for tests must not run the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
