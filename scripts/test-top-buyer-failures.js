#!/usr/bin/env node
// Failures our top paying buyers get (src/top-buyer-failures.js,
// topBuyerFailures on /api/gateway-status).
//
// The incident it replays: our largest outside buyer, paying on Solana, got
// nine 502s from onchain-sql in five minutes, retried, and left; the payer
// was not known for a Solana payment at that point and failed calls are not
// in the sales ledger, so nothing read it.
//
// Module half (injected clock, memory store):
//   - nine failures in five minutes from the top Solana payer read alert, and
//     the operator view names the tool, the statuses and our error text;
//   - a payer outside the top ten with the same failures reads ok;
//   - fewer than the threshold, or failures spread wider than the window,
//     read ok; 2xx answers are not kept;
//   - alert holds after the last failure and then clears;
//   - the public answer is the word alone (no payer, no figure);
//   - threshold, window and hold follow their env variables;
//   - memory is bounded; error text is cut and scrubbed.
// Ledger half: the top payers come from the sales ledger's outside paid rows
// over seven days; our canary, burner and spending wallets, synthetic rows
// and free rails never rank.
// Wire half: a paid server (Base and Solana, stub facilitator, stubbed query
// service) with that ledger. Unpaid 402 challenges and payments the
// facilitator refused at verify count nothing; a non-top Solana payer's
// failures leave ok; the top Solana payer's nine failing onchain-sql calls
// turn the word to alert, the public body carries the word only, the
// operator view (private, no-store) names the short payer, rank 1, the slug,
// the statuses and the first characters of the error text the buyer was
// sent; the word clears after its hold.
//
//   node scripts/test-top-buyer-failures.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TMP = mkdtempSync(join(tmpdir(), "top-buyer-"));
process.env.SALES_LEDGER_DB = join(TMP, "agent402-sales.db");
// A secret-named variable whose value the error text must never carry.
process.env.TOP_BUYER_TEST_API_KEY = "tbk-0123456789abcdefghijklmnopqrstuv";

const kit = await import("@solana/kit");
const T = await import("../src/top-buyer-failures.js");
const { OUR_SOLANA_WALLETS, OUR_EVM_WALLETS } = await import("../src/revenue-live.js");
const { shortPayer } = await import("../src/verify-failure-log.js");

const topSol = await kit.generateKeyPairSigner();     // the largest outside buyer, on Solana
const nonTopSol = await kit.generateKeyPairSigner();  // an outside buyer ranked twelfth
const refusedSol = topSol;                             // its refused-at-verify attempts (same wallet, see below)
const evm = (n) => "0x" + n.toString(16).padStart(40, "0");
const CANARY_SOL = [...OUR_SOLANA_WALLETS][0];
const SPEND_EVM = [...OUR_EVM_WALLETS].find((w) => w.startsWith("0x7706"));

