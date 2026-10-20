#!/usr/bin/env node
// scripts/submit-sitemaps.js against a stubbed Bing: lists first, submits
// only the feeds Bing does not hold, submits nothing on --dry-run, never
// sends the key anywhere but the query string Bing's API takes, and fails
// loudly on an API error. Offline; nothing reaches Bing.
//
//   node scripts/test-submit-sitemaps.js
import { execFileSync } from "node:child_process";
import { createSearchData } from "../src/search-data.js";
import { DEFAULT_SITEMAPS, missingFeeds, sameFeed, syncSitemaps } from "./submit-sitemaps.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const KEY = "stub-bing-key-0123456789";

ok(sameFeed("https://agent402.tools/sitemapindex.xml", "https://AGENT402.tools/sitemapindex.xml/"), "feed match ignores host case and a trailing slash");
ok(!sameFeed("https://agent402.tools/sitemap.xml", "https://agent402.tools/sitemapindex.xml"), "different paths are different feeds");
ok(DEFAULT_SITEMAPS.includes("https://agent402.tools/sitemapindex.xml") && DEFAULT_SITEMAPS.includes("https://agent402.tools/sitemap-reports.xml"), "defaults are the index and the reports sitemap");
ok(JSON.stringify(missingFeeds(DEFAULT_SITEMAPS, [{ url: "https://agent402.tools/sitemap.xml" }])) === JSON.stringify(DEFAULT_SITEMAPS), "with only the monolith held, both defaults are missing");

/** A Bing stub: records every call, holds `held`, accepts SubmitFeed. */
function stub(held, { failSubmit = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: u.pathname.split("/").pop(), apikey: u.searchParams.get("apikey"), site: u.searchParams.get("siteUrl"), body: init.body ? JSON.parse(init.body) : null, url: String(url) });
    if (u.pathname.endsWith("/GetFeeds")) return jsonRes({ d: held.map((h) => ({ Url: h, Status: "Success", UrlCount: 10 })) });
    if (u.pathname.endsWith("/SubmitFeed")) {
      if (failSubmit) return jsonRes({ Message: "feed rejected" }, 400);
      held.push(init.body ? JSON.parse(init.body).feedUrl : "");
      return jsonRes({ d: null });
    }
    return jsonRes({ Message: "unexpected call" }, 500);
  };
  const sd = createSearchData({ env: { BING_WEBMASTER_API_KEY: KEY }, fetchImpl, store: null, log: () => {} });
  return { sd, calls, held };
}

// ---------- missing feeds are submitted, held ones are not ----------
{
  const { sd, calls, held } = stub(["https://agent402.tools/sitemap.xml"]);
  const logs = [];
  const r = await syncSitemaps({ sd, dryRun: false, log: (m) => logs.push(m) });
  ok(calls[0].method === "GetFeeds" && calls[0].site === "https://agent402.tools/", "lists the site's feeds first");
  ok(r.submitted.length === 2 && calls.filter((c) => c.method === "SubmitFeed").length === 2, "submits the two missing feeds");
  ok(calls.filter((c) => c.method === "SubmitFeed").every((c) => c.body.siteUrl === "https://agent402.tools/" && DEFAULT_SITEMAPS.includes(c.body.feedUrl)), "each submit names the site and one wanted feed");
  ok(held.length === 3, "the stub now holds all three");
  ok(calls.every((c) => c.apikey === KEY), "the key rides only as the API's apikey parameter");
  ok(!logs.some((l) => l.includes(KEY)), "the key is never logged");
  // Second run: nothing to do.
  const again = await syncSitemaps({ sd, dryRun: false, log: () => {} });
  ok(again.submitted.length === 0 && again.missing.length === 0, "a second run submits nothing (idempotent)");
}

// ---------- dry run lists and submits nothing ----------
{
  const { sd, calls } = stub([]);
  const r = await syncSitemaps({ sd, dryRun: true, log: () => {} });
  ok(r.missing.length === 2 && r.submitted.length === 0 && calls.every((c) => c.method === "GetFeeds"), "dry run: both missing, no SubmitFeed call");
}

// ---------- extra feeds, already-held copies with a different spelling ----------
{
  const { sd, calls } = stub(["https://AGENT402.tools/sitemapindex.xml/", "https://agent402.tools/sitemap-reports.xml"]);
  const r = await syncSitemaps({ sd, wanted: [...DEFAULT_SITEMAPS, "https://agent402.tools/sitemap-tools.xml"], dryRun: false, log: () => {} });
  ok(r.submitted.length === 1 && r.submitted[0] === "https://agent402.tools/sitemap-tools.xml" && calls.filter((c) => c.method === "SubmitFeed").length === 1, "only the extra feed is submitted; differently spelled copies count as held");
}

// ---------- an API error is an error, not a silent skip ----------
{
  const { sd } = stub([], { failSubmit: true });
  let err = null;
  try { await syncSitemaps({ sd, dryRun: false, log: () => {} }); } catch (e) { err = e; }
  ok(err && /SubmitFeed HTTP 400/.test(err.message) && !err.message.includes(KEY), `a rejected submit throws without the key (${err && err.message})`);
}

// ---------- the CLI refuses without a key and prints nothing secret ----------
{
  let out = "", code = 0;
  try { out = execFileSync(process.execPath, [new URL("./submit-sitemaps.js", import.meta.url).pathname, "--dry-run"], { env: { PATH: process.env.PATH }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; out = `${e.stdout || ""}${e.stderr || ""}`; }
  ok(code === 2 && /BING_WEBMASTER_API_KEY is not set/.test(out), `without a key the CLI exits 2 (got ${code})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
