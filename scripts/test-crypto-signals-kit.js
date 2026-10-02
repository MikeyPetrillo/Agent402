// scripts/test-crypto-signals-kit.js
// Offline tests for src/tools/crypto-signals-kit.js. No network: globalThis.fetch
// is replaced with a router that answers each upstream (the outlet RSS/Atom
// feeds, Hyperliquid info) from fixtures, so the test pins
//   - the catalog envelope (3 tools, prices, discovery),
//   - input validation (400s) before any egress,
//   - the RSS + Atom parser on realistic fixtures (CDATA, entities, utm links,
//     namespaced dates, self-closing tags), a malformed feed, an HTML page,
//   - news aggregation: keyword filter (all/any), hours window, URL dedupe
//     across feeds, newest-first order, per-source stats, errors[] for one
//     failing feed, 502 only when every feed fails, the 5-minute cache,
//   - indicator math against hand-computed fixtures (SMA, EMA, RSI, MACD,
//     Bollinger, ATR, VWAP) and the summary/notes assembly,
//   - market pulse arithmetic (breadth, median, volume-weighted change,
//     totals, minVolumeUsd filter, funding extremes),
//   - upstream 5xx -> 502, 429 -> 503, transport timeout -> 504, and the
//     "unknown coin" shape Hyperliquid really returns (500 "null") -> 422.
// Live coverage is the catalog's answers-its-own-example sweep (test-all.js).

import {
  CRYPTO_SIGNALS_TOOLS, NEWS_SOURCES, parseFeed, sma, ema, rsi, macd, bollinger, atr, vwap,
  computeIndicators, marketPulse, __test,
} from "../src/tools/crypto-signals-kit.js";

const h = (slug) => CRYPTO_SIGNALS_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) <= eps;
async function throws(promise, status, label, msgRe) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!msgRe || msgRe.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${msgRe ? ` /${msgRe.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
const NOW = Date.now();
const rfc = (msAgo) => new Date(NOW - msAgo).toUTCString();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;

// RSS 2.0 in the shape the outlets really serve: CDATA titles, utm-tagged
// link, HTML + entities in description, dc:creator, a self-closing
// content:encoded, one item older than any window we ask for.
const RSS_A = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
<channel><title>Outlet A</title><link>https://a.example</link>
<item>
  <title><![CDATA[Bitcoin ETF inflows resume as price holds $77K]]></title>
  <link><![CDATA[https://a.example/news/btc-etf?utm_source=rss_feed&utm_medium=rss]]></link>
  <guid isPermaLink="false">a-1</guid>
  <pubDate>${rfc(1 * H)}</pubDate>
  <description><![CDATA[<p style="float:right"><img src="https://a.example/x.jpg"></p><p>Spot ETF inflows returned for a third day &amp; funding stayed neutral &#169; traders watch $80K.</p>]]></description>
  <dc:creator>Reporter</dc:creator>
  <content:encoded/>
</item>
<item>
  <title>Ethereum staking queue clears</title>
  <link>https://a.example/news/eth-staking</link>
  <pubDate>${rfc(3 * H)}</pubDate>
  <description>Validators exit &lt;b&gt;faster&lt;/b&gt; this week.</description>
</item>
<item>
  <title>Old story about bitcoin</title>
  <link>https://a.example/news/old</link>
  <pubDate>${rfc(400 * H)}</pubDate>
  <description>Too old for any window.</description>
</item>
<item>
  <title>No link here</title>
  <pubDate>${rfc(1 * H)}</pubDate>
</item>
</channel></rss>`;

// Atom with rel-less and rel="alternate" links, type="html" CDATA, published
// + updated, and the SAME story as A's first item under a different utm tag
// (dedupe must collapse it).
const ATOM_B = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://b.example</id><title>Outlet B</title>
  <entry>
    <title type="html"><![CDATA[Solana activates shorter slots]]></title>
    <id>https://b.example/sol-slots</id>
    <link rel="self" href="https://b.example/feed/sol-slots"/>
    <link rel="alternate" href="https://b.example/news/sol-slots"/>
    <updated>${iso(0.5 * H)}</updated>
    <published>${iso(2 * H)}</published>
    <summary type="html"><![CDATA[The first cut since inception shortens the block window.]]></summary>
    <author><name>B Desk</name></author>
  </entry>
  <entry>
    <title>Bitcoin ETF inflows resume as price holds $77K</title>
    <id>dup</id>
    <link href="https://a.example/news/btc-etf?utm_source=other&utm_campaign=x"/>
    <published>${iso(1 * H)}</published>
    <content type="html"><![CDATA[Syndicated copy of the same story.]]></content>
  </entry>
</feed>`;

// RSS with the outlet name + title prepended to the description (the
// Bitcoin Magazine shape) and a dc:date instead of pubDate.
const RSS_C = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title>Miners add hashrate</title><link>https://c.example/hash</link><dc:date>${iso(4 * H)}</dc:date>
<description><![CDATA[<p><a href="https://c.example">Outlet C</a><br><a href="https://c.example/hash">Miners add hashrate</a></p><p>Network hashrate set a new high this week.</p>]]></description></item>
</channel></rss>`;

const HTML_PAGE = "<!DOCTYPE html><html><head><title>Not found</title></head><body>nope</body></html>";
const MALFORMED = "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><item><title>Broken";

const META = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }, { name: "kPEPE", szDecimals: 0 }, { name: "OLD", szDecimals: 1, isDelisted: true }] };
const CTXS = [
  { funding: "0.0000125", openInterest: "36000", prevDayPx: "76968.0", dayNtlVlm: "4679441788.67", markPx: "77267.0" },
  { funding: "-0.00005", openInterest: "754447", prevDayPx: "2380.3", dayNtlVlm: "3396726206.45", markPx: "2429.3" },
  { funding: "0.0003", openInterest: "1000000000", prevDayPx: "0.004", dayNtlVlm: "500000", markPx: "0.00404" },
  { funding: "0", openInterest: "0", prevDayPx: "1", dayNtlVlm: "0", markPx: "1" },
];
// 60 hourly candles: a gentle ramp with a wobble so every indicator has data.
const CANDLES = Array.from({ length: 60 }, (_, k) => {
  const base = 100 + k * 0.5 + (k % 5) * 0.3;
  return { t: NOW - (60 - k) * H, T: NOW - (59 - k) * H - 1, s: "BTC", i: "1h", o: String(base - 0.2), c: String(base), h: String(base + 0.5), l: String(base - 0.6), v: String(10 + (k % 3)), n: 100 };
});

