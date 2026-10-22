// Pins the load-shed boot warm-up default: with SHED_LAG_WARMUP_MS unset, a
// saturated loop with few requests waiting (boot work) does not shed free
// traffic until 60 s after the module loaded, and does from 60 s on. Inside
// the warm-up a saturated loop with a backlog (a flood: a quarter of the
// in-flight ceiling, 100 by default) still sheds. The module's start time is bracketed by
// reading the clock on both sides of its import.
delete process.env.SHED_LAG_WARMUP_MS;
delete process.env.LOAD_SHED;
delete process.env.SHED_LAG_MS;
delete process.env.SHED_INFLIGHT;
delete process.env.SHED_WARMUP_LAG_INFLIGHT;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const before = Date.now();
const { shouldShedFree } = await import("../src/load-shed.js");
const after = Date.now();
const saturated = { inFlight: 0, lagMs: 5000, lateTicks: 4 };

ok(shouldShedFree({ ...saturated, now: before + 59_000 }) === null, "59 s after boot: lag does not shed");
ok(shouldShedFree({ ...saturated, now: before + 30_000 }) === null, "30 s after boot: lag does not shed");
ok(shouldShedFree({ ...saturated, now: after + 60_000 }) === "lag", "60 s after boot: a saturated loop sheds");
ok(shouldShedFree({ ...saturated, now: after + 61_000 }) === "lag", "61 s after boot: a saturated loop sheds");
ok(shouldShedFree({ inFlight: 10_000, lagMs: 0, lateTicks: 0, now: before }) === "inflight", "the in-flight ceiling applies from the start");
ok(shouldShedFree({ ...saturated, inFlight: 100, now: before + 1_000 }) === "lag", "1 s after boot: a saturated loop with 100 requests in flight (a flood) sheds");
ok(shouldShedFree({ ...saturated, inFlight: 100, now: before + 30_000 }) === "lag", "30 s after boot: a saturated loop with 100 requests in flight sheds");
ok(shouldShedFree({ ...saturated, inFlight: 99, now: before + 30_000 }) === null, "30 s after boot: a saturated loop with 99 in flight (boot work) does not shed");
ok(shouldShedFree({ inFlight: 300, lagMs: 5000, lateTicks: 1, now: before + 30_000 }) === null, "during the warm-up a single stall (one late tick) with a backlog does not shed");
ok(shouldShedFree({ inFlight: 300, lagMs: 100, lateTicks: 4, now: before + 30_000 }) === null, "during the warm-up a backlog without loop lag does not shed below the in-flight ceiling");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
