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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

const dir = mkdtempSync(join(tmpdir(), "refund-lookup-"));
process.env.REFUND_DB_DIR = dir;
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
const { recordRefundOwed, markRefundPaid, markRefundVoid, listRefunds, refundsForPayer, claimRefundForSend, refundByEvidence } = await import("../src/refund-ledger.js");
const { referralRefundWriter, referralRefundEvidence } = await import("../src/referral-gate.js");
const { refundMemo } = await import("./refund-run.js");
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
const TX_SEND = "0x" + "f6".repeat(32);
const STELLAR_TX = "ab".repeat(32);

recordRefundOwed({ slug: "secret-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.005, tx: TX_PAID, httpStatus: 502, note: "internal note: upstream X failed" });
recordRefundOwed({ slug: "other-tool", network: "eip155:137", payer: PAYER_A, priceUsd: 0.01, tx: TX_OWED, httpStatus: 500, note: "internal note: owed detail" });
recordRefundOwed({ slug: "void-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.002, tx: TX_VOID, httpStatus: 499 });
recordRefundOwed({ slug: "b-tool", network: "eip155:8453", payer: PAYER_B, priceUsd: 0.05, tx: TX_B, httpStatus: 502 });
recordRefundOwed({ slug: "sol-tool", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: SOL_PAYER, priceUsd: 0.003, tx: TX_SOL, httpStatus: 502 });
recordRefundOwed({ slug: "no-tx-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.004, httpStatus: 502 }); // payer|slug|minute fallback key
recordRefundOwed({ slug: "send-tool", network: "eip155:42220", payer: PAYER_B, priceUsd: 0.02, tx: TX_SEND, httpStatus: 499, hangupReason: "settled in flight" });
recordRefundOwed({ slug: "xlm-tool", network: "stellar:pubnet", payer: "G" + "A".repeat(55), priceUsd: 0.001, tx: STELLAR_TX, httpStatus: 502 });
const rows = listRefunds({ status: "all" });
const idOf = (tx) => rows.find((r) => r.evidence === tx).id;
ok(claimRefundForSend(idOf(TX_PAID)) && markRefundPaid(idOf(TX_PAID), RF_PAID), "fixture: one refund claimed and paid");
ok(markRefundVoid(idOf(TX_VOID), "served after all"), "fixture: one refund voided");
ok(claimRefundForSend(idOf(TX_SEND)), "fixture: one refund claimed for sending");

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

// every status, with found / priceUsd / the payment's explorer link
const KEYS = "tx,found,status,priceUsd,amountUsd,network,chain,txUrl,refundTx,refundTxUrl,refundedAt,note,refunds";
ok(Object.keys(paid).join() === KEYS, `the answer carries exactly the public fields (${Object.keys(paid).join()})`);
ok(paid.found === true && paid.priceUsd === 0.005 && paid.txUrl === `https://basescan.org/tx/${TX_PAID}`, "paid: found, the call's price and the payment on its explorer");
const sending = refundLookup(TX_SEND);
ok(sending.status === "sending" && sending.found === true && sending.refundTx === null && sending.priceUsd === 0.02 && sending.chain === "celo" && sending.txUrl === `https://celoscan.io/tx/${TX_SEND}`, "a refund being sent answers sending, with no refund tx yet");
ok(refundLookup(STELLAR_TX).status === "owed" && refundLookup(STELLAR_TX).txUrl === `https://stellar.expert/explorer/public/tx/${STELLAR_TX}`, "a Stellar transaction id (64 hex, no 0x) is looked up");
ok(owed.found === true && refundLookup(TX_VOID).found === true, "owed and void are found");
for (const t of [TX_PAID, TX_OWED, TX_VOID, TX_SEND, STELLAR_TX]) {
  const blobT = JSON.stringify(refundLookup(t));
  ok(![PAYER_A, PAYER_B, SOL_PAYER].some((p) => blobT.toLowerCase().includes(p.toLowerCase().slice(2))) && !/-tool|internal note|served after all|settled in flight|"id"|evidence|hangup|httpStatus|createdAt/.test(blobT), `the answer for ${t.slice(0, 10)} carries no payer, tool, note, hang-up reason or internal id`);
}
// a wallet address is never a key, on any rail
throws400(() => refundLookup(PAYER_A), "an EVM wallet address is refused (0x + 40 hex is not a transaction)");
throws400(() => refundLookup(SOL_PAYER), "a Solana wallet address is refused (a signature is 64 to 90 base58 characters)");
throws400(() => refundLookup("G" + "A".repeat(55)), "a Stellar account is refused");
throws400(() => refundLookup("A".repeat(58)), "an Algorand address is refused (a transaction id is 52 characters)");

// unknown vs no refund: same shape, same status
const unknown = refundLookup("0x" + "99".repeat(32));
ok(unknown.status === "none" && unknown.found === false && unknown.priceUsd === null && unknown.txUrl === null && Object.keys(unknown).join() === Object.keys(paid).join(), "an unknown tx answers status none, found false, in exactly the key set of a known one");
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

// ---- a payment keyed by its own authorization (the referral rail writes
// `<tx>#<nonce>`, one row per payment, so two payments settled in one
// transaction are two debts): the buyer holds the TRANSACTION, and the lookup
// by transaction finds every row of it.
const TX_REF = "0x" + "5e".repeat(32), TX_REF1 = "0x" + "6f".repeat(32);
const N1 = "0x" + "01".repeat(32), N2 = "0x" + "02".repeat(32);
const oweReferral = referralRefundWriter({ recordRefundOwed, refundByEvidence });
ok(await oweReferral({ slug: "ref-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.03, tx: TX_REF1, evidenceKey: referralRefundEvidence(TX_REF1, N1), httpStatus: 409, wire: "referral" }) === true
  && await oweReferral({ slug: "ref-tool", network: "eip155:8453", payer: PAYER_A, priceUsd: 0.01, tx: TX_REF, evidenceKey: referralRefundEvidence(TX_REF, N1), httpStatus: 409, wire: "referral" }) === true
  && await oweReferral({ slug: "ref-tool", network: "eip155:8453", payer: PAYER_B, priceUsd: 0.02, tx: TX_REF, evidenceKey: referralRefundEvidence(TX_REF, N2), httpStatus: 409, wire: "referral-operator" }) === true, "fixture: three referral debts written by the gate's own writer, two of them in one transaction");
const one = refundLookup(TX_REF1);
ok(one.status === "owed" && one.found === true && one.priceUsd === 0.03 && one.chain === "base" && one.txUrl === `https://basescan.org/tx/${TX_REF1}` && one.refunds.length === 1 && one.refunds[0].status === "owed" && one.refunds[0].priceUsd === 0.03, `a debt keyed by its authorization is found by its transaction: owed, never "none" (${one.status}, ${one.refunds?.length} listed)`);
ok(refundLookup(TX_REF1.toUpperCase().replace("0X", "0x")).status === "owed", "in either hex case");
const two = refundLookup(TX_REF);
ok(two.status === "owed" && two.refunds.length === 2 && two.refunds.map((r) => r.priceUsd).sort().join() === "0.01,0.02" && two.refunds.every((r) => r.status === "owed"), `two payments settled in one transaction are both listed, each with its own status and amount (${two.refunds?.map((r) => `${r.status} ${r.priceUsd}`).join("; ")})`);
const allRows = listRefunds({ status: "all" });
const refId = (ev) => allRows.find((r) => r.evidence === ev).id;
const RF_REF = "0x" + "7a".repeat(32);
ok(claimRefundForSend(refId(referralRefundEvidence(TX_REF, N1))) && markRefundPaid(refId(referralRefundEvidence(TX_REF, N1)), RF_REF), "fixture: one of the two is repaid");
const mixed = refundLookup(TX_REF);
ok(mixed.status === "owed" && mixed.priceUsd === 0.02 && mixed.refundTx === null && mixed.refunds.find((r) => r.priceUsd === 0.01)?.status === "paid" && mixed.refunds.find((r) => r.priceUsd === 0.01)?.refundTx === RF_REF && mixed.refunds.find((r) => r.priceUsd === 0.02)?.status === "owed", "with one repaid and one owed the answer leads with the one still owed, and each row says its own");
const refBlob = JSON.stringify([one, two, mixed]);
ok(![PAYER_A, PAYER_B].some((p) => refBlob.toLowerCase().includes(p.toLowerCase().slice(2))) && !refBlob.includes(N1.slice(2)) && !refBlob.includes(N2.slice(2)) && !/ref-tool|referral|evidence|"id"/.test(refBlob), "and none of it carries a payer, a tool, a wire or the authorization's nonce");
throws400(() => refundLookup(referralRefundEvidence(TX_REF, N1)), "the keyed form itself is not a transaction and is refused");
ok(refundLookup("0x" + "5e".repeat(31) + "5f").status === "none" && refundLookup(TX_REF).refunds.length === 2 && refundLookup("0x" + "99".repeat(32)).refunds.length === 0, "a neighboring hash matches nothing (no prefix search), and an unknown one lists nothing");
ok(refundMemo({ evidence: referralRefundEvidence(TX_REF, N1) }) === `agent402 refund for ${TX_REF}` && refundMemo({ evidence: TX_PAID }) === `agent402 refund for ${TX_PAID}` && refundMemo({ evidence: `${PAYER_A}|x|1` }) === "agent402 refund", "the refund's memo names the settlement transaction for a keyed row too, and never a fallback key");
const mineRef = ownRefundsView(refundsForPayer(PAYER_B)).rows.find((r) => r.amountUsd === 0.02 && r.status === "owed");
ok(mineRef?.tx === TX_REF && mineRef.txUrl === `https://basescan.org/tx/${TX_REF}`, `the payer's own listing shows the transaction of a keyed row (${mineRef?.tx})`);

// ---- identity-bound listing
const mine = refundsForPayer(PAYER_A.toLowerCase()).filter((r) => !String(r.evidence).includes("#"));
ok(mine.length === 4 && mine.every((r) => r.evidence !== TX_B && r.evidence !== TX_SOL), "refundsForPayer returns only that wallet's rows (EVM matched case-insensitively)");
ok(refundsForPayer(SOL_PAYER.toLowerCase()).length === 0 && refundsForPayer(SOL_PAYER).length === 1, "a base58 payer is matched exactly, never folded");
ok(refundsForPayer("").length === 0 && refundsForPayer(null).length === 0, "no payer, no rows");
const view = ownRefundsView(mine);
ok(view.count === 4 && view.paidUsd === 0.005 && view.owedUsd === 0.014 && view.rows.find((r) => r.status === "owed" && r.amountUsd === 0.004).tx === null, "the own-refunds view totals owed and paid and hides the fallback key (tx null), never the payer");
ok(view.rows.find((r) => r.amountUsd === 0.004).txUrl === null, "a fallback ledger key never becomes an explorer link (it would name the payer)");

const myUsage = USAGE_TOOLS.find((t) => t.slug === "my-usage");
const reqFor = (from) => { const h = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from } } })).toString("base64"); return { header: (k) => (k === "payment-signature" ? h : undefined) }; };
const outA = await myUsage.handler({}, reqFor(PAYER_A));
ok(outA.refunds && outA.refunds.count === 6 && outA.refunds.rows.some((r) => r.tx === TX_PAID && r.refundTx === RF_PAID), "my-usage lists the signed payer's refunds with our refund tx");
ok(!JSON.stringify(outA.refunds).includes(TX_B), "and never another wallet's");
const outB = await myUsage.handler({}, reqFor(PAYER_B));
ok(outB.refunds.count === 3 && outB.refunds.rows.every((r) => r.tx === TX_B || r.tx === TX_SEND || r.tx === TX_REF) && outB.refunds.rows.every((r) => !("refunds" in r)), "control: the other wallet sees exactly its own rows");
try { await myUsage.handler({}, { header: () => undefined }); ok(false, "an unsigned caller is refused"); } catch (e) { ok(e?.statusCode === 400, "an unsigned caller is refused (no refunds without the payment identity)"); }

// ---- the route, booted: free, same shape, rate limited
// stores: false: the server reads the ledger this process wrote above.
let log = "";
const srv = await bootServer({
  stores: false,
  env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", REVENUE_LEDGER_DB: join(dir, "rev.db"), POSTHOG_API_KEY: "" },
}).catch((e) => { log = e.message; return null; });
const proc = srv?.child;
const base = srv?.url;
try {
  ok(Boolean(srv), "server booted");
  const g = await fetch(`${base}/api/refunds/lookup?tx=${TX_PAID}`);
  const gj = await g.json();
  ok(g.status === 200 && gj.status === "paid" && gj.refundTx === RF_PAID && /no-store/.test(g.headers.get("cache-control") || ""), "GET /api/refunds/lookup answers free, uncached");
  const p = await fetch(`${base}/api/refunds/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: TX_OWED }) });
  ok(p.status === 200 && (await p.json()).status === "owed", "POST with { tx } answers the same");
  const u = await (await fetch(`${base}/api/refunds/lookup?tx=0x${"99".repeat(32)}`)).json();
  ok(u.status === "none" && Object.keys(u).join() === Object.keys(gj).join(), "unknown tx over HTTP: status none, same key set");
  const bad = await fetch(`${base}/api/refunds/lookup?tx=0xa1a1`);
  ok(bad.status === 400, "a malformed tx is a 400");
  const short = await fetch(`${base}/api/refunds?tx=${TX_SEND}`);
  const sj = await short.json();
  ok(short.status === 200 && sj.status === "sending" && sj.found === true && sj.priceUsd === 0.02 && /no-store/.test(short.headers.get("cache-control") || ""), "GET /api/refunds?tx= answers the same lookup, free and uncached");
  ok((await fetch(`${base}/api/refunds?payer=${PAYER_B}`)).status === 400 && (await fetch(`${base}/api/refunds`)).status === 400, "no tx, no answer: /api/refunds never lists rows or takes a wallet");
  ok((await fetch(`${base}/api/refunds?tx=${PAYER_B}`)).status === 400, "a wallet address as tx is a 400 over HTTP");
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  const op = spec?.paths?.["/api/refunds"]?.get;
  ok(/one transaction's payments/.test(op?.summary || "") && /one transaction per ask/.test(op?.responses?.[200]?.description || "") && /One transaction per ask; never a wallet's list/.test(op?.description || "") && !/one payment/i.test(`${op?.summary} ${op?.responses?.[200]?.description} ${op?.description}`), "the published lookup text says one transaction per ask, in its summary, description and 200 answer");
  ok(op && Array.isArray(op.security) && op.security.length === 0 && op.parameters?.[0]?.name === "tx" && op.responses?.[200]?.content?.["application/json"]?.schema?.properties?.status?.enum?.join() === "owed,sending,paid,void,none" && !("payer" in (op.responses[200].content["application/json"].schema.properties || {})), "openapi documents GET /api/refunds: free, one tx, every status, no payer field");
  // The sweep (scripts/test-all.js buildGetUrl) calls each GET with its
  // published parameter examples: both names must publish a tx that answers 200.
  for (const path of ["/api/refunds", "/api/refunds/lookup"]) {
    const ex = spec?.paths?.[path]?.get?.parameters?.find((p) => p.name === "tx")?.example;
    const r = typeof ex === "string" ? await fetch(`${base}${path}?tx=${encodeURIComponent(ex)}`) : null;
    const rj = r ? await r.json() : null;
    ok(r?.status === 200 && typeof rj?.status === "string" && rj.tx === ex, `openapi ${path} publishes a tx example the server answers 200 to (${r?.status ?? "no example"})`);
  }
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  ok(/\/api\/refunds\]\([^)]*\/api\/refunds\?tx=\): free refund status of one transaction's payments/.test(llms), "llms.txt names the refund lookup");
  const llmsFull = await (await fetch(`${base}/llms-full.txt`)).text();
  ok(/\/api\/refunds\]\([^)]*\/api\/refunds\?tx=\): free refund status of one transaction's payments/.test(llmsFull) && /`refunds` \(every refund recorded for that transaction/.test(llmsFull) && !/free refund status for one payment/.test(llms + llmsFull), "llms-full.txt names it the same way, with the refunds list");
  let limited = null, n = 0;
  for (let i = 0; i < 40 && !limited; i++) { const r = await fetch(`${base}/api/refunds${i % 2 ? "/lookup" : ""}?tx=0x${"98".repeat(32)}`); n++; if (r.status === 429) limited = r; }
  ok(limited && limited.headers.get("retry-after") === "60", `a spray is rate limited with Retry-After, both names in one bucket (429 after ${n})`);
} finally {
  proc?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (fail) console.log((srv ? srv.log() : log).slice(-2000));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
