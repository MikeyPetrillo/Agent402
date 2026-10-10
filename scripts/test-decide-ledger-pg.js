// The decide ledger on a REAL Postgres (src/decide/ledger.js with
// STATE_DATABASE_URL): the SQLite file is imported once at the first open and
// never again, writes land in the database (and, while the file exists, in
// the file), and the money invariants hold with concurrent writers: a credit
// is minted pending, redeemable only once active, redeemed by exactly one of
// two concurrent runs, returned when that run fails before spending, and a
// run is booked once per key and never past a ceiling. Requires
// STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-decide-ledger-pg" });
const sdb = await import("../src/state-db.js");
const { openDecideLedger, hashToken, singleWriterTopology } = await import("../src/decide/ledger.js");
const { makeFeedbackHandler } = await import("../src/tools/decide-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "decide-ledger-pg-"));
const FILE = join(DIR, "ledger.db");
const T = (t) => `${sdb.stateDbSchema()}.decide_ledger_${t}`;
const now = Date.now();

// The file a previous build left on the volume: one settled decision with an
// active credit, one pending credit, one finished run.
{
  const db = new Database(FILE);
  db.exec(`
    CREATE TABLE decisions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, depth TEXT NOT NULL, price_micro INTEGER NOT NULL, payer TEXT, plan_json TEXT NOT NULL, cost_via_micro INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, feedback_hash TEXT);
    CREATE TABLE credits (token_hash TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT, amount_micro INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT, status TEXT NOT NULL, budget_micro INTEGER NOT NULL, spent_micro INTEGER NOT NULL DEFAULT 0, credit_micro INTEGER NOT NULL DEFAULT 0, steps_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, finished_at INTEGER, run_key TEXT);
  `);
  db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?)").run("d_old", now - 1000, "plan", 10000, "0xa", JSON.stringify([{ step: 1, tool: { id: "t1" } }]), 20000, 1, hashToken("fb_old"));
  db.prepare("INSERT INTO credits VALUES (?,?,?,?,?,?,?,?)").run(hashToken("dc_old"), "d_old", "0xa", 5000, now + 3_600_000, "active", null, now - 1000);
  db.prepare("INSERT INTO credits VALUES (?,?,?,?,?,?,?,?)").run(hashToken("dc_pending"), "d_old", "0xa", 5000, now + 3_600_000, "pending", null, now - 1000);
  db.prepare("INSERT INTO runs (id, decision_id, payer, status, budget_micro, spent_micro, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)").run("run_old", "d_old", "0xa", "complete", 10000, 8000, now - 2000, now - 1000);
  db.close();
}

