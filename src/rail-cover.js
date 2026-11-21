// What a verified payment on a rail other than the x402 EVM exact wire draws
// on, and how much of it the payer holds: the terms and balance reads the
// in-flight coverage check (src/inflight-cover.js) needs for a Tempo pull
// credential and for a Solana, Algorand or Stellar x402 payment.
//
// TERMS. { rail, payer, network, asset, atomic }: the account the payment
// draws on, the token, and the base units it moves. Read only after the gate
// verified the payment:
//   - Tempo pull: the sender the gate VERIFIED (the signature or the chain
//     proved it; never the credential's client-written source; for a pull
//     signed by an access key, the account the key signs for, which is the
//     account that pays), the challenge's currency and amount (src/mpp-tempo.js sets them on the
//     request). A push credential is final before the handler and has none.
//     A pull with another address in the fee-payer slot draws on its signer,
//     which the signature proves. A multisig envelope proves no account (the
//     gate marks it `ledger`, see inspectTempoSender's booking): its terms
//     carry `unproven`, the client address it came from, and the coverage
//     check books it there, on no account's ledger and on no balance. The
//     exception is a multisig account PROVEN BY SETTLEMENT (below): a pull
//     whose owner approvals verify against a config the chain has already
//     accepted for that account, in a payment this server settled, is the
//     account's own, and its terms are a verified sender's.
//   - Solana: the WALLET, the transfer's authority (always a static key), the
//     mint, and the accept's amount, judged on all the wallet holds of the
//     mint (`byOwner`), whether the transfer names its accounts in the static
//     keys or through an address lookup table: one wallet paying in both
//     shapes is one ledger. When the source token account is static and is
//     not one of the wallet's own (a delegate's transfer), its balance is
//     added to the wallet's.
//   - Algorand: the sender of the signed payment transaction, the accept's
//     asset id and amount.
//   - Stellar: the `from` of the invoked transfer, the accept's asset
//     contract and amount.
// The amount and asset come from the payment's `accepted` requirement, which
// the paywall matched against its own offer before verify. Null when any part
// cannot be read; the caller then has no coverage decision to make.
//
// BALANCES. One bounded read each, null when it cannot be read (the caller
// treats null as unknown, never as zero):
//   - Tempo: balanceOf on the TIP-20 token through TEMPO_RPC_URL.
//   - Solana: the sum of the wallet's token accounts of the mint
//     (getTokenAccountsByOwner with the mint, SOLANA_RPCS; a wallet with none
//     reads as unknown, never zero), plus a static source account that is not
//     among them (getTokenAccountBalance, on the same RPC).
//   - Algorand: the account's holding of the asset from algod
//     (ALGORAND_ALGOD_BASES).
//   - Circle Gateway batched: the signer's available Gateway balance on the
//     paying network's domain (the batched payment is paid from it, not from
//     the wallet).
//   - Stellar: a G account's classic balance of the asset whose contract id
//     is the accept's (Horizon: STELLAR_HORIZON_URL first, then
//     STELLAR_HORIZON_URLS); 7 decimals. A contract account (C...) keeps its
//     balance in contract storage and reads as unknown.
// Every read is an upper bound on what can settle (it ignores fees, a
// delegate's allowance and selling liabilities), so it can only err toward
// admitting a run.
import { paymentHeaderOf } from "./payer.js";
import { decodePaymentHeader } from "./payment-header.js";
import { nonEvmPayerFromRequest } from "./non-evm-payer.js";
import { svmTransferAccounts, svmTransferAuthority, isSvmNetwork } from "./svm-payer.js";
import { limiterKey } from "./rate-limit.js";
import { shared, sharedWrite } from "./shared-limits.js";

const UINT = /^\d{1,39}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const RAIL_READ_TIMEOUT_MS = 2_500;

/** The client address a request came from, as every per-address guard keys
 *  it (an IPv6 address by its /64); one shared key when none can be read. */
function clientAddressKey(req) {
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : req.socket?.remoteAddress;
  return `ip:${ip ? limiterKey(String(ip).trim()) : "?"}`;
}

