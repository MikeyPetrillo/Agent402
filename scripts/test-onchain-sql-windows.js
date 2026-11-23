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
const { CDP_TOOLS, dayWindowPlan, _setSlowQueryGatewayMsForTest, _setQueryHealthForTest, _resetSqlPacerForTest, SQL_MAX_ROWS, SQL_WINDOW_MAX_DAYS, SQL_WINDOW_MAX_QUERIES, QUERY_HEALTH_SQL, SQL_QUERY_BUDGET, SQL_RANGE_MAX_DAYS, SQL_RANGE_MAX_QUERIES, SQL_RANGE_RUN_SECONDS, SQL_RANGE_PATH, SQL_WEEK_MAX_DAYS, SQL_WEEK_MAX_QUERIES, SQL_WEEK_BUDGET_MS, SQL_WEEK_PATH, SVM_SQL_BUDGET_MS } = cdp;
const { EVM_RUN_SECONDS } = await import("../src/evm-validity.js");
const { isLongRunningSlug } = await import("../src/composite-spend-guard.js");
const { asyncProfileOf } = await import("../src/slow-routes.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
const { SLOW_TOOL_SECONDS } = await import("../src/avm-validity.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sql = (q, req) => CDP_TOOLS.find((t) => t.slug === "onchain-sql").handler({ sql: q }, req);
const RANGE = CDP_TOOLS.find((t) => t.slug === "onchain-sql-range");
const sqlRange = (q, req) => RANGE.handler({ sql: q }, req);
const WEEK = CDP_TOOLS.find((t) => t.slug === "onchain-sql-week");
const sqlWeek = (q, req) => WEEK.handler({ sql: q }, req);
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
let failDay = null;
let onDaySent = null; // called after each day query is received // ISO date (YYYY-MM-DD) whose query answers the slow 502
let wholeAnswers = false;
let whole503 = 0; // whole-range sends that answer 503 before the slow 502
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
    if (whole503 > 0) { whole503--; return J(503, { errorMessage: "unavailable" }); }
    if (wholeAnswers) return J(200, { result: [{ n: 1 }] });
    return new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
  }
  const from = ge ? Date.parse(ge[1].replace(" ", "T") + "Z") : (lt ? Date.parse(lt[1].replace(" ", "T") + "Z") - DAY : 0);
  const day = new Date(from).toISOString().slice(0, 10);
  if (onDaySent) onDaySent(day);
  if (failDay === day) return new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
  const desc = /ORDER BY "?block_time"? DESC/i.test(q);
  const limits = [...q.matchAll(/\bLIMIT (\d+)/g)].map((m) => Number(m[1]));
  const cap = limits.length ? Math.min(...limits) : Infinity;
  const rows = [];
  for (let i = 0; i < rowsPerDay; i++) rows.push({ block_time: new Date(from + Math.floor((i + 0.5) * DAY / rowsPerDay)).toISOString(), day });
  if (desc) rows.reverse();
  return new Promise((r) => setTimeout(() => r(J(200, { result: rows.slice(0, cap) })), dayDelayMs));
};
const reset = () => { sent = []; rowsPerDay = 3; dayDelayMs = 5; failDay = null; wholeAnswers = false; whole503 = 0; onDaySent = null; };
const days = (n) => `SELECT tx_id, block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${n} DAY AND executing_account = 'x'`;
// Day queries one windowed call can send after its whole-range send.
const D = SQL_WINDOW_MAX_QUERIES - 1;
// A range just over a day that crosses one UTC midnight: two days, so it fits
// the limit (waits out the first two minutes after midnight, where no such
// range in whole minutes exists).
async function twoDayRange() {
  for (;;) {
    const now = Date.now(), m = Math.floor((now % DAY) / 60_000);
    if (m >= 2) return `SELECT tx_id, block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${1440 + Math.floor(m / 2)} MINUTE AND executing_account = 'x'`;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
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

  // ---- the windowed call's query limit ----
  ok(D >= 1, `a windowed call has room for at least one day query (limit ${SQL_WINDOW_MAX_QUERIES})`);
  // ---- a range that fits the limit is answered whole from its days ----
  {
    reset();
    const q = await twoDayRange();
    ok(D >= 2 && dayWindowPlan(q).spans.length === 2, "the two-day range splits into two UTC days");
    const r = await sql(q);
    ok(Array.isArray(r.rows) && r.rows.length === 2 * 3 && sortedAsc(r.rows), `the two-day select is answered from its days, oldest first, in order (${r.rows?.length} rows)`);
    ok(r.complete === true && r.truncated === false && r.matched === r.returned && r.windowed?.by === "day" && r.windowed.days === 2 && r.windowed.daysRead === 2, `complete, with the days read in fields (${JSON.stringify(r.windowed)})`);
    ok(sent.length === 1 + 2 && !/toDateTime/.test(sent[0]), `one whole-range query, then one per day (${sent.length} queries)`);
    ok(/one day at a time/.test(r.note), "the note says it was read one day at a time");
  }
  {
    reset();
    const q = await twoDayRange();
    const r = await sql(`${q} ORDER BY block_time DESC`);
    ok(r.rows.length === 2 * 3 && sortedDesc(r.rows) && r.windowed.order === "desc" && r.complete === true, `ORDER BY block_time DESC reads newest first and merges in order (${r.rows.length})`);
  }
  // ---- a range past the limit reads the first days and marks the rest ----
  for (const n of [7, SQL_WINDOW_MAX_DAYS]) {
    reset();
    const p = dayWindowPlan(days(n), Date.now());
    const r = await sql(days(n));
    ok(sent.length <= SQL_WINDOW_MAX_QUERIES && sent.length === 1 + D, `${n} days: the call sends ${sent.length} queries, at most ${SQL_WINDOW_MAX_QUERIES}`);
    ok(r.rows.length === D * 3 && sortedAsc(r.rows) && r.complete === false && r.truncated === true && r.matchedIsLowerBound === true, `${n} days: the rows of the first ${D} days, partial in fields (${r.rows.length})`);
    ok(r.windowed.daysRead === D && r.windowed.days === p.spans.length && r.windowed.stoppedBy === "query-limit" && r.windowed.coveredTo === new Date(p.spans[D].from).toISOString(), `${n} days: the fields name the query limit and what was covered (${JSON.stringify(r.windowed)})`);
    ok(new RegExp(`limit of ${SQL_WINDOW_MAX_QUERIES} queries`).test(r.note) && /for the rest/.test(r.note), `${n} days: the note names the limit and how to read the rest`);
  }
  {
    reset();
    const r = await sql(`${days(7)} ORDER BY block_time DESC`);
    ok(r.rows.length === D * 3 && sortedDesc(r.rows) && r.windowed.order === "desc" && r.windowed.stoppedBy === "query-limit" && sent.length === 1 + D, `DESC past the limit reads the newest ${D} days (${r.rows.length})`);
  }
  // ---- the buyer's LIMIT and the row cap stop the walk ----
  {
    reset();
    const r = await sql(`${days(7)} LIMIT 5`);
    ok(r.rows.length === 5 && r.complete === true && sent.length === 1 + 2, `LIMIT 5 stops after the days that hold 5 rows (${r.rows.length} rows, ${sent.length} queries)`);
  }
  {
    reset();
    rowsPerDay = SQL_MAX_ROWS;
    const r = await sql(days(7));
    ok(r.rows.length === SQL_MAX_ROWS && r.truncated === true && r.complete === false && r.matchedIsLowerBound === true && sent.length === 1 + 2, `past the row cap the first ${SQL_MAX_ROWS} are served, marked truncated (${r.rows.length}, ${sent.length} queries)`);
    ok(/more than 1000 rows matched/.test(r.note), "the note names the cap");
  }
  // ---- partial answers say so in fields ----
  {
    reset();
    const at = Date.now();
    const p = dayWindowPlan(days(7), at);
    failDay = new Date(p.spans[1].from).toISOString().slice(0, 10);
    const r = await sql(days(7));
    ok(r.rows.length === 3 && r.complete === false && r.truncated === true && r.matchedIsLowerBound === true, `a day past the window ends the walk with the rows read so far, partial in fields (${r.rows.length})`);
    ok(r.windowed.daysRead === 1 && r.windowed.stoppedBy === "day-past-window" && r.windowed.coveredTo === new Date(p.spans[1].from).toISOString(), `the fields name what was covered (${JSON.stringify(r.windowed)})`);
    ok(/for the rest/.test(r.note), "the note says how to read the rest");
  }
  {
    reset();
    dayDelayMs = 1200;
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "5000";
    const r = await sql(days(7));
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(r.complete === false && r.windowed.stoppedBy === "time" && r.windowed.daysRead >= 1 && r.windowed.daysRead < D, `the walk stops inside the call's time budget, partial in fields (${r.windowed?.daysRead} days)`);
  }
  // ---- uncharged as before when nothing is delivered ----
  {
    reset();
    const at = Date.now();
    failDay = new Date(at - 7 * DAY).toISOString().slice(0, 10); // the first (open-below) day
    const e = await sql(days(7)).catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && e?.charged === false, `no day answering: the same uncharged narrow-query 422 (${e?.statusCode})`);
  }
  {
    reset();
    rowsPerDay = 0;
    const r = await sql(await twoDayRange());
    ok(Array.isArray(r.rows) && r.rows.length === 0 && r.complete === true && r.windowed.daysRead === 2, "every day read and none matched: a complete answer with no rows");
    reset();
    rowsPerDay = 0;
    const r0 = await sql(days(7)).catch((x) => x);
    ok(!(r0 instanceof Error) && Array.isArray(r0.rows) && r0.rows.length === 0 && r0.complete === false && r0.truncated === true && r0.matched === 0 && r0.matchedIsLowerBound === true && sent.length === 1 + D, `no rows in the days the limit allows: an answer with no rows, marked partial, never complete (${r0?.statusCode ?? "200"}, ${sent.length} queries)`);
    ok(r0.windowed?.daysRead === D && r0.windowed.coveredFrom && r0.windowed.coveredTo && /for the rest/.test(r0.note || ""), `...with the days read, what they cover and the range left (${JSON.stringify(r0.windowed)})`);
  }
  // ---- ORDER BY is read on the same positions as the clauses ----
  {
    const at = Date.now();
    const byOther = 'SELECT "program_id", "block_time" FROM solana.instructions WHERE block_time >= now() - INTERVAL 5 DAY ORDER BY 1, block_time LIMIT 100';
    ok(dayWindowPlan(byOther, at) === null, "ORDER BY 1, block_time after quoted columns is not split (its first key is not block_time)");
    const quoted = 'SELECT "program_id", "block_time" FROM solana.instructions WHERE block_time >= now() - INTERVAL 5 DAY ORDER BY "block_time" DESC LIMIT 100';
    const p = dayWindowPlan(quoted, at);
    ok(p && p.direction === "desc" && p.limit === 100, `ORDER BY "block_time" DESC is split newest first (${JSON.stringify(p && { direction: p.direction, limit: p.limit })})`);
    ok(dayWindowPlan('SELECT "a b c d e f", tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY ORDER BY tx_id', at) === null, "a long quoted column before FROM does not shift where ORDER BY is read");
    reset();
    const e = await sql(byOther).catch((x) => x);
    ok(e?.statusCode === 422 && sent.length === 1, `ORDER BY 1, block_time: one whole-range query and the uncharged 422, never a day's rows (${e?.statusCode}, ${sent.length})`);
  }
  // ---- a long identifier costs linear time in the plan ----
  {
    const id = "test".repeat(14_500);
    const hostile = [
      `SELECT ${id} FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY`,
      `SELECT x AS ${id}test FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY`,
      `SELECT ${id}( FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY`,
    ];
    let worst = 0;
    for (const q of hostile) { let best = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); dayWindowPlan(q); best = Math.min(best, performance.now() - t); } worst = Math.max(worst, best); }
    ok(worst < 50, `a ${id.length.toLocaleString("en-US")}-character identifier is planned in under 50 ms (worst ${worst.toFixed(1)} ms)`);
    ok(dayWindowPlan(`SELECT tx_id FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY AND welchttest(a, b) > 0`) === null && dayWindowPlan(`SELECT ${"f".repeat(70)}(x) FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY`) === null, "an aggregate named on the list, and a function name too long to read, are not split");
    ok(dayWindowPlan("SELECT tx_id, lower(tx_signer) FROM solana.instructions WHERE block_time > now() - INTERVAL 5 DAY") !== null, "an ordinary function call is still split");
  }
  // ---- a buyer who hung up gets no more day queries ----
  {
    reset();
    const req = {};
    onDaySent = () => { req.__a402ClientGoneAt = Date.now(); };
    const r = await sql(days(7), req).catch((x) => x);
    ok(!(r instanceof Error) && r.windowed?.stoppedBy === "caller-gone" && r.windowed.daysRead === 1 && r.complete === false && sent.length === 2, `a caller gone after the first day stops the walk: no further day query, and the days read are answered for the settlement and hang-up rules to decide (${r?.statusCode ?? r?.windowed?.stoppedBy}, ${sent.length} queries)`);
    reset();
    const req2 = {};
    onDaySent = () => { req2.__a402ClientGoneAt = Date.now(); };
    failDay = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    const e = await sql(days(7), req2).catch((x) => x);
    ok(e?.statusCode === 422 && e?.charged === false, `a caller gone before any day was read: the uncharged 422 (${e?.statusCode})`);
  }
  // ---- the description states the per-call limit ----
  {
    const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
    const days = SQL_WINDOW_MAX_QUERIES - 1;
    for (const [where, text] of [["tool description", tool.description], ["sql field description", tool.discovery.inputSchema.properties.sql.description]]) {
      ok(text.includes(`at most ${SQL_WINDOW_MAX_QUERIES} queries per call`) && text.includes(`${days} ${days === 1 ? "day" : "days"}`) && /windowed\.stoppedBy/.test(text), `the ${where} states the per-call query limit, the days it reads and where the next range is named`);
    }
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

  // ---- onchain-sql points a walk its limit ended to the range route ----
  {
    reset();
    const r = await sql(days(7));
    const paths = (r.longerRange || []).map((x) => x.path);
    ok(r.complete === false && paths.join(",") === "/api/onchain-sql-week,/api/onchain-sql-range" && SQL_WEEK_PATH === paths[0] && SQL_RANGE_PATH === paths[1], `a 7-day walk the query limit ended names both longer routes in a field (${paths.join(", ")})`);
    const [wk, m] = r.longerRange;
    ok(wk.maxDays === SQL_WEEK_MAX_DAYS && wk.rails === "all" && wk.async === false && m.maxDays === SQL_RANGE_MAX_DAYS && m.rails === "x402-exact-evm" && m.async === true, `each with its most days and the payment it takes (${JSON.stringify(r.longerRange)})`);
    ok(r.note.endsWith(`${SQL_WEEK_PATH} reads up to ${SQL_WEEK_MAX_DAYS} days of such a query in one call on every payment rail; ${SQL_RANGE_PATH} reads up to ${SQL_RANGE_MAX_DAYS} days of such a query in one call on x402 exact on EVM chains, as a job (Prefer: respond-async).`) && r.note.split(SQL_WEEK_PATH).length === 2, "the note adds one factual sentence naming them");
    reset();
    const r14 = await sql(days(14));
    ok((r14.longerRange || []).map((x) => x.path).join(",") === SQL_RANGE_PATH, `a 14-day walk names only the route whose days cover it (${JSON.stringify(r14.longerRange)})`);
    reset();
    const c = await sql(await twoDayRange());
    ok(c.complete === true && !("longerRange" in c), "a complete windowed answer names no other route");
    reset();
    rowsPerDay = SQL_MAX_ROWS;
    const cut = await sql(days(7));
    ok(cut.truncated === true && !("longerRange" in cut), "a walk the row cap ended names no other route (the range route has the same cap)");
    reset();
    failDay = new Date(dayWindowPlan(days(7), Date.now()).spans[1].from).toISOString().slice(0, 10);
    const f = await sql(days(7));
    ok(f.windowed.stoppedBy === "day-past-window" && !("longerRange" in f), "a walk a slow day ended names no other route");
    reset();
    wholeAnswers = true;
    const w = await sql(days(7));
    ok(!("longerRange" in w), "an answer read whole names no other route");
  }

  // ---- onchain-sql-range: its limits, wiring and price basis ----
  ok(RANGE && RANGE.route === "POST /api/onchain-sql-range" && /^\$\d+\.\d{2}$/.test(RANGE.price), `the range route is listed with a cent price (${RANGE?.price})`);
  ok(SQL_RANGE_MAX_DAYS === SQL_WINDOW_MAX_DAYS && SQL_RANGE_MAX_DAYS === 31, `the range route reads up to ${SQL_RANGE_MAX_DAYS} days`);
  ok(SQL_RANGE_MAX_QUERIES === 2 + SQL_RANGE_MAX_DAYS + 1 && SQL_RANGE_MAX_QUERIES >= SQL_QUERY_BUDGET, `its query limit is the whole-range send and its retry plus one query a day (${SQL_RANGE_MAX_QUERIES})`);
  ok(EVM_RUN_SECONDS["onchain-sql-range"] === SQL_RANGE_RUN_SECONDS && RANGE.handler.__budgetMs === SQL_RANGE_RUN_SECONDS * 1000, `its handler budget is its run budget (${SQL_RANGE_RUN_SECONDS} s)`);
  const prof = asyncProfileOf(RANGE);
  ok(prof?.slow === true && prof.maxSeconds === SQL_RANGE_RUN_SECONDS && isLongRunningSlug("onchain-sql-range"), "it runs as a job (slow route) and is EVM exact only (long-running)");
  ok(WALLET_ONLY_SLUGS.has("onchain-sql-range"), "it is wallet-only");
  ok(new RegExp(`up to ${SQL_RANGE_MAX_DAYS} days`).test(RANGE.description) && /partial/.test(RANGE.description) && /one UTC day at a time/.test(RANGE.description), "its description names the day reading, the most days and the partial marking");
  ok(/x402 exact on EVM chains/.test(RANGE.description) && /runs as a job \(Prefer: respond-async\)/.test(RANGE.description), "its description names the payment it takes and that it runs as a job");

  // ---- a 31-day walk in one call, merged in order ----
  {
    reset();
    const q = days(SQL_RANGE_MAX_DAYS);
    const p = dayWindowPlan(q, Date.now());
    const r = await sqlRange(q);
    ok(p.spans.length >= SQL_RANGE_MAX_DAYS && r.rows.length === p.spans.length * 3 && sortedAsc(r.rows), `${SQL_RANGE_MAX_DAYS} days: every day read, ${r.rows.length} rows merged oldest first`);
    ok(r.complete === true && r.truncated === false && r.windowed.daysRead === p.spans.length && r.windowed.days === p.spans.length && !r.windowed.stoppedBy && !("longerRange" in r), `complete, the days read in fields (${JSON.stringify(r.windowed)})`);
    ok(sent.length === 1 + p.spans.length && sent.length <= SQL_RANGE_MAX_QUERIES && !/toDateTime/.test(sent[0]), `one whole-range query, then one a day (${sent.length} queries, limit ${SQL_RANGE_MAX_QUERIES})`);
    const daysSeen = r.rows.map((x) => x.day).filter((d, i, a) => i === 0 || a[i - 1] !== d);
    ok(daysSeen.length === p.spans.length && new Set(daysSeen).size === daysSeen.length, "each day's rows appear once, in day order");
  }
  {
    reset();
    const r = await sqlRange(`${days(SQL_RANGE_MAX_DAYS)} ORDER BY block_time DESC`);
    ok(r.complete === true && sortedDesc(r.rows) && r.windowed.order === "desc" && r.rows.length === r.windowed.days * 3, `DESC over ${SQL_RANGE_MAX_DAYS} days reads newest first and merges in order (${r.rows.length})`);
  }
  {
    reset();
    whole503 = 1;
    const p = dayWindowPlan(days(SQL_RANGE_MAX_DAYS), Date.now());
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    ok(r.complete === true && sent.length === 2 + p.spans.length && sent.length <= SQL_RANGE_MAX_QUERIES, `a whole-range send retried once still leaves room for every day (${sent.length} queries of ${SQL_RANGE_MAX_QUERIES})`);
  }
  // ---- partial answers say so in fields ----
  {
    reset();
    dayDelayMs = 1200;
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "6000";
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(r.complete === false && r.truncated === true && r.matchedIsLowerBound === true && r.windowed.stoppedBy === "time" && r.windowed.daysRead >= 1 && r.windowed.daysRead < r.windowed.days && r.windowed.coveredFrom && r.windowed.coveredTo, `the call's time ends the walk: partial in fields (${JSON.stringify(r.windowed)})`);
    ok(sortedAsc(r.rows) && /for the rest/.test(r.note) && !("longerRange" in r), "the rows read so far, in order, with the range left to read and no pointer");
  }
  {
    reset();
    rowsPerDay = 100;
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    ok(r.rows.length === SQL_MAX_ROWS && r.truncated === true && r.complete === false && r.matchedIsLowerBound === true && sent.length === 1 + 11 && sortedAsc(r.rows), `the row cap ends the walk: the first ${SQL_MAX_ROWS} rows, marked truncated (${sent.length} queries)`);
  }
  {
    reset();
    const p = dayWindowPlan(days(SQL_RANGE_MAX_DAYS), Date.now());
    failDay = new Date(p.spans[20].from).toISOString().slice(0, 10);
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    ok(r.complete === false && r.windowed.daysRead === 20 && r.windowed.stoppedBy === "day-past-window" && r.windowed.coveredTo === new Date(p.spans[20].from).toISOString(), `a slow day ends the walk with the 20 days before it, partial in fields (${JSON.stringify(r.windowed)})`);
  }
  {
    reset();
    rowsPerDay = 0;
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    const n = dayWindowPlan(days(SQL_RANGE_MAX_DAYS), Date.now()).spans.length;
    ok(Array.isArray(r.rows) && r.rows.length === 0 && r.complete === true && r.windowed.daysRead === n && sent.length === 1 + n, `every day read and none matched: a complete answer with no rows (${sent.length} queries)`);
  }
  {
    reset();
    rowsPerDay = 0;
    dayDelayMs = 1200;
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "6000";
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS)).catch((x) => x);
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(!(r instanceof Error) && r.rows.length === 0 && r.complete === false && r.matchedIsLowerBound === true && r.windowed.stoppedBy === "time" && r.windowed.daysRead >= 1 && r.windowed.coveredTo && /for the rest/.test(r.note), `range: days read with no rows before the time ran out answer no rows, partial, with the range left (${r?.statusCode ?? JSON.stringify(r?.windowed)})`);
  }
  {
    reset();
    const e = await sqlRange(days(SQL_RANGE_MAX_DAYS + 1)).catch((x) => x);
    ok(e?.statusCode === 422 && e?.charged === false && sent.length === 1, `more than ${SQL_RANGE_MAX_DAYS} days is not split: one query, the uncharged 422 (${e?.statusCode}, ${sent.length})`);
  }
  // ---- aggregates and other queries answer exactly as onchain-sql ----
  {
    const agg = "SELECT executing_account, count() AS n FROM solana.instructions WHERE block_time > now() - INTERVAL 30 DAY GROUP BY executing_account";
    reset();
    const a1 = await sql(agg).catch((x) => x);
    const n1 = sent.length;
    reset();
    const a2 = await sqlRange(agg).catch((x) => x);
    ok(a2?.statusCode === 422 && a1?.statusCode === a2.statusCode && a1.message === a2.message && sent.length === n1 && n1 === 1, `an aggregate past the window: the same uncharged 422 on both routes, one query (${a2?.statusCode})`);
    reset();
    wholeAnswers = true;
    const b1 = await sql(agg);
    reset();
    wholeAnswers = true;
    const b2 = await sqlRange(agg);
    ok(JSON.stringify(b1) === JSON.stringify(b2) && sent.length === 1, "an aggregate the service answers: the same answer on both routes");
    reset();
    wholeAnswers = true;
    const w = await sqlRange(days(SQL_RANGE_MAX_DAYS));
    ok(!w.windowed && sent.length === 1, "a long range the service answers whole is sent once and not split");
  }
  // ---- onchain-sql-week: a week on every rail, synchronously ----
  ok(WEEK && WEEK.route === "POST /api/onchain-sql-week" && /^\$\d+\.\d{2}$/.test(WEEK.price), `the week route is listed with a cent price (${WEEK?.price})`);
  ok(SQL_WEEK_MAX_DAYS === 7 && SQL_WEEK_MAX_QUERIES === 2 + SQL_WEEK_MAX_DAYS + 1, `the week route reads up to ${SQL_WEEK_MAX_DAYS} days in at most ${SQL_WEEK_MAX_QUERIES} queries`);
  ok(SQL_WEEK_BUDGET_MS === SVM_SQL_BUDGET_MS && WEEK.handler.__budgetMs === SQL_WEEK_BUDGET_MS, `its handler budget is the Solana payment's (${SQL_WEEK_BUDGET_MS} ms) on every rail`);
  ok(!isLongRunningSlug("onchain-sql-week") && !Object.hasOwn(EVM_RUN_SECONDS, "onchain-sql-week") && asyncProfileOf(WEEK) === null, "it is not long-running and not a job route: every rail, answered on the connection");
  ok(WALLET_ONLY_SLUGS.has("onchain-sql-week"), "it is wallet-only");
  ok(SLOW_TOOL_SECONDS["onchain-sql-week"] * 1000 > SQL_WEEK_BUDGET_MS && SLOW_TOOL_SECONDS["onchain-sql-range"] > SQL_RANGE_RUN_SECONDS, "an Algorand payment must outlive each route's budget, or it is refused before any query");
  ok(/up to 7 days/.test(WEEK.description) && /every payment rail/.test(WEEK.description) && /partial/.test(WEEK.description) && /stops inside 40 seconds/.test(WEEK.description), "its description names the days, the rails, the time and the partial marking");
  {
    reset();
    const q = days(SQL_WEEK_MAX_DAYS);
    const p = dayWindowPlan(q, Date.now());
    const r = await sqlWeek(q);
    ok(r.complete === true && r.rows.length === p.spans.length * 3 && sortedAsc(r.rows) && r.windowed.daysRead === p.spans.length && sent.length === 1 + p.spans.length && sent.length <= SQL_WEEK_MAX_QUERIES && !("longerRange" in r), `${SQL_WEEK_MAX_DAYS} days: every day read and merged in order (${r.rows.length} rows, ${sent.length} queries)`);
    reset();
    const d = await sqlWeek(`${q} ORDER BY block_time DESC`);
    ok(d.complete === true && sortedDesc(d.rows) && d.windowed.order === "desc", "DESC reads newest first");
    reset();
    whole503 = 1;
    const t = await sqlWeek(q);
    ok(t.complete === true && sent.length === 2 + p.spans.length && sent.length <= SQL_WEEK_MAX_QUERIES, `a retried whole-range send still leaves room for every day (${sent.length} of ${SQL_WEEK_MAX_QUERIES})`);
  }
  {
    reset();
    const r = await sqlWeek(days(14));
    ok(r.complete === false && r.windowed.stoppedBy === "query-limit" && r.windowed.daysRead === SQL_WEEK_MAX_QUERIES - 1 && sent.length === SQL_WEEK_MAX_QUERIES && sortedAsc(r.rows), `past a week: the first ${SQL_WEEK_MAX_QUERIES - 1} days, marked partial (${r.windowed.daysRead} days, ${sent.length} queries)`);
    ok((r.longerRange || []).map((x) => x.path).join(",") === SQL_RANGE_PATH && r.note.endsWith(`${SQL_RANGE_PATH} reads up to ${SQL_RANGE_MAX_DAYS} days of such a query in one call on x402 exact on EVM chains, as a job (Prefer: respond-async).`), `and names the range route, with its payment (${JSON.stringify(r.longerRange)})`);
  }
  {
    reset();
    dayDelayMs = 1200;
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "6000";
    const r = await sqlWeek(days(SQL_WEEK_MAX_DAYS));
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(r.complete === false && r.truncated === true && r.windowed.stoppedBy === "time" && r.windowed.daysRead >= 1 && r.windowed.coveredTo && /for the rest/.test(r.note) && (r.longerRange || []).map((x) => x.path).join(",") === SQL_RANGE_PATH, `the call's time ends a slow week early: partial in fields, the range route named (${JSON.stringify(r.windowed)})`);
  }
  {
    const agg = "SELECT executing_account, count() AS n FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY GROUP BY executing_account";
    reset();
    const a1 = await sql(agg).catch((x) => x);
    reset();
    const a2 = await sqlWeek(agg).catch((x) => x);
    ok(a2?.statusCode === 422 && a1?.message === a2?.message && sent.length === 1, "an aggregate on the week route answers exactly as onchain-sql (one query, the same 422)");
    reset();
    const quoted = `SELECT "tx_id", block_time FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY ORDER BY 1, block_time`;
    const e = await sqlWeek(quoted).catch((x) => x);
    ok(e?.statusCode === 422 && sent.length === 1, "ORDER BY 1, block_time after a quoted column is not walked on the week route");
  }
  // ---- a buyer who hung up gets no more of the range walk ----
  {
    reset();
    const req = {};
    let n = 0;
    onDaySent = () => { if (++n === 3) req.__a402ClientGoneAt = Date.now(); };
    const r = await sqlRange(days(SQL_RANGE_MAX_DAYS), req).catch((x) => x);
    ok(!(r instanceof Error) && r.windowed?.stoppedBy === "caller-gone" && r.windowed.daysRead === 3 && sent.length === 1 + 3, `a caller gone during the ${SQL_RANGE_MAX_DAYS}-day walk stops it: no further day query; the days read are answered for the settlement and hang-up rules to decide (${r?.statusCode ?? r?.windowed?.stoppedBy}, ${sent.length} queries)`);
  }
  // ---- hostile and quoted queries on the range route ----
  {
    reset();
    const longName = `SELECT ${"a".repeat(59_000)}test(tx_id) FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY`;
    const t0 = performance.now();
    const p = dayWindowPlan(longName, Date.now());
    const planMs = performance.now() - t0;
    ok(planMs < 250, `a 59,000-character identifier is read in bounded time (${planMs.toFixed(1)} ms)`);
    const t1 = performance.now();
    const r = await sqlRange(longName).catch((x) => x);
    ok(performance.now() - t1 < 5_000 && (p === null ? sent.length === 1 && r?.statusCode === 422 : true), `the range route answers it promptly (${(performance.now() - t1).toFixed(0)} ms, ${sent.length} queries, plan ${p ? "split" : "not split"})`);
    // The plan's hostile identifiers, over the range route's longest walk.
    const id = "test".repeat(14_500);
    for (const q of [
      `SELECT ${id} FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY`,
      `SELECT x AS ${id}test FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY`,
      `SELECT ${id}( FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY`,
    ]) {
      reset();
      const t = performance.now();
      const plan = dayWindowPlan(q);
      const planMs = performance.now() - t;
      const out = await sqlRange(q).catch((x) => x);
      const walked = !!out?.windowed;
      ok(planMs < 50 && (walked ? out.complete === true && sent.length === 1 + plan.spans.length && sortedAsc(out.rows) : out?.statusCode === 422 && sent.length === 1), `a ${id.length.toLocaleString("en-US")}-character identifier on the range route: planned in ${planMs.toFixed(1)} ms, ${walked ? `walked ${out.windowed.daysRead} days in order` : "answered as onchain-sql"} (${sent.length} queries)`);
    }
    reset();
    const qDesc = `SELECT "program_id", "block_time" FROM solana.instructions WHERE block_time >= now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY ORDER BY "block_time" DESC LIMIT 1000`;
    const rd = await sqlRange(qDesc);
    ok(rd.windowed?.order === "desc" && rd.complete === true && sortedDesc(rd.rows) && rd.windowed.daysRead === rd.windowed.days, `ORDER BY "block_time" DESC after quoted columns walks ${SQL_RANGE_MAX_DAYS} days newest first (${rd.windowed?.daysRead})`);
    reset();
    const quoted = `SELECT "tx_id", 'x' AS "block_time_label", block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY ORDER BY 1, block_time`;
    ok(dayWindowPlan(quoted, Date.now()) === null, "quoted columns with ORDER BY 1, block_time are not windowed");
    const e = await sqlRange(quoted).catch((x) => x);
    ok(e?.statusCode === 422 && e?.charged === false && sent.length === 1, `the range route answers it as onchain-sql: one query, the uncharged 422 (${e?.statusCode}, ${sent.length})`);
    reset();
    const quotedOk = `SELECT "tx_id", block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_RANGE_MAX_DAYS} DAY AND tx_signer = 'it''s ORDER BY 1' ORDER BY block_time`;
    const r2 = await sqlRange(quotedOk);
    ok(r2.complete === true && r2.windowed?.days >= SQL_RANGE_MAX_DAYS && sortedAsc(r2.rows), `quoted columns and a quoted ORDER BY inside a string still walk ${SQL_RANGE_MAX_DAYS} days in order (${r2.windowed?.daysRead})`);
  }
  // ---- what a buyer reads before buying: the charge rule and the routes' terms ----
  {
    const CHARGE = "A walk that read at least one day is a served answer and is charged at this route's price, even when it is partial or holds no rows; a walk that read no day answers 422 and is not charged (a Tempo push payment is final before the call and is booked as owed).";
    for (const slug of ["onchain-sql", "onchain-sql-week", "onchain-sql-range"]) {
      const t = CDP_TOOLS.find((x) => x.slug === slug);
      ok(t.description.includes(CHARGE), `${slug}: the description states the charge rule`);
      ok(t.discovery.inputSchema.properties.sql.description.includes(CHARGE), `${slug}: the sql field states the charge rule`);
    }
    const WEEK = CDP_TOOLS.find((x) => x.slug === "onchain-sql-week"), RANGE_T = CDP_TOOLS.find((x) => x.slug === "onchain-sql-range");
    ok(/its day walk stops inside \d+ seconds/.test(WEEK.description) && !/answered within/.test(WEEK.description), "onchain-sql-week: the time is the walk's, not a promise about the answer");
    for (const t of [WEEK, RANGE_T]) ok(t.description.includes("Any query that is not read by day gets the same answer as on onchain-sql, at this route's price; send it to onchain-sql for the lower price.") && !/answered exactly as onchain-sql answers them/.test(t.description), `${t.slug}: other queries are named at this route's price`);
    // The partial note: the charge, and no rows named when there are none.
    reset();
    rowsPerDay = 0;
    const z = await sql(days(7));
    ok(/This partial answer was charged; sending the rest of the range is a new call\./.test(z.note) && !/these rows cover/.test(z.note) && /the days read cover/.test(z.note), `the partial note states the charge and names the days read, not rows (${z.note})`);
    reset();
    const r1 = await sql(days(7));
    ok(/This partial answer was charged; sending the rest of the range is a new call\./.test(r1.note) && /these rows cover/.test(r1.note), "a partial answer with rows says so too");
  }

} finally {
  globalThis.fetch = realFetch;
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
