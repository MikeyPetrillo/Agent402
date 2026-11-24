// Macro tools: cpi-yoy lists a month with no published value in missingDates
// (and a note) instead of dropping it silently; world-bank-indicator's
// default endYear is the previous calendar year and its schema description
// states the same value. Offline: DNS and fetch are answered locally with
// bodies shaped like the upstream APIs.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { stubGuardResolver, oneV4 } from "./lib/guard-resolver-stub.js";
dnsPromises.lookup = async () => ({ address: "1.1.1.1", family: 4 });
stubGuardResolver(oneV4("1.1.1.1")); // the address guard resolves with dns.Resolver
syncBuiltinESMExports();
const { MACRO_TOOLS, worldBankDefaultEndYear } = await import("../src/tools/macro-kit.js");

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

// --- cpi-yoy: one month the BLS has no value for among the trailing twelve
{
  const { _resetUsMacroForTest } = await import("../src/tools/us-macro-series.js");
  const now = new Date();
  const month = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
  const months = Array.from({ length: 30 }, (_, i) => month(31 - i)); // oldest first, through two months ago
  const gap = month(5);
  const bls = (skip) => (u) => (u.hostname === "api.bls.gov" ? { status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "CUSR0000SA0", data: months.map((date, i) => ({ year: date.slice(0, 4), period: `M${date.slice(5, 7)}`, value: date === skip ? "-" : (300 + i).toFixed(3) })) }] } } : {});
  _resetUsMacroForTest();
  respond = bls(gap);
  const r = await tool("cpi-yoy").handler({});
  ok(Array.isArray(r.missingDates) && r.missingDates.length === 1 && r.missingDates[0] === gap, `cpi-yoy names the unpublished month (got ${JSON.stringify(r.missingDates)})`);
  ok(new RegExp(gap).test(r.note || ""), "cpi-yoy says so in a note");
  ok(!r.trailing12mo.some((o) => o.date === gap) && r.trailing12mo.length === 11, "the trailing readings never carry a made-up value for it");
  _resetUsMacroForTest();
  respond = bls(null);
  const full = await tool("cpi-yoy").handler({});
  ok(Array.isArray(full.missingDates) && full.missingDates.length === 0 && !("note" in full) && full.trailing12mo.length === 12, "a complete year reports an empty missingDates and no note");
}

// --- world-bank-indicator default end year
{
  const y = new Date().getUTCFullYear() - 1;
  ok(worldBankDefaultEndYear() === y, `the default end year is the previous calendar year (${worldBankDefaultEndYear()})`);
  ok(worldBankDefaultEndYear(new Date("2031-01-01T00:00:00Z")) === 2030, "the default moves with the clock");
  const t = tool("world-bank-indicator");
  ok(t.discovery.inputSchema.properties.endYear.description.includes(String(y)), `the endYear description states ${y}`);
  // The series read, and the indicator's license read beside it (src/tools/macro-kit.js).
  respond = (u) => {
    if (/^\/v2\/indicator\//.test(u.pathname)) return [{ page: 1 }, [{ id: "NY.GDP.MKTP.CD", source: { id: "2", value: "World Development Indicators" } }]];
    if (/\/metadata$/.test(u.pathname)) return { source: [{ id: "2", name: "World Development Indicators", concept: [{ id: "Series", variable: [{ id: "NY.GDP.MKTP.CD", metatype: [{ id: "License_Type", value: "CC BY-4.0" }, { id: "Source", value: "World Bank national accounts data" }] }] }] }] };
    return [{ page: 1, pages: 1, per_page: 200, total: 1 }, [{ indicator: { id: "NY.GDP.MKTP.CD", value: "GDP (current US$)" }, country: { id: "US", value: "United States" }, date: String(y), value: 1 }]];
  };
  seen.length = 0;
  await t.handler({ country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2018 });
  const dataRead = seen.find((u) => /^\/v2\/country\//.test(u.pathname));
  ok(dataRead?.searchParams.get("date") === `2018:${y}`, `with no endYear the request window ends at ${y} (got ${dataRead?.searchParams.get("date")})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
