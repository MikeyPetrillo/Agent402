// Daily MPP reconciliation (src/mpp-reconcile.js) - offline.
//
// Stub chain feed + in-memory ledger rows, one case per mismatch category,
// then the things that make a reconciliation trustworthy rather than merely
// present: an unreadable chain is `unknown` (never `ok`), a partial read never
// asserts served_unpaid, day boundaries are soft, a rerun is idempotent, no
// payer address reaches any output, the public status carries words only, and
// the operator routes are operator-only on a booted server.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import {
  reconcileRecords, statusWordFor, createMppReconciler, fetchTransfersFromFeed, fetchTransfersFromRpc,
  CATEGORIES, MISMATCH_CATEGORIES, dayStartMs,
} from "../src/mpp-reconcile.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const DAY = "2026-09-20";
const START = dayStartMs(DAY), END = START + 86_400_000;
const at = (h, m = 0) => START + h * 3600e3 + m * 60e3;
const USDCE = "0x20c000000000000000000000b9537d11c60e8b50";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const OTHER_TOKEN = "0x20c0000000000000000000000000000000000abc";
const RECIPIENT = "0x" + "ab".repeat(20);
const PAYER = "0x" + "cd".repeat(20);            // must never appear in any output
const BURNER = "0x" + "ee".repeat(20);
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const atomic = (usd) => String(Math.round(usd * 1e6));

const row = (id, o) => ({ id, ts: at(10), slug: "uuid", priceUsd: 0.001, quoteUsd: null, rail: "usdc", network: "tempo", payer: PAYER, tx: h(id), internal: false, wire: "mpp-tempo", ...o });
const xfer = (id, o) => ({ tx: h(id), token: USDCE, amountAtomic: atomic(0.001), decimals: 6, ts: at(10), recipient: RECIPIENT, sender: PAYER, ...o });

// --- one fixture that trips every category ----------------------------------
const ledgerRows = [
  row(1),                                                       // clean match
  row(2),                                                       // served_unpaid (no transfer)
  row(4, { priceUsd: 0.01 }),                                   // amount_mismatch (underpaid)
  row(5),                                                       // amount_mismatch (overpaid)
  row(6),                                                       // wrong_currency
  row(7), row(7, { id: 70 }),                                   // duplicate_tx
  row(8, { tx: null }),                                         // missing_tx
  row(9, { wire: "mpp", network: "eip155:8453" }),              // evm_unverified
  row(10, { wire: "mpp", network: "eip155:8453" }),             // evm verified
  row(11, { wire: "mpp-stripe", network: "stripe", tx: "pi_bad", priceUsd: 0.5 }),   // stripe_mismatch
  row(12, { wire: "mpp-stripe", network: "stripe", tx: "pi_good", priceUsd: 0.5 }),
  row(13, { internal: true }),                                  // internal served_unpaid
  row(14, { ts: END - 60_000 }),                                // booked 23:59, transfer lands 00:01 next day
  row(15, { priceUsd: 0.001, quoteUsd: 0.004 }),                // metered quote: paid the quote, tolerated
];
const transfers = { complete: true, source: "feed", rows: [
  xfer(1),
  xfer(3),                                                      // paid_unrecorded
  xfer(4, { amountAtomic: atomic(0.001) }),
  xfer(5, { amountAtomic: atomic(0.5) }),
  xfer(6, { token: OTHER_TOKEN }),
  xfer(7),
  xfer(20, { amountAtomic: atomic(50) }),                       // non_payment_transfer (informational)
  xfer(24, { amountAtomic: "1" }),                              // one base unit: below any price, informational
  xfer(25, { amountAtomic: atomic(0.001) }),                    // exactly the floor: still a lost sale
  xfer(21, { sender: BURNER }),                                 // paid_unrecorded, internal by sender
  xfer(22),                                                     // explained by a refund -> charged_failed only
  xfer(14, { ts: END + 60_000 }),
  xfer(15, { amountAtomic: atomic(0.004) }),
  xfer(99, { ts: START - 30 * 60_000 }),                        // previous day, outside the reported day
] };
const refunds = [
  { id: 1, evidence: h(22), slug: "hash", network: "tempo", priceUsd: 0.001, httpStatus: 500, synthetic: 0, status: "owed", createdAt: at(11), wire: "mpp-tempo" },
  { id: 2, evidence: h(23), slug: "hash", network: "eip155:8453", priceUsd: 0.001, httpStatus: 502, synthetic: 0, status: "owed", createdAt: at(11), wire: "x402" }, // not MPP: ignored
];
const evmChecks = new Map([[h(9), { checked: true, verified: false, reason: "transaction did not succeed on chain (status 0x0)" }], [h(10), { checked: true, verified: true }]]);
const stripeChecks = { configured: true, results: new Map([["pi_bad", { status: "requires_payment_method", amountCents: 0 }], ["pi_good", { status: "succeeded", amountCents: 50 }]]) };

