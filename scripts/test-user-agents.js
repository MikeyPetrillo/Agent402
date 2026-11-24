#!/usr/bin/env node
// Each component that sends requests to a host we do not run names itself
// with its own User-Agent (src/user-agents.js), so a seller can tell our index
// crawler, our price probes, a purchase our router makes for a paying caller
// and a fetch a caller of our catalog asked for apart in its logs. Pinned by
// what each one actually sends, with the network stubbed:
//   - safeFetch sends the fetch string unless its caller names another;
//     probePublicUrl sends the probe string unless its caller names another;
//   - the caller-driven fetch tools (http-check, http-headers, x402-quote,
//     x402-audit, unshorten-url) send the fetch string;
//   - the router's model-list read and its purchase send the router string;
//   - the index and MPP index crawls ask for the crawler string, and their
//     probes for the probe string (the crawl itself in test-crawl-revisit.js);
//   - no file sends the bare `Agent402/1.0`;
//   - each of those requests is counted, per host and component, in the
//     request log /crawler says we keep (src/seller-load.js): the catalog's
//     fetches, the site-crawl tool and the router's purchase included.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
const UA = await import("../src/user-agents.js");
const { safeFetch, probePublicUrl } = await import("../src/tools/fetch-guard.js");
const { readFileSync, readdirSync } = await import("node:fs");
const { isHost } = await import("./lib/url-host.js");
const { sellerLoad } = await import("../src/seller-load.js");
/** Requests the request log holds for `host` from component `kind`. */
const logged = async (host, kind) => (await sellerLoad.requestLog(host)).rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.requests, 0);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---- the list ---------------------------------------------------------------------
const all = UA.SELLER_FACING_USER_AGENTS;
ok(new Set(all.map((u) => u.ua)).size === all.length && new Set(all.map((u) => u.token)).size === all.length, "every component has its own User-Agent and product token");
ok(all.every((u) => u.ua.includes(UA.INFO_URL) && u.ua.includes(`${u.token}/1.0`)), "each names its token and links to /crawler");
ok([UA.CRAWLER_UA, UA.PROBE_UA, UA.ROUTER_UA, UA.FETCH_UA].every((s) => s.startsWith("Mozilla/5.0 (compatible; ")), "the crawler, probe, router and fetch strings keep the browser-compatible form");
ok(all.every((u) => u.ua !== UA.RETIRED_BARE_UA), "none is the bare Agent402/1.0");

