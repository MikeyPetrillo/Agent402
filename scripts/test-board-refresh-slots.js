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

// --- a high heap defers, then gives the attempt up and tries again in an hour ---------
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
  await c.runTo(DAY0 + 22 * H + S.MAX_DEFER_MS + 2 * MIN);
  ok(runs.length === 2 && runs[1] === DAY0 + 21 * H + S.MAX_DEFER_MS + S.GIVEN_UP_RETRY_MS, `the given-up rebuild tries again an hour later and runs once the heap is down (${runs.length} runs)`);
  await c.runTo(DAY0 + 33 * H + 2 * MIN);
  ok(runs.length === 3 && runs[2] === DAY0 + 33 * H, "the next slot rebuilds");
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

// --- a given-up rebuild tries again every hour until it runs ---------------------------
{
  S.__resetBoardRefresh();
  const slot = DAY0 + cad.BOARD_SLOT_HOURS_UTC.solana[0] * H;
  const c = clock(slot - 5 * MIN);
  const runs = [], errors = [];
  let high = true;
  const s = S.scheduleBoardRefresh({ board: "solana", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => high, log: { ...quiet, error: (m) => errors.push(m) }, run: async () => { runs.push(c.now()); } });
  ok(S.boardRefreshStatus().status === "ok", "before any slot the word reads ok");
  await c.runTo(slot + 46 * MIN);
  ok(errors.length === 1 && /tries again in 60 min/.test(errors[0]) && S.boardRefreshStatus().status === "held", `the first give-up says when it tries again and the word reads held (${errors[0]})`);
  await c.runTo(slot + 2 * H + 31 * MIN); // the retry at +1h45 waited its own 45 minutes
  ok(runs.length === 0 && errors.length === 2 && S.boardRefreshStatus().status === "held", "an hour later it tries again, and gives that attempt up too while the heap stays high");
  await c.runTo(slot + 4 * H + 16 * MIN);
  const full = S.boardRefreshStatus({ full: true });
  ok(errors.length === 3 && S.STALLED_AFTER_GIVEN_UP === 3 && full.status === "stalled" && full.boards.solana.givenUpInARow === 3 && full.boards.solana.givenUpTotal === 3 && JSON.stringify(S.boardRefreshStatus()) === '{"status":"stalled"}', `three given up in a row read stalled: one word publicly, the counts on the full view (${JSON.stringify(full.boards.solana)})`);
  high = false;
  await c.runTo(slot + 5 * H + 16 * MIN);
  ok(runs.length === 1 && runs[0] === slot + 5 * H + 15 * MIN && S.boardRefreshStatus().status === "ok", `once the heap comes down the next hourly try rebuilds, hours before the next slot, and the word reads ok (ran ${runs.length ? (runs[0] - slot) / MIN : "never"} min after the slot)`);
  await c.runTo(slot + 11 * H + 59 * MIN);
  ok(runs.length === 1, "no further retry runs once it has rebuilt");
  await c.runTo(slot + 12 * H + MIN);
  ok(runs.length === 2 && S.boardRefreshStatus({ full: true }).boards.solana.givenUpTotal === 3, "the next slot rebuilds as usual");
  s.stop();
}
// A rebuild that starts for another reason cancels the pending retry.
{
  S.__resetBoardRefresh();
  const slot = DAY0 + cad.BOARD_SLOT_HOURS_UTC.mpp[0] * H;
  const c = clock(slot - 5 * MIN);
  const runs = [];
  let high = true;
  const s = S.scheduleBoardRefresh({ board: "mpp", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => high, log: quiet, givenUpRetryMs: 13 * H, run: async () => { runs.push(c.now()); } });
  await c.runTo(slot + 46 * MIN);
  high = false;
  await c.runTo(slot + 12 * H + MIN); // the next slot runs first
  await c.runTo(slot + 14 * H);       // the retry was due at +13h45
  ok(runs.length === 1 && runs[0] === slot + 12 * H, `a rebuild that ran since cancels the pending retry: one rebuild, not two (${runs.map((t) => (t - slot) / MIN)})`);
  s.stop();
}

