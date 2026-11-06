#!/usr/bin/env node
// The Robinhood settle order's since on the state database
// (src/robinhood-order.js stateDbOrderStore): each step is a real fresh
// process (a deploy) reading the same row, so the robinhoodSettler clock
// survives a restart, and a process that finds the facilitator first again
// resets it. Requires STATE_DATABASE_URL (CI fails without it).
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
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  try { const { __dropStateSchema, closeStateDb } = await import("../src/state-db.js"); await __dropStateSchema(); await closeStateDb(); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
