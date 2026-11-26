// Store cases for the sanctions events store (src/sanctions-events.js), run
// by an offline suite in file mode and by a Postgres suite in database mode:
//   race     a journal replay whose write lands AFTER a flush wrote a newer
//            copy of the same row never lowers it (the replay waits between
//            its read and its write: records.get patched in database mode,
//            the store's test hook in file mode);
//   bounded  20,000 refusals on one row during a store outage leave the
//            journal holding a small constant number of entries, and a replay
//            after recovery lands the final count quickly;
//   filed    a journaled copy with more attempts never changes a filed row;
//            what it holds past the filed row lands in one new row, however
//            often it is replayed;
//   elsewhere (database mode, with EV2) a row one process files while
//            another still counts on it: the other's later attempts and
//            counts open a new unfiled row, none lost.
// `EV`: the store module. `EV2`: a second instance of it (its own memory and
// journal handle, the same database), or null. `sdb`: src/state-db.js
// (database mode) or null.
import { readFileSync, appendFileSync } from "node:fs";
import { oursMs, OURS_READING } from "./ours-clock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function journalEntries(file) {
  const out = new Map();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return 0; }
  for (const l of text.split("\n")) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e && e.removed) out.delete(e.removed);
    else if (e && e.id && e.kind) out.set(e.id, e);
  }
  return out.size;
}

