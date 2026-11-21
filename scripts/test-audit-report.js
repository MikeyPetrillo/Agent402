#!/usr/bin/env node
// The audit report (POST /api/audit-report, src/tools/audit-report-kit.js)
// and the issued-receipt store behind it (src/receipt-store.js). Offline:
// the sales ledger and the receipt store are temp SQLite files, the handler's
// identity and signer are injected.
//
//   1. Identity: the report is the paying wallet's, never a parameter's;
//      another wallet's rows and receipts appear nowhere; no verified payer
//      (and FREE_MODE always) refuses.
//   2. Every rail's rows: x402, the MPP evm wire, the Gateway batched option,
//      Tempo, a referral sale at what the buyer paid; credits and card rows
//      (no wallet) and another chain's payer are never in it.
//   3. Receipts: each row's kept receipt verifies against the key and names
//      the row's settlement; one naming another payer is never attached.
//   4. The summary receipt verifies over the report (JSON) and the CSV
//      bytes, and fails on any change to either or to itself.
//   5. Caps and pages: limit, clamp, window bound, cursors that walk every
//      row once, totals over the whole window, partial-answer fields.
//   6. Storage: kept only on a final 200 finish, only for the rails a report
//      reads, bounded by the sweep; privacy text states the retention.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "a402-audit-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.RECEIPT_STORE_DB = join(dir, "receipts.db");
delete process.env.FREE_MODE;