// ---- the module, on an injected clock ------------------------------------------
{
  T._resetTopBuyerFailures();
  const env = {};
  const TOP = topSol.address;
  // The incident: 22:53 to 22:57 UTC, nine 502s, the error text we sent.
  const t0 = Date.parse("2026-11-10T22:53:00Z");
  const said = "CDP's query service is failing right now; retry later.";
  ok((await T.topBuyerFailuresStatus({ now: t0, env })).status === "unknown", "before the top payers are read the word is unknown (pages nothing)");
  ok((await T.topBuyerFailuresStatus({ now: t0, env, off: true })).status === "off", "FREE_MODE reads off");
  T.setTopBuyers([evm(1), TOP, evm(2), evm(3), evm(4), evm(5), evm(6), evm(7), evm(8), evm(9)], t0);
  ok((await T.topBuyerFailuresStatus({ now: t0, env })).status === "ok", "with top payers read and nothing failing the word is ok");
  ok(T.noteVerifiedPaidOutcome({ payer: TOP, slug: "onchain-sql", status: 200, at: t0 }, env) === false && T._localSizes().events === 0, "a 2xx is not kept");
  for (let i = 0; i < 2; i++) T.noteVerifiedPaidOutcome({ payer: TOP, slug: "onchain-sql", status: 502, error: said, at: t0 + i * 30_000 }, env);
  ok((await T.topBuyerFailuresStatus({ now: t0 + 60_000, env })).status === "ok", "two failures are under the threshold of three");
  for (let i = 2; i < 9; i++) T.noteVerifiedPaidOutcome({ payer: TOP, slug: "onchain-sql", status: 502, error: said, at: t0 + i * 30_000 }, env);
  const last = t0 + 8 * 30_000; // 22:57
  const pub = await T.topBuyerFailuresStatus({ now: last + 1_000, env });
  ok(pub.status === "alert", `nine 502s from the top Solana payer in five minutes read alert (${JSON.stringify(pub)})`);
  ok(Object.keys(pub).join() === "status" && !JSON.stringify(pub).includes(TOP.slice(0, 4)) && !/\d/.test(JSON.stringify(pub)), `the public answer is the word alone: no payer, no figure (${JSON.stringify(pub)})`);
  const full = await T.topBuyerFailuresStatus({ now: last + 1_000, env, full: true });
  const a = full.alerting?.[0];
  ok(a && a.payer === shortPayer(TOP) && a.payer.length === 4 && TOP.startsWith(a.payer) && a.rank === 2, `the operator view names the short payer and its spend rank (${JSON.stringify(a && { payer: a.payer, rank: a.rank })})`);
  ok(a && a.failures.length === 9 && a.failures.every((f) => f.slug === "onchain-sql" && f.status === 502 && f.error === said) && a.failures[0].at === "2026-11-10T22:53:00.000Z" && a.failures[8].at === "2026-11-10T22:57:00.000Z", "it lists each failure: the tool, the status, the time and what we told the buyer");
  ok(!JSON.stringify(full).includes(TOP) && full.rule.failures === 3 && full.rule.windowMinutes === 10, "the operator view never carries the full address; the rule is stated");
  // Holds after the last failure for the hold, then clears.
  ok((await T.topBuyerFailuresStatus({ now: last + 20 * MIN, env })).status === "alert", "alert holds twenty minutes after the last failure, so a 15-minute pager reads it");
  ok((await T.topBuyerFailuresStatus({ now: last + 20 * MIN + 1, env })).status === "ok", "and then clears");
  // A payer outside the top ten, same failures: ok.
  T._resetTopBuyerFailures();
  T.setTopBuyers([evm(1), evm(2), evm(3), evm(4), evm(5), evm(6), evm(7), evm(8), evm(9), evm(10)], t0);
  for (let i = 0; i < 9; i++) T.noteVerifiedPaidOutcome({ payer: nonTopSol.address, slug: "onchain-sql", status: 502, error: said, at: t0 + i * 30_000 }, env);
  ok((await T.topBuyerFailuresStatus({ now: last + 1_000, env })).status === "ok", "the same nine failures from a payer outside the top ten read ok");
  // Spread wider than the window: three failures six minutes apart.
  T._resetTopBuyerFailures();
  T.setTopBuyers([TOP], t0);
  for (let i = 0; i < 3; i++) T.noteVerifiedPaidOutcome({ payer: TOP, slug: "x", status: 500, at: t0 + i * 6 * MIN }, env);
  ok((await T.topBuyerFailuresStatus({ now: t0 + 12 * MIN + 1, env })).status === "ok", "three failures twelve minutes end to end are not three inside ten minutes");
  T.noteVerifiedPaidOutcome({ payer: TOP, slug: "x", status: 404, at: t0 + 13 * MIN }, env);
  ok((await T.topBuyerFailuresStatus({ now: t0 + 13 * MIN + 1, env })).status === "alert", "a 4xx counts: a fourth failure puts three inside ten minutes");
  // Env: threshold, window, hold.
  T._resetTopBuyerFailures();
  T.setTopBuyers([TOP], t0);
  const env2 = { TOP_BUYER_FAIL_MIN: "5", TOP_BUYER_FAIL_WINDOW_MS: "60000", TOP_BUYER_FAIL_HOLD_MS: "30000" };
  for (let i = 0; i < 4; i++) T.noteVerifiedPaidOutcome({ payer: TOP, slug: "x", status: 503, at: t0 + i * 1000 }, env2);
  ok((await T.topBuyerFailuresStatus({ now: t0 + 5_000, env: env2 })).status === "ok", "TOP_BUYER_FAIL_MIN=5: four failures read ok");
  T.noteVerifiedPaidOutcome({ payer: TOP, slug: "x", status: 503, at: t0 + 5_000 }, env2);
  ok((await T.topBuyerFailuresStatus({ now: t0 + 6_000, env: env2 })).status === "alert", "a fifth reads alert");
  ok((await T.topBuyerFailuresStatus({ now: t0 + 35_001, env: env2 })).status === "ok", "TOP_BUYER_FAIL_HOLD_MS=30000: clears thirty seconds after it");
  ok(T.failMin({ TOP_BUYER_FAIL_MIN: "junk" }) === 3 && T.failWindowMs({ TOP_BUYER_FAIL_WINDOW_MS: "-1" }) === 600_000 && T.failHoldMs({}) === 1_200_000 && T.topCount({}) === 10 && T.topDays({}) === 7, "an unreadable setting keeps its default");
  // Error text: cut to 160, scrubbed of secrets and control characters.
  const long = `upstream said ${process.env.TOP_BUYER_TEST_API_KEY}\nline two ${"z".repeat(400)}`;
  const e = T.errorTextOf({ error: long });
  ok(e.length === 160 && !e.includes(process.env.TOP_BUYER_TEST_API_KEY) && e.includes("[redacted]") && !e.includes("\n"), `our error text is cut to 160 characters and scrubbed (${e.slice(0, 60)}...)`);
  ok(T.errorTextOf({ error: { message: "m" } }) === "m" && T.errorTextOf({}) === null && T.errorTextOf(null) === null, "a nested message is read; no text is null");
  // Memory is bounded.
  T._resetTopBuyerFailures();
  for (let p = 0; p < 2_500; p++) for (let i = 0; i < (p < 3 ? 80 : 1); i++) T.noteVerifiedPaidOutcome({ payer: `payer-${p}-${"x".repeat(30)}`, slug: "x", status: 500, at: t0 + i }, env);
  const sz = T._localSizes();
  ok(sz.payers <= 2_000 && sz.events <= 2_000 + 3 * 50, `memory is bounded: at most 2000 payers and 50 failures each (${JSON.stringify(sz)})`);
  T._resetTopBuyerFailures();
}

