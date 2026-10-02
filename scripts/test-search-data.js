// Search data pipeline (src/search-data.js), offline: stubbed Google/Bing
// endpoints, an in-memory store, and one booted server for the operator routes.
import { generateKeyPairSync, createVerify } from "node:crypto";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import {
  readConfig, buildJwtAssertion, createSearchData, createMemoryStore, computeWeeklySummary,
  parseBingDate, addDays, GSC_ROW_LIMIT, GSC_SCOPE_READ, GSC_SCOPE_WRITE,
} from "../src/search-data.js";
import { parseSitemap, collectSitemapUrls, selectChanged, pingIndexNow, chunk } from "../src/indexnow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  type: "service_account", client_email: "reader@test-project.iam.gserviceaccount.com", private_key_id: "kid123",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token",
};
const NOW = Date.parse("2026-09-24T12:00:00Z");
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ---------- no-op without env ----------
{
  const cfg = readConfig({});
  ok(!cfg.google && !cfg.bingKey && cfg.enabled, "empty env: no sources, enabled flag default on");
  ok(cfg.gscSite === "sc-domain:agent402.tools" && cfg.bingSite === "https://agent402.tools/", "site defaults");
  let fetched = 0;
  const logs = [];
  const sd = createSearchData({ env: {}, store: createMemoryStore(), fetchImpl: async () => { fetched++; return jsonRes({}); }, log: (m) => logs.push(m) });
  ok(sd.start() === null, "scheduler does not arm without credentials");
  ok((await sd.runOnce()).reason === "not-configured", "runOnce is a no-op without credentials");
  const s = await sd.summary();
  ok(Object.keys(s.sources).length === 0, "summary has no sources without credentials");
  ok((await sd.inspectUrls(["https://agent402.tools/"])).reason === "not-configured", "inspect is a no-op without credentials");
  ok(fetched === 0, "nothing fetched without credentials");
  const off = createSearchData({ env: { SEARCH_DATA: "off", BING_WEBMASTER_API_KEY: "k" }, store: createMemoryStore(), log: () => {} });
  ok(off.start() === null, "SEARCH_DATA=off disarms the scheduler");
  const nodb = createSearchData({ env: { BING_WEBMASTER_API_KEY: "k" }, store: null, log: () => {} });
  ok(nodb.start() === null && (await nodb.runOnce()).reason === "no-db", "no database: not started, runOnce refuses");
  const bad = readConfig({ GSC_SERVICE_ACCOUNT_JSON: "{not json" });
  ok(!bad.google && /not valid JSON/.test(bad.googleError), "malformed service account JSON is reported, not thrown");
  const leaky = readConfig({ GSC_SERVICE_ACCOUNT_JSON: '"private_key_SECRETPART' });
  ok(!/SECRETPART|private_key/.test(leaky.googleError || ""), "the error never quotes the value");
}