// A MULTISIG ACCOUNT PROVEN BY SETTLEMENT. Whether a multisig envelope's
// config is the named account's cannot be read here, but the chain says so
// when it takes a payment: a pull from `account` whose approvals verify
// against the config with commitment `commitment`, which THIS SERVER settled,
// proves that config signs for that account. The Tempo gate records the pair
// from its settled path (noteTempoMultisigSettled; nothing in a request can
// write it), and a later pull naming the same account under the same
// commitment, with approvals that verify, is that account's own.
//   - Kept in the shared store the coverage check uses (src/shared-limits.js:
//     a flag per pair), so another container and a restarted one read it;
//     with no shared store it is this process's, and a restart returns the
//     account to the client-address allowance until its next pull settles.
//   - Bounded: a pair exists only for a payment that settled, lasts
//     MULTISIG_PROOF_MS past the last one (written through at most once a
//     day per pair), and this process remembers at most PROOFS_MAX of them,
//     which it reads only when the store does not answer.
//   - Withdrawn (withdrawTempoMultisigProof) when a pull under the pair is
//     not settled for a cause that is not this server's: a config the chain
//     no longer takes for the account stops being its own here.
const PROOF_NAME = "tempo-multisig-proof";
export const MULTISIG_PROOF_MS = 30 * 24 * 60 * 60_000;
const PROOF_REFRESH_MS = 24 * 60 * 60_000;
const PROOFS_MAX = 10_000;
const COMMITMENT = /^0x[0-9a-f]{64}$/;
const proofs = new Map(); // "account:commitment" -> until; least recently set first
const proofKey = (account, commitment) => {
  const a = String(account || "").toLowerCase(), c = String(commitment || "").toLowerCase();
  return HEX_ADDR.test(a) && COMMITMENT.test(c) ? `${a}:${c}` : null;
};
function rememberProof(k, until) {
  proofs.delete(k);
  proofs.set(k, until);
  while (proofs.size > PROOFS_MAX) proofs.delete(proofs.keys().next().value);
}
/** A pull from `account` under the config `commitment` SETTLED through this
 *  server. Called by the Tempo gate's settled path only. */
export function noteTempoMultisigSettled(account, commitment, now = Date.now()) {
  const k = proofKey(account, commitment);
  if (!k) return false;
  const had = proofs.get(k) || 0;
  rememberProof(k, now + MULTISIG_PROOF_MS);
  if (had - now < MULTISIG_PROOF_MS - PROOF_REFRESH_MS) void sharedWrite(PROOF_NAME, shared.flagSet(PROOF_NAME, k, now + MULTISIG_PROOF_MS, { now }));
  return true;
}
/** The chain did not take a pull under this pair: it is no longer proven. */
export function withdrawTempoMultisigProof(account, commitment, now = Date.now()) {
  const k = proofKey(account, commitment);
  if (!k) return false;
  proofs.delete(k);
  void sharedWrite(PROOF_NAME, shared.flagSet(PROOF_NAME, k, 0, { now }));
  return true;
}
/** Has a pull from `account` under `commitment` settled through this server
 *  (here or on another container) within MULTISIG_PROOF_MS? The store
 *  answers; this process's own memory only when it does not. Never throws. */
export async function tempoMultisigProven(account, commitment, now = Date.now()) {
  const k = proofKey(account, commitment);
  if (!k) return false;
  let r = null;
  try { r = await shared.flagGet(PROOF_NAME, k, { now }); } catch { r = null; }
  if (r?.ok) {
    if (r.until > now) { rememberProof(k, r.until); return true; }
    proofs.delete(k);
    return false;
  }
  return (proofs.get(k) || 0) > now;
}
/** Test-only: this process forgets the pairs it remembers (a restart). */
export function _resetTempoMultisigProofsForTest() { proofs.clear(); }

/** The Tempo pull payment on this request, or null. One whose sender the gate
 *  did not prove (any `ledger` mark) carries `unproven`: the client address,
 *  the only thing about its sender this server knows. The exception: a
 *  multisig pull whose approvals verify against a config (`commitment`, set
 *  by the gate only then) that a settled payment has proven for the account
 *  it names; its terms are the account's own. */
export async function tempoCoverTermsOf(req) {
  const t = req && typeof req === "object" && req.tempoSettling === true ? req.mppTempoPull : null;
  if (!t || typeof t !== "object") return null;
  const payer = String(t.sender || ""), asset = String(t.currency || ""), amount = String(t.amountAtomic ?? "");
  if (!HEX_ADDR.test(asset) || !UINT.test(amount)) return null;
  const terms = { rail: "tempo", payer: HEX_ADDR.test(payer) ? payer.toLowerCase() : null, network: "tempo", asset: asset.toLowerCase(), atomic: BigInt(amount) };
  if (t.ledger != null) {
    if (terms.payer && t.commitment != null && await tempoMultisigProven(terms.payer, t.commitment)) return terms;
    // Unproven: `payer` is only the account the credential names (none when
    // it names none), never a key.
    return { ...terms, unproven: clientAddressKey(req) };
  }
  return terms.payer ? terms : null;
}

