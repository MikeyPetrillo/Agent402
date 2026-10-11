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
// and, from the source, that every raw 402 probe sends the crawler User-Agent
// the page quotes, and that the robots token the page names is the crawler's.
// Offline: no network, no server.
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "crawler-page-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const idx = await import("../src/x402-index.js");
const { crawlerPage, CRAWLER_UA, ROBOTS_TOKEN } = await import("../src/crawler-page.js");
const { USER_AGENT } = await import("../src/tools/fetch-guard.js");
const { crawlIntervalLabel } = await import("../src/crawl-cadence.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const html = crawlerPage("https://agent402.tools", { unpaidQuoteBudget: 0 });
const text = html.replace(/<\/?(code|a|em|strong)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ---- the page's identity strings are the crawler's ---------------------------
const idxSrc = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
const mppSrc = readFileSync(new URL("../src/mpp-index.js", import.meta.url), "utf8");
ok(CRAWLER_UA === USER_AGENT && text.includes(USER_AGENT), "the page quotes the User-Agent safeFetch sends (src/tools/fetch-guard.js)");
ok(new RegExp(`const ROBOTS_UA = "${ROBOTS_TOKEN}";`).test(idxSrc) && text.includes(`product token ${ROBOTS_TOKEN}`), `robots.txt rules are matched on the token the page names (${ROBOTS_TOKEN})`);
// Every unpaid 402 probe goes through probePublicUrl (src/tools/fetch-guard.js),
// which sets the crawler User-Agent; neither index makes a raw fetch to a seller.
const guardSrc = readFileSync(new URL("../src/tools/fetch-guard.js", import.meta.url), "utf8");
const probeFn = guardSrc.slice(guardSrc.indexOf("export async function probePublicUrl"), guardSrc.indexOf("export async function retryTransient"));
ok(/headers: \{ "User-Agent": USER_AGENT, \.\.\.headers \}/.test(probeFn), "probePublicUrl sends the crawler User-Agent on every probe");
for (const [name, src] of [["x402-index.js", idxSrc], ["mpp-index.js", mppSrc]]) {
  const raw = [...src.matchAll(/await fetch\((target|url), \{/g)].length;
  const probes = [...src.matchAll(/await probePublicUrl\(/g)].length;
  ok(raw === 0 && probes > 0, `${name}: every 402 probe (${probes}) goes through probePublicUrl and none is a raw fetch (${raw}), so "on every request" holds`);
  ok(/^import \{ safeFetch, probePublicUrl \} from "\.\/tools\/fetch-guard\.js";/m.test(src), `${name} imports the probe statically from fetch-guard.js`);
}
ok(text.includes(`re-reads an origin ${crawlIntervalLabel()}`), "the re-crawl cadence is derived (crawl-cadence.js)");
ok(!/That is all|2026-09-21|same effect|honours robots\.txt, including for the discovery paths/.test(text), "no stale or overstated claims (complete-list, dated history, robots-as-removal)");

// ---- drive the crawl --------------------------------------------------------
const served = new Map();
const fetched = [];
idx.__setCrawlFetchForTest(async (url) => {
  fetched.push(url);
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