// ---------- JWT assertion ----------
{
  const cfg = readConfig({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) });
  const nowSec = Math.floor(NOW / 1000);
  const jwt = buildJwtAssertion(cfg.google, GSC_SCOPE_READ, nowSec);
  const [h, c, sig] = jwt.split(".");
  const header = b64dec(h), claims = b64dec(c);
  ok(header.alg === "RS256" && header.typ === "JWT" && header.kid === "kid123", "JWT header RS256 + kid");
  ok(claims.iss === SA.client_email && claims.aud === SA.token_uri && claims.scope === GSC_SCOPE_READ, "JWT claims iss/aud/scope");
  ok(claims.iat === nowSec && claims.exp === nowSec + 3600, "JWT iat/exp one hour");
  ok(!/[=+/]/.test(jwt), "JWT is base64url without padding");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${c}`);
  ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")), "JWT signature verifies with the public key");
}

// ---------- Google stub ----------
function googleStub({ bigFirstPage = false } = {}) {
  const calls = { token: [], query: [], sitemaps: 0, submit: [], inspect: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u === SA.token_uri) {
      const p = new URLSearchParams(opts.body);
      calls.token.push({ grant: p.get("grant_type"), assertion: p.get("assertion") });
      return jsonRes({ access_token: `tok${calls.token.length}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (!/^Bearer tok\d+$/.test(opts.headers?.Authorization || "")) return jsonRes({ error: { message: "no auth" } }, 401);
    if (u.endsWith("/searchAnalytics/query")) {
      const body = JSON.parse(opts.body);
      calls.query.push(body);
      const dims = body.dimensions;
      const mk = (i, day) => ({ keys: dims.map((d) => (d === "date" ? day : d === "page" ? `https://agent402.tools/p${i}` : `q${i}`)), clicks: 1, impressions: 10, ctr: 0.1, position: 5 });
      if (bigFirstPage && dims.length === 3 && body.startDate === body.endDate) {
        if (body.startRow === 0) return jsonRes({ rows: Array.from({ length: GSC_ROW_LIMIT }, (_, i) => mk(i, body.startDate)) });
        return jsonRes({ rows: [mk(GSC_ROW_LIMIT, body.startDate), mk(GSC_ROW_LIMIT + 1, body.startDate)] });
      }
      return jsonRes({ rows: [mk(1, body.endDate), mk(2, body.startDate)] });
    }
    if (/\/sitemaps$/.test(u)) { calls.sitemaps++; return jsonRes({ sitemap: [{ path: "https://agent402.tools/sitemapindex.xml", errors: "0", warnings: "1", contents: [{ type: "web", submitted: "700", indexed: "0" }] }] }); }
    if (/\/sitemaps\//.test(u) && opts.method === "PUT") { calls.submit.push(u); return new Response("", { status: 200 }); }
    if (u.includes("urlInspection")) {
      calls.inspect.push(JSON.parse(opts.body));
      return jsonRes({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-09-20T00:00:00Z" } } });
    }
    return jsonRes({ error: { message: "unexpected " + u } }, 404);
  };
  return { calls, fetchImpl };
}

// ---------- pagination ----------
{
  const { calls, fetchImpl } = googleStub({ bigFirstPage: true });
  const sd = createSearchData({ env: { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) }, store: createMemoryStore(), fetchImpl, now: () => NOW, log: () => {} });
  const rows = await sd._gscQuery("2026-09-20", "2026-09-20", ["date", "query", "page"]);
  ok(rows.length === GSC_ROW_LIMIT + 2, `pagination collects every page (${rows.length})`);
  ok(calls.query.length === 2 && calls.query[0].startRow === 0 && calls.query[1].startRow === GSC_ROW_LIMIT, "startRow advances by the row limit and stops on a short page");
  ok(calls.query[0].rowLimit === GSC_ROW_LIMIT && calls.query[0].dataState === "all" && calls.query[0].type === "web", "query body carries rowLimit/dataState/type");
  ok(calls.token.length === 1 && calls.token[0].grant === "urn:ietf:params:oauth:grant-type:jwt-bearer", "one token exchange (jwt-bearer), cached across pages");
  ok(rows[0].source === "google" && rows[0].day === "2026-09-20" && rows[0].query === "q0" && rows[0].page === "https://agent402.tools/p0", "rows mapped to source/day/query/page");
}

// ---------- backfill chunking ----------
{
  const sd = createSearchData({ env: { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) }, store: createMemoryStore(), log: () => {} });
  const chunks = sd.backfillChunks("2025-05-01", "2026-09-20", 30);
  ok(chunks[0][1] === "2026-09-20" && chunks.at(-1)[0] === "2025-05-01", "chunks cover newest to oldest");
  let contiguous = true, sized = true;
  for (let i = 0; i < chunks.length; i++) {
    const [s, e] = chunks[i];
    const days = (Date.parse(e) - Date.parse(s)) / 86400000 + 1;
    if (days > 30 || days < 1) sized = false;
    if (i > 0 && addDays(chunks[i - 1][0], -1) !== chunks[i][1]) contiguous = false;
  }
  ok(contiguous, "chunks are contiguous with no gap or overlap");
  ok(sized, "every chunk is at most 30 days");
}

