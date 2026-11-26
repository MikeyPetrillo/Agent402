// The router lists some outside sellers and never buys from them
// (src/router-listed-only.js), while discovery keeps listing them. What
// this file pins, with synthetic hosts whose digests are injected at runtime
// through ROUTER_EXCLUDED_SELLER_HASHES (no listed seller is named here):
//   (a) the digest scheme is the hashed-names guard's (sha256, first 20 hex,
//       lowercased), a subdomain of a listed domain matches, a lookalike and
//       an unlisted control do not, and the shipped list is digests only;
//   (b) dispatchEligibility: an excluded seller with passing evidence reads
//       listed_only on every chain, with no unproven lane; the control
//       seller with the same evidence is eligible;
//   (c) route-execute refuses the seller at buy time even when the resolver
//       handed it in as dispatchable (the stub buyer records zero buys), and
//       pays the control candidate after it;
//   (d) payX402 and payTempo refuse the seller before any request is sent;
//   (e) a booted server lists the seller on /api/index?seller= with
//       routerDispatchEligible false and reason listed_only, and still
//       ranks it on /api/route?include=external; the control stays eligible;
//   (f) every public surface says only that the router lists the seller and
//       does not buy from it: the legend, the refusal bodies, the seller's
//       index row, the /sell row, the changelog entry and every src/ line
//       that carries the reason give no reason for it.
// Offline: placeholder hosts only, the crawler is off, nothing leaves the machine.
//
//   node scripts/test-router-listed-only.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const EXCLUDED_DOMAIN = "seller-excluded.example";
process.env.ROUTER_EXCLUDED_SELLER_HASHES = ` ${h(EXCLUDED_DOMAIN)} ,not-a-digest`;
process.env.X402_INDEX_CRAWL = "off";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { sellerListedOnly, hostOf, __digestForTests } from "../src/router-listed-only.js";
import { dispatchEligibility, DISPATCH_REASONS } from "../src/dispatch-eligibility.js";
import { buildRouteExecuteTool } from "../src/tools/route-execute.js";

let pass = 0;
// Every public sentence about a listed-only seller, collected as the sections run and read in (f).
const PUBLIC_TEXT = [];
const procs = new Set();
const ok = (c, m) => {
  if (!c) { console.error(`FAIL - ${m}`); for (const p of procs) { console.error(p.log().slice(-2000)); p.child.kill("SIGTERM"); } process.exit(1); }
  pass++; console.log(`ok - ${m}`);
};

const EXCLUDED = `https://api.${EXCLUDED_DOMAIN}`;
const CONTROL = "https://seller-ok.example";

// ------------------------------------------------------------- (a) matching
{
  const gen = readFileSync(new URL("./gen-third-party-hashes.js", import.meta.url), "utf8");
  ok(/createHash\("sha256"\)\.update\(s\)\.digest\("hex"\)\.slice\(0, 20\)/.test(gen) && __digestForTests("abc") === h("abc"), "the list uses the hashed-names guard's digest");
  ok(sellerListedOnly(EXCLUDED_DOMAIN), "the listed registrable domain is excluded");
  ok(sellerListedOnly(`${EXCLUDED}/v1/prices?x=1`) && sellerListedOnly(`https://a.b.${EXCLUDED_DOMAIN}`) && sellerListedOnly(`https://API.${EXCLUDED_DOMAIN.toUpperCase()}.`), "a subdomain, at any depth and any case, is excluded");
  ok(sellerListedOnly(`${EXCLUDED}/prefix`) && sellerListedOnly(`api.${EXCLUDED_DOMAIN}`), "a seller key (origin plus prefix) and a bare host are read");
  ok(!sellerListedOnly(`https://not${EXCLUDED_DOMAIN}`) && !sellerListedOnly(`https://${EXCLUDED_DOMAIN}.evil.example`), "a lookalike or a domain that only contains the name is not excluded");
  ok(!sellerListedOnly(CONTROL) && !sellerListedOnly("") && !sellerListedOnly(null) && !sellerListedOnly({}), "an unlisted control seller and an unreadable ref are not excluded");
  ok(hostOf("https://x.example:8443/p") === "x.example", "the host is read without port or path");
  const src = readFileSync(new URL("../src/router-listed-only.js", import.meta.url), "utf8");
  const listed = src.slice(src.indexOf("const LISTED"), src.indexOf("]);", src.indexOf("const LISTED")));
  const entries = listed.match(/"[^"]*"/g) || [];
  ok(entries.length >= 1 && entries.every((e) => /^"[0-9a-f]{20}"$/.test(e)), `the shipped list holds digests only (${entries.length})`);
  ok(sellerListedOnly(EXCLUDED, { env: {} }) === false, "with the variable unset, the synthetic host is not listed (the injection is what lists it)");
}

