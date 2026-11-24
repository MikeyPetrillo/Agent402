// scripts/test-robots-gate.js
// The robots.txt gate for the tools that return a caller-named page's content
// (src/tools/robots-gate.js), and the promise that fetched content is not kept.
//
//   1. The rule, offline: which groups apply to Agent402-Fetch (its exact name,
//      the brand, else `*`; never a group for a product whose name is only part
//      of ours), the longest match, the 403 and the fields it carries, an
//      unreadable robots.txt allowing the read, the per-origin cache (an hour,
//      ten minutes for an unreadable file, one read for concurrent calls, a
//      bounded number of origins, an oversize rule set never kept).
//   2. The caller path: a server booted with a stubbed robots.txt
//      (scripts/lib/robots-stub-preload.js) answers 403 robots_disallowed on
//      every gated route for a disallowed URL, and the log shows no fetch of
//      that page; an allowed URL is served as before.
//   3. Retention: two calls for the same allowed page each fetch it (no
//      cross-call cache of fetched content), no gated route is in the shared
//      response cache (src/cache.js), and no gated tool's module writes to a
//      store, a file or the shared cache. The paid replay window and the task
//      window are the only places an answer is kept.
//
//   node scripts/test-robots-gate.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = await import("../src/tools/robots-gate.js");
const { parseRobots } = await import("../src/tools/kit.js");
const { toolErrorFields } = await import("../src/tool-error-fields.js");
const { refusalReason, REFUSAL_REASONS } = await import("../src/refusal-reason.js");
const { FETCH_TOKEN, BROWSER_FETCH_UA, BROWSER_FETCH_MOBILE_UA } = await import("../src/user-agents.js");
const { CACHEABLE_ROUTES } = await import("../src/cache.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const { __test, assertRobotsAllow, ROBOTS_GATED_SLUGS, ROBOTS_CACHE_MS, ROBOTS_UNREADABLE_CACHE_MS, ROBOTS_CACHE_MAX_ORIGINS, ROBOTS_CACHE_ENTRY_CHARS } = gate;

async function verdict(robots, url, opts) {
  __test.clear();
  __test.setFetchRobots(async () => { if (robots instanceof Error) throw robots; return robots; });
  try { await assertRobotsAllow(url, opts); return { allowed: true }; }
  catch (e) { return { allowed: false, err: e }; }
}

// ---------------------------------------------------------------------------
// 1. The rule
// ---------------------------------------------------------------------------
{
  const v = await verdict("User-agent: Agent402-Fetch\nDisallow: /private\n", "https://a.example/private/x");
  ok(!v.allowed && v.err.statusCode === 403, "a Disallow for Agent402-Fetch refuses the path with 403");
  ok(v.err.robotsRule === "Disallow: /private" && v.err.robotsUrl === "https://a.example/robots.txt", "the refusal names the rule and the robots.txt it came from");
  const fields = toolErrorFields(v.err);
  ok(fields.reason === "robots_disallowed" && fields.rule === "Disallow: /private" && fields.robotsTxt === "https://a.example/robots.txt" && fields.hint === "robots-disallowed", `the answer carries reason, rule, robotsTxt and hint (${JSON.stringify(fields)})`);
  ok(typeof fields.fix === "string" && fields.fix.includes(FETCH_TOKEN), "the answer says what helps");
  ok(REFUSAL_REASONS.includes("robots_disallowed") && refusalReason(v.err.message, 403, v.err) === "robots_disallowed" && refusalReason(v.err.message, 403) === "robots_disallowed", "the refusal classifies as robots_disallowed, with or without the error");
  ok((await verdict("User-agent: Agent402-Fetch\nDisallow: /private\n", "https://a.example/public")).allowed, "a path the rule does not cover is allowed");
}
ok((await verdict("User-agent: agent402-fetch\nDisallow: /\n", "https://a.example/x")).allowed === false, "the token is matched case-insensitively");
ok((await verdict("User-agent: Agent402\nDisallow: /\n", "https://a.example/x")).allowed === false, "a group for the brand token Agent402 applies");
ok((await verdict("User-agent: Fetch\nDisallow: /\n", "https://a.example/x")).allowed === true, "a group for another product named Fetch (part of our token) does not apply");
ok((await verdict("User-agent: Agent402-Fetcher\nDisallow: /\n", "https://a.example/x")).allowed === true, "a group for a longer name that starts with our token does not apply");
{
  // The group selection itself, on the parser's raw groups (the cache keeps
  // only our groups too, so this is checked apart from it).
  const raw = parseRobots("User-agent: Fetch\nDisallow: /a\n\nUser-agent: Agent402-Fetch/2.1\nDisallow: /b\n\nUser-agent: Agent402\nDisallow: /c\n\nUser-agent: *\nDisallow: /d\n");
  const sel = gate.groupsForToken(raw, FETCH_TOKEN).map((g) => g.agents.join(","));
  ok(JSON.stringify(sel) === JSON.stringify(["", "agent402-fetch", "agent402-fetch", "*"]), `groupsForToken keeps the exact token (with a version), the brand and *, and drops Fetch (${JSON.stringify(sel)})`);
}
ok((await verdict("User-agent: *\nDisallow: /\n", "https://a.example/x")).allowed === false, "with no group naming us, the * group applies");
ok((await verdict("User-agent: *\nDisallow: /\n\nUser-agent: Agent402-Fetch\nAllow: /\n", "https://a.example/x")).allowed === true, "a group naming us replaces the * group");
ok((await verdict("User-agent: Agent402-Fetch\nDisallow: /docs\nAllow: /docs/public\n", "https://a.example/docs/public/a")).allowed === true, "the longest matching rule decides (Allow)");
ok((await verdict("User-agent: Agent402-Fetch\nDisallow: /*.pdf$\n", "https://a.example/f/report.pdf")).allowed === false, "wildcard and end anchor rules apply");
ok((await verdict("User-agent: Agent402-Fetch\nDisallow: /search\n", "https://a.example/search?q=1")).allowed === false, "the query string is part of the path matched");
ok((await verdict("User-agent: Agent402Bot\nDisallow: /\n", "https://a.example/x", { token: "Agent402Bot" })).allowed === false, "another token of ours (site-map's) is matched when asked for");
ok((await verdict("User-agent: Agent402Bot\nDisallow: /\n", "https://a.example/x")).allowed === true, "the site-crawl token's group does not bind the fetch token");
ok((await verdict(new Error("404"), "https://a.example/x")).allowed === true, "an unreadable robots.txt allows the read");
ok((await verdict("<html><body>Not found</body></html>", "https://a.example/x")).allowed === true, "an HTML page served as robots.txt allows the read");
ok((await verdict("User-agent: *\nDisallow: /\n", "not a url")).allowed === true, "a value that is not a URL is left to the tool's own input check");
ok((await verdict("User-agent: *\nDisallow: /\n", "ftp://a.example/x")).allowed === true, "a non-http(s) URL is left to the tool's own input check");
{
  const v = await verdict(`User-agent: Agent402-Fetch\nDisallow: /${"a".repeat(1500)}\n`, `https://a.example/${"a".repeat(1600)}`);
  ok(!v.allowed && v.err.robotsRule.length <= 200 && toolErrorFields(v.err).rule === v.err.robotsRule, "a long rule is cut to 200 printable characters in the answer");
}
{
  const v = await verdict("User-agent: Agent402-Fetch\nDisallow: /\u0007x\n", "https://a.example/\u0007x");
  ok(v.allowed || !/[^\x20-\x7e]/.test(v.err.robotsRule), "a rule's control characters never reach the answer");
}

// The cache
{
  __test.clear();
  let reads = 0;
  __test.setFetchRobots(async () => { reads++; await new Promise((r) => setTimeout(r, 20)); return "User-agent: *\nAllow: /\n"; });
  await Promise.all([assertRobotsAllow("https://c.example/a"), assertRobotsAllow("https://c.example/b"), assertRobotsAllow("https://c.example/c")]);
  ok(reads === 1, `concurrent calls for one origin read robots.txt once (${reads})`);
  await assertRobotsAllow("https://c.example/d");
  ok(reads === 1, "a later call within the hour reads it from the cache");
  const e = __test.cacheEntry("https://c.example");
  ok(e && Math.abs(e.expires - Date.now() - ROBOTS_CACHE_MS) < 5000 && ROBOTS_CACHE_MS === 3600_000, "a readable robots.txt is kept an hour");
  ok(Object.keys(e).sort().join() === "expires,groups", "the cache entry holds only the rules and their expiry");
  await assertRobotsAllow("http://c.example/a");
  ok(reads === 2, "another scheme is another origin");
  __test.setFetchRobots(async () => { reads++; throw new Error("unreadable"); });
  await assertRobotsAllow("https://u.example/a");
  const u = __test.cacheEntry("https://u.example");
  ok(u && u.groups === null && Math.abs(u.expires - Date.now() - ROBOTS_UNREADABLE_CACHE_MS) < 5000, "an unreadable robots.txt is kept ten minutes, as unreadable");
}
{
  __test.clear();
  __test.setFetchRobots(async (url) => `User-agent: *\nDisallow: /${new URL(url).hostname}\n`);
  for (let i = 0; i < ROBOTS_CACHE_MAX_ORIGINS + 25; i++) await assertRobotsAllow(`https://h${i}.example/x`);
  ok(__test.cacheSize() === ROBOTS_CACHE_MAX_ORIGINS, `the cache holds at most ${ROBOTS_CACHE_MAX_ORIGINS} origins (${__test.cacheSize()})`);
  ok(__test.cacheEntry("https://h0.example") === null && __test.cacheEntry(`https://h${ROBOTS_CACHE_MAX_ORIGINS + 24}.example`), "the oldest origin leaves first");
}
{
  __test.clear();
  let reads = 0;
  const big = `User-agent: *\n${Array.from({ length: 1500 }, (_, i) => `Disallow: /p${i}-${"x".repeat(30)}`).join("\n")}\nDisallow: /blocked\n`;
  __test.setFetchRobots(async () => { reads++; return big; });
  const first = await assertRobotsAllow("https://big.example/blocked").then(() => true, (e) => e.statusCode);
  ok(first === 403, "an oversize rule set still decides its own call");
  ok(__test.cacheEntry("https://big.example") === null && ROBOTS_CACHE_ENTRY_CHARS > 0, "an oversize rule set is not kept");
  __test.clear();
  __test.setFetchRobots(async () => "User-agent: Googlebot\nDisallow: /\n" + "User-agent: Other\nDisallow: /x\n".repeat(500) + "User-agent: *\nAllow: /\n");
  await assertRobotsAllow("https://g.example/");
  const g = __test.cacheEntry("https://g.example");
  ok(g && g.groups.every((grp) => grp.agents.some((a) => a === "*" || /^agent402/.test(a))), "only the groups that can apply to our tokens are kept");
}

// Memory: what is kept is copies of the kept rules, never slices that hold
// the fetched file alive, and the kept rules are capped per origin and in
// total. 2000 origins, each serving about 490 KB whose `*` group has 40 rules
// (the rest another agent's group and a comment), stay well under 50 MB.
{
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const { ROBOTS_CACHE_TOTAL_CHARS } = gate;
  ok(Number.isFinite(ROBOTS_CACHE_TOTAL_CHARS) && ROBOTS_CACHE_TOTAL_CHARS > 0 && ROBOTS_CACHE_TOTAL_CHARS < ROBOTS_CACHE_MAX_ORIGINS * ROBOTS_CACHE_ENTRY_CHARS, `the kept rules are capped in total (${ROBOTS_CACHE_TOTAL_CHARS} chars)`);
  __test.clear();
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const pad = "z".repeat(490 * 1024);
  __test.setFetchRobots(async (url) => {
    const h = new URL(url).hostname;
    const rules = Array.from({ length: 40 }, (_, i) => `Disallow: /private-area-${i}-${h}/`).join("\n");
    return `User-agent: *\n${rules}\nUser-agent: Otherbot\nDisallow: /other-${h}\n# ${h}${pad}\n`;
  });
  let refused = 0;
  for (let i = 0; i < 2000; i++) await assertRobotsAllow(`https://pad${i}.example/private-area-3-pad${i}.example/x`).catch((e) => { if (e.statusCode === 403) refused++; });
  gc(); gc();
  const heldMb = (process.memoryUsage().heapUsed - before) / 1e6;
  ok(refused === 2000 && __test.cacheSize() > 0, `the padded files still decide their calls (${refused} refused)`);
  ok(heldMb < 50, `2000 origins with padded robots.txt files hold under 50 MB (${heldMb.toFixed(1)} MB)`);
  ok(__test.keptChars() <= ROBOTS_CACHE_TOTAL_CHARS, `the kept rules stay inside the total cap (${__test.keptChars()} chars)`);
  __test.clear();
  ok(__test.keptChars() === 0, "clearing the cache clears its tally");
}

// The browser string
ok(BROWSER_FETCH_UA.startsWith("Mozilla/5.0 (Macintosh;") && /Chrome\/\d+/.test(BROWSER_FETCH_UA) && BROWSER_FETCH_UA.includes(`${FETCH_TOKEN}/1.0 (+https://agent402.tools/crawler)`), "the browser string keeps the desktop browser's and carries the fetch token");
ok(BROWSER_FETCH_MOBILE_UA.includes("Mobile Safari") && BROWSER_FETCH_MOBILE_UA.includes(FETCH_TOKEN), "the mobile browser string carries the fetch token");
{
  const render = readFileSync(join(ROOT, "src/tools/render.js"), "utf8");
  const stat = readFileSync(join(ROOT, "src/tools/render-static.js"), "utf8");
  ok(!/userAgent:\s*"Mozilla/.test(render) && /const DESKTOP_UA = BROWSER_FETCH_UA;/.test(render) && /userAgent: BROWSER_FETCH_MOBILE_UA/.test(render), "render.js sends only the browser strings that carry the token");
  ok(/STATIC_DESKTOP_UA = BROWSER_FETCH_UA;/.test(stat), "render's no-browser read sends the same string as its browser");
}

// ---------------------------------------------------------------------------
// 2. The caller path: every gated route, booted with a stubbed robots.txt
// ---------------------------------------------------------------------------
const BLOCKED = "https://robots-blocked.example/page";
const OPEN = "https://robots-open.example/page";
const srv = await bootServer({
  stores: "robots-gate",
  args: ["--import", "./scripts/lib/robots-stub-preload.js"],
  env: { FREE_MODE: "true", ROBOTS_STUB: "1", RENDER_STATIC_READ: "on", AGENT402_MCP_MAX_PER_MIN: "999999" },
});
try {
  const spec = await (await fetch(`${srv.url}/openapi.json`)).json();
  const opBySlug = new Map();
  for (const [path, ops] of Object.entries(spec.paths || {})) for (const [method, op] of Object.entries(ops)) {
    const slug = String(path).replace(/^\/api\//, "").replace(/^\/v1\//, "v1-");
    opBySlug.set(slug, { path, method: method.toUpperCase(), op });
  }
  const swapUrls = (v, url) => {
    if (typeof v === "string") return /^https?:\/\//i.test(v.trim()) ? url : v;
    if (Array.isArray(v)) return v.map((x) => swapUrls(x, url));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapUrls(x, url)]));
    return v;
  };
  // A field the published example leaves out reaches the URL read here.
  const EXTRA = { "html-frames": (i) => ({ ...i, compare: { baselineUrl: BLOCKED } }), "image-crop": (i) => { const { dataUri, image, ...rest } = i; return { ...rest, url: BLOCKED }; } };
  async function call(slug, url) {
    const entry = opBySlug.get(slug);
    if (!entry) return { status: 0, body: { error: "not in /openapi.json" } };
    const { path, method, op } = entry;
    if (method === "GET") {
      const q = new URLSearchParams();
      for (const p of op.parameters || []) if (p.in === "query" && p.example !== undefined) q.set(p.name, /^https?:\/\//i.test(String(p.example)) ? url : String(p.example));
      if (!q.has("url")) q.set("url", url);
      const r = await fetch(`${srv.url}${path}?${q}`);
      return { status: r.status, body: await r.json().catch(() => null) };
    }
    let input = swapUrls(op.requestBody?.content?.["application/json"]?.example ?? {}, url);
    if (EXTRA[slug]) input = EXTRA[slug](input);
    else if (!JSON.stringify(input).includes(url)) input = { ...input, url };
    const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  // transcribe-long is listed only while its switch is on (src/tools/stt-kit.js
  // sttLongEnabled); it runs the same handler as transcribe.
  const served = ROBOTS_GATED_SLUGS.filter((s) => opBySlug.has(s));
  const missing = ROBOTS_GATED_SLUGS.filter((s) => !opBySlug.has(s));
  ok(missing.every((s) => s === "transcribe-long"), `every gated tool is served on this boot (${missing.join(", ") || "none missing"})`);
  for (const slug of served) {
    const before = srv.log().length;
    const r = await call(slug, BLOCKED);
    const after = srv.log().slice(before);
    ok(r.status === 403 && r.body?.reason === "robots_disallowed" && r.body?.rule === "Disallow: /", `${slug}: a disallowed URL answers 403 robots_disallowed (${r.status} ${r.body?.reason || r.body?.error || ""})`);
    ok(!after.includes("[robots-stub] content fetch robots-blocked.example"), `${slug}: the disallowed page is never fetched`);
  }
  ok(srv.log().includes("[robots-stub] robots robots-blocked.example"), "the gate read the stubbed robots.txt");

  // An allowed page is served as before; read twice, it is fetched twice.
  for (const slug of ["extract", "render", "page-change", "meta"]) {
    const before = srv.log().length;
    const a = await call(slug, OPEN);
    const b = await call(slug, OPEN);
    const fetches = (srv.log().slice(before).match(/\[robots-stub\] content fetch robots-open\.example/g) || []).length;
    ok(a.status === 200 && b.status === 200, `${slug}: an allowed URL is served (${a.status}, ${b.status}${a.status === 200 ? "" : ` ${JSON.stringify(a.body).slice(0, 300)}`})`);
    ok(fetches >= 2, `${slug}: two calls fetch the page twice, nothing kept between them (${fetches} fetches)`);
    ok(JSON.stringify(a.body) !== JSON.stringify(b.body), `${slug}: the second answer is the page as it is now, not a kept copy`);
  }
} finally {
  await srv.stop();
}

// ---------------------------------------------------------------------------
// 3. Retention, by reading the code
// ---------------------------------------------------------------------------
ok(Array.isArray(ROBOTS_GATED_SLUGS) && ROBOTS_GATED_SLUGS.length > 0, `the gated list is published (${ROBOTS_GATED_SLUGS.length} tools)`);
for (const route of Object.keys(CACHEABLE_ROUTES)) {
  const slug = route.replace(/^\/api\//, "");
  if (ROBOTS_GATED_SLUGS.includes(slug)) ok(false, `${route} is a gated tool in the shared response cache`);
}
ok(true, "no gated tool is in the shared response cache (src/cache.js CACHEABLE_ROUTES)");
const GATED_MODULES = [
  "src/tools/extract.js", "src/tools/pdf.js", "src/tools/pdf-kit.js", "src/tools/pdf-summarize-kit.js", "src/tools/render.js", "src/tools/render-static.js",
  "src/tools/page-change-kit.js", "src/tools/media-kit.js", "src/tools/ocr-kit.js", "src/tools/image-kit.js", "src/tools/stt-kit.js",
  "src/tools/browser-measure-kit.js", "src/tools/crawl-kit.js", "src/tools/enrich-kit.js", "src/tools/robots-gate.js",
];
const STORE_IMPORT = /from\s+"[./]*(?:cache|state-db|json-document|lazy-redis|journal|ledger-journal)\.js"|from\s+"redis"|\bwriteFileSync\b|\bwriteFile\(|\bappendFile|\bcreateWriteStream\b/;
for (const f of GATED_MODULES) {
  const src = readFileSync(join(ROOT, f), "utf8");
  const m = src.match(STORE_IMPORT);
  // The OCR kit writes its language data (not caller content) to a tmp cache
  // directory, and the media kit hands bytes to ffmpeg through a tmp file it
  // deletes in the same call; both are checked by name below.
  const allowed = m && ((f.endsWith("ocr-kit.js") && /TESS_CACHE_DIR/.test(src)) || (f.endsWith("media-kit.js") && /\bunlink|rm\(/.test(src)) || (f.endsWith("stt-kit.js") && /\bunlink|rm\(/.test(src)));
  ok(!m || allowed, `${f} keeps no fetched content in a store or file${m ? ` (${m[0]}${allowed ? ", a per-call temp file removed in the call" : ""})` : ""}`);
}
{
  const gateSrc = readFileSync(join(ROOT, "src/tools/robots-gate.js"), "utf8");
  ok(/cache\.set\(origin, \{ groups, expires/.test(gateSrc) && !/cache\.set\([^)]*html/.test(gateSrc), "the robots gate keeps rules only, never a page");
}

// The caller-URL clause on /terms and the reads it exempts, the same on
// /terms and /crawler (one list, src/tools/robots-gate.js).
{
  const { termsPage } = await import("../src/terms.js");
  const { crawlerPage } = await import("../src/crawler-page.js");
  const { ROBOTS_UNGATED_READS } = gate;
  const flat = (h) => h.replace(/\s+/g, " ");
  const terms = flat(termsPage("https://agent402.tools"));
  const crawler = flat(crawlerPage("https://agent402.tools"));
  const sec = /<h2 id="caller-urls">URLs you ask us to fetch<\/h2>([\s\S]*?)<h2/.exec(terms)?.[1] || "";
  ok(sec.length > 0, "/terms carries the caller-URL section");
  ok(/you represent that you have the right to access the content/.test(sec) && /robots\.txt, and we do not fetch a path it disallows for our fetch token; such a call answers 403/.test(sec), "the section states the caller's right to the content and the robots rule");
  ok(typeof ROBOTS_UNGATED_READS === "string" && ROBOTS_UNGATED_READS.length > 20 && sec.includes(ROBOTS_UNGATED_READS) && crawler.includes(ROBOTS_UNGATED_READS), "/terms and /crawler name the same reads that do not read robots.txt first");
  ok(!/Every tool that returns a page's content/.test(crawler), "/crawler does not state the rule without its exceptions");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
