// The decide handlers when the state database fails mid-run, on a REAL
// Postgres behind a relay a test can cut (every statement fails) or arm so a
// statement lands and its reply is lost:
//   - a run that already paid a seller is never turned into a 500 (a 500 is
//     never charged) when a later step's seller hold cannot be booked; before
//     any spend the run is refused 503 and the credit comes back;
//   - a failure from the credit redeem to the run booking never strands the
//     credit or the run key;
//   - writes made after a spend are journaled to local disk before the
//     answer, so a container that exits before the database answers again
//     loses none of them (a fresh ledger replays them);
//   - POST /api/decide answers its paid decision when the ledger is down
//     after the model call, and the decision and its credit land later.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

const CHILD = process.env.DECIDE_FAIL_CHILD === "1";
if (!CHILD) requireTestPg({ label: "test-decide-ledger-failures-pg" });
const REAL = process.env.STATE_DATABASE_URL;
const relay = await startPgRelay(REAL);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.DECIDE_PENDING_REPLAY_MS = "200";
const DIR = CHILD ? process.env.DECIDE_FAIL_DIR : mkdtempSync(join(tmpdir(), "decide-fail-pg-"));

const sdb = await import("../src/state-db.js");
const { openDecideLedger } = await import("../src/decide/ledger.js");
const { makeExecuteHandler, makeDecideHandler } = await import("../src/tools/decide-kit.js");

const ext = (id, seller) => ({ id, slug: id, name: id, seller, firstParty: false, endpoint: `https://${seller}/x`, method: "POST", priceUsd: 0.02, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "x" } });
const fp = (id) => ({ ...ext(id, "agent402"), firstParty: true });