// ------------------------------------------------------------- (b) the label
const PASSING = { routable: true, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], settled: 500, payers: 40, priceUsd: 0.01, spendChains: ["base", "solana"], minSettled: 50, minPayers: 3, unprovenMaxUsd: 0.05 };
{
  const c = dispatchEligibility({ ...PASSING, seller: CONTROL });
  ok(c.eligible === true, `the control seller with passing evidence is eligible (${c.reason})`);
  const x = dispatchEligibility({ ...PASSING, seller: EXCLUDED });
  ok(x.eligible === false && x.reason === "listed_only", `the excluded seller with the same evidence is listed_only (${x.reason})`);
  ok(x.chains.base?.reason === "listed_only" && x.chains.solana?.reason === "listed_only" && !x.chains.base.unprovenTier, "...on every chain it advertises, with no unproven lane");
  const thin = dispatchEligibility({ ...PASSING, settled: 0, payers: 0, seller: EXCLUDED });
  ok(thin.reason === "listed_only" && !thin.chains.base?.unprovenTier, "a thin history is not admitted to the unproven lane either");
  ok(dispatchEligibility({ ...PASSING, routable: false, seller: EXCLUDED }).reason === "listed_only", "the reason outranks a failed crawl");
  const row = dispatchEligibility({ ...PASSING, routeText: { route: "/v1/prices", url: `${EXCLUDED}/v1/prices`, description: "prices" } });
  ok(row.reason === "listed_only", "a route row with no explicit seller is read from its own url");
  ok(typeof DISPATCH_REASONS.listed_only === "string" && !/https?:|\.ai\b|\.com\b/.test(DISPATCH_REASONS.listed_only), "listed_only is documented in DISPATCH_REASONS and names no host");
}

// ------------------------------------------------------------- (c) route-execute at buy time
{
  const tier = { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 };
  const row = (origin) => ({ seller: origin, slug: "prices", url: `${origin}/v1/prices`, method: "GET", price: "$0.01", networks: ["eip155:8453"] });
  const run = async (list) => {
    const buys = [];
    const tool = buildRouteExecuteTool({
      getCatalog: () => ({}), tier,
      // The resolver hands the excluded seller in as if its label said dispatchable.
      resolveExternal: async () => list,
      payExternal: async (url) => { buys.push(url); return { result: { ok: 1 }, quote: { usd: 0.01 }, receipt: { transaction: "0xabc" } }; },
      externalEnabled: () => true, externalChains: () => ["base"], spendingWalletStatus: async () => ({ status: "ok" }),
      recordPurchase: () => {}, retractPurchase: () => {},
    });
    let err = null, out = null;
    try { out = await tool.handler({ task: "stock prices", include: "external" }, {}); } catch (e) { err = e; }
    return { buys, err, out };
  };
  const only = await run([row(EXCLUDED)]);
  ok(only.buys.length === 0 && only.err?.statusCode === 409 && /lists that outside seller and does not buy from it/.test(only.err.message) && /Nothing was spent/.test(only.err.message), `an excluded candidate is refused at buy time and nothing is bought (${only.err?.statusCode}: ${only.err?.message})`);
  ok(!only.err.message.includes(EXCLUDED_DOMAIN), "the refusal names no host");
  PUBLIC_TEXT.push(["route-execute 409", only.err.message]);
  const both = await run([row(EXCLUDED), row(CONTROL)]);
  ok(both.buys.length === 1 && new URL(both.buys[0]).origin === new URL(CONTROL).origin, `the next candidate, an unlisted control, is bought (${both.buys.join(", ")})`);
  // Every candidate dropped by the resolver as listed only: the refusal says so.
  const none = []; Object.defineProperty(none, "__gateDrops", { value: { total: 1, byReason: { listed_only: 1 } }, enumerable: false });
  const dropped = await run(none);
  PUBLIC_TEXT.push(["route-execute 404", dropped.err?.message]);
  ok(dropped.buys.length === 0 && dropped.err?.statusCode === 404 && /are listed only: the router does not buy from them/.test(dropped.err.message) && /pay them directly/.test(dropped.err.message), `a resolver that dropped every candidate as listed only is named (${dropped.err?.message})`);
}

