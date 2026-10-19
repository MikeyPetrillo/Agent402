// flight-search accepts a departure date that is today anywhere on Earth: a
// date is past only when it is before the calendar date in UTC-12. Pure
// validation, offline.
import { validateSearch } from "../src/tools/flights-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tryIt = (date, nowIso) => { try { validateSearch({ from: "LAX", to: "JFK", date }, Date.parse(nowIso)); return "ok"; } catch (e) { return `${e.statusCode} ${e.message}`; } };

// 03:00 UTC on the 20th is still the evening of the 19th in the Americas.
ok(tryIt("2026-10-19", "2026-10-20T03:00:00Z") === "ok", "a same-day search in a zone behind UTC is accepted after UTC midnight");
ok(tryIt("2026-10-20", "2026-10-20T03:00:00Z") === "ok", "the UTC date is accepted");
ok(/past/.test(tryIt("2026-10-18", "2026-10-20T03:00:00Z")), "the day before the earliest local date is refused");
// At 13:00 UTC on the 20th it is the 20th everywhere (UTC-12 reads 01:00 on the 20th).
ok(/past/.test(tryIt("2026-10-19", "2026-10-20T13:00:00Z")), "once the 19th has ended everywhere it is refused");
ok(tryIt("2026-10-19", "2026-10-20T11:59:00Z") === "ok", "the 19th is still accepted while UTC-12 is on the 19th");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
