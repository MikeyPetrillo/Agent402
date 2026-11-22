// onchain-sql's busy answer, its in-flight places and the send pacer's clock
// (offline: the query service is a stubbed fetch, no network, no real keys).
//
//   - a busy refusal's Retry-After is spread over 4 to 6 s, so callers refused
//     together do not all come back in the same second;
//   - a query that finds every in-flight place taken waits for one, first
//     come first served, as far out as a send slot may be (the slot reach,
//     within the handler budget), and is refused busy only past that;
//   - the pacer reads a monotonic clock: a wall clock stepped back does not
//     hold or refuse the sends after it.
//
//   node scripts/test-onchain-sql-pacer.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "pkcs8", format: "pem" });
delete process.env.ONCHAIN_SQL_INFLIGHT_MAX;
delete process.env.CDP_SQL_SEND_GAP_MS;
delete process.env.RATE_LIMIT_REPLICAS;
const m = await import("../src/tools/cdp-kit.js");
const { CDP_TOOLS, _resetSqlPacerForTest, _setSqlPacerClockForTest, _buyerQueriesInflightForTest, BUYER_QUERY_INFLIGHT_MAX } = m;

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = "SELECT block_number FROM base.blocks";
const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
const run = (req) => tool.handler({ sql }, req);
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realDateNow = Date.now;
let fetchImpl = async () => J(200, { result: [{ x: 1 }] });
globalThis.fetch = (...a) => fetchImpl(...a);
const T0 = 1_000_000;
const clockOf = () => { const c = { t: T0, slots: [] }; c.now = () => c.t; c.sleep = async (ms) => { c.slots.push(c.t + ms); }; return c; };