/** The verified Solana, Algorand or Stellar payment on this request, or null. */
export async function nonEvmCoverTermsOf(req) {
  const header = paymentHeaderOf(req);
  if (!header || header.length > 65536) return null;
  let p;
  try { p = decodePaymentHeader(header); } catch { return null; }
  const network = typeof p?.accepted?.network === "string" ? p.accepted.network : "";
  const amount = String(p?.accepted?.amount ?? "");
  const asset = typeof p?.accepted?.asset === "string" ? p.accepted.asset : "";
  if (!network || !UINT.test(amount) || !asset || asset.length > 128) return null;
  const atomic = BigInt(amount);
  if (isSvmNetwork(network)) {
    const tx = p?.payload?.transaction ?? p?.transaction;
    const t = svmTransferAccounts(tx);
    if (t) {
      if (t.mint !== asset) return null;
      // Keyed on the wallet (the transfer's authority, which the paid record
      // is kept under too), the same ledger a lookup-table payment of that
      // wallet is kept in. `source`: the static source token account, added
      // to the wallet's balance when it is not one of the wallet's own.
      return { rail: "svm", byOwner: true, payer: t.authority, owner: t.authority, source: t.source, network, asset, atomic };
    }
    // An account of the transfer is a lookup-table entry: keyed on the wallet
    // (its authority, read from the static keys), whose balance is what it
    // holds of the accepted mint (the gate matched the mint before verify).
    const a = svmTransferAuthority(tx);
    if (!a?.found || typeof a.authority !== "string" || !a.authority) return null;
    return { rail: "svm", byOwner: true, payer: a.authority, owner: a.authority, network, asset, atomic };
  }
  if (!/^(algorand|stellar):/.test(network)) return null;
  let key = null;
  try { key = await nonEvmPayerFromRequest(req); } catch { key = null; }
  if (!key) return null;
  if (key.startsWith("avm:")) return /^\d{1,20}$/.test(asset) ? { rail: "avm", payer: key.slice(4), network, asset, atomic } : null;
  if (key.startsWith("stellar:")) return { rail: "stellar", payer: key.slice(8), network, asset, atomic };
  return null;
}

const getJson = async (url, { headers, timeoutMs }) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return res.json();
};
const postRpc = async (url, method, params, { headers = {}, timeoutMs }) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return undefined;
  const j = await res.json();
  return j && !j.error ? j.result : undefined;
};
const entryOf = (e) => (typeof e === "string" ? { url: e, headers: undefined } : { url: e?.url, headers: e?.headers });
/** Walk `bases` until one answers a bigint, inside one overall deadline. */
async function firstAnswer(bases, readOne, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const b of bases) {
    const left = deadline - Date.now();
    if (left <= 50) break;
    const { url, headers } = entryOf(b);
    if (!url) continue;
    try {
      const v = await readOne(String(url).replace(/\/+$/, ""), { headers, timeoutMs: left });
      if (typeof v === "bigint" && v >= 0n) return v;
    } catch { /* the next base */ }
  }
  return null;
}

