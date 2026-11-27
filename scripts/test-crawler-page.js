#!/usr/bin/env node
// /crawler says what the index crawler reads and how robots.txt applies to each
// read. This drives the REAL crawl (src/x402-index.js, through its
// __setCrawlFetchForTest seam) against stub origins and checks the page's
// claims against what was fetched:
//   - with a manifest, robots "User-agent: *  Disallow: /" still lets the
//     manifest and /openapi.json be read;
//   - a rule naming Agent402 stops /openapi.json but never the manifest;
//   - with no manifest, /agents.json and /llms.txt are tried, and a blanket
//     Disallow stops them;
// and, from the source, that every raw 402 probe sends the probe User-Agent
// the page quotes, and that the robots token the page names is the crawler's.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { decodeEntities, stripTags, stripInlineTags } from "./lib/html-text.js";
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "crawler-page-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const idx = await import("../src/x402-index.js");
const { crawlerPage, CRAWLER_UA, ROBOTS_TOKEN } = await import("../src/crawler-page.js");
const UA = await import("../src/user-agents.js");
const { crawlIntervalLabel } = await import("../src/crawl-cadence.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const html = crawlerPage("https://agent402.tools", { unpaidQuoteBudget: 0 });
const text = decodeEntities(stripTags(stripInlineTags(html))).replace(/\s+/g, " ");

// ---- the seller's cadence hint is documented as built -------------------------
{
  const { REVISIT_HINT_FIELD, REVISIT_CAP_MS } = await import("../src/seller-load.js");
  ok(REVISIT_CAP_MS > 0 && text.includes(`add a top-level "${REVISIT_HINT_FIELD}" to your manifest at /.well-known/x402`) && /It only ever lengthens our wait/.test(text),
    "the page documents the manifest's revisit hint by the field the crawl reads, and that it only lengthens the wait");
}

// ---- the page's identity strings are the crawler's ---------------------------
const idxSrc = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
const mppSrc = readFileSync(new URL("../src/mpp-index.js", import.meta.url), "utf8");
ok(CRAWLER_UA === UA.CRAWLER_UA && text.includes(UA.CRAWLER_UA), "the page quotes the crawler's User-Agent (src/user-agents.js)");
for (const { token, ua } of UA.SELLER_FACING_USER_AGENTS) ok(text.includes(ua), `the page lists ${token}'s full User-Agent`);
ok(new Set(UA.SELLER_FACING_USER_AGENTS.map((u) => u.ua)).size === UA.SELLER_FACING_USER_AGENTS.length, "every component's User-Agent is distinct");
ok(UA.SELLER_FACING_USER_AGENTS.every((u) => u.ua !== UA.RETIRED_BARE_UA && u.ua.includes(UA.INFO_URL)), "none is the bare Agent402/1.0, and each links to /crawler");
ok(text.includes(`No request to a site in our index, or to a URL a caller names, carries the older ${UA.RETIRED_BARE_UA} token`), "the page says the older token never reaches a seller or a caller's URL (scoped: test-user-agents pins where it remains)");

// ---- every figure on the page and in its changelog entries comes from code ----------
{
  const { spanLabel, LIVE_QUOTE_MAX_AGE_MS, slowOriginIntervalLabel } = await import("../src/crawl-cadence.js");
  const SL = await import("../src/seller-load.js");
  for (const [what, ms] of [["revisit cap", SL.REVISIT_CAP_MS], ["default hold", SL.THROTTLE_DEFAULT_MS], ["longest hold", SL.THROTTLE_MAX_MS], ["request log", SL.REQUEST_LOG_KEEP_MS], ["price re-read", LIVE_QUOTE_MAX_AGE_MS]]) {
    ok(text.includes(spanLabel(ms)), `the page prints the ${what} from code (${spanLabel(ms)})`);
  }
  ok(text.includes(`about ${SL.DAILY_BUDGET.toLocaleString("en-US")} requests a day to one site on its own account (a crawl already under way finishes its reads)`) && text.includes(slowOriginIntervalLabel()), "the daily budget and the slow cycle are printed from code");
  // The per-route interval (scripts/test-route-probe-interval.js drives it).
  {
    const { ROUTE_PROBE_MIN_INTERVAL_MS } = await import("../src/crawl-cadence.js");
    ok(ROUTE_PROBE_MIN_INTERVAL_MS > 0 && text.includes(`Whatever makes a route due, the scheduled crawl sends it this price request at most once in ${spanLabel(ROUTE_PROBE_MIN_INTERVAL_MS)}, with one more try on the next crawl when the first got a server error, a redirect or no answer.`), "the page states the per-route interval and its one retry, from code");
    ok(text.includes(`is one request to its cheapest paid route, on a rotation across the index. When that route refuses the shape of our request, the check is not repeated for ${spanLabel(ROUTE_PROBE_MIN_INTERVAL_MS)}.`), "and what the paywall check sends, with the wait after a refusal of our request's shape");
  }
  ok(text.includes(`The unpaid price checks take at most ${SL.probeShareLabel()} of that`) && text.includes("counted apart and never use that allowance"), "the probes' share and the registration reads' own count are stated, from code");
  // The rule for requests that follow a redirect onto another site
  // (src/seller-load.js landingGate; scripts/test-crawl-redirect-budget.js
  // holds the code to it): the page states it, with the figure from code.
  ok(text.includes(`Every request that follows such a move to the other site, a document read or a price check, is held to ${SL.DAILY_BUDGET.toLocaleString("en-US")} more a day there, apart from that site's own allowance: past it those requests are not sent until the next day, and the moved site's listing stays as it was.`), "the page states the allowance for requests that follow a moved site's documents, from code");
  ok(!text.includes("a separate allowance of the same size"), "the earlier wording of that allowance is gone");
  // Typed figures: the prose of the page module and of the changelog's
  // seller-request entries, with every \${...} interpolation removed, names no
  // count of time or requests in digits or words.
  const TYPED = /\b(\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|a|an)[ -](second|minute|hour|day|week|request)s?\b/gi;
  // A rate's unit ("in an hour", "a day") and "one request made for one
  // caller" are not figures the code could change.
  const ALLOW = new Set(["a day", "a request", "a minute", "an hour", "one request"]);
  const stripInterp = (src) => src.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  const pageSrc = readFileSync(new URL("../src/crawler-page.js", import.meta.url), "utf8");
  const sections = stripInterp(pageSrc.slice(pageSrc.indexOf("const SECTIONS = ["), pageSrc.indexOf("export function crawlerPage")));
  const typedPage = [...sections.matchAll(TYPED)].map((m) => m[0]).filter((m) => !ALLOW.has(m.toLowerCase()));
  ok(typedPage.length === 0, `no figure is typed into the page's prose (${typedPage.join(", ") || "none"})`);
  const clSrc = readFileSync(new URL("../src/changelog.js", import.meta.url), "utf8");
  const TITLES = ["Our requests to sellers name themselves and back off", "Price reads keep their weekly clock, and the router never uses up a seller's crawl"];
  const blocks = [...clSrc.matchAll(/title: "([^"]*)",\s*items: \[([\s\S]*?)\n {4}\],/g)].filter((b) => TITLES.includes(b[1]));
  ok(blocks.length === TITLES.length, `the changelog's seller-request entries are found (${blocks.length})`);
  const typedCl = blocks.flatMap((b) => [...stripInterp(b[2]).matchAll(TYPED)].map((m) => `${b[1]}: ${m[0]}`)).filter((m) => !ALLOW.has(m.split(": ").pop().toLowerCase()));
  ok(typedCl.length === 0, `no figure is typed into those entries (${typedCl.join("; ") || "none"})`);
}
ok(/const ROBOTS_UA = CRAWLER_TOKEN;/.test(idxSrc) && ROBOTS_TOKEN === UA.CRAWLER_TOKEN && text.includes(`product token ${ROBOTS_TOKEN}`), `robots.txt rules are matched on the token the page names (${ROBOTS_TOKEN})`);
// Every unpaid 402 probe goes through probePublicUrl (src/tools/fetch-guard.js),
// which sets the crawler User-Agent; neither index makes a raw fetch to a seller.
const guardSrc = readFileSync(new URL("../src/tools/fetch-guard.js", import.meta.url), "utf8");
const probeFn = guardSrc.slice(guardSrc.indexOf("export async function probePublicUrl"), guardSrc.indexOf("export async function retryTransient"));
ok(/userAgent: USER_AGENT = PROBE_UA \}/.test(probeFn) && /headers: \{ "User-Agent": USER_AGENT, \.\.\.headers \}/.test(probeFn), "probePublicUrl sends the probe User-Agent unless its caller names another");
for (const [name, src] of [["x402-index.js", idxSrc], ["mpp-index.js", mppSrc]]) {
  const raw = [...src.matchAll(/await fetch\((target|url), \{/g)].length;
  // x402-index.js routes its per-route probes through probeSellerRoute, whose
  // one request primitive (probeFetch) is probePublicUrl; a direct call counts
  // the same way. Either shape means the guard and the crawler User-Agent.
  const direct = [...src.matchAll(/await probePublicUrl\(/g)].length;
  const viaSeller = [...src.matchAll(/await probeSellerRoute\(/g)].length;
  const seam = /let probeFetch = \(url, opts\) => probePublicUrl\(url, opts\);/.test(src) ? 1 : 0;
  const probes = direct + (viaSeller > 0 && seam ? viaSeller : 0);
  ok(raw === 0 && probes > 0, `${name}: every 402 probe (${probes}) goes through probePublicUrl and none is a raw fetch (${raw}), so "on every request" holds`);
  ok(/^import \{ safeFetch, probePublicUrl\b[^}]*\} from "\.\/tools\/fetch-guard\.js";/m.test(src), `${name} imports the probe statically from fetch-guard.js`);
}
ok(text.includes(`re-reads an origin ${crawlIntervalLabel()}`), "the re-crawl cadence is derived (crawl-cadence.js)");
ok(!/That is all|2026-09-21|same effect|honours robots\.txt, including for the discovery paths/.test(text), "no stale or overstated claims (complete-list, dated history, robots-as-removal)");

// ---- drive the crawl --------------------------------------------------------
const served = new Map();
const fetched = [];
const sentAs = new Set();
idx.__setCrawlFetchForTest(async (url, opts) => {
  fetched.push(url);
  sentAs.add(opts?.userAgent);
  const hit = served.get(url);
  if (hit === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: typeof hit === "string" ? hit : JSON.stringify(hit), finalUrl: url, validators: null };
});
const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifest = (o) => ({ x402Version: 2, name: "Seller", resources: [{ resource: `${o}/api/thing`, method: "GET", description: "A thing.", price: "$0.005", accepts }] });
const openapi = (o) => ({ openapi: "3.1.0", info: { title: "Seller" }, servers: [{ url: o }], paths: { "/api/thing": { get: { operationId: "thing", summary: "A thing", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.005" } } } } } });
async function crawl(origin, files) {
  for (const [p, body] of Object.entries(files)) served.set(`${origin}${p}`, body);
  idx.__resetRobotsCacheForTest();
  fetched.length = 0;
  await idx.__crawlSellerForTest(origin);
  return fetched.filter((u) => u.startsWith(origin)).map((u) => u.slice(origin.length));
}

{
  const O = "https://blanket.example.invalid";
  const paths = await crawl(O, { "/robots.txt": "User-agent: *\nDisallow: /\n", "/.well-known/x402": manifest(O), "/openapi.json": openapi(O) });
  ok(paths.includes("/robots.txt") && paths.includes("/.well-known/x402"), `blanket Disallow: robots.txt and the manifest are read (${paths.join(", ")})`);
  ok(paths.includes("/openapi.json"), "blanket Disallow + a published manifest: /openapi.json is read, as the page says");
}
{
  const O = "https://names-us.example.invalid";
  const paths = await crawl(O, { "/robots.txt": `User-agent: ${ROBOTS_TOKEN}\nDisallow: /\n`, "/.well-known/x402": manifest(O), "/openapi.json": openapi(O) });
  ok(paths.includes("/.well-known/x402"), "a rule naming Agent402: the manifest is still read, as the page says");
  ok(!paths.includes("/openapi.json"), `a rule naming Agent402 stops /openapi.json (${paths.join(", ")})`);
}
{
  const O = "https://names-legacy.example.invalid";
  const paths = await crawl(O, { "/robots.txt": "User-agent: Agent402\nDisallow: /\n", "/.well-known/x402": manifest(O), "/openapi.json": openapi(O) });
  ok(!paths.includes("/openapi.json"), `a group for the shorter token Agent402 still applies to the crawler (${paths.join(", ")})`);
}
ok(sentAs.size === 1 && sentAs.has(UA.CRAWLER_UA), "every crawler read asks for the crawler's own User-Agent");
{
  const O = "https://no-manifest.example.invalid";
  const paths = await crawl(O, { "/robots.txt": "User-agent: *\nAllow: /\n", "/llms.txt": `# Seller\n\n- [Thing](${O}/api/thing): a thing, $0.01\n` });
  ok(["/robots.txt", "/.well-known/x402", "/openapi.json", "/agents.json", "/llms.txt"].every((p) => paths.includes(p)),
    `no manifest: the crawler tries /openapi.json, then /agents.json, then /llms.txt (${paths.join(", ")})`);
  for (const p of ["/robots.txt", "/.well-known/x402", "/openapi.json", "/agents.json", "/llms.txt"]) ok(text.includes(p), `the page names ${p}`);
}
{
  const O = "https://no-manifest-blocked.example.invalid";
  const paths = await crawl(O, { "/robots.txt": "User-agent: *\nDisallow: /\n", "/agents.json": { endpoints: [] }, "/llms.txt": "# x\n" });
  ok(!paths.includes("/agents.json") && !paths.includes("/llms.txt") && !paths.includes("/openapi.json"),
    `no manifest + blanket Disallow: /openapi.json, /agents.json and /llms.txt are not read (${paths.join(", ")})`);
}
ok(/SUCCESSION_PATH = "\/\.well-known\/agent402-succession"/.test(idxSrc) && text.includes("/.well-known/agent402-succession"), "the succession marker the crawler reads is named");

rmSync(dir, { recursive: true, force: true });
// ---- the unpaid budget is per address, whatever the User-Agent ----------------
// The sentences the address-keyed budget (src/unpaid-quote-budget.js) relies
// on: a reader must not take a fresh User-Agent for a fresh budget, and named
// crawlers read a larger allowance on the same address count.
{
  const { NAMED_CLIENT_BUDGET_MULTIPLIER } = await import("../src/unpaid-quote-budget.js");
  const budget = 250;
  const on = decodeEntities(stripTags(stripInlineTags(crawlerPage("https://agent402.tools", { unpaidQuoteBudget: budget })))).replace(/\s+/g, " ");
  ok(on.includes("budgeted per client address, whatever the User-Agent (an IPv6 /64 counts as one address"), "/crawler says the unpaid budget counts per address, whatever the User-Agent");
  ok(on.includes("on the one address Cloudflare Workers share, each User-Agent gets its own budget under a ceiling for the address"), "/crawler names the shared Worker address exception");
  ok(on.includes(`against ${(budget * NAMED_CLIENT_BUDGET_MULTIPLIER).toLocaleString("en-US")} unpaid requests per address in an hour, on the same count as everything else from that address`), "/crawler quotes the named-crawler allowance on the same address count, derived from the multiplier");
  ok(!/per User-Agent/i.test(on) && !/crawlers are not budgeted/i.test(on), "/crawler never says the budget is per User-Agent or that named crawlers are exempt");
  ok(!/whatever the User-Agent/.test(text), "with the budget off, no per-address budget is claimed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
