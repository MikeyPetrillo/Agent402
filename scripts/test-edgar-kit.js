// EDGAR-kit tests — same shape as test-macro-kit.js: strict on our validation
// logic (offline, deterministic) and tolerant of SEC EDGAR rate-limiting or
// outages on live calls. Fails only if an assertion breaks or if EVERY live
// call fails (which would mean our integration is broken, not SEC's network).
//
// Note: EDGAR enforces a User-Agent header — set EDGAR_USER_AGENT to your own
// "Name email@domain" string for friendlier rate treatment. The kit ships a
// generic Agent402 fallback that works out-of-the-box.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { EDGAR_TOOLS, tickerSuggestions } from "../src/tools/edgar-kit.js";

const h = (slug) => EDGAR_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- a company name where a ticker goes gets the likely tickers (offline) ---
{
  const map = new Map([
    ["TSLA", { name: "Tesla, Inc." }], ["NVDA", { name: "NVIDIA CORP" }],
    ["BRK-A", { name: "BERKSHIRE HATHAWAY INC" }], ["BRK-B", { name: "BERKSHIRE HATHAWAY INC" }],
    ["TSLL", { name: "Direxion Daily TSLA Bull 2X Shares" }], ["XTES", { name: "Some Tesla Supplier Ltd" }],
  ]);
  const t = tickerSuggestions(map, "Tesla");
  ok(t[0]?.ticker === "TSLA", `"Tesla" suggests TSLA first (got ${JSON.stringify(t)})`);
  ok(t.some((x) => x.ticker === "XTES") && t.length <= 3, "a name containing the word ranks after names that start with it, capped at 3");
  ok(tickerSuggestions(map, "nvidia")[0]?.ticker === "NVDA", "case-insensitive");
  ok(tickerSuggestions(map, "berkshire hathaway").map((x) => x.ticker).join() === "BRK-A,BRK-B", "multi-word names match; both share classes listed");
  ok(tickerSuggestions(map, "ts").length === 0, "under three letters suggests nothing (too loose)");
  ok(tickerSuggestions(map, "zzzz").length === 0, "no match suggests nothing");
}

// --- an EDGAR 5xx is read once more, inside the budget (offline) ---
{
  const { withEdgarRetry } = await import("../src/tools/edgar-kit.js");
  const e5 = (s) => Object.assign(new Error(`EDGAR upstream HTTP ${s} - try again later`), { statusCode: 502, upstreamStatus: s });
  const e404 = Object.assign(new Error("EDGAR returned 404"), { statusCode: 422, upstreamStatus: 404 });
  const seq = (answers) => { let n = 0; const f = async () => { const a = answers[n++]; if (a instanceof Error) throw a; return a; }; f.calls = () => n; return f; };
  let r = seq([e5(500), { ok: 1 }]);
  ok((await withEdgarRetry(r, { pauseMs: 0, budget: null })).ok === 1 && r.calls() === 2, "an EDGAR 500 is retried once and the second answer is used");
  r = seq([e5(503), e5(500)]);
  let err = null; try { await withEdgarRetry(r, { pauseMs: 0, budget: null }); } catch (e) { err = e; }
  ok(err?.statusCode === 502 && r.calls() === 2, "a second 5xx stands as the 502 (two reads, no more)");
  r = seq([e404]);
  err = null; try { await withEdgarRetry(r, { pauseMs: 0, budget: null }); } catch (e) { err = e; }
  ok(err?.statusCode === 422 && r.calls() === 1, "a 404 is not retried");
  r = seq([e5(500), { ok: 1 }]);
  err = null; try { await withEdgarRetry(r, { pauseMs: 0, budget: { remaining: () => 1_000 } }); } catch (e) { err = e; }
  ok(err?.statusCode === 502 && r.calls() === 1, "with too little budget left the 5xx stands without a retry");
}