const sum = reconcileRecords({ start: START, end: END, ledgerRows, transfers, refunds, evmChecks, stripeChecks, currencies: [USDCE, PATHUSD], isOwnWallet: (a) => a === BURNER });
const n = (k) => sum.counts[k].total;
const has = (k, id) => sum.mismatches.some((m) => m.category === k && String(m.tx).toLowerCase() === h(id));

ok(has("served_unpaid", 2), "served_unpaid: a Tempo ledger row whose tx never reached our recipient");
ok(has("paid_unrecorded", 3), "paid_unrecorded: a transfer to our recipient with no ledger row");
ok(has("charged_failed", 22) && !has("paid_unrecorded", 22), "charged_failed: a refund-ledger debt explains its transfer (not double-reported as paid_unrecorded)");
ok(n("charged_failed") === 1, "a non-MPP (x402) refund row is not counted as an MPP charged-failure");
ok(sum.mismatches.some((m) => m.category === "amount_mismatch" && m.tx === h(4) && /underpaid/.test(m.explanation)), "amount_mismatch: underpaid against the booked price");
ok(sum.mismatches.some((m) => m.category === "amount_mismatch" && m.tx === h(5) && /overpaid/.test(m.explanation)), "amount_mismatch: overpaid beyond the tolerance");
ok(!has("amount_mismatch", 15), "a metered row paid at its quote is inside the tolerance");
ok(has("wrong_currency", 6), "wrong_currency: paid in a token we do not offer");
ok(has("duplicate_tx", 7) && n("duplicate_tx") === 1, "duplicate_tx: one hash on two ledger rows, reported once");
ok(sum.mismatches.some((m) => m.category === "missing_tx" && m.tx === null), "missing_tx: an MPP row with no settlement reference");
ok(has("evm_unverified", 9) && !has("evm_unverified", 10), "evm_unverified: only the evm row the chain disagrees with");
ok(sum.mismatches.some((m) => m.category === "stripe_mismatch" && m.tx === "pi_bad") && !sum.mismatches.some((m) => m.tx === "pi_good"), "stripe_mismatch: a PaymentIntent that did not succeed");
ok(sum.info.some((m) => m.category === "non_payment_transfer" && m.tx === h(20)) && !sum.mismatches.some((m) => m.tx === h(20)), "a large unmatched transfer is informational, never a mismatch");
ok(sum.info.some((m) => m.category === "non_payment_transfer" && m.tx === h(24) && /smallest price/.test(m.explanation)) && !sum.mismatches.some((m) => m.tx === h(24)), "a transfer below the smallest price (2026-09-28's one base unit) is informational, never a lost sale");
ok(has("paid_unrecorded", 25), "a transfer of exactly the smallest price is still a paid-but-unrecorded sale");
ok(!has("served_unpaid", 14) && !has("paid_unrecorded", 14), "soft day boundary: booked 23:59, landed 00:01 matches");
ok(!sum.mismatches.some((m) => m.tx === h(99)), "a transfer from another day is not reported in this day");
ok(sum.counts.served_unpaid.internal === 1 && sum.counts.served_unpaid.external === 1, "internal/external split on ledger rows");
ok(sum.mismatches.some((m) => m.tx === h(21) && m.side === "internal") && sum.mismatches.some((m) => m.tx === h(3) && m.side === "unattributed"), "chain-only transfers: internal when the sender is ours, otherwise unattributed");
ok(CATEGORIES.every((k) => k === "charged_failed" || n(k) >= 1), "every mismatch category is exercised by the fixture");
ok(sum.mismatchTotal === MISMATCH_CATEGORIES.reduce((a, k) => a + n(k), 0) && !MISMATCH_CATEGORIES.includes("charged_failed"), "charged_failed is itemized but does not by itself make a mismatch (its own alarm)");
ok(!JSON.stringify(sum).toLowerCase().includes(PAYER.slice(2)), "no payer address anywhere in the summary");
ok(statusWordFor({ ...sum, tempoConfigured: true }) === "mismatch", "status word: mismatch");

