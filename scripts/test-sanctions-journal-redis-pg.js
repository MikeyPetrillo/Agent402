// The sanctions events store's journal in REAL Redis (LEDGER_JOURNAL_REDIS=on)
// on a REAL Postgres: a row write that fails keeps the row's journal entry
// held by this process until a later write lands it, and only then is the
// entry removed.
//   1. The store refuses the write once: the newest copy stays in the journal,
//      and a replay run again and again over a window never takes it (the
//      process that holds it writes it itself; released, the replay would
//      land it and a later removal could miss where it went).
//   2. The store recovers: the flush lands the row with every attempt and
//      the journal holds nothing for it.
// Works whichever way the persistence gate reads (entries in Redis, or on the
// local fallback while Redis persistence is off); the log names which.
//
//   STATE_DATABASE_URL=postgres://... REDIS_URL=redis://... node scripts/test-sanctions-journal-redis-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-sanctions-journal-redis-pg" });
if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-sanctions-journal-redis-pg: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '' --appendonly yes) and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
process.env.LEDGER_JOURNAL_REDIS = "on";
const DIR = mkdtempSync(join(tmpdir(), "sanctions-journal-redis-"));
process.env.SANCTIONS_EVENTS_FILE = join(DIR, "events.jsonl");

const sdb = await import("../src/state-db.js");
const { awaitJournalRedisGate } = await import("../src/ledger-journal-redis.js");
const EV = await import("../src/sanctions-events.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stored = async (id) => (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [EV.SANCTIONS_EVENTS_COLLECTION, id])).rows[0]?.body ?? null;
let exit = 1;
try {
  const gate = await awaitJournalRedisGate({ timeoutMs: 5_000 });
  console.log(`# journal entries go to ${gate.open ? "Redis" : `the local fallback (${gate.reason})`}`);
  const addr = "0x" + "b4".repeat(20);
  const ev = { kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/held-redis" };
  const mine = async () => (await EV.__sanctionsJournalEntriesForTests()).filter((e) => e.payload?.address === addr);
  let away = true;
  EV.__setSanctionsStoreHookForTests(async (source) => { if (away && source === "flush") throw new Error("case: store away"); });
  try {
    const first = await EV.recordSanctionsEvent(ev); // refused: kept in the journal
    await EV.recordSanctionsEvent(ev);
    await EV.flushSanctionsEvents(); // refused again
    await EV.__sanctionsJournalSettledForTests();
    const held = await mine();
    const id = held[0]?.payload?.id;
    ok(first === null && held.length === 1 && held[0].payload.attempts === 2 && EV.sanctionsEventWriteLimits().pending === 1, `a write that fails keeps the row's newest copy in the journal (${held.length} entr${held.length === 1 ? "y" : "ies"}, attempts ${held[0]?.payload?.attempts})`);
    // Over a window, replay after replay: the entry stays held here, so none lands it.
    const until = Date.now() + 1_500;
    let replays = 0, landedByReplay = false;
    while (Date.now() < until && !landedByReplay) {
      await EV.replaySanctionsJournal();
      replays++;
      landedByReplay = Boolean(id && (await stored(id)));
      await sleep(50);
    }
    ok(id && !landedByReplay && (await mine()).length === 1, `${replays} replays over 1.5 s leave the entry held by the process whose write failed (landed by a replay: ${landedByReplay})`);
    away = false;
    await EV.flushSanctionsEvents();
    await EV.__sanctionsJournalSettledForTests();
    // The removal reaches the journal on its own schedule: wait for it, with a deadline.
    const deadline = Date.now() + 5_000;
    let left = await mine();
    while (left.length && Date.now() < deadline) { await sleep(50); left = await mine(); }
    const s = await stored(id);
    ok(s?.attempts === 2 && EV.sanctionsEventWriteLimits().pending === 0, `once the store takes it, the row lands with both attempts (${s?.attempts})`);
    ok(left.length === 0, `...and the journal holds nothing more for it (${left.length} left)`);
  } finally { EV.__setSanctionsStoreHookForTests(null); }
  exit = fail ? 1 : 0;
} catch (e) {
  console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch { /* best effort */ }
  try { await sdb.closeStateDb(); } catch { /* closing */ }
  rmSync(DIR, { recursive: true, force: true });
  console.log(`\ntest-sanctions-journal-redis-pg: ${pass} passed, ${fail} failed`);
  process.exit(exit);
}
