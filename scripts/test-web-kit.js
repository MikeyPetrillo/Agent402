// scripts/test-web-kit.js
// Tests for src/tools/web-kit.js. Pattern matches scripts/test-enrich-kit.js:
//   • Catalog envelope + input validation + pure parsing always run (offline).
//   • Live upstream calls (archive.org, hnrss.org, youtu.be) are opt-in via
//     WEB_LIVE_TEST=1.

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { WEB_TOOLS } from "../src/tools/web-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

const h = (slug) => WEB_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(WEB_TOOLS.length === 3, `3 tools exported (got ${WEB_TOOLS.length})`);
const SPEC = {
  "archive-snapshot": { price: "$0.003", category: "web" },
  "feed-parse": { price: "$0.004", category: "web" },
  "unshorten-url": { price: "$0.002", category: "web" },
};
for (const t of WEB_TOOLS) {
  const spec = SPEC[t.slug];
  ok(!!spec, `${t.slug}: is a shortlist slug`);
  if (!spec) continue;
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug} route`);
  ok(t.price === spec.price, `${t.slug}: priced ${spec.price} (got ${t.price})`);
  ok(t.category === spec.category, `${t.slug}: category=${spec.category} (got ${t.category})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.bodyType === "json" && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  // All three reach the network — must be wallet-only (PoW can't farm egress).
  ok(WALLET_ONLY_SLUGS.has(t.slug), `${t.slug}: in WALLET_ONLY_SLUGS`);
}

// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Input validation — deterministic, no network
// ----------------------------------------------------------------------------
// Shared url gate (all three tools)
for (const slug of ["archive-snapshot", "feed-parse", "unshorten-url"]) {
  await throws(h(slug)({}), 400, `${slug}: missing url`);
  await throws(h(slug)({ url: "   " }), 400, `${slug}: blank url`);
  await throws(h(slug)({ url: "not a url" }), 400, `${slug}: unparseable url`);
  await throws(h(slug)({ url: "ftp://example.com/x" }), 400, `${slug}: non-http scheme`);
  await throws(h(slug)({ url: "https://example.com/" + "a".repeat(2100) }), 400, `${slug}: url over 2048 chars`);
}

// archive-snapshot timestamp validation
await throws(h("archive-snapshot")({ url: "https://example.com", timestamp: "202" }), 400, "archive-snapshot: timestamp too short");
await throws(h("archive-snapshot")({ url: "https://example.com", timestamp: "2020-01-01" }), 400, "archive-snapshot: non-digit timestamp");
await throws(h("archive-snapshot")({ url: "https://example.com", timestamp: "202001011230590" }), 400, "archive-snapshot: timestamp too long");

// SSRF: caller-URL tools must reject private/loopback targets before any fetch
await throws(h("feed-parse")({ url: "http://127.0.0.1/feed.xml" }), 400, "feed-parse: loopback rejected");
await throws(h("feed-parse")({ url: "http://169.254.169.254/latest/meta-data" }), 400, "feed-parse: metadata IP rejected");
await throws(h("feed-parse")({ url: "http://[::1]/feed.xml" }), 400, "feed-parse: IPv6 loopback rejected");
await throws(h("unshorten-url")({ url: "http://127.0.0.1/x" }), 400, "unshorten-url: loopback rejected");
await throws(h("unshorten-url")({ url: "http://10.0.0.8/x" }), 400, "unshorten-url: RFC1918 rejected");
await throws(h("unshorten-url")({ url: "http://169.254.169.254/x" }), 400, "unshorten-url: metadata IP rejected");

