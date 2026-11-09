// scripts/test-exa-ceilings.js
// The Exa kit's two daily ceilings (src/tools/exa-kit.js, read through
// src/daily-ceilings.js). Offline: a stubbed fetch, a key that works nowhere,
// nothing spent.
//   EXA_DAILY_MAX_USD       the alarm: past it a call is still served and
//                           exaSpend reads `over`; 0 refuses every call
//   EXA_DAILY_HARD_MAX_USD  the stop: a call that would pass it is refused
// The prepaid allowance word (exaAllowance, EXA_CREDITS_USD) is separate and
// must not move with either. Every figure is derived from the kit's own
// estimate, never typed.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { EXA_TOOLS, estimateExaUsd, exaSpendStatus, exaAllowanceStatus, _exaSpendReset, _exaSpendBook, _exaLifetimeReset } from "../src/tools/exa-kit.js";
import { dailyCeilings, ceilingWord, HARD_MULTIPLIER } from "../src/daily-ceilings.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-exa-ceilings");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const E = estimateExaUsd("/search", { numResults: 10 }); // one search
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let fetched = 0, warned = [], upstream = () => ({ status: 200, body: { results: [{ url: "https://a.example", title: "t" }], costDollars: { total: E } } });
globalThis.fetch = async () => { fetched++; const u = upstream(); return { ok: u.status >= 200 && u.status < 300, status: u.status, json: async () => u.body, headers: { get: () => null } }; };
console.warn = (...a) => { warned.push(a.join(" ")); };
const search = EXA_TOOLS.find((t) => t.slug === "exa-search").handler;
const call = async () => { try { return { data: await search({ query: "agent payments" }) }; } catch (e) { return { error: e }; } };
const setEnv = (soft, hard) => {
  if (soft === undefined) delete process.env.EXA_DAILY_MAX_USD; else process.env.EXA_DAILY_MAX_USD = String(soft);
  if (hard === undefined) delete process.env.EXA_DAILY_HARD_MAX_USD; else process.env.EXA_DAILY_HARD_MAX_USD = String(hard);
  _exaSpendReset(); _exaLifetimeReset(); fetched = 0; warned = [];
};
process.env.EXA_API_KEY = "test-key";
delete process.env.EXA_CREDITS_USD;