const { recordSale } = await import("../src/sales-ledger.js");
const store = await import("../src/receipt-store.js");
const kit = await import("../src/tools/audit-report-kit.js");
const { loadReceiptKeys, buildReceiptRecord, signReceipt, verifyReceipt, requestDigest, responseDigest } = await import("../src/receipt-signing.js");
const { isIdentityBoundRoute } = await import("../src/payments.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log(`ok - ${m}`); };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; console.log(`ok - ${m}`); };

const A = "0xaaaa00000000000000000000000000000000000a";
const B = "0xbbbb00000000000000000000000000000000000b";
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const pemB64 = (k) => Buffer.from(k.export({ format: "pem", type: "pkcs8" })).toString("base64");
const KP = generateKeyPairSync("ed25519");
const { signer, keys } = loadReceiptKeys({ RECEIPT_SIGNING_KEY: pemB64(KP.privateKey), RECEIPT_SIGNING_KEY_ID: "t1" });
const other = loadReceiptKeys({ RECEIPT_SIGNING_KEY: pemB64(generateKeyPairSync("ed25519").privateKey), RECEIPT_SIGNING_KEY_ID: "t1" });
const def = kit.AUDIT_TOOLS[0];

// ---- the route's contract ----
ok(def.slug === "audit-report" && def.route === "POST /api/audit-report", "the route and slug");
ok(isIdentityBoundRoute(def), "identity-bound: offered on EVM x402 only, refused on Tempo, card and credits gates");
ok(WALLET_ONLY_SLUGS.has("audit-report"), "wallet-only: no proof-of-work tier (a free call has no wallet to report on)");
ok(Array.isArray(def.binaryTypes) && def.binaryTypes.includes("text/csv") && def.mimeType === "application/json", "the CSV answer is declared as bytes; the published example answers JSON");
ok(Number(String(def.price).replace(/[^0-9.]/g, "")) > 0, `priced (${def.price})`);

// ---- seed the ledger ----
// recordSale stamps Date.now(); spread the rows over days by a clock shim.
const realNow = Date.now;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00Z
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };
const sha = (c) => c.repeat(64);
const seeds = [
  // [ts, sale, receipt rail (null = none kept)]
  [T0, { slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "0xa1", wire: "x402", responseSha256: sha("1") }, "x402"],
  [T0 + 1000, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "0xa2", wire: "mpp" }, "mpp-evm"],
  [T0 + DAY, { slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "gw-transfer-1", wire: "gateway-batched" }, "gateway-batched"],
  [T0 + DAY + 5, { slug: "my-usage", priceUsd: 0.005, rail: "usdc", network: "tempo", payer: A, tx: "0xtempo1", wire: "mpp-tempo" }, "mpp-tempo"],
  // A referral sale: price_usd is the net, quote_usd the gross the buyer paid.
  [T0 + 2 * DAY, { slug: "hash", priceUsd: 0.0008, quoteUsd: 0.001, rail: "referral", network: "eip155:8453", payer: A, tx: "0xref1", wire: "referral" }, null],
  // A metered call: settled under its quote.
  [T0 + 2 * DAY + 7, { slug: "v1-chat-metered", priceUsd: 0.0123, quoteUsd: 0.05, rail: "usdc", network: "eip155:8453", payer: A, tx: "0xa3", wire: "x402" }, "x402"],
  // Our own traffic for this wallet is still its own history.
  [T0 + 3 * DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "0xa4", wire: "x402", synthetic: true }, null],
  // Not this wallet's: another wallet, a credits key, a card, another chain, a free call.
  [T0 + 1500, { slug: "seller-dossier", priceUsd: 0.05, rail: "usdc", network: "eip155:8453", payer: B, tx: "0xb1", wire: "x402" }, "x402"],
  [T0 + 1600, { slug: "hash", priceUsd: 0.001, rail: "credits", network: "stripe", payer: "k_testkey123", tx: null, wire: "credits" }, null],
  [T0 + 1700, { slug: "recall-report", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_123", wire: "stripe-checkout" }, null],
  [T0 + 1800, { slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: SOL, tx: "5solsig", wire: "x402" }, null],
  [T0 + 1900, { slug: "hash", priceUsd: 0.001, rail: "pow", network: null, payer: A, tx: null, wire: null }, null],
  // Outside the default window, inside a year.
  [T0 - 200 * DAY, { slug: "dns-lookup", priceUsd: 0.002, rail: "usdc", network: "eip155:137", payer: A, tx: "0xold", wire: "x402" }, "x402"],
];
const issued = new Map(); // tx -> { jws, record, body }
for (const [ts, sale, rrail] of seeds) {
  at(ts, () => recordSale(sale));
  if (!rrail) continue;
  const body = Buffer.from(JSON.stringify({ for: sale.tx }));
  const record = buildReceiptRecord({ iss: "https://example.test", method: "POST", path: `/api/${sale.slug}`, slug: sale.slug, requestSha256: requestDigest("POST", `/api/${sale.slug}`, { q: sale.tx }), responseSha256: responseDigest(body), priceUsd: sale.priceUsd, rail: rrail, network: sale.network, payer: rrail === "mpp-tempo" ? null : sale.payer, settlement: sale.tx, now: ts });
  const jws = signReceipt(record, signer);
  issued.set(sale.tx, { jws, record, body });
  store.storeIssuedReceipt(jws, record);
}
// A receipt naming ANOTHER payer under one of A's settlements: never attached to A's row.
{
  const forged = buildReceiptRecord({ method: "POST", path: "/api/hash", slug: "hash", requestSha256: sha("c"), responseSha256: sha("d"), priceUsd: 0.001, rail: "x402", network: "eip155:8453", payer: B, settlement: "0xa1", now: T0 - 5 });
  store.storeIssuedReceipt(signReceipt(forged, signer), forged);
}

// ---- what the store keeps ----
{
  const rec = (rail, payer, settlement = "0xs") => buildReceiptRecord({ method: "POST", path: "/api/x", slug: "x", requestSha256: sha("e"), responseSha256: sha("f"), priceUsd: 0.001, rail, network: null, payer, settlement });
  const row = (rail, payer, settlement) => { const r = rec(rail, payer, settlement); return store.issuedReceiptRow(signReceipt(r, signer), r); };
  ok(row("x402", A) && row("gateway-batched", A) && row("mpp-evm", A) && row("mpp-tempo", A), "kept: the rails a wallet's report reads, with an EVM payer");
  ok(row("mpp-tempo", null, "0xt") && row("mpp-tempo", null, "0xt").payer === null, "kept: a Tempo receipt signed before its sender was read, by its settlement");
  for (const [rail, payer, why] of [["credits", "k_abc", "a credits debit (its history is on the balance page)"], ["mpp-stripe", null, "a card payment (no wallet)"], ["card-checkout", null, "a card report"], ["x402", SOL, "a Solana payer (cannot open a report)"], ["x402", null, "an x402 receipt naming no payer"], ["audit-summary", A, "a summary receipt"]]) {
    ok(row(rail, payer) === null, `not kept: ${why}`);
  }
  ok(store.issuedReceiptRow("not a jws", rec("x402", A)) === null && store.issuedReceiptRow("a.b.c".repeat(2000), rec("x402", A)) === null, "not kept: a value that is not a compact JWS, or one past the bound");
}

// ---- the handler ----
const handler = (payer, extra = {}) => kit.makeAuditReportHandler({ payerOf: () => payer, signer: () => signer, refresh: async () => {}, now: () => T0 + 10 * DAY, ...extra });
const call = (payer, input, extra) => handler(payer, extra)(input, { headers: {} });
const WIN = { from: "2026-09-25", to: "2026-10-31" };

// 1. identity
{
  const r = await call(A, { ...WIN, wallet: B, payer: B });
  ok(r.report.wallet === A, "the report is the paying wallet's; a wallet or payer input changes nothing");
  ok(!JSON.stringify(r).includes(B.slice(2)), "another wallet's address appears nowhere in the answer");
  ok(!JSON.stringify(r).includes("0xb1"), "nor its settlement");
  const rb = await call(B, WIN);
  eq(rb.report.rows.map((x) => x.settlement), ["0xb1"], "the other wallet sees only its own row");
  const refuse = await call(null, WIN).catch((e) => e);
  ok(refuse instanceof Error && refuse.statusCode === 400 && /wallet that PAYS/.test(refuse.message), "no verified payer: refused 400, naming payment as the identity");
  process.env.FREE_MODE = "true";
  const free = await kit.makeAuditReportHandler({ refresh: async () => {} })(WIN, { header: () => Buffer.from(JSON.stringify({ payload: { authorization: { from: A } } })).toString("base64"), headers: {} }).catch((e) => e);
  delete process.env.FREE_MODE;
  ok(free instanceof Error && free.statusCode === 400 && /FREE_MODE/.test(free.message), "FREE_MODE: a typed payment header carries no identity, refused");
}

// 2. every rail's rows
const full = await call(A, WIN);
{
  const rows = full.report.rows;
  eq(rows.map((r) => r.settlement), ["0xa1", "0xa2", "gw-transfer-1", "0xtempo1", "0xref1", "0xa3", "0xa4"], "this wallet's paid rows in the window, oldest first: credits, card, Solana, free and other wallets' rows are not in it");
  const by = Object.fromEntries(rows.map((r) => [r.settlement, r]));
  eq([by["0xa1"].rail, by["0xa2"].rail, by["gw-transfer-1"].rail, by["0xtempo1"].rail, by["0xref1"].rail], ["x402", "mpp-evm", "gateway-batched", "mpp-tempo", "referral"], "each row names its rail");
  ok(by["0xref1"].priceUsd === 0.001 && by["0xref1"].quotedUsd === null && by["0xref1"].route === null, "a referral row reads what the buyer paid (the gross), never the net, and names no route here");
  ok(by["0xa3"].priceUsd === 0.0123 && by["0xa3"].quotedUsd === 0.05, "a metered row: settled amount and its quoted ceiling");
  ok(by["0xa1"].network === "eip155:8453" && by["0xtempo1"].network === "tempo", "the network rides");
  ok(by["0xa4"].receipt === null && by["0xa4"].responseSha256 === null && by["0xa4"].requestSha256 === null, "a row with no kept receipt says null, never a guess");
}

// 3. receipts
{
  const rows = full.report.rows.filter((r) => r.receipt);
  eq(rows.map((r) => r.settlement), ["0xa1", "0xa2", "gw-transfer-1", "0xtempo1", "0xa3"], "every row whose receipt was kept carries it");
  ok(full.report.receipts.onThisPage === 5 && full.report.receipts.read === "ok" && full.report.receipts.keptDays === store.RECEIPT_STORE_DAYS, "the receipt count, read state and retention are fields");
  for (const r of rows) {
    const v = verifyReceipt(r.receipt, { keys, responseBody: issued.get(r.settlement).body });
    ok(v.valid && v.checks.response && v.record.settlement === r.settlement && r.receiptId === v.record.id && r.requestSha256 === v.record.requestSha256 && r.responseSha256 === v.record.responseSha256, `${r.rail}: the receipt verifies against the key and the answer bytes, and names the row's settlement and digests`);
    ok(!verifyReceipt(r.receipt, { keys: other.keys }).valid, `${r.rail}: and fails against another key under the same kid`);
  }
  const a1 = full.report.rows.find((r) => r.settlement === "0xa1");
  ok(verifyReceipt(a1.receipt, { keys }).record.payer === A, "the receipt naming another payer under this settlement was not attached");
  ok(a1.route === "POST /api/hash", "the route is the receipt's");
}

// 4. the summary receipt
{
  const v = verifyReceipt(full.summaryReceipt, { keys, responseBody: JSON.stringify(full.report) });
  ok(v.valid && v.checks.response && v.record.payer === A && v.record.rail === kit.AUDIT_SUMMARY_RAIL && v.record.priceUsd === null && v.record.settlement === null && v.record.slug === "audit-report", "the summary verifies over JSON.stringify(report), names the wallet, rail audit-summary, no price or settlement");
  ok(full.reportSha256 === v.record.responseSha256, "reportSha256 is the digest the summary signs");
  const t1 = JSON.parse(JSON.stringify(full.report)); t1.rows[0].priceUsd = 0.0001;
  ok(verifyReceipt(full.summaryReceipt, { keys, responseBody: JSON.stringify(t1) }).reason === "response_mismatch", "a changed amount fails the summary");
  const t2 = JSON.parse(JSON.stringify(full.report)); t2.rows.pop();
  ok(verifyReceipt(full.summaryReceipt, { keys, responseBody: JSON.stringify(t2) }).reason === "response_mismatch", "a dropped row fails the summary");
  const t3 = JSON.parse(JSON.stringify(full.report)); t3.wallet = B;
  ok(verifyReceipt(full.summaryReceipt, { keys, responseBody: JSON.stringify(t3) }).reason === "response_mismatch", "another wallet named fails the summary");
  const [h, p, s] = full.summaryReceipt.split(".");
  const rec = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...rec, payer: B })).toString("base64url")}.${s}`;
  ok(verifyReceipt(forged, { keys }).reason === "bad_signature", "a summary whose payer was changed fails its signature");
  ok(full.verification.keys.endsWith("/.well-known/agent402-receipt-key.json") && full.verification.verify.endsWith("/api/receipts/verify") && full.verification.offline.length >= 4, "the verification section names the keys, the check and the offline steps");
  const off = await call(A, WIN, { signer: () => null });
  ok(off.summaryReceipt === null && /not issued/.test(off.note), "signing off: no summary receipt, and the answer says so");
}

// 5. caps and pages
{
  ok(full.report.matched === 7 && full.report.returned === 7 && full.report.complete === true && full.report.truncated === false && full.report.page.last === true && full.report.page.nextCursor === null, "a whole window in one page: partial-answer fields say complete");
  const seen = [];
  let cursor = null, pages = 0, first = null;
  do {
    const r = await call(A, cursor ? { cursor, limit: 2 } : { ...WIN, limit: 2 });
    if (!first) first = r;
    pages++;
    ok(r.report.matched === 7 && r.report.returned <= 2 && r.report.totals.calls === 7, `page ${pages}: ${r.report.returned} rows of 7 matched, totals over the whole window`);
    ok(verifyReceipt(r.summaryReceipt, { keys, responseBody: JSON.stringify(r.report) }).valid, `page ${pages}: its own summary verifies`);
    seen.push(...r.report.rows.map((x) => x.settlement));
    cursor = r.report.page.nextCursor;
  } while (cursor && pages < 10);
  eq(seen, full.report.rows.map((r) => r.settlement), "the cursors walk every row once, in order");
  ok(pages === 4 && first.report.truncated === true && first.report.complete === false, "a short page says it is short");
  eq(first.report.byTool, full.report.byTool, "totals by tool are the window's, not the page's");
  eq(full.report.byDay.map((d) => d.day), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"], "totals by UTC day");
  ok(Math.abs(full.report.totals.paidUsd - (0.001 + 0.001 + 0.001 + 0.005 + 0.001 + 0.0123 + 0.001)) < 1e-9, `the window's total is the sum of what the wallet paid (${full.report.totals.paidUsd})`);
  ok(full.report.byTool.find((t) => t.slug === "hash").calls === 3, "per tool: calls across rails");
  const big = await call(A, { ...WIN, limit: 5000 });
  ok(big.report.requestedExceededMax === true && big.report.page.limit === kit.AUDIT_MAX_LIMIT, "a limit past the cap is clamped and says so");
  const def30 = await call(A, {});
  ok(def30.report.window.to === new Date(T0 + 10 * DAY).toISOString() && Date.parse(def30.report.window.to) - Date.parse(def30.report.window.from) === 30 * DAY, "the default window is the last 30 days");
  const year = await call(A, { from: "2026-03-01", to: "2026-10-31" });
  ok(year.report.rows.some((r) => r.settlement === "0xold"), "a longer window (under a year) reaches older rows");
  for (const [input, re, what] of [
    [{ limit: 0 }, /limit/, "a zero limit"],
    [{ limit: "x" }, /limit/, "a limit that is not a number"],
    [{ from: "2025-01-01", to: "2026-10-31" }, /at most 366 days/, "a window over a year"],
    [{ from: "2026-10-31", to: "2026-10-01" }, /after/, "from after to"],
    [{ from: "yesterday" }, /ISO date/, "a date that does not read"],
    [{ from: { toString: 1 } }, /ISO date/, "a date that is an object"],
    [{ cursor: "%%%" }, /cursor/, "a cursor that is not one"],
    [{ cursor: Buffer.from(JSON.stringify({ v: 1, f: 0, t: 400 * DAY, ts: 0, id: 0 })).toString("base64url") }, /cursor/, "a cursor whose window is over a year"],
    [{ cursor: first.report.page.nextCursor, from: "2026-01-01" }, /window the cursor/, "a cursor with another window"],
    [{ format: "xml" }, /format/, "an unknown format"],
  ]) {
    const e = await call(A, input).catch((x) => x);
    ok(e instanceof Error && e.statusCode === 400 && re.test(e.message), `400: ${what}`);
  }
  const unread = await call(A, WIN, { receiptsForSettlements: async () => { throw new Error("store down"); } });
  ok(unread.report.receipts.read === "unavailable" && unread.report.rows.every((r) => r.receipt === null), "a receipt store that cannot be read: rows carry none and the field says unavailable");
}

