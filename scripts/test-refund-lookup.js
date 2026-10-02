#!/usr/bin/env node
// Refund lookup (src/refund-lookup.js, GET|POST /api/refunds/lookup) and the
// caller's own refunds on my-usage. A Base refund is a memo-less USDC
// transfer, so a buyer needs a way to tie it to the payment it repays.
//
// What is pinned:
//  - exact match on ONE transaction hash only (no prefix, no wildcard, no
//    payer|slug|minute fallback key, no case folding of base58);
//  - an unknown tx and a known payment with no refund answer the same shape
//    with status "none", so the answer does not reveal whether we saw it;
//  - the public answer never carries the payer, the tool bought, the ledger's
//    note or any other row;
//  - my-usage lists ONLY the signed payer's rows;
//  - the route is free and rate limited.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

const dir = mkdtempSync(join(tmpdir(), "refund-lookup-"));
process.env.REFUND_DB_DIR = dir;
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
const { recordRefundOwed, markRefundPaid, markRefundVoid, listRefunds, refundsForPayer, claimRefundForSend } = await import("../src/refund-ledger.js");
const { refundLookup, lookupKeys, ownRefundsView, explorerTxUrl, publicRefundView } = await import("../src/refund-lookup.js");
const { USAGE_TOOLS } = await import("../src/tools/usage-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const throws400 = (fn, m) => { try { fn(); ok(false, `${m} (no throw)`); } catch (e) { ok(e?.statusCode === 400, `${m} (${e?.statusCode})`); } };

const PAYER_A = "0xAaAaaAaAAaaAaaAaAaAaaaAAaaAaaaAaAaaAaaA1";
const PAYER_B = "0xbBbbBbbBBbbbbbbbBbBBbbbbBbbbbBBbbbbbBbB2";
const SOL_PAYER = "7vYbmxp2Q7dXgWm2Gm9rBp3eKk8Ld5sNf1r2Zq3UuVwX";
const TX_PAID = "0x" + "a1".repeat(32);
const TX_OWED = "0x" + "b2".repeat(32);
const TX_VOID = "0x" + "c3".repeat(32);
const TX_B = "0x" + "d4".repeat(32);
const TX_SOL = "5VfydnLu4XwV2H2dLHPv22JxhLbYJruaM9YTaGY3aTZjd4re" + "Aq1ucRUVVSb2PVw6mZXV9tA4CBLyGXV4G2bV1zbu";
const RF_PAID = "0x" + "e5".repeat(32);

recordRefundOwed({ slug: "secret-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.005, tx: TX_PAID, httpStatus: 502, note: "internal note: upstream X failed" });
recordRefundOwed({ slug: "other-tool", network: "eip155:137", payer: PAYER_A, priceUsd: 0.01, tx: TX_OWED, httpStatus: 500 });
recordRefundOwed({ slug: "void-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.002, tx: TX_VOID, httpStatus: 499 });
recordRefundOwed({ slug: "b-tool", network: "eip155:8453", payer: PAYER_B, priceUsd: 0.05, tx: TX_B, httpStatus: 502 });
recordRefundOwed({ slug: "sol-tool", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: SOL_PAYER, priceUsd: 0.003, tx: TX_SOL, httpStatus: 502 });
recordRefundOwed({ slug: "no-tx-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.004, httpStatus: 502 }); // payer|slug|minute fallback key
const rows = listRefunds({ status: "all" });
const idOf = (tx) => rows.find((r) => r.evidence === tx).id;
ok(claimRefundForSend(idOf(TX_PAID)) && markRefundPaid(idOf(TX_PAID), RF_PAID), "fixture: one refund claimed and paid");
ok(markRefundVoid(idOf(TX_VOID), "served after all"), "fixture: one refund voided");

// ---- the public answer
const paid = refundLookup(TX_PAID);
ok(paid.status === "paid" && paid.amountUsd === 0.005 && paid.network === "eip155:8453" && paid.chain === "base" && paid.refundTx === RF_PAID && paid.refundTxUrl === `https://basescan.org/tx/${RF_PAID}` && typeof paid.refundedAt === "string", "a paid refund answers status, amount, network and our refund tx with its explorer link");
const blob = JSON.stringify(paid);
ok(!blob.toLowerCase().includes(PAYER_A.toLowerCase().slice(2)) && !/secret-tool|internal note|upstream X/.test(blob), "the public answer never carries the payer, the tool bought or the ledger's note");
ok(refundLookup(TX_PAID.toUpperCase().replace("0X", "0x")).status === "paid", "a hex hash is matched case-insensitively (hex has no case)");
const owed = refundLookup(TX_OWED);
ok(owed.status === "owed" && owed.refundTx === null && owed.chain === "polygon", "an owed refund answers owed, with no refund tx yet");
ok(refundLookup(TX_VOID).status === "void", "a voided debt answers void");
ok(refundLookup(TX_SOL).status === "owed" && refundLookup(TX_SOL).chain === "solana", "a Solana signature matches exactly");
ok(refundLookup(TX_SOL.replace("V", "v")).status === "none", "base58 is never case-folded: a different spelling is a different signature");

// unknown vs no refund: same shape, same status
const unknown = refundLookup("0x" + "99".repeat(32));
ok(unknown.status === "none" && Object.keys(unknown).join() === Object.keys(paid).join(), "an unknown tx answers status none in exactly the key set of a known one");
const unknownBody = { ...unknown, tx: null }, noneBody = { ...publicRefundView("0x" + "77".repeat(32), null), tx: null };
ok(JSON.stringify(unknownBody) === JSON.stringify(noneBody), "and the body is identical apart from the echoed tx, so it does not say whether we ever saw the payment");

// no enumeration
throws400(() => refundLookup(TX_PAID.slice(0, 40)), "a PREFIX of a real tx is refused, never matched");
throws400(() => refundLookup("0x" + "%".repeat(64)), "a wildcard is refused");
throws400(() => refundLookup(`${PAYER_A}|no-tx-tool|12345`), "the payer|slug|minute fallback key is not a tx and is refused (it would name the payer)");
throws400(() => refundLookup(""), "an empty tx is refused");
throws400(() => refundLookup(`${TX_PAID},${TX_OWED}`), "two hashes in one ask are refused");
ok(lookupKeys(TX_PAID).length === 1 && lookupKeys("A".repeat(52)).length === 1, "an Algorand txid shape is accepted as-is");
ok(explorerTxUrl("stellar:pubnet", "ab") === "https://stellar.expert/explorer/public/tx/ab" && explorerTxUrl("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "X") === "https://allo.info/tx/X" && explorerTxUrl("eip155:4663", "0x1").includes("robinhood"), "explorer links cover the non-EVM and newer EVM rails");

// ---- identity-bound listing
const mine = refundsForPayer(PAYER_A.toLowerCase());
ok(mine.length === 4 && mine.every((r) => r.evidence !== TX_B && r.evidence !== TX_SOL), "refundsForPayer returns only that wallet's rows (EVM matched case-insensitively)");
ok(refundsForPayer(SOL_PAYER.toLowerCase()).length === 0 && refundsForPayer(SOL_PAYER).length === 1, "a base58 payer is matched exactly, never folded");
ok(refundsForPayer("").length === 0 && refundsForPayer(null).length === 0, "no payer, no rows");
const view = ownRefundsView(mine);
ok(view.count === 4 && view.paidUsd === 0.005 && view.owedUsd === 0.014 && view.rows.find((r) => r.status === "owed" && r.amountUsd === 0.004).tx === null, "the own-refunds view totals owed and paid and hides the fallback key (tx null), never the payer");

const myUsage = USAGE_TOOLS.find((t) => t.slug === "my-usage");
const reqFor = (from) => { const h = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from } } })).toString("base64"); return { header: (k) => (k === "payment-signature" ? h : undefined) }; };
const outA = await myUsage.handler({}, reqFor(PAYER_A));
ok(outA.refunds && outA.refunds.count === 4 && outA.refunds.rows.some((r) => r.tx === TX_PAID && r.refundTx === RF_PAID), "my-usage lists the signed payer's refunds with our refund tx");
ok(!JSON.stringify(outA.refunds).includes(TX_B), "and never another wallet's");
const outB = await myUsage.handler({}, reqFor(PAYER_B));
ok(outB.refunds.count === 1 && outB.refunds.rows[0].tx === TX_B, "control: the other wallet sees exactly its own row");
try { await myUsage.handler({}, { header: () => undefined }); ok(false, "an unsigned caller is refused"); } catch (e) { ok(e?.statusCode === 400, "an unsigned caller is refused (no refunds without the payment identity)"); }

// ---- the route, booted: free, same shape, rate limited
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", REVENUE_LEDGER_DB: join(dir, "rev.db"), POSTHOG_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; proc.stdout.on("data", (d) => { log += d; }); proc.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  const g = await fetch(`${base}/api/refunds/lookup?tx=${TX_PAID}`);
  const gj = await g.json();
  ok(g.status === 200 && gj.status === "paid" && gj.refundTx === RF_PAID && /no-store/.test(g.headers.get("cache-control") || ""), "GET /api/refunds/lookup answers free, uncached");
  const p = await fetch(`${base}/api/refunds/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: TX_OWED }) });
  ok(p.status === 200 && (await p.json()).status === "owed", "POST with { tx } answers the same");
  const u = await (await fetch(`${base}/api/refunds/lookup?tx=0x${"99".repeat(32)}`)).json();
  ok(u.status === "none" && Object.keys(u).join() === Object.keys(gj).join(), "unknown tx over HTTP: status none, same key set");
  const bad = await fetch(`${base}/api/refunds/lookup?tx=0xa1a1`);
  ok(bad.status === 400, "a malformed tx is a 400");
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) { const r = await fetch(`${base}/api/refunds/lookup?tx=0x${"98".repeat(32)}`); if (r.status === 429) limited = r; }
  ok(limited && limited.headers.get("retry-after") === "60", "a spray is rate limited with Retry-After");
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (fail) console.log(log.slice(-2000));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
