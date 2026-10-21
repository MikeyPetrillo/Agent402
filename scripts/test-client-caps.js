// Locks the agent402-client spending-cap fixes (offline, mocks catalog + fetch):
//  - concurrency: reservations are taken synchronously so N concurrent calls
//    can't collectively blow a rolling cap (was a TOCTOU);
//  - a non-settling call releases its reservation;
//  - 402-inspection: the cap is checked against the price the 402 actually quotes,
//    not just the seller-advertised catalog price, with fail-open on a parse miss.
import { Agent402, SpendingLimitError } from "../client/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const okResp = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });

const mkClient = (opts) => {
  // fetch = payFetch (paid path); fetchImpl = the plain fetch used for the unpaid
  // preflight. Both stubbed so nothing touches the network.
  const a = new Agent402({ baseUrl: "http://mock.local", fetch: okResp, fetchImpl: okResp, ...opts });
  a._loadCatalog = async () => new Map([["t", { slug: "t", path: "/api/t", method: "GET", price: "$0.01", computePayable: false }]]);
  return a;
};

// 1. Concurrency: 20 concurrent $0.01 calls under a $0.05 cap → at most 5 settle.
{
  const a = mkClient({ dailyLimitUsd: 0.05 });
  const res = await Promise.allSettled(Array.from({ length: 20 }, () => a.call("t", {}, { cache: false })));
  const settled = res.filter((r) => r.status === "fulfilled").length;
  const refused = res.filter((r) => r.status === "rejected" && r.reason?.name === "SpendingLimitError").length;
  ok(settled <= 5, `at most 5 of 20 concurrent calls settle under a $0.05 cap (got ${settled})`);
  ok(a.spendingSummary().dailyUsd <= 0.05 + 1e-9, `settled spend never exceeds the cap ($${a.spendingSummary().dailyUsd})`);
  ok(settled + refused === 20, `every call settled or was refused, none lost (${settled}+${refused})`);
}

// 2. A failed (502) paid call releases its reservation — $0 consumed.
{
  const a = mkClient({ dailyLimitUsd: 0.05 });
  a.payFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  let threw = false;
  try { await a.call("t", {}, { cache: false }); } catch { threw = true; }
  ok(threw && a.spendingSummary().dailyUsd === 0, "a failed (502) paid call releases its reservation — $0 consumed");
}

// 3. 402-inspection: catalog advertises $0.01 but the 402 quotes 1000 USDC → refused.
{
  const a = mkClient({ maxPerCallUsd: 0.05 });
  // A real accept: Base USDC from the known-asset table, so the cap prices it.
  a.f = async () => ({ status: 402, json: async () => ({ accepts: [{ network: "eip155:8453", maxAmountRequired: "1000000000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { decimals: 6 } }] }) });
  a.payFetch = async () => ({ ok: true, json: async () => ({}) }); // must NOT be reached
  let err = null;
  try { await a.call("t", {}, { cache: false }); } catch (e) { err = e; }
  ok(err?.name === "SpendingLimitError", `a 402 quoting $1000 is refused despite a $0.01 catalog price (got ${err?.name})`);
  ok(err?.priceUsd >= 1000, `the cap saw the real 402 amount, not the advertised price (priceUsd=${err?.priceUsd})`);
  ok(a.spendingSummary().dailyUsd === 0, "nothing was signed for the refused hostile call");
}

// 3b. An accept naming an asset outside the known-asset table has no price: it
//     is refused, never priced from the seller's own decimals.
{
  const a = mkClient({ maxPerCallUsd: 0.05 });
  a.f = async () => ({ status: 402, json: async () => ({ accepts: [{ maxAmountRequired: "1000", asset: "USDC", extra: { decimals: 6 } }] }) });
  let reached = false;
  a.payFetch = async () => { reached = true; return { ok: true, json: async () => ({}) }; };
  let err = null;
  try { await a.call("t", {}, { cache: false }); } catch (e) { err = e; }
  ok(err?.name === "SpendingLimitError" && err?.limit === "knownAsset", `an unknown asset is refused (got ${err?.name}/${err?.limit})`);
  ok(err?.priceUsd == null, `an unknown asset carries no price (priceUsd=${err?.priceUsd})`);
  ok(!reached && a.spendingSummary().dailyUsd === 0, "nothing was signed for the unknown-asset call");
}

// 4. Fail-open: a non-402 preflight (e.g. FREE_MODE) falls back to the advertised
//    price and the call proceeds — a parse miss never blocks a legit payment.
{
  const a = mkClient({ maxPerCallUsd: 0.05 });
  const r = await a.call("t", {}, { cache: false }); // preflight returns 200 → fall back to $0.01
  ok(r && r.ok === 1, "fail-open: a non-402 preflight uses the advertised price and the call proceeds");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
