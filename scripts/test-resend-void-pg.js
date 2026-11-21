// A charged answer that was never delivered is owed back until a resend of
// the same payment is actually served (src/server.js onReplay, the stored
// answer is kept for IDEM_TTL_MS). The void that resend takes is written now
// or not at all: one the database did not confirm is never replayed later,
// so a buyer who was told to retry and never did keeps the debt owed.
// Against a REAL Postgres (STATE_DATABASE_URL; CI fails without it), behind a
// TCP relay the test cuts.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-resend-void-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
delete process.env.REDIS_URL;
const { url, schema } = requireTestPg({ label: "test-resend-void-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "resend-void-pg-"));

// ---- a TCP relay in front of Postgres the test can cut and heal ----
const target = new URL(url);
let cut = false;
const live = new Set();
const relay = createServer((client) => {
  if (cut) { client.destroy(); return; }
  live.add(client);
  client.on("error", () => client.destroy()); client.on("close", () => live.delete(client));
  const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
  live.add(up);
  client.on("data", (d) => up.write(d));
  up.on("data", (d) => client.write(d));
  const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
  up.on("error", drop); client.on("close", drop); up.on("close", drop);
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const cutRelay = () => { cut = true; for (const s of live) s.destroy(); live.clear(); };
const healRelay = () => { cut = false; };
process.env.STATE_DATABASE_URL = `${target.protocol}//${target.username ? `${target.username}${target.password ? ":" + target.password : ""}@` : ""}127.0.0.1:${relay.address().port}${target.pathname}${target.search}`;
process.env.STATE_DB_SCHEMA = schema;
process.env.STATE_DB_QUERY_TIMEOUT_MS = "2500";
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "2000";
process.env.REFUND_DB_DIR = DIR;
process.env.LEDGER_MIRROR_MARGIN_MS = "400";

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const { chargedReplayVerdict, RESEND_SERVED_NOTE } = await import("../src/idempotency.js");
const T = `${schema}.refunds`, M = `${schema}.refund_marks`;
const NOTE = RESEND_SERVED_NOTE || "served on the resend of the same payment";
const rowOf = async (ev) => (await sdb.stateQuery(`SELECT * FROM ${T} WHERE evidence = $1`, [ev])).rows[0] || null;
const markOf = async (ev) => (await sdb.stateQuery(`SELECT state FROM ${M} WHERE evidence = $1`, [ev])).rows[0]?.state ?? null;
const voidOnResend = (ev) => (rl.voidOwedOnResend || rl.voidOwedOnClaim)(ev, NOTE);
const debt = async (tx, n) => rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0x" + String(n).repeat(40).slice(0, 40), priceUsd: 0.01, tx, httpStatus: 499, wire: "x402" });
const settle = async () => { await rl.refundLedgerRefresh(); await rl.refundLedgerFlush(); };

try {
  await rl.refundLedgerReady();
  ok(typeof rl.voidOwedOnResend === "function" && typeof RESEND_SERVED_NOTE === "string", "the resend's void is its own ledger call, with one note");

  // ---- CONTROL: a healthy store voids now, and the resend is served ----
  const A = "0x" + "a1".repeat(32);
  ok((await debt(A, 1)) === true, "setup: an owed hang-up debt");
  {
    const v = await chargedReplayVerdict(A, { voidOnClaim: voidOnResend, rowOf: (tx) => rl.refundByEvidenceFresh(tx) });
    ok(v.verdict === "serve" && v.voided === true && (await rowOf(A)).status === "void", `CONTROL the void lands and the resend is served (${JSON.stringify({ verdict: v.verdict, voided: v.voided })})`);
    ok((await rl.claimRefundForSend(Number((await rowOf(A)).id), "refund-run")) === false, "CONTROL a served payment is not refunded");
  }

  // ---- the store is down: the resend is asked to retry, and never does ----
  const B = "0x" + "b2".repeat(32);
  ok((await debt(B, 2)) === true, "setup: a second owed debt");
  cutRelay();
  {
    const v = await chargedReplayVerdict(B, { voidOnClaim: voidOnResend, rowOf: (tx) => rl.refundByEvidenceFresh(tx) });
    ok(v.verdict === "pending", `with the store down the resend is held, not served (${v.verdict})`);
  }
  healRelay();
  await settle();
  ok((await rowOf(B)).status === "owed", `the buyer never retried: after the store heals the debt still reads owed (${(await rowOf(B)).status})`);
  ok((await markOf(B)) !== "void", `and nothing marks its evidence void (${await markOf(B)})`);
  ok((await rl.claimRefundForSend(Number((await rowOf(B)).id), "refund-run")) === true, "so the refund run can claim it");

  // ---- the mark landed and the row's void did not ----
  const C = "0x" + "c3".repeat(32);
  ok((await debt(C, 3)) === true, "setup: a third owed debt");
  cutRelay();
  ok((await voidOnResend(C)) === false, "the void is not confirmed while the store is down");
  healRelay();
  await sdb.stateQuery(`INSERT INTO ${M} (evidence, state, at) VALUES ($1, 'void', $2) ON CONFLICT (evidence) DO UPDATE SET state = 'void'`, [C, Date.now()]);
  await settle();
  ok((await rowOf(C)).status === "owed" && (await markOf(C)) === "owed", `a mark that landed alone is taken back (row ${(await rowOf(C)).status}, mark ${await markOf(C)})`);
  ok((await rl.claimRefundForSend(Number((await rowOf(C)).id), "refund-run")) === true, "and the refund run can claim the debt");

  // ---- the void landed and its answer was lost: unserved, it is owed again ----
  const D = "0x" + "d4".repeat(32);
  ok((await debt(D, 4)) === true, "setup: a fourth owed debt");
  const before = await rowOf(D);
  cutRelay();
  ok((await voidOnResend(D)) === false, "the void is not confirmed while the store is down (again)");
  healRelay();
  const full = before.note ? `${before.note}; ${NOTE}` : NOTE;
  await sdb.stateQuery(`UPDATE ${T} SET status = 'void', note = $2, resolved_at = $3 WHERE evidence = $1`, [D, full, Date.now()]);
  await sdb.stateQuery(`INSERT INTO ${M} (evidence, state, at) VALUES ($1, 'void', $2) ON CONFLICT (evidence) DO UPDATE SET state = 'void'`, [D, Date.now()]);
  await settle();
  {
    const r = await rowOf(D);
    ok(r.status === "owed" && (r.note ?? null) === (before.note ?? null) && r.resolved_at == null && (await markOf(D)) === "owed", `a void nobody was served under is owed again, as it was (${r.status}, note ${JSON.stringify(r.note)}, mark ${await markOf(D)})`);
  }

  // ---- served on a later resend (another container): never reopened ----
  const E = "0x" + "e5".repeat(32);
  ok((await debt(E, 5)) === true, "setup: a fifth owed debt");
  const beforeE = await rowOf(E);
  cutRelay();
  ok((await voidOnResend(E)) === false, "the void is not confirmed while the store is down (third)");
  healRelay();
  const fullE = beforeE.note ? `${beforeE.note}; ${NOTE}` : NOTE;
  await sdb.stateQuery(`UPDATE ${T} SET status = 'void', note = $2, resolved_at = $3 WHERE evidence = $1`, [E, `${fullE}; answer sent`, Date.now()]);
  await sdb.stateQuery(`INSERT INTO ${M} (evidence, state, at) VALUES ($1, 'void', $2) ON CONFLICT (evidence) DO UPDATE SET state = 'void'`, [E, Date.now()]);
  await settle();
  ok((await rowOf(E)).status === "void" && (await markOf(E)) === "void", `a row whose answer was sent on a later resend stays void (${(await rowOf(E)).status})`);

  // ---- a retry after the heal is served once ----
  const F = "0x" + "f6".repeat(32);
  ok((await debt(F, 6)) === true, "setup: a sixth owed debt");
  cutRelay();
  ok((await voidOnResend(F)) === false, "the void is not confirmed while the store is down (fourth)");
  healRelay();
  {
    const v = await chargedReplayVerdict(F, { voidOnClaim: voidOnResend, rowOf: (tx) => rl.refundByEvidenceFresh(tx) });
    await settle();
    ok(v.verdict === "serve" && v.voided === true && (await rowOf(F)).status === "void", `the buyer's retry after the heal is served and the debt is void (${v.verdict}, ${(await rowOf(F)).status})`);
  }

  // ---- the server asks for the resend's own void, and notes a later serve ----
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/voidOnClaim: \(tx\) => voidOwedOnResend\(tx, RESEND_SERVED_NOTE\)/.test(server), "the server's replay hook voids through the resend's own call");
  ok(/noteResendAnswerSent\(charged\.tx/.test(server), "and marks a row that was already void as answered, so no earlier undo reopens it");
} finally {
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* best effort */ }
  relay.close();
  for (const s of live) s.destroy();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-resend-void-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
