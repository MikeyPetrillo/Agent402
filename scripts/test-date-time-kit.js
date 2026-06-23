// Date-time-kit tests — all deterministic (no network). Validates input
// rejection + correct computation for every tool.
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

// --- date-diff ---
{
  const r = await h("date-diff")({ from: "2024-01-15", to: "2026-06-23" });
  ok(r.diff.years === 2, "date-diff years=2");
  ok(r.diff.months === 5, "date-diff months=5");
  ok(r.total.days === 890, "date-diff total days=890");
  ok(r.direction === "forward", "date-diff direction=forward");
}
{
  const r = await h("date-diff")({ from: "2026-06-23", to: "2024-01-15" });
  ok(r.direction === "backward", "date-diff backward direction");
}
try { await h("date-diff")({ from: "bad", to: "2026-01-01" }); ok(false, "date-diff rejects bad from"); }
catch (e) { ok(e.statusCode === 400, "date-diff rejects bad from"); }

// --- cron-explain ---
{
  const r = await h("cron-explain")({ expression: "0 9 * * 1-5" });
  ok(r.summary.includes("09:00"), "cron 0 9 * * 1-5 shows 09:00");
  ok(r.summary.includes("Monday"), "cron 0 9 * * 1-5 mentions Monday");
  ok(r.summary.includes("Friday"), "cron 0 9 * * 1-5 mentions Friday");
  ok(r.fields.minute === "0", "cron fields.minute=0");
}
{
  const r = await h("cron-explain")({ expression: "*/15 * * * *" });
  ok(r.summary.includes("15"), "cron */15 shows step 15");
}
try { await h("cron-explain")({ expression: "bad" }); ok(false, "cron rejects bad expr"); }
catch (e) { ok(e.statusCode === 400, "cron rejects bad expr"); }

try { await h("cron-explain")({ expression: "" }); ok(false, "cron rejects empty"); }
catch (e) { ok(e.statusCode === 400, "cron rejects empty"); }

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

// --- business-days ---
{
  // 2026 full year: 365 days, 261 weekdays, 104 weekend days
  const r = await h("business-days")({ start: "2026-01-01", end: "2026-12-31", holidays: "false" });
  ok(r.businessDays === 261, "biz-days 2026 no holidays = 261");
  ok(r.weekendDays === 104, "biz-days 2026 weekends = 104");
  ok(r.totalDays === 365, "biz-days 2026 total = 365");
}
{
  const r = await h("business-days")({ start: "2026-01-01", end: "2026-12-31", holidays: "true" });
  ok(r.holidayDays > 0, "biz-days with holidays subtracts some");
  ok(r.businessDays < 261, "biz-days with holidays < 261");
  ok(r.businessDays + r.weekendDays + r.holidayDays === 365, "biz-days totals add up");
}
try { await h("business-days")({ start: "2026-12-31", end: "2026-01-01" }); ok(false, "biz-days rejects end<start"); }
catch (e) { ok(e.statusCode === 400, "biz-days rejects end<start"); }

try { await h("business-days")({ start: "", end: "2026-01-01" }); ok(false, "biz-days rejects empty start"); }
catch (e) { ok(e.statusCode === 400, "biz-days rejects empty start"); }

// --- summary ---
console.log(`\n=== date-time-kit: ${pass}/${pass + fail} PASS ===`);
if (fail) { console.error(`${fail} test(s) FAILED`); process.exit(1); }
console.log("date-time-kit PASS");
