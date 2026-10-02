#!/usr/bin/env node
// Buy ONE call from many x402 sellers and grade each answer against what that
// seller's own 402 promised. Dispatch-only, never in CI: it spends real USDC.
//
// Why this exists. Every index in this ecosystem - ours included - publishes
// what sellers CLAIM: crawled manifests, advertised prices, declared chains,
// settlement counts read off a chain. Measured on 2026-09-11/12 that layer is
// unreliable in ways no document reader can see: one seller ranked #1 for its
// task had answered HTTP 500 after payment for eleven days; 18 origins
// advertise a USDC accept no stock client can sign; a leaderboard's top row was
// a gateway wallet with sixteen vendors behind it. All four are invisible to a
// crawler and obvious to someone who pays.
//
// So: pay, then grade. The grading half matters as much as the paying half,
// because a seller that takes $0.02 and returns `{}` passes every payability
// check ever written - a shape this repo shipped four times in its own catalog
// before it started checking answers against documented examples.
//
//   BURNER_KEY=0x... SWEEP_LIMIT=50 SWEEP_MAX_USD=0.02 SWEEP_TOTAL_USD=1.50 \
//   SWEEP_LIVE=true node scripts/seller-sweep.mjs
//
// DRY BY DEFAULT. Without SWEEP_LIVE=true it resolves candidates, reads every
// bare 402 and reports what it WOULD spend, paying nothing.
// Runs OUT OF TREE (copied to a temp dir by its workflow), so no import from src/:
// the vendor client default since @x402/core 2.23 is a $1 pegged-assets cap and
// this script bounds spend itself; the same line src/x402-spend-controls.js wraps.
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { readOutputContract, verdictFor, acceptFilterFor, VERDICTS } from "./seller-verify-core.mjs";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const LIVE = String(process.env.SWEEP_LIVE || "").toLowerCase() === "true";
const LIMIT = Math.max(1, Math.min(3000, Number(process.env.SWEEP_LIMIT) || 50));
const OFFSET = Math.max(0, Number(process.env.SWEEP_OFFSET) || 0); // shard a long sweep without re-paying earlier sellers
const MAX_USD = Number(process.env.SWEEP_MAX_USD || 0.02);
const TOTAL_USD = Number(process.env.SWEEP_TOTAL_USD || 1.5);
const PACE_MS = Math.max(0, Number(process.env.SWEEP_PACE_MS) || 400);
const OUT = process.env.SWEEP_OUT || "sweep.json";

// Every bound is validated before anything is signed, and a malformed value
// REFUSES rather than falling back to a default - the money-safety rule this
// repo already applies to the refund runner and the external buy script.
for (const [k, v] of [["SWEEP_MAX_USD", MAX_USD], ["SWEEP_TOTAL_USD", TOTAL_USD]]) {
  if (!(Number.isFinite(v) && v > 0)) { console.error(`${k} must be a positive number, got ${JSON.stringify(process.env[k])}; not spending`); process.exit(2); }
}
if (MAX_USD > 0.10) { console.error(`SWEEP_MAX_USD ${MAX_USD} is above the $0.10 ceiling this script will sign for; refusing`); process.exit(2); }
if (TOTAL_USD > 25) { console.error(`SWEEP_TOTAL_USD ${TOTAL_USD} is above the $25 ceiling this script will spend in one run; refusing`); process.exit(2); }
const maxAtomic = BigInt(Math.round(MAX_USD * 1e6));

