// What a verified payment on a rail other than the x402 EVM exact wire draws
// on, and how much of it the payer holds: the terms and balance reads the
// in-flight coverage check (src/inflight-cover.js) needs for a Tempo pull
// credential and for a Solana, Algorand or Stellar x402 payment.
//
// TERMS. { rail, payer, network, asset, atomic }: the account the payment
// draws on, the token, and the base units it moves. Read only after the gate
// verified the payment:
//   - Tempo pull: the sender the gate VERIFIED (the signature or the chain
//     proved it; never the credential's client-written source), the
//     challenge's currency and amount (src/mpp-tempo.js sets them on the
//     request). A push credential is final before the handler and has none.
//   - Solana: the SOURCE token account of the transfer (the balance that
//     moves is that account's, whoever its authority is), the mint, and the
//     accept's amount.
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
//   - Solana: getTokenAccountBalance of the source account (SOLANA_RPCS).
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
import { svmTransferAccounts, isSvmNetwork } from "./svm-payer.js";

const UINT = /^\d{1,39}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const RAIL_READ_TIMEOUT_MS = 2_500;

/** The verified Tempo pull payment on this request, or null. */
export function tempoCoverTermsOf(req) {
  const t = req && typeof req === "object" && req.tempoSettling === true ? req.mppTempoPull : null;
  if (!t || typeof t !== "object") return null;
  const payer = String(t.sender || ""), asset = String(t.currency || ""), amount = String(t.amountAtomic ?? "");
  if (!HEX_ADDR.test(payer) || !HEX_ADDR.test(asset) || !UINT.test(amount)) return null;
  return { rail: "tempo", payer: payer.toLowerCase(), network: "tempo", asset: asset.toLowerCase(), atomic: BigInt(amount) };
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
    const t = svmTransferAccounts(p?.payload?.transaction ?? p?.transaction);
    if (!t || t.mint !== asset) return null;
    // `owner`: the wallet (the transfer's authority), which the paid record is kept under.
    return { rail: "svm", payer: t.source, owner: t.authority, network, asset, atomic };
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
async function svmBalance({ payer }, timeoutMs) {
  const { SOLANA_RPCS } = await import("./solana-history-rpc.js");
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
