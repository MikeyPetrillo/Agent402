#!/usr/bin/env node
// The Robinhood settle order's since on the state database
// (src/robinhood-order.js stateDbOrderStore): each step is a real fresh
// process (a deploy) reading the same row, so the robinhoodSettler clock
// survives a restart, and a process that finds the facilitator first again
// resets it. Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawnSync } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-robinhood-settler-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const H = 3_600_000;
const T0 = Date.now() - 48 * H;
const MOD = new URL("../src/robinhood-order.js", import.meta.url).href;
const DB = new URL("../src/state-db.js", import.meta.url).href;

/** One process: build the order on the state-database store, read once at `at`, print the word. */
function proc(at, readingDry) {
  const code = `
    const O = await import(${JSON.stringify(MOD)});
    const { closeStateDb } = await import(${JSON.stringify(DB)});
    const store = await O.stateDbOrderStore();
    const at = ${at};
    const o = O.createRobinhoodOrder({ host: "facilitator.example", now: () => at, log: () => {}, store });
    const runway = ${readingDry ? 3 : 2000};
    o.update([{ network: "eip155:4663", facilitator: "facilitator.example", runway, status: runway < 50 ? "low" : "ok", balanceEth: 0.001, at }]);
    await o.synced();
    const s = o.status({ full: true, env: {}, at });
    const row = await store.load();
    await closeStateDb();
    console.log(JSON.stringify({ hasStore: !!store, word: s.status, since: s.since, row }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "" }, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr.slice(-600)}`);
  return childJson(r.stdout);
}

/** Two orders (two replicas) on their own store handles to the same row, one lagging. */
function twoReplicas(t0) {
  const code = `
    const O = await import(${JSON.stringify(MOD)});
    const { closeStateDb } = await import(${JSON.stringify(DB)});
    const H = 3600000, t0 = ${t0}, HOST = "facilitator.example";
    const row = (at, runway) => [{ network: "eip155:4663", facilitator: HOST, runway, status: runway < 50 ? "low" : "ok", balanceEth: 0.001, at }];
    const ca = { t: t0 }, cb = { t: t0 };
    const a = O.createRobinhoodOrder({ host: HOST, now: () => ca.t, log: () => {}, store: await O.stateDbOrderStore() });
    const b = O.createRobinhoodOrder({ host: HOST, now: () => cb.t, log: () => {}, store: await O.stateDbOrderStore() });
    a.update(row(ca.t, 3)); await a.synced();
    cb.t = t0 + 60000; b.update(row(cb.t, 3)); await b.synced();
    cb.t = t0 + H; b.update(row(cb.t, 2000)); await b.synced();
    const store = await O.stateDbOrderStore();
    const afterReset = await store.load();
    ca.t = t0 + H + 30000; a.update(row(ca.t, 3)); await a.synced();
    const afterLag = await store.load();
    cb.t = t0 + 2 * H; b.update(row(cb.t, 3)); await b.synced();
    cb.t = t0 + 6.5 * H; b.update(row(cb.t, 3)); await b.synced();
    const word = b.status({ env: {}, at: cb.t }).status;
    // A fresh process (a deploy) reads the stored clock before its first update.
    const fresh = O.createRobinhoodOrder({ host: HOST, now: () => t0 + 12 * H, log: () => {}, store: await O.stateDbOrderStore() });
    await fresh.synced();
    const freshWord = fresh.status({ env: {}, at: t0 + 12 * H }).status;
    await closeStateDb();
    console.log(JSON.stringify({ afterReset, afterLag, word, freshWord }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "" }, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr.slice(-600)}`);
  return childJson(r.stdout);
}

/** Two replicas, one row: A's relayer-first write is held across B's reset and
 *  lands after it, so the row holds a start older than the reset B knows. */