// --- an empty first search page is read once more (offline, stubbed reader) ---
{
  const { eftsSearchWith } = await import("../src/tools/edgar-kit.js");
  const empty = { hits: { total: { value: 0 }, hits: [] } };
  const full = { hits: { total: { value: 2 }, hits: [{ _id: "a" }, { _id: "b" }] } };
  let calls = [];
  const reader = (answers) => async (url) => { calls.push(url); return answers[calls.length - 1]; };
  const r1 = await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, full]), pauseMs: 0 });
  ok(calls.length === 2 && calls[0] === calls[1] && r1.hits.hits.length === 2, "an empty first page is read again with the same URL, and the second answer is used");
  calls = [];
  const r2 = await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, empty, empty, empty, full]), pauseMs: 0, budget: null });
  ok(calls.length === 5 && r2.hits.hits.length === 0 && calls[4] !== calls[0] && /forms=10-K/.test(calls[4]), "a search empty on every read answers empty once a control query confirms the index is answering");
  ok(calls[1] === calls[0] && calls[2] === calls[0] && calls[3] === `${calls[0]}&from=0`, "the last re-read asks the same search under another URL (explicit first-page offset)");
  calls = [];
  const rAlt = await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, empty, empty, full]), pauseMs: 0, budget: null });
  ok(calls.length === 4 && rAlt.hits.hits.length === 2, "hits under the other URL are the answer, with no control read (one URL answering empty)");
  calls = [];
  let dead = null;
  try { await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, empty, empty, empty, empty]), pauseMs: 0, budget: null }); } catch (e) { dead = e; }
  ok(calls.length === 5 && dead?.statusCode === 503 && /not answering/.test(dead?.message || ""), `when the control query is empty too the search answers a 503, never a confident empty (${dead?.statusCode} ${dead?.message})`);
  calls = [];
  dead = null;
  const throwing = async (url) => { calls.push(url); if (calls.length === 5) throw Object.assign(new Error("EDGAR upstream HTTP 500"), { statusCode: 502, upstreamStatus: 500 }); return empty; };
  try { await eftsSearchWith({ forms: "S-1" }, { getJson: throwing, pauseMs: 0, budget: null }); } catch (e) { dead = e; }
  ok(dead?.statusCode === 503 && /not answering/.test(dead?.message || ""), "a control read that fails also answers the 503");
  calls = [];
  dead = null;
  try { await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, full]), pauseMs: 0, budget: { remaining: () => 5_000 } }); } catch (e) { dead = e; }
  ok(calls.length === 2 && !dead, `with little budget left the re-reads stop early and the confirming read still runs (${calls.length} reads)`);
  calls = [];
  dead = null;
  try { await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, full]), pauseMs: 0, budget: { remaining: () => 1_000 } }); } catch (e) { dead = e; }
  ok(calls.length === 1 && dead?.statusCode === 503, "with no budget left to confirm, an empty answer is a 503, not a confident empty");
  calls = [];
  const r3 = await eftsSearchWith({ forms: "S-1" }, { getJson: reader([empty, empty, full]), pauseMs: 0 });
  ok(calls.length === 3 && r3.hits.hits.length === 2, "an empty answer twice, then hits, returns the hits (the 2026-10-30 CI case)");
  calls = [];
  await eftsSearchWith({ forms: "S-1" }, { getJson: reader([full]), pauseMs: 0 });
  ok(calls.length === 1, "a first page with hits is read once");
  calls = [];
  await eftsSearchWith({ forms: "S-1", from: 100 }, { getJson: reader([empty]), pauseMs: 0 });
  ok(calls.length === 1 && /from=100/.test(calls[0]), "a later empty page ends paging without a second read");
}

