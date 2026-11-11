// A buyer holds the settle receipt before the sale's row is readable: the
// sale is booked on the final response and its Postgres write is queued
// behind earlier writes. A lookup of that transaction made while the write is
// still queued (the attest and feedback routes, moments after the purchase)
// waits for it instead of answering "no sale". Here the write is held in
// Postgres by a table lock that blocks inserts and lets reads through.
//   STATE_DATABASE_URL=postgres://... node scripts/test-attest-queued-sale-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-attest-queued-sale-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "attest-queued-"));
process.env.SALES_LEDGER_DB = join(DIR, "sales.db");
process.env.LEDGER_MIRROR_REFRESH_MS = "3600000";
const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const TX1 = "0x" + "c1".repeat(32), TX2 = "0x" + "c2".repeat(32), TX3 = "0x" + "c3".repeat(32);

const sl = await import("../src/sales-ledger.js");
const { makeAttestHandler } = await import("../src/tools/attest-kit.js");
const { closeStateDb, __dropStateSchema } = await import("../src/state-db.js");
const locker = new pg.Client({ connectionString: url });
const tick = () => new Promise((r) => setImmediate(r));
// Until `test()` is true, or the deadline: an outcome, never a fixed pause.
async function until(test, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const insertWaiting = async () => (await locker.query(
  "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relname = 'sales' AND NOT l.granted", [schema])).rows[0].n > 0;
/** Book a sale whose write is held in Postgres, run `ask` while it is held, release, and report what `ask` did. */
async function whileSaleIsQueued(tx, ask) {
  await locker.query("BEGIN");
  await locker.query(`LOCK TABLE "${schema}".sales IN SHARE MODE`);
  let released = false;
  try {
    const landed = sl.recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: BUYER, tx, synthetic: false, wire: "x402", responseSha256: "ab".repeat(32) });
    let settled = null;
    const asked = ask().then((v) => { settled = { v }; return v; }, (e) => { settled = { e }; throw e; });
    asked.catch(() => {});
    const held = await until(insertWaiting);
    // Give an answer that does not wait every chance to arrive first.
    for (let i = 0; i < 50 && !settled; i++) await tick();
    const answeredWhileQueued = settled;
    const queued = sl.queuedSaleWrites();
    await locker.query("COMMIT"); released = true;
    const out = await asked.then((v) => ({ v }), (e) => ({ e }));
    await landed;
    return { held, answeredWhileQueued, queued, out };
  } finally {
    if (!released) await locker.query("ROLLBACK").catch(() => {});
  }
}

try {
  await locker.connect();
  await sl.salesLedgerReady();

  // 1. The ledger's own lookup.
  const a = await whileSaleIsQueued(TX1, () => sl.saleByTxFresh(TX1));
  ok(a.held, "the sale's insert was held in Postgres while the lookup ran");
  ok(a.queued.count === 1, `the queued write is counted while it waits (${JSON.stringify(a.queued)})`);
  ok(a.answeredWhileQueued === null, `a lookup of a sale whose write is queued does not answer before it lands (answered: ${JSON.stringify(a.answeredWhileQueued?.v ?? a.answeredWhileQueued?.e?.message ?? null)})`);
  ok(a.out.v?.tx === TX1 && a.out.v?.payer === BUYER, `the lookup answers the sale once its write lands (${JSON.stringify(a.out.v?.slug ?? a.out.e?.message ?? null)})`);
  ok(sl.queuedSaleWrites().count === 0, "nothing is counted as queued once the write has landed");

  // 2. The attest route's handler, as the buyer, moments after the purchase.
  const lines = [];
  const chain = { address: "0x77065d81e18ad403BCD6e9A0616b288e16744121", ensureSchema: async () => {}, estimateUsd: async () => 0.001, attest: async () => ({ uid: "0x" + "a1".repeat(32), attestTx: "0x" + "33".repeat(32), block: "1" }) };
  const spend = { maySpend: () => ({ ok: true }), noteSpend: () => ({ id: 1 }), adjustSpend: () => {}, reserveSpend: async () => ({ ok: true, handle: null }) };
  const asBuyer = makeAttestHandler({ chain, spend, payerOf: () => BUYER, log: (l) => lines.push(l) });
  const b = await whileSaleIsQueued(TX2, () => asBuyer({ tx: TX2 }));
  ok(b.held && b.answeredWhileQueued === null, `the buyer is not refused while the sale's write is queued (answered: ${JSON.stringify(b.answeredWhileQueued?.e?.statusCode ?? b.answeredWhileQueued?.v?.uid ?? null)})`);
  ok(b.out.v?.existing === false && /^0x[0-9a-f]{64}$/.test(b.out.v?.uid || "") && b.out.v?.data?.slug === "hash", `the buyer's attestation is written once the sale lands (${JSON.stringify(b.out.v?.uid?.slice(0, 10) ?? `${b.out.e?.statusCode} ${b.out.e?.message?.slice(0, 60)}`)})`);
  ok(lines.length === 0, "a served attestation logs no refusal");

  // 3. Payer attribution is unchanged: another wallet is refused for the
  //    landed sale, a hash that is no sale here is refused at once, and the
  //    log (never the answer) names which check refused.
  const asOther = makeAttestHandler({ chain, spend, payerOf: () => OTHER, log: (l) => lines.push(l) });
  const r1 = await asOther({ tx: TX2 }).then(() => null, (e) => e);
  const r2 = await asBuyer({ tx: TX3 }).then(() => null, (e) => e);
  ok(r1?.statusCode === 403 && r2?.statusCode === 403, `another wallet and an unknown hash are both refused 403 (${r1?.statusCode} / ${r2?.statusCode})`);
  ok(r1 && r2 && r1.message.replace(TX2, "") === r2.message.replace(TX3, ""), "the two refusals read the same to the caller");
  ok(lines.length === 2 && lines[0].includes("(other_payer)") && lines[1].includes("(no_sale)"), `the log names each refusal's check (${JSON.stringify(lines.map((l) => l.slice(0, 40)))})`);
  ok(lines.every((l) => !l.includes(BUYER) && !l.includes(OTHER) && !l.includes(TX2) && !l.includes(TX3) && l.includes("queuedSaleWrites=0")), "a refusal line carries short identifiers and the queued-write count, never a full address or hash");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await locker.end().catch(() => {});
  await sl.salesLedgerFlush().catch(() => {});
  await __dropStateSchema?.().catch(() => {});
  await closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-attest-queued-sale-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
