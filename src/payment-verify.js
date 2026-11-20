// Did the money actually arrive? Ask the chain, not the facilitator.
//
// A refund row is created when the settle receipt says success:true. That
// receipt is unforgeable by a buyer - it is a response header written only by
// @x402/express - but "unforgeable" is not "true". A facilitator can be wrong,
// and we PROVED it can this week, in the opposite direction: on Stellar the
// channel service reported settle_channel_service_failed for transfers that
// then confirmed on-chain. The mirror of that bug - reporting success for a
// transfer that never landed, or that reverted - would have us refunding money
// we never received, out of our own wallet, with no attacker involved at all.
//
// So before any refund leaves, the payment it repays must be confirmed
// independently: the SAME payer, to OUR payTo, for AT LEAST the amount, in a
// transaction that actually succeeded. This module answers that and nothing
// else.
//
// FAIL CLOSED. Every failure - unreadable RPC, unknown chain, missing tx,
// amount short, wrong recipient - returns a `verified:false` with a reason,
// and the executor HOLDS the row. The debt stays on the books; nobody is paid
// on an unproven claim. That asymmetry is the whole point: withholding a real
// refund costs a delay and is visible in the ledger, while paying an unreal
// one costs money and is invisible.

export const SOLANA_RPCS = (process.env.REFUND_SOLANA_RPCS || "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com").split(",").map((x) => x.trim()).filter(Boolean);
export const ALGORAND_INDEXERS = (process.env.REFUND_ALGORAND_INDEXERS || "https://mainnet-idx.4160.nodely.dev").split(",").map((x) => x.trim()).filter(Boolean);

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// TIP-20 TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo):
// keccak256 of that signature, the same constant src/tempo-confirm.js derives.
export const TIP20_TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
/** Tempo mainnet: an EVM chain id, but its own verifier (TIP-20 tokens, more than one accepted currency). */
export const TEMPO_NETWORK = "eip155:4217";
/** Base USDC: the asset a referral-rail payment moves. */
export const REFERRAL_USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

import { isGatewayWire } from "./gateway-wire.js";
import { proveReceipt } from "./referral-proof.js";
import { STELLAR_USDC_CODE, STELLAR_USDC_ISSUER } from "./stellar-confirm.js";
import { usdToBaseUnits } from "./base-units.js";

/** Circle Gateway's API (the batched x402 option, src/gateway-nanopayments.js). */
export const GATEWAY_API_BASE_URL = "https://gateway-api.circle.com";
const GATEWAY_MAX_BODY_BYTES = 64 * 1024;

const fail = (reason) => ({ verified: false, reason });
// A verdict read from a transaction the chain holds (it was mined, and it is
// not this payment's transfer, or it failed): the late-settlement reconcile
// closes such an entry. `absent`: every source answered and none holds the
// transaction. Any other failure is unread.
const minedFail = (reason, extra = {}) => ({ ...fail(reason), mined: true, ...extra });
const pass = (detail) => ({ verified: true, ...detail });

/** 32-byte topic -> 0x-prefixed lowercase address (EVM is case-insensitive,
 *  the one family where lowercasing is correct rather than destructive). */