// --- clean day, unreadable chain, partial chain -----------------------------
const clean = reconcileRecords({ start: START, end: END, ledgerRows: [row(1)], transfers: { complete: true, source: "rpc", rows: [xfer(1)] }, currencies: [USDCE] });
ok(clean.mismatchTotal === 0 && statusWordFor({ ...clean, tempoConfigured: true }) === "ok", "clean day reads ok");
const blind = reconcileRecords({ start: START, end: END, ledgerRows: [row(1)], transfers: { complete: false, source: "rpc", rows: [], error: "unreadable" } });
ok(blind.mismatchTotal === 0 && statusWordFor({ ...blind, tempoConfigured: true }) === "unknown", "an unreadable chain is unknown, never ok");
ok(statusWordFor({ ...clean, tempoConfigured: true, sources: { chain: null } }) === "unknown", "no chain source at all is unknown");
const partial = reconcileRecords({ start: START, end: END, ledgerRows: [row(1), row(2)], transfers: { complete: false, source: "feed", rows: [xfer(1)] } });
ok(!partial.mismatches.some((m) => m.category === "served_unpaid"), "a partial chain read never asserts served_unpaid");
const blindButDup = reconcileRecords({ start: START, end: END, ledgerRows: [row(7), row(7, { id: 71 })], transfers: null });
ok(statusWordFor({ ...blindButDup, tempoConfigured: true }) === "mismatch", "ledger-internal checks still say mismatch when the chain is unreadable");
ok(statusWordFor({ ...clean, sources: { chain: { complete: false } }, tempoConfigured: false }) === "ok", "no Tempo recipient configured: nothing to read, the leg is not unknown");
ok(statusWordFor(null) === "unknown", "never run is unknown");
const noStripe = reconcileRecords({ start: START, end: END, ledgerRows: [row(11, { wire: "mpp-stripe", tx: "pi_x" })], transfers: { complete: true, rows: [] } });
ok(noStripe.sources.stripe.checked === false && /not checked/.test(noStripe.sources.stripe.reason) && noStripe.counts.stripe_mismatch.total === 0, "no Stripe key: 'not checked', never a failure");

// --- the reconciler: idempotence, persistence, status views -----------------
const dir = mkdtempSync(join(tmpdir(), "mpp-rec-"));
const file = join(dir, "state.json");
let chainReads = 0;
const mkRec = (overrides = {}) => createMppReconciler({
  file, log: () => {}, now: () => END + 5 * 3600e3,
  ledgerRows: (a, b) => ledgerRows.filter((r) => r.ts >= a && r.ts < b),
  refunds: (a, b) => refunds.filter((r) => r.createdAt >= a && r.createdAt < b),
  recipients: () => [RECIPIENT], currencies: () => [USDCE, PATHUSD], isOwnWallet: (a) => a === BURNER,
  fetchTransfers: async () => { chainReads++; return transfers; },
  verifyEvm: async (r) => evmChecks.get(String(r.tx).toLowerCase()) || { checked: false },
  stripeLookup: async (pi) => stripeChecks.results.get(pi),
  ...overrides,
});
const rec = mkRec();
const r1 = await rec.runOnce();
ok(r1.ok && r1.day === DAY, "runOnce reconciles the PREVIOUS UTC day by default");
ok(chainReads === 1, "one chain read covers the day and the 7-day window");
const snap1 = JSON.stringify(r1.summary.counts);
const r2 = await rec.runOnce();
ok(JSON.stringify(r2.summary.counts) === snap1 && Object.keys(rec._state().days).length === 1, "idempotent: a rerun replaces the day with the same answer, nothing accumulates");
const [c1, c2] = await Promise.all([rec.runOnce(), rec.runOnce()]);
ok(c1 === c2, "concurrent runs share one run");
ok(existsSync(file) && JSON.parse(readFileSync(file, "utf8")).days[DAY], "state persisted atomically to the store file");
ok(!readFileSync(file, "utf8").toLowerCase().includes(PAYER.slice(2)), "no payer address in the persisted store");
const reloaded = mkRec();
ok(reloaded._state().days[DAY]?.mismatchTotal === r1.summary.mismatchTotal, "a new process warm-starts from the store");