// --- every eftsSearch caller, through the shared reader: truly empty, flaky
// empty then hits, and the index serving empty pages (offline, stubbed) ---
{
  const kit = await import("../src/tools/edgar-kit.js");
  const { probeInsiderFilings } = await import("../src/tools/insider-flow-kit.js");
  const { probeHolders, probe13G } = await import("../src/tools/ticker-pack-kit.js");
  const empty = { hits: { total: { value: 0 }, hits: [] } };
  const CTRL = { hits: { total: { value: 9000 }, hits: [{ _id: "0000000000-26-000001:x.htm", _source: { form: "10-K" } }] } };
  const ISSUER = "0000320193", OWNER = "0001214128";
  const hit = (form, ciks, id = "0001127602-26-000001:doc.htm") => ({ _id: id, _source: { form, root_forms: [form], ciks, display_names: ciks.map((c) => `BERKSHIRE HATHAWAY INC (CIK ${c})`), file_date: "2026-11-01", period_ending: "2026-09-30", adsh: id.split(":")[0] } });
  const hitsOf = (h) => ({ hits: { total: { value: 1 }, hits: [h] } });
  // [label, run(), its hits page, check on the answer with hits]
  const callers = [
    ["edgar-search", () => h("edgar-search")({ q: "going concern", forms: "10-Q", days: 90, limit: 5 }), hitsOf(hit("10-Q", [ISSUER])), (r) => r.hits.length === 1],
    ["edgar-recent-ipos (recent filings)", () => h("edgar-recent-ipos")({ form: "S-1", days: 30, limit: 5 }), hitsOf(hit("S-1", [ISSUER])), (r) => r.filings.length === 1],
    ["edgar-insider-trades", () => h("edgar-insider-trades")({ cik: ISSUER, days: 90, limit: 5 }), hitsOf(hit("4", [OWNER, ISSUER])), (r) => r.trades.length === 1],
    ["13F manager resolve", () => kit.resolveManager({ name: "Berkshire Hathaway" }), hitsOf(hit("13F-HR", ["0001067983"])), (r) => r.cik === "0001067983"],
    ["insider flow probe", () => probeInsiderFilings({ cik: ISSUER, days: 90 }), hitsOf(hit("4", [OWNER, ISSUER])), (r) => r.filings.length === 1],
    ["ticker pack 13F holders", () => probeHolders({ name: "Apple Inc.", fetchImpl: async () => { throw new Error("no fetch in this test"); } }), hitsOf(hit("13F-HR", ["0001067983"], "0000950123-26-000001:")), (r) => r != null],
    ["ticker pack 13G", () => probe13G({ cik: ISSUER, fetchText: async () => { throw new Error("no fetch in this test"); } }), hitsOf(hit("SCHEDULE 13G", [OWNER, ISSUER], "0000950123-26-000002:legacy.htm")), (r) => r != null],
  ];
  const run = async (fn) => { try { return { r: await fn() }; } catch (e) { return { e }; } };
  for (const [label, fn, page, check] of callers) {
    // Truly empty: four empty reads, the control has hits -> the empty answer stands (no 5xx).
    let n = 0, ctl = 0;
    kit._setEftsReaderForTest(async (url) => { n++; if (/forms=10-K&/.test(url) && !/q=/.test(url) && n > 4) { ctl++; return CTRL; } return empty; });
    let out = await run(fn);
    ok(ctl === 1 && !(out.e?.statusCode >= 500), `${label}: truly empty is confirmed by one control read and is not a 5xx (${out.e ? out.e.statusCode + " " + out.e.message : "answered"})`);
    // Flaky: two empty reads, then hits -> the hits, no control read.
    n = 0; ctl = 0;
    kit._setEftsReaderForTest(async (url) => { n++; if (/forms=10-K&/.test(url) && !/q=/.test(url) && n > 4) { ctl++; return CTRL; } return n <= 2 ? empty : page; });
    out = await run(fn);
    ok(!out.e && ctl === 0 && check(out.r), `${label}: empty twice then hits answers the hits without a control read (${out.e ? out.e.statusCode + " " + out.e.message : "ok"})`);
    // Index dead: every read empty, the control too -> a 503 saying the upstream search is not answering.
    n = 0;
    kit._setEftsReaderForTest(async () => { n++; return empty; });
    out = await run(fn);
    ok(out.e?.statusCode === 503 && /not answering/.test(out.e?.message || "") && n === 5, `${label}: an index serving empty pages answers a 503, never a confident empty (${out.e ? out.e.statusCode : "answered"}, ${n} reads)`);
  }
  kit._setEftsReaderForTest(null);
}