// --- candidates: from OUR OWN index, cheapest priced Base route per origin ---
const ourHost = (() => { try { return new URL(TARGET).host.toLowerCase(); } catch { return ""; } })();
const sellers = [];
// Page until the SERVER says there are no more, never a hard page count: this
// loop used to stop at 40 pages of 100 and silently missed every seller past
// 4,000 (there are 4,473). It also passed `perPage`, which the handler did not
// read, so it got the 100 default by luck rather than by asking.
for (let p = 0; ; p++) {
  const r = await fetch(`${TARGET}/api/index?page=${p}&limit=250`, { signal: AbortSignal.timeout(60_000) });
  const d = await r.json();
  const s = d.sellers || [];
  sellers.push(...s);
  if (!s.length || d.complete || p >= (d.lastPage ?? 0)) break;
}
// Route rows live on the seller DETAIL projection, not the list page, so
// candidates are chosen in two stages: page the list for routable Base
// origins, then read detail until LIMIT of them yield a callable route.
//
// The contract we grade against comes from the SAME projection:
// `responseContract.guaranteedPaths`, which our crawler already extracts from
// each seller's own OpenAPI, beside a `runtimeVerified` flag that has read
// false on every row since it shipped - because nothing had ever paid a seller
// to find out. That flag names this job.
const origins = [];
for (const s of sellers) {
  if (!s.routable || s.origin === "self") continue;
  let host = ""; try { host = new URL(s.origin).host.toLowerCase(); } catch { continue; }
  if (host === ourHost) continue; // never pay ourselves
  if (!(s.networks || []).some((n) => String(n).includes("8453"))) continue;
  origins.push(s.origin);
}
console.log(`${origins.length} routable Base origins; reading detail until ${OFFSET + LIMIT} callable routes (offset ${OFFSET})`);
const cheapest = new Map();
let looked = 0, noInput = 0;
for (const origin of origins) {
  if (cheapest.size >= OFFSET + LIMIT) break;
  looked++;
  let d = null;
  try {
    const r = await fetch(`${TARGET}/api/index?seller=${encodeURIComponent(origin)}`, { signal: AbortSignal.timeout(20_000) });
    d = await r.json();
  } catch { continue; }
  for (const t of d?.tools || []) {
    const price = Number(t.price ?? t.priceUsd);
    if (!t.paid || !Number.isFinite(price) || price <= 0 || price > MAX_USD) continue;
    if (/[{}]/.test(String(t.route || ""))) continue; // an unsubstituted template is not a callable route
    // THE INPUT IS THE SELLER'S OWN OR WE DO NOT CALL. A seller whose request
    // contract names required fields and publishes no example cannot be swept:
    // a body we invented failing is a fact about our guess, not about them.
    const required = t?.requestContract?.required?.body;
    const example = t?.discovery?.input ?? t?.discovery?.example ?? t?.example ?? null;
    const usable = (t.method || "POST").toUpperCase() === "GET" || !Array.isArray(required) || !required.length || (example && typeof example === "object");
    if (!usable) { noInput++; continue; }
    const prev = cheapest.get(origin);
    if (prev && prev.price <= price) continue;
    cheapest.set(origin, { origin, route: t.route, method: (t.method || "POST").toUpperCase(), price,
      input: example && typeof example === "object" ? example : null,
      guaranteedPaths: Array.isArray(t?.responseContract?.guaranteedPaths) ? t.responseContract.guaranteedPaths : null });
  }
}
console.log(`  read ${looked} seller records, ${cheapest.size} callable, ${noInput} skipped for publishing required inputs with no example`);
const candidates = [...cheapest.values()].sort((a, b) => a.price - b.price).slice(OFFSET, OFFSET + LIMIT);
console.log(`${LIVE ? "LIVE" : "DRY RUN"}: ${candidates.length} candidates, per-seller cap $${MAX_USD}, run cap $${TOTAL_USD}`);
if (!candidates.length) { console.error("no candidates - is the index reachable?"); process.exit(1); }