// ---- the ledger: who the top payers are --------------------------------------------
const L = await import("../src/sales-ledger.js");
{
  const sale = (payer, usd, o = {}) => L.recordSale({ slug: o.slug || "onchain-sql", priceUsd: usd, rail: o.rail || "usdc", network: o.network || "eip155:8453", payer, tx: `tx-${Math.random()}`, synthetic: !!o.synthetic, wire: "x402" });
  for (let i = 0; i < 5; i++) sale(topSol.address, 1, { network: SOL });            // $5
  for (let n = 1; n <= 10; n++) sale(evm(n), 1 + n / 10);                           // $1.1 .. $2.0
  sale(nonTopSol.address, 0.1, { network: SOL });                                   // $0.10, twelfth
  sale(CANARY_SOL, 100, { network: SOL });                                          // our canary burner
  sale(SPEND_EVM, 100);                                                             // our router spending wallet
  sale(evm(0xbeef), 100, { synthetic: true });                                      // our synthetic traffic
  sale(evm(0xf00d), 100, { rail: "pow" });                                          // a free rail
  await L.salesLedgerFlush();
  const rows = await L.topExternalPayersAsync({ days: 7, limit: 10 });
  const payers = rows.map((r) => r.payer);
  ok(payers.length === 10 && payers[0] === topSol.address && payers[1] === evm(10) && payers[9] === evm(2), `the top ten by seven-day spend, highest first (${payers.map((p) => p.slice(0, 6)).join(",")})`);
  ok(!payers.includes(CANARY_SOL) && !payers.includes(SPEND_EVM) && !payers.includes(evm(0xbeef)) && !payers.includes(evm(0xf00d)) && !payers.includes(nonTopSol.address), "our canary, our spending wallet, synthetic rows and free rails never rank; the twelfth payer is out");
  ok(payers[0] === topSol.address && topSol.address !== topSol.address.toLowerCase(), "the Solana address is kept as written, never case-folded");
  ok((await L.topExternalPayersAsync({ days: 7, limit: 10, now: Date.now() + 8 * 86_400_000 })).length === 0, "sales older than the window do not rank");
  const got = await T.refreshTopBuyers({ read: () => Promise.resolve([{ payer: CANARY_SOL }, ...rows]), isOwn: (p) => OUR_SOLANA_WALLETS.has(p) });
  ok(got.length === 10 && !got.includes(CANARY_SOL) && got[0] === topSol.address, "the refresh drops any wallet of ours a row still names and keeps ten");
  T._resetTopBuyerFailures();
}

