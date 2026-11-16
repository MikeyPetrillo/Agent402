import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
// scripts/test-coingecko-endpoint.js
// Offline (globalThis.fetch is stubbed). src/tools/coingecko-endpoint.js picks
// the CoinGecko host and key header per COINGECKO_API_TIER: demo (default)
// sends a set key as x-cg-demo-api-key to api.coingecko.com, pro sends it as
// x-cg-pro-api-key to pro-api.coingecko.com, and a keyless call goes to the
// public host with no key header whatever the tier. Every module that calls
// CoinGecko (crypto-kit, crypto-markets-kit, price-feed-kit) is driven under
// each setting, the key never appears in a URL, an error or the console, and
// no src/ file but the helper names a CoinGecko API host or key header.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cgTier, cgBase, cgKeyHeaders, CG_DEMO_BASE, CG_PRO_BASE } from "../src/tools/coingecko-endpoint.js";
import { CRYPTO_TOOLS, clearCryptoCache } from "../src/tools/crypto-kit.js";
import { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache, resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";
import { PRICE_FEED_TOOLS, clearPriceFeedCache } from "../src/tools/price-feed-kit.js";
import { MARKET_TICK_TOOLS, __setMarketTickSources, clearMarketTickCache } from "../src/tools/market-tick-kit.js";
import { buildSkillTools } from "../src/tools/skill-runner.js";
import { SKILL_PACKS } from "../src/skills.js";
import { COINGECKO_CREDIT, COINGECKO_ATTRIBUTION, COINGECKO_API_URL, attributionTailOf, creditAnswers, withCredit } from "../src/data-attribution.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

const KEY = "placeholder-not-a-key"; // test-only placeholder
// Everything the kits print is captured so the key can be looked for in it.
const printed = [];
for (const m of ["log", "warn", "error", "info"]) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { printed.push(a.map(String).join(" ")); orig(...a); };
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------
function withEnv(env, fn) {
  const keep = { COINGECKO_API_KEY: process.env.COINGECKO_API_KEY, COINGECKO_API_TIER: process.env.COINGECKO_API_TIER };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const cases = [
  [{ COINGECKO_API_KEY: undefined, COINGECKO_API_TIER: undefined }, "demo", CG_DEMO_BASE, {}],
  [{ COINGECKO_API_KEY: undefined, COINGECKO_API_TIER: "pro" }, "demo", CG_DEMO_BASE, {}],
  [{ COINGECKO_API_KEY: "  ", COINGECKO_API_TIER: "pro" }, "demo", CG_DEMO_BASE, {}],
  [{ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: undefined }, "demo", CG_DEMO_BASE, { "x-cg-demo-api-key": KEY }],
  [{ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: "demo" }, "demo", CG_DEMO_BASE, { "x-cg-demo-api-key": KEY }],
  [{ COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: "garbage" }, "demo", CG_DEMO_BASE, { "x-cg-demo-api-key": KEY }],
  [{ COINGECKO_API_KEY: ` ${KEY} `, COINGECKO_API_TIER: " PRO " }, "pro", CG_PRO_BASE, { "x-cg-pro-api-key": KEY }],
];
for (const [env, tier, base, hdrs] of cases) {
  withEnv(env, () => {
    const label = `key=${env.COINGECKO_API_KEY === undefined ? "unset" : env.COINGECKO_API_KEY.trim() ? "set" : "blank"} tier=${JSON.stringify(env.COINGECKO_API_TIER ?? null)}`;
    ok(cgTier() === tier, `${label}: tier ${tier}`);
    ok(cgBase() === base, `${label}: base ${base}`);
    ok(JSON.stringify(cgKeyHeaders()) === JSON.stringify(hdrs), `${label}: headers ${Object.keys(hdrs).join(",") || "none"}`);
  });
}
ok(CG_DEMO_BASE === "https://api.coingecko.com/api/v3" && CG_PRO_BASE === "https://pro-api.coingecko.com/api/v3", "bases are the documented hosts");

// ---------------------------------------------------------------------------
// Every CoinGecko-calling module, under each setting
// ---------------------------------------------------------------------------
const calls = [];
let respond = null;
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => JSON.parse(typeof body === "string" ? body : JSON.stringify(body)),
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const h = init?.headers || {};
  calls.push({ url: u, headers: typeof h.entries === "function" ? Object.fromEntries(h.entries()) : { ...h } });
  return respond(u);
};
const okBody = (u) => {
  if (u.pathname.endsWith("/simple/price")) {
    const ids = (u.searchParams.get("ids") || "").split(",");
    return jsonRes(200, Object.fromEntries(ids.map((id) => [id, { usd: 1, usd_24h_change: 0, usd_24h_vol: 1, usd_market_cap: 1, last_updated_at: 1700000000 }])));
  }
  if (u.pathname.endsWith("/global/decentralized_finance_defi")) {
    return jsonRes(200, { data: { defi_market_cap: "1", eth_market_cap: "2", defi_to_eth_ratio: "50", trading_volume_24h: "3", defi_dominance: "4", top_coin_name: "X", top_coin_defi_dominance: 5 } });
  }
  return jsonRes(404, { error: "not found" });
};
const resetAll = () => { calls.length = 0; clearCryptoCache(); clearCryptoMarketsCache(); clearPriceFeedCache(); resetCgRateLimit(); };
const tool = (list, slug) => list.find((t) => t.slug === slug).handler;
const MODULES = [
  ["crypto-kit crypto-price", (n) => tool(CRYPTO_TOOLS, "crypto-price")({ coins: n % 2 ? "BTC" : "ETH" })],
  ["crypto-markets-kit global-defi", () => tool(CRYPTO_MARKETS_TOOLS, "global-defi")({})],
  ["price-feed-kit price-coingecko", (n) => tool(PRICE_FEED_TOOLS, "price-coingecko")({ ids: [n % 2 ? "bitcoin" : "ethereum"] })],
];
const SETTINGS = [
  ["keyless, default tier", { COINGECKO_API_KEY: undefined, COINGECKO_API_TIER: undefined }, "api.coingecko.com", null],
  ["keyless, tier pro", { COINGECKO_API_KEY: undefined, COINGECKO_API_TIER: "pro" }, "api.coingecko.com", null],
  ["key, default tier", { COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: undefined }, "api.coingecko.com", "x-cg-demo-api-key"],
  ["key, tier pro", { COINGECKO_API_KEY: KEY, COINGECKO_API_TIER: "pro" }, "pro-api.coingecko.com", "x-cg-pro-api-key"],
];
let n = 0;
for (const [mod, call] of MODULES) {
  for (const [label, env, host, header] of SETTINGS) {
    const keep = { ...process.env };
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetAll();
    respond = okBody;
    let err = null;
    try { await call(n++); } catch (e) { err = e; }
    ok(!err, `${mod} / ${label}: answers${err ? ` (${err.statusCode} ${err.message})` : ""}`);
    const c = calls[0];
    ok(calls.length >= 1 && c.url.hostname === host && c.url.pathname.startsWith("/api/v3/"), `${mod} / ${label}: host ${host}`);
    const keyHeaders = Object.keys(c?.headers || {}).filter((k) => /^x-cg-/i.test(k));
    ok(header ? keyHeaders.length === 1 && keyHeaders[0] === header && c.headers[header] === KEY : keyHeaders.length === 0,
      `${mod} / ${label}: ${header ? `key in ${header} only` : "no key header"}`);
    ok(!calls.some((x) => x.url.toString().includes(KEY)), `${mod} / ${label}: key never in the URL`);

    // An upstream refusal that echoes the key never carries it into the error.
    if (env.COINGECKO_API_KEY) {
      resetAll();
      respond = () => jsonRes(400, { status: { error_code: 400, error_message: `bad key ${KEY} for this host` } });
      let e2 = null;
      try { await call(n++); } catch (e) { e2 = e; }
      ok(e2 && e2.statusCode >= 400, `${mod} / ${label}: upstream 400 is refused (${e2?.statusCode})`);
      ok(e2 && !String(e2.message).includes(KEY) && !JSON.stringify(e2).includes(KEY), `${mod} / ${label}: key not in the error`);
    }
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
}
ok(!printed.some((line) => line.includes(KEY)), "key never printed to the console");

// ---------------------------------------------------------------------------
// The shared jsonGet also reads a non-CoinGecko host (crypto-orderbook reads
// Coinbase Exchange): a keyed call there carries no x-cg-* header in either
// tier, while the same key rides a CoinGecko call made beside it.
// ---------------------------------------------------------------------------
const orderbook = tool(CRYPTO_TOOLS, "crypto-orderbook");
for (const tier of [undefined, "pro"]) {
  const keep = { ...process.env };
  process.env.COINGECKO_API_KEY = KEY;
  if (tier) process.env.COINGECKO_API_TIER = tier; else delete process.env.COINGECKO_API_TIER;
  resetAll();
  respond = (u) => (u.hostname === "api.exchange.coinbase.com"
    ? jsonRes(200, { bids: [["100.5", "1.25", 3]], asks: [["100.6", "0.5", 2]], sequence: 1 })
    : okBody(u));
  let out = null, err = null;
  try { out = await orderbook({ pair: "BTC-USD", depth: 1 }); } catch (e) { err = e; }
  const ex = calls.filter((c) => c.url.hostname === "api.exchange.coinbase.com");
  ok(!err && ex.length >= 1, `crypto-orderbook / key, tier ${tier || "default"}: answers from the exchange host${err ? ` (${err.statusCode} ${err.message})` : ""}`);
  ok(ex.length >= 1 && ex.every((c) => Object.keys(c.headers).every((k) => !/^x-cg-/i.test(k)) && !Object.values(c.headers).some((v) => String(v).includes(KEY))),
    `crypto-orderbook / key, tier ${tier || "default"}: no x-cg-* header and no key on the exchange request`);
  ok(out && !Object.hasOwn(out, "credit"), `crypto-orderbook / key, tier ${tier || "default"}: an exchange answer carries no CoinGecko credit`);
  resetAll();
  await tool(CRYPTO_TOOLS, "crypto-price")({ coins: "BTC" });
  ok(calls.some((c) => Object.keys(c.headers).some((k) => /^x-cg-/i.test(k))), `control / tier ${tier || "default"}: the same key rides a CoinGecko call from the same helper`);
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
}

// ---------------------------------------------------------------------------
// Source credit: CoinGecko's API terms ask for "Data provided by CoinGecko"
// with a link to its API page, next to the data. Every CoinGecko-backed tool
// ends its description with the linked sentence, publishes it as `credit` in
// its example, and every answer carries it.
// ---------------------------------------------------------------------------
ok(COINGECKO_API_URL === "https://www.coingecko.com/en/api", "credit link is CoinGecko's API page");
ok(COINGECKO_CREDIT === `Data provided by CoinGecko (${COINGECKO_API_URL}).` && COINGECKO_ATTRIBUTION === COINGECKO_CREDIT, "credit: the sentence with its link, the same text the descriptions end with");
const CG_TOOLS = [
  ...CRYPTO_TOOLS.filter((t) => t.slug !== "crypto-orderbook"),
  ...CRYPTO_MARKETS_TOOLS,
  ...PRICE_FEED_TOOLS.filter((t) => t.slug === "price-coingecko"),
];
ok(CG_TOOLS.length >= 24, `the CoinGecko-backed tools are read from the kits (${CG_TOOLS.length})`);
for (const t of CG_TOOLS) {
  ok(t.attribution === "coingecko" && attributionTailOf(t.description) === COINGECKO_CREDIT && t.description.includes(COINGECKO_API_URL), `${t.slug}: description ends with the linked credit`);
  ok(t.credit === COINGECKO_CREDIT && t.discovery?.output?.example?.credit === COINGECKO_CREDIT, `${t.slug}: published example carries the credit with the link`);
}
for (const t of [...CRYPTO_TOOLS, ...PRICE_FEED_TOOLS].filter((x) => !CG_TOOLS.includes(x))) {
  ok(t.credit === undefined && !Object.hasOwn(t.discovery?.output?.example || {}, "credit") && t.attribution !== "coingecko", `${t.slug}: not CoinGecko data, no CoinGecko credit`);
}
// Answers: the stubbed modules above, each with the credit and every field
// the handler returned.
for (const [mod, call] of MODULES) {
  resetAll();
  respond = okBody;
  const out = await call(n++);
  ok(out?.credit === COINGECKO_CREDIT, `${mod}: the answer carries the credit with the link`);
}
{
  resetAll();
  respond = (u) => (u.pathname.endsWith("/search/trending")
    ? jsonRes(200, { coins: [{ item: { id: "bitcoin", name: "Bitcoin", symbol: "BTC", market_cap_rank: 1, score: 0 } }] })
    : okBody(u));
  const out = await tool(CRYPTO_TOOLS, "crypto-trending")({});
  ok(out?.credit === COINGECKO_CREDIT && Array.isArray(out.coins) && out.coins.length === 1, "crypto-trending: the answer keeps its fields and carries the credit");
}
// The wrapper: additive, idempotent, never on a non-object answer.
{
  const t = { slug: "zz", description: "d", discovery: { output: { example: { a: 1 } } }, handler: async (i) => ({ a: i.a, nested: { b: 2 } }) };
  creditAnswers(t, "Credit (https://example.test).");
  const inner = t.handler;
  creditAnswers(t, "Credit (https://example.test).");
  ok(t.handler === inner, "creditAnswers: a second call does not wrap again");
  const out = await t.handler({ a: 7 });
  ok(JSON.stringify(out) === JSON.stringify({ a: 7, nested: { b: 2 }, credit: "Credit (https://example.test)." }), "creditAnswers: every field kept, credit added");
  ok(JSON.stringify(t.discovery.output.example) === JSON.stringify({ a: 1, credit: "Credit (https://example.test)." }), "creditAnswers: example gains the credit");
  ok(JSON.stringify(withCredit([1], "c")) === "[1]" && withCredit(null, "c") === null && withCredit({ credit: "own" }, "c").credit === "own", "withCredit: arrays, null and an answer with its own credit are left as they are");
}

// Market tick: an answer that serves a coin figure carries the credit; an
// equities-only answer does not.
{
  const tick = MARKET_TICK_TOOLS[0];
  ok(tick.discovery.output.example.credit === COINGECKO_CREDIT, "market-tick: published example (BTC, ETH, AAPL) carries the credit");
  __setMarketTickSources({
    crypto: async ({ coins }) => ({ currency: "usd", coins: Object.fromEntries(String(coins).split(",").map((id) => [id, { price: 1, change24hPct: 0, lastUpdated: "2026-11-16T00:00:00.000Z" }])), credit: COINGECKO_CREDIT }),
    equity: async ({ symbol }) => ({ symbol, price: 2, previousClose: 2, change: 0, changePct: 0, currency: "USD", asOf: "2026-11-13" }),
  });
  clearMarketTickCache();
  const mixed = await tick.handler({ symbols: "BTC,AAPL" });
  ok(mixed.credit === COINGECKO_CREDIT && mixed.items.length === 2, "market-tick: a coin figure in the answer brings the credit");
  clearMarketTickCache();
  const eq = await tick.handler({ symbols: "AAPL" });
  ok(!Object.hasOwn(eq, "credit"), "market-tick: an equities-only answer carries no CoinGecko credit");
  __setMarketTickSources(null);
  clearMarketTickCache();
}

// Skill packs: the credit is printed once on the envelope, not per step.
{
  const catalog = Object.fromEntries([...CRYPTO_TOOLS, ...CRYPTO_MARKETS_TOOLS, ...PRICE_FEED_TOOLS].map((t) => [t.route, t]));
  const packs = buildSkillTools({ getCatalog: () => catalog });
  const cgSlugs = new Set(CG_TOOLS.map((t) => t.slug));
  const runsCg = new Set(SKILL_PACKS.filter((p) => p.toolSlugs.some((s) => cgSlugs.has(s))).map((p) => `skill-${p.slug}`));
  const withCg = packs.filter((p) => runsCg.has(p.slug));
  ok(withCg.length >= 3, `packs that run a CoinGecko tool are read from their steps (${withCg.length})`);
  for (const p of withCg) {
    const ex = p.discovery.output.example;
    ok(ex.credit === COINGECKO_CREDIT && ex.steps.every((s) => !Object.hasOwn(s.result || {}, "credit")), `${p.slug}: published example carries the credit once`);
    ok(p.description.split(COINGECKO_CREDIT).length === 2, `${p.slug}: description prints the credit once`);
  }
  for (const p of packs.filter((x) => !withCg.includes(x))) ok(!Object.hasOwn(p.discovery.output.example, "credit"), `${p.slug}: no CoinGecko tool, no credit`);
  const dossier = packs.find((p) => p.slug === "skill-crypto-dossier") || withCg[0];
  resetAll();
  respond = (u) => {
    if (u.pathname.endsWith("/search/trending")) return jsonRes(200, { coins: [{ item: { id: "bitcoin", name: "Bitcoin", symbol: "BTC", market_cap_rank: 1, score: 0 } }] });
    if (u.pathname.endsWith("/global")) return jsonRes(200, { data: { total_market_cap: { usd: 1 }, total_volume: { usd: 1 }, market_cap_percentage: { btc: 50 }, active_cryptocurrencies: 1, markets: 1, market_cap_change_percentage_24h_usd: 0, updated_at: 1700000000 } });
    return okBody(u);
  };
  const env = await dossier.handler({ coin: "BTC" }, null);
  const okCg = env.steps.filter((s) => s.ok && !s.skipped && cgSlugs.has(s.slug));
  ok(okCg.length >= 2, `${dossier.slug}: at least two CoinGecko steps answered (${okCg.map((s) => s.slug).join(",")})`);
  ok(env.credit === COINGECKO_CREDIT && env.steps.every((s) => !Object.hasOwn(s.result || {}, "credit")), `${dossier.slug}: the answer prints the credit once, on the envelope`);
}

// ---------------------------------------------------------------------------
// Guard: the helper is the only src/ file that names a CoinGecko API host or
// a CoinGecko key header. upstream-budgets.js matches hosts by suffix
// ("api.coingecko.com" also covers pro-api.coingecko.com), not a URL.
// ---------------------------------------------------------------------------
const root = fileURLToPath(new URL("..", import.meta.url));
const HELPER = "src/tools/coingecko-endpoint.js";
const ALLOWED = new Map([["src/upstream-budgets.js", /match: "api\.coingecko\.com"/]]);
const offenders = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "generated") walk(p); continue; }
    if (!/\.(m?js|cjs)$/.test(name)) continue;
    const rel = relative(root, p).split("\\").join("/");
    if (rel === HELPER) continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (!/(?:pro-)?api\.coingecko\.com|x-cg-(?:demo|pro)-api-key/i.test(line)) return;
      const allow = ALLOWED.get(rel);
      if (allow && allow.test(line)) return;
      offenders.push(`${rel}:${i + 1}`);
    });
  }
})(join(root, "src"));
ok(offenders.length === 0, `no src/ file outside ${HELPER} names a CoinGecko API host or key header${offenders.length ? `: ${offenders.join(", ")}` : ""}`);
ok("pro-api.coingecko.com".endsWith("api.coingecko.com"), "upstream budget suffix match covers the pro host");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