const pub = await rec.status({ full: false });
ok(pub.status === "mismatch" && pub.categories.served_unpaid === "mismatch" && pub.categories.missing_tx === "mismatch", "public status: words per category");
ok(pub.chargedFailedStatus === "charged_failed", "public status: charged-but-failed word from the live refund read");
const nums = []; (function walk(o, p) { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`); else if (typeof o === "number") nums.push(p); })(pub, "");
ok(nums.length === 0, `public status carries no number${nums.length ? `: ${nums.join(",")}` : ""}`);
const op = await rec.status({ full: true });
ok(op.counts.served_unpaid.total === 2 && op.chargedFailed24h.total >= 0 && typeof op.mismatches === "number", "operator status carries the counts and the split");
const d = rec.detail();
ok(Array.isArray(d.day.mismatches) && d.day.mismatches.every((m) => !("payer" in m)), "operator detail itemizes mismatches (tx, slug, amount, category) without a payer field");

const cleanFile = createMppReconciler({ file: join(dir, "clean.json"), log: () => {}, now: () => END + 3600e3, recipients: () => [RECIPIENT], currencies: () => [USDCE], ledgerRows: () => [row(1)], refunds: () => [], fetchTransfers: async () => ({ complete: true, source: "rpc", rows: [xfer(1)] }) });
await cleanFile.runOnce();
ok((await cleanFile.status()).status === "ok" && (await cleanFile.status()).chargedFailedStatus === "ok", "clean run: ok / ok");
ok((await createMppReconciler({ file: join(dir, "none.json"), log: () => {} }).status()).status === "unknown", "never run: unknown");
const staleRec = createMppReconciler({ file: join(dir, "clean.json"), log: () => {}, now: () => END + 60 * 3600e3, refunds: () => [] });
ok((await staleRec.status()).status === "unknown" && (await staleRec.status()).stale === true, "an ok older than 36h reads unknown (stale)");
const blindRec = createMppReconciler({ file: join(dir, "blind.json"), log: () => {}, now: () => END + 3600e3, recipients: () => [RECIPIENT], ledgerRows: () => [row(1)], refunds: () => [], fetchTransfers: async () => ({ complete: false, source: "rpc", rows: [], error: "unreadable" }) });
await blindRec.runOnce();
ok((await blindRec.status()).status === "unknown", "reconciler with an unreadable chain reports unknown");
const offRec = createMppReconciler({ file: join(dir, "off.json"), log: () => {}, now: () => END + 3600e3, recipients: () => [], ledgerRows: () => [], refunds: () => [], fetchTransfers: async () => { throw new Error("must not read the chain"); } });
const offRun = await offRec.runOnce();
ok(offRun.ok && (await offRec.status()).status === "ok", "Tempo not configured: no chain read, the day is ok");
process.env.MPP_RECONCILE = "off";
ok(rec.start() === null, "MPP_RECONCILE=off disarms the timer");
delete process.env.MPP_RECONCILE;

// --- chain readers ---------------------------------------------------------
{
  const page = (data, nextCursor = null) => ({ ok: true, status: 200, json: async () => ({ data, nextCursor }) });
  const t = (hash, rcpt = RECIPIENT) => ({ id: hash, transactionHash: hash, timestamp: new Date(at(10)).toISOString(), recipient: rcpt, sender: PAYER, sourceToken: { address: USDCE, decimals: 6 }, sourceAmount: { baseUnits: "1000" } });
  const urls = [];
  const f1 = await fetchTransfersFromFeed({ apiKey: "k", recipients: [RECIPIENT], fromMs: START, toMs: END, fetchImpl: async (u) => { urls.push(u); return urls.length === 1 ? page([t(h(1))], "c2") : page([t(h(2))]); } });
  ok(f1.complete && f1.rows.length === 2 && f1.rows[0].amountAtomic === "1000", "feed reader pages by cursor to the end");
  ok(/recipient=0x/.test(urls[0]) && /timestamp\.from=/.test(urls[0]) && /timestamp\.to=/.test(urls[0]) && /cursor=c2/.test(urls[1]), "feed reader filters by recipient and time window");
  let calls = 0;
  const f2 = await fetchTransfersFromFeed({ apiKey: "k", recipients: [RECIPIENT], fromMs: START, toMs: END, fetchImpl: async () => { calls++; return page([t(h(1), "0x" + "11".repeat(20))], "more"); } });
  ok(!f2.complete && /not honoured/.test(f2.error) && calls === 1, "a feed that ignores the recipient filter is abandoned after ONE page (caller falls back)");
  const f3 = await fetchTransfersFromFeed({ apiKey: "k", recipients: [RECIPIENT], fromMs: START, toMs: END, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  ok(!f3.complete && /401/.test(f3.error), "feed HTTP error is incomplete, not empty-and-complete");
  const f4 = await fetchTransfersFromFeed({ recipients: [RECIPIENT], fromMs: START, toMs: END });
  ok(!f4.complete, "no data key: incomplete");

  // RPC: 1 block per second from ts 0, latest block = END/1000 + 100.
  const latest = Math.floor(END / 1000) + 100;
  const getLogs = [];
  const rpcFn = async (m, p) => {
    if (m === "eth_blockNumber") return "0x" + latest.toString(16);
    if (m === "eth_getBlockByNumber") return { timestamp: "0x" + parseInt(p[0], 16).toString(16) };
    if (m === "eth_getLogs") { getLogs.push(p[0]); return getLogs.length === 1 ? [{ transactionHash: h(1), address: USDCE, data: "0x3e8", blockNumber: "0x" + Math.floor(at(10) / 1000).toString(16), topics: [p[0].topics[0], "0x" + PAYER.slice(2).padStart(64, "0"), "0x" + RECIPIENT.slice(2).padStart(64, "0")] }] : []; }
    throw new Error(m);
  };
  const r = await fetchTransfersFromRpc({ rpcFn, recipients: [RECIPIENT], fromMs: START, toMs: END, chunk: 40_000 });
  ok(r.complete && r.rows.length === 1 && r.rows[0].amountAtomic === "1000" && r.rows[0].ts === at(10), "RPC reader: block range from timestamps, amount + time decoded");
  ok(getLogs.length === 3 && getLogs.every((q) => !q.address && Array.isArray(q.topics[2])), "RPC reader chunks under the cap and applies NO token filter (so a wrong currency is visible)");
  const bad = await fetchTransfersFromRpc({ rpcFn: async () => { throw new Error("rpc down"); }, recipients: [RECIPIENT], fromMs: START, toMs: END });
  ok(!bad.complete && /unreadable/.test(bad.error), "RPC failure is incomplete, never a clean empty read");
}

// --- source pins: the debts the reconciler counts must actually be recorded --
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf("} else if ((req.tempoSettled || req.stripeSettled) && res.statusCode >= 400) {"));
  ok(branch.length > 0 && /recordRefundOwed\(\{[\s\S]{0,600}wire: req\.tempoSettled \? "mpp-tempo" : "mpp-stripe"/.test(branch.slice(0, 3000)),
    "server.js records a refund debt (wire mpp-tempo / mpp-stripe) when a Tempo/Stripe settle is followed by a >= 400");
  ok(/wire: req\.mppCredential \? "mpp" : "x402"/.test(src), "server.js tags x402-path debts with the wire, so MPP evm charged-failures are countable");
  ok(/mppReconcile: await mppReconciler\.status\(\{ full \}\)/.test(src), "gateway-status passes the operator flag (public view is words only)");
}

// --- booted server: operator auth + the public view -------------------------
{
  const PORT = await getFreePort();
  const TOKEN = "mpp-reconcile-test-operator-token-0123456789";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN, MPP_RECONCILE_FILE: join(dir, "server.json"), MPP_RECONCILE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const res = await fetch(`${base}/health`); if (res.ok) { up = true; break; } } catch {}
    await new Promise((res) => setTimeout(res, 500));
  }
  ok(up, "server booted");
  const noAuth = await fetch(`${base}/__operator/mpp-reconcile.json`);
  ok(noAuth.status === 404, "GET /__operator/mpp-reconcile.json without the token: 404");
  const noAuthRun = await fetch(`${base}/__operator/mpp-reconcile/run`, { method: "POST" });
  ok(noAuthRun.status === 404, "POST /__operator/mpp-reconcile/run without the token: 404");
  const authed = await fetch(`${base}/__operator/mpp-reconcile.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const aBody = await authed.json().catch(() => ({}));
  ok(authed.status === 200 && aBody.status && "lastRunAt" in aBody, "operator GET answers the detail");
  const run = await fetch(`${base}/__operator/mpp-reconcile/run`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  const runBody = await run.json().catch(() => ({}));
  ok(run.status === 200 && runBody.ok === true, "operator POST runs a reconciliation");
  const gs = await (await fetch(`${base}/api/gateway-status`)).json();
  ok(typeof gs.mppReconcile?.status === "string" && typeof gs.mppReconcile?.chargedFailedStatus === "string", "public /api/gateway-status carries mppReconcile status words");
  ok(!("counts" in gs.mppReconcile) && !("chargedFailed24h" in gs.mppReconcile), "...and no counts");
  child.kill();
}

console.log(`\ntest-mpp-reconcile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