// ----------------------------------------------------------------------------
// Fetch router
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let mode = "ok";
const calls = [];
const res = (status, body) => ({ status, ok: status < 400, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const feedUrlOf = (id) => NEWS_SOURCES[id].url;
const FEED_MAP = {
  [feedUrlOf("coindesk")]: RSS_A,
  [feedUrlOf("blockworks")]: ATOM_B,
  [feedUrlOf("bitcoinmagazine")]: RSS_C,
  [feedUrlOf("cointelegraph")]: HTML_PAGE,      // not a feed at all
  [feedUrlOf("decrypt")]: MALFORMED,            // truncated XML
  [feedUrlOf("theblock")]: "__500__",
  [feedUrlOf("thedefiant")]: "__timeout__",
  [feedUrlOf("cryptoslate")]: RSS_C.replace("c.example", "d.example").replace("Miners add hashrate", "Fresh item from D"),
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body || null });
  ok(opts.signal instanceof AbortSignal, `egress carries an AbortSignal (${u.slice(0, 40)})`);
  ok(String(opts.headers?.["User-Agent"] || "").includes("Agent402"), "egress carries the Agent402 User-Agent");
  if (mode === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
  if (mode === "http500") return res(500, "Internal Error");
  if (mode === "http429") return res(429, "slow down");
  if (u in FEED_MAP) {
    if (mode === "feeds-all-fail") return res(503, "<html>down</html>");
    const body = FEED_MAP[u];
    if (body === "__500__") return res(500, "<html>boom</html>");
    if (body === "__timeout__") { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
    return res(200, body);
  }
  if (u === __test.HL_INFO) {
    const body = JSON.parse(opts.body);
    if (mode === "hl-unknown-500") return res(500, "null");
    switch (body.type) {
      case "meta": return res(200, META);
      case "metaAndAssetCtxs": return res(200, [META, CTXS]);
      case "candleSnapshot": return res(200, CANDLES);
      default: return res(422, "Failed to deserialize the JSON body into the target type");
    }
  }
  throw new Error(`unexpected egress in test: ${u}`);
};

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(CRYPTO_SIGNALS_TOOLS.length === 3, "3 tools exported");
const want = { "crypto-news": "$0.002", "crypto-indicators": "$0.002", "crypto-market-pulse": "$0.004" };
for (const t of CRYPTO_SIGNALS_TOOLS) {
  ok(want[t.slug] === t.price, `${t.slug} priced ${t.price}`);
  ok(t.category === "crypto" && /^POST \/api\//.test(t.route), `${t.slug} route/category`);
  ok(t.discovery?.bodyType === "json" && t.discovery.input && t.discovery.inputSchema?.properties && t.discovery.output?.example, `${t.slug} discovery complete`);
  ok(typeof t.handler === "function" && Array.isArray(t.tags) && t.tags.length >= 4, `${t.slug} handler + tags`);
  ok(!/—/.test(t.description), `${t.slug} description has no em dash`);
}
ok(Object.keys(NEWS_SOURCES).length >= 5 && Object.keys(NEWS_SOURCES).length <= 8, `${Object.keys(NEWS_SOURCES).length} news sources (5-8)`);

// ----------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------
{
  const a = parseFeed(RSS_A);
  ok(a.length === 3, `RSS: 3 items parsed (the linkless one skipped), got ${a.length}`);
  ok(a[0].title === "Bitcoin ETF inflows resume as price holds $77K", "RSS: CDATA title unwrapped");
  ok(a[0].url === "https://a.example/news/btc-etf", `RSS: utm params stripped from link (${a[0].url})`);
  ok(a[0].summary === "Spot ETF inflows returned for a third day & funding stayed neutral \u00a9 traders watch $80K.", `RSS: html stripped + entities decoded (${a[0].summary})`);
  ok(a[0].publishedAt && Math.abs(Date.parse(a[0].publishedAt) - (NOW - H)) < 1000, "RSS: pubDate -> ISO");
  ok(a[1].summary === "Validators exit faster this week.", `RSS: escaped html in description stripped (${a[1].summary})`);
  const b = parseFeed(ATOM_B);
  ok(b.length === 2, "Atom: 2 entries");
  ok(b[0].url === "https://b.example/news/sol-slots", `Atom: rel=alternate link preferred over rel=self (${b[0].url})`);
  ok(b[0].publishedAt && Math.abs(Date.parse(b[0].publishedAt) - (NOW - 2 * H)) < 1000, "Atom: published preferred over updated");
  ok(b[1].url === "https://a.example/news/btc-etf", "Atom: href-only link canonicalized");
  const c = parseFeed(RSS_C, "Outlet C");
  ok(c.length === 1 && c[0].publishedAt && c[0].summary === "Network hashrate set a new high this week.", `RSS: dc:date honoured + outlet/title prefix stripped (${c[0]?.summary})`);
  let threw = false;
  try { parseFeed(HTML_PAGE); } catch { threw = true; }
  ok(threw, "HTML page is rejected as not-a-feed");
  ok(parseFeed(MALFORMED).length === 0, "truncated feed parses to zero items (no throw, no crash)");
  const longText = "word ".repeat(200);
  const lf = parseFeed(`<rss version="2.0"><channel><item><title>T</title><link>https://x.example/1</link><pubDate>${rfc(0)}</pubDate><description>${longText}</description></item></channel></rss>`);
  ok(lf[0].summary.length <= 300 && !lf[0].summary.endsWith(" ") && lf[0].summary.length > 250, `summary capped at 300 chars on a word boundary (${lf[0].summary.length})`);
  ok(__test.canonicalUrl("https://x.example/a?utm_source=rss&id=5#frag") === "https://x.example/a?id=5", "canonicalUrl keeps non-tracking params, drops fragment");
  ok(__test.canonicalUrl("javascript:alert(1)") === null && __test.canonicalUrl("not a url") === null, "canonicalUrl refuses non-http");
  ok(__test.cleanText("a\u0000b &#x41;&amp;&nbsp;<i>c</i>") === "ab A& c", `cleanText strips control chars + tags, decodes entities (${JSON.stringify(__test.cleanText("a\u0000b &#x41;&amp;&nbsp;<i>c</i>"))})`);
}

// ----------------------------------------------------------------------------
// crypto-news handler
// ----------------------------------------------------------------------------
{
  __test.resetCaches();
  await throws(h("crypto-news")({ limit: 51 }), 400, "limit 51 -> 400");
  await throws(h("crypto-news")({ hours: 169 }), 400, "hours 169 -> 400");
  await throws(h("crypto-news")({ sources: ["nope"] }), 400, "unknown source -> 400", /valid:/);
  await throws(h("crypto-news")({ match: "fuzzy" }), 400, "bad match -> 400");
  await throws(h("crypto-news")({ query: "x".repeat(201) }), 400, "query too long -> 400");
  await throws(h("crypto-news")({ query: 42 }), 400, "non-string query -> 400");
  ok(calls.length === 0, "validation 400s happen before any egress");

  const r = await h("crypto-news")({ hours: 48 });
  ok(r.source === "rss" && typeof r.fetchedAt === "string", "news envelope source + fetchedAt");
  ok(calls.filter((c) => c.url in FEED_MAP).length === 8, "all 8 feeds fetched in parallel on a cold cache");
  const errIds = r.errors.map((e) => e.source).sort();
  ok(errIds.join() === "cointelegraph,theblock,thedefiant", `failing feeds listed in errors[]; a truncated feed is an empty feed, not an error (${errIds.join(",")})`);
  ok(r.sources.find((s) => s.id === "decrypt")?.items === 0 && !r.sources.find((s) => s.id === "decrypt")?.error, "truncated feed reports 0 items without an error entry");
  ok(r.errors.every((e) => !/boom|down|html/i.test(e.error)), "upstream error bodies never relayed in errors[]");
  ok(r.errors.some((e) => e.source === "theblock" && /HTTP 500/.test(e.error)), "HTTP 500 feed reported as HTTP 500");
  ok(r.errors.some((e) => e.source === "thedefiant" && /timed out/.test(e.error)), "timed-out feed reported as timed out");
  ok(r.errors.some((e) => e.source === "cointelegraph" && /not a valid RSS\/Atom/.test(e.error)), "HTML page reported as not-a-feed");
  const urls = r.items.map((i) => i.url);
  ok(new Set(urls).size === urls.length && urls.filter((u) => u === "https://a.example/news/btc-etf").length === 1, "same story from two feeds deduped by canonical URL");
  ok(r.items.length === 5 && r.totalMatched === 5, `5 unique in-window items across feeds (got ${r.items.length}/${r.totalMatched})`);
  ok(!urls.some((u) => u === "https://a.example/news/old"), "item older than the hours window excluded");
  const times = r.items.map((i) => Date.parse(i.publishedAt));
  ok(times.every((t, k) => k === 0 || times[k - 1] >= t), "items sorted newest first");
  ok(r.items[0].source === "coindesk" && r.items[0].sourceName === "CoinDesk" && r.items[0].title && r.items[0].summary !== undefined, "item shape: title/url/source/sourceName/publishedAt/summary");
  ok(Object.keys(r.items[0]).join(",") === "title,url,source,sourceName,publishedAt,summary", "item keys exactly as documented");
  const cd = r.sources.find((s) => s.id === "coindesk");
  ok(cd && cd.items === 3 && cd.matched === 2 && cd.cached === false, `per-source stats (coindesk items=${cd?.items} matched=${cd?.matched})`);
  const bw = r.sources.find((s) => s.id === "blockworks");
  ok(bw && bw.matched === 1, "dedupe counted against the later feed (blockworks matched=1)");

  const before = calls.length;
  const r2 = await h("crypto-news")({ query: "bitcoin etf", limit: 10 });
  ok(calls.length === before, "second call within 5 minutes makes no egress (cache)");
  ok(r2.sources.every((s) => s.cached === true), "sources flagged cached:true on a warm cache");
  ok(r2.count === 1 && r2.items[0].url === "https://a.example/news/btc-etf" && r2.query === "bitcoin etf", `match=all keyword filter (${r2.count})`);
  const r3 = await h("crypto-news")({ query: "bitcoin solana", match: "any", limit: 10 });
  ok(r3.count === 2, `match=any keyword filter (${r3.count})`);
  const r4 = await h("crypto-news")({ query: "zzzqqq" });
  ok(r4.count === 0 && Array.isArray(r4.items), "no match -> 200 with empty items, not an error");
  const r5 = await h("crypto-news")({ sources: "coindesk,blockworks", hours: 2 });
  ok(r5.sources.length === 2 && r5.items.every((i) => ["coindesk", "blockworks"].includes(i.source)), "sources as CSV string restricts the feed set");
  ok(r5.items.every((i) => Date.parse(i.publishedAt) >= NOW - 2 * H - 1000), "hours=2 window applied");
  const r6 = await h("crypto-news")({ limit: 2 });
  ok(r6.count === 2 && r6.totalMatched === 5, "limit caps items, totalMatched reports the full count");

  // Every feed fails -> 502 (the ones that failed are still negatively cached for 60s, so use fresh cache)
  __test.resetCaches();
  mode = "feeds-all-fail";
  await throws(h("crypto-news")({}), 502, "every feed failing -> 502", /Every requested news feed failed/);
  mode = "ok";
  // failure is cached briefly too (no re-hammer)
  const b2 = calls.length;
  await throws(h("crypto-news")({}), 502, "failed feeds negatively cached (still 502, no refetch)");
  ok(calls.length === b2, "no refetch inside the failure cache window");
  __test.resetCaches();
}

// ----------------------------------------------------------------------------
// Indicator math (hand-computed)
// ----------------------------------------------------------------------------
{
  const s = sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  ok(s[1] === null && s[2] === 2 && s[9] === 9, "SMA(3): null before window, 2 at idx2, 9 at the end");
  const e = ema([1, 2, 3, 4, 5], 3);
  ok(e[1] === null && e[2] === 2 && e[3] === 3 && e[4] === 4, `EMA(3) SMA-seeded: [_,_,2,3,4] got ${JSON.stringify(e)}`);
  ok(ema([1, 2], 3).every((v) => v === null), "EMA with too few values is all null");
  const r = rsi([10, 11, 10, 12], 2);
  ok(r[1] === null && near(r[2], 50) && near(r[3], 83.333333, 1e-5), `RSI(2) Wilder: [_,_,50,83.33] got ${JSON.stringify(r)}`);
  const up = rsi(Array.from({ length: 20 }, (_, k) => k + 1), 14);
  ok(near(up[19], 100), "RSI of a monotone rise = 100");
  const down = rsi(Array.from({ length: 20 }, (_, k) => 20 - k), 14);
  ok(near(down[19], 0), "RSI of a monotone fall = 0");
  ok(rsi([1, 2, 3], 14).every((v) => v === null), "RSI with too few values is all null");
  const m = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
  ok(near(m.line[5], 0.5) && near(m.signal[5], 0.5) && near(m.hist[5], 0) && m.line[1] === null && m.signal[2] === null, `MACD(2,3,2) on a ramp: line 0.5, signal 0.5, hist 0 (got ${m.line[5]}, ${m.signal[5]}, ${m.hist[5]})`);
  const flat = macd(new Array(40).fill(50), 12, 26, 9);
  ok(near(flat.line[39], 0) && near(flat.signal[39], 0) && near(flat.hist[39], 0) && flat.signal[32] === null && flat.signal[33] !== null, "MACD(12,26,9) on a flat series is 0 and its signal starts at idx 33 (34 candles)");
  const b = bollinger([1, 2, 3, 4, 5], 3, 2);
  ok(near(b.middle[4], 4) && near(b.upper[4], 4 + 2 * Math.sqrt(2 / 3)) && near(b.lower[4], 4 - 2 * Math.sqrt(2 / 3)) && b.upper[1] === null, `Bollinger(3,2) population sd: mid 4, upper ${b.upper[4]}`);
  const a = atr([{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 9, c: 11 }, { h: 12, l: 10, c: 11 }], 2);
  ok(a[0] === null && a[1] === null && near(a[2], 2.5) && near(a[3], 2.25), `ATR(2) Wilder: [_,_,2.5,2.25] got ${JSON.stringify(a)}`);
  const v = vwap([{ h: 10, l: 8, c: 9, v: 1 }, { h: 12, l: 10, c: 11, v: 3 }]);
  ok(near(v[0], 9) && near(v[1], 10.5), `VWAP cumulative: [9, 10.5] got ${JSON.stringify(v)}`);
  ok(vwap([{ h: 1, l: 1, c: 1, v: 0 }])[0] === null, "VWAP with zero volume is null, not NaN");

  // Assembly on the 60-candle fixture: every indicator present, values agree
  // with the primitives, summary derived from the same arrays.
  const candles = CANDLES.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }));
  const closes = candles.map((c) => c.c);
  const out = computeIndicators(candles, new Set(["rsi", "macd", "ema", "sma", "bollinger", "atr", "vwap"]), 5);
  ok(out.candles === 60 && out.window.from === new Date(candles[0].t).toISOString() && out.lastClose === closes[59], "assembly: candles/window/lastClose");
  ok(near(out.indicators.rsi.value, rsi(closes, 14)[59], 1e-4) && out.indicators.rsi.series.length === 5, "assembly: rsi value + 5 series points");
  ok(near(out.indicators.macd.histogram, macd(closes)[`hist`][59], 1e-6) && out.indicators.macd.series[4].macd != null, "assembly: macd hist matches primitive");
  ok(near(out.indicators.ema.ema20, ema(closes, 20)[59], 1e-6) && near(out.indicators.ema.ema50, ema(closes, 50)[59], 1e-6) && out.indicators.ema.ema200 === null, "assembly: ema20/50 present, ema200 null on 60 candles");
  ok(out.notes && out.notes.some((n) => /ema200 needs at least 200/.test(n)), "assembly: notes explain the missing ema200");
  ok(near(out.indicators.sma.sma20, sma(closes, 20)[59], 1e-6) && near(out.indicators.sma.sma50, sma(closes, 50)[59], 1e-6), "assembly: sma20/50");
  const bb = bollinger(closes, 20, 2);
  ok(near(out.indicators.bollinger.upper, bb.upper[59], 1e-6) && near(out.indicators.bollinger.percentB, (closes[59] - bb.lower[59]) / (bb.upper[59] - bb.lower[59]), 1e-3), "assembly: bollinger upper + %B");
  ok(near(out.indicators.atr.value, atr(candles, 14)[59], 1e-6) && out.indicators.atr.pctOfClose > 0, "assembly: atr + pct of close");
  ok(near(out.indicators.vwap.value, vwap(candles)[59], 1e-6), "assembly: vwap");
  ok(out.summary.trend === (closes[59] > ema(closes, 50)[59] ? "above" : "below"), `assembly: trend vs EMA50 (${out.summary.trend})`);
  ok(["oversold", "neutral", "overbought"].includes(out.summary.rsiZone), "assembly: rsiZone");
  const hs = macd(closes).hist;
  const expectCross = hs[58] <= 0 && hs[59] > 0 ? "bullish" : hs[58] >= 0 && hs[59] < 0 ? "bearish" : "none";
  ok(out.summary.macdCross === expectCross && out.summary.macdHistogram === (hs[59] > 0 ? "positive" : hs[59] < 0 ? "negative" : "flat"), `assembly: macdCross/histogram from the last two bars (${out.summary.macdCross}, ${out.summary.macdHistogram})`);
  ok(/EMA50/.test(out.summary.text) && /RSI/.test(out.summary.text) && /MACD/.test(out.summary.text), "assembly: summary text is the fixed template");
  const sub = computeIndicators(candles, new Set(["rsi"]), 3);
  ok(Object.keys(sub.indicators).join() === "rsi" && sub.indicators.rsi.series.length === 3 && sub.summary.trend !== "unknown", "assembly: indicator subset still yields a full summary");
  const tiny = computeIndicators(candles.slice(0, 10), new Set(["rsi", "macd", "ema"]), 3);
  ok(tiny.indicators.rsi.value === null && tiny.indicators.macd.value === null && tiny.summary.trend === "unknown" && tiny.summary.macdCross === "unknown" && tiny.notes.length >= 3, "assembly: too few candles -> nulls + notes + unknown summary, never NaN");
  // Cross: a V-shaped series crosses from negative to positive histogram at
  // some bar; cut the window right there and the summary must say bullish,
  // one bar earlier it must say none, and the mirror image must say bearish.
  const vShape = Array.from({ length: 80 }, (_, k) => (k < 40 ? 100 - k : 60 + (k - 40) * 1.5));
  const vh = macd(vShape).hist;
  const flip = vh.findIndex((v, k) => k > 0 && vh[k - 1] != null && vh[k - 1] <= 0 && v > 0);
  ok(flip > 0, `V-shape fixture has a bullish histogram flip (idx ${flip})`);
  const mk = (arr) => arr.map((c, k) => ({ t: NOW - (arr.length - k) * H, o: c, h: c + 1, l: c - 1, c, v: 1 }));
  ok(computeIndicators(mk(vShape.slice(0, flip + 1)), new Set(["macd"]), 3).summary.macdCross === "bullish", "assembly: histogram sign flip on the last bar reads as bullish cross");
  ok(computeIndicators(mk(vShape.slice(0, flip)), new Set(["macd"]), 3).summary.macdCross === "none", "assembly: one bar before the flip reads as no cross");
  const mirror = vShape.map((c) => 200 - c);
  const mh = macd(mirror).hist;
  const mflip = mh.findIndex((v, k) => k > 0 && mh[k - 1] != null && mh[k - 1] >= 0 && v < 0);
  ok(mflip > 0 && computeIndicators(mk(mirror.slice(0, mflip + 1)), new Set(["macd"]), 3).summary.macdCross === "bearish", "assembly: mirrored flip reads as bearish cross");
}