export async function runSanctionsStoreCases({ EV, EV2 = null, sdb = null, ok, label }) {
  const eventsFile = () => process.env.SANCTIONS_EVENTS_FILE;
  const journalFile = () => `${eventsFile()}.pending.ndjson`;
  const stored = async (id) => {
    if (sdb) return (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [EV.SANCTIONS_EVENTS_COLLECTION, id])).rows[0]?.body ?? null;
    let row = null;
    for (const l of readFileSync(eventsFile(), "utf8").split("\n")) { if (!l) continue; try { const r = JSON.parse(l); if (r.id === id) row = r; } catch { /* torn */ } }
    return row;
  };

  // ---- race
  // The delay sits where a lost update would happen: in database mode between
  // a read-then-write merge's read and its write (records.get, the read the
  // earlier merge made, is patched to wait after it reads; the one-statement
  // upsert reads nothing, so it never waits there and its write cannot be
  // overtaken); in file mode before the merge, which reads and writes the
  // in-memory rows in one synchronous step. The flush runs once the replay
  // has read (or has finished, when it read nothing).
  const raceHooks = () => {
    let delay = 0, signal = null;
    const read = new Promise((r) => { signal = r; });
    const recs = sdb?.records;
    const origGet = recs?.get;
    if (recs) recs.get = async (...a) => { const r = await origGet.apply(recs, a); if (a[0] === EV.SANCTIONS_EVENTS_COLLECTION && delay) { signal(); await sleep(delay); } return r; };
    return {
      read, arm: (ms) => { delay = ms; },
      replayHook: async () => { if (!recs && delay) { signal(); await sleep(delay); } },
      restore: () => { if (recs) recs.get = origGet; },
    };
  };
  {
    EV.__resetSanctionsEventLimitsForTests();
    const ev = { kind: "screen-hit", address: "0x" + "e7".repeat(20), rail: "x402", route: "POST /api/race" };
    const row = await EV.recordSanctionsEvent(ev);
    let failFlush = 1;
    const h = raceHooks();
    EV.__setSanctionsStoreHookForTests?.(async (source) => {
      if (source === "flush" && failFlush > 0) { failFlush--; throw new Error("case: write refused"); }
      if (source === "replay") await h.replayHook();
    });
    try {
      await EV.recordSanctionsEvent(ev);
      await EV.recordSanctionsEvent(ev);
      await EV.flushSanctionsEvents(); // refused: the copy (3 attempts) stays held here
      await EV.__dropSanctionsJournalHoldsForTests?.(); // ...freed, as a dead process's would be
      await EV.recordSanctionsEvent(ev); // a fourth attempt, held for the next flush
      h.arm(150);
      const rp = EV.replaySanctionsJournal(); // reads the stored row (1), then waits before its write
      await Promise.race([h.read, rp]);
      await EV.flushSanctionsEvents(); // writes the newer copy (4) meanwhile
      await rp;
    } finally {
      EV.__setSanctionsStoreHookForTests?.(null);
      h.restore();
    }
    await EV.flushSanctionsEvents();
    const s = await stored(row.id);
    ok(s?.attempts === 4 && EV.sanctionsEventWriteLimits().pending === 0, `${label}: a replay whose write lands after a newer flush never lowers the row (stored attempts ${s?.attempts} of 4)`);

    // An OLDER copy left in the journal by another process (a deploy overlap, a
    // kill), replayed while this process writes a newer one: the replay's write
    // lands last and must not lower the row.
    EV.__resetSanctionsEventLimitsForTests();
    const ev2 = { kind: "screen-hit", address: "0x" + "e8".repeat(20), rail: "x402", route: "POST /api/race" };
    const row2 = await EV.recordSanctionsEvent(ev2);
    for (let i = 0; i < 3; i++) await EV.recordSanctionsEvent(ev2); // 4 attempts, the last 3 not written yet
    const older = { ...row2, attempts: 2, lastSeenAt: row2.at };
    appendFileSync(journalFile(), JSON.stringify({ id: `case-older-${Date.now()}`, kind: "sanctions-row", payload: older, at: Date.now() }) + "\n");
    const h2 = raceHooks();
    EV.__setSanctionsStoreHookForTests?.(async (source) => { if (source === "replay") await h2.replayHook(); });
    try {
      h2.arm(150);
      const rp = EV.replaySanctionsJournal();
      await Promise.race([h2.read, rp]);
      await EV.flushSanctionsEvents();
      await rp;
    } finally {
      EV.__setSanctionsStoreHookForTests?.(null);
      h2.restore();
    }
    const s2 = await stored(row2.id);
    ok(s2?.attempts === 4, `${label}: an older journaled copy replayed after a newer write never lowers the row (stored attempts ${s2?.attempts} of 4)`);
  }

  // ---- bounded
  {
    EV.__resetSanctionsEventLimitsForTests();
    const before = journalEntries(journalFile());
    EV.__setSanctionsStoreHookForTests?.(async (source) => { if (source === "flush") throw new Error("case: store away"); });
    let mid = 0, unsettledMid = 0, row = null;
    const N = 20_000;
    try {
      for (let i = 0; i < N; i++) {
        row = await EV.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unsigned-field", rail: "bounded", route: "POST /ref/hash" });
        if (i === N / 2) {
          // Unsettled: a shared journal drops a row's older copy only once
          // the newer one is durable, so a few copies may still be waiting:
          // never one per refusal.
          unsettledMid = journalEntries(journalFile()) - before;
          await EV.__sanctionsJournalSettledForTests?.();
          mid = journalEntries(journalFile()) - before;
        }
      }
      await EV.__sanctionsJournalSettledForTests?.();
      await sleep(20);
    } finally { EV.__setSanctionsStoreHookForTests?.(null); }
    const held = journalEntries(journalFile()) - before;
    ok(row?.count === N && unsettledMid <= 256 && mid <= 2 && held <= 2, `${label}: ${N} refusals on one row during an outage leave ${held} journal entr${held === 1 ? "y" : "ies"} (${mid} midway once durable, ${unsettledMid} before), not one per refusal`);
    // A restart: the process's holds end with it, memory is gone; the replay alone lands the final count.
    await EV.__dropSanctionsJournalHoldsForTests?.();
    EV.__resetSanctionsEventLimitsForTests();
    EV.__resetSanctionsEventsForTests();
    // The replay's cost is read two ways a loaded host does not move: the
    // writes it makes (one per entry the journal holds, never one per
    // refusal) and the time that was this thread's (scripts/lib/ours-clock.js),
    // so a host busy with other work, or a database answering slowly, is not
    // read as a long replay, while a replay that works through every refusal
    // still costs our thread seconds.
    let writes = 0;
    EV.__setSanctionsStoreHookForTests?.(async (source) => { if (source === "replay") writes++; });
    const t0 = Date.now(), c0 = oursMs();
    try { await EV.replaySanctionsJournal(); } finally { EV.__setSanctionsStoreHookForTests?.(null); }
    const took = oursMs() - c0, wall = Date.now() - t0;
    const s = await stored(row.id);
    ok(s?.count === N && journalEntries(journalFile()) === before, `${label}: after recovery the replay lands the final count (${s?.count}) in ${wall} ms and empties the journal`);
    ok(writes <= held && took < 1000, `${label}: the bounded journal's replay is short: ${writes} write${writes === 1 ? "" : "s"} for ${held} entr${held === 1 ? "y" : "ies"}, ${took.toFixed(0)} ms of ${OURS_READING} (${wall} ms wall)`);
  }

  // ---- held: a write that fails keeps the row's journal entry (in a shared journal too) until the
  //      row lands; a replay meanwhile does not take it from this process; once it lands the journal
  //      holds nothing more for it.
  {
    EV.__resetSanctionsEventLimitsForTests();
    const addr = "0x" + "a7".repeat(20);
    const mine = async () => (await EV.__sanctionsJournalEntriesForTests()).filter((e) => e.payload?.address === addr);
    let away = true;
    EV.__setSanctionsStoreHookForTests?.(async (source) => { if (away && source === "flush") throw new Error("case: store away"); });
    try {
      const first = await EV.recordSanctionsEvent({ kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/held" });
      await EV.recordSanctionsEvent({ kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/held" });
      await EV.flushSanctionsEvents();
      await EV.__sanctionsJournalSettledForTests?.();
      const held = await mine();
      ok(first === null && held.length === 1 && held[0].payload.attempts === 2, `${label}: a write that fails leaves the row's newest copy in the journal (${held.length} entr${held.length === 1 ? "y" : "ies"}, attempts ${held[0]?.payload?.attempts})`);
      await EV.replaySanctionsJournal();
      ok((await mine()).length === 1 && !(await stored(held[0].payload.id)), `${label}: a replay meanwhile leaves the entry held by this process (it writes it itself)`);
      away = false;
      await EV.flushSanctionsEvents();
      await EV.__sanctionsJournalSettledForTests?.();
      await sleep(50);
      const s = await stored(held[0].payload.id);
      ok(s?.attempts === 2 && (await mine()).length === 0 && EV.sanctionsEventWriteLimits().pending === 0, `${label}: once the store takes it, the row lands with both attempts and the journal holds nothing for it (${(await mine()).length} left)`);
    } finally { EV.__setSanctionsStoreHookForTests?.(null); }
  }

  // ---- keys: at most SANCTIONS_AGGREGATE_KEYS_PER_HOUR aggregate rows an hour; the rest in one overflow row
  {
    EV.__resetSanctionsEventLimitsForTests();
    const hour = Date.UTC(2031, 0, 6, 10, 30); // one clock hour of its own
    const cap = EV.SANCTIONS_AGGREGATE_KEYS_PER_HOUR;
    const made = [];
    for (let i = 0; i < cap + 50; i++) made.push(await EV.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unsigned-field", rail: `k${i}`, route: "POST /api/keys" }, { now: hour + i }));
    for (let i = 0; i < 10; i++) await EV.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unproven-signer", rail: `k${cap + 100 + i}`, route: "POST /api/keys" }, { now: hour + 1000 + i });
    await EV.flushSanctionsEvents();
    const ids = new Set(made.map((r) => r?.id));
    const over = made[made.length - 1];
    const so = await stored(over.id);
    ok(ids.size === cap + 1 && over.overflow === true && so?.count === 60 && so.byReason?.["unsigned-field"] === 50 && so.byReason?.["unproven-signer"] === 10 && so.rail === null && so.country === null, `${label}: ${cap + 60} distinct aggregate keys in one hour open ${ids.size - 1} rows and one overflow row counting the other ${so?.count}`);
    const next = await EV.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unsigned-field", rail: "k-next", route: "POST /api/keys" }, { now: hour + 3_600_000 });
    ok(next && !next.overflow && next.rail === "k-next", `${label}: the next hour opens rows again`);
  }

  // ---- filed
  {
    EV.__resetSanctionsEventLimitsForTests();
    const row = await EV.recordSanctionsEvent({ kind: "screen-hit", address: "0x" + "f9".repeat(20), rail: "x402", route: "POST /api/filed" });
    await EV.markSanctionsEventsFiled({ ids: [row.id], reference: "RS-FILED" });
    // A copy of the row with more attempts, left in the journal (as a killed process would leave it).
    const copy = { ...row, attempts: 99, lastSeenAt: new Date(Date.now() + 60_000).toISOString(), filedAt: null, filedRef: null };
    appendFileSync(journalFile(), JSON.stringify({ id: `case-${Date.now()}`, kind: "sanctions-row", payload: copy, at: Date.now() }) + "\n");
    EV.__resetSanctionsEventsForTests();
    await EV.replaySanctionsJournal();
    const s = await stored(row.id);
    ok(s?.filedRef === "RS-FILED" && s.attempts === 1 && s.lastSeenAt === row.lastSeenAt, `${label}: a journaled copy never changes a filed row (attempts ${s?.attempts}, ref ${s?.filedRef})`);
    const follow = async () => {
      if (sdb) return (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND body->>'follows' = $2`, [EV.SANCTIONS_EVENTS_COLLECTION, row.id])).rows.map((x) => x.body);
      return readFileSync(eventsFile(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.follows === row.id).reduce((m, r) => m.set(r.id, r), new Map());
    };
    const f1 = [...(await follow()).values()];
    // The same copy left again (a replay that died before removing it): one row still, by maximum.
    appendFileSync(journalFile(), JSON.stringify({ id: `case-again-${Date.now()}`, kind: "sanctions-row", payload: copy, at: Date.now() }) + "\n");
    EV.__resetSanctionsEventsForTests();
    await EV.replaySanctionsJournal();
    const f2 = [...(await follow()).values()];
    ok(f1.length === 1 && f1[0].attempts === 98 && !f1[0].filedAt && f1[0].address === row.address && f1[0].kind === row.kind && f2.length === 1 && f2[0].id === f1[0].id && f2[0].attempts === 98,
      `${label}: what the copy holds past the filed row lands in one new unfiled row (attempts ${f1[0]?.attempts} of 98; ${f2.length} row after a second replay)`);
  }

  // ---- elsewhere: another process files a row this one still counts on
  if (sdb && EV2) {
    EV.__resetSanctionsEventLimitsForTests(); EV2.__resetSanctionsEventLimitsForTests();
    const addr = "0x" + "c3".repeat(20);
    const ev = { kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/elsewhere" };
    const rows = async () => (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND body->>'address' = $2 ORDER BY id`, [EV.SANCTIONS_EVENTS_COLLECTION, addr])).rows.map((x) => x.body);
    const first = await EV2.recordSanctionsEvent(ev); // process B
    await EV2.recordSanctionsEvent(ev);
    await EV2.flushSanctionsEvents(); // stored: 2 attempts
    const marked = await EV.markSanctionsEventsFiled({ ids: [first.id], reference: "RS-ELSEWHERE" }); // process A files it
    for (let i = 0; i < 3; i++) await EV2.recordSanctionsEvent(ev); // B keeps counting on its copy
    await EV2.flushSanctionsEvents(); // B's write meets the filed row
    await EV2.flushSanctionsEvents(); // ...and writes the row it opened
    await EV2.__sanctionsJournalSettledForTests?.();
    let after = await rows();
    const filed = after.find((r) => r.id === first.id), next = after.find((r) => r.id !== first.id);
    const leftB = (await EV2.__sanctionsJournalEntriesForTests()).filter((e) => e.payload?.address === addr);
    ok(marked.marked === 1 && filed?.filedRef === "RS-ELSEWHERE" && filed.attempts === 2 && after.length === 2 && next && !next.filedAt && next.attempts === 3 && next.follows === first.id
      && next.kind === "screen-hit" && next.route === ev.route && next.report === "rejected" && next.dueBy,
      `${label}: attempts after another process filed the row open a new unfiled row (filed ${filed?.attempts}, new ${next?.attempts} of 3, ${after.length} rows)`);
    ok(EV2.sanctionsEventWriteLimits().pending === 0 && leftB.length === 0, `${label}: ...and nothing stays pending or journaled for either row (${leftB.length} journal entries)`);
    await EV2.recordSanctionsEvent(ev); // a later repeat adds to the new row
    await EV2.flushSanctionsEvents();
    after = await rows();
    ok(after.length === 2 && after.find((r) => r.id === next?.id)?.attempts === 4 && after.reduce((t, r) => t + r.attempts, 0) === 6, `${label}: a later repeat adds to the new row; every one of the 6 attempts is on a row (${after.map((r) => r.attempts).join("+")})`);
    const view = await EV.sanctionsEventsOperatorView({ recent: 1000 });
    ok(view.unfiled.some((r) => r.id === next?.id) && !view.unfiled.some((r) => r.id === first.id), `${label}: the operator view lists the new row as due and the filed one as filed`);

    // The same for an hourly count row (a geo-payment aggregate, a report).
    const agg = { kind: "geo-payment", reason: "region-blocked", rail: "elsewhere", route: "POST /api/elsewhere", country: "CU" };
    const a = await EV2.recordSanctionsAggregate(agg);
    await EV2.recordSanctionsAggregate(agg);
    await EV2.flushSanctionsEvents();
    await EV.markSanctionsEventsFiled({ ids: [a.id], reference: "RS-AGG" });
    for (let i = 0; i < 3; i++) await EV2.recordSanctionsAggregate({ ...agg, reason: i ? "region-blocked" : "country-blocked" });
    await EV2.flushSanctionsEvents(); await EV2.flushSanctionsEvents();
    const aggRows = (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND body->>'rail' = 'elsewhere' ORDER BY id`, [EV.SANCTIONS_EVENTS_COLLECTION])).rows.map((x) => x.body);
    const aFiled = aggRows.find((r) => r.id === a.id), aNext = aggRows.find((r) => r.id !== a.id);
    ok(aggRows.length === 2 && aFiled?.count === 2 && aFiled.filedRef === "RS-AGG" && aNext && !aNext.filedAt && aNext.count === 3 && aNext.byReason?.["region-blocked"] === 2 && aNext.byReason?.["country-blocked"] === 1 && aNext.country === "CU",
      `${label}: counts after another process filed the hour's row open a new unfiled row (filed ${aFiled?.count}, new ${aNext?.count} ${JSON.stringify(aNext?.byReason)})`);
  }
}
