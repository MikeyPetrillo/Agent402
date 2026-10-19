// Macro tools: cpi-yoy lists a month with no published value in missingDates
// (and a note) instead of dropping it silently; world-bank-indicator's
// default endYear is the previous calendar year and its schema description
// states the same value; the release calendar's window starts at today's
// date in America/Chicago. Offline: DNS and fetch are answered locally with
// bodies shaped like the upstream APIs.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
dnsPromises.lookup = async () => ({ address: "1.1.1.1", family: 4 });
syncBuiltinESMExports();
process.env.FRED_API_KEY = "test-key-not-real";
const { MACRO_TOOLS, worldBankDefaultEndYear, fredCalendarWindow } = await import("../src/tools/macro-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);

const seen = [];
let respond = () => ({});
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  seen.push(u);
  return new Response(JSON.stringify(respond(u)), { status: 200, headers: { "content-type": "application/json" } });
};

// --- cpi-yoy: one unpublished month among the newest 13 (FRED marks it ".")
{
  const months = ["2026-09-01", "2026-08-01", "2026-07-01", "2026-06-01", "2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01", "2026-01-01", "2025-12-01", "2025-11-01", "2025-10-01", "2025-09-01"];
  respond = () => ({ observations: months.map((date, i) => ({ realtime_start: "2026-10-19", realtime_end: "2026-10-19", date, value: date === "2026-07-01" ? "." : (3 + i / 10).toFixed(4) })) });
  const r = await tool("cpi-yoy").handler({});
  ok(Array.isArray(r.missingDates) && r.missingDates.length === 1 && r.missingDates[0] === "2026-07-01", `cpi-yoy names the unpublished month (got ${JSON.stringify(r.missingDates)})`);
  ok(/2026-07-01/.test(r.note || ""), "cpi-yoy says so in a note");
  ok(!r.trailing12mo.some((o) => o.date === "2026-07-01") && r.trailing12mo.length === 12, "the trailing readings never carry a made-up value for it");
  respond = () => ({ observations: months.map((date, i) => ({ date, value: (3 + i / 10).toFixed(4) })) });
  const full = await tool("cpi-yoy").handler({});
  ok(Array.isArray(full.missingDates) && full.missingDates.length === 0 && !("note" in full), "a complete year reports an empty missingDates and no note");
}

// --- world-bank-indicator default end year
{
  const y = new Date().getUTCFullYear() - 1;
  ok(worldBankDefaultEndYear() === y, `the default end year is the previous calendar year (${worldBankDefaultEndYear()})`);
  ok(worldBankDefaultEndYear(new Date("2031-01-01T00:00:00Z")) === 2030, "the default moves with the clock");
  const t = tool("world-bank-indicator");
  ok(t.discovery.inputSchema.properties.endYear.description.includes(String(y)), `the endYear description states ${y}`);
  respond = () => [{ page: 1, pages: 1, per_page: 200, total: 1 }, [{ indicator: { id: "NY.GDP.MKTP.CD", value: "GDP (current US$)" }, country: { id: "US", value: "United States" }, date: String(y), value: 1 }]];
  seen.length = 0;
  await t.handler({ country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2018 });
  ok(seen.at(-1)?.searchParams.get("date") === `2018:${y}`, `with no endYear the request window ends at ${y} (got ${seen.at(-1)?.searchParams.get("date")})`);
}

// --- release calendar window in America/Chicago
{
  // 02:00 UTC on Oct 20 is 21:00 on Oct 19 in Chicago (CDT, UTC-5).
  const w = fredCalendarWindow(14, Date.parse("2026-10-20T02:00:00Z"));
  ok(w.start === "2026-10-19" && w.end === "2026-11-02", `the window starts at Chicago's date (got ${w.start}..${w.end})`);
  const w2 = fredCalendarWindow(1, Date.parse("2026-10-20T06:00:00Z"));
  ok(w2.start === "2026-10-20" && w2.end === "2026-10-21", "after Chicago's midnight the next day starts");
  respond = () => ({ release_dates: [] });
  seen.length = 0;
  await tool("fred-release-calendar").handler({ days: 14 });
  const u = seen.find((x) => x.pathname.endsWith("/releases/dates"));
  const now = fredCalendarWindow(14);
  ok(u && u.searchParams.get("realtime_start") === now.start && u.searchParams.get("realtime_end") === now.end, `the handler sends the Chicago window (${u?.searchParams.get("realtime_start")}..${u?.searchParams.get("realtime_end")})`);
  ok(/America\/Chicago/.test(tool("fred-release-calendar").description), "the description names the zone");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