function lateWrite(t0) {
  const code = `
    const O = await import(${JSON.stringify(MOD)});
    const { closeStateDb } = await import(${JSON.stringify(DB)});
    const H = 3600000, t0 = ${t0}, HOST = "facilitator.example";
    const row = (at, runway) => [{ network: "eip155:4663", facilitator: HOST, runway, status: runway < 50 ? "low" : "ok", balanceEth: 0.001, at }];
    const real = await O.stateDbOrderStore();
    let release; const held = new Promise((r) => { release = r; });
    const aStore = { load: () => real.load(), async save(body) { await held; return real.save(body); } };
    const ca = { t: t0 }, cb = { t: t0 };
    const a = O.createRobinhoodOrder({ host: HOST, now: () => ca.t, log: () => {}, store: aStore });
    const b = O.createRobinhoodOrder({ host: HOST, now: () => cb.t, log: () => {}, store: await O.stateDbOrderStore() });
    await a.synced(); await b.synced();
    a.update(row(ca.t, 3));
    cb.t = t0 + H; b.update(row(cb.t, 2000)); await b.synced();
    release(); await a.synced();
    const stale = await real.load();
    cb.t = t0 + 2 * H; b.update(row(cb.t, 3)); await b.synced();
    const since = b.status({ full: true, env: {}, at: cb.t }).since;
    const after = await real.load();
    cb.t = t0 + 6.5 * H; b.update(row(cb.t, 3)); await b.synced();
    const word = b.status({ env: {}, at: cb.t }).status;
    await closeStateDb();
    console.log(JSON.stringify({ stale, since, after, word }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "" }, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr.slice(-600)}`);
  return childJson(r.stdout);
}

try {
  const a = proc(T0, true);
  ok(a.hasStore, "the state database gives the order a store");
  ok(a.word === "ok" && a.row?.ownFirst === true && a.row?.since === T0, `the turn to our relayer is stored (${JSON.stringify(a.row)})`);
  const b = proc(T0 + 7 * H, true);
  ok(b.word === "relayer" && b.since === new Date(T0).toISOString(), `a fresh process seven hours later keeps the clock (${b.word}, ${b.since})`);
  const c = proc(T0 + 7 * H + 60_000, false);
  ok(c.word === "ok" && c.row?.ownFirst === false, `a fresh process that finds the facilitator funded reads ok and stores it (${JSON.stringify(c.row)})`);
  const d = proc(T0 + 9 * H, true);
  ok(d.word === "ok" && d.row?.since === T0 + 9 * H, `dry again: a fresh clock, not the old start (${d.word}, ${JSON.stringify(d.row)})`);
  const e = proc(T0 + 15 * H + 60_000, true);
  ok(e.word === "relayer", `six hours on from the fresh start: relayer (${e.word})`);
  const { __dropStateSchema } = await import("../src/state-db.js"); await __dropStateSchema();
  const T1 = Date.now() - 24 * H;
  const r = twoReplicas(T1);
  ok(r.afterReset?.ownFirst === false && r.afterReset?.resetAt === T1 + H, `two replicas: the facilitator-first write records the reset (${JSON.stringify(r.afterReset)})`);
  ok(r.afterLag?.ownFirst === true && r.afterLag?.since >= T1 + H, `two replicas: the lagging relayer-first replica writes no start before the reset (${JSON.stringify(r.afterLag)})`);
  ok(r.word === "ok", `two replicas: the peer that turns relayer first later does not adopt the old start (${r.word})`);
  ok(r.freshWord === "relayer", `a fresh process reads the stored clock before its first update (${r.freshWord})`);
  await __dropStateSchema();
  const T2 = Date.now() - 24 * H;
  const l = lateWrite(T2);
  ok(l.stale?.ownFirst === true && l.stale?.since === T2 && l.stale?.resetAt === undefined, `late write: the row holds a relayer-first start before the reset (${JSON.stringify(l.stale)})`);
  ok(l.since === new Date(T2 + 2 * H).toISOString() && l.after?.since === T2 + 2 * H && l.after?.resetAt === T2 + H, `late write: the peer keeps its own start and writes it with the reset (${l.since}, ${JSON.stringify(l.after)})`);
  ok(l.word === "ok", `late write: 4.5 hours relayer first reads ok, not the stale clock (${l.word})`);
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  try { const { __dropStateSchema, closeStateDb } = await import("../src/state-db.js"); await __dropStateSchema(); await closeStateDb(); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