function addrFromTopic(topic) {
  if (typeof topic !== "string" || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

// Public RPCs answer bursts with 429 (a whole refund run held on it,
// 2026-10-06). These are reads, so retrying them is always safe.
const RPC_RETRY_STATUSES = new Set([429, 502, 503, 504]);
export const RPC_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export async function rpc(url, method, params, fetchImpl, timeoutMs, delays = RPC_RETRY_DELAYS_MS) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || !RPC_RETRY_STATUSES.has(res.status) || attempt >= delays.length) break;
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || "error"}`);
  return j.result;
}

// An RPC URL can carry a provider key, and a reason from here reaches logs
// (the refund job's log is public): no URL is ever part of one. A cut-off
// copy of a URL is not masked by the log's own secret filter, and a fetch of
// a URL it cannot parse quotes all of it, spaces included, after "Failed to
// parse URL from", so the rest of that line goes too.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>]+/gi;
const UNPARSED_URL = /(Failed to parse URL from)[^\n]*/gi;
/** `text` with every URL in it replaced by "<url>". */
export function withoutUrls(text) { return String(text ?? "").replace(UNPARSED_URL, "$1 <url>").replace(URL_IN_TEXT, "<url>"); }
const errText = (e) => withoutUrls(e?.message || String(e));

/** The RPC URLs `rpcFor` named: one URL or a list, blanks and repeats dropped, in order. */
export function rpcUrlList(v) {
  const out = [];
  for (const u of Array.isArray(v) ? v : [v]) {
    const s = typeof u === "string" ? u.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * A transaction receipt, read from each host in turn. A host that answers
 * none (the transaction not yet seen, or a node that keeps no history that
 * old) is read again after each of `emptyDelaysMs`, then the next host is
 * read; a host that cannot be read is passed over. Returns `{ receipt, url }`
 * from the first host that holds it, else `{ receipt: null, error }` (the
 * last read error, or null when every host answered none).
 */
async function readReceipt(urls, tx, { fetchImpl, timeoutMs, emptyDelaysMs = [], pause }) {
  let error = null;
  for (const url of urls) {
    for (let attempt = 0; ; attempt++) {
      let receipt;
      try { receipt = await rpc(url, "eth_getTransactionReceipt", [tx], fetchImpl, timeoutMs); }
      catch (e) { error = errText(e); break; }
      if (receipt) return { receipt, url };
      if (attempt >= emptyDelaysMs.length) break;
      await pause(emptyDelaysMs[attempt]);
    }
  }
  return { receipt: null, error };
}
const receiptFail = (read) => fail(read.error ? `could not read the transaction: ${read.error}` : "transaction not found on chain");

/**
 * Sum of `token` Transfer logs in a receipt that move from `from` to any
 * address in `toSet` (EVM addresses, compared lowercased).
 */
export function evmTransferredInReceipt(receipt, { token, from, toSet }) {
  const tok = String(token || "").toLowerCase();
  const payer = String(from || "").toLowerCase();
  const ours = new Set([...toSet].map((a) => String(a).toLowerCase()));
  let moved = 0n;
  for (const log of receipt?.logs || []) {
    if (String(log.address || "").toLowerCase() !== tok) continue;        // the right token only
    const topics = log.topics || [];
    if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (addrFromTopic(topics[1]) !== payer) continue;                    // from the SAME payer
    if (!ours.has(addrFromTopic(topics[2]))) continue;                   // to ANY wallet we control
    try { moved += BigInt(log.data); } catch { /* unparseable value - ignore this log */ }
  }
  return moved;
}

/**
 * EVM: read the recorded transaction and prove it moved the token from the
 * payer to our payTo. Everything is taken from the transaction itself - we
 * never trust the ledger row's own claim about what happened.
 */
async function verifyEvm({ tx, payer, payToSet, amountUsd, asset, rpcUrls, fetchImpl, timeoutMs, emptyDelaysMs, pause }) {
  const ours = new Set([...payToSet].map((a) => String(a).toLowerCase()));
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return fail("no usable transaction hash recorded");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
  if (![...ours].some((a) => /^0x[0-9a-fA-F]{40}$/.test(a))) return fail("no EVM payTo to check against");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(asset || ""))) return fail("no token address for this network");

  // An empty answer is read again, then from the next host: a public node can
  // keep no receipts past a few days, or answer from a backend that does not.
  const read = await readReceipt(rpcUrls, tx, { fetchImpl, timeoutMs, emptyDelaysMs, pause });
  const receipt = read.receipt;
  if (!receipt) return receiptFail(read);
  // status 0x0 is a REVERTED transaction: the facilitator may have broadcast
  // it and called that success, but no tokens moved.
  if (String(receipt.status) !== "0x1") return fail(`transaction did not succeed on chain (status ${receipt.status})`);

  let decimalsHex;
  try {
    // decimals() - never assumed. Assuming 6 and being wrong by a factor of a
    // million is the kind of mistake that only shows up in the loss column.
    decimalsHex = await rpc(read.url, "eth_call", [{ to: asset, data: "0x313ce567" }, "latest"], fetchImpl, timeoutMs);
  } catch (e) { return fail(`could not read token decimals: ${errText(e)}`); }
  const decimals = Number(BigInt(decimalsHex || "0x0"));
  if (!Number.isFinite(decimals) || decimals > 36) return fail("token decimals unreadable");
  const expected = usdToBaseUnits(Number(amountUsd), decimals);
  if (expected <= 0n) return fail("expected amount is zero");

  const from = String(payer).toLowerCase();

  const moved = evmTransferredInReceipt(receipt, { token: asset, from, toSet: ours });
  if (moved === 0n) return fail("no transfer from this payer to our payTo in that transaction");
  // >= not ==: premium-priced chains quote MORE than list, and the debt is
  // recorded at list, so the buyer legitimately paid at least the expected sum.
  if (moved < expected) return fail(`transfer is short: moved ${moved} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: moved.toString(), decimals, tx });
}