// ---- the wire ---------------------------------------------------------------------
const OP = "top-buyer-failures-test-operator-token-0123456789";
const feePayer = await kit.generateKeyPairSigner();
const payTo = await kit.generateKeyPairSigner();
let refuseAll = false;
let verifies = 0, settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const [path] = req.url.split("?");
    if (path === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    let j = {}; try { j = JSON.parse(body); } catch { /* empty */ }
    if (path === "/verify") { verifies++; return refuseAll ? reply(200, { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction" }) : reply(200, { isValid: true }); }
    if (path === "/settle") { settles++; return reply(200, { success: true, transaction: "5".repeat(64), network: SOL }); }
    if (path === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CB = "ComputeBudget111111111111111111111111111111";
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
let priceSeq = 1;
async function paymentTx(buyer, amount) {
  const src = (await kit.generateKeyPairSigner()).address;
  const ixs = [
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, ...u32(20000)]) },
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(priceSeq++)]) },
    { programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(MINT), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ], data: new Uint8Array([12, ...u64(amount), 6]) },
  ];
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
    (m) => kit.appendTransactionMessageInstructions(ixs, m),
  );
  return kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
let srv = null;
try {
  srv = await bootServer({
    args: ["--import", "./scripts/lib/cdp-sql-stub-preload.js"], stores: "top-buyer",
    env: {
      FREE_MODE: "", NODE_ENV: "", CDP_SQL_STUB: "1",
      CDP_API_KEY_ID: "organizations/test/apiKeys/test", CDP_API_KEY_SECRET: privateKey.export({ type: "pkcs8", format: "pem" }),
      SALES_LEDGER_DB: process.env.SALES_LEDGER_DB,
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
      CDP_FACILITATOR_URL: FAC, FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "",
      AGENT402_BASE_RPC: `${FAC}/rpc`, MPP_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", FIRST_CALL_ALLOWANCE: "",
      AGENT402_OPERATOR_TOKEN: OP, UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
      TOP_BUYERS_REFRESH_MS: "1000", TOP_BUYER_FAIL_HOLD_MS: "8000",
      TOP_BUYER_FAIL_MIN: "", TOP_BUYER_FAIL_WINDOW_MS: "", TOP_BUYERS_COUNT: "", TOP_BUYERS_DAYS: "",
    },
  });
  const B = srv.url;
  const gs = async (op = false) => {
    const r = await fetch(`${B}/api/gateway-status`, { headers: op ? { "X-Operator-Token": OP } : {} });
    return { cache: r.headers.get("cache-control"), body: await r.json() };
  };
  const waitWord = async (want, ms = 15_000) => {
    let last = null;
    for (const until = Date.now() + ms; Date.now() < until;) { last = (await gs(true)).body.topBuyerFailures; if (last?.status === want) return last; await sleep(100); }
    return last;
  };
  const ready = await (async () => { for (const until = Date.now() + 20_000; Date.now() < until;) { const w = (await gs(true)).body.topBuyerFailures; if (w?.watched >= 10) return w; await sleep(100); } return (await gs(true)).body.topBuyerFailures; })();
  ok(ready?.status === "ok" && ready.watched === 10, `the server reads its top ten payers from the ledger off the request path (${JSON.stringify(ready && { status: ready.status, watched: ready.watched })})`);

  const ROUTE = "/api/onchain-sql";
  const FAIL_SQL = "SELECT 1 AS fail_upstream FROM base.blocks";
  const bare = await fetch(`${B}${ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: FAIL_SQL }) });
  const offer = JSON.parse(Buffer.from(bare.headers.get("payment-required"), "base64").toString("utf8"));
  await bare.arrayBuffer();
  const solAccept = (offer.accepts || []).find((x) => x.network === SOL);
  ok(bare.status === 402 && !!solAccept, `onchain-sql offers Solana (${bare.status})`);
  const pay = async (buyer, sql) => {
    const tx = await paymentTx(buyer, Number(solAccept.amount));
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted: solAccept, payload: { transaction: tx } })).toString("base64");
    const r = await fetch(`${B}${ROUTE}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: JSON.stringify({ sql }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // Unpaid challenges and payments refused at verify count nothing.
  for (let i = 0; i < 5; i++) { const r = await fetch(`${B}${ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: FAIL_SQL }) }); await r.arrayBuffer(); }
  const v0 = verifies;
  const refused = [];
  refuseAll = true;
  for (let i = 0; i < 5; i++) refused.push((await pay(refusedSol, FAIL_SQL)).status);
  refuseAll = false;
  ok(refused.every((s) => s === 402) && verifies - v0 === 5, `five payments refused at verify answer 402 (${refused.join(",")})`);
  // A non-top Solana payer's failures.
  const nonTop = [];
  for (let i = 0; i < 9; i++) nonTop.push(await pay(nonTopSol, FAIL_SQL));
  ok(nonTop.every((r) => r.status >= 500) && settles === 0, `a non-top payer's nine paid calls fail and nothing settles (${nonTop.map((r) => r.status).join(",")})`);
  // Each failure is booked when its response closes: wait until all nine are, then read the word.
  let quiet = await gs(true);
  for (const until = Date.now() + 10_000; Date.now() < until && !(quiet.body.topBuyerFailures?.recorded >= 9);) { await sleep(50); quiet = await gs(true); }
  ok(quiet.body.topBuyerFailures?.status === "ok" && quiet.body.topBuyerFailures.recorded === 9, `challenges and verify refusals count nothing, and nine failures from a payer outside the top ten leave ok (${JSON.stringify({ status: quiet.body.topBuyerFailures?.status, recorded: quiet.body.topBuyerFailures?.recorded })})`);

  // The incident: the top Solana payer, nine failing onchain-sql calls.
  const top = [];
  for (let i = 0; i < 9; i++) top.push(await pay(topSol, FAIL_SQL));
  ok(top.every((r) => r.status >= 500), `the top payer's nine paid calls fail (${top.map((r) => r.status).join(",")})`);
  const alert = await waitWord("alert");
  ok(alert?.status === "alert", `topBuyerFailures reads alert (${JSON.stringify(alert?.status)})`);
  const pubR = await gs(false);
  ok(pubR.body.topBuyerFailures && Object.keys(pubR.body.topBuyerFailures).join() === "status" && pubR.body.topBuyerFailures.status === "alert", `the public body carries the word only (${JSON.stringify(pubR.body.topBuyerFailures)})`);
  ok(!JSON.stringify(pubR.body).includes(topSol.address.slice(0, 4) + topSol.address.slice(4, 12)) && !JSON.stringify(pubR.body).includes(topSol.address), "and no payer anywhere in the public body");
  const opR = await gs(true);
  const row = opR.body.topBuyerFailures?.alerting?.[0];
  const sent = String(top[0].body.error || "").slice(0, 160);
  ok(/private/.test(opR.cache || "") && /no-store/.test(opR.cache || ""), `the operator view is private, no-store (${opR.cache})`);
  ok(row && row.payer === topSol.address.slice(0, 4) && row.rank === 1, `the operator view names the short payer and rank 1 (${JSON.stringify(row && { payer: row.payer, rank: row.rank })})`);
  ok(row && row.failures.length === 9 && row.failures.every((f, i) => f.slug === "onchain-sql" && f.status === top[i].status && typeof f.at === "string"), `it lists nine onchain-sql failures with the statuses the buyer got (${row && row.failures.map((f) => f.status).join(",")})`);
  ok(row && sent.length > 0 && row.failures[0].error === sent, `and the first characters of the error text we sent (${JSON.stringify(row?.failures?.[0]?.error)} vs ${JSON.stringify(sent)})`);
  ok(!JSON.stringify(opR.body.topBuyerFailures).includes(topSol.address), "the operator view never carries the full address");
  // Clears after the hold.
  const cleared = await waitWord("ok", 20_000);
  ok(cleared?.status === "ok", `the word clears after its hold (${cleared?.status})`);
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || e);
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  await srv?.stop();
  facilitator.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