// ---------- full google run: recent + backfill + idempotence ----------
{
  const { calls, fetchImpl } = googleStub();
  const store = createMemoryStore();
  const env = { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(SA), SEARCH_DATA_BACKFILL_MONTHS: "3" };
  const sd = createSearchData({ env, store, fetchImpl, now: () => NOW, log: () => {} });
  const r1 = await sd.runOnce();
  ok(r1.ok && r1.google.recent > 0, "run pulls the recent window");
  const recent = calls.query.filter((q) => q.endDate === "2026-09-23");
  ok(recent.length === 3 && recent[0].startDate === "2026-09-21", "recent window is the last 3 days across three dimension sets");
  ok(new Set(calls.query.map((q) => q.dimensions.join())).size === 3, "dimension sets: date / date,page / date,query,page");
  ok(r1.google.backfillChunks === 3, `3-month backfill in 30-day chunks (${r1.google.backfillChunks})`);
  ok(calls.query.every((q) => q.startDate >= "2026-06-24"), "backfill never reaches past the configured months");
  ok((await store.getSnapshot("google", "backfill_done"))?.value === 1, "backfill_done recorded");
  ok((await store.getSnapshot("google", "sitemap:/sitemapindex.xml:web:submitted"))?.value === 700, "sitemap snapshot stored");
  ok(calls.submit.length === 0, "sitemap not submitted without the flag");
  const size1 = store.daily.size;
  const q1 = calls.query.length;
  const r2 = await sd.runOnce();
  ok(r2.google.backfillChunks === 0 && calls.query.length - q1 === 3, "second run skips backfill");
  ok(store.daily.size === size1, "re-pulling the same days upserts, never duplicates");
  ok(calls.token.length === 1, "token reused across runs until expiry");

  // Resume: an interrupted backfill restarts past its cursor.
  const store2 = createMemoryStore();
  await store2.upsertSnapshot([{ source: "google", day: "2026-09-23", metric: "backfill_cursor", value: Math.round(Date.parse("2026-08-01T00:00:00Z") / 86400000) }]);
  const g2 = googleStub();
  const sd2 = createSearchData({ env, store: store2, fetchImpl: g2.fetchImpl, now: () => NOW, log: () => {} });
  await sd2.runOnce();
  const back = g2.calls.query.filter((q) => q.endDate !== "2026-09-23");
  ok(back.length > 0 && back.every((q) => q.endDate <= "2026-07-31"), "backfill resumes before the stored cursor");

  // Submit flag + on-demand submit use the write scope.
  const g3 = googleStub();
  const sd3 = createSearchData({ env: { ...env, SEARCH_SUBMIT_SITEMAP: "on" }, store: createMemoryStore(), fetchImpl: g3.fetchImpl, now: () => NOW, log: () => {} });
  await sd3.runOnce();
  ok(g3.calls.submit.length === 1 && g3.calls.submit[0].endsWith(encodeURIComponent("https://agent402.tools/sitemapindex.xml")), "flag submits sitemapindex.xml");
  const scopes = g3.calls.token.map((t) => b64dec(t.assertion.split(".")[1]).scope);
  ok(scopes.includes(GSC_SCOPE_READ) && scopes.includes(GSC_SCOPE_WRITE), "reads use readonly scope, submit uses webmasters scope");

  // URL inspection: capped per call, only http(s).
  const urls = Array.from({ length: 30 }, (_, i) => `https://agent402.tools/tools/t${i}`).concat(["javascript:alert(1)"]);
  const ins = await sd3.inspectUrls(urls);
  ok(ins.results.length === 20 && g3.calls.inspect.length === 20, "inspection capped at 20 URLs per call");
  ok(ins.results[0].verdict === "PASS" && g3.calls.inspect[0].siteUrl === "sc-domain:agent402.tools", "inspection result mapped, siteUrl sent");
  const capped = await sd3.inspectUrls(urls.slice(0, 5), { dailyCap: 22 });
  ok(capped.results.filter((r) => r.error).length === 3, "daily inspection cap enforced");
}