// ---- child: one paid run, the database cut after the seller is paid, exit before any retry ----
if (CHILD) {
  const L = openDecideLedger(join(DIR, "ledger.db"));
  await L.ready;
  const decisionId = `dec_${randomBytes(4).toString("hex")}`;
  await L.saveDecision({ decisionId, depth: "plan", priceUsd: 0.02, payer: "ip:9.9.9.9", plan: [{ step: 1, purpose: "p", tool: ext("e1", "s1.example"), fallbacks: [] }], costViaUsd: 0.05 });
  await L.markDecisionSettled(decisionId);
  const catalog = { rx: { slug: "route-execute-pro", route: "POST /x", handler: async () => { relay.cut(); return { result: {}, receipt: { underlyingPriceUsd: 0.02 } }; } } };
  const exec = makeExecuteHandler({ ledger: L, getCatalog: () => catalog, runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }), ledgerRetryMs: [60_000] });
  const req = { headers: {}, ip: "9.9.9.9", __meteredQuoteUsd: 0.05 };
  const out = await exec({ decisionId, maxBudgetUsd: 0.05 }, req);
  for (const fn of req.__onSettled || []) fn(true); // the payment settled
  setTimeout(() => {
    console.log(JSON.stringify({ decisionId, runId: out.runId, status: out.status, spentUsd: out.spentUsd, leftover: out.leftoverCredit }));
    process.exit(0); // gone long before the first in-memory retry
  }, 300);
} else {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = async (t, p) => (await sdb.stateQuery(t, p)).rows;
  const T = (t) => `${sdb.stateDbSchema()}.decide_ledger_${t}`;

  // Ack loss: the statement (or the transaction's COMMIT) lands, then the caller sees a dead connection.
  const pool = await sdb.stateDb();
  const lost = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  const armed = [];
  const hit = (text) => { const a = armed.find((x) => x.left > 0 && x.re.test(String(text?.text ?? text))); if (a) { a.left--; return true; } return false; };
  const origQuery = pool.query.bind(pool);
  pool.query = async (text, values, cb) => { const r = await origQuery(text, values, cb); if (hit(text)) throw lost(); return r; };
  const origConnect = pool.connect.bind(pool);
  let txArmed = null;
  pool.connect = (...a) => {
    if (typeof a[0] === "function") return origConnect(...a);
    return origConnect().then((c) => {
      const oq = c.query; let marked = false;
      c.query = function (cfg, v, cb) {
        const text = String(cfg?.text ?? cfg);
        const p = oq.call(this, cfg, v, cb);
        if (txArmed && txArmed.test(text)) marked = true;
        if (/^COMMIT/i.test(text) && marked) { marked = false; txArmed = null; return Promise.resolve(p).then(() => { throw lost(); }); }
        return p;
      };
      const rel = c.release.bind(c);
      c.release = (e) => { c.query = oq; return rel(e); };
      return c;
    });
  };

  const L = openDecideLedger(join(DIR, "none.db"));
  await L.ready;
  let routerHook = null, paid = 0;
  const catalog = {
    a: { slug: "a", route: "POST /api/a", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => ({ a: p.q }) },
    rx: { slug: "route-execute-pro", route: "POST /x", handler: async () => { paid += 0.02; if (routerHook) await routerHook(); return { result: { ext: true }, receipt: { underlyingPriceUsd: 0.02 } }; } },
  };
  const exec = makeExecuteHandler({ ledger: L, getCatalog: () => catalog, runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }), ledgerRetryMs: [100, 100, 100, 100, 100] });
  const mkReq = (quoted) => ({ headers: {}, ip: "1.2.3.4", __meteredQuoteUsd: quoted });
  async function decision(plan, { credit = 0 } = {}) {
    const decisionId = `dec_${randomBytes(4).toString("hex")}`;
    await L.saveDecision({ decisionId, depth: "plan", priceUsd: 0.02, payer: "ip:1.2.3.4", plan, costViaUsd: 0.05 });
    await L.markDecisionSettled(decisionId);
    let token = null;
    if (credit) { const c = await L.mintCredit({ decisionId, amountUsd: credit, ttlMs: 3_600_000, payer: "ip:1.2.3.4" }); await L.activateCredit(c.hash); token = c.token; }
    return { decisionId, token };
  }
  const run = async (fn) => { try { return { out: await fn() }; } catch (e) { return { err: e, status: e?.statusCode ?? 500 }; } };

  try {
    // Step 1 paid a seller, then the database is down for step 2's hold: the run answers 200 (charged).
    {
      const { decisionId } = await decision([{ step: 1, purpose: "p1", tool: ext("e1", "s1.example"), fallbacks: [] }, { step: 2, purpose: "p2", tool: ext("e2", "s2.example"), fallbacks: [] }]);
      let n = 0; routerHook = async () => { if (++n === 1) relay.cut(); }; paid = 0;
      const r = await run(() => exec({ decisionId, maxBudgetUsd: 0.06 }, mkReq(0.06)));
      routerHook = null; relay.heal();
      ok(!r.err && r.out.status === "partial" && paid === 0.02, `a seller paid, then the next hold fails: 200 partial, not a 500 (${r.err ? `${r.status} ${r.err.message}` : r.out.status})`);
      ok(r.out?.steps?.[1]?.attempts?.[0]?.skipped === "the spend ledger is unavailable; this leg was not paid", "...the leg is skipped, never paid");
      await wait(1500);
      const row = (await q(`SELECT status, spent_micro FROM ${T("runs")} WHERE decision_id = $1`, [decisionId]))[0];
      ok(row?.status === "partial" && Number(row.spent_micro) === 21000, `...the run's finish lands once the database is back (${JSON.stringify(row)})`);
    }
    // The same with step 2's hold COMMIT landed and its reply lost: 200, and the phantom hold is dropped.
    {
      const { decisionId } = await decision([{ step: 1, purpose: "p1", tool: ext("e1", "s3.example"), fallbacks: [] }, { step: 2, purpose: "p2", tool: ext("e2", "s4.example"), fallbacks: [] }]);
      let n = 0; routerHook = async () => { if (++n === 1) txArmed = /INSERT INTO .*seller_spend/; }; paid = 0;
      const r = await run(() => exec({ decisionId, maxBudgetUsd: 0.06 }, mkReq(0.06)));
      routerHook = null; txArmed = null;
      const holds = await q(`SELECT micro FROM ${T("seller_spend")} WHERE seller = 's4.example'`);
      ok(!r.err && paid === 0.02 && holds.length === 0, `a hold whose reply was lost after a paid step: 200 and no hold left for the unpaid leg (${r.err ? r.status : 200}, ${JSON.stringify(holds)})`);
    }
    // Nothing spent yet and the first hold fails: 503, the run closed, the credit back.
    {
      const { decisionId, token } = await decision([{ step: 1, purpose: "p1", tool: ext("e1", "s5.example"), fallbacks: [] }], { credit: 0.02 });
      const orig = L.holdSellerSpend;
      L.holdSellerSpend = async () => { throw lost(); };
      const r = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05 }, mkReq(0.03)));
      L.holdSellerSpend = orig;
      const st = await L.creditState(token);
      const row = (await q(`SELECT status FROM ${T("runs")} WHERE decision_id = $1`, [decisionId]))[0];
      ok(r.status === 503 && st?.state === "active" && row?.status === "failed", `the first hold fails before any spend: 503, credit ${st?.state}, run ${row?.status}`);
    }
    // The database down at the booking, after the credit was redeemed: 503 and the credit restored.
    {
      const { decisionId, token } = await decision([{ step: 1, purpose: "p", tool: fp("a"), fallbacks: [] }], { credit: 0.02 });
      const orig = L.bookRun;
      L.bookRun = async (...a) => { relay.cut(); try { return await orig.apply(L, a); } finally { relay.heal(); } };
      const r = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05 }, mkReq(0.03)));
      L.bookRun = orig;
      await wait(500);
      const st = await L.creditState(token);
      ok(r.status === 503 && st?.state === "active", `booking fails after the redeem: ${r.status}, credit ${st?.state}`);
      const again = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05 }, mkReq(0.03)));
      ok(!again.err, `...the retry with the same credit runs (${again.err ? again.status : 200})`);
    }
    // The booking COMMIT lands and its reply is lost: the run key and the credit are released.
    {
      const { decisionId, token } = await decision([{ step: 1, purpose: "p", tool: fp("a"), fallbacks: [] }], { credit: 0.02 });
      txArmed = /INSERT INTO .*decide_ledger_runs/;
      const r = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05, runKey: "k1" }, mkReq(0.03)));
      txArmed = null;
      const runs = await q(`SELECT status FROM ${T("runs")} WHERE decision_id = $1`, [decisionId]);
      const st = await L.creditState(token);
      ok(r.status === 503 && st?.state === "active" && runs.every((x) => x.status === "failed"), `a booking whose reply was lost: 503, credit ${st?.state}, runs ${JSON.stringify(runs)}`);
      const again = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05, runKey: "k1" }, mkReq(0.03)));
      ok(!again.err, `...the paid retry with the same run key runs (${again.err ? `${again.status} ${again.err.message}` : 200})`);
    }
    // The redeem lands and its reply is lost: the credit is restored.
    {
      const { decisionId, token } = await decision([{ step: 1, purpose: "p", tool: fp("a"), fallbacks: [] }], { credit: 0.02 });
      armed.push({ re: /SET state = 'redeemed'/, left: 1 });
      const r = await run(() => exec({ decisionId, creditToken: token, maxBudgetUsd: 0.05 }, mkReq(0.03)));
      const st = await L.creditState(token);
      ok(r.status === 503 && st?.state === "active", `a redeem whose reply was lost: ${r.status}, credit ${st?.state}`);
    }

    // POST /api/decide: the ledger down after the model call still answers the paid decision.
    {
      const realFetch = globalThis.fetch;
      process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
      const decisionId = `dx_${randomBytes(4).toString("hex")}`;
      globalThis.fetch = async () => { relay.cut(); return new Response(JSON.stringify({ decisionId, plan: [{ step: 1, purpose: "p", tool: fp("a"), fallbacks: [] }], gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 }); };
      const req = mkReq(0.05);
      const r = await run(() => makeDecideHandler({ ledger: L })({ task: "do it", depth: "plan" }, req));
      globalThis.fetch = realFetch;
      const atAnswer = L.pendingCount();
      for (const fn of req.__onSettled || []) fn(true);
      ok(!r.err && r.out.executionCredit?.token && r.out.executionCredit.recordPending === true, `decide with the ledger down after the model call: 200 with a credit (${r.err ? `${r.status} ${r.err.message}` : "200"})`);
      ok(atAnswer === 2, `...the decision and the credit are journaled before the answer (${atAnswer})`);
      await wait(200);
      ok(L.pendingCount() === 4, `...the activation and the settled mark once the payment settles (${L.pendingCount()})`);
      relay.heal();
      await wait(1500);
      const d = await L.getDecision(decisionId);
      const st = r.out ? await L.creditState(r.out.executionCredit.token) : null;
      ok(d?.settled === true && st?.state === "active", `...once the database is back the decision is settled (${d?.settled}) and the credit active (${st?.state})`);
    }

    // The decision's save lands and its reply is lost, then the payment settles: the retried save never unsettles it.
    {
      const realFetch = globalThis.fetch;
      const decisionId = `dx_${randomBytes(4).toString("hex")}`;
      globalThis.fetch = async () => new Response(JSON.stringify({ decisionId, plan: [{ step: 1, purpose: "p", tool: fp("a"), fallbacks: [] }], gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 });
      armed.push({ re: /INSERT INTO .*decide_ledger_decisions/, left: 1 });
      const req = mkReq(0.05);
      const r = await run(() => makeDecideHandler({ ledger: L })({ task: "do it", depth: "plan" }, req));
      globalThis.fetch = realFetch;
      for (const fn of req.__onSettled || []) fn(true);
      await wait(1800);
      const d = await L.getDecision(decisionId);
      ok(!r.err && d?.settled === true && L.pendingCount() === 0, `a save whose reply was lost, then settled: the retried save keeps it settled (${d?.settled}, journal ${L.pendingCount()})`);
    }

    // A container that exits before the database answers again: a fresh ledger replays its journal.
    {
      const childDir = mkdtempSync(join(DIR, "child-"));
      // The ledger file exists (the volume): the journal lives in it.
      new Database(join(childDir, "ledger.db")).close();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, STATE_DATABASE_URL: REAL, DECIDE_FAIL_CHILD: "1", DECIDE_FAIL_DIR: childDir, DECIDE_PENDING_REPLAY_MS: "600000" }, stdio: ["ignore", "pipe", "inherit"] });
      let buf = ""; child.stdout.on("data", (d) => { buf += d; });
      await new Promise((r) => child.on("exit", r));
      const o = JSON.parse(buf.split("\n").find((l) => l.startsWith("{")) || "{}");
      const before = (await q(`SELECT status FROM ${T("runs")} WHERE id = $1`, [o.runId]))[0];
      ok(o.status === "complete" && o.leftover?.token && before?.status === "running", `the child answered ${o.status} with a leftover credit, then exited; the run reads ${before?.status} in the database`);
      ok(existsSync(join(childDir, "ledger.db")), "...its journal is in the ledger file on the volume");
      const L2 = openDecideLedger(join(childDir, "ledger.db"));
      await L2.ready;
      for (let i = 0; i < 30 && L2.pendingCount(); i++) await wait(100);
      const runRow = (await q(`SELECT status, spent_micro FROM ${T("runs")} WHERE id = $1`, [o.runId]))[0];
      const credits = await q(`SELECT state, amount_micro FROM ${T("credits")} WHERE decision_id = $1`, [o.decisionId]);
      const holds = await q(`SELECT micro FROM ${T("seller_spend")} WHERE run_id = $1`, [o.runId]);
      ok(runRow?.status === "complete" && Number(runRow.spent_micro) === Math.round(o.spentUsd * 1e6), `a restarted ledger lands the run's finish (${JSON.stringify(runRow)})`);
      ok(credits.length === 1 && credits[0].state === "active" && Number(credits[0].amount_micro) === Math.round(o.leftover.amountUsd * 1e6), `...and the leftover credit, minted and active (${JSON.stringify(credits)})`);
      ok(holds.length === 1 && Number(holds[0].micro) === 20000, `...and the seller hold at what was paid (${JSON.stringify(holds)})`);
      ok(L2.pendingCount() === 0, "...and the journal is empty");
      await L2.replayPending();
      const credits2 = await q(`SELECT state FROM ${T("credits")} WHERE decision_id = $1`, [o.decisionId]);
      ok(credits2.length === 1, "a second replay changes nothing");
    }
  } finally {
    relay.heal();
    try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch (e) { console.error("drop failed", e.message); }
    await sdb.closeStateDb();
    await relay.close();
  }
  console.log(`\ntest-decide-ledger-failures-pg: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