// --- deterministic validation (no network) ---
// Each row asserts the handler throws a 400 Error on bad input — we never
// touch SEC for these.
for (const [slug, args, label] of [
  ["edgar-company-lookup", {}, "edgar-company-lookup rejects missing ticker"],
  ["edgar-company-lookup", { ticker: "@@@@@@" }, "edgar-company-lookup rejects malformed ticker"],
  ["edgar-filings", {}, "edgar-filings rejects when neither ticker nor cik provided"],
  ["edgar-filings", { cik: "not-a-number" }, "edgar-filings rejects malformed cik"],
  ["edgar-company-concept", { ticker: "AAPL" }, "edgar-company-concept rejects missing tag"],
  ["edgar-company-concept", { ticker: "AAPL", tag: "Has Spaces" }, "edgar-company-concept rejects malformed tag"],
  ["edgar-company-facts", {}, "edgar-company-facts rejects when neither ticker nor cik provided"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD" }, "edgar-xbrl-frame rejects missing period"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD", period: "2023Q1" }, "edgar-xbrl-frame rejects non-CY period"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD", period: "CY2023Q5" }, "edgar-xbrl-frame rejects invalid quarter"],
  ["edgar-insider-trades", {}, "edgar-insider-trades rejects when neither ticker nor cik provided"],
  ["edgar-13f-holdings", {}, "edgar-13f-holdings rejects when neither ticker nor cik provided"],
  ["edgar-recent-ipos", { form: "@@bad@@" }, "edgar-recent-ipos rejects malformed form"],
  ["edgar-search", {}, "edgar-search rejects missing q"],
  ["edgar-search", { q: "test", locationCode: "USA" }, "edgar-search rejects non-2-letter locationCode"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of SEC rate-limiting / outages) ---
// confirmUpstream(r): when the tool's answer fails the check, ask the outside
// host the same question directly; true means the host itself answers that
// way right now (its state, tolerated and named), false means the tool is at
// fault (an assertion failure). The direct read is the only way to tell a
// hollow answer of ours from a hollow answer of theirs.
async function live(slug, args, check, label, confirmUpstream = null) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else if (confirmUpstream && await confirmUpstream(r).catch(() => false)) { liveErr++; console.warn(`warn - ${label}: the outside host answers the same way when asked directly (its state, not ours); tolerated`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

// Apple is the canonical EDGAR test case — CIK 320193, ticker AAPL — and it
// reports rich XBRL across decades, so single-test invariants are stable.
await live("edgar-company-lookup", { ticker: "AAPL" },
  (r) => r.cik === "0000320193" && r.cikInt === 320193 && /apple/i.test(r.name || ""),
  "edgar-company-lookup AAPL → CIK 0000320193");

await live("edgar-filings", { ticker: "AAPL", form: "10-K", limit: 3 },
  (r) => r.cik === "0000320193" && Array.isArray(r.filings) && r.filings.length > 0 && r.filings.every((f) => f.form === "10-K") && typeof r.filings[0].url === "string",
  "edgar-filings AAPL 10-K limit=3");

await live("edgar-filings", { cik: "320193", limit: 5 },
  (r) => r.cik === "0000320193" && Array.isArray(r.filings) && r.filings.length === 5,
  "edgar-filings via CIK (unpadded) limit=5");

await live("edgar-company-concept", { ticker: "AAPL", taxonomy: "us-gaap", tag: "Revenues" },
  (r) => r.cik === "0000320193" && r.tag === "Revenues" && r.units && Array.isArray(r.units.USD) && r.units.USD.length > 0,
  "edgar-company-concept AAPL us-gaap/Revenues");

await live("edgar-company-facts", { ticker: "AAPL" },
  (r) => r.cik === "0000320193" && r.mode === "summary" && r.taxonomies && r.taxonomies["us-gaap"] && r.taxonomies["us-gaap"].count > 0,
  "edgar-company-facts AAPL summary mode");

await live("edgar-company-facts", { ticker: "AAPL", tags: "Revenues,Assets" },
  (r) => r.mode === "full" && r.taxonomies && r.taxonomies["us-gaap"] && r.taxonomies["us-gaap"].Revenues && r.taxonomies["us-gaap"].Assets,
  "edgar-company-facts AAPL full mode (tags=Revenues,Assets)");

// XBRL frames — pick a period far enough in the past that filings are
// definitely settled. CY2022Q4 is safe.
await live("edgar-xbrl-frame", { taxonomy: "us-gaap", tag: "Revenues", unit: "USD", period: "CY2022Q4", limit: 10 },
  (r) => r.tag === "Revenues" && Array.isArray(r.data) && r.data.length > 0 && r.totalCompanies >= r.returned,
  "edgar-xbrl-frame us-gaap/Revenues/USD/CY2022Q4 limit=10");

// Instantaneous balance-sheet period (suffix "I")
await live("edgar-xbrl-frame", { taxonomy: "us-gaap", tag: "Assets", unit: "USD", period: "CY2022Q4I", limit: 5 },
  (r) => r.tag === "Assets" && Array.isArray(r.data) && r.data.length > 0,
  "edgar-xbrl-frame us-gaap/Assets/USD/CY2022Q4I (instantaneous)");

// --- Form 4 / 13F / IPO / full-text search ---
// Insider trades: Apple is a high-volume issuer; a 90-day window should always
// have multiple Form 4s. If SEC's efts.sec.gov is rate-limiting our IP this
// will return 504 — tolerated.
await live("edgar-insider-trades", { ticker: "AAPL", days: 90, limit: 5 },
  (r) => r.cik === "0000320193" && Array.isArray(r.trades) && r.trades.every((t) => t.form === "4"),
  "edgar-insider-trades AAPL days=90");

// 13F holdings: Berkshire Hathaway (CIK 1067983) is the canonical 13F filer —
// always has a recent 13F-HR with a parseable informationtable.xml.
await live("edgar-13f-holdings", { cik: "1067983", limit: 5 },
  (r) => r.cik === "0001067983" && Array.isArray(r.holdings) && r.holdings.length > 0 && r.holdings[0].valueUsd > 0 && r.holdings[0].cusip,
  "edgar-13f-holdings Berkshire top-5");

// Recent IPOs: S-1 filings in last 30 days. There are always S-1 filings —
// this should never be empty on a normal week.
// EDGAR's full-text search treats forms=S-1 as a prefix match, so the response
// includes both S-1 and S-1/A (amendments). That's the intended behavior for
// "recent IPO activity" — accept either in the form column.
await live("edgar-recent-ipos", { form: "S-1", days: 30, limit: 5 },
  (r) => r.form === "S-1" && Array.isArray(r.filings) && r.filings.every((f) => /^S-1(\/A)?$/.test(f.form || "")),
  "edgar-recent-ipos S-1 days=30");

// Full-text search: "going concern" in 10-Q filings — always has plenty of
// hits given how many small companies disclose this.
await live("edgar-search", { q: "going concern", forms: "10-Q", days: 90, limit: 5 },
  (r) => r.q === "going concern" && Array.isArray(r.hits) && r.hits.length > 0 && r.hits.every((h) => h.form === "10-Q"),
  "edgar-search 'going concern' forms=10-Q days=90",
  async (r) => {
    if (!r || !Array.isArray(r.hits) || r.hits.length !== 0 || !r.startDate || !r.endDate) return false;
    const u = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"going concern"')}&forms=10-Q&dateRange=custom&startdt=${r.startDate}&enddt=${r.endDate}`;
    const res = await fetch(u, { headers: { "User-Agent": process.env.EDGAR_USER_AGENT || "Agent402 edgar-kit test (mike@agent402.tools)", Accept: "application/json" } });
    if (!res.ok) return true; // the host refused the runner: its state
    const j = await res.json();
    return Number(j?.hits?.total?.value ?? 0) === 0;
  });

// Full-text search with company filter: searching Apple's own filings.
await live("edgar-search", { q: "revenue", ticker: "AAPL", forms: "10-K", limit: 3 },
  (r) => r.q === "revenue" && r.ciks === "0000320193" && Array.isArray(r.hits),
  "edgar-search 'revenue' ticker=AAPL forms=10-K");

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("edgar-kit: FAILED"); process.exit(1); }
console.log("edgar-kit: OK");