// ---------- Bing ----------
{
  const calls = [];
  const ms = Date.parse("2026-09-20T00:00:00Z");
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = u.pathname.split("/").pop();
    calls.push({ method, key: u.searchParams.get("apikey"), site: u.searchParams.get("siteUrl"), http: opts.method, body: opts.body });
    const d = `/Date(${ms}-0700)/`;
    if (method === "GetRankAndTrafficStats") return jsonRes({ d: [{ Date: d, Clicks: 4, Impressions: 100 }] });
    if (method === "GetQueryStats") return jsonRes({ d: [{ Date: d, Query: "x402 api", Clicks: 2, Impressions: 40, AvgImpressionPosition: 7.5, AvgClickPosition: 6 }] });
    if (method === "GetPageStats") return jsonRes({ d: [{ Date: d, Query: "https://agent402.tools/tools/hash", Clicks: 1, Impressions: 30, AvgImpressionPosition: -1 }] });
    if (method === "GetCrawlStats") return jsonRes({ d: [{ Date: d, CrawledPages: 50, InIndex: 400, CrawlErrors: 2 }] });
    if (method === "GetCrawlIssues") return jsonRes({ d: [{ Url: "https://agent402.tools/x" }] });
    if (method === "SubmitFeed") return jsonRes({ d: null });
    return jsonRes({ Message: "unknown" }, 400);
  };
  const store = createMemoryStore();
  const sd = createSearchData({ env: { BING_WEBMASTER_API_KEY: "bingkey" }, store, fetchImpl, now: () => NOW, log: () => {} });
  const r = await sd.runOnce();
  ok(r.ok && r.bing.traffic === 1 && r.bing.queries === 1 && r.bing.pages === 1, "bing traffic/query/page stats pulled");
  ok(calls.every((c) => c.key === "bingkey" && (c.site === "https://agent402.tools/" || c.method === "SubmitFeed")), "api key + siteUrl on every call");
  const rows = [...store.daily.values()];
  ok(rows.some((x) => x.query === "" && x.page === "" && x.impressions === 100), "site total row (query='' page='')");
  const q = rows.find((x) => x.query === "x402 api");
  ok(q && q.page === "" && q.position === 7.5 && Math.abs(q.ctr - 0.05) < 1e-9 && q.day === "2026-09-20", "query row: position, derived CTR, parsed date");
  ok(rows.find((x) => x.page.endsWith("/tools/hash"))?.position === null, "Bing -1 position stored as null");
  ok((await store.getSnapshot("bing", "crawl:InIndex"))?.value === 400 && (await store.getSnapshot("bing", "crawl_issues"))?.value === 1, "crawl stats + issues snapshot");
  const sub = await sd.submitSitemaps();
  const feed = calls.find((c) => c.method === "SubmitFeed");
  ok(sub.bing?.ok && feed.http === "POST" && JSON.parse(feed.body).feedUrl === "https://agent402.tools/sitemapindex.xml", "SubmitFeed POSTs the sitemap index");
  ok(parseBingDate("/Date(1758326400000)/") === "2025-09-20" && parseBingDate("junk") === null, "Bing date parsing");
}

