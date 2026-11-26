// The payment refusal record (src/payment-refusals.js) on a REAL Postgres
// (STATE_DATABASE_URL; CI fails without it): rows in the records table,
// repeats added to one row's count across two processes on one schema (an
// additive upsert, so neither overwrites the other), the payer only as
// verified (an EVM address lowercased, a base58 one exactly), a flood held to
// the day's row cap with the rest in the overflow row, the operator view's
// filters and per-day count by reason, a write that fails kept for the next
// flush, and the retention pass removing rows past 90 days.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-payment-refusals-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { requireTestPg } from "./lib/test-pg.js";
import { hookStatements } from "./lib/pg-statement-hook.js";
requireTestPg({ label: "test-payment-refusals-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sdb = await import("../src/state-db.js");
const A = await import("../src/payment-refusals.js?process=a");
const B = await import("../src/payment-refusals.js?process=b");
const T = `${sdb.stateDbSchema()}.records`;
const stored = async () => (await sdb.stateQuery(`SELECT body FROM ${T} WHERE collection = $1 ORDER BY id`, [A.PAYMENT_REFUSALS_COLLECTION])).rows.map((r) => r.body);
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

const DAY = Date.UTC(2026, 10, 20, 9, 0, 0);
const EVM = "0x" + "Cd".repeat(20);
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
let exit = 1;
try {
  await sdb.stateDb();
  ok(A !== B && A.paymentRefusalsStatus().store === "database", "two module instances (two processes) on the state database");
  // The same refusal from two processes adds up in one row.
  const one = { slug: "hash", routeClass: "direct", rail: "x402", network: "eip155:8453", reason: "insufficient_funds", status: 402, amountUsd: 0.001, payer: EVM };
  for (let i = 0; i < 3; i++) A.recordPaymentRefusal(one, { now: DAY + i });
  for (let i = 0; i < 2; i++) B.recordPaymentRefusal(one, { now: DAY + 100 + i });
  await A.flushPaymentRefusals(); await B.flushPaymentRefusals();
  A.recordPaymentRefusal(one, { now: DAY + 200 });
  await A.flushPaymentRefusals();
  let rows = await stored();
  ok(rows.length === 1 && rows[0].count === 6 && rows[0].payer === EVM.toLowerCase(), `repeats from two processes add to one row (rows ${rows.length}, count ${rows[0]?.count}, payer ${rows[0]?.payer})`);
  ok(rows[0].firstAt === new Date(DAY).toISOString() && rows[0].lastAt === new Date(DAY + 200).toISOString(), "the row keeps the first and the last time seen across both");
  // An unproven refusal names no payer; a base58 payer is kept exactly.
  A.recordPaymentRefusal({ ...one, payer: null, reason: "invalid_exact_evm_payload_signature" }, { now: DAY });
  A.recordPaymentRefusal({ ...one, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: SOL }, { now: DAY });
  A.recordPaymentRefusal({ ...one, payer: "not an address" }, { now: DAY });
  await A.flushPaymentRefusals();
  rows = await stored();
  ok(rows.filter((r) => r.payer === null).length === 2 && rows.some((r) => r.payer === SOL) && !JSON.stringify(rows).includes("not an address"), "an unproven or malformed payer is stored as null; a base58 payer exactly");

  // A write that fails is kept for the next flush.
  {
    A.recordPaymentRefusal({ ...one, reason: "kept-pending" }, { now: DAY });
    const pool = await sdb.stateDb();
    const unhook = hookStatements(pool, async (sql, _v, run) => { if (/INSERT INTO .*records/.test(sql)) throw new Error("statement refused by the test"); return run(); });
    const n0 = await quiet(() => A.flushPaymentRefusals());
    unhook();
    const pend = A.paymentRefusalsStatus().pending;
    const n1 = await A.flushPaymentRefusals();
    const kept = (await stored()).find((r) => r.reason === "kept-pending");
    ok(n0 === 0 && pend === 1 && n1 === 1 && kept?.count === 1, `a failed write keeps its count for the next flush, counted once (${n0}, pending ${pend}, then ${n1}, count ${kept?.count})`);
  }

  // A flood: the day's row cap holds; the rest is the overflow row.
  A.__resetPaymentRefusalsForTests();
  A.__setPaymentRefusalLimitsForTests({ keysPerDay: 40 });
  const FLOOD = Date.UTC(2026, 10, 21, 3, 0, 0);
  for (let i = 0; i < 3000; i++) A.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: i % 3 ? "invalid_payload" : "insufficient_funds", payer: "0x" + i.toString(16).padStart(40, "0") }, { now: FLOOD + i });
  await A.flushPaymentRefusals();
  const day = (await stored()).filter((r) => r.day === "2026-11-21");
  const over = day.find((r) => r.overflow);
  ok(day.length === 41 && over?.count === 2960 && day.reduce((t, r) => t + Number(r.count), 0) === 3000, `3000 distinct refusals: 40 rows and one overflow row, all counted (rows ${day.length}, overflow ${over?.count})`);
  // A second process's overflow adds by reason into the same row.
  B.__setPaymentRefusalLimitsForTests({ keysPerDay: 0 });
  B.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: "insufficient_funds", payer: null }, { now: FLOOD + 5000 });
  await B.flushPaymentRefusals();
  const over2 = (await stored()).find((r) => r.overflow && r.day === "2026-11-21");
  ok(over2?.count === 2961 && Number(over2.byReason.insufficient_funds) === over.byReason.insufficient_funds + 1, `another process's overflow adds into the day's overflow row by reason (${JSON.stringify(over2?.byReason)})`);

  // The operator view on the database.
  const f = (q) => A.refusalFiltersOf(q, { now: Date.UTC(2026, 10, 26) });
  const all = await A.paymentRefusalsView(f({ since: "2026-11-21" }), { limit: 5 });
  ok(all.matched === 41 && all.returned === 5 && all.summary.length === 1 && all.summary[0].total === 3001, `the view pages the day's rows and sums the overflow by reason (${all.matched}/${all.returned}, total ${all.summary[0]?.total})`);
  const byReason = await A.paymentRefusalsView(f({ since: "2026-11-21", reason: "insufficient_funds" }));
  const want = 1000 + 1;
  ok(byReason.summary[0]?.total === want && Object.keys(byReason.summary[0].byReason).join() === "insufficient_funds", `the reason filter counts only that code, inside the overflow row too (${JSON.stringify(byReason.summary[0])})`);
  const byPayer = await A.paymentRefusalsView(f({ payer: EVM.toUpperCase().replace("0X", "0x") }));
  ok(byPayer.matched === 2 && byPayer.rows.every((r) => r.payer === EVM.toLowerCase()) && byPayer.rows.some((r) => r.count === 6), `the payer filter finds the payer's two rows whatever the case (${byPayer.matched})`);
  const bySol = await A.paymentRefusalsView(f({ payer: SOL.toLowerCase() }));
  ok(bySol.matched === 0 && (await A.paymentRefusalsView(f({ payer: SOL }))).matched === 1, "a base58 payer filter is exact (another case finds nothing)");
  const bySlug = await A.paymentRefusalsView(f({ slug: "pdf-to-markdown" }));
  const sinceAt = await A.paymentRefusalsView(f({ since: new Date(DAY + 150).toISOString() }));
  ok(bySlug.matched === 0 && sinceAt.rows.every((r) => r.lastAt >= new Date(DAY + 150).toISOString()) && sinceAt.rows.some((r) => r.count === 6), "the slug filter and a since time narrow the rows");

  // Retention: rows past 90 days are removed (dry run counts only).
  const NOW = Date.UTC(2026, 10, 26, 12);
  A.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: "ancient" }, { now: NOW - 120 * 86_400_000 });
  await A.flushPaymentRefusals();
  const n0 = (await stored()).length;
  const dry = await A.prunePaymentRefusals({ now: NOW });
  const n1 = (await stored()).length;
  const wet = await A.prunePaymentRefusals({ now: NOW, apply: true });
  const left = await stored();
  ok(dry.due === 1 && dry.removed === 0 && n1 === n0 && wet.removed === 1 && left.length === n0 - 1 && !left.some((r) => r.reason === "ancient"), `the retention pass removes only the row past 90 days, dry run first (due ${dry.due}, removed ${wet.removed})`);
  exit = fail ? 1 : 0;
} catch (e) {
  console.error(`FAIL - ${e?.stack || e}`);
  exit = 1;
} finally {
  try { await sdb.__dropStateSchema(); } catch { /* best effort */ }
  try { await sdb.closeStateDb(); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(exit || (fail ? 1 : 0));
