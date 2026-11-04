// Date-time-kit tests — all deterministic (no network). Validates input
// rejection + correct computation for every tool.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { DATE_TIME_TOOLS } from "../src/tools/date-time-kit.js";

const h = (slug) => DATE_TIME_TOOLS.find((t) => t.slug === slug).handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- timezone-convert ---
{
  const r = await h("timezone-convert")({ datetime: "2026-06-23T14:00:00Z", from: "UTC", to: "America/New_York" });
  ok(r.to.formatted.includes("10:00:00"), "tz-convert UTC→ET shows 10:00");
  ok(r.utc === "2026-06-23T14:00:00.000Z", "tz-convert preserves UTC");
}
try { await h("timezone-convert")({ datetime: "2026-01-01", from: "Fake/Zone", to: "UTC" }); ok(false, "tz-convert rejects bad tz"); }
catch (e) { ok(e.statusCode === 400, "tz-convert rejects bad tz"); }

try { await h("timezone-convert")({ datetime: "", from: "UTC", to: "UTC" }); ok(false, "tz-convert rejects empty datetime"); }
catch (e) { ok(e.statusCode === 400, "tz-convert rejects empty datetime"); }

// --- date-format ---
{
  const r = await h("date-format")({ datetime: "1719100800" });
  ok(r.iso === "2024-06-23T00:00:00.000Z", "date-format unix→ISO");
  ok(r.unix === 1719100800, "date-format unix roundtrip");
  ok(r.dayOfWeek === "Sunday", "date-format dayOfWeek=Sunday");
}
{
  const r = await h("date-format")({ datetime: "2026-12-25T00:00:00Z" });
  ok(r.date === "2026-12-25", "date-format ISO→date-only");
  ok(r.dayOfWeek === "Friday", "date-format Christmas 2026 is Friday");
}
try { await h("date-format")({ datetime: "not-a-date" }); ok(false, "date-format rejects bad input"); }
catch (e) { ok(e.statusCode === 400, "date-format rejects bad input"); }

// --- summary ---
console.log(`\n=== date-time-kit: ${pass}/${pass + fail} PASS ===`);
if (fail) { console.error(`${fail} test(s) FAILED`); process.exit(1); }
console.log("date-time-kit PASS");