// CSV
{
  const r = await call(A, { ...WIN, format: "csv", limit: 3 });
  ok(Buffer.isBuffer(r.__binary) && r.contentType === "text/csv", "format csv: raw text/csv bytes");
  const text = r.__binary.toString("utf8");
  const lines = text.trimEnd().split("\r\n");
  ok(lines[0] === '"at","slug","route","priceUsd","quotedUsd","rail","network","settlement","requestSha256","responseSha256","receiptId","receipt"' && lines.length === 4, "a header row and one line per row of the page");
  const v = verifyReceipt(r.headers["Agent402-Audit-Summary"], { keys, responseBody: r.__binary });
  ok(v.valid && v.record.payer === A, "the summary header verifies over the CSV bytes");
  ok(verifyReceipt(r.headers["Agent402-Audit-Summary"], { keys, responseBody: text.replace("0.001", "0.002") }).reason === "response_mismatch", "a changed CSV fails it");
  ok(typeof r.headers["Agent402-Audit-Next-Cursor"] === "string" && r.headers["Agent402-Audit-Matched"] === "7" && r.headers["Agent402-Audit-Returned"] === "3", "the CSV's page fields ride as headers");
  const csv = kit.auditCsv([{ at: "x", slug: "=cmd|'/c calc'!A1", route: '"q"', priceUsd: 1, network: "a,b" }]);
  ok(csv.includes(`"'=cmd`) && csv.includes('"""q"""') && csv.includes('"a,b"'), "a formula-shaped cell is quote-prefixed; quotes doubled; commas held");
}