// ---- what each sends ----------------------------------------------------------------
const orig = globalThis.fetch;
const seen = [];
const uaOf = (init) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get("user-agent") ?? undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === "user-agent") return v;
  return undefined;
};
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), ua: uaOf(init) });
  return new Response(JSON.stringify({ ok: true }), { status: 402, headers: { "content-type": "application/json" } });
};
const last = () => seen.at(-1)?.ua;
try {
  const fetchesBefore = await logged("fetched-for-caller.example.com", "fetch");
  await safeFetch("https://fetched-for-caller.example.com/doc").catch(() => null);
  ok(last() === UA.FETCH_UA, "safeFetch sends the fetch string by default");
  ok((await logged("fetched-for-caller.example.com", "fetch")) - fetchesBefore === 1, "and the request log counts it for the host as a catalog fetch");
  await safeFetch("https://seller.example.com/doc", { userAgent: UA.CRAWLER_UA }).catch(() => null);
  ok(last() === UA.CRAWLER_UA, "and the string its caller names");
  await probePublicUrl("https://seller.example.com/paid");
  ok(last() === UA.PROBE_UA, "probePublicUrl sends the probe string by default");
  await probePublicUrl("https://seller.example.com/paid", { userAgent: UA.ROUTER_UA });
  ok(last() === UA.ROUTER_UA, "and the router's when the router asks");
  await probePublicUrl("https://seller.example.com/paid", { headers: { "User-Agent": "x" } });
  ok(last() === "x", "a caller header still wins, as before");

  // Caller-driven fetch tools.
  const kits = await Promise.all(["kit.js", "x402-kit.js", "web-kit.js", "network-kit2.js"].map((f) => import(`../src/tools/${f}`)));
  const tools = kits.flatMap((m) => Object.values(m).filter(Array.isArray).flat()).filter((t) => t && typeof t === "object" && typeof t.handler === "function");
  const bySlug = (s) => tools.find((t) => t.slug === s);
  for (const [slug, input] of [
    ["http-check", { url: "https://caller-named.example.com/" }],
    ["http-headers", { url: "https://caller-named.example.com/" }],
    ["x402-quote", { url: "https://caller-named.example.com/paid" }],
    ["x402-audit", { url: "https://caller-named.example.com/paid" }],
    ["unshorten-url", { url: "https://caller-named.example.com/s" }],
  ]) {
    const tool = bySlug(slug);
    if (!tool) { ok(false, `${slug} is in the catalog`); continue; }
    const before = seen.length;
    const loggedBefore = await logged("caller-named.example.com", "fetch");
    await tool.handler(input).catch(() => null);
    const sent = seen.slice(before).filter((r) => isHost(r.url, "caller-named.example.com"));
    ok(sent.length > 0 && sent.every((r) => r.ua === UA.FETCH_UA), `${slug} sends the fetch string to the URL its caller named (${sent.length} request(s))`);
    const n = (await logged("caller-named.example.com", "fetch")) - loggedBefore;
    ok(n === sent.length, `and the request log counts each of them for the host as a catalog fetch (${n} of ${sent.length})`);
  }

  // The site-crawl tool: its own string, and its requests in the log.
  {
    const { CRAWL_TOOLS } = await import("../src/tools/crawl-kit.js");
    const crawl = CRAWL_TOOLS.find((t) => t.slug === "site-crawl");
    const before = seen.length;
    const loggedBefore = await logged("crawl-me.example.com", "site-crawl");
    await crawl.handler({ url: "https://crawl-me.example.com/", maxPages: 2 }).catch(() => null);
    const sent = seen.slice(before).filter((r) => isHost(r.url, "crawl-me.example.com"));
    ok(sent.length > 0 && sent.every((r) => r.ua === UA.SITE_CRAWL_UA), `site-crawl sends its own string (${sent.length} request(s))`);
    const n = (await logged("crawl-me.example.com", "site-crawl")) - loggedBefore;
    ok(n === sent.length, `and the request log counts each of them for the host (${n} of ${sent.length})`);
  }
  // safeFetch for the index crawler is counted where the crawl budgets it,
  // never twice here.
  {
    const b = await logged("seller.example.com", "fetch");
    await safeFetch("https://seller.example.com/doc", { userAgent: UA.CRAWLER_UA }).catch(() => null);
    ok((await logged("seller.example.com", "fetch")) === b, "a crawler read through safeFetch is not logged as a catalog fetch");
  }

  // A deployment that sets NETWORK_KIT_USER_AGENT keeps it on the caller-named
  // fetches of http-headers and tech-stack (a fresh module instance reads it).
  process.env.NETWORK_KIT_USER_AGENT = "Operator-Set/2.0";
  try {
    const nk = await import("../src/tools/network-kit2.js?ua=operator");
    const nkTools = Object.values(nk).filter(Array.isArray).flat().filter((t) => t && typeof t.handler === "function");
    for (const slug of ["http-headers", "tech-stack"]) {
      const tool = nkTools.find((t) => t.slug === slug);
      const before = seen.length;
      await tool?.handler({ url: "https://caller-named.example.com/" }).catch(() => null);
      const sent = seen.slice(before).filter((r) => isHost(r.url, "caller-named.example.com"));
      ok(sent.length > 0 && sent.every((r) => r.ua === "Operator-Set/2.0"), `${slug} sends NETWORK_KIT_USER_AGENT when the deployment sets it (${sent.length} request(s))`);
    }
  } finally { delete process.env.NETWORK_KIT_USER_AGENT; }

  // The router's model-list read, inside a paying caller's purchase.
  const { sellerServesModel, ROUTER_UA } = await import("../src/x402-buyer.js");
  ok(ROUTER_UA === UA.ROUTER_UA, "the buyers' ROUTER_UA is the one in the list");
  let modelInit = null;
  await sellerServesModel("https://router-seller.example.com/v1/chat/completions", "m-1", { fetchImpl: async (u, init) => { modelInit = init; return new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 }); } });
  ok(uaOf(modelInit) === UA.ROUTER_UA && modelInit?.headers?.["X-Agent402-Via"] === "router", "the router's model-list read sends the router string and says it is the router");
  ok((await logged("router-seller.example.com", "router-buy")) === 1, "and the request log counts it for the host as the router's purchase");
} finally {
  globalThis.fetch = orig;
}

