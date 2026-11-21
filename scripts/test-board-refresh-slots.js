// The seller boards (Base, Solana, MPP) rebuild twice a day at fixed slots, an
// hour apart, one at a time (src/board-refresh-slots.js): never beside another
// board's rebuild, never during an index crawl, never while the heap is high,
// and a boot rebuilds only a board that has no snapshot since its last slot.
// Offline, on a simulated clock: no timer of the host runs.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

const S = await import("../src/board-refresh-slots.js");
const cad = await import("../src/refresh-cadence.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const H = 3_600_000, MIN = 60_000;
const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

// --- a simulated clock with its own timers ------------------------------------
function clock(start) {
  let t = start, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, id }); return { id, unref() {} }; },
    clearTimer: (h) => { if (h) timers.delete(h.id); },
    /** Advance to `to`, firing timers in order; promises settle between timers. */
    async runTo(to) {
      for (;;) {
        const due = [...timers.values()].filter((x) => x.at <= to).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        t = Math.max(t, due.at);
        due.fn();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      }
      t = to;
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
  };
}
const quiet = { error() {}, warn() {}, log() {} };
const DAY0 = Date.parse("2026-11-21T00:00:00Z");

// --- the cadence and the slots ----------------------------------------------------
ok(cad.BOARD_REFRESH_MS === 12 * H && cad.LEADERBOARD_DEFAULT_REFRESH_MS === 12 * H, "the boards rebuild every 12 hours");
ok(cad.cadenceWords(cad.LEADERBOARD_DEFAULT_REFRESH_MS) === "every 12 hours" && cad.cadenceBadge(cad.LEADERBOARD_DEFAULT_REFRESH_MS) === "EVERY 12H", "the pages' words and badge follow the constant");
{
  const slots = cad.BOARD_SLOT_HOURS_UTC;
  ok(JSON.stringify(Object.keys(slots).sort()) === '["base","mpp","solana"]', "one row of slots per board");
  ok(Object.values(slots).every((h) => h.length === 2 && h[1] - h[0] === 12 && h.every((x) => Number.isInteger(x) && x >= 0 && x < 24)), "each board has two slots a day, 12 hours apart");
  const all = Object.values(slots).flat();
  ok(new Set(all).size === all.length && all.every((a) => all.every((b) => a === b || Math.abs(a - b) >= 1)), `no two boards share a slot hour (${JSON.stringify(slots)})`);
  ok(S.nextSlotAt([8, 20], DAY0) === DAY0 + 8 * H && S.nextSlotAt([8, 20], DAY0 + 8 * H) === DAY0 + 20 * H && S.nextSlotAt([8, 20], DAY0 + 21 * H) === DAY0 + 32 * H, "the next slot is strictly after now, across midnight");
  ok(S.lastSlotAt([8, 20], DAY0 + 8 * H) === DAY0 + 8 * H && S.lastSlotAt([8, 20], DAY0 + 7 * H) === DAY0 - 4 * H && S.lastSlotAt([8, 20], DAY0 + 23 * H) === DAY0 + 20 * H, "the last slot is at or before now, across midnight");
}
// Each board module takes its cadence from the one constant and starts through the schedule.
{
  const sol = await import("../src/solana-leaderboard.js");
  const mpp = await import("../src/mpp-leaderboard.js");
  ok(sol.SOLANA_LB_DEFAULT_REFRESH_MS === 12 * H && mpp.MPP_LB_REFRESH_MS === 12 * H && mpp.MPP_LB_STALE_MS === 36 * H, "the Solana and MPP boards read the same 12 hours");
  ok(/scheduleBoardRefresh\(\{\s*board: "base"/.test(read("../src/leaderboard.js")) && /scheduleBoardRefresh\(\{\s*board: "solana"/.test(read("../src/solana-leaderboard.js")) && /scheduleBoardRefresh\(\{\s*board: "mpp"/.test(read("../src/mpp-leaderboard.js")), "each board starts through the slot schedule");
  ok(/addBoardRefreshQuietCheck\(\(\) => \(crawlInProgress\(\)/.test(read("../src/server.js")), "the server hands in the index crawl check");
}

// --- three boards over two days: twice a day each, never two at once ----------------
{
  S.__resetBoardRefresh();
  const c = clock(DAY0 + 30 * MIN);
  const runs = [];
  let active = 0, most = 0;
  const board = (name) => S.scheduleBoardRefresh({
    board: name, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: quiet,
    // A rebuild longer than the hour between two boards' slots.
    run: () => new Promise((res) => { active++; most = Math.max(most, active); runs.push({ name, at: c.now() }); c.setTimer(() => { active--; res(); }, 80 * MIN); }),
  });
  const all = ["base", "solana", "mpp"].map(board);
  await c.runTo(DAY0 + 48 * H + 30 * MIN);
  for (const s of all) s.stop();
  const per = (n) => runs.filter((r) => r.name === n);
  ok(["base", "solana", "mpp"].every((n) => per(n).length === 4), `each board rebuilt twice a day for two days (${["base", "solana", "mpp"].map((n) => `${n} ${per(n).length}`).join(", ")})`);
  ok(most === 1, `no two rebuilds ran at once, though each outlasts the hour to the next board's slot (most at once: ${most})`);
  ok(per("base").every((r) => new Date(r.at).getUTCHours() === 8 || new Date(r.at).getUTCHours() === 20), "the Base board started in its own slot hours");
  ok(per("solana").every((r, i) => r.at >= per("base")[i].at + 80 * MIN), "a board whose slot arrives while another rebuilds starts after it ends");
}
// The model of the timers this replaced: three intervals counted from one boot, nothing between them.
{
  const c = clock(DAY0);
  let active = 0, most = 0;
  const run = () => { active++; most = Math.max(most, active); c.setTimer(() => { active--; }, 20 * MIN); };
  const every = (ms, first) => { const tick = () => { run(); c.setTimer(tick, ms); }; c.setTimer(tick, first); };
  every(4 * H, 20_000); every(4 * H, 180_000); every(30 * MIN, 120_000);
  await c.runTo(DAY0 + 12 * H);
  ok(most === 3, `CONTROL three timers counted from one boot run all three rebuilds at once (most at once: ${most})`);
}

// --- a due rebuild waits for a crawl, then runs ---------------------------------------
{
  S.__resetBoardRefresh();
  const c = clock(DAY0 + 7 * H + 59 * MIN);
  let crawling = true;
  S.addBoardRefreshQuietCheck(() => (crawling ? "an index crawl is in flight" : null));
  const runs = [];
  const s = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: quiet, run: async (why) => { runs.push({ at: c.now(), ...why }); } });
  await c.runTo(DAY0 + 8 * H + 10 * MIN);
  ok(runs.length === 0, "while a crawl is in flight the due rebuild waits");
  crawling = false;
  await c.runTo(DAY0 + 8 * H + 12 * MIN);
  ok(runs.length === 1 && runs[0].slot === true && runs[0].at <= DAY0 + 8 * H + 11 * MIN + 1, `and runs within a minute of the crawl ending (${runs.length} run, ${runs[0] ? Math.round((runs[0].at - DAY0 - 8 * H) / MIN) : "?"} min after the slot)`);
  // A crawl that never ends does not silence the board.
  crawling = true;
  const warned = [];
  s.stop();
  const s2 = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: { ...quiet, warn: (m) => warned.push(m) }, run: async () => { runs.push({ at: c.now() }); } });
  await c.runTo(DAY0 + 20 * H + S.MAX_DEFER_MS + 2 * MIN);
  ok(runs.length === 2 && runs[1].at >= DAY0 + 20 * H + S.MAX_DEFER_MS && warned.length === 1 && /an index crawl is in flight/.test(warned[0]), `a rebuild held by a crawl for ${S.MAX_DEFER_MS / MIN} min runs anyway, with a warning (${warned[0] || "none"})`);
  s2.stop();
}

// --- a high heap defers, then gives the slot up -----------------------------------------
{
  S.__resetBoardRefresh();
  const c = clock(DAY0 + 8 * H + 59 * MIN);
  let high = true;
  const runs = [], errors = [];
  const s = S.scheduleBoardRefresh({ board: "solana", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => high, log: { ...quiet, error: (m) => errors.push(m) }, run: async () => { runs.push(c.now()); } });
  await c.runTo(DAY0 + 9 * H + 20 * MIN);
  ok(runs.length === 0, "while the heap is high the due rebuild waits");
  high = false;
  await c.runTo(DAY0 + 9 * H + 22 * MIN);
  ok(runs.length === 1, "and runs once the heap has come down");
  high = true;
  await c.runTo(DAY0 + 21 * H + S.MAX_DEFER_MS + 5 * MIN);
  ok(runs.length === 1 && errors.length === 1 && /given up/.test(errors[0]) && /the heap is high/.test(errors[0]), `a heap that stays high gives the slot up, with an error line, and never rebuilds into it (${errors[0] || "none"})`);
  high = false;
  await c.runTo(DAY0 + 33 * H + 2 * MIN);
  ok(runs.length === 2, "the next slot rebuilds");
  s.stop();
  ok(S.heapIsHigh({ share: 0.7, used: 80, limit: 100 }) === true && S.heapIsHigh({ share: 0.7, used: 60, limit: 100 }) === false && S.heapIsHigh({ share: 0, used: 99, limit: 100 }) === false, "the heap check compares used to V8's limit, and a share of 0 switches it off");
  ok(S.boardRefreshHeapShare({}) === 0.7 && S.boardRefreshHeapShare({ BOARD_REFRESH_HEAP_SHARE: "0.5" }) === 0.5 && S.boardRefreshHeapShare({ BOARD_REFRESH_HEAP_SHARE: "off" }) === 0 && S.boardRefreshHeapShare({ BOARD_REFRESH_HEAP_SHARE: "9" }) === 0.7 && S.boardRefreshHeapShare({ BOARD_REFRESH_HEAP_SHARE: "abc" }) === 0.7, "BOARD_REFRESH_HEAP_SHARE: a share, off, and a malformed value reads as the default");
}

// --- boot: a current board is not rebuilt; a missing or missed one is ---------------------
{
  S.__resetBoardRefresh();
  const boot = DAY0 + 11 * H; // three hours after the Base slot
  const scenario = async (snapshotAt, extra = {}) => {
    const c = clock(boot);
    const runs = [];
    const s = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: quiet, snapshotAt: () => snapshotAt, bootDelayMs: 20_000, run: async (why) => { runs.push({ at: c.now(), ...why }); }, ...extra });
    await c.runTo(boot + 30 * MIN);
    s.stop();
    return runs;
  };
  ok((await scenario(DAY0 + 8 * H + 5 * MIN)).length === 0, "a boot with a snapshot built since the last slot rebuilds nothing");
  const stale = await scenario(DAY0 + 7 * H);
  ok(stale.length === 1 && stale[0].slot === false && stale[0].at === boot + 20_000, "a boot whose snapshot predates the last slot rebuilds once, after the boot delay");
  ok((await scenario(0)).length === 1, "a boot with no snapshot rebuilds once");
  const twice = await scenario(0, { secondKickMs: 8 * MIN });
  ok(twice.length === 2 && twice[1].at === boot + 20_000 + 8 * MIN, "a board that asks for a second boot pass gets it after its boot rebuild");
  ok((await scenario(DAY0 + 8 * H + 5 * MIN, { secondKickMs: 8 * MIN })).length === 0, "and none when the boot rebuilt nothing");
  const noKick = await (async () => { const c = clock(boot); const runs = []; const s = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: quiet, run: async () => { runs.push(c.now()); } }); await c.runTo(boot + 30 * MIN); s.stop(); return runs; })();
  ok(noKick.length === 0, "with no boot delay named there is no boot rebuild");
}

// --- stop cancels everything -----------------------------------------------------------------
{
  S.__resetBoardRefresh();
  const c = clock(DAY0);
  let n = 0;
  const s = S.scheduleBoardRefresh({ board: "mpp", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, log: quiet, bootDelayMs: 1000, run: async () => { n++; } });
  s.stop();
  await c.runTo(DAY0 + 48 * H);
  ok(n === 0, "a stopped schedule never rebuilds");
}

console.log(`\ntest-board-refresh-slots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
