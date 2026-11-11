#!/usr/bin/env node
// The buyer scorecard (src/scorecard.js, buyerScorecardAsync in
// src/sales-ledger.js, GET /api/scorecard and /scorecard).
//
// Ledger half (one seeded ledger, an injected clock):
//   - wallets, returning wallets (paid in an earlier month, including before
//     the seven-month window) and multi-day wallets per UTC month;
//   - our canary and burner wallets, the router's spending wallets, synthetic
//     rows, free rails and rows with no paying wallet are never counted;
//   - a count of 1 or 2 reads "<3", and a month with fewer than 3 wallets
//     publishes that bucket and nothing else;
//   - a network with fewer than 3 wallets is folded into "other", and the
//     smallest named network joins it until it holds 3;
//   - no full address and no per-wallet figure in the JSON or the page;
//   - sample settlements: withheld by default; published (explorer links on
//     the right host, hash-shaped, the lowest ids, the same on every read)
//     with SCORECARD_PUBLISH_TX=on; the partial-answer fields say so;
//   - the page renders on the design tokens.
// Perf half (a child with a 300,000-row ledger): one refresh stays under its
// bound on the ours clock and never holds the event loop long.
// Wire half: a paid server (Base and Solana, stub facilitator). A Solana x402
// sale books the paying wallet as written (base58, never case-folded) in the
// sales ledger; /api/scorecard and /scorecard answer from the timer's figures
// (public cache, "<3", no address); the operator view is private, no-store
// and lists the sample settlement.
//
//   node scripts/test-scorecard.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";
import { hostOf } from "./lib/url-host.js";

const HERE = fileURLToPath(import.meta.url);
const ROOT = join(dirname(HERE), "..");

// ------------------------------------------------------------------ perf child
if (process.env.SCORECARD_PERF_CHILD === "1") {
  const { gapMeter, bound, oursMs } = await import("./lib/ours-clock.js");
  const L = await import("../src/sales-ledger.js");
  const { default: Database } = await import("better-sqlite3");
  const { sampleOk, scorecardNetworkKey } = await import("../src/scorecard.js");
  const now = Date.UTC(2026, 10, 11, 12);
  const h = new Database(process.env.SALES_LEDGER_DB);
  const ins = h.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const span = 400 * 86_400_000;
  h.transaction(() => {
    for (let i = 0; i < 300_000; i++) {
      const ts = now - span + Math.floor((i / 300_000) * span);
      const payer = `0x${(i % 4000).toString(16).padStart(40, "0")}`;
      ins.run(ts, "hash", 0.001 + (i % 7) / 1000, i % 11 === 0 ? "pow" : "usdc", i % 3 ? "base" : "eip155:8453", payer, `0x${i.toString(16).padStart(64, "0")}`, i % 13 === 0 ? 1 : 0, "x402");
    }
  })();
  h.close();
  const gaps = gapMeter(2);
  const t0 = oursMs(), w0 = performance.now();
  const r = await L.buyerScorecardAsync({ now, months: 7, minGroup: 3, samples: 3, sampleOk, networkKey: scorecardNetworkKey });
  const ours = oursMs() - t0, wall = performance.now() - w0;
  const { worst } = gaps.stop();
  const total = bound(300, 20), hold = bound(20, 2);
  console.log(JSON.stringify({ ours, wall, worst, total, hold, months: r.months.length, wallets: r.months.at(-1).wallets }));
  process.exit(0);
}

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = mkdtempSync(join(tmpdir(), "a402-scorecard-"));
process.env.SALES_LEDGER_DB = join(TMP, "sales.db");
delete process.env.SCORECARD_PUBLISH_TX;
const L = await import("../src/sales-ledger.js");
const S = await import("../src/scorecard.js");
const { OUR_EVM_WALLETS, OUR_SOLANA_WALLETS } = await import("../src/revenue-live.js");