// The resolver drops such a candidate on every chain branch, before judging or probing any.
{
  const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = serverSrc.slice(serverSrc.indexOf("async function resolveExternalSeller("), serverSrc.indexOf("const { probePublicUrl } = await import(\"./tools/fetch-guard.js\");"));
  const at = fn.indexOf("if (sellerListedOnly(r.url) || sellerListedOnly(r.seller)) {");
  ok(at > fn.indexOf('} else if (chain === "algorand") {') && at > fn.indexOf('} else if (chain === "solana") {') && at < fn.indexOf("await judgeSellerOrder(") && fn.indexOf("await judgeSellerOrder(") > 0, "the resolver filters every chain's listed-only candidates before judging");
  ok(/dispatchEligibility\(\{ routable: true, [^\n]*seller: r\.seller \|\| r\.url \|\| null, routeText: r, /.test(fn) && /seller: origin \|\| row\.url \|\| null,/.test(serverSrc), "the resolver's gate and every public label pass the seller to dispatchEligibility");
}

// ------------------------------------------------------------- (d) the buyers themselves
{
  const realFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (...a) => { sent++; return realFetch(...a); };
  const { payX402 } = await import("../src/x402-buyer.js");
  const { payTempo } = await import("../src/tempo-buyer.js");
  for (const chain of ["base", "solana", "algorand"]) {
    let err = null;
    try { await payX402(`${EXCLUDED}/v1/prices`, { maxAtomic: 10_000n, chain, onSigned: () => null }); } catch (e) { err = e; }
    ok(err?.statusCode === 409 && err.code === "listed_only" && /Nothing was signed/.test(err.message), `payX402 on ${chain} refuses the seller (${err?.statusCode} ${err?.code})`);
    PUBLIC_TEXT.push([`payX402 ${chain}`, err.message]);
  }
  let terr = null;
  try { await payTempo(`${EXCLUDED}/v1/prices`, { maxAtomic: 10_000n, createCredential: async () => { throw new Error("must not sign"); }, onSigned: () => null }); } catch (e) { terr = e; }
  PUBLIC_TEXT.push(["payTempo", terr?.message]);
  ok(terr?.statusCode === 409 && terr.code === "listed_only", `payTempo refuses the seller (${terr?.statusCode} ${terr?.code})`);
  ok(sent === 0, `no request reached the network (${sent})`);
  globalThis.fetch = realFetch;
}

// ------------------------------------------------------------- (e) a booted server: listed, never dispatched
{
  const dir = mkdtempSync(join(tmpdir(), "a402-listed-only-"));
  const now = Date.now();
  const PAYTO_X = "0x1111111111111111111111111111111111111111";
  const PAYTO_C = "0x2222222222222222222222222222222222222222";
  const tool = (origin) => ({ seller: origin, route: "/v1/stock-prices", slug: "stock-prices", name: "Stock prices", description: "Daily stock prices and fundamentals for listed equities.", method: "GET", price: "$0.01", networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": origin === EXCLUDED ? PAYTO_X : PAYTO_C } });
  const entry = (origin, payTo) => [origin, {
    manifest: { name: origin.replace(/^https:\/\//, ""), homepage: origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
    payToByNetwork: { "eip155:8453": payTo },
    evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } },
    tools: [tool(origin)],
  }];
  const lbFile = join(dir, "leaderboard-snapshot.json");
  const lbRow = (rank, origin, payTo) => ({ rank, homepage: origin, origins: [origin], wallet: payTo, wallets: [payTo], callsSettled: 500, uniqueBuyers: 40 });
  writeFileSync(lbFile, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: new Date(now).toISOString(), windowLabel: "7d",
    leaderboard: [lbRow(1, EXCLUDED, PAYTO_X), lbRow(2, CONTROL, PAYTO_C)],
    walletEvidence: { [PAYTO_X]: { callsSettled: 500, uniqueBuyers: 40, origins: [EXCLUDED] }, [PAYTO_C]: { callsSettled: 500, uniqueBuyers: 40, origins: [CONTROL] } },
  }));
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: 2 }), JSON.stringify(entry(EXCLUDED, PAYTO_X)), JSON.stringify(entry(CONTROL, PAYTO_C))].join("\n") + "\n");
  const srv = await bootServer({
    stores: false,
    readyPath: `/api/index?seller=${encodeURIComponent(CONTROL)}`,
    timeoutMs: 90_000,
    env: { FREE_MODE: "true", ROUTER_EXCLUDED_SELLER_HASHES: h(EXCLUDED_DOMAIN), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_INDEX_CRAWL: "on", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), LEADERBOARD_SNAPSHOT_FILE: lbFile, ROUTER_WORKERS: "0" },
  });
  procs.add(srv);
  const base = srv.url;
  try {
    const read = async (origin) => { const r = await fetch(`${base}/api/index?seller=${encodeURIComponent(origin)}`); return r.ok ? r.json() : null; };
    const x = await read(EXCLUDED);
    const c = await read(CONTROL);
    ok(x && x.origin === EXCLUDED && x.tools?.length === 1, "the excluded seller is listed on /api/index?seller=");
    ok(x.routerDispatchEligible === false && x.routerDispatchReason === "listed_only", `its seller verdict is listed_only (${x.routerDispatchReason})`);
    ok(x.tools[0].routerDispatchEligible === false && x.tools[0].routerDispatchReason === "listed_only" && x.tools[0].routerDispatchByChain?.base?.reason === "listed_only" && x.tools[0].executeViaCallableNow !== true, `its route row reads listed_only and is not callable through the router (${JSON.stringify(x.tools[0].routerDispatchByChain)})`);
    ok(c && c.routerDispatchEligible === true && c.tools?.[0]?.routerDispatchEligible === true, `the control seller with the same evidence is eligible (${c?.routerDispatchReason})`);
    ok(x.legend?.routerDispatchReason?.listed_only === DISPATCH_REASONS.listed_only, "the legend served beside the rows explains listed_only");
    let routed = null;
    for (let i = 0; i < 60 && !routed; i++) {
      const r = await fetch(`${base}/api/route?q=${encodeURIComponent("stock prices fundamentals")}&include=external&top=10`);
      if (r.ok) { const j = await r.json(); if (!j.indexing && (j.results || []).some((t) => t.seller === CONTROL)) routed = j; }
      if (!routed) await new Promise((r) => setTimeout(r, 500));
    }
    const xr = (routed?.results || []).find((t) => t.seller === EXCLUDED);
    ok(xr && xr.routerDispatchEligible === false && xr.routerDispatchReason === "listed_only", `/api/route?include=external still lists the excluded seller for a direct buy, labeled listed_only (${xr?.routerDispatchReason})`);
    const cr = routed.results.find((t) => t.seller === CONTROL);
    ok(cr && cr.executeViaCallableNow === true, "the control seller's row is callable now");
    const page = await (await fetch(`${base}/api/index?limit=50&page=0`)).json();
    ok((page.sellers || []).some((s) => s.origin === EXCLUDED && s.routerDispatchReason === "listed_only"), "the /api/index listing keeps the excluded seller with its reason");
    const find = await (await fetch(`${base}/api/find?q=${encodeURIComponent("seller-excluded")}`)).json();
    ok((find.relatedSellers || []).some((r) => r.origin === EXCLUDED), `/api/find still points a buyer to the excluded seller by name (${(find.relatedSellers || []).map((r) => r.origin).join(", ") || "none"})`);
    const sell = await (await fetch(`${base}/sell`)).text();
    ok(sell.includes(">listed_only<"), "the /sell page lists listed_only");
    const at = sell.indexOf(">listed_only<");
    PUBLIC_TEXT.push(["/sell row", sell.slice(at, sell.indexOf("</tr>", at))]);
    PUBLIC_TEXT.push(["/api/index?seller= row", JSON.stringify({ ...x, legend: { routerDispatchReason: { listed_only: x.legend?.routerDispatchReason?.listed_only } } })]);
    PUBLIC_TEXT.push(["/api/route row", JSON.stringify(xr)]);
    PUBLIC_TEXT.push(["/api/index listing row", JSON.stringify((page.sellers || []).find((s) => s.origin === EXCLUDED))]);
  } finally { srv.child.kill("SIGTERM"); }
}