// ----------------------------------------------------------------------------
// crypto-indicators handler
// ----------------------------------------------------------------------------
{
  __test.resetCaches();
  calls.length = 0;
  await throws(h("crypto-indicators")({}), 400, "missing coin -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", interval: "7m" }), 400, "bad interval -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", limit: 501 }), 400, "limit 501 -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", points: 101 }), 400, "points 101 -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", indicators: ["rsi", "stoch"] }), 400, "unknown indicator -> 400", /valid:/);
  await throws(h("crypto-indicators")({ coin: "B T C" }), 400, "coin with spaces -> 400");
  ok(calls.length === 0, "indicator validation 400s happen before any egress");
  const r = await h("crypto-indicators")({ coin: "btc", interval: "1h", limit: 60, points: 4, indicators: "rsi,macd,vwap" });
  ok(r.source === "hyperliquid" && r.coin === "BTC" && r.interval === "1h" && r.candles === 60, "indicators: coin resolved case-insensitively, 60 candles");
  ok(Object.keys(r.indicators).sort().join() === "macd,rsi,vwap" && r.indicators.rsi.series.length === 4, "indicators: CSV subset honoured, 4 points");
  ok(r.summary && r.summary.trend !== "unknown" && typeof r.fetchedAt === "string", "indicators: summary + fetchedAt");
  ok(r.ohlcv === undefined, "indicators: no OHLCV rows unless asked");
  await throws(h("crypto-indicators")({ coin: "BTC", ohlcv: 101 }), 400, "ohlcv 101 -> 400");
  const callsBefore = calls.length;
  const ro = await h("crypto-indicators")({ coin: "BTC", interval: "1h", limit: 60, points: 1, ohlcv: 3 });
  const lastBar = ro.ohlcv?.[2];
  ok(Array.isArray(ro.ohlcv) && ro.ohlcv.length === 3 && lastBar.close === ro.lastClose && ["open", "high", "low", "close", "volume"].every((k) => typeof lastBar[k] === "number") && !Number.isNaN(Date.parse(lastBar.t)),
    `indicators: ohlcv returns the last 3 bars, newest last, closing at lastClose (${JSON.stringify(lastBar)})`);
  ok(calls.filter((c) => c.body && JSON.parse(c.body).type === "candleSnapshot").length === calls.slice(0, callsBefore).filter((c) => c.body && JSON.parse(c.body).type === "candleSnapshot").length + 1, "indicators: ohlcv rides the same single candle read");
  const snap = calls.find((c) => c.body && JSON.parse(c.body).type === "candleSnapshot");
  const req = JSON.parse(snap.body).req;
  ok(req.coin === "BTC" && req.interval === "1h" && req.endTime - req.startTime === 60 * H, "indicators: candleSnapshot window = limit x interval");
  await throws(h("crypto-indicators")({ coin: "ZZZZ" }), 422, "unknown coin (not in meta) -> 422", /Unknown perp market/);
  mode = "hl-unknown-500";
  __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 422, "HL 500 \"null\" -> 422, not 502");
  mode = "http500"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 502, "HL 500 -> 502");
  mode = "http429"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 503, "HL 429 -> 503");
  mode = "timeout"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 504, "HL timeout -> 504");
  mode = "ok"; __test.resetCaches();
}

