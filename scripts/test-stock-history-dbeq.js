#!/usr/bin/env node
// stock-history is served from DBEQ.BASIC alone, with every bar at least 24
// hours old and every answer labeled with its venues and "not consolidated"
// (src/tools/databento.js, src/tools/finance-kit.js). Offline: global fetch is
// stubbed and records every upstream request.
//   1. with the provider on, no request ever names the consolidated summary
//      dataset, whatever DATABENTO_SUMMARY says (history reads, the range
//      read, the warmer's audit and pre-reads);
//   2. an end date of today (and a dataset that claims today's bars) is
//      clamped to the latest session whose bar is at least 24 hours old, and
//      the answer says so (latestAvailable, delayHours);
//   3. every answer carries the fixed venues notice and consolidated: false;
//   4. the published example answers through the stub with every documented
//      field;
//   5. stock-quote stays refused with the provider on;
//   6. stock-history is refused on the third-party routes (/ref and /aws),
//      even with the suite's clearance seam naming it.
//
//   node scripts/test-stock-history-dbeq.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
import { isHost } from "./lib/url-host.js";
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
process.env.STOCK_DATA_PROVIDER = "databento";
process.env.DATABENTO_WARM = "off";
process.env.DATABENTO_SUMMARY = "on";
const db = await import("../src/tools/databento.js");
const { FINANCE_TOOLS, financeToolsEnabled, STOCK_RESALE_REASON } = await import("../src/tools/finance-kit.js");
const SP = await import("../src/tools/stock-provider.js");
const historyTool = FINANCE_TOOLS.find((t) => t.slug === "stock-history");
const history = historyTool.handler;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const realFetch = globalThis.fetch;

const DAY = 864e5;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const ns = (day) => String(Date.parse(`${day}T00:00:00Z`) * 1e6);
// One bar per venue per day, the shape DBEQ.BASIC answers (publisher ids 39, 40, 41).
const venueRows = (day, i) => [39, 40, 41].map((pub, k) => JSON.stringify({ hd: { ts_event: ns(day), publisher_id: pub }, open: String((100 + i) * 1e9), high: String((102 + i) * 1e9), low: String((99 + i) * 1e9), close: String((101 + i + k * 0.01) * 1e9), volume: String(1000 * (3 - k)) }));
const today = isoDay(Date.now());

const up = { calls: [], rangeEnd: null };
const datasetOf = (url, init) => new URL(String(url)).searchParams.get("dataset") || new URLSearchParams(String(init?.body || "")).get("dataset");
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!isHost(u, "hist.databento.com")) throw new Error(`unexpected egress: ${u}`);
  const body = String(init?.body || "");
  const kind = u.includes("get_dataset_range") ? "range" : u.includes("get_cost") ? "cost" : u.includes("get_range") ? "data" : "other";
  const params = new URLSearchParams(body);
  up.calls.push({ kind, dataset: datasetOf(url, init), url: u, body, end: params.get("end"), start: params.get("start") });
  // The dataset claims bars through today (an end of tomorrow, exclusive).
  if (kind === "range") return new Response(JSON.stringify({ end: up.rangeEnd || isoDay(Date.now() + DAY) }), { status: 200 });
  if (kind === "cost") return new Response("0.00001", { status: 200 });
  if (kind === "data") {
    // Every weekday from start up to (not including) end, today's included if asked.
    const rows = [];
    let i = 0;
    for (let t = Date.parse(params.get("start") + "T00:00:00Z"); t < Date.parse(params.get("end") + "T00:00:00Z"); t += DAY) {
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) rows.push(...venueRows(isoDay(t), i++));
    }
    // An upstream that answers past the end it was asked for.
    if (up.pastEnd) rows.push(...venueRows(today, 99));
    return new Response(rows.join("\n") + "\n", { status: 200 });
  }
  throw new Error(`unstubbed path ${u}`);
};
const reset = () => { db.__resetDatabentoState(); up.calls = []; up.rangeEnd = null; up.pastEnd = false; };
const named = (c, re) => re.test(c.url) || re.test(c.body);
const NOTICE_FIELDS = (r) => r.notice === db.VENUE_NOTICE && r.consolidated === false && r.delayHours === 24
  && ["IEX", "NYSE Chicago", "NYSE National"].every((v) => r.venues.includes(v)) && !/Pearl/.test(r.venues)
  && /Not consolidated: volumes and prices are those venues' only, and closes can differ from the official consolidated close/.test(r.notice)
  && /not investment advice/i.test(r.notice) && r.dataset === "DBEQ.BASIC";