// --- a rebuild that never settles gives the gate back at its bound ----------------------
{
  S.__resetBoardRefresh();
  const slot = DAY0 + cad.BOARD_SLOT_HOURS_UTC.base[0] * H;
  const c = clock(slot - 5 * MIN);
  const errors = [], started = [], signals = [];
  const settle = [];
  const s = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, runMaxMs: 30 * MIN, log: { ...quiet, error: (m) => errors.push(m) },
    run: ({ signal }) => { started.push(c.now()); signals.push(signal); return new Promise((res) => settle.push(res)); } });
  await c.runTo(slot + MIN);
  ok(started.length === 1 && S.boardRefreshRunning() === "base" && S.boardRefreshStatus().status === "ok", "a rebuild that is running holds the gate");
  await c.runTo(slot + 31 * MIN);
  const st = S.boardRefreshStatus({ full: true });
  ok(S.boardRefreshRunning() === null && errors.length === 1 && /still running after 30 min/.test(errors[0]) && signals[0].aborted === true && st.status === "stalled" && st.boards.base.pastItsBound === true, `past its bound the gate is released, the run's signal is aborted, an error line is written and the word reads stalled (${errors[0]})`);
  // The board's next slot rebuilds again (it used to spend every later tick on "its own rebuild is still running").
  await c.runTo(slot + 12 * H + MIN);
  ok(started.length === 2 && S.boardRefreshRunning() === "base", "the board's next slot rebuilds: a hung rebuild no longer ends the board's rebuilds");
  // The first run settles now, late: it must not release the gate the second run holds.
  settle[0]();
  await c.runTo(slot + 12 * H + 2 * MIN);
  ok(S.boardRefreshRunning() === "base" && S.boardRefreshStatus().status === "stalled", "a run that settles after its bound releases nothing: the later run still holds the gate");
  settle[1]();
  await c.runTo(slot + 12 * H + 3 * MIN);
  const done = S.boardRefreshStatus({ full: true });
  ok(S.boardRefreshRunning() === null && done.status === "ok" && done.boards.base.pastItsBound === false && done.boards.base.pastItsBoundTotal === 1, "a run that finishes inside its bound releases the gate and the word reads ok again");
  await c.runTo(slot + 12 * H + 40 * MIN);
  ok(errors.length === 1, "a finished run's bound never fires");
  s.stop();
}
// A peer never waits on a hung rebuild past the bound, and a stopped schedule's hung rebuild still gives the gate back.
{
  S.__resetBoardRefresh();
  const slotBase = DAY0 + cad.BOARD_SLOT_HOURS_UTC.base[0] * H;
  const c = clock(slotBase - 5 * MIN);
  const a = S.scheduleBoardRefresh({ board: "base", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, heapHigh: () => false, runMaxMs: 10 * MIN, log: quiet, run: () => new Promise(() => {}) });
  await c.runTo(slotBase + MIN);
  a.stop();
  await c.runTo(slotBase + 11 * MIN);
  ok(S.boardRefreshRunning() === null, "the gate comes back at the bound even when the schedule that started the rebuild was stopped");
  ok(S.boardRefreshRunMaxMs({}) === 2 * H && S.boardRefreshRunMaxMs({ BOARD_REFRESH_RUN_MAX_MS: "600000" }) === 600_000 && S.boardRefreshRunMaxMs({ BOARD_REFRESH_RUN_MAX_MS: "5" }) === 2 * H && S.boardRefreshRunMaxMs({ BOARD_REFRESH_RUN_MAX_MS: "soon" }) === 2 * H, "BOARD_REFRESH_RUN_MAX_MS sets the bound; under a minute or malformed reads as two hours");
}

console.log(`\ntest-board-refresh-slots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
