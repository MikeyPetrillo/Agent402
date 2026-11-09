// scripts/test-x-data-ceilings.js
// The X data kit's two daily ceilings (src/tools/x-data-kit.js). Offline: a
// stubbed fetch, no bearer that works anywhere, nothing spent.
//   X_DATA_DAILY_MAX_USD       the alarm: past it a call is still served and
//                              xDataSpend reads `over`; 0 refuses every call
//   X_DATA_DAILY_HARD_MAX_USD  the stop: a read that would pass it is refused
// Every figure is derived from the kit's own estimate, never typed.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { __test, estimateXReadUsd, xDataSpendStatus, _xSpendReset, _xSpendBook } from "../src/tools/x-data-kit.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-x-data-ceilings");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const E = estimateXReadUsd("/tweets/search/recent", { max_results: 10 }); // one full page
const page = () => new Response(JSON.stringify({ data: Array.from({ length: 10 }, (_, i) => ({ id: String(1e10 + i), text: "t" })), meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let fetched = 0, warned = [];
globalThis.fetch = async () => { fetched++; return page(); };
console.warn = (...a) => { warned.push(a.join(" ")); };
const read = async () => { try { return { data: await __test.xGet("/tweets/search/recent", { max_results: 10 }) }; } catch (e) { return { error: e }; } };
const setEnv = (soft, hard) => {
  if (soft === undefined) delete process.env.X_DATA_DAILY_MAX_USD; else process.env.X_DATA_DAILY_MAX_USD = String(soft);
  if (hard === undefined) delete process.env.X_DATA_DAILY_HARD_MAX_USD; else process.env.X_DATA_DAILY_HARD_MAX_USD = String(hard);
  _xSpendReset(); fetched = 0; warned = [];
};
process.env.X_BEARER_TOKEN = "test-bearer";

try {
  // --- under the alarm ceiling ------------------------------------------
  setEnv(3 * E, 6 * E);
  let r = await read();
  ok(Array.isArray(r.data?.data) && fetched === 1 && xDataSpendStatus().status === "ok", "under the alarm ceiling: served, the word reads ok");

  // --- at the alarm ceiling: served, and the word pages -------------------
  setEnv(2 * E, 6 * E);
  _xSpendBook(2 * E);
  ok(xDataSpendStatus().status === "over", "spend at the alarm ceiling reads over");
  r = await read();
  ok(!r.error && Array.isArray(r.data?.data) && fetched === 1, `at the alarm ceiling a call is served (${r.error?.message || "200"})`);
  ok(xDataSpendStatus().status === "over" && xDataSpendStatus().refusedToday === 0, "after it the word still reads over and nothing was refused");
  r = await read(); r = await read();
  ok(fetched === 3 && !r.error, "calls keep being served between the two ceilings");
  ok(warned.filter((w) => /\[x-data\].*X_DATA_DAILY_MAX_USD/.test(w)).length === 1, "passing the alarm ceiling logs one line for the day");
  ok(warned.every((w) => !/\d+\.\d+/.test(w) && !/\$\d/.test(w)), "that line carries no figure");

  // --- at the hard ceiling: refused before any fetch ----------------------
  setEnv(2 * E, 6 * E);
  _xSpendBook(5.5 * E);
  r = await read();
  ok(r.error?.statusCode === 503 && /usage cap/.test(r.error.message) && !/\$\d/.test(r.error.message) && fetched === 0, "a read that would pass the hard ceiling is refused 503 before any fetch");
  ok(xDataSpendStatus().refusedToday === 1 && xDataSpendStatus().spentUsd <= xDataSpendStatus().hardCapUsd, "the refusal is counted and books nothing past the hard ceiling");
  ok(xDataSpendStatus().status === "over", "short of the hard ceiling the word still reads over");
  _xSpendBook(1 * E);
  ok(xDataSpendStatus().status === "capped", "spend at the hard ceiling reads capped");

  // --- the default hard ceiling is five times the alarm ceiling ------------
  setEnv(2 * E, undefined);
  ok(Math.abs(xDataSpendStatus().hardCapUsd - 10 * E) < 1e-9, "unset: the hard ceiling is 5 times the alarm ceiling");
  _xSpendBook(8.5 * E);
  r = await read();
  ok(!r.error && fetched === 1, "unset: a read inside 5 times the alarm ceiling is served");
  _xSpendReset(); _xSpendBook(9.5 * E); fetched = 0;
  r = await read();
  ok(r.error?.statusCode === 503 && fetched === 0, "unset: a read past 5 times the alarm ceiling is refused");
  for (const junk of ["junk", "-3", "0", ""]) {
    setEnv(2 * E, junk);
    ok(Math.abs(xDataSpendStatus().hardCapUsd - 10 * E) < 1e-9, `hard ceiling "${junk}" reads as the default, never as off or as no ceiling`);
  }
  setEnv(4 * E, 1 * E);
  ok(Math.abs(xDataSpendStatus().hardCapUsd - 4 * E) < 1e-9, "a hard ceiling under the alarm ceiling reads as the alarm ceiling");

  // --- 0 is the switch: every call refused, whatever the hard ceiling ------
  for (const hard of [undefined, 100 * E]) {
    setEnv(0, hard);
    r = await read();
    ok(r.error?.statusCode === 503 && fetched === 0, `alarm ceiling 0 refuses every call (hard ceiling ${hard === undefined ? "unset" : "set"})`);
    ok(xDataSpendStatus().status === "off", "and the word reads off, which does not page");
  }

  // --- the two observers page on over and capped ---------------------------
  const worker = readFileSync(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  const yml = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  const TITLE = "X data daily spend OVER its ceiling";
  ok(worker.includes(`title: "${TITLE}"`) && /xDataSpend\?\.status, \["over", "capped"\], \["ok", "off"\]/.test(worker), "the status Worker pages on over and capped and closes on ok or off");
  const step = yml.slice(yml.indexOf(".xDataSpend.status"));
  ok(yml.includes(`TITLE="${TITLE}"`) && /"\$STATUS" = "over" \] \|\| \[ "\$STATUS" = "capped"/.test(step.slice(0, 1200)), "heartbeat.yml pages on the same two words under the same title");
} finally {
  globalThis.fetch = realFetch; console.warn = realWarn;
  delete process.env.X_BEARER_TOKEN; delete process.env.X_DATA_DAILY_MAX_USD; delete process.env.X_DATA_DAILY_HARD_MAX_USD;
  _xSpendReset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