// A FRESH CLIENT PER SELLER. registerPolicy accumulates on the client, so a
// policy registered per seller on one shared client leaves every previous
// seller's payee in force too - and no accept is paid to two addresses. The
// first live run failed 44 of 45 sellers exactly that way. Building the client
// inside the loop gives the policy nowhere to pile up.
let newClient = null, wrapFetchWithPayment = null, account = null;
if (LIVE) {
  const pk = (process.env.BURNER_KEY || "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) { console.error("SWEEP_LIVE=true needs a BURNER_KEY"); process.exit(2); }
  account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const fetchMod = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  wrapFetchWithPayment = fetchMod.wrapFetchWithPayment;
  newClient = () => { const c = new fetchMod.x402Client(); c.setSpendControls?.(false); registerExactEvmScheme(c, { signer: account, networks: ["eip155:8453"] }); return c; };
  console.log(`paying from ${account.address}`);
}

const rows = [];
let spent = 0;
// WRITE AFTER EVERY SELLER. The full sweep is ~2,244 sellers and ~3 hours; a
// single write at the end means a timeout, a runner eviction or an unhandled
// throw discards every verdict the run already PAID FOR. Money spent and
// nothing learned is the worst outcome available here, and it was one line away.
const persist = () => {
  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), live: LIVE, offset: OFFSET,
    capUsd: MAX_USD, totalCapUsd: TOTAL_USD, spentUsd: Number(spent.toFixed(6)),
    swept: rows.length, complete: rows.length >= candidates.length, verdicts: VERDICTS, tally, rows }, null, 2));
};
for (const c of candidates) {
  const url = c.origin.replace(/\/+$/, "") + c.route;
  const row = { origin: c.origin, route: c.route, method: c.method, listedUsd: c.price };
  const headers = { Accept: "application/json", ...(c.method === "GET" ? {} : { "Content-Type": "application/json" }) };
  // The seller's OWN documented input when it publishes one, else an empty
  // object. Never anything of our choosing: a body we invented failing is a
  // fact about our guess, not about the seller.
  const body = c.method === "GET" ? undefined : JSON.stringify(c.input && typeof c.input === "object" ? c.input : {});
  try {
    const bare = await fetch(url, { method: c.method, headers, body, signal: AbortSignal.timeout(12_000), redirect: "manual" });
    row.bareStatus = bare.status;
    const hdr = bare.headers.get("payment-required");
    let challenge = null;
    if (bare.status === 402 && hdr) { try { challenge = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); } catch { /* unreadable */ } }
    const accepts = challenge?.accepts || [];
    const baseAccept = accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact") || null;
    const quoteUsd = baseAccept ? Number(baseAccept.amount) / 1e6 : null;
    // The seller's OpenAPI contract our crawler already holds, else whatever
    // their live 402 declares. Both are the seller's own words about their
    // own output; neither is anything we chose.
    const contract = (c.guaranteedPaths && c.guaranteedPaths.length)
      ? { kind: "paths", value: c.guaranteedPaths }
      : readOutputContract(challenge);
    row.quotedUsd = quoteUsd;
    row.declares = contract ? contract.kind : null;
    row.guaranteedPaths = c.guaranteedPaths ? c.guaranteedPaths.length : 0;

    if (!challenge || !baseAccept || !(quoteUsd <= MAX_USD)) {
      Object.assign(row, verdictFor({ challengeReadable: !!challenge, baseAccept, quoteUsd, capUsd: MAX_USD, settled: false }));
      rows.push(row); persist(); continue;
    }
    if (!LIVE) { row.verdict = "would_pay"; rows.push(row); persist(); continue; }
    // THE RUN CAP IS CHECKED BEFORE EVERY BUY, against the amount about to be
    // signed - not after, and not once at the start.
    if (spent + quoteUsd > TOTAL_USD) { row.verdict = "run_cap_reached"; rows.push(row); persist(); console.log(`run cap $${TOTAL_USD} reached after $${spent.toFixed(4)}; stopping`); break; }

    const client = newClient(); // fresh: policies accumulate, see acceptFilterFor
    const keep = acceptFilterFor({ payTo: baseAccept.payTo, maxAtomic });
    client.registerPolicy((_v, reqs) => reqs.filter(keep));
    let receipt = null;
    const payFetch = wrapFetchWithPayment(async (i, init) => {
      const res = await fetch(i, init);
      const rh = res.headers.get("payment-response");
      if (rh) { try { receipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8")); } catch { /* keep null */ } }
      return res;
    }, client);
    const t0 = Date.now();
    let paid = null, text = "";
    try { paid = await payFetch(url, { method: c.method, headers, body, signal: AbortSignal.timeout(45_000) }); text = await paid.text(); }
    catch (e) { row.error = String(e?.message || e).slice(0, 120); }
    row.ms = Date.now() - t0;
    row.paidStatus = paid?.status ?? null;
    row.settlementTx = receipt?.transaction || null;
    const settled = !!(receipt && receipt.success !== false && paid && paid.status === 200);
    if (settled) spent += quoteUsd;
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    Object.assign(row, verdictFor({ challengeReadable: true, baseAccept, quoteUsd, capUsd: MAX_USD, settled, status: paid?.status ?? null, body: parsed, contract }));
    // Never keep a stranger's response body: it is their content, and the
    // verdict is the product. Only its SHAPE leaves this loop.
    row.bodyKeys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 20) : null;
  } catch (e) {
    row.verdict = "unreachable"; row.error = String(e?.message || e).slice(0, 120);
  }
  rows.push(row);
  persist();
  console.log(`  ${String(row.verdict).padEnd(16)} $${String(row.quotedUsd ?? "-").padEnd(7)} ${row.origin.slice(0, 44)}`);
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
}

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log(`\nspent $${spent.toFixed(4)} of $${TOTAL_USD} across ${rows.length} sellers`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}${VERDICTS[k] ? "" : ""}`);
persist();
console.log(`\nwrote ${OUT}`);

// Hand the result to the server, which keeps it as a dated object beside the
// daily dataset. Without this the artifact expires with the Actions run and
// the money spent produces nothing durable - which is what happened to the
// first three sweeps. Best-effort on purpose: a failed handoff must never fail
// a run that already paid, and the artifact is still attached either way.
if (LIVE && process.env.AGENT402_OPERATOR_TOKEN) {
  try {
    const body = JSON.stringify({ spentUsd: spent, capUsd: MAX_USD, rows });
    const r = await fetch(`${TARGET}/__operator/seller-verification`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AGENT402_OPERATOR_TOKEN}` },
      body, signal: AbortSignal.timeout(60_000),
    });
    console.log(r.ok ? `recorded to the dataset: ${JSON.stringify(await r.json())}` : `dataset handoff refused: HTTP ${r.status}`);
  } catch (e) {
    console.log(`dataset handoff failed (the artifact still has everything): ${String(e?.message || e).slice(0, 120)}`);
  }
}