// ---- from the source ------------------------------------------------------------------
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const idx = src("x402-index.js"), mpp = src("mpp-index.js");
// The crawl's document reads have one sender, crawlRead's call of crawlFetch.
// Its options name the crawler string after the caller's are spread, and
// nothing later in them (another spread, a second userAgent) can replace it;
// what else the call carries (a redirect hook) is not this pin's business.
{
  const calls = idx.match(/\bcrawlFetch\([^\n]*/g) || [];
  const rest = /^crawlFetch\(url, \{ \.\.\.opts, userAgent: CRAWLER_UA(?=[ ,}])([^\n]*)$/.exec(calls[0] || "")?.[1];
  ok(calls.length === 1 && typeof rest === "string" && !/\.\.\.|userAgent|user-agent/i.test(rest), `every x402 index document read asks for the crawler string (crawlRead; ${calls.length} crawlFetch call)`);
}
ok((idx.match(/safeFetch\([^;]*\)/g) || []).filter((c) => !/crawlFetch|safeFetch\(url, opts\)/.test(c)).every((c) => c.includes("userAgent: CRAWLER_UA")), "the index's other reads (registries, succession markers) send the crawler string");
ok(/let probeFetch = \(url, opts\) => probePublicUrl\(url, opts\);/.test(idx), "the index's probes go through probePublicUrl, so they send the probe string");
ok((mpp.match(/safeFetch\([^)]/g) || []).length > 0 && (mpp.match(/safeFetch\([^)]/g) || []).length === (mpp.match(/userAgent: CRAWLER_UA/g) || []).length, "every MPP index read sends the crawler string");
const server = src("server.js");
ok((server.match(/userAgent: ROUTER_UA/g) || []).length === 2, "the router's pre-payment probe and the operator's diagnosis probe send the router string");
ok(/import \{ ROUTER_UA \} from "\.\/x402-buyer\.js"|"user-agent": ROUTER_UA/.test(src("tempo-buyer.js")), "the Tempo buyer sends the router string");
// Every request the buyers send a seller is in the request log: each fetch of
// the seller's URL follows a noteHostRequest(url, "router-buy") line.
for (const f of ["x402-buyer.js", "tempo-buyer.js"]) {
  const lines = src(f).split("\n");
  const sends = lines.map((l, i) => [l, i]).filter(([l]) => /\bawait fetch\(url,/.test(l));
  const unlogged = sends.filter(([, i]) => !/noteHostRequest\(url, "router-buy"\)/.test(lines[i - 1] || ""));
  ok(sends.length >= 2 && unlogged.length === 0, `every purchase request in ${f} is counted in the request log (${sends.length} sends${unlogged.length ? `; not counted at lines ${unlogged.map(([, i]) => i + 1).join(", ")}` : ""})`);
}
const files = [];
const walk = (dir) => { for (const e of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) { if (e.isDirectory()) walk(`${dir}/${e.name}`); else if (e.name.endsWith(".js")) files.push(`${dir}/${e.name}`); } };
walk("src");
const bare = files.filter((f) => /["'`]Agent402\/1\.0["'`]/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) && f !== "src/user-agents.js");
ok(bare.length === 0, `no file sends the bare Agent402/1.0 (${bare.join(", ") || "none"})`);
// The older `Agent402/1.0` product token survives only in kits that call one
// data provider's fixed API (never a seller, never a URL a caller names), which
// is what /crawler says. A new file that sends it, or one of these that starts
// fetching a caller's URL with it, is a change the page has to follow.
const VENDOR_ONLY = new Set(["src/tools/x-data-kit.js", "src/tools/enrich-kit.js", "src/tools/b2b-enrich-kit.js", "src/tools/network-kit2.js", "src/tools/cve-kit.js", "src/tools/defi-kit.js", "src/tools/derivatives-kit.js", "src/tools/solana-intel-kit.js", "src/tools/crypto-kit.js", "src/tools/crypto-markets-kit.js", "src/tools/crypto-signals-kit.js"]);
const legacy = files.filter((f) => f !== "src/user-agents.js" && f !== "src/changelog.js" && /Agent402\/1\.0/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));
ok(legacy.length > 0 && legacy.every((f) => VENDOR_ONLY.has(f)), `the Agent402/1.0 token appears only in the vendor-API kits (${legacy.filter((f) => !VENDOR_ONLY.has(f)).join(", ") || "no others"})`);
{
  const nk2 = src("tools/network-kit2.js");
  const uses = [...nk2.matchAll(/"User-Agent": (\w+)/g)].map((m) => m[1]);
  ok(uses.includes("CALLER_FETCH_UA") && uses.filter((u) => u === "USER_AGENT").length === 1 && /async function fetchJson\(url, label(?:, extraHeaders = \{\})?\)/.test(nk2) && ![...nk2.matchAll(/fetchJson\([^;]*?\)/g)].some((m) => /User-Agent/i.test(m[0])), "network-kit2 sends its vendor string only from fetchJson (fixed data APIs; a caller of it adds no User-Agent); caller-named fetches send the fetch string or the deployment's own");
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
