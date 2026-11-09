// The durable record of Tempo late-landing watches (src/tempo-late-watches.js)
// and the in-process watch's use of it (src/mpp-tempo.js watchLateTempoLanding):
// a read that fails keeps the entry, and one failing for a day is dropped with
// an error; a booking that does not land keeps it; the list is bounded with an
// error for each dropped entry; an in-process watch removes its entry only
// once it has answered. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
const { createLateWatchLedger, LATE_WATCH_GRACE_MS, LATE_WATCH_GIVE_UP_MS, LATE_WATCH_KEEP_MAX, lateWatchKey } = await import("../src/tempo-late-watches.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { watchLateTempoLanding, configureTempoLateWatches, _lateTempoWatchCount } = await import("../src/mpp-tempo.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const fresh = () => createJsonDocument({ name: `tempo-late-watches-t${++n}`, log: () => {} });
const entries = async (doc) => Object.keys((await doc.read()).body?.watches || {});
const DUE = 40 + LATE_WATCH_GRACE_MS + 1;

{
  const doc = fresh(); const logs = [];
  let t = 1_000_000;
  const L = createLateWatchLedger({ doc, now: () => t, log: (m) => logs.push(m) });
  await L.record("k1", { auth: "A1", startedAt: t, lastDelayMs: 40, method: "GET", path: "/x", amountAtomic: "1000" });
  t += DUE;
  // A failed read (trace.error, the confirm never throws) keeps the entry.
  const failing = async (_a, { trace }) => { trace.error = "timeout"; return null; };
  const r1 = await L.sweep({ confirm: failing, book: async () => true });
  ok(r1.failed === 1 && (await entries(doc)).length === 1, "a read that fails keeps the entry for the next tick");
  // A confirm that throws is a failed read too.
  const r1b = await L.sweep({ confirm: async () => { throw new Error("boom"); }, book: async () => true });
  ok(r1b.failed === 1 && (await entries(doc)).length === 1, "a confirm that throws is a failed read");
  // After a day of failures: dropped, with an error naming the route.
  t += LATE_WATCH_GIVE_UP_MS + 1;
  const r2 = await L.sweep({ confirm: failing, book: async () => true });
  ok(r2.gaveUp === 1 && (await entries(doc)).length === 0 && logs.some((m) => /ERROR late-landing watch for GET \/x could not read the chain/.test(m)), "after a day of failed reads the entry is dropped with an error");
}
{
  const doc = fresh();
  let t = 1_000_000;
  const L = createLateWatchLedger({ doc, now: () => t, log: () => {} });
  await L.record("k2", { auth: "A2", startedAt: t, lastDelayMs: 40 });
  t += DUE;
  const found = async () => ({ txId: "0x" + "cd".repeat(32), amountAtomic: 1000n });
  const r1 = await L.sweep({ confirm: found, book: async () => false });
  ok(r1.failed === 1 && (await entries(doc)).length === 1, "a booking that does not land keeps the entry");
  let calls = 0;
  const r2 = await L.sweep({ confirm: found, book: async () => { calls++; return true; } });
  ok(r2.landed === 1 && calls === 1 && (await entries(doc)).length === 0, "the next tick books it and removes the entry");
  await L.record("k3", { auth: "A3", startedAt: t, lastDelayMs: 40 });
  t += DUE;
  const r3 = await L.sweep({ confirm: async () => null, book: async () => true });
  ok(r3.absent === 1 && (await entries(doc)).length === 0, "a clean read that finds nothing removes the entry");
  // An entry a live watch on this process owns is never read by the sweep.
  await L.record("k4", { auth: "A4", startedAt: t, lastDelayMs: 40 });
  L.own("k4"); t += DUE;
  const r4 = await L.sweep({ confirm: found, book: async () => true });
  ok(r4.read === 0 && (await entries(doc)).length === 1, "the sweep never reads an entry this process's live watch owns");
  L.release("k4");
}
{
  // The list is bounded: past the bound the oldest is dropped with an error.
  const doc = fresh(); const logs = [];
  const L = createLateWatchLedger({ doc, log: (m) => logs.push(m) });
  const body = { watches: {} };
  for (let i = 0; i < LATE_WATCH_KEEP_MAX; i++) body.watches[`k${i}`] = { auth: `A${i}`, startedAt: 1000 + i, lastDelayMs: 40 };
  await doc.update(() => body, { fallback: { watches: {} } });
  await L.record("newest", { auth: "AN", startedAt: 999_999, lastDelayMs: 40 });
  const keys = await entries(doc);
  ok(keys.length === LATE_WATCH_KEEP_MAX && !keys.includes("k0") && keys.includes("newest") && logs.filter((m) => /ERROR late-landing watch list is full/.test(m)).length === 1, `the list keeps at most ${LATE_WATCH_KEEP_MAX}, dropping the oldest with one error line`);
}
{
  // The in-process watch: removes its entry only once it has answered.
  const doc = fresh();
  const L = createLateWatchLedger({ doc, log: () => {} });
  configureTempoLateWatches(L);
  const settle = async () => { for (let i = 0; i < 100 && _lateTempoWatchCount() > 0; i++) await sleep(5); await sleep(20); };
  watchLateTempoLanding("AUTH-clean", { confirm: async () => null, onLanded: async () => true, delays: [0], log: () => {}, record: { method: "GET", path: "/a" } });
  await settle();
  ok(!(await entries(doc)).includes(lateWatchKey("AUTH-clean")), "a watch whose reads all answered and found nothing removes its entry");
  watchLateTempoLanding("AUTH-failing", { confirm: async (_a, { trace }) => { trace.error = "timeout"; return null; }, onLanded: async () => true, delays: [0], log: () => {}, record: { method: "GET", path: "/b" } });
  await settle();
  ok((await entries(doc)).includes(lateWatchKey("AUTH-failing")), "a watch whose last read failed leaves its entry for the sweep");
  watchLateTempoLanding("AUTH-unbooked", { confirm: async () => ({ txId: "0x" + "ef".repeat(32) }), onLanded: async () => false, delays: [0], log: () => {}, record: { method: "GET", path: "/c" } });
  await settle();
  ok((await entries(doc)).includes(lateWatchKey("AUTH-unbooked")), "a landing whose booking did not land leaves its entry for the sweep");
  watchLateTempoLanding("AUTH-booked", { confirm: async () => ({ txId: "0x" + "aa".repeat(32) }), onLanded: async () => true, delays: [0], log: () => {}, record: { method: "GET", path: "/d" } });
  await settle();
  ok(!(await entries(doc)).includes(lateWatchKey("AUTH-booked")), "a booked landing removes its entry");
  const before = (await entries(doc)).length;
  watchLateTempoLanding("AUTH-norecord", { confirm: async () => null, onLanded: async () => true, delays: [0], log: () => {} });
  await settle();
  ok((await entries(doc)).length === before, "a watch started without a record is not written (the old in-process behavior)");
  configureTempoLateWatches(null);
}

{
  // The server wires it: the ledger configured, the sweep started on the gate's
  // booking path, synthetic traffic marked; the gate's watch passes a record.
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const tempo = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  ok(/configureTempoLateWatches\(createLateWatchLedger\(\)\);/.test(server) && /startLateWatchSweep\(\{ sweepOnce: \(\) => tempoGate\.sweepLateWatches\(\) \}\)/.test(server) && /syntheticOf: isSyntheticRequest,/.test(server)
    && /__lateWatchSynthetic === "boolean" \? req\.__lateWatchSynthetic : isSyntheticRequest\(req\)/.test(server),
    "server.js configures the ledger, starts the sweep on the gate and keeps a stored request's synthetic mark");
  ok(/record: \{ method: req\.method, path: req\.path, payer: req\.mppTempoLedgerPayer \|\| null, amountAtomic: String\(binding\.amountAtomic\), synthetic: !!syntheticOf\(req\) \},/.test(tempo), "the gate's late watch passes the record the sweep books from");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
