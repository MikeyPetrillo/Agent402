// The issued-receipt store and the audit report on a REAL Postgres
// (src/receipt-store.js, src/tools/audit-report-kit.js with
// STATE_DATABASE_URL): the table is created once by two loaders at once, a
// receipt is written once however often it is offered, a lookup never
// returns another payer's receipt, the sweep bounds the table by age and by
// rows, a write the database refused is kept and lands on the retry, and the
// report reads the sales mirror and the receipt rows together.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-audit-report-pg" });
const dir = mkdtempSync(join(tmpdir(), "a402-audit-pg-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.RECEIPT_STORE_DB = join(dir, "receipts.db");
delete process.env.FREE_MODE;
const sdb = await import("../src/state-db.js");
const store = await import("../src/receipt-store.js");
const { recordSale, salesLedgerFlush } = await import("../src/sales-ledger.js");
const kit = await import("../src/tools/audit-report-kit.js");
const { loadReceiptKeys, buildReceiptRecord, signReceipt, verifyReceipt } = await import("../src/receipt-signing.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T = `${sdb.stateDbSchema()}.issued_receipts`;
const count = async () => Number((await sdb.stateQuery(`SELECT COUNT(*) AS n FROM ${T}`)).rows[0].n);
const pemB64 = (k) => Buffer.from(k.export({ format: "pem", type: "pkcs8" })).toString("base64");
const { signer, keys } = loadReceiptKeys({ RECEIPT_SIGNING_KEY: pemB64(generateKeyPairSync("ed25519").privateKey), RECEIPT_SIGNING_KEY_ID: "p1" });
const A = "0xaaaa00000000000000000000000000000000000a";
const B = "0xbbbb00000000000000000000000000000000000b";
const rec = (payer, settlement, now = Date.now(), rail = "x402") => buildReceiptRecord({ method: "POST", path: "/api/hash", slug: "hash", requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), priceUsd: 0.001, rail, network: "eip155:8453", payer, settlement, now });

try {
  ok(store.receiptStoreBackend === "pg", "the store is on the database");
  // Two writes at once on an empty schema: one table, both rows.
  const r1 = rec(A, "0xp1"), r2 = rec(A, "0xp2");
  const [w1, w2] = await Promise.all([store.storeIssuedReceipt(signReceipt(r1, signer), r1), store.storeIssuedReceipt(signReceipt(r2, signer), r2)]);
  await store.receiptStoreFlush();
  ok(w1 !== false && (await count()) === 2, "two writes on an empty schema create the table once and land");
  // Offered again (an idempotent replay of the same bytes): written once.
  await store.storeIssuedReceipt(signReceipt(r1, signer), r1);
  await store.receiptStoreFlush();
  ok((await count()) === 2, "the same receipt offered twice is one row (its id is unique)");
  // Another payer's receipt under A's settlement, and a Tempo one with no payer yet.
  const rb = rec(B, "0xp1");
  const rt = rec(null, "0xp3", Date.now(), "mpp-tempo");
  await store.storeIssuedReceipt(signReceipt(rb, signer), rb);
  await store.storeIssuedReceipt(signReceipt(rt, signer), rt);
  await store.receiptStoreFlush();
  const got = await store.receiptsForSettlements(A, ["0xp1", "0xp2", "0xp3"]);
  ok(got.get("0xp1").length === 1 && got.get("0xp1")[0].payer === A && got.get("0xp2").length === 1 && got.get("0xp3")[0].payer === null, "a lookup returns this payer's receipts and the payer-less Tempo one, never another payer's under the same settlement");
  ok((await store.receiptsForSettlements(B, ["0xp2"])).size === 0, "another payer reads none of A's");

  // A write the database refuses is queued and lands on the next drain.
  const saved = process.env.STATE_DB_SCHEMA;
  const rq = rec(A, "0xq1");
  const pgCount = store.receiptStoreCounts().failed;
  // Point the next insert at a schema that is not there: the statement fails.
  process.env.STATE_DB_SCHEMA = "no_such_schema_x";
  const res = await store.storeIssuedReceipt(signReceipt(rq, signer), rq);
  process.env.STATE_DB_SCHEMA = saved;
  ok(res === false && store.receiptStoreCounts().failed > pgCount && store.receiptStoreCounts().pending === 1, "a write the database refused is kept pending, not dropped");
  await store.receiptStoreFlush();
  ok(store.receiptStoreCounts().pending === 0 && (await store.receiptsForSettlements(A, ["0xq1"])).get("0xq1")?.length === 1, "and lands on the next drain");

  // The sweep: by age, then by rows.
  const old = rec(A, "0xold", Date.now() - 500 * 86_400_000);
  await store.storeIssuedReceipt(signReceipt(old, signer), old);
  await store.receiptStoreFlush();
  const s1 = await store.sweepIssuedReceipts({ days: 400, maxRows: 1_000_000 });
  ok(s1.aged === 1 && !(await store.receiptsForSettlements(A, ["0xold"])).has("0xold"), "the sweep deletes a receipt past the retention");
  const before = await count();
  const s2 = await store.sweepIssuedReceipts({ days: 3650, maxRows: 2 });
  ok(s2.over === before - 2 && (await count()) === 2, `past the row bound the oldest go first (${before} -> 2)`);

  // The report on the database: sales mirror + receipt rows.
  const now = Date.now();
  await recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "0xr1", wire: "x402" });
  await recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: B, tx: "0xr2", wire: "x402" });
  await salesLedgerFlush?.();
  const rr = rec(A, "0xr1", now);
  const jws = signReceipt(rr, signer);
  await store.storeIssuedReceipt(jws, rr);
  await store.receiptStoreFlush();
  const h = kit.makeAuditReportHandler({ payerOf: () => A, signer: () => signer, refresh: async () => {} });
  const out = await h({}, { headers: {} });
  ok(out.report.rows.length === 1 && out.report.rows[0].settlement === "0xr1" && out.report.rows[0].receipt === jws, "the report reads the wallet's sale and its kept receipt from the database");
  ok(verifyReceipt(out.summaryReceipt, { keys, responseBody: JSON.stringify(out.report) }).valid, "its summary verifies");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