try {
  // ---- 1. only DBEQ.BASIC is ever asked, with DATABENTO_SUMMARY=on
  reset();
  const answers = [];
  answers.push(await history({ symbol: "AAPL", days: 5 }));
  answers.push(await history({ symbol: "AAPL", days: 5 })); // the cached repeat
  answers.push(await history({ symbol: "MSFT", days: 30, indicators: true }));
  await db.warmTick(); // the warmer's range read and quote-shape audit
  await db.databentoAdapter.quote("IBM", { demand: true }); // the adapter's own quote path
  ok(up.calls.length > 0 && up.calls.every((c) => c.dataset === "DBEQ.BASIC"), `every upstream request names DBEQ.BASIC (${[...new Set(up.calls.map((c) => `${c.kind}:${c.dataset}`))].join(" ")})`);
  ok(!up.calls.some((c) => named(c, /EQUS/i)), "no request names the consolidated summary dataset, DATABENTO_SUMMARY=on notwithstanding");
  delete process.env.DATABENTO_SUMMARY;
  reset();
  await history({ symbol: "AAPL", days: 5 });
  ok(up.calls.length > 0 && !up.calls.some((c) => named(c, /EQUS/i)), "control: unset, the same holds");
  ok(JSON.stringify(db.datasetOrder()) === '["DBEQ.BASIC"]', "the dataset order is DBEQ.BASIC alone");

  // ---- 2. the 24-hour clamp
  const latest = db.latestAvailableSession();
  ok(latest < today && Date.parse(latest + "T00:00:00Z") + DAY <= Date.now() - 24 * 3600_000, `the latest available session's bar ended at least 24 hours ago (${latest}, today ${today})`);
  for (const [at, want, why] of [
    ["2026-11-25T15:00:00Z", "2026-11-23", "Wednesday afternoon: Monday (Tuesday's bar is not 24 hours past its day yet)"],
    ["2026-11-26T00:00:00Z", "2026-11-24", "the moment Tuesday's bar turns 24 hours past its day"],
    ["2026-11-27T12:00:00Z", "2026-11-25", "the day after Thanksgiving: Wednesday (the holiday is skipped)"],
    ["2026-11-30T12:00:00Z", "2026-11-27", "Monday: the Friday half day"],
  ]) ok(db.latestAvailableSession(Date.parse(at)) === want, `${why}: ${db.latestAvailableSession(Date.parse(at))}`);
  reset();
  const h = await history({ symbol: "AAPL", days: 10 });
  const dataCalls = up.calls.filter((c) => c.kind === "data");
  const cap = isoDay(Date.parse(latest + "T00:00:00Z") + DAY);
  ok(dataCalls.length === 1 && dataCalls.every((c) => c.end <= cap), `the bar read asks no further than the day after the latest available session (end ${dataCalls.map((c) => c.end).join()}, cap ${cap})`);
  ok(h.bars.length === 10 && h.bars.every((b) => b.day <= latest) && h.asOf <= latest && h.latestAvailable === latest, `no bar is newer than latestAvailable (${h.asOf} <= ${h.latestAvailable})`);
  ok(!h.bars.some((b) => b.day === today), "today's bar is never served though the dataset claims it");
  reset();
  const direct = await db.databentoAdapter.dailyBars("AAPL", { sessions: 5, end: isoDay(Date.now() + DAY) });
  const directData = up.calls.filter((c) => c.kind === "data");
  ok(directData.every((c) => c.end <= cap) && direct.bars.every((b) => b.day <= latest) && direct.latestAvailable === latest, `an explicit end of today clamps to the delayed end (asked ${isoDay(Date.now() + DAY)}, read ${directData.map((c) => c.end).join()})`);
  // An answer carrying a bar past the asked end is held to the delay too.
  reset(); up.pastEnd = true;
  const past = await history({ symbol: "TSLA", days: 5 });
  ok(past.bars.every((b) => b.day <= latest) && !past.bars.some((b) => b.day === today), `a bar the upstream sends past the asked end is dropped (${past.asOf})`);
  // A dataset that ends earlier than the delay bounds the read itself.
  reset(); up.rangeEnd = "2026-10-14";
  const older = await history({ symbol: "AAPL", days: 3 });
  ok(up.calls.filter((c) => c.kind === "data").every((c) => c.end === "2026-10-14") && older.asOf === "2026-10-13", `a dataset end older than the delay is the bound (${older.asOf})`);
  answers.push(h, older);

  // ---- 3. the notice on every answer
  ok(answers.length >= 5 && answers.every(NOTICE_FIELDS), `every answer carries the venues notice, consolidated: false and delayHours 24 (${answers.length} answers)`);
  ok(answers.every((r) => r.bars.every((b) => b.volume === null && Number.isFinite(b.venueVolume))), "every bar's volume is null and venueVolume carries the venue total");
  ok(answers.every((r) => typeof r.latestAvailable === "string"), "every answer names its latestAvailable session");
  ok(/at least 24 hours old/.test(historyTool.description) && /latestAvailable/.test(historyTool.description) && /not the consolidated tape/.test(historyTool.description), "the description states the delay, names latestAvailable and says not consolidated");

  // ---- 4. the published example through the stub
  reset();
  const ex = historyTool.discovery.output.example;
  const r = await history(historyTool.discovery.input, {});
  const missing = Object.keys(ex).filter((k) => !(k in r));
  ok(missing.length === 0 && r.bars.length === historyTool.discovery.input.days, `the published example answers with every documented field (missing: ${missing.join(", ") || "none"}, ${r.bars.length} bars)`);
  ok(NOTICE_FIELDS(ex) && ex.bars.every((b) => b.volume === null), "the published example itself carries the notice fields");

  // ---- 5. stock-quote stays off with the provider on
  ok(financeToolsEnabled().map((t) => t.slug).join() === "stock-history" && SP.stockQuoteEnabled() === false, "with the provider on the kit lists stock-history alone");
  let refused = null;
  try { await FINANCE_TOOLS.find((t) => t.slug === "stock-quote").handler({ symbol: "AAPL" }, {}); } catch (e) { refused = e; }
  ok(refused?.statusCode === 503 && refused.notOffered === true, `stock-quote answers 503 not-offered with the provider on (${refused?.statusCode})`);

  // ---- 6. refused on the third-party routes
  const { resaleClearanceRefusal, markResaleCleared } = await import("../src/resale-terms.js");
  const { referralIneligibility } = await import("../src/referral-gate.js");
  const { awsIneligibility } = await import("../src/aws-marketplace-gate.js");
  const seamEnv = { ...process.env, RESALE_CLEARED_FOR_TEST: "stock-history" };
  ok(resaleClearanceRefusal(historyTool) === STOCK_RESALE_REASON && resaleClearanceRefusal(historyTool, { env: seamEnv }) === STOCK_RESALE_REASON, "stock-history is barred from resale, the clearance seam notwithstanding");
  ok(referralIneligibility(historyTool) === STOCK_RESALE_REASON, `/ref refuses stock-history with the reason (${referralIneligibility(historyTool)})`);
  ok(awsIneligibility(historyTool, {}) === STOCK_RESALE_REASON, `/aws refuses stock-history with the reason (${awsIneligibility(historyTool, {})})`);
  let cleared = null;
  try { markResaleCleared([historyTool], ["stock-history"], "a test source"); } catch (e) { cleared = e; }
  ok(/barred and cannot be cleared/.test(cleared?.message || ""), "a clearance mark cannot be added to stock-history");
  // Control: a tool that is cleared passes the same check.
  const control = { slug: "control-tool", resaleCleared: true, handler: () => ({}) };
  ok(resaleClearanceRefusal(control) === null, "control: a cleared tool is not refused by the same check");
} finally {
  globalThis.fetch = realFetch;
  db.__resetDatabentoState();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