// ----------------------------------------------------------------------------
// Live upstream checks — opt-in
// ----------------------------------------------------------------------------
async function live(label, fn, check) {
  try {
    const r = await fn();
    if (check(r)) { liveOk++; console.log(`live ok - ${label}: ${JSON.stringify(r).slice(0, 160)}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 300)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

if (process.env.WEB_LIVE_TEST === "1") {
  await live("archive-snapshot example.com",
    () => h("archive-snapshot")({ url: "https://example.com" }),
    (r) => r.available === true && typeof r.snapshot?.url === "string" && /web\.archive\.org/.test(r.snapshot.url));

  await live("archive-snapshot example.com @2020",
    () => h("archive-snapshot")({ url: "https://example.com", timestamp: "20200101" }),
    (r) => r.requestedTimestamp === "20200101" && r.available === true && String(r.snapshot?.timestamp).startsWith("20"));

  await live("feed-parse hnrss.org/frontpage (RSS 2.0)",
    () => h("feed-parse")({ url: "https://hnrss.org/frontpage", limit: 5 }),
    (r) => r.format === "rss2" && typeof r.title === "string" && Array.isArray(r.items) && r.items.length > 0 && r.items.length <= 5 &&
      r.items.every((it) => typeof it.title === "string" && typeof it.link === "string") && Array.isArray(r.warnings));

  await live("feed-parse GitHub Atom feed",
    () => h("feed-parse")({ url: "https://github.com/MikeyPetrillo/Agent402/commits/main.atom", limit: 3 }),
    (r) => r.format === "atom" && Array.isArray(r.items) && r.items.length > 0 && r.items.every((it) => typeof it.id === "string"));

  await live("unshorten-url youtu.be",
    () => h("unshorten-url")({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    (r) => r.redirects >= 1 && /youtube\.com\/watch/.test(r.finalUrl) && Array.isArray(r.hops) && r.hops.length >= 2 &&
      r.hops[0].status >= 300 && r.hops[0].status < 400 && r.truncated === false);

  await live("unshorten-url non-redirecting URL",
    () => h("unshorten-url")({ url: "https://example.com/" }),
    (r) => r.redirects === 0 && r.finalUrl === "https://example.com/" && r.finalStatus === 200 && r.hops.length === 1);
} else {
  console.log("(skipping live upstream calls — set WEB_LIVE_TEST=1 to enable)");
}

// archive-snapshot: an EMPTY Wayback answer is not "never archived". The
// availability API returned `archived_snapshots: {}` for wikipedia.org@2015
// on the 2026-09-07 nightly (a 200, 5.1 s) and the handler sold that as
// available:false without asking the Memento aggregator. Stubbed fetch:
// (a) empty Wayback + a memento -> available:true from memgator; (b) empty +
// memgator 404 -> available:false naming BOTH archives; (c) a real Wayback
// hit never consults memgator.
{
  const realFetch = globalThis.fetch;
  // Route by HOSTNAME equality, never a substring of the URL (CodeQL
  // js/incomplete-url-substring-sanitization flagged the first draft).
  const hostOf = (input) => { try { return new URL(String(input)).hostname; } catch { return ""; } };
  const script = (wayback, memgator) => async (input) => {
    const u = String(input);
    if (hostOf(input) === "archive.org") return new Response(JSON.stringify(wayback), { status: 200, headers: { "content-type": "application/json" } });
    if (hostOf(input) === "memgator.cs.odu.edu") {
      if (memgator === 404) return new Response("", { status: 404 });
      return new Response(JSON.stringify(memgator), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const empty = { url: "https://www.wikipedia.org", archived_snapshots: {}, timestamp: "2015" };
  const memento = { mementos: { closest: { datetime: "2015-01-01T00:00:58Z", uri: "https://web.archive.org/web/20150101000058/http://wikipedia.org/" } } };
  try {
    globalThis.fetch = script(empty, memento);
    const a = await h("archive-snapshot")({ url: "https://www.wikipedia.org", timestamp: "2015" });
    ok(a.available === true && a.source === "memgator.cs.odu.edu" && a.snapshot?.timestamp === "20150101000058",
      "archive-snapshot: an empty Wayback answer is checked against the Memento aggregator and its memento is served");

    globalThis.fetch = script(empty, 404);
    const b = await h("archive-snapshot")({ url: "https://www.wikipedia.org", timestamp: "2015" });
    ok(b.available === false && b.snapshot === null && b.source === "web.archive.org+memgator.cs.odu.edu" && /neither/.test(b.note || ""),
      "archive-snapshot: only two archives agreeing on nothing reads as not archived, and says so");

    let memgatorAsked = false;
    const hit = { url: "https://www.wikipedia.org", archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20151231235819/https://www.wikipedia.org/", timestamp: "20151231235819" } } };
    globalThis.fetch = async (input) => { if (hostOf(input) === "memgator.cs.odu.edu") memgatorAsked = true; return script(hit, 404)(input); };
    const c = await h("archive-snapshot")({ url: "https://www.wikipedia.org", timestamp: "2015" });
    ok(c.available === true && c.source === "web.archive.org" && !memgatorAsked, "archive-snapshot: a real Wayback hit never consults memgator");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\npassed: ${pass} | failed: ${fail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
const liveOptIn = process.env.WEB_LIVE_TEST === "1";
if (fail > 0 || (liveOptIn && liveOk === 0)) { console.error("web-kit: FAILED"); process.exit(1); }
console.log("web-kit: OK");
