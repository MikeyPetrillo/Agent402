// A blocked event loop is not a database that stopped answering.
//
// A timer and a reply that both come due while the event loop is blocked are
// handled timer first, so a plain client-side read limit failed every query
// in flight across a long block ("Query read timeout") and discarded its
// connection, although each reply was already waiting in its socket. At boot
// that turned one long synchronous step into a failed first load for every
// store loading at the time. Pinned here:
//   - control: the driver's own plain timer does fail a query across a block
//     longer than its limit (so the block below is long enough to matter);
//   - stateQuery and a withStateTx statement in flight across the same block
//     both succeed;
//   - a statement the database really does not answer still fails within the
//     limit, and its connection is discarded, never left holding a pool slot;
//   - stores waiting for the schema lock hold no pooled connection, so a
//     serving read is not queued behind them.
// Requires STATE_DATABASE_URL (CI fails without it).
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url } = requireTestPg({ label: "test-state-db-stall-timeout-pg" });
const LIMIT_MS = 800;
process.env.STATE_DB_QUERY_TIMEOUT_MS = String(LIMIT_MS);
process.env.STATE_DB_POOL_MAX = "2";
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* the event loop is blocked */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Off the timers phase, as the boot's block was (a continuation after an
// import): the next loop turn then runs the due timers before it reads sockets.
const offTimers = () => new Promise((r) => setImmediate(r));

try {
  await sdb.stateQuery("SELECT 1"); // schema in place, pool warm

  // Control: the driver's plain timer, the same block.
  {
    const c = new pg.Client({ connectionString: url, query_timeout: LIMIT_MS });
    await c.connect();
    const p = c.query("SELECT pg_sleep(0.2) AS s, 1 AS one").then(() => null, (e) => e);
    await sleep(20); await offTimers();
    block(LIMIT_MS * 2);
    const err = await p;
    ok(err && /Query read timeout/.test(err.message), `control: a plain read timer fails a query in flight across a ${LIMIT_MS * 2} ms block (${err ? err.message : "it succeeded"})`);
    await c.end().catch(() => {});
  }

  {
    const p = sdb.stateQuery("SELECT pg_sleep(0.2) AS s, 1 AS one").then((r) => r, (e) => e);
    await sleep(20); await offTimers(); // sent: the block starts with the statement on the wire, as at boot
    block(LIMIT_MS * 2);
    const r = await p;
    ok(!(r instanceof Error) && r?.rows?.[0]?.one === 1, `stateQuery in flight across a ${LIMIT_MS * 2} ms block answers (${r instanceof Error ? r.message : "rows ok"})`);
  }
  {
    const r = await sdb.withStateTx(async (c) => {
      const p = c.query("SELECT pg_sleep(0.2) AS s, 2 AS two").then((x) => x, (e) => e);
      await sleep(20); await offTimers();
      block(LIMIT_MS * 2);
      return p;
    }).catch((e) => e);
    ok(!(r instanceof Error) && r?.rows?.[0]?.two === 2, `a transaction's statement in flight across the block answers (${r instanceof Error ? r.message : "rows ok"})`);
  }
  ok(sdb.stateDbStatus() === "on", `no block-made failure turned the word degraded (${sdb.stateDbStatus()})`);

  // A statement the database does not answer within the limit still fails in bounded time.
  {
    const t0 = Date.now();
    const err = await sdb.stateQuery("SELECT pg_sleep(3)").then(() => null, (e) => e);
    const took = Date.now() - t0;
    ok(err && /Query read timeout/.test(err.message) && took < LIMIT_MS + 1500, `an unanswered statement fails within the limit (${took} ms: ${err?.message})`);
    // Each timed-out connection is discarded, so a pool of two is not used up.
    for (let i = 0; i < 3; i++) await sdb.stateQuery("SELECT pg_sleep(3)").catch(() => {});
    const t1 = Date.now();
    const r = await sdb.stateQuery("SELECT 7 AS n").catch((e) => e);
    ok(r?.rows?.[0]?.n === 7 && Date.now() - t1 < 1000, `after four timed-out statements a pool of two still answers at once (${Date.now() - t1} ms)`);
  }
  {
    const t0 = Date.now();
    const err = await sdb.withStateTx((c) => c.query("SELECT pg_sleep(3)")).then(() => null, (e) => e);
    ok(err && /Query read timeout/.test(err.message) && Date.now() - t0 < LIMIT_MS + 1500, `an unanswered statement in a transaction fails within the limit (${Date.now() - t0} ms)`);
    const r = await sdb.stateQuery("SELECT 8 AS n").catch((e) => e);
    ok(r?.rows?.[0]?.n === 8, "the transaction's connection was discarded, the pool still answers");
  }

  // Schema-lock waiters hold no pooled connection.
  await sleep(LIMIT_MS * 2); // let the database finish the sleeps above
  {
    const holds = [];
    for (let i = 0; i < 6; i++) holds.push(sdb.withSchemaLock(async (c) => { await c.query("SELECT pg_sleep(0.15)"); return i; }));
    await sleep(30);
    const t0 = Date.now();
    const r = await sdb.stateQuery("SELECT 9 AS n").catch((e) => e);
    const took = Date.now() - t0;
    ok(r?.rows?.[0]?.n === 9 && took < 400, `a read while six stores wait for the schema lock, pool of two, answers without queueing behind them (${took} ms)`);
    const got = await Promise.all(holds);
    ok(got.join(",") === "0,1,2,3,4,5", "every schema-lock holder ran, in order");
    const nested = await sdb.withSchemaLock(async () => sdb.withSchemaLock(async () => "inner").catch((e) => e)).catch((e) => e);
    ok(nested instanceof Error || nested === "inner", "a nested schema-lock call does not wait on its own queue");
  }
  ok(typeof sdb.stallAwareTimeout === "function", "stallAwareTimeout is exported");
  {
    // The timer itself: late by a block, it waits again; on time, it fires.
    let fired = 0;
    const t0 = performance.now();
    sdb.stallAwareTimeout(200, () => { fired = performance.now() - t0; });
    await offTimers();
    block(600);
    await sleep(50);
    ok(fired === 0, "a timer that came due during a block does not fire on the turn the block ends");
    await sleep(800);
    ok(fired > 600, `it fires after the block plus the waited time (${Math.round(fired)} ms)`);
    let quick = 0;
    const t1 = performance.now();
    sdb.stallAwareTimeout(150, () => { quick = performance.now() - t1; });
    await sleep(400);
    // libuv measures a timer from the loop time cached when the loop turn
    // began, so a 150 ms timer can read up to about 1 ms short on
    // performance.now(); the floor allows that and nothing more.
    ok(quick >= 149 && quick < 350, `with no block it fires on time (${Math.round(quick)} ms)`);
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
}
console.log(`\ntest-state-db-stall-timeout-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
