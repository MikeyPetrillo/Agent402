// /robots.txt encodes Agent402's crawl posture: every major LLM crawler is
// *explicitly* allowed (because the catalog is FOR them), while the paths that
// are private, bearer-scoped or retired are refused to all of them.
//
// THIS TEST ASSERTS THE OUTCOME, NOT THE TEXT, and the reason is a live defect
// it would have caught. A crawler obeys the one group that names it and no
// other (RFC 9309). Each named agent used to get `User-agent: X / Allow: /`
// plus three rules, while the fourteen private disallows lived only under
// `User-agent: *` - so none of them reached a named crawler, and the
// wallet-keyed memory rows, the receipt pages and the proof-of-work challenge
// endpoint were crawlable by every search and AI bot we welcome. A rule added
// specifically to stop one of those crawls had no effect on the crawler it was
// written for. The old test looked for `Disallow: /api/memory` with a regex,
// anywhere in the file, and passed the whole time: it never worked out which
// group a named bot follows. So the checks below run the repo's OWN robots
// parser (parseRobots/robotsAllows, src/tools/kit.js - the same code our
// crawler obeys on other people's sites) over the SERVED document and ask what
// each named agent is actually allowed to fetch. A control proves the check
// can fail: the old grouping is rebuilt in memory and must come out permissive.
//
// Locked here:
//   1. Content-type is text/plain (otherwise crawlers do not trust it).
//   2. Every documented LLM crawler has its own group with an explicit Allow: /.
//   3. Googlebot, Bingbot, GPTBot and ClaudeBot are REFUSED the private paths
//      and still ALLOWED the catalog pages and the machine-readable surfaces.
//   4. An unnamed crawler gets the same refusals from the wildcard group.
//   5. Nothing listed in the sitemap is disallowed to a named crawler (the
//      failure this change could introduce, in the other direction).
//   6. The sitemap reference and the machine-readable catalogs hint survive.
//
//   node scripts/test-robots-policy.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { parseRobots, robotsAllows } from "../src/tools/kit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch { /* gone */ } process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env, FREE_MODE: "true", PORT: String(PORT),
    X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off",
    MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
  },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 180; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  const res = await fetch(`${BASE}/robots.txt`);
  ok(res.status === 200, `/robots.txt -> 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("text/plain"), `content-type is text/plain (got ${res.headers.get("content-type")})`);
  const txt = await res.text();
  const groups = parseRobots(txt);
  const allows = (ua, path) => robotsAllows(groups, ua, path).allowed;

  // Every documented LLM crawler. If one of these silently drops, the catalog
  // is invisible to that crawler - losing reach to a sizable audience.
  const LLM_BOTS = [
    "GPTBot",            // OpenAI
    "OAI-SearchBot",     // OpenAI search
    "ChatGPT-User",      // ChatGPT user-triggered
    "ClaudeBot",         // Anthropic
    "anthropic-ai",      // Anthropic
    "PerplexityBot",     // Perplexity
    "Google-Extended",   // Gemini training
    "Applebot-Extended", // Apple Intelligence
    "CCBot",             // Common Crawl (LLM training data)
    "Bytespider",        // ByteDance
    "Amazonbot",         // Amazon
    "cohere-ai",         // Cohere
    "Meta-ExternalAgent",// Meta AI
    "SmitheryBot",       // registry backlink / listing scanner
  ];
  for (const bot of LLM_BOTS) {
    const re = new RegExp(`User-agent:\\s*${bot}\\s*\\n\\s*Allow:\\s*/`, "i");
    ok(re.test(txt), `robots.txt explicitly Allows ${bot} (own group + Allow: /)`);
  }

  // ---- the outcome, per named crawler -------------------------------------
  // Private or bearer-scoped: a crawler that fetches one of these gets a 4xx,
  // which a search console reports back as a crawl error on a healthy site.
  const REFUSED = [
    ["/api/memory", "wallet-keyed rows, one owner each"],
    ["/api/pow/challenge?slug=hash", "a proof-of-work challenge is not a page"],
    ["/r/x", "a paid report, the session id is the bearer"],
    ["/m/x", "a monitor report, same"],
    ["/__operator", "the operator surfaces"],
    ["/api/buy", "the checkout endpoint"],
    ["/api/convert/json-to-yaml", "a retired namespace, nothing lives there"],
  ];
  // The catalog itself: naming a crawler is a welcome, and it has to stay one.
  const ALLOWED = [
    ["/tools/hash", "a tool page"],
    ["/api/pricing", "the price list"],
    ["/openapi.json", "the OpenAPI document"],
    ["/.well-known/x402", "the x402 manifest"],
    ["/marketplace", "the seller roster"],
    ["/llms.txt", "the agent catalog"],
  ];
  const NAMED = ["Googlebot", "Bingbot", "GPTBot", "ClaudeBot"];
  for (const ua of NAMED) {
    for (const [path, why] of REFUSED) ok(!allows(ua, path), `${ua} is refused ${path} (${why})`);
    for (const [path, why] of ALLOWED) ok(allows(ua, path), `${ua} is allowed ${path} (${why})`);
  }
  // A crawler we do not name follows the wildcard group and gets the same answer.
  for (const [path] of REFUSED) ok(!allows("some-unnamed-bot/1.0", path), `an unnamed crawler is refused ${path}`);
  for (const [path] of ALLOWED) ok(allows("some-unnamed-bot/1.0", path), `an unnamed crawler is allowed ${path}`);

  // CONTROL: the check must be able to fail. Rebuild the old shape - the
  // private rules in the wildcard group only - and the same parser must call
  // it permissive for a named crawler. A green run is only believed once the
  // parser has been shown to catch the defect this test exists for.
  const oldShape = [
    "User-agent: Googlebot", "Allow: /", "Disallow: /api/market/", "",
    "User-agent: *", "Allow: /", "Disallow: /api/memory", "Disallow: /api/pow/", "Disallow: /r/", "",
  ].join("\n");
  const oldGroups = parseRobots(oldShape);
  ok(
    ["/api/memory", "/api/pow/challenge", "/r/x"].every((p) => robotsAllows(oldGroups, "Googlebot", p).allowed),
    "control: with the private rules in the wildcard group only, the parser reports Googlebot allowed (so a regression to that shape fails the checks above)",
  );
  ok(
    ["/api/memory", "/api/pow/challenge", "/r/x"].every((p) => !robotsAllows(oldGroups, "unnamed-bot", p).allowed),
    "control: the same wildcard-only document still refuses an unnamed crawler (the defect is the grouping, not the rules)",
  );

  // Sanity: the refusals are specific, never all of /api.
  ok(!/Disallow:\s*\/api\s*$/m.test(txt), "robots.txt does NOT disallow all of /api (that would block catalog discovery)");
  ok(allows("Googlebot", "/api/find?q=hash") && allows("Googlebot", "/api/reliability"), "the discovery endpoints under /api stay allowed to a named crawler");

  // ---- nothing we ask to be indexed may be refused -------------------------
  // The failure this change could introduce in the other direction: a sitemap
  // that lists a URL robots.txt refuses is a self-inflicted crawl error.
  const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(locs.length > 10, `sitemap.xml lists URLs to check (got ${locs.length})`);
  const blocked = [];
  for (const loc of locs) {
    const p = new URL(loc).pathname;
    for (const ua of NAMED) if (!allows(ua, p)) blocked.push(`${ua} ${p}`);
  }
  ok(blocked.length === 0, `no sitemap URL is disallowed to a named crawler${blocked.length ? `:\n  ${blocked.slice(0, 10).join("\n  ")}` : ""}`);

  // Sitemap reference and the orientation hint.
  ok(txt.includes(`Sitemap: ${BASE}/sitemap.xml`), `robots.txt references Sitemap: ${BASE}/sitemap.xml`);
  ok(txt.includes("/llms.txt") && txt.includes("/openapi.json"), "robots.txt advertises /llms.txt + /openapi.json as machine-readable catalogs");
  ok(/^# Crawling this catalog/m.test(txt) && txt.includes(`${BASE}/crawler`), "robots.txt points crawlers at the crawl policy page");

  console.log(`\n${pass} passed (${LLM_BOTS.length} LLM bots allowed; ${NAMED.length} named crawlers checked by outcome)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