// 6. storage: kept only on a final 200, bounded by the sweep
{
  const kept = [];
  const keep = (j, r) => kept.push(r.id);
  const mk = () => Object.assign(new EventEmitter(), { statusCode: 200 });
  const J = "aaa.bbb.ccc";
  const rec = (id, more = {}) => ({ id, rail: "x402", payer: A, settlement: `0x${id}`, iat: new Date(T0).toISOString(), ...more });
  const r1 = mk(); store.keepReceiptOnFinalOk(J, rec("one"), null, r1, keep);
  ok(kept.length === 0, "nothing is kept before the response finished");
  r1.emit("finish");
  const r2 = mk(); store.keepReceiptOnFinalOk(J, rec("two"), null, r2, keep); r2.statusCode = 402; r2.emit("finish");
  const r3 = mk(); store.keepReceiptOnFinalOk(J, rec("three"), null, r3, keep); r3.statusCode = 500; r3.emit("finish");
  const r4 = mk(); store.keepReceiptOnFinalOk(J, rec("four"), null, r4, keep); r4.emit("close");
  eq(kept, ["one"], "kept on a final 200 finish only: a final 402 or 500 keeps nothing, nor a connection closed before the finish");
  r1.emit("finish");
  eq(kept, ["one"], "kept once per response");

  // A receipt the store never keeps (a Solana payer, a card rail) adds no
  // listener at all; one it keeps adds its own without tripping Node's
  // listener-leak warning on a response that already carries the default ten.
  const warnings = [];
  const onWarn = (w) => { if (w?.name === "MaxListenersExceededWarning") warnings.push(String(w.message).slice(0, 120)); };
  process.on("warning", onWarn);
  try {
    const busy = () => { const r = mk(); for (let i = 0; i < r.getMaxListeners(); i++) r.on("finish", () => {}); return r; };
    const sol = busy(); const before = sol.listenerCount("finish");
    const skippedBefore = store.receiptStoreCounts().skipped;
    store.keepReceiptOnFinalOk(J, rec("sol", { payer: SOL }), null, sol, keep);
    const card = busy();
    store.keepReceiptOnFinalOk(J, rec("card", { rail: "mpp-stripe", payer: null }), null, card, keep);
    ok(store.receiptStoreCounts().skipped === skippedBefore + 2, `a receipt the store never keeps is counted for the operator (skipped ${skippedBefore} -> ${store.receiptStoreCounts().skipped})`);
    ok(sol.listenerCount("finish") === before && card.listenerCount("finish") === before, `a receipt the store never keeps adds no finish listener (${sol.listenerCount("finish")}, ${card.listenerCount("finish")} of ${before})`);
    const evm = busy();
    const skippedMid = store.receiptStoreCounts().skipped;
    store.keepReceiptOnFinalOk(J, rec("evm"), null, evm, keep);
    ok(store.receiptStoreCounts().skipped === skippedMid, "a receipt the store keeps is not counted as skipped");
    await new Promise((r) => setImmediate(r));
    ok(evm.listenerCount("finish") === before + 1 && warnings.length === 0, `a kept receipt's listener on a response with ten already raises no listener-leak warning (${warnings.join(" | ") || "none"})`);
    evm.emit("finish"); sol.emit("finish"); card.emit("finish");
    eq(kept, ["one", "evm"], "the kept one is still kept on its final 200; the never-kept ones are not");
    const unlimited = mk(); unlimited.setMaxListeners(0);
    store.keepReceiptOnFinalOk(J, rec("u"), null, unlimited, keep);
    ok(unlimited.getMaxListeners() === 0 && unlimited.listenerCount("finish") === 1, "a response with no listener bound (0) stays unbounded");
  } finally { process.off("warning", onWarn); }

  const before = (await store.receiptsForSettlements(A, ["0xold"])).get("0xold")?.length || 0;
  const s1 = await store.sweepIssuedReceipts({ now: T0 + 10 * DAY, days: 100, maxRows: 1_000_000 });
  const after = (await store.receiptsForSettlements(A, ["0xold"])).get("0xold")?.length || 0;
  ok(before === 1 && after === 0 && s1.aged >= 1, `the sweep deletes receipts past the retention (${s1.aged} aged out)`);
  const s2 = await store.sweepIssuedReceipts({ now: T0 + 10 * DAY, days: 3650, maxRows: 3 });
  const left = await store.receiptsForSettlements(A, ["0xa1", "0xa2", "gw-transfer-1", "0xtempo1", "0xa3"]);
  ok(s2.over >= 1 && [...left.values()].flat().length <= 3 && left.has("0xa3"), `past the row bound the oldest go first (${s2.over} removed, newest kept)`);
}

// Privacy states the retention, from the same constant.
{
  const src = readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8");
  ok(/\/api\/audit-report/.test(src) && (src.match(/\$\{RECEIPT_STORE_DAYS\} days after it was issued/g) || []).length >= 2, "/privacy names the audit report and the kept receipts' retention, read from RECEIPT_STORE_DAYS");
}

// The wiki page names the refund block as served: listed beside the calls,
// never netted from the totals, read up to the kit's cap.
{
  const { AUDIT_REFUNDS_MAX: cap } = await import("../src/tools/audit-report-kit.js");
  const wiki = readFileSync(new URL("../wiki/Audit-Report.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  ok(/`report\.refunds`/.test(wiki) && /`netted: false`/.test(wiki) && wiki.includes(`newest ${cap} refund rows`), `wiki/Audit-Report.md names report.refunds, netted: false and the ${cap}-row read`);
  ok(!/full paid history/.test(wiki) && !/hand to an auditor/.test(wiki), "wiki/Audit-Report.md describes a record of paid calls, not a full history for an auditor");
}

console.log(`\n${n} passed`);