async function tempoBalance({ payer, asset }, timeoutMs) {
  const url = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
  const data = "0x70a08231" + payer.slice(2).toLowerCase().padStart(64, "0");
  return firstAnswer([url], async (u, o) => {
    const hex = await postRpc(u, "eth_call", [{ to: asset, data }, "latest"], o);
    return typeof hex === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(hex) ? BigInt(hex) : null;
  }, timeoutMs);
}
const SVM_OWNER_ACCOUNTS_MAX = 64;
async function svmBalance({ payer, asset, byOwner, source }, timeoutMs) {
  const { SOLANA_RPCS } = await import("./solana-history-rpc.js");
  if (byOwner === true) {
    return firstAnswer(SOLANA_RPCS, async (u, o) => {
      const r = await postRpc(u, "getTokenAccountsByOwner", [payer, { mint: asset }, { encoding: "jsonParsed" }], o);
      const list = r?.value;
      if (!Array.isArray(list) || list.length > SVM_OWNER_ACCOUNTS_MAX) return null;
      let sum = 0n, sourceIn = false;
      for (const e of list) {
        const info = e?.account?.data?.parsed?.info;
        const amt = info?.tokenAmount?.amount;
        if (info?.mint !== asset || typeof amt !== "string" || !UINT.test(amt)) return null;
        if (typeof source === "string" && e?.pubkey === source) sourceIn = true;
        sum += BigInt(amt);
      }
      // A static source that is not the wallet's own (a delegate's
      // transfer): what moves is that account's balance, so it is added.
      if (typeof source === "string" && source && !sourceIn) {
        const b = await postRpc(u, "getTokenAccountBalance", [source], o);
        const amt = b?.value?.amount;
        if (typeof amt !== "string" || !UINT.test(amt)) return null;
        return sum + BigInt(amt);
      }
      if (!list.length) return null;
      return sum;
    }, timeoutMs);
  }
  return firstAnswer(SOLANA_RPCS, async (u, o) => {
    const r = await postRpc(u, "getTokenAccountBalance", [payer], o);
    const amt = r?.value?.amount;
    return typeof amt === "string" && UINT.test(amt) ? BigInt(amt) : null;
  }, timeoutMs);
}
async function avmBalance({ payer, asset }, timeoutMs) {
  const { ALGORAND_ALGOD_BASES } = await import("./revenue-live.js");
  return firstAnswer(ALGORAND_ALGOD_BASES, async (u, o) => {
    const j = await getJson(`${u}/v2/accounts/${encodeURIComponent(payer)}/assets/${encodeURIComponent(asset)}`, o);
    const amt = j?.["asset-holding"]?.amount;
    return typeof amt === "number" || typeof amt === "string" || typeof amt === "bigint" ? (UINT.test(String(amt)) ? BigInt(String(amt)) : null) : null;
  }, timeoutMs);
}
/** A Horizon decimal balance ("12.3400000") in 7-decimal base units, or null. */
export function stellarAtomic(text) {
  const m = /^(\d{1,20})(?:\.(\d{1,7}))?$/.exec(String(text ?? ""));
  return m ? BigInt(m[1]) * 10_000_000n + BigInt((m[2] || "").padEnd(7, "0")) : null;
}
async function stellarBalance({ payer, asset }, timeoutMs) {
  if (!/^G[A-Z2-7]{55}$/.test(payer)) return null;
  const { STELLAR_HORIZON_URLS } = await import("./revenue-live.js");
  const first = String(process.env.STELLAR_HORIZON_URL || "").trim();
  const bases = [...(first ? [first] : []), ...STELLAR_HORIZON_URLS.filter((u) => u !== first.replace(/\/+$/, ""))];
  const sdk = await import("@stellar/stellar-sdk");
  return firstAnswer(bases, async (u, o) => {
    const j = await getJson(`${u}/accounts/${encodeURIComponent(payer)}`, o);
    if (!j || !Array.isArray(j.balances)) return null;
    for (const b of j.balances) {
      if (!b || typeof b.asset_code !== "string" || typeof b.asset_issuer !== "string") continue;
      let id = null;
      try { id = new sdk.Asset(b.asset_code, b.asset_issuer).contractId(sdk.Networks.PUBLIC); } catch { id = null; }
      if (id === asset) return stellarAtomic(b.balance);
    }
    return null; // the account answered and names no such holding: unknown, never zero
  }, timeoutMs);
}

// The signer's available USDC inside Circle Gateway on the paying network's
// domain (POST /v1/balances, readable by address): what a batched payment is
// paid from. `client` is a test seam.
let gatewayClientForTest = null;
export function _setGatewayBalanceClientForTest(c) { gatewayClientForTest = c || null; }
async function gatewayBalance({ payer, network }, timeoutMs) {
  const g = await import("./gateway-nanopayments.js");
  const domain = g.GATEWAY_DOMAINS[network];
  if (!Number.isInteger(domain)) return null;
  const client = gatewayClientForTest || new g.GatewayNanopaymentsClient({ networks: [] });
  const read = client.balances({ depositor: payer, domains: [domain] }).then((b) => {
    const usd = Number(b?.byDomain?.[String(domain)]);
    return Number.isFinite(usd) && usd >= 0 ? BigInt(Math.round(usd * 1e6)) : null;
  }, () => null);
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try { return await Promise.race([read, late]); } finally { clearTimeout(timer); }
}

/** The payer's balance of the paying asset on a non-EVM-exact rail, in base
 *  units, or null when it cannot be read in time. Never throws. */
export async function readRailBalance(terms, { timeoutMs = RAIL_READ_TIMEOUT_MS } = {}) {
  try {
    if (terms?.rail === "tempo") return await tempoBalance(terms, timeoutMs);
    if (terms?.rail === "svm") return await svmBalance(terms, timeoutMs);
    if (terms?.rail === "avm") return await avmBalance(terms, timeoutMs);
    if (terms?.rail === "stellar") return await stellarBalance(terms, timeoutMs);
    if (terms?.rail === "gateway") return await gatewayBalance(terms, timeoutMs);
  } catch { /* unknown */ }
  return null;
}