try {
  // --- under the alarm ceiling ------------------------------------------
  setEnv(3 * E, 6 * E);
  let r = await call();
  ok(Array.isArray(r.data?.results) && fetched === 1 && exaSpendStatus().status === "ok", `under the alarm ceiling: served, the word reads ok (${r.error?.message || "200"})`);

  // --- at the alarm ceiling: served, and the word pages -------------------
  setEnv(2 * E, 6 * E);
  _exaSpendBook(2 * E);
  ok(exaSpendStatus().status === "over", "spend at the alarm ceiling reads over");
  r = await call();
  ok(!r.error && Array.isArray(r.data?.results) && fetched === 1, `at the alarm ceiling a call is served (${r.error?.message || "200"})`);
  ok(exaSpendStatus().status === "over" && exaSpendStatus().refusedToday === 0, "after it the word still reads over and nothing was refused");
  r = await call(); r = await call();
  ok(fetched === 3 && !r.error, "calls keep being served between the two ceilings");
  ok(warned.filter((w) => /\[exa\].*EXA_DAILY_MAX_USD/.test(w)).length === 1, "passing the alarm ceiling logs one line for the day");
  ok(warned.every((w) => !/\d+\.\d+/.test(w) && !/\$\d/.test(w)), "that line carries no figure");

  // --- the vendor's reported cost still re-books the estimate -------------
  setEnv(2 * E, 60 * E);
  _exaSpendBook(2 * E);
  upstream = () => ({ status: 200, body: { results: [], costDollars: { total: 3 * E } } });
  await call();
  ok(Math.abs(exaSpendStatus().spentUsd - 5 * E) < 1e-4, "past the alarm ceiling the booking is still corrected to the vendor's reported cost");
  upstream = () => ({ status: 200, body: { results: [{ url: "https://a.example", title: "t" }], costDollars: { total: E } } });

  // --- at the hard ceiling: refused before any fetch ----------------------
  setEnv(2 * E, 6 * E);
  _exaSpendBook(5.5 * E);
  r = await call();
  ok(r.error?.statusCode === 503 && /usage cap/.test(r.error.message) && /not charged on x402/.test(r.error.message) && !/\$\d/.test(r.error.message) && fetched === 0, "a call that would pass the hard ceiling is refused 503 before any fetch");
  ok(exaSpendStatus().refusedToday === 1 && exaSpendStatus().status === "over", "the refusal is counted and books nothing; short of the hard ceiling the word reads over");
  _exaSpendBook(1 * E);
  ok(exaSpendStatus().status === "capped", "spend at the hard ceiling reads capped");

  // --- the default hard ceiling is five times the alarm ceiling ------------
  setEnv(2 * E, undefined);
  ok(HARD_MULTIPLIER === 5 && Math.abs(exaSpendStatus().hardCapUsd - 10 * E) < 1e-9, "unset: the hard ceiling is 5 times the alarm ceiling");
  _exaSpendBook(8.5 * E);
  r = await call();
  ok(!r.error && fetched === 1, "unset: a call inside 5 times the alarm ceiling is served");
  _exaSpendReset(); _exaSpendBook(9.5 * E); fetched = 0;
  r = await call();
  ok(r.error?.statusCode === 503 && fetched === 0, "unset: a call past 5 times the alarm ceiling is refused");
  for (const junk of ["junk", "-3", "0", ""]) {
    setEnv(2 * E, junk);
    ok(Math.abs(exaSpendStatus().hardCapUsd - 10 * E) < 1e-9, `hard ceiling "${junk}" reads as the default, never as off or as no ceiling`);
  }
  setEnv(4 * E, 1 * E);
  ok(Math.abs(exaSpendStatus().hardCapUsd - 4 * E) < 1e-9, "a hard ceiling under the alarm ceiling reads as the alarm ceiling");

  // --- the alarm ceiling's own readings are unchanged ----------------------
  for (const hard of [undefined, 100 * E]) {
    setEnv(0, hard);
    r = await call();
    ok(r.error?.statusCode === 503 && fetched === 0, `alarm ceiling 0 refuses every call (hard ceiling ${hard === undefined ? "unset" : "set"})`);
    ok(exaSpendStatus().status === "off", "and the word reads off, which does not page");
  }
  for (const raw of [undefined, "", "junk", "-1"]) {
    setEnv(raw, undefined);
    ok(exaSpendStatus().capUsd === 1 && exaSpendStatus().status === "ok", `alarm ceiling ${JSON.stringify(raw)} reads as the default of 1, never as off`);
  }

  // --- the prepaid allowance word does not move with the ceilings ---------
  setEnv(2 * E, 6 * E);
  ok(exaAllowanceStatus().status === "unconfigured", "without EXA_CREDITS_USD the allowance word reads unconfigured, over or not");
  process.env.EXA_CREDITS_USD = String(1000 * E);
  _exaSpendBook(3 * E);
  ok(exaSpendStatus().status === "over" && exaAllowanceStatus().status === "ok", "spend past the alarm ceiling leaves a funded allowance reading ok");
  _exaSpendBook(900 * E);
  ok(exaSpendStatus().status === "capped" && exaAllowanceStatus().status === "low", "and the allowance word reads low on its own measure");
  delete process.env.EXA_CREDITS_USD;
  // A spent prepaid balance: the upstream refuses, and the tool answers 503 under either ceiling.
  setEnv(1000 * E, undefined);
  upstream = () => ({ status: 402, body: {} });
  r = await call();
  ok(r.error?.statusCode === 503 && /temporarily unavailable/.test(r.error.message) && fetched === 1 && exaSpendStatus().status === "ok", "with the prepaid balance spent the upstream's refusal is a 503 while the word reads ok");

  // --- the shared reader ---------------------------------------------------
  const c = dailyCeilings("A", "H", { A: "2", H: "" });
  ok(c.alarmUsd === 2 && c.hardUsd === 10 && c.refuseAtUsd === 10 && ceilingWord(1.9e6, c) === "ok" && ceilingWord(2e6, c) === "over" && ceilingWord(10e6, c) === "capped", "the shared reader gives the alarm, the hard ceiling and the words");
  const off = dailyCeilings("A", "H", { A: "0", H: "50" });
  ok(off.refuseAtUsd === 0 && ceilingWord(0, off) === "off", "and 0 refuses at 0 whatever the hard ceiling");
  const kits = ["exa-kit.js", "x-data-kit.js"].map((f) => readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8"));
  ok(kits.every((k) => /dailyCeilings\(/.test(k) && /ceilingWord\(/.test(k) && !/Number\(process\.env\.(EXA|X_DATA)_DAILY/.test(k) && !/process\.env\.(EXA|X_DATA)_DAILY_(HARD_)?MAX_USD/.test(k)), "both kits read their ceilings through the shared reader");

  // --- the two observers page on over and capped ---------------------------
  const worker = readFileSync(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  const yml = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  const TITLE = "Exa daily spend OVER its ceiling";
  ok(worker.includes(`title: "${TITLE}"`) && /exaSpend\?\.status, \["over", "capped"\], \["ok", "off"\]/.test(worker), "the status Worker pages on over and capped and closes on ok or off");
  const step = yml.slice(yml.indexOf(".exaSpend.status"));
  ok(yml.includes(`TITLE="${TITLE}"`) && /"\$STATUS" = "over" \] \|\| \[ "\$STATUS" = "capped"/.test(step.slice(0, 1200)), "heartbeat.yml pages on the same two words under the same title");
  ok(/exaAllowance\?\.status, \["low"\], \["ok", "unconfigured"\]/.test(worker) && yml.includes('TITLE="Exa prepaid allowance LOW"'), "the prepaid allowance alarm is still its own issue");
} finally {
  globalThis.fetch = realFetch; console.warn = realWarn;
  delete process.env.EXA_API_KEY; delete process.env.EXA_DAILY_MAX_USD; delete process.env.EXA_DAILY_HARD_MAX_USD; delete process.env.EXA_CREDITS_USD;
  _exaSpendReset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
