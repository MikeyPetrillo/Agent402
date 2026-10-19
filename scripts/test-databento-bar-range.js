#!/usr/bin/env node
// Every equities read is bounded by the DAILY-BAR schema's end, not the
// dataset's: over a weekend the dataset's end (instrument definitions,
// statistics) runs past the last settled session, and a bar read up to it is
// refused by both datasets. Offline: global fetch is stubbed with the shape
// the range endpoint answers.
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
process.env.DATABENTO_WARM = "off";
const db = await import("../src/tools/databento.js");
const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
const quote = FINANCE_TOOLS.find((t) => t.slug === "stock-quote").handler;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

const WEEKEND = {
  start: "2024-07-01T00:00:00.000000000Z", end: "2026-10-19T04:00:00.000000000Z",
  schema: { "ohlcv-1d": { start: "2024-07-01T00:00:00.000000000Z", end: "2026-10-17T00:00:00.000000000Z" }, definition: { end: "2026-10-19T04:00:00.000000000Z" } },
};
ok(db.rangeEndOf(WEEKEND) === "2026-10-17", `the bar schema's end wins over the dataset's (${db.rangeEndOf(WEEKEND)})`);
ok(db.rangeEndOf({ end: "2026-10-14" }) === "2026-10-14", "an answer without per-schema ends still reads the dataset's end");
ok(db.rangeEndOf({}) === "", "no end at all reads empty (the caller refuses it)");

const ns = (day) => String(Date.parse(`${day}T00:00:00Z`) * 1e6);
const row = (day, close) => JSON.stringify({ hd: { ts_event: ns(day), publisher_id: 90 }, open: "3.4e11", high: "3.48e11", low: "3.38e11", close, volume: "1000" });
const ends = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("get_dataset_range")) return new Response(JSON.stringify(WEEKEND), { status: 200 });
  if (u.includes("get_cost")) return new Response("0.00001", { status: 200 });
  if (u.includes("get_range")) {
    const p = new URLSearchParams(String(init?.body || ""));
    ends.push(p.get("end"));
    if (p.get("end") > "2026-10-17") return new Response(JSON.stringify({ detail: "data_schema_not_fully_available" }), { status: 422 });
    return new Response([row("2026-10-15", "341000000000"), row("2026-10-16", "342000000000")].join("\n") + "\n", { status: 200 });
  }
  return new Response("{}", { status: 404 });
};
try {
  const out = await quote({ symbol: "AAPL" });
  ok(ends.length > 0 && ends.every((e) => e <= "2026-10-17"), `the bar read never asks past the bars' end (${ends.join(",")})`);
  ok(out && Number.isFinite(out.close ?? out.price ?? out.last), `a weekend quote answers from the last settled session (${JSON.stringify(out).slice(0, 120)})`);
} catch (e) {
  ok(false, `a weekend quote answers instead of throwing (${e.statusCode} ${e.message})`);
} finally { globalThis.fetch = realFetch; }

console.log(`\ntest-databento-bar-range: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