try {
  // ---------------------------------------------------------------- d-12 (a)
  // The busy refusal's Retry-After: 4 s plus a random 0 to 2 s, whole seconds.
  {
    const clock = clockOf();
    _setSqlPacerClockForTest(clock);
    _resetSqlPacerForTest(400_000, 1); // one send, then no slot in reach of anyone
    const first = await run();
    ok(first?.rowCount === 1, "a first query is sent");
    const seen = new Map();
    let shapes = true;
    for (let i = 0; i < 300; i++) {
      const e = await run().catch((x) => x);
      if (!(e?.statusCode === 429 && e?.hint === "busy" && e?.shed === true && /Nothing was charged\.$/.test(e?.message))) shapes = false;
      seen.set(e?.retryAfter, (seen.get(e?.retryAfter) || 0) + 1);
    }
    const values = [...seen.keys()].sort();
    ok(shapes && values.every((v) => Number.isInteger(v) && v >= 4 && v <= 6), `every busy refusal is a 429, shed, with a whole Retry-After of 4 to 6 s (${values.join(", ")})`);
    ok(values.join() === "4,5,6" && [...seen.values()].every((n) => n >= 40), `over 300 refusals each of 4, 5 and 6 s is given, so refused callers spread out (${values.map((v) => `${v} s x${seen.get(v)}`).join(", ")})`);
    _setSqlPacerClockForTest(null);
    _resetSqlPacerForTest(0);
  }

  // ---------------------------------------------------------------- d-12 (b)
  // Every place taken: the next query waits for one, first come first
  // served, and takes the first that comes free.
  {
    _resetSqlPacerForTest(0);
    const gates = [], sentTags = [];
    fetchImpl = async (url, init) => { sentTags.push(/AS (ninth|tenth)\b/.exec(String(init?.body))?.[1] || "held"); await new Promise((r) => gates.push(r)); return J(200, { result: [{ x: 1 }] }); };
    const release = () => { const r = gates.shift(); if (r) r(); };
    const tagged = (tag) => tool.handler({ sql: `SELECT block_number AS ${tag} FROM base.blocks` });
    const held = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => run());
    await sleep(30);
    ok(_buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX && gates.length === BUYER_QUERY_INFLIGHT_MAX, `${BUYER_QUERY_INFLIGHT_MAX} queries hold every place (${_buyerQueriesInflightForTest()})`);
    const order = [];
    const ninth = tagged("ninth").then((r) => { order.push("ninth"); return r; }, (e) => { order.push("ninth"); return e; });
    await sleep(10);
    const tenth = tagged("tenth").then((r) => { order.push("tenth"); return r; }, (e) => { order.push("tenth"); return e; });
    await sleep(300);
    ok(order.length === 0 && gates.length === BUYER_QUERY_INFLIGHT_MAX && _buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX, `a ninth and a tenth wait for a place, unsent, rather than being refused at once (${order.join(", ") || "both waiting"}, ${gates.length} sent)`);
    release(); // one place comes free: the ninth (first in) takes it
    await sleep(30);
    ok(gates.length === BUYER_QUERY_INFLIGHT_MAX && _buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX, `the place that came free is handed on, not counted down: still ${BUYER_QUERY_INFLIGHT_MAX} in flight (${_buyerQueriesInflightForTest()})`);
    ok(sentTags.slice(BUYER_QUERY_INFLIGHT_MAX).join() === "ninth", `the first to wait is the first sent: the ninth, while the tenth still waits (${sentTags.slice(BUYER_QUERY_INFLIGHT_MAX).join(", ")})`);
    release();
    await sleep(30);
    ok(sentTags.slice(BUYER_QUERY_INFLIGHT_MAX).join() === "ninth,tenth", `the next place goes to the tenth (${sentTags.slice(BUYER_QUERY_INFLIGHT_MAX).join(", ")})`);
    while (gates.length) { release(); await sleep(5); }
    const all = await Promise.all([...held, ninth, tenth]);
    ok(all.every((r) => r?.rowCount === 1) && _buyerQueriesInflightForTest() === 0, `every one of the ten is served and the count returns to zero (${all.map((r) => r?.statusCode ?? 200).join(",")})`);
  }

  // A query that waits past the slot reach (here the handler budget leaves
  // one second) is refused busy, unsent, and leaves the queue.
  {
    _resetSqlPacerForTest(0);
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "2500"; // reach: 2.5 s less the 1.5 s read floor
    const gates = [];
    fetchImpl = async () => { await new Promise((r) => gates.push(r)); return J(200, { result: [{ x: 1 }] }); };
    const held = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => run());
    await sleep(30);
    const t = realDateNow();
    const late = await run().catch((x) => x);
    const ms = realDateNow() - t;
    ok(late?.statusCode === 429 && late?.hint === "busy" && late?.shed === true && /answering 8 queries/.test(late?.message) && /Nothing was charged\.$/.test(late?.message) && ms >= 900 && ms < 2000 && gates.length === BUYER_QUERY_INFLIGHT_MAX,
      `with no place free within its reach a query is refused busy after the reach, unsent (${late?.statusCode}, ${ms} ms, "${String(late?.message).slice(0, 70)}")`);
    while (gates.length) gates.shift()();
    await Promise.all(held);
    ok(_buyerQueriesInflightForTest() === 0, `the refused query took no place: the count returns to zero (${_buyerQueriesInflightForTest()})`);
    // With a place free a query does not wait at all.
    fetchImpl = async () => J(200, { result: [{ x: 1 }] });
    const t2 = realDateNow();
    ok((await run()).rowCount === 1 && realDateNow() - t2 < 300, "control: with a place free the query is sent at once");
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
  }

  // A buyer gone while it waited for a place: when the place comes its query
  // is not sent (499, which cancels settlement) and the place is handed on.
  {
    _resetSqlPacerForTest(0);
    const gates = [];
    let sent = 0;
    fetchImpl = async () => { sent++; await new Promise((r) => gates.push(r)); return J(200, { result: [{ x: 1 }] }); };
    const held = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => run());
    await sleep(30);
    const req = {};
    const gone = run(req).catch((x) => x);
    await sleep(20);
    req.__a402ClientGoneAt = realDateNow();
    gates.shift()();
    const e = await gone;
    ok(e?.statusCode === 499 && sent === BUYER_QUERY_INFLIGHT_MAX, `a buyer gone while waiting for a place is not sent (${e?.statusCode}, ${sent} sent)`);
    while (gates.length) gates.shift()();
    await Promise.all(held);
    ok(_buyerQueriesInflightForTest() === 0, `and its place is returned (${_buyerQueriesInflightForTest()})`);
    fetchImpl = async () => J(200, { result: [{ x: 1 }] });
  }
  // The same with a send gap: a gone waiter takes no send slot when its place
  // comes, so a live query behind it keeps the slot it would have had.
  {
    const clock = clockOf();
    _setSqlPacerClockForTest(clock);
    _resetSqlPacerForTest(200, 2);
    const gates = [], sentTags = [];
    fetchImpl = async (_url, init) => { sentTags.push(String(init?.body).match(/AS (\w+)/)?.[1]); await new Promise((r) => gates.push(r)); return J(200, { result: [{ x: 1 }] }); };
    const q = (tag, req) => tool.handler({ sql: `SELECT block_number AS ${tag} FROM base.blocks` }, req);
    const held = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, (_, i) => q(`held${i}`));
    await sleep(30);
    const g1 = {}, g2 = {};
    const gone1 = q("gone1", g1).catch((x) => x), gone2 = q("gone2", g2).catch((x) => x);
    await sleep(10);
    const live = q("live").catch((x) => x);
    await sleep(10);
    g1.__a402ClientGoneAt = realDateNow(); g2.__a402ClientGoneAt = realDateNow();
    const before = clock.slots.length;
    gates.shift()();
    await sleep(50);
    const [e1, e2] = await Promise.all([gone1, gone2]);
    const liveSlot = clock.slots[clock.slots.length - 1];
    // The held sends took slots T0, T0, +400, +400, ... +1200, +1200: the next free pair is +1600.
    ok(e1?.statusCode === 499 && e2?.statusCode === 499 && sentTags.includes("live") && clock.slots.length - before === 1 && liveSlot === T0 + 1600,
      `gone place waiters take no send slot, and the live query keeps its slot (${e1?.statusCode}, ${e2?.statusCode}; ${clock.slots.length - before} slot wait after the release; live +${liveSlot - T0} ms, want +1600)`);
    while (gates.length) { gates.shift()(); await sleep(2); }
    await Promise.all([...held, live]);
    _setSqlPacerClockForTest(null);
    _resetSqlPacerForTest(0);
    fetchImpl = async () => J(200, { result: [{ x: 1 }] });
  }

  // ---------------------------------------------------------------- d-18
  // The pacer's clock is monotonic: a wall clock stepped back 5 s after a
  // send does not move the next slots 5 s out (where they were refused).
  {
    _setSqlPacerClockForTest(null);
    _resetSqlPacerForTest(150);
    fetchImpl = async () => J(200, { result: [{ x: 1 }] });
    ok((await run()).rowCount === 1, "a query is sent on the real clock");
    const back = realDateNow() - 5_000;
    const base = realDateNow();
    Date.now = () => back + (realDateNow() - base); // the wall clock steps back 5 s and runs on
    let rs;
    const t = performance.now();
    try { rs = await Promise.all([run(), run(), run()].map((p) => p.catch((x) => x))); } finally { Date.now = realDateNow; }
    const ms = performance.now() - t;
    ok(rs.every((r) => r?.rowCount === 1) && ms < 1_500, `after the wall clock steps back 5 s, three queries are sent a slot apart, none refused or held for the step (${rs.map((r) => r?.statusCode ?? 200).join(", ")}, ${Math.round(ms)} ms)`);
    _resetSqlPacerForTest(0);
  }
  // ---------------------------------------------------------------- d-14
  // At one replica two sends may go back to back, at the same long-run rate:
  // a send waits only for the send two before it plus two gaps, so a pair
  // never waits, any two gaps of time hold at most two sends (under 2 a
  // second at the default gap), and no send is ever later than it was under
  // one gap per send. At more replicas a send keeps the one-gap rule (each
  // replica's pair would add up past the project's rate).
  {
    const { sqlSendGapConfig } = m;
    ok(sqlSendGapConfig({}).burst === 2 && sqlSendGapConfig({ RATE_LIMIT_REPLICAS: "1" }).burst === 2 && sqlSendGapConfig({ RATE_LIMIT_REPLICAS: "2" }).burst === 1 && sqlSendGapConfig({ RATE_LIMIT_REPLICAS: "4" }).burst === 1,
      `two sends back to back at one replica, one at more (${[{}, { RATE_LIMIT_REPLICAS: "2" }].map((e) => sqlSendGapConfig(e).burst).join(", ")})`);
    const sent = [];
    let clock = clockOf();
    fetchImpl = async () => { sent.push(clock.now()); return J(200, { result: [{ x: 1 }] }); };
    _setSqlPacerClockForTest(clock);
    _resetSqlPacerForTest(625, 2);
    const five = await Promise.all(Array.from({ length: 5 }, () => run().catch((x) => x)));
    ok(five.every((r) => r?.rowCount === 1) && clock.slots.map((s) => s - T0).join() === "1250,1250,2500", `five at once: a pair at once, then a pair two gaps out, then the fifth (waits +${clock.slots.map((s) => s - T0).join(", +")} ms)`);
    const six = await run().catch((x) => x);
    const seven = await run().catch((x) => x);
    ok(six?.rowCount === 1 && seven?.statusCode === 429 && seven?.hint === "busy" && clock.slots.map((s) => s - T0).join() === "1250,1250,2500,2500",
      `the sixth pairs with the fifth (+2500 ms, in reach); the seventh, four gaps out, is refused busy (${six?.statusCode ?? 200}, ${seven?.statusCode})`);
    // The schedule holds at most two sends in any two gaps, so at most two in any second.
    const times = [T0, T0, ...clock.slots];
    let most = 0;
    for (let i = 0; i < times.length; i++) most = Math.max(most, times.filter((t) => t >= times[i] && t < times[i] + 1000).length);
    ok(most === 2, `no second holds more than two sends (${most})`);
    // Two calls 200 ms apart: the second is sent at once (one gap per send held it 425 ms).
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(625, 2);
    await run();
    clock.t += 200;
    await run();
    ok(clock.slots.length === 0, `two calls 200 ms apart: neither waits (waits ${clock.slots.map((s) => s - T0).join(", ") || "none"})`);
    // The first query after an idle gap is sent at once.
    clock.t += 30_000;
    await run();
    ok(clock.slots.length === 0, "the first query after an idle gap is sent at once");
    // At two replicas the one-gap rule holds: a pair 200 ms apart waits a gap.
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(1250, 1);
    await run(); clock.t += 200; await run();
    ok(clock.slots.map((s) => s - T0).join() === "1250", `at two replicas the second of a pair waits one gap (+${clock.slots.map((s) => s - T0).join(", +")} ms)`);
    // This server's own read still never waits more than one gap and never
    // goes ahead of a waiting buyer: after a pair a buyer and then an own
    // read arrive; the buyer takes the next slot and the own read, past one
    // gap, is refused unsent.
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(625, 2);
    sent.length = 0;
    await run(); await run();
    const buyer = run();
    const own = await m.ownSqlQuery({ sql }).catch((x) => x);
    await buyer;
    ok(own?.statusCode === 429 && sent.length === 3 && clock.slots.map((s) => s - T0).join() === "1250", `an own read behind a waiting buyer is refused unsent (${own?.statusCode}, ${sent.length} sent)`);
    // The revenue page's reads (cdpSql, src/revenue-live.js) are this server's
    // own too: behind a waiting buyer one is refused unsent and takes no slot,
    // so it never moves a buyer's query later; with the line free it is sent.
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(625, 2);
    sent.length = 0;
    await run(); await run();
    const buyer2 = run();
    const revenue = await m.cdpSql("SELECT 1 FROM base.events", { cacheSeconds: 300, retryWaitMs: 0 }).catch((x) => x);
    await buyer2;
    ok(revenue?.statusCode === 429 && sent.length === 3 && clock.slots.map((s) => s - T0).join() === "1250", `a revenue read behind a waiting buyer is refused unsent and takes no slot (${revenue?.statusCode ?? "sent"}, ${sent.length} sent, slots +${clock.slots.map((s) => s - T0).join(", +")})`);
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(625, 2);
    sent.length = 0;
    const rows = await m.cdpSql("SELECT 1 FROM base.events", { cacheSeconds: 300, retryWaitMs: 0 }).catch((x) => x);
    ok(Array.isArray(rows) && sent.length === 1, `with no query waiting the revenue read is sent (${Array.isArray(rows) ? rows.length + " row(s)" : rows?.statusCode})`);
    // A pair of revenue reads (the page sends two at once) both go: the second is one gap off, never further.
    clock = clockOf(); _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(625, 1);
    sent.length = 0;
    const pair = await Promise.all([m.cdpSql("SELECT 1 FROM base.events", { retryWaitMs: 0 }).catch((x) => x), m.cdpSql("SELECT 2 FROM base.events", { retryWaitMs: 0 }).catch((x) => x)]);
    ok(pair.every(Array.isArray) && sent.length === 2, `the page's pair of reads both send, the second one gap later (${pair.map((p) => (Array.isArray(p) ? "sent" : p?.statusCode)).join(", ")})`);
    _setSqlPacerClockForTest(null);
    _resetSqlPacerForTest(0);
  }
} finally {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
  _setSqlPacerClockForTest(null);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