// ------------------------------------------------------------------ ledger half
const NOW = Date.UTC(2026, 10, 11, 12); // 2026-11-11 12:00 UTC
const DAY = 86_400_000;
const realNow = Date.now;
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const b58 = (n) => Array.from({ length: n }, () => B58[Math.floor(rnd() * 58)]).join("");
const evm = (i) => `0xAbC${String(i).padStart(37, "0")}`; // mixed case: the ledger lowercases EVM
const sol = () => { let a; do a = b58(44); while (a === a.toLowerCase()); return a; };
let txn = 0;
const evmTx = () => `0x${(++txn).toString(16).padStart(64, "0")}`;
const solTx = () => b58(88);
const sale = (ms, o) => at(ms, () => L.recordSale({ slug: "hash", priceUsd: 0.01, rail: "usdc", network: "base", tx: evmTx(), synthetic: false, wire: "x402", ...o }));

const nov = (d) => Date.UTC(2026, 10, d, 10);
const oct = (d) => Date.UTC(2026, 9, d, 10);
const sep = (d) => Date.UTC(2026, 8, d, 10);
const aug = (d) => Date.UTC(2026, 7, d, 10);
const feb = (d) => Date.UTC(2026, 1, d, 10);

const W = Array.from({ length: 6 }, (_, i) => evm(i + 1)); // base wallets
const SOLW = [sol(), sol(), sol()];
const POLY = evm(40);
const everyAddress = [...W, ...SOLW, POLY];
// November (month to date): five base wallets, three Solana wallets, one Polygon wallet.
for (const w of W.slice(0, 5)) sale(nov(2), { payer: w });
const FIRST_NOV_TX = [1, 2, 3].map((i) => `0x${i.toString(16).padStart(64, "0")}`);
sale(nov(5), { payer: W[1] });                    // W2: a second day this month
sale(nov(2), { payer: W[2], tx: null });          // W3: same day again: still one day (no transaction on this row)
for (const w of SOLW) sale(nov(3), { payer: w, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: solTx(), priceUsd: 0.02 });
sale(nov(4), { payer: POLY, network: "eip155:137", priceUsd: 0.05 });
// Earlier history: W1 and W4 paid in September; W3 paid in February (before the window).
sale(sep(10), { payer: W[0] }); sale(sep(11), { payer: W[3] }); sale(sep(12), { payer: W[5] }); sale(sep(13), { payer: W[4] });
sale(feb(10), { payer: W[2] });
// October: two wallets only.
sale(oct(7), { payer: W[0], priceUsd: 0.25 }); sale(oct(8), { payer: W[1], priceUsd: 0.5 });
// August: three base wallets and one Solana wallet: Solana folds, then base joins it.
for (const w of W.slice(0, 3)) sale(aug(5), { payer: w });
sale(aug(6), { payer: SOLW[0], network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: solTx() });
// Never counted: our wallets (canary, burner, the router's spending wallets), synthetic rows,
// free rails, rows with no paying wallet, card rows.
const ours = [...OUR_EVM_WALLETS].slice(0, 3);
for (const w of ours) sale(nov(6), { payer: w, priceUsd: 9 });
const spendingSol = [...OUR_SOLANA_WALLETS].at(-1);
sale(nov(6), { payer: spendingSol, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: solTx(), priceUsd: 9 });
sale(nov(6), { payer: evm(90), synthetic: true, priceUsd: 9 });
sale(nov(6), { payer: evm(91), rail: "pow", priceUsd: 9 });
sale(nov(6), { payer: null, priceUsd: 9 });
sale(nov(6), { payer: null, rail: "card", network: "stripe", tx: "pi_x", priceUsd: 9 });
// A row booked as outside before its wallet joined our set (internal = 0 on the row): left out by address now.
const spendingEvm = [...OUR_EVM_WALLETS].find((w) => w.startsWith("0x77065d81")); // the Base spending wallet route-execute buys with
{
  const { default: Database } = await import("better-sqlite3");
  const h = new Database(process.env.SALES_LEDGER_DB);
  h.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, 'hash', 9, 'usdc', 'base', ?, ?, 0, 'x402')").run(nov(7), spendingEvm, evmTx());
  h.close();
}
const notCounted = [...ours, spendingSol, spendingEvm, evm(90), evm(91)];