try {
  ok(singleWriterTopology({ ...process.env, RATE_LIMIT_REPLICAS: "3" }) === true, "with the database on, any number of writers is a safe topology");
  ok(singleWriterTopology({ RATE_LIMIT_REPLICAS: "3" }) === false && singleWriterTopology({}) === true, "...and the replica rule still applies without it");

  // ---- (1) import once ------------------------------------------------------
  const L = openDecideLedger(FILE);
  ok(L.async === true && typeof L.ready?.then === "function", "the ledger on the database is async and exposes ready");
  await L.ready;
  const d = await L.getDecision("d_old");
  ok(d && d.settled === true && d.priceUsd === 0.01 && d.plan[0].tool.id === "t1", "the first open imports the file's decisions");
  ok((await L.creditAvailableUsd("dc_old", "d_old", now)) === 0.005 && (await L.creditAvailableUsd("dc_pending", "d_old", now)) === 0, "...and its credits, with their states");
  ok((await L.getRun("run_old"))?.spentUsd === 0.008, "...and its runs");
  ok(!!(await sdb.imports.done("ledger.db")), "the import is marked under the file's basename");
  ok((await L.feedbackTokenOk("d_old", "fb_old", { now })) === true, "an imported feedback hash still verifies");
  // A row added to the file after the import must not appear at the next open.
  { const db = new Database(FILE); db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?)").run("d_late", now, "plan", 1, null, "[]", 1, 1, null); db.close(); }
  const L2 = openDecideLedger(FILE);
  await L2.ready;
  ok((await L2.getDecision("d_late")) === null && (await L2.getDecision("d_old"))?.id === "d_old", "a second open does not import again");

  // ---- (2) writes go to the database; a second instance sees them -----------
  await L.saveDecision({ decisionId: "d1", depth: "plan", priceUsd: 0.03, payer: "0xb", plan: [{ step: 1, tool: { id: "t1" } }], costViaUsd: 0.031, feedbackHash: hashToken("fb1"), now });
  ok((await L2.getDecision("d1"))?.costViaUsd === 0.031 && (await L2.getDecision("d1")).settled === false, "a decision written by one instance is read by another, unsettled");
  const row = (await sdb.stateQuery(`SELECT settled FROM ${T("decisions")} WHERE id = $1`, ["d1"])).rows[0];
  ok(row && Number(row.settled) === 0, "...straight from the table");
  await L.markDecisionSettled("d1");
  ok((await L2.getDecision("d1")).settled === true, "settlement is visible to the other instance");
  ok(L.getDecisionSync("d1")?.settled === true, "the synchronous quote view follows this instance's writes");
  // The other instance's mirror was stale (unsettled): a sync read schedules a
  // refresh, so the paid retry of a quote sees the settled decision.
  L2.getDecisionSync("d1");
  await new Promise((r) => setTimeout(r, 150));
  ok(L2.getDecisionSync("d1")?.settled === true, "a stale mirror entry in another instance refreshes in the background");

  // ---- (3) the credit lifecycle, with two concurrent redeems ----------------
  const c = await L.mintCredit({ decisionId: "d1", amountUsd: 0.02, ttlMs: 3_600_000, payer: "0xb", now });
  {
    // A mint retried with its token (the first attempt landed, its reply was lost) is one credit, on either instance.
    const { newCreditToken } = await import("../src/decide/ledger.js");
    const tk = newCreditToken();
    const args = { decisionId: "d1", amountUsd: 0.01, expiresAt: now + 3_600_000, payer: "0xb", now, token: tk };
    const [m1, m2] = await Promise.all([L.mintCredit(args), L2.mintCredit(args)]);
    ok(m1.hash === m2.hash && (await L.creditState(tk))?.amountUsd === 0.01, "a mint retried with its token names one credit (two instances at once)");
    let threw = false; try { await L2.mintCredit({ ...args, amountUsd: 0.05 }); } catch { threw = true; }
    ok(threw && (await L.creditState(tk))?.amountUsd === 0.01, "the same token for a different credit is refused, the first kept");
  }
  ok((await L.creditState(c.token))?.state === "pending" && (await L.redeemCredit(c.token, "d1", "r0", now)) === 0, "a credit is minted pending and cannot be redeemed");
  ok(L.creditAvailableUsdSync(c.token, "d1", now) === 0, "...nor quoted");
  ok((await L.activateCredit(c.hash)) === true && (await L.activateCredit(c.hash)) === false, "activation (after settlement) happens once");
  ok((await L2.creditAvailableUsd(c.token, "d1", now)) === 0.02, "the other instance sees it active");
  const [a, b] = await Promise.all([L.redeemCredit(c.token, "d1", "r1", now), L2.redeemCredit(c.token, "d1", "r2", now)]);
  ok([a, b].filter((x) => x === 0.02).length === 1 && [a, b].filter((x) => x === 0).length === 1, `two concurrent redeems: exactly one wins (${a}, ${b})`);
  const winner = a === 0.02 ? "r1" : "r2";
  const loser = winner === "r1" ? "r2" : "r1";
  await L.restoreCredit(c.token, loser);
  ok((await L.creditState(c.token)).state === "redeemed", "the losing run cannot return the credit");
  await L.restoreCredit(c.token, winner);
  ok((await L.creditState(c.token)).state === "active" && (await L2.creditAvailableUsd(c.token, "d1", now)) === 0.02, "the run that redeemed it returns it to active when it fails before spending");
  ok((await L.redeemCredit(c.token, "d_old", "r3", now)) === 0 && (await L.redeemCredit(c.token, "d1", "r3", now + 4_000_000)) === 0, "a credit cannot be redeemed for another decision or after expiry");

  // ---- (3b) run booking: once per key, never past a ceiling -----------------
  const caps = { payerHourUsd: 1, globalDayUsd: null, payerDayUsd: 1, hourSinceMs: now - 3_600_000, daySinceMs: now - 86_400_000 };
  const [b1, b2] = await Promise.all([
    L.bookRun({ runId: "run_a", decisionId: "d1", payer: "0xb", budgetUsd: 0.05, creditUsd: 0, runKey: "k1", now, caps }),
    L2.bookRun({ runId: "run_b", decisionId: "d1", payer: "0xb", budgetUsd: 0.05, creditUsd: 0, runKey: "k1", now, caps }),
  ]);
  ok([b1, b2].filter((x) => x.ok).length === 1 && [b1, b2].find((x) => !x.ok)?.reason === "key", `two concurrent bookings with one key: exactly one is booked (${JSON.stringify([b1, b2])})`);
  const over = await L.bookRun({ runId: "run_c", decisionId: "d1", payer: "0xb", budgetUsd: 0.96, creditUsd: 0, runKey: null, now, caps });
  ok(over.ok === false && over.reason === "payerHour" && (await L.getRun("run_c")) === null, "a booking that would cross the payer's hourly ceiling (0.05 running + 0.96) is refused and writes nothing");
  ok((await L.payerExposureUsd("0xb", now - 3_600_000, now)) === 0.05, "a running run counts its whole budget as exposure");
  await L.finishRun({ runId: b1.ok ? "run_a" : "run_b", status: "failed", spentUsd: 0, steps: [], now });
  const again = await L.bookRun({ runId: "run_d", decisionId: "d1", payer: "0xb", budgetUsd: 0.05, creditUsd: 0, runKey: "k1", now, caps });
  ok(again.ok === true, "a run that failed having spent nothing frees its key for a retry");
  const hold = await L.holdSellerSpend({ runId: "run_d", seller: "seller.test", amountUsd: 0.4, now, capUsd: 0.5, sinceMs: now - 86_400_000 });
  const second = await L2.holdSellerSpend({ runId: "run_d", seller: "seller.test", amountUsd: 0.2, now, capUsd: 0.5, sinceMs: now - 86_400_000 });
  ok(typeof hold === "number" && second === false, "a seller hold is booked under the seller's ceiling and the next one that would cross it is refused");
  await L.settleSellerHold(hold, 0.1);
  ok((await L2.sellerSpendUsd("seller.test", now - 86_400_000)) === 0.1, "settling the hold to what left is what the other instance reads");

  // ---- feedback through the kit's async handler ----------------------------
  const fb = makeFeedbackHandler({ ledger: L, send: async () => ({}) });
  const r1 = await fb({ decisionId: "d1", feedbackToken: "fb1", step: 1, outcome: "success" });
  const r2 = await fb({ decisionId: "d1", feedbackToken: "fb1", step: 1, outcome: "failure" });
  ok(r1.ok === true && r1.replaced === false && r2.replaced === true, "feedback on the database: the first verdict is new, the second replaces it");
  let refused = null;
  try { await fb({ decisionId: "d1", feedbackToken: "wrong", step: 1, outcome: "success" }); } catch (e) { refused = e; }
  ok(refused?.statusCode === 403, "a wrong feedback token is refused");

  // ---- write-through: the database write also lands in the SQLite file -----
  {
    const db = new Database(FILE, { readonly: true });
    const cr = db.prepare("SELECT state FROM credits WHERE token_hash = ?").get(c.hash);
    const dr = db.prepare("SELECT settled FROM decisions WHERE id = ?").get("d1");
    const rr = db.prepare("SELECT status FROM runs WHERE id = ?").get("run_d");
    const sp = db.prepare("SELECT micro FROM seller_spend WHERE run_id = ?").get("run_d");
    db.close();
    ok(cr?.state === "active" && dr?.settled === 1 && rr?.status === "running" && sp?.micro === 100000, "every write in database mode is also applied to the SQLite file (a rollback reads current state)");
  }

  // ---- roll-forward: a file written in a rollback window wins per row ------
  {
    // A transition and a row made by the file-only build: within the
    // write-through grace they are left alone (an ordinary write-through).
    const db = new Database(FILE);
    db.prepare("UPDATE credits SET state = 'redeemed', run_id = 'run_file' WHERE token_hash = ?").run(c.hash);
    db.prepare("INSERT INTO runs (id, decision_id, payer, status, budget_micro, spent_micro, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)").run("run_file", "d1", "0xb", "complete", 50000, 50000, now, now);
    db.close();
    const L3 = openDecideLedger(FILE);
    await L3.ready;
    ok((await L3.creditState(c.token)).state === "active" && (await L3.getRun("run_file")) === null, "a file written within the write-through grace is not re-read (the rows stay)");
    // The same file dated past the grace: a rollback window. The file wins.
    const future = (Date.now() + 120_000) / 1000;
    utimesSync(FILE, future, future);
    const L4 = openDecideLedger(FILE);
    await L4.ready;
    const rolled = await L4.creditState(c.token);
    const run = await L4.getRun("run_file");
    ok(rolled.state === "redeemed" && (await sdb.stateQuery(`SELECT run_id FROM ${T("credits")} WHERE token_hash = $1`, [c.hash])).rows[0].run_id === "run_file", "roll-forward: a credit redeemed in the file is redeemed in the table");
    ok(run?.status === "complete" && run.spentUsd === 0.05 && (await L4.getDecision("d_late"))?.id === "d_late", "roll-forward: a run booked in the file exists in the table (and the file's other rows came along)");
    ok((await L4.redeemCredit(c.token, "d1", "r9", now)) === 0, "...so the rolled-forward credit cannot be redeemed again");
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-decide-ledger-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
