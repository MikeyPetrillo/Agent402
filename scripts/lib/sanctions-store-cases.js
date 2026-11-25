// Store cases for the sanctions events store (src/sanctions-events.js), run
// by an offline suite in file mode and by a Postgres suite in database mode:
//   race     a journal replay whose write lands AFTER a flush wrote a newer
//            copy of the same row never lowers it (forced with the store's
//            test hook, and with records.get / records.put patched the way the
//            earlier read-then-write merge used them);
//   bounded  20,000 refusals on one row during a store outage leave the
//            journal holding a small constant number of entries, and a replay
//            after recovery lands the final count quickly;
//   filed    a journaled copy with more attempts never changes a filed row.
// `EV`: the store module. `sdb`: src/state-db.js (database mode) or null.
import { readFileSync, appendFileSync } from "node:fs";

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

export async function runSanctionsStoreCases({ EV, sdb = null, ok, label }) {
  const eventsFile = () => process.env.SANCTIONS_EVENTS_FILE;
  const journalFile = () => `${eventsFile()}.pending.ndjson`;
  const stored = async (id) => {
    if (sdb) return (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [EV.SANCTIONS_EVENTS_COLLECTION, id])).rows[0]?.body ?? null;
    let row = null;
    for (const l of readFileSync(eventsFile(), "utf8").split("\n")) { if (!l) continue; try { const r = JSON.parse(l); if (r.id === id) row = r; } catch { /* torn */ } }
    return row;
  };

  // ---- race
  {
    EV.__resetSanctionsEventLimitsForTests();
    const ev = { kind: "screen-hit", address: "0x" + "e7".repeat(20), rail: "x402", route: "POST /api/race" };
    const row = await EV.recordSanctionsEvent(ev);
    let failFlush = 1, delayReplay = 0;
    EV.__setSanctionsStoreHookForTests?.(async (source) => {
      if (source === "flush" && failFlush > 0) { failFlush--; throw new Error("case: write refused"); }
      if (source === "replay" && delayReplay) await sleep(delayReplay);
    });
    // The same interleaving for a build whose merge read then wrote through records.get / records.put.
    const recs = sdb?.records;
    const origGet = recs?.get, origPut = recs?.put;
    let failPut = 1;
    if (recs) {
      recs.put = async (...a) => { if (a[0] === EV.SANCTIONS_EVENTS_COLLECTION && failPut > 0 && a[2]?.attempts > 1) { failPut--; throw new Error("case: write refused"); } return origPut.apply(recs, a); };
      recs.get = async (...a) => { const r = await origGet.apply(recs, a); if (a[0] === EV.SANCTIONS_EVENTS_COLLECTION && delayReplay) await sleep(delayReplay); return r; };
    }
    try {
      await EV.recordSanctionsEvent(ev);
      await EV.recordSanctionsEvent(ev);
      await EV.flushSanctionsEvents(); // refused: the copies are freed for the replay
      await EV.recordSanctionsEvent(ev); // a fourth attempt, held for the next flush
      delayReplay = 150;
      const rp = EV.replaySanctionsJournal(); // reads, then waits
      await sleep(20);
      await EV.flushSanctionsEvents(); // writes the newer copy meanwhile
      await rp;
    } finally {
      EV.__setSanctionsStoreHookForTests?.(null);
      if (recs) { recs.get = origGet; recs.put = origPut; }
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
    EV.__setSanctionsStoreHookForTests?.(async (source) => { if (source === "replay") await sleep(150); });
    if (recs) recs.get = async (...a) => { const r = await origGet.apply(recs, a); if (a[0] === EV.SANCTIONS_EVENTS_COLLECTION) await sleep(150); return r; };
    try {
      const rp = EV.replaySanctionsJournal();
      await sleep(20);
      await EV.flushSanctionsEvents();
      await rp;
    } finally {
      EV.__setSanctionsStoreHookForTests?.(null);
      if (recs) recs.get = origGet;
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
    EV.__dropSanctionsJournalHoldsForTests?.();
    await sleep(200);
    EV.__resetSanctionsEventLimitsForTests();
    EV.__resetSanctionsEventsForTests();
    const t0 = Date.now();
    await EV.replaySanctionsJournal();
    const took = Date.now() - t0;
    const s = await stored(row.id);
    ok(s?.count === N && journalEntries(journalFile()) === before, `${label}: after recovery the replay lands the final count (${s?.count}) in ${took} ms and empties the journal`);
    ok(took < 1000, `${label}: the bounded journal's replay is short (${took} ms)`);
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
  }
}