const raw = L.buyerScorecard({ now: NOW, months: 7, minGroup: 3, samples: 3, sampleOk: S.sampleOk, networkKey: S.scorecardNetworkKey });
const rawAgain = await L.buyerScorecardAsync({ now: NOW, months: 7, minGroup: 3, samples: 3, sampleOk: S.sampleOk, networkKey: S.scorecardNetworkKey });
ok(JSON.stringify(raw) === JSON.stringify(rawAgain), "the paged async read and the one-pass read give the same answer");
ok(raw.months.map((m) => m.month).join() === "2026-05,2026-06,2026-07,2026-08,2026-09,2026-10,2026-11", `seven UTC months, the current one last (${raw.months.map((m) => m.month).join()})`);
const rNov = raw.months.at(-1);
ok(rNov.wallets === 9, `November: nine outside wallets; our wallets (also one booked as outside before it joined our set), synthetic, free and unattributed rows left out (${rNov.wallets})`);
ok(rNov.calls === 11 && Math.abs(rNov.usd - (7 * 0.01 + 3 * 0.02 + 0.05)) < 1e-9, `November: eleven calls and their USD only (${rNov.calls}, ${rNov.usd})`);
ok(rNov.returningWallets === 6, `November: W1 to W5 and the August Solana wallet paid in an earlier month (W3 only before the window): six returning (${rNov.returningWallets})`);
ok(rNov.multiDayWallets === 1, `November: one wallet paid on two days (${rNov.multiDayWallets})`);
const netNames = rNov.networks.map((n) => n.network).join();
ok(netNames === "base,other" && rNov.networks[1].networks.join() === "polygon,solana" && rNov.networks[1].wallets === 4,
  `November: Polygon's one wallet folds, and Solana (the smallest named) joins it until other holds 3+ (${JSON.stringify(rNov.networks)})`);
const rAug = raw.months.find((m) => m.month === "2026-08");
ok(rAug.networks.length === 1 && rAug.networks[0].network === "other" && rAug.networks[0].networks.join() === "base,solana" && rAug.networks[0].wallets === 4, `August: Solana folds and base joins: one other row of four wallets (${JSON.stringify(rAug.networks)})`);
ok(raw.months.every((m) => m.networks.every((n) => n.wallets >= 3 || m.wallets < 3)), "no network row holds fewer than 3 wallets in a month that has 3 or more");

// The public body.
const body = S.scorecardBody(raw, { asOf: new Date(NOW).toISOString(), publishTx: false, firstRecordedAt: null });
const bNov = body.months.at(-1), bOct = body.months.find((m) => m.month === "2026-10"), bSep = body.months.find((m) => m.month === "2026-09"), bMay = body.months[0];
ok(["name", "asOf", "refreshesEverySeconds", "firstRecordedAt", "months", "returned", "matched", "complete", "truncated", "method", "verify"].every((k) => k in body), `the body carries its fields (${Object.keys(body).join()})`);
ok(body.complete === true && body.returned === 7 && body.matched === 7, "all seven months, complete");
ok(typeof body.method?.counted === "string" && Array.isArray(body.method?.excluded) && body.method.excluded.length >= 3 && typeof body.method.smallCounts === "string", "the method is stated in fields");
ok(bNov.monthToDate === true && bNov.to === body.asOf && bSep.monthToDate === false && bSep.to === "2026-10-01T00:00:00.000Z", "the current month runs to asOf; a past month runs to the next month's start");
ok(bNov.wallets === 9 && bNov.returningWallets === 6 && bNov.returningShare === 0.667 && bNov.multiDayWallets === "<3" && bNov.multiDayShare === null, `November: 9 wallets, 6 returning (0.667), multi-day "<3" with no share (${JSON.stringify({ w: bNov.wallets, r: bNov.returningWallets, rs: bNov.returningShare, m: bNov.multiDayWallets, ms: bNov.multiDayShare })})`);
ok(bNov.settledCalls === 11 && bNov.usd === 0.18, `November: 11 calls, $0.18 (${bNov.settledCalls}, ${bNov.usd})`);
ok(bOct.wallets === "<3" && bOct.withheld === true && bOct.settledCalls === null && bOct.usd === null && bOct.returningWallets === null && bOct.multiDayWallets === null && bOct.networks.length === 0 && bOct.proof === null,
  `October (two wallets): "<3" and nothing else (${JSON.stringify(bOct)})`);