// ---------- weekly summary math ----------
{
  const end = "2026-09-20";
  const rows = [];
  const add = (day, query, page, clicks, impressions, position) => rows.push({ day, query, page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
  for (let i = 0; i < 7; i++) {
    const cur = addDays(end, -i), prev = addDays(end, -7 - i);
    add(cur, "", "", 20, 1000, 8); add(prev, "", "", 10, 1000, 12);
    add(cur, "", "/a", 10, 200, 5); add(prev, "", "/a", 2, 200, 9);       // gainer
    add(cur, "", "/b", 1, 100, 6); add(prev, "", "/b", 6, 100, 4);        // loser
    add(cur, "", "/new", 1, 30, 11);                                       // new
    add(prev, "", "/gone", 1, 50, 15);                                     // dropped
    add(cur, "", "/lowctr", 0, 60, 7);                                     // 420 impr, 0 clicks, pos 7
    add(cur, "", "/deep", 0, 60, 45);                                      // low CTR but deep, excluded
    add(cur, "alpha", "/a", 5, 50, 3); add(prev, "alpha", "/a", 1, 50, 6);
    add(cur, "beta", "/b", 0, 20, 9); add(prev, "beta", "/b", 3, 20, 5);
  }
  add(addDays(end, -20), "", "", 999, 9999, 1); // outside both windows
  const s = computeWeeklySummary(rows, { end });
  ok(s.window.from === "2026-09-14" && s.window.prevTo === "2026-09-13" && s.window.prevFrom === "2026-09-07", "window boundaries");
  ok(s.totals.clicks === 140 && s.totals.prevClicks === 70 && s.totals.clicksChange === 1, "totals from site rows, change +100%");
  ok(s.totals.ctr === 0.02 && s.totals.prevCtr === 0.01, "CTR = clicks/impressions");
  ok(s.totals.position === 8 && s.totals.prevPosition === 12, "impression-weighted average position");
  ok(s.pages.gaining[0].key === "/a" && s.pages.gaining[0].clicksDelta === 56, "top gaining page");
  ok(s.pages.losing[0].key === "/b" && s.pages.losing[0].clicksDelta === -35, "top losing page");
  ok(s.queries.gaining[0].key === "alpha" && s.queries.losing[0].key === "beta", "query gainers/losers");
  ok(s.pages.new.map((p) => p.page).includes("/new") && !s.pages.new.map((p) => p.page).includes("/a"), "newly appearing pages");
  ok(s.pages.dropped.length === 1 && s.pages.dropped[0].page === "/gone", "dropped pages");
  const low = s.lowCtrPages.map((p) => p.page);
  ok(low.includes("/lowctr") && !low.includes("/deep") && !low.includes("/a"), "low-CTR detection with position and impression thresholds");
  ok(!low.includes("/b") || s.lowCtrPages.find((p) => p.page === "/b").impressions >= 100, "low-CTR list respects the impression floor");
  ok(computeWeeklySummary([], {}).empty === true, "no end day -> empty summary");

  // Summary via a pipeline instance reads the store's last 14 days.
  const store = createMemoryStore();
  await store.upsertDaily(rows.map((r) => ({ ...r, source: "google" })));
  const sd = createSearchData({ env: { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) }, store, now: () => NOW, log: () => {} });
  const out = await sd.summary();
  ok(out.sources.google?.totals?.clicks === 140, "pipeline summary ends at the newest stored day");
  await store.upsertDaily(rows.slice(0, 5).map((r) => ({ ...r, source: "google" })));
  ok(store.daily.size === new Set(rows.map((r) => `${r.day}|${r.query}|${r.page}`)).size, "memory upsert is idempotent");
}

// ---------- IndexNow helpers ----------
{
  const idx = `<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap><loc>https://agent402.tools/sitemap-a.xml</loc><lastmod>2026-09-20</lastmod></sitemap><sitemap><loc>https://other.example/s.xml</loc></sitemap></sitemapindex>`;
  const a = `<urlset><url><loc>https://agent402.tools/</loc><lastmod>2026-09-20</lastmod></url><url><loc>https://agent402.tools/x?a=1&amp;b=2</loc><lastmod>2026-08-01</lastmod></url></urlset>`;
  const legacy = `<urlset><url><loc>https://agent402.tools/</loc></url><url><loc>https://agent402.tools/legacy</loc></url></urlset>`;
  ok(parseSitemap(idx).kind === "index" && parseSitemap(a).entries[1].loc === "https://agent402.tools/x?a=1&b=2", "sitemap parsing (index + entity decode)");
  const fetched = [];
  const fetchImpl = async (u) => {
    fetched.push(String(u));
    const body = { "https://agent402.tools/sitemapindex.xml": idx, "https://agent402.tools/sitemap-a.xml": a, "https://agent402.tools/sitemap.xml": legacy }[String(u)];
    return body ? new Response(body) : new Response("nope", { status: 404 });
  };
  const r = await collectSitemapUrls("https://agent402.tools", { fetchImpl });
  ok(r.urls.length === 3 && r.sitemaps.length === 3, "every sitemap walked, URLs deduped across sitemaps");
  ok(!fetched.some((u) => u.includes("other.example")), "child sitemaps on another host are not followed");
  ok(selectChanged(r.urls).length === 3, "no state: everything selected");
  ok(JSON.stringify(selectChanged(r.urls, { previous: ["https://agent402.tools/", "https://agent402.tools/legacy"] })) === JSON.stringify(["https://agent402.tools/x?a=1&b=2"]), "state: only new URLs");
  ok(JSON.stringify(selectChanged(r.urls, { since: "2026-09-01" })) === JSON.stringify(["https://agent402.tools/"]), "since: lastmod on/after the date");
  ok(chunk(Array.from({ length: 25001 })).map((c) => c.length).join() === "10000,10000,5001", "batches of 10,000");
  const posts = [];
  const p = await pingIndexNow({ host: "agent402.tools", key: "k", keyLocation: "https://agent402.tools/k.txt", urls: Array.from({ length: 10001 }, (_, i) => `https://agent402.tools/${i}`), fetchImpl: async (u, o) => { posts.push(JSON.parse(o.body)); return new Response("", { status: 202 }); } });
  ok(p.ok && posts.length === 2 && posts[0].urlList.length === 10000 && posts[0].host === "agent402.tools" && posts[0].key === "k", "ping batches with host/key/keyLocation");
  ok((await pingIndexNow({ host: "h", key: "", urls: ["x"] })).reason === "no-key", "no key: no ping");
  const failing = await pingIndexNow({ host: "h", key: "k", urls: ["https://h/a"], fetchImpl: async () => new Response("bad", { status: 403 }) });
  ok(!failing.ok, "a refused batch reports not ok");
}

// ---------- operator routes on a booted server ----------
{
  const TOKEN = "search-data-operator-token-xyz";
  const PORT = await getFreePort();
  const base = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, FREE_MODE: "true", PORT: String(PORT), AGENT402_OPERATOR_TOKEN: TOKEN, X402_INDEX_CRAWL: "off" };
  for (const k of ["DATABASE_URL", "ANALYTICS_DATABASE_URL", "GSC_SERVICE_ACCOUNT_JSON", "BING_WEBMASTER_API_KEY"]) delete env[k];
  const child = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
      await wait(500);
    }
    ok(up, "server booted");
    if (up) {
      const st = async (path, opts) => (await fetch(base + path, opts)).status;
      ok((await st("/__operator/search.json")) === 404, "search.json 404 without auth");
      ok((await st("/__operator/search")) === 404, "search page 404 without auth");
      ok((await st("/__operator/search/run", { method: "POST" })) === 404, "run 404 without auth");
      ok((await st("/__operator/search/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })) === 404, "inspect 404 without auth");
      ok((await st("/__operator/search/sitemaps/submit", { method: "POST" })) === 404, "submit 404 without auth");
      ok((await st("/__operator/search.json", { headers: { authorization: "Bearer wrong" } })) === 404, "wrong token 404");
      const auth = { authorization: `Bearer ${TOKEN}` };
      const j = await (await fetch(`${base}/__operator/search.json`, { headers: auth })).json();
      ok(j.status?.google?.configured === false && j.status?.bing?.configured === false, "authed JSON reports sources unconfigured");
      const html = await fetch(`${base}/__operator/search`, { headers: auth });
      const text = await html.text();
      ok(html.status === 200 && /Search data/.test(text) && /noindex/.test(text), "authed HTML view renders, noindex");
      const run = await (await fetch(`${base}/__operator/search/run`, { method: "POST", headers: auth })).json();
      ok(run.reason === "not-configured", "authed run is a no-op without credentials");
      ok(/\[search-data\] not configured/.test(log), "boot logs the not-configured state");
    } else console.error(log.slice(-800));
  } finally { child.kill("SIGKILL"); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
