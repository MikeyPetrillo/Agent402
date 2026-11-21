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
const voidOnResend = (ev, attempt = null) => (rl.voidOwedOnResend || rl.voidOwedOnClaim)(ev, NOTE, { attempt });
// The note one resend's void writes: the fixed note and that call's own mark.
const noteOf = (attempt) => `${NOTE} [attempt ${attempt}]`;
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
  ok((await voidOnResend(D, "d4d4d4d4")) === false, "the void is not confirmed while the store is down (again)");
  healRelay();
  const full = before.note ? `${before.note}; ${noteOf("d4d4d4d4")}` : noteOf("d4d4d4d4");
  await sdb.stateQuery(`UPDATE ${T} SET status = 'void', note = $2, resolved_at = $3 WHERE evidence = $1`, [D, full, Date.now()]);
  await sdb.stateQuery(`INSERT INTO ${M} (evidence, state, at) VALUES ($1, 'void', $2) ON CONFLICT (evidence) DO UPDATE SET state = 'void'`, [D, Date.now()]);
  await settle();
  {
    const r = await rowOf(D);
    ok(r.status === "owed" && (r.note ?? null) === (before.note ?? null) && r.resolved_at == null && (await markOf(D)) === "owed", `a void nobody was served under is owed again, as it was (${r.status}, note ${JSON.stringify(r.note)}, mark ${await markOf(D)})`);
  }

  // ---- a void another resend wrote is not this resend's to take back ----
  const D2 = "0x" + "d5".repeat(32);
  ok((await debt(D2, 9)) === true, "setup: a debt two resends reach");
  const beforeD2 = await rowOf(D2);
  cutRelay();
  ok((await voidOnResend(D2, "aaaaaaaa")) === false, "one resend's void is not confirmed");
  healRelay();
  // Another resend's confirmed void, as that call writes it (its own mark).
  const otherNote = beforeD2.note ? `${beforeD2.note}; ${noteOf("bbbbbbbb")}` : noteOf("bbbbbbbb");
  await sdb.stateQuery(`UPDATE ${T} SET status = 'void', note = $2, resolved_at = $3 WHERE evidence = $1`, [D2, otherNote, Date.now()]);
  await sdb.stateQuery(`INSERT INTO ${M} (evidence, state, at) VALUES ($1, 'void', $2) ON CONFLICT (evidence) DO UPDATE SET state = 'void'`, [D2, Date.now()]);
  await settle();
  ok((await rowOf(D2)).status === "void" && (await rowOf(D2)).note === otherNote && (await markOf(D2)) === "void", `the undo of one resend's unconfirmed void leaves another resend's void as it is (${(await rowOf(D2)).status}, mark ${await markOf(D2)})`);

  // ---- served on a later resend (another container): never reopened ----
  const E = "0x" + "e5".repeat(32);
  ok((await debt(E, 5)) === true, "setup: a fifth owed debt");
  const beforeE = await rowOf(E);
  cutRelay();
  ok((await voidOnResend(E, "e5e5e5e5")) === false, "the void is not confirmed while the store is down (third)");
  healRelay();
  const fullE = beforeE.note ? `${beforeE.note}; ${noteOf("e5e5e5e5")}` : noteOf("e5e5e5e5");
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

  // ---- two resends at once: the first void lands and is served, the second's fails ----
  // Both read the row owed before either void landed, so both carry the same
  // note. The second's void statement fails (the store drops mid-write) and
  // its undo is kept for when the store answers. That undo must take back
  // only its OWN void: the first resend's void was confirmed and its answer
  // went out, so the row stays void and the refund run cannot claim it.
  const G = "0x" + "a7".repeat(32);
  ok((await debt(G, 7)) === true, "setup: a seventh owed debt");
  {
    const first = voidOnResend(G);   // issued while the store is up: lands
    const second = voidOnResend(G);  // issued beside it, the row still owed in this process
    const firstLanded = await first;
    cutRelay();                      // the second's statement meets a dead store
    const secondLanded = await second.catch(() => false);
    healRelay();
    await settle();
    await settle();
    const r = await rowOf(G);
    // Whichever order the queue ran them in, one void was confirmed (its
    // resend is served) and the row must still be void once every undo has run.
    ok(firstLanded === true || secondLanded === true, `one of the two voids was confirmed (${firstLanded}, ${secondLanded})`);
    ok(r.status === "void" && (await markOf(G)) === "void", `a confirmed void is not taken back by the other resend's undo: the served row stays void (${r.status}, mark ${await markOf(G)}, note ${JSON.stringify(r.note)})`);
    ok((await rl.claimRefundForSend(Number(r.id), "refund-run")) === false, "and the refund run cannot claim a debt whose answer went out");
  }
  // The same, with the second's failure forced after the first is confirmed:
  // the second attempt's undo is written by hand, as the ledger keeps it.
  const H = "0x" + "b8".repeat(32);
  ok((await debt(H, 8)) === true, "setup: an eighth owed debt");
  {
    const beforeH = await rowOf(H);
    ok((await voidOnResend(H)) === true, "the first resend's void is confirmed and its answer goes out");
    const served = await rowOf(H);
    // What a second resend that read the row owed, and whose void was not
    // confirmed, leaves behind: the undo of a void under the note IT would
    // have written. Run here exactly as the dead-letter replays it.
    cutRelay();
    ok((await voidOnResend(H)) === false, "a second resend's void is not confirmed (the store is down)");
    healRelay();
    await settle();
    const after = await rowOf(H);
    ok(after.status === "void" && after.note === served.note && (await markOf(H)) === "void", `the second resend's undo leaves the first's confirmed void alone (${after.status}, note ${JSON.stringify(after.note)}; it was owed with note ${JSON.stringify(beforeH.note)})`);
    // The second resend, retried, is served from the row that is already void, and the note says so.
    const v = await chargedReplayVerdict(H, { voidOnClaim: voidOnResend, rowOf: (tx) => rl.refundByEvidenceFresh(tx) });
    ok(v.verdict === "serve" && v.voided === false && v.row?.status === "void" && (await rl.noteResendAnswerSent(H, v.row, NOTE)) === true && /; answer sent$/.test((await rowOf(H)).note), `its retry is served from the void row and the note records the answer (${v.verdict}, ${JSON.stringify((await rowOf(H)).note)})`);
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