ok(bSep.wallets === 4 && bSep.returningWallets === "<3" && bSep.returningShare === null, `September: 4 wallets, one returning from August reads "<3" with no share (${JSON.stringify({ w: bSep.wallets, r: bSep.returningWallets })})`);
ok(bMay.wallets === 0 && bMay.settledCalls === 0 && bMay.withheld === false, "a month with no outside paid calls reads zero");
ok(body.months.every((m) => m.networks.every((n) => n.wallets === "<3" ? false : true)), "no network row reads \"<3\"");

// Proof: withheld by default; published with the switch.
ok(bNov.proof.published === false && bNov.proof.samples.length === 0 && bNov.proof.settlementsWithTx === 10 && bNov.proof.truncated === true && bNov.proof.matched === 10 && bNov.proof.returned === 0 && typeof bNov.proof.withheldReason === "string",
  `by default no transaction is listed, and the partial fields say the list is withheld (${JSON.stringify(bNov.proof)})`);
const pub = S.scorecardBody(raw, { asOf: new Date(NOW).toISOString(), publishTx: true });
const pNov = pub.months.at(-1);
const EXPECT_HOST = { base: "basescan.org", solana: "solscan.io", polygon: "polygonscan.com" };
ok(pNov.proof.published === true && pNov.proof.samples.length === 3 && pNov.proof.returned === 3 && pNov.proof.matched === 10 && pNov.proof.truncated === true, `published: three samples of ten (${JSON.stringify(pNov.proof && { n: pNov.proof.samples.length, m: pNov.proof.matched })})`);
ok(pNov.proof.samples.every((s) => s.url && hostOf(s.url) === EXPECT_HOST[s.chain] && new URL(s.url).pathname === `/tx/${s.tx}` && new URL(s.url).protocol === "https:"), `each sample links its transaction on its chain's explorer (${pNov.proof.samples.map((s) => s.url).join(" ")})`);
ok(JSON.stringify(pNov.proof.samples.map((s) => s.tx)) === JSON.stringify(FIRST_NOV_TX), `samples are the month's first settlements by ledger id (${pNov.proof.samples.map((s) => s.tx.slice(-4)).join()})`);
ok(JSON.stringify(S.scorecardBody(rawAgain, { asOf: new Date(NOW).toISOString(), publishTx: true }).months.at(-1).proof.samples) === JSON.stringify(pNov.proof.samples), "the same samples on every read");
ok(S.sampleOk("base", "0xnot-a-hash") === false && S.sampleOk("stripe", `0x${"a".repeat(64)}`) === false && S.sampleOk("base", `0x${"a".repeat(64)}`) === true, "a sample must be hash-shaped and on a network an explorer reads");

// No address, no per-wallet figure.
const page = S.scorecardPage("https://example.test", body);
const pubPage = S.scorecardPage("https://example.test", pub);
const texts = [JSON.stringify(body), page, JSON.stringify(pub), pubPage];
const leaked = [...everyAddress, ...notCounted].filter((a) => texts.some((t) => t.toLowerCase().includes(String(a).toLowerCase())));
ok(leaked.length === 0, `no wallet address appears in the JSON or the page (leaked ${leaked.length})`);
ok(!JSON.stringify(body).includes("0.75") && !JSON.stringify(body).includes("0.25"), "October's two wallets' own amounts appear nowhere");
ok(!/"payer"|"payers"/.test(JSON.stringify(pub)), "no payer field in the body");
ok(page.includes("&lt;3") && page.includes("/api/scorecard") && page.includes("November 2026") && /<h1[^>]*>Who pays, month by month\.<\/h1>/.test(page), "the page renders the months, the bucket and its machine-readable link");

