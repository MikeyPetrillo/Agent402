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

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

const KEY = "cg-test-key-7f3a9c41d2e8b6";
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
