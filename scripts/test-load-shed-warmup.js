// Pins the load-shed boot warm-up default: with SHED_LAG_WARMUP_MS unset, a
// saturated loop does not shed free traffic until 60 s after the module
// loaded, and does from 60 s on. The module's start time is bracketed by
// reading the clock on both sides of its import.
delete process.env.SHED_LAG_WARMUP_MS;
delete process.env.LOAD_SHED;
delete process.env.SHED_LAG_MS;
delete process.env.SHED_INFLIGHT;

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

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