// ----------------------------------------------------------------------------
// market pulse
// ----------------------------------------------------------------------------
{
  const rows = [
    { coin: "BTC", markPx: 100, change24hPct: 1, fundingHourly: 0.00001, fundingAprPct: 8.76, openInterestUsd: 1000, volume24hUsd: 5000 },
    { coin: "ETH", markPx: 10, change24hPct: -2, fundingHourly: -0.00002, fundingAprPct: -17.52, openInterestUsd: 500, volume24hUsd: 3000 },
    { coin: "SOL", markPx: 5, change24hPct: 4, fundingHourly: 0.00005, fundingAprPct: 43.8, openInterestUsd: 200, volume24hUsd: 2000 },
    { coin: "DOGE", markPx: 0.1, change24hPct: 0, fundingHourly: 0, fundingAprPct: 0, openInterestUsd: 100, volume24hUsd: 1000 },
    { coin: "TINY", markPx: 1, change24hPct: 50, fundingHourly: 0.001, fundingAprPct: 876, openInterestUsd: 10, volume24hUsd: 10 },
    { coin: "NOPX", markPx: null, change24hPct: null, fundingHourly: null, fundingAprPct: null, openInterestUsd: null, volume24hUsd: 0 },
  ];
  const p = marketPulse(rows, { limit: 2, minVolumeUsd: 500 });
  ok(p.markets.listed === 5 && p.markets.counted === 4 && p.markets.minVolumeUsd === 500, `pulse: listed/counted (${p.markets.listed}/${p.markets.counted})`);
  ok(p.breadth.advancers === 2 && p.breadth.decliners === 1 && p.breadth.unchanged === 1 && p.breadth.advancersPct === 50, "pulse: breadth counts exclude the illiquid market");
  ok(p.breadth.meanChange24hPct === 0.75 && p.breadth.medianChange24hPct === 0.5, `pulse: mean 0.75 / median 0.5 (${p.breadth.meanChange24hPct}/${p.breadth.medianChange24hPct})`);
  ok(near(p.breadth.volumeWeightedChange24hPct, (1 * 5000 - 2 * 3000 + 4 * 2000 + 0) / 11000, 1e-4), "pulse: volume-weighted change");
  ok(p.totals.openInterestUsd === 1810 && p.totals.volume24hUsd === 11010 && near(p.totals.top5VolumeSharePct, 100, 1e-6), "pulse: totals over ALL priced markets");
  ok(p.funding.positive === 2 && p.funding.negative === 1 && p.funding.zero === 1, "pulse: funding breadth");
  ok(p.majors.BTC.markPx === 100 && p.majors.ETH.change24hPct === -2, "pulse: majors");
  ok(p.topByVolume.map((r) => r.coin).join() === "BTC,ETH", "pulse: topByVolume limit 2");
  ok(p.topGainers.map((r) => r.coin).join() === "SOL,BTC" && p.topLosers.map((r) => r.coin).join() === "ETH,DOGE", `pulse: gainers/losers exclude TINY (${p.topGainers.map((r) => r.coin)})`);
  ok(p.highestFunding[0].coin === "SOL" && p.lowestFunding[0].coin === "ETH" && p.highestFunding[0].fundingHourly === 0.00005, "pulse: funding extremes");
  const all = marketPulse(rows, { limit: 20, minVolumeUsd: 0 });
  ok(all.markets.counted === 5 && all.topGainers[0].coin === "TINY", "pulse: minVolumeUsd 0 admits every priced market");

  await throws(h("crypto-market-pulse")({ limit: 21 }), 400, "pulse limit 21 -> 400");
  await throws(h("crypto-market-pulse")({ minVolumeUsd: -1 }), 400, "pulse negative minVolumeUsd -> 400");
  const live = await h("crypto-market-pulse")({ limit: 5 });
  ok(live.source === "hyperliquid" && live.markets.listed === 3 && live.breadth.advancers === 2 && live.breadth.decliners === 0, `pulse handler on fixture (listed ${live.markets.listed}, counted ${live.markets.counted})`);
  ok(live.majors.BTC.markPx === 77267 && live.topByVolume[0].coin === "BTC" && typeof live.fetchedAt === "string", "pulse handler: majors + leaders + fetchedAt");
  mode = "http500";
  await throws(h("crypto-market-pulse")({}), 502, "pulse HL 500 -> 502");
  mode = "timeout";
  await throws(h("crypto-market-pulse")({}), 504, "pulse HL timeout -> 504");
  mode = "ok";
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