// The refresh loop: computes once in flight, keeps the last figures on a failed read.
{
  let n = 0, fail = false;
  const sc = S.createScorecard({ compute: async () => { n++; await sleep(20); if (fail) throw new Error("x"); return { v: n }; }, log: { warn() {} } });
  const [a, b] = await Promise.all([sc.get(), sc.get()]);
  ok(n === 1 && a === b && a.value.v === 1, `one computation for two first reads (${n})`);
  fail = true;
  const c = await sc.refresh();
  ok(c.value.v === 1 && n === 2, "a failed refresh keeps the last figures");
  ok(S.scorecardRefreshMs({ SCORECARD_REFRESH_MS: "5" }) === 900_000 && S.scorecardRefreshMs({ SCORECARD_REFRESH_MS: "60000" }) === 60_000, "SCORECARD_REFRESH_MS: at least 10 s, default 15 min");
}

// ------------------------------------------------------------------ perf half
{
  const db = join(TMP, "perf.db");
  const r = spawnSync(process.execPath, [HERE], { cwd: ROOT, env: { ...process.env, SCORECARD_PERF_CHILD: "1", SALES_LEDGER_DB: db }, encoding: "utf8", timeout: 300_000 });
  let res = null; try { res = childJson(r.stdout); } catch (e) { console.error(r.stderr?.slice(-2000)); }
  ok(res && res.months === 7 && res.wallets > 0, `perf child read 300,000 rows (${JSON.stringify(res && { months: res.months, wallets: res.wallets })})`);
  ok(res && res.ours < res.total.ms, `one refresh over 300,000 rows: ${res?.ours?.toFixed(0)} ms ours (${res?.wall?.toFixed(0)} ms wall) under ${res?.total?.note}`);
  ok(res && res.worst < res.hold.ms, `the longest event-loop hold: ${res?.worst?.toFixed(1)} ms under ${res?.hold?.note}`);
}

