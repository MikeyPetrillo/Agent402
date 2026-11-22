// onchain-sql day windows against a stub CDP query service (fetch stubbed in
// process, keys generated locally). The stub runs a whole-range query into
// the service's slow 502 and answers a query carrying one day's block_time
// bounds with that day's rows, so the handler's real path is read:
//   - a long-range plain select that times out whole is answered by day
//     windows, rows merged in order (oldest first, newest first under DESC);
//   - the buyer's LIMIT and the row cap stop the walk; the answer's fields
//     say when it is partial (src/partial-answer.js);
//   - an aggregate, an ORDER BY on another column, a range of a day or less
//     or past the window maximum, and a base table answer as before (one
//     query, the uncharged 422);
//   - no day answering ends in the same uncharged 422 as before, a partial
//     answer is one 200, and a buyer who left stops the walk.
//
//   node scripts/test-onchain-sql-windows.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "pkcs8", format: "pem" });
delete process.env.CDP_SQL_API_KEY_ID;
delete process.env.CDP_SQL_API_KEY_SECRET;
const cdp = await import("../src/tools/cdp-kit.js");
const { CDP_TOOLS, dayWindowPlan, _setSlowQueryGatewayMsForTest, _setQueryHealthForTest, _resetSqlPacerForTest, SQL_MAX_ROWS, SQL_WINDOW_MAX_DAYS, QUERY_HEALTH_SQL } = cdp;

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sql = (q) => CDP_TOOLS.find((t) => t.slug === "onchain-sql").handler({ sql: q });
const DAY = 86_400_000;

_resetSqlPacerForTest(0);
_setSlowQueryGatewayMsForTest(40);
_setQueryHealthForTest(true);

// ---- the stub query service ----
// rowsPerDay rows a day, block_time spread over the day; a day query is read
// by its toDateTime bounds, a whole query (no such bound) runs past the window.
let sent = [];
let rowsPerDay = 3;
let dayDelayMs = 5;
let failDay = null; // ISO date (YYYY-MM-DD) whose query answers the slow 502
let wholeAnswers = false;
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : {};
  const q = String(body.sql || "");
  if (Object.values(QUERY_HEALTH_SQL).includes(q)) return J(200, { result: [{ block_slot: 1 }] });
  sent.push(q);
  const ge = /block_time >= toDateTime\('([^']+)', 'UTC'\)/.exec(q);
  const lt = /block_time < toDateTime\('([^']+)', 'UTC'\)/.exec(q);
  if (!ge && !lt) {
    if (wholeAnswers) return J(200, { result: [{ n: 1 }] });
    return new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
  }
  const from = ge ? Date.parse(ge[1].replace(" ", "T") + "Z") : (lt ? Date.parse(lt[1].replace(" ", "T") + "Z") - DAY : 0);
  const day = new Date(from).toISOString().slice(0, 10);
  if (failDay === day) return new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
  const desc = /ORDER BY block_time DESC/i.test(q);
  const limits = [...q.matchAll(/\bLIMIT (\d+)/g)].map((m) => Number(m[1]));
  const cap = limits.length ? Math.min(...limits) : Infinity;
  const rows = [];
  for (let i = 0; i < rowsPerDay; i++) rows.push({ block_time: new Date(from + Math.floor((i + 0.5) * DAY / rowsPerDay)).toISOString(), day });
  if (desc) rows.reverse();
  return new Promise((r) => setTimeout(() => r(J(200, { result: rows.slice(0, cap) })), dayDelayMs));
};
const reset = () => { sent = []; rowsPerDay = 3; dayDelayMs = 5; failDay = null; wholeAnswers = false; };
const days = (n) => `SELECT tx_id, block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${n} DAY AND executing_account = 'x'`;
const sortedAsc = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].block_time <= r.block_time);
const sortedDesc = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].block_time >= r.block_time);