/**
 * Tempo: the EVM proof, for TIP-20. A Tempo payment can be in any currency our
 * challenges offer (`tokens`), and the token emits Transfer and, for a memo
 * transfer, TransferWithMemo for the same movement, so each kind is summed on
 * its own and the larger counts (never both). Returns the token that moved,
 * so a refund goes back in the currency that was paid.
 */
async function verifyTempo({ tx, payer, payToSet, amountUsd, tokens, rpcUrls, fetchImpl, timeoutMs, emptyDelaysMs, pause }) {
  const ours = new Set([...payToSet].map((a) => String(a).toLowerCase()));
  const allowed = new Set([...(tokens || [])].map((t) => String(t).toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)));
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return fail("no usable transaction hash recorded");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
  if (![...ours].some((a) => /^0x[0-9a-f]{40}$/.test(a))) return fail("no Tempo payTo to check against");
  if (!allowed.size) return fail("no Tempo currency to check against");
  const read = await readReceipt(rpcUrls, tx, { fetchImpl, timeoutMs, emptyDelaysMs, pause });
  const receipt = read.receipt;
  if (!receipt) return receiptFail(read);
  if (String(receipt.status) !== "0x1") return fail(`transaction did not succeed on chain (status ${receipt.status})`);
  const from = String(payer).toLowerCase();
  const moved = new Map(); // token -> { transfer, memo }
  for (const log of receipt.logs || []) {
    const token = String(log.address || "").toLowerCase();
    if (!allowed.has(token)) continue;
    const topics = log.topics || [];
    const t0 = String(topics[0] || "").toLowerCase();
    const kind = t0 === ERC20_TRANSFER_TOPIC ? "transfer" : t0 === TIP20_TRANSFER_WITH_MEMO_TOPIC ? "memo" : null;
    if (!kind) continue;
    if (addrFromTopic(topics[1]) !== from) continue;
    if (!ours.has(addrFromTopic(topics[2]))) continue;
    let v; try { v = BigInt(log.data); } catch { continue; }
    const m = moved.get(token) || { transfer: 0n, memo: 0n };
    m[kind] += v;
    moved.set(token, m);
  }
  let token = null, best = 0n;
  for (const [t, m] of moved) { const v = m.transfer > m.memo ? m.transfer : m.memo; if (v > best) { best = v; token = t; } }
  if (!token) return fail("no transfer from this payer to our payTo in that transaction");
  let decimalsHex;
  try { decimalsHex = await rpc(read.url, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"], fetchImpl, timeoutMs); }
  catch (e) { return fail(`could not read token decimals: ${errText(e)}`); }
  const decimals = Number(BigInt(decimalsHex || "0x0"));
  if (!Number.isFinite(decimals) || decimals > 36) return fail("token decimals unreadable");
  const expected = usdToBaseUnits(Number(amountUsd), decimals);
  if (expected <= 0n) return fail("expected amount is zero");
  if (best < expected) return fail(`transfer is short: moved ${best} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: best.toString(), decimals, tx, token });
}

/**
 * Solana: read the recorded signature and prove the token moved from the payer
 * to our payTo. Balances are compared pre/post for the OWNER, which is what
 * actually changed hands - token-account addresses are derived, and matching
 * on them instead would miss a payer using a non-default account.
 */
async function verifySolana({ tx, payer, payToSet, amountUsd, asset, rpcs, fetchImpl, timeoutMs }) {
  if (typeof tx !== "string" || tx.length < 40) return fail("no usable Solana signature recorded");
  const mint = String(asset || "");
  if (!mint) return fail("no mint for this network");
  let txn = null, lastErr = "";
  for (const url of rpcs) {
    try {
      txn = await rpc(url, "getTransaction", [tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }], fetchImpl, timeoutMs);
      if (txn) break;
    } catch (e) { lastErr = errText(e); }
  }
  if (!txn) return { ...fail(`transaction not found on chain${lastErr ? ` (${lastErr})` : ""}`), ...(lastErr || !rpcs.length ? {} : { absent: true }) };
  const meta = txn.meta || {};
  // A failed Solana transaction moves no tokens - exactly what our own best
  // customer's wallet produced when it ran dry (insufficient funds, 2026-08-03).
  if (meta.err) return minedFail(`transaction failed on chain (${JSON.stringify(meta.err).slice(0, 60)})`, { failedOnChain: true });

  const sum = (rows, owner) => (rows || [])
    .filter((b) => b && b.owner === owner && b.mint === mint)
    .reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
  const decimals = Number(((meta.postTokenBalances || []).find((b) => b?.mint === mint) || {}).uiTokenAmount?.decimals);
  if (!Number.isFinite(decimals)) return minedFail("token decimals unreadable from the transaction");

  const credited = [...payToSet].reduce(
    (a, w) => a + (sum(meta.postTokenBalances, w) - sum(meta.preTokenBalances, w)), 0n);
  if (credited <= 0n) return minedFail("our payTo was not credited in that transaction");
  const debited = sum(meta.preTokenBalances, payer) - sum(meta.postTokenBalances, payer);
  if (debited <= 0n) return minedFail("this payer was not debited in that transaction");

  const expected = usdToBaseUnits(Number(amountUsd), decimals);
  if (expected <= 0n) return fail("expected amount is zero");
  if (credited < expected) return minedFail(`transfer is short: credited ${credited} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: credited.toString(), decimals, tx });
}