// ------------------------------------------------------------- (f) no public surface gives a reason
// A listed-only seller is a named outside business, so what is published about
// it is the fact alone. REASON_WORDS is every word a reason would need.
{
  const REASON_WORDS = /\bterms?\b|resale|resell|licen[sc]|redistribut|\bpolic(y|ies)\b|\bbecause\b|\bforbid|\bbar(s|red|ring)?\b|AI[- ]agent/i;
  const OLD_CODE = ["terms", "no", "resale"].join("_");
  PUBLIC_TEXT.push(["the legend", DISPATCH_REASONS.listed_only]);
  ok(DISPATCH_REASONS.listed_only === "the router lists this seller and does not buy from it; a buyer can pay it directly", "the legend is the neutral sentence");
  ok(PUBLIC_TEXT.length >= 11 && PUBLIC_TEXT.every(([, t]) => typeof t === "string" && t.length > 20), `every public text was collected (${PUBLIC_TEXT.length})`);
  for (const [where, text] of PUBLIC_TEXT) {
    const hit = text.match(REASON_WORDS);
    ok(!hit && !text.includes(OLD_CODE), `${where} gives no reason for the listing-only status${hit ? ` (found ${JSON.stringify(hit[0])})` : ""}`);
  }
  // The whole tree: the retired code is served nowhere, and no src/ line that
  // carries the reason (a string, a comment or a table row) pairs it with one.
  const { readdirSync } = await import("node:fs");
  const root = new URL("../src/", import.meta.url);
  const paired = [], old = [];
  for (const rel of readdirSync(root, { recursive: true })) {
    if (!/\.(js|mjs|json|md)$/.test(String(rel))) continue;
    const text = readFileSync(new URL(String(rel), root), "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.includes(OLD_CODE)) old.push(`${rel}:${i + 1}`);
      if (/listed_only|listed only: the router|lists (this|that outside) seller and does not buy/.test(line) && REASON_WORDS.test(line)) paired.push(`${rel}:${i + 1}`);
    });
  }
  ok(old.length === 0, `no file under src/ carries the retired reason code (${old.join(", ") || "none"})`);
  ok(paired.length === 0, `no src/ line pairs the reason with a word that explains it (${paired.join(", ") || "none"})`);
  const mod = readFileSync(new URL("../src/router-listed-only.js", import.meta.url), "utf8");
  ok(!REASON_WORDS.test(mod), `the module itself, comments included, gives no reason (${mod.match(REASON_WORDS)?.[0] || "none"})`);
  for (const file of ["../src/changelog.js", "../CHANGELOG.md"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const at = text.indexOf("The router lists some outside sellers without buying from them");
    const entry = at < 0 ? "" : text.slice(at, at + 220).split(/",\n|\n\n|\n- |\n###/)[0];
    ok(at >= 0 && entry.includes("`listed_only`") && !REASON_WORDS.test(entry) && !text.includes(OLD_CODE), `${file.replace(/^\.\.\//, "")} states the listing-only fact and no reason`);
  }
}

assert.ok(pass > 0);
console.log(`OK: ${pass} passed`);
process.exit(0);