try {
  // ---- the plan ----
  {
    const at = Date.parse("2026-11-22T15:00:00Z");
    const p = dayWindowPlan(days(7), at);
    ok(p && p.spans.length === 8 && p.direction === "asc" && p.limit === null, `a 7-day plain select splits into 8 UTC days (got ${p?.spans.length})`);
    const w = p.windowSql(p.spans[1]);
    ok(/WHERE \(\nblock_time > now\(\) - INTERVAL 7 DAY AND executing_account = 'x'\n\) AND block_time >= toDateTime\('2026-11-16 00:00:00', 'UTC'\) AND block_time < toDateTime\('2026-11-17 00:00:00', 'UTC'\)/.test(w), `the buyer's WHERE is kept whole and the day's bounds are ANDed to it (${JSON.stringify(w)})`);
    ok(!/>=/.test(p.windowSql(p.spans[0]).split("\n) AND ")[1]) && !/ < /.test(p.windowSql(p.spans[7]).split("\n) AND ")[1]), "the first day is open below and the last open above: the buyer's bounds decide the edges");
    const c = dayWindowPlan("SELECT a FROM solana.instructions WHERE block_time > now() - INTERVAL 3 DAY -- note\nORDER BY block_time DESC LIMIT 20", at);
    ok(c && c.direction === "desc" && c.limit === 20 && /-- note\n\) AND block_time/.test(c.windowSql(c.spans[0])), "a trailing line comment in WHERE cannot swallow the day's bound; DESC and LIMIT are read");
    for (const [why, q] of [
      ["an aggregate", "SELECT count() FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY"],
      ["GROUP BY", "SELECT executing_account, sum(stack_height) FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY GROUP BY executing_account"],
      ["an -If aggregate", "SELECT countIf(stack_height > 1) FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY"],
      ["DISTINCT", "SELECT DISTINCT tx_signer FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY"],
      ["a window function", "SELECT tx_id, row_number() OVER (ORDER BY block_time) FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY"],
      ["ORDER BY another column", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY ORDER BY tx_id"],
      ["LIMIT m, n", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY LIMIT 10, 5"],
      ["OFFSET", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY LIMIT 5 OFFSET 10"],
      ["a subquery", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY AND tx_signer IN (SELECT a FROM base.events)"],
      ["a JOIN", "SELECT i.tx_id FROM solana.instructions i JOIN solana.instructions j ON i.tx_id = j.tx_id WHERE i.block_time > now() - INTERVAL 7 DAY"],
      ["a second table by comma", "SELECT tx_id FROM solana.instructions, base.blocks WHERE block_time > now() - INTERVAL 7 DAY"],
      ["a base table", "SELECT * FROM base.events WHERE block_time > now() - INTERVAL 7 DAY"],
      ["a day or less", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY"],
      [`more than ${SQL_WINDOW_MAX_DAYS} days`, `SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_WINDOW_MAX_DAYS + 1} DAY`],
      ["an OR", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY OR a = 1"],
      ["SETTINGS", "SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY SETTINGS max_threads = 1"],
    ]) ok(dayWindowPlan(q, at) === null, `not split: ${why}`);
    ok(dayWindowPlan("SELECT count_of_x FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY", at) !== null && dayWindowPlan("SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY AND tx_signer = 'group by sum('", at) !== null, "a column named like an aggregate, or the words inside a string, do not block the split");
  }

  // ---- a long-range select that times out whole is answered by day windows ----
  {
    reset();
    const r = await sql(days(7));
    ok(Array.isArray(r.rows) && r.rows.length === 8 * 3 && sortedAsc(r.rows), `the 7-day select is answered from its days, oldest first, in order (${r.rows?.length} rows)`);
    ok(r.complete === true && r.truncated === false && r.matched === r.returned && r.windowed?.by === "day" && r.windowed.days === 8 && r.windowed.daysRead === 8, `complete, with the days read in fields (${JSON.stringify(r.windowed)})`);
    ok(sent.length === 1 + 8 && !/toDateTime/.test(sent[0]), `one whole-range query, then one per day (${sent.length} queries)`);
    ok(/one day at a time/.test(r.note), "the note says it was read one day at a time");
  }
  {
    reset();
    const r = await sql(`${days(5)} ORDER BY block_time DESC`);
    ok(r.rows.length === 6 * 3 && sortedDesc(r.rows) && r.windowed.order === "desc", `ORDER BY block_time DESC reads newest first and merges in order (${r.rows.length})`);
  }
  // ---- the buyer's LIMIT and the row cap stop the walk ----
  {
    reset();
    const r = await sql(`${days(7)} LIMIT 5`);
    ok(r.rows.length === 5 && r.complete === true && sent.length === 1 + 2, `LIMIT 5 stops after the days that hold 5 rows (${r.rows.length} rows, ${sent.length} queries)`);
  }
  {
    reset();
    rowsPerDay = 300;
    const r = await sql(days(7));
    ok(r.rows.length === SQL_MAX_ROWS && r.truncated === true && r.complete === false && r.matchedIsLowerBound === true && sent.length === 1 + 4, `past the row cap the first ${SQL_MAX_ROWS} are served, marked truncated (${r.rows.length}, ${sent.length} queries)`);
    ok(/more than 1000 rows matched/.test(r.note), "the note names the cap");
  }
  // ---- partial answers say so in fields ----
  {
    reset();
    const at = Date.now();
    const p = dayWindowPlan(days(7), at);
    failDay = new Date(p.spans[3].from).toISOString().slice(0, 10);
    const r = await sql(days(7));
    ok(r.rows.length === 3 * 3 && r.complete === false && r.truncated === true && r.matchedIsLowerBound === true, `a day past the window ends the walk with the rows read so far, partial in fields (${r.rows.length})`);
    ok(r.windowed.daysRead === 3 && r.windowed.stoppedBy === "day-past-window" && r.windowed.coveredTo === new Date(p.spans[3].from).toISOString(), `the fields name what was covered (${JSON.stringify(r.windowed)})`);
    ok(/for the rest/.test(r.note), "the note says how to read the rest");
  }
  {
    reset();
    dayDelayMs = 400;
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "5000";
    const r = await sql(days(7));
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(r.complete === false && r.windowed.stoppedBy === "time" && r.windowed.daysRead >= 1 && r.windowed.daysRead < 8, `the walk stops inside the call's time budget, partial in fields (${r.windowed?.daysRead} days)`);
  }
  // ---- uncharged as before when nothing is delivered ----
  {
    reset();
    const at = Date.now();
    const p = dayWindowPlan(days(7), at);
    failDay = new Date(at - 7 * DAY).toISOString().slice(0, 10); // the first (open-below) day
    void p;
    const e = await sql(days(7)).catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && e?.charged === false, `no day answering: the same uncharged narrow-query 422 (${e?.statusCode})`);
  }
  {
    reset();
    rowsPerDay = 0;
    const r = await sql(days(3));
    ok(Array.isArray(r.rows) && r.rows.length === 0 && r.complete === true && r.windowed.daysRead === 4, "every day read and none matched: a complete answer with no rows");
  }
  // ---- aggregates and other queries are passed through unchanged ----
  {
    reset();
    const agg = "SELECT executing_account, count() AS n FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY GROUP BY executing_account";
    const e = await sql(agg).catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && sent.length === 1 && !/toDateTime/.test(sent[0]), `an aggregate is not split: one query, the uncharged 422 as before (${sent.length})`);
    reset();
    wholeAnswers = true;
    const ok200 = await sql(agg);
    ok(ok200.rows?.length === 1 && !ok200.windowed && sent.length === 1, "an aggregate the service answers is served as before");
    reset();
    wholeAnswers = true;
    const plain = await sql(days(7));
    ok(!plain.windowed && sent.length === 1, "a long-range select the service answers whole is sent once and not split");
    reset();
    const other = await sql("SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY ORDER BY tx_id").catch((x) => x);
    ok(other?.statusCode === 422 && sent.length === 1, "an ORDER BY on another column is answered as before");
  }
} finally {
  globalThis.fetch = realFetch;
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