// ------------------------------------------------------------------ wire half
{
  const { bootServer } = await import("./lib/boot-server.js");
  const kit = await import("@solana/kit");
  const { default: Database } = await import("better-sqlite3");
  const SOLNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const OP = "scorecard-test-operator-token-0123456789abcdef";
  const feePayer = await kit.generateKeyPairSigner();
  const payTo = await kit.generateKeyPairSigner();
  let buyer = null;
  do buyer = await kit.generateKeyPairSigner(); while (buyer.address === buyer.address.toLowerCase());
  const SETTLE_TX = b58(88);
  const facilitator = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const [path] = req.url.split("?");
      if (path === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOLNET, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
      if (path === "/verify") return reply(200, { isValid: true, payer: buyer.address });
      // The facilitator's settle response names the wallet it verified and settled from.
      if (path === "/settle") return reply(200, { success: true, transaction: SETTLE_TX, network: SOLNET, payer: buyer.address });
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
  async function paymentTx(amount) {
    const src = (await kit.generateKeyPairSigner()).address;
    const ixs = [
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, ...u32(20000)]) },
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) },
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
  const ledgerFile = join(TMP, "wire-sales.db");
  let srv = null;
  try {
    srv = await bootServer({
      stores: "scorecard",
      env: {
        FREE_MODE: "", NODE_ENV: "", SALES_LEDGER_DB: ledgerFile,
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", CDP_FACILITATOR_URL: FAC, FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "",
        AGENT402_BASE_RPC: `${FAC}/rpc`, MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", FIRST_CALL_ALLOWANCE: "",
        AGENT402_OPERATOR_TOKEN: OP, UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "", SCORECARD_PUBLISH_TX: "", SCORECARD_REFRESH_MS: "10000",
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
      },
    });
    const B = srv.url;
    const ROUTE = "/api/uuid";
    const bare = await fetch(`${B}${ROUTE}`);
    const offer = JSON.parse(Buffer.from(bare.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    await bare.arrayBuffer();
    const accept = (offer.accepts || []).find((x) => x.network === SOLNET);
    ok(bare.status === 402 && !!accept, `the tool offers Solana (${bare.status})`);
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted: accept, payload: { transaction: await paymentTx(Number(accept.amount)) } })).toString("base64");
    const paid = await fetch(`${B}${ROUTE}`, { headers: { "payment-signature": header } });
    await paid.arrayBuffer();
    ok(paid.status === 200, `a Solana x402 call settles (${paid.status})`);
    // The ledger row: read the file the server writes.
    let row = null;
    for (const until = Date.now() + 10_000; Date.now() < until && !row;) {
      try { const h = new Database(ledgerFile, { readonly: true, fileMustExist: true }); row = h.prepare("SELECT payer, network, tx, internal, rail FROM sales WHERE tx = ?").get(SETTLE_TX) || null; h.close(); } catch { /* not written yet */ }
      if (!row) await sleep(100);
    }
    ok(row && row.payer === buyer.address && row.payer !== row.payer.toLowerCase() && row.internal === 0 && row.rail === "usdc" && S.scorecardNetworkKey(row.network) === "solana",
      `the sales ledger books the Solana paying wallet as written, never case-folded (${JSON.stringify(row && { payerKept: row.payer === buyer.address, network: row.network, internal: row.internal })})`);

    // The scorecard answers from its timer's figures; force a fresh read by polling until the sale shows.
    let sc = null, res = null;
    for (const until = Date.now() + 40_000; Date.now() < until;) {
      res = await fetch(`${B}/api/scorecard`);
      sc = await res.json().catch(() => null);
      if (sc?.months?.at(-1)?.wallets === "<3") break;
      await sleep(500);
    }
    const cur = sc?.months?.at(-1);
    ok(res?.status === 200 && /public/.test(res.headers.get("cache-control") || "") && /x-operator-token/i.test(res.headers.get("vary") || ""), `GET /api/scorecard: public cache, varies on the operator header (${res?.headers.get("cache-control")})`);
    ok(cur && cur.wallets === "<3" && cur.withheld === true && cur.settledCalls === null && cur.usd === null, `one paying wallet reads "<3" and nothing else (${JSON.stringify(cur)})`);
    const pubText = JSON.stringify(sc);
    ok(!pubText.includes(buyer.address) && !pubText.includes(SETTLE_TX), "no address and no transaction in the public body");
    const htmlRes = await fetch(`${B}/scorecard`);
    const html = await htmlRes.text();
    ok(htmlRes.status === 200 && html.includes("&lt;3") && !html.includes(buyer.address) && !html.includes(SETTLE_TX), `/scorecard renders without the address (${htmlRes.status})`);
    const opRes = await fetch(`${B}/api/scorecard`, { headers: { "X-Operator-Token": OP } });
    const op = await opRes.json();
    ok(/private/.test(opRes.headers.get("cache-control") || "") && /no-store/.test(opRes.headers.get("cache-control") || ""), `the operator view is private, no-store (${opRes.headers.get("cache-control")})`);
    ok(op.months.at(-1).wallets === "<3" && !JSON.stringify(op).includes(buyer.address), "the operator view keeps the buckets and carries no address");
    const sm = await fetch(`${B}/sitemap.xml`).then((r) => r.text());
    const llms = await fetch(`${B}/llms.txt`).then((r) => r.text());
    const oa = await fetch(`${B}/openapi.json`).then((r) => r.json());
    ok(sm.includes(`${B}/scorecard</loc>`) || /\/scorecard<\/loc>/.test(sm), "the page is in the sitemap");
    ok(llms.includes("/api/scorecard"), "llms.txt names /api/scorecard");
    ok(oa?.paths?.["/api/scorecard"]?.get?.security?.length === 0, "openapi documents GET /api/scorecard as free");
  } catch (e) {
    failed++; console.error("FAIL -", e?.stack || e);
    if (srv) console.error(srv.log().slice(-3000));
  } finally {
    await srv?.stop();
    facilitator.close();
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