/**
 * Algorand: the indexer stores only CONFIRMED transactions, so presence is the
 * success proof - but sender, receiver, ASA and amount are still all checked
 * against the debt rather than assumed from it.
 */
async function verifyAlgorand({ tx, payer, payToSet, amountUsd, asset, indexers, fetchImpl, timeoutMs }) {
  if (typeof tx !== "string" || tx.length < 40) return fail("no usable Algorand txid recorded");
  const assetId = Number(String(asset || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(assetId) || assetId <= 0) return fail("no ASA id for this network");

  let body = null, lastErr = "", notFound = 0;
  for (const base of indexers) {
    try {
      const res = await fetchImpl(`${String(base).replace(/\/+$/, "")}/v2/transactions/${encodeURIComponent(tx)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) notFound++;
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      body = await res.json();
      if (body) break;
    } catch (e) { lastErr = errText(e); }
  }
  const t = body?.transaction;
  // The indexer answers 404 for a transaction it does not hold.
  if (!t) return { ...fail(`transaction not found on chain${lastErr ? ` (${lastErr})` : ""}`), ...(indexers.length && notFound === indexers.length ? { absent: true } : {}) };
  if (!t["confirmed-round"]) return fail("transaction is not confirmed");

  const ax = t["asset-transfer-transaction"];
  if (!ax) return minedFail("not an asset-transfer transaction");
  if (Number(ax["asset-id"]) !== assetId) return minedFail(`wrong asset (${ax["asset-id"]} != ${assetId})`);
  if (t.sender !== payer) return minedFail("sender is not the payer we would repay");
  if (![...payToSet].includes(ax.receiver)) return minedFail("receiver is not a wallet we control");
  // USDC on Algorand is 6-decimal; the amount is already in atomic units.
  const expected = usdToBaseUnits(Number(amountUsd), 6);
  const moved = BigInt(ax.amount || 0);
  if (expected <= 0n) return fail("expected amount is zero");
  if (moved < expected) return minedFail(`transfer is short: moved ${moved} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: moved.toString(), decimals: 6, tx });
}

/**
 * Circle Gateway batched payment (wire gateway-batched): the row's evidence is
 * Gateway's transfer id, not a chain hash, so the proof is Gateway's own
 * transfer record (GET /v1/x402/transfers/{id}, keyless), held to the same
 * rule as a chain receipt: the SAME payer, to a payTo WE control, at least
 * the amount, in USDC, on the row's network, and SETTLED. Gateway's own
 * advice is to wait for `confirmed` before crediting for accounting; a
 * transfer still `received` or `batched` may yet fail (and a failed one was
 * never charged), so only `confirmed` and `completed` prove a debt. Anything
 * else holds the row with the reason.
 */
async function verifyGatewayBatched({ tx, payer, payToSet, amountUsd, network, fetchImpl, timeoutMs, gatewayBase = GATEWAY_API_BASE_URL }) {
  const id = String(tx || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return fail("Circle Gateway debt with no Gateway transfer id recorded - cannot be proven; resolve by hand from Gateway's transfer history");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
  const ours = new Set([...payToSet].map((a) => String(a).toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  if (!ours.size) return fail("no EVM payTo to check against");
  let res, text = "";
  try {
    res = await fetchImpl(`${gatewayBase}/v1/x402/transfers/${id}`, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!/\bjson\b/i.test(String(res.headers?.get?.("content-type") || ""))) return fail(`Circle Gateway transfer lookup answered HTTP ${res.status} without JSON`);
    text = String(await res.text());
  } catch (e) { return fail(`could not read the Circle Gateway transfer: ${String(e?.name || "error").slice(0, 40)}`); }
  if (res.status === 404) return fail("Circle Gateway has no transfer with that id");
  if (!res.ok) return fail(`Circle Gateway transfer lookup answered HTTP ${res.status}`);
  if (Buffer.byteLength(text) > GATEWAY_MAX_BODY_BYTES) return fail("Circle Gateway transfer record too large");
  let t;
  try { t = JSON.parse(text); } catch { return fail("Circle Gateway transfer record is not JSON"); }
  if (!t || typeof t !== "object" || String(t.id || "").toLowerCase() !== id) return fail("Circle Gateway answered a different transfer");
  const status = String(t.status || "");
  if (status === "failed") return fail("Circle Gateway reports the transfer failed - no charge landed, nothing to repay (void with a note)");
  if (status !== "confirmed" && status !== "completed") return fail(`Circle Gateway transfer not settled yet (status ${/^[a-z_]{1,20}$/.test(status) ? status : "unknown"}) - held until it is confirmed`);
  if (t.token !== undefined && t.token !== "USDC") return fail("Circle Gateway transfer is not USDC");
  if (String(t.fromAddress || "").toLowerCase() !== String(payer).toLowerCase()) return fail("Circle Gateway transfer is from a different payer");
  if (!ours.has(String(t.toAddress || "").toLowerCase())) return fail("Circle Gateway transfer is not to our payTo");
  if (t.recipientNetwork !== network && t.sendingNetwork !== network) return fail("Circle Gateway transfer is on a different network than this debt");
  if (!/^[0-9]{1,78}$/.test(String(t.amount ?? ""))) return fail("Circle Gateway transfer amount unreadable");
  const expected = usdToBaseUnits(Number(amountUsd), 6); // USDC, 6 decimals on Gateway
  if (expected <= 0n) return fail("expected amount is zero");
  const moved = BigInt(t.amount);
  if (moved < expected) return fail(`transfer is short: moved ${moved} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: moved.toString(), decimals: 6, tx: id, via: "circle-gateway", status });
}

/**
 * Confirm the inbound payment a refund row claims. Returns
 * `{ verified:true, … }` or `{ verified:false, reason }` - never throws.
 *
 * `rpcFor(network)` supplies the RPC URL, or a list of them read in order (a
 * receipt a host does not hold is read from the next), `acceptsFor(network)`
 * the live 402 accepts entry (asset + payTo) so the token and recipient come
 * from our own offer rather than a hand-maintained table.
 * `receiptRetryDelaysMs`: an empty receipt is read again from the same host
 * after each delay before the next host is read (none by default: a serving
 * path's caller reads once).
 */
export async function verifyInboundPayment({
  network, payer, amountUsd, tx, createdAt,
  wire = null,                 // the row's payment wire; gateway-batched is proven at Gateway
  gatewayBase = GATEWAY_API_BASE_URL,
  acceptsFor = () => null,
  rpcFor = () => null,
  receiptRetryDelaysMs = [],
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  stellarConfirm = null,       // injected: (opts) => Promise<{transaction}|null>
  payToSetFor = null,          // (network) => iterable of every payTo WE control
  referralPayTo = null,        // the split contract a "referral" row was paid to (src/referral-gate.js)
  referralMerchantId = null,   // our merchant id on that contract (REFERRAL_MERCHANT_ID)
  referralPayout = null,       // the wallet the contract pays our merchant amount to (REFERRAL_PAYOUT_ADDRESS)
  referralRoutedTopic = null,  // the routed-payment event topic, when it differs from the documented one
  solanaRpcs = SOLANA_RPCS,
  algorandIndexers = ALGORAND_INDEXERS,
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  try {
    // A sale on a referral copy (wire "referral") paid the referral network's
    // split contract, not a wallet of ours, and that contract pays whichever
    // merchant its caller names. Its proof is the gate's own rule
    // (proveReceipt, src/referral-chain.js), on Base: in the recorded
    // transaction, an authorization of this payer with its own transfer of
    // at least the amount into THAT contract, routed by the contract to OUR
    // merchant and paid out to our payout wallet. A transfer into the
    // contract alone proves nothing about who was paid, and is not repaid.
    // An OPERATOR's refund of a referral payment whose routing the rule does
    // not accept (wire "referral-operator", written only by the operator's
    // `refund` in src/referral-gate.js): what a refund needs is proof that
    // the buyer paid, so it is proven by this payer's own authorization in
    // the recorded transaction with its transfer of at least the amount into
    // the split contract, whatever the contract did next.
    // A referral row's evidence is the transaction, or the transaction and
    // the authorization's nonce ("<tx>#<nonce>": one row per payment where a
    // transaction settled several): the nonce, when there, is the one proven.
    let referralNonce = null;
    if ((wire === "referral" || wire === "referral-operator") && typeof tx === "string" && tx.includes("#")) {
      const [hash, nonce] = tx.split("#");
      tx = hash;
      referralNonce = /^0x[0-9a-fA-F]{64}$/.test(String(nonce || "")) ? nonce : null;
      if (referralNonce === null) return fail("the recorded evidence names no usable authorization nonce");
    }
    if (wire === "referral-operator") {
      if (String(network || "") !== "eip155:8453") return fail(`referral debt on ${network || "an unknown network"} - the referral rail settles on Base only`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(referralPayTo || ""))) return fail("no referral pay-to address configured (REFERRAL_PAY_TO) - cannot prove where the money went");
      const rpcUrls = rpcUrlList(rpcFor(network));
      if (!rpcUrls.length) return fail(`no RPC configured for ${network}`);
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return fail("no usable transaction hash recorded");
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
      const units = usdToBaseUnits(Number(amountUsd), 6);
      if (units <= 0n) return fail("expected amount is zero");
      const read = await readReceipt(rpcUrls, tx, { fetchImpl, timeoutMs, emptyDelaysMs: receiptRetryDelaysMs, pause });
      const receipt = read.receipt;
      if (!receipt) return receiptFail(read);
      const proof = proveReceipt(receipt, { tx, from: payer, nonce: referralNonce, payTo: referralPayTo, amount: units.toString() });
      if (proof.moved !== true) return fail(`the transaction does not show this payer's own transfer of the amount into the split contract (${proof.why})`);
      return pass({ movedAtomic: units.toString(), decimals: 6, tx });
    }
    if (wire === "referral") {
      if (String(network || "") !== "eip155:8453") return fail(`referral debt on ${network || "an unknown network"} - the referral rail settles on Base only`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(referralPayTo || ""))) return fail("no referral pay-to address configured (REFERRAL_PAY_TO) - cannot prove where the money went");
      const rpcUrls = rpcUrlList(rpcFor(network));
      if (!rpcUrls.length) return fail(`no RPC configured for ${network}`);
      if (!/^\d{1,78}$/.test(String(referralMerchantId ?? "")) || !/^0x[0-9a-fA-F]{40}$/.test(String(referralPayout || ""))) return fail("no referral merchant id or payout address configured (REFERRAL_MERCHANT_ID, REFERRAL_PAYOUT_ADDRESS) - cannot prove the payment was routed to us");
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return fail("no usable transaction hash recorded");
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
      const units = usdToBaseUnits(Number(amountUsd), 6);
      if (units <= 0n) return fail("expected amount is zero");
      const read = await readReceipt(rpcUrls, tx, { fetchImpl, timeoutMs, emptyDelaysMs: receiptRetryDelaysMs, pause });
      const receipt = read.receipt;
      if (!receipt) return receiptFail(read);
      // The routed event and the payout of the amount it states decide; the
      // refund row carries no commission, so the least net asked here is 1.
      const proof = proveReceipt(receipt, { tx, from: payer, nonce: referralNonce, payTo: referralPayTo, amount: units.toString(), merchantId: String(referralMerchantId), payoutAddress: referralPayout, minNet: "1", ...(referralRoutedTopic ? { routedTopic: referralRoutedTopic } : {}) });
      if (proof.verdict !== "paid") return fail(`the transaction does not prove a payment routed to this merchant (${proof.verdict}: ${proof.why})`);
      return pass({ movedAtomic: units.toString(), decimals: 6, tx });
    }
    const accepts = acceptsFor(network);
    // payTo is per-SLUG: self-funding routes settle to the SPENDING wallet, not
    // the treasury. Verifying against a single address made every debt for
    // those routes unverifiable forever - and they are the ones most likely to
    // charged-fail. `payToSetFor` supplies every address WE control on this
    // network; a transfer to any of them is a transfer to us. It still proves
    // the money reached us, which is the property that matters.
    const extra = typeof payToSetFor === "function" ? payToSetFor(network) : null;
    const payToSet = new Set(
      [...(extra || []), accepts?.payTo].filter(Boolean).map((x) => String(x)),
    );
    const payTo = accepts?.payTo || [...payToSet][0];
    if (!payToSet.size) return fail(`no live payTo for ${network} - cannot prove where the money went`);
    const n = String(network || "");

    // A Circle Gateway batched sale settled off chain: its evidence is
    // Gateway's transfer id, proven by Gateway's record, never by an RPC.
    if (isGatewayWire(wire)) {
      if (!n.startsWith("eip155:")) return fail(`Circle Gateway debt on ${n || "an unknown network"} - not a network the batched option settles`);
      return await verifyGatewayBatched({ tx, payer, payToSet, amountUsd, network: n, fetchImpl, timeoutMs, gatewayBase });
    }

    if (n === TEMPO_NETWORK) {
      const rpcUrls = rpcUrlList(rpcFor(network));
      if (!rpcUrls.length) return fail(`no RPC configured for ${network}`);
      const tokens = Array.isArray(accepts?.assets) ? accepts.assets : accepts?.asset ? [accepts.asset] : [];
      return await verifyTempo({ tx, payer, payToSet, amountUsd, tokens, rpcUrls, fetchImpl, timeoutMs, emptyDelaysMs: receiptRetryDelaysMs, pause });
    }

    if (n.startsWith("eip155:")) {
      const rpcUrls = rpcUrlList(rpcFor(network));
      if (!rpcUrls.length) return fail(`no RPC configured for ${network}`);
      return await verifyEvm({ tx, payer, payToSet, amountUsd, asset: accepts.asset, rpcUrls, fetchImpl, timeoutMs, emptyDelaysMs: receiptRetryDelaysMs, pause });
    }

    if (n.startsWith("stellar:")) {
      if (typeof stellarConfirm !== "function") return fail("no Stellar verifier available");
      // Reuses the same payer->payTo, same-transaction proof the late-settle
      // fix already relies on; the window opens just before the debt was
      // recorded so a late confirmation still counts.
      const found = await stellarConfirm({
        payer, payTo, sinceMs: Number(createdAt || 0) - 120_000, waitMs: 0,
        assetCode: STELLAR_USDC_CODE, assetIssuer: STELLAR_USDC_ISSUER,
      });
      if (!found) return fail("no confirmed transfer from this payer to our payTo");
      // BIND IT TO THIS DEBT, UNCONDITIONALLY. The confirmer answers "did this
      // payer pay us near this time", which is weaker than the other rails:
      // they resolve a specific transaction. The binding used to apply only
      // when the row happened to record a 64-hex hash - but the ledger's
      // fallback evidence is payer|slug|minute, and on THAT path the check was
      // skipped entirely. Two such rows plus one dust payment would then verify
      // both, and each would be repaid at full face value. A row we cannot bind
      // is held for a human, which is the asymmetry this module exists for.
      const recorded = String(tx || "");
      if (!/^[0-9a-fA-F]{64}$/.test(recorded)) {
        return fail("no transaction recorded - cannot bind a confirmation to this debt");
      }
      if (String(found.transaction) !== recorded) {
        return fail("the confirmed transfer is a different transaction than this debt recorded");
      }
      // USDC BY ISSUER. Anyone can issue a Stellar asset whose code reads
      // "USDC"; a credit counts only in the asset our offers name, by code and
      // issuer, as the confirmer reports what it found.
      if (found.assetCode !== STELLAR_USDC_CODE || found.assetIssuer !== STELLAR_USDC_ISSUER) {
        return fail("the confirmed transfer is not USDC from its issuer");
      }
      // COMPARE THE AMOUNT. Every other rail enforces "at least the amount";
      // this branch carried found.amount and never checked it, so a dust
      // transfer satisfied a debt of any size. Stellar amounts are decimal
      // strings with 7 places - compare in integer stroops, not floats.
      const stroops = (v) => {
        try { return usdToBaseUnits(typeof v === "string" ? v : Number(v), 7); } catch { return null; }
      };
      const got = stroops(found.amount);
      const want = stroops(amountUsd);
      if (got === null || want === null) return fail("could not read the transferred amount");
      if (want <= 0n) return fail("expected amount is zero");
      if (got < want) return fail(`transfer is short: ${found.amount} < ${amountUsd}`);
      return pass({ tx: found.transaction, amount: found.amount });
    }

    if (n.startsWith("solana:")) {
      return await verifySolana({ tx, payer, payToSet, amountUsd, asset: accepts.asset, rpcs: solanaRpcs, fetchImpl, timeoutMs });
    }

    if (n.startsWith("algorand:")) {
      return await verifyAlgorand({ tx, payer, payToSet, amountUsd, asset: accepts.asset, indexers: algorandIndexers, fetchImpl, timeoutMs });
    }

    // Any FUTURE chain holds its rows rather than being assumed good:
    // unverifiable is not the same as unpaid, and the debt stays visible until
    // someone can prove it.
    return fail(`no on-chain verifier for ${n.split(":")[0] || "unknown"} yet - debt held, not written off`);
  } catch (e) {
    return fail(`verification error: ${errText(e).slice(0, 120)}`);
  }
}
