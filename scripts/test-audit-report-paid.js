#!/usr/bin/env node
// The audit report on a PAID server with a receipt key (the paid-wires rig:
// every wire settles against local stubs, nothing leaves this machine).
//
// One wallet pays on the x402 wire, the MPP evm wire and Tempo, a second
// wallet pays too, a failed answer and a refused settle are tried; then:
//   - the first wallet's report holds exactly its own settled calls, each
//     row carrying the very receipt that call's Agent402-Receipt header
//     carried, and POST /api/receipts/verify accepts each one and the
//     report's summary receipt (and refuses a changed report);
//   - the second wallet's report holds none of the first's;
//   - the route offers EVM x402 only (no Tempo, no Solana): the payment is
//     the identity;
//   - the CSV form verifies over its bytes;
//   - the receipt store holds a receipt for each final 200 on a stored rail
//     and nothing for the failed answer or the refused settle.
import "./lib/offline-stores.js";
import "./lib/file-mode.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";
import { RECEIPT_HEADER, RECEIPT_VERIFY_PATH } from "../src/receipt-signing.js";

const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const viemTempo = await import("viem/tempo");

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const pemB64 = (k) => Buffer.from(k.export({ format: "pem", type: "pkcs8" })).toString("base64");
const KP = generateKeyPairSync("ed25519");
const storeDir = mkdtempSync(join(tmpdir(), "a402-audit-paid-"));
const RECEIPT_STORE_DB = join(storeDir, "receipts.db");
const HASH = { method: "POST", path: "/api/hash", body: { text: "audit" } };
const UUID = { method: "POST", path: "/api/uuid", body: { count: 1 } };
const DUB = { method: "POST", path: "/api/dub", body: { text: "hello world", targetLanguage: "es" } };
const AUDIT = (body = {}) => ({ method: "POST", path: "/api/audit-report", body });
const verifyApi = async (receipt, body) => (await fetch(`${rig.url}${RECEIPT_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt, body }) })).json();

rig = await bootPaidWires({ label: "audit-paid", env: { RECEIPT_SIGNING_KEY: pemB64(KP.privateKey), RECEIPT_SIGNING_KEY_ID: "a1-test", RECEIPT_STORE_DB } });
try {
  // One key, one address, three wires.
  const k = generatePrivateKey();
  const acct = privateKeyToAccount(k);
  const addr = acct.address;
  const A = { wire: "evm", id: `evm:${addr.toLowerCase()}`, address: addr };
  const Ampp = { ...A, wire: "mpp-evm" };
  const Atempo = { wire: "tempo", id: `tempo:${addr.toLowerCase()}`, address: addr, account: acct, root: viemTempo.Account.fromSecp256k1(k) };
  rig.fund(A, 10n ** 12n);
  rig.fund(Atempo, 10n ** 12n);
  const B = await rig.wallet("evm");
  rig.fund(B, 10n ** 12n);

  // The route is identity-bound: EVM x402 only, no Tempo or card challenge.
  {
    const o = await rig.offerOf(AUDIT());
    const nets = (o.offer?.accepts || []).map((a) => a.network);
    await ok(o.status === 402 && nets.length > 0 && nets.every((n) => n.startsWith("eip155:")), `the 402 offers EVM networks only (${[...new Set(nets)].join(", ")})`);
    await ok(!o.challenges.some((c) => c.method === "tempo" || c.method === "stripe"), "no Tempo or card challenge: those carry no signed wallet");
  }

  const served = []; // { settlement, receipt, text, rail }
  for (const [w, route, rail] of [[A, HASH, "x402"], [Ampp, UUID, "mpp-evm"], [Atempo, HASH, "mpp-tempo"], [A, UUID, "x402"]]) {
    const r = await rig.pay(w, route);
    const receipt = r.headers.get(RECEIPT_HEADER);
    await ok(r.status === 200 && !!receipt, `${rail}: a settled 200 with a receipt (${r.status})`);
    const rec = JSON.parse(Buffer.from(receipt.split(".")[1], "base64url").toString("utf8"));
    served.push({ settlement: rec.settlement, receipt, text: r.text, rail: rec.rail });
  }
  // A failed answer and a refused settle: no receipt, no row, nothing kept.
  rig.st.llmStatus = 500;
  const failed = await rig.pay(A, DUB);
  rig.st.llmStatus = 0;
  await ok(failed.status >= 400 && !failed.headers.get(RECEIPT_HEADER), `a failed answer (${failed.status}) carries no receipt`);
  const poor = await rig.wallet("evm");
  rig.fund(poor, 1n);
  const refused = await rig.pay(poor, HASH);
  await ok(refused.status === 402 && !refused.headers.get(RECEIPT_HEADER), "a refused settle carries no receipt");
  const rb = await rig.pay(B, HASH);
  await ok(rb.status === 200, "a second wallet pays");
  const bSettlement = JSON.parse(Buffer.from(rb.headers.get(RECEIPT_HEADER).split(".")[1], "base64url").toString("utf8")).settlement;
  await sleep(500); // the sale rows land on the response's settle outcome

  // The first wallet's report.
  const rep = await rig.pay(A, AUDIT({}));
  await ok(rep.status === 200 && rep.json?.report, `the audit report answers 200 (${rep.status} ${rep.text.slice(0, 160)})`);
  const report = rep.json.report;
  await ok(report.wallet === addr.toLowerCase(), "it is the paying wallet's report");
  const settlements = report.rows.map((r) => r.settlement);
  await ok(served.every((s) => settlements.includes(s.settlement)) && report.rows.length === served.length, `it holds every call that wallet settled, on every wire, and nothing else (${report.rows.length} rows)`);
  await ok(!settlements.includes(bSettlement) && !rep.text.includes(B.address.slice(2).toLowerCase()), "nothing of the other wallet's");
  for (const s of served) {
    const row = report.rows.find((r) => r.settlement === s.settlement);
    await ok(row.receipt === s.receipt && row.rail === s.rail, `${s.rail}: the row carries the exact receipt its call's ${RECEIPT_HEADER} header carried`);
    const v = await verifyApi(row.receipt, s.text);
    await ok(v.valid === true && v.record.settlement === s.settlement, `${s.rail}: POST ${RECEIPT_VERIFY_PATH} verifies it against the bytes that call served`);
  }
  const sum = await verifyApi(rep.json.summaryReceipt, JSON.stringify(report));
  await ok(sum.valid === true && sum.record.payer === addr.toLowerCase() && sum.record.rail === "audit-summary", "the summary receipt verifies over the report through the public check");
  const t = JSON.parse(JSON.stringify(report)); t.rows[0].priceUsd = 99;
  const bad = await verifyApi(rep.json.summaryReceipt, JSON.stringify(t));
  await ok(bad.valid === false && bad.reason === "response_mismatch", "a changed report fails it");
  await ok(!!rep.headers.get(RECEIPT_HEADER), "the report's own call carries its payment receipt too");
  await ok(report.totals.calls === served.length && report.byTool.length === 2 && report.complete === true, "totals by tool cover the window");

  // The second wallet's report.
  const repB = await rig.pay(B, AUDIT({}));
  await ok(repB.status === 200 && repB.json.report.rows.map((r) => r.settlement).join() === bSettlement && !served.some((s) => repB.text.includes(s.settlement)), "the second wallet's report holds only its own call");

  // CSV.
  const csv = await rig.pay(A, AUDIT({ format: "csv" }));
  await ok(csv.status === 200 && /^text\/csv/.test(csv.headers.get("content-type") || ""), `format csv answers text/csv (${csv.status})`);
  const csvSum = await verifyApi(csv.headers.get("agent402-audit-summary"), csv.text);
  await ok(csvSum.valid === true && csvSum.record.payer === addr.toLowerCase(), "its summary header verifies over the CSV bytes");

  // The store: one kept receipt per final 200 on a stored rail, the report
  // calls included; none for the failed answer or the refused settle.
  await sleep(200);
  const db = new Database(RECEIPT_STORE_DB, { readonly: true });
  const rows = db.prepare("SELECT payer, rail, settlement FROM issued_receipts").all();
  db.close();
  const paid200 = served.length + 1 /* B */ + 3 /* A report, B report, A csv */;
  await ok(rows.length === paid200, `the store holds one receipt per settled 200 (${rows.length} of ${paid200})`);
  await ok(rows.every((r) => r.payer === null || /^0x[0-9a-f]{40}$/.test(r.payer)), "each is keyed by an EVM payer (or a Tempo settlement)");
} finally { await rig.stop(); rig = null; }

// Without a key: no receipts kept, and the report says no summary is issued.
rig = await bootPaidWires({ label: "audit-paid-off", env: { RECEIPT_STORE_DB: join(storeDir, "off.db") } });
try {
  const w = await rig.wallet("evm");
  rig.fund(w, 10n ** 12n);
  await rig.pay(w, HASH);
  await sleep(300);
  const r = await rig.pay(w, AUDIT({}));
  await ok(r.status === 200 && r.json.summaryReceipt === null && /not issued/.test(r.json.note) && r.json.report.rows.length === 1 && r.json.report.rows[0].receipt === null, "no key: the report holds the settled call with no receipt and no summary, and says why");
} finally { await rig.stop(); rig = null; }

console.log(`\n${pass} passed`);
