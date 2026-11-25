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
import { UPSTREAM_BUDGETS } from "../src/upstream-budgets.js";
import { cgTier, cgBase, cgKeyHeaders, CG_DEMO_BASE, CG_PRO_BASE, CG_API_HOSTS } from "../src/tools/coingecko-endpoint.js";
import { CRYPTO_TOOLS, clearCryptoCache } from "../src/tools/crypto-kit.js";
import { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache, resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";
import { CRYPTO_SCREENS_TOOLS } from "../src/tools/crypto-screens-kit.js";
import { PRICE_FEED_TOOLS, clearPriceFeedCache } from "../src/tools/price-feed-kit.js";
import { buildSkillTools } from "../src/tools/skill-runner.js";
import { SKILL_PACKS } from "../src/skills.js";
import { missingExampleKeys } from "../src/answer-shape.js";
import { responseSchemaFor } from "../src/openapi-schema.js";
import { COINGECKO_CREDIT, COINGECKO_ATTRIBUTION, COINGECKO_API_URL, HYPERLIQUID_ATTRIBUTION, attributionTailOf, creditAnswers, withCredit } from "../src/data-attribution.js";

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
// Source credit: CoinGecko's API terms (section 4.3) ask for "Powered by CoinGecko"
// with a link to its API page, next to the data. Every CoinGecko-backed tool
// ends its description with the linked sentence, publishes it as `credit` in
// its example, and every answer carries it.
// ---------------------------------------------------------------------------
ok(COINGECKO_API_URL === "https://www.coingecko.com/en/api", "credit link is CoinGecko's API page");
ok(COINGECKO_CREDIT === `Powered by CoinGecko (${COINGECKO_API_URL}).` && COINGECKO_ATTRIBUTION === COINGECKO_CREDIT, "credit: the sentence with its link, the same text the descriptions end with");
const CG_TOOLS = [
  ...CRYPTO_TOOLS,
  ...CRYPTO_MARKETS_TOOLS,
  ...CRYPTO_SCREENS_TOOLS,
  ...PRICE_FEED_TOOLS.filter((t) => t.slug === "price-coingecko"),
];
ok(CG_TOOLS.length > 0, `the CoinGecko-backed tools are read from the kits (${CG_TOOLS.length})`);
for (const t of CG_TOOLS) {
  ok(t.attribution === "coingecko" && attributionTailOf(t.description) === COINGECKO_CREDIT && t.description.includes(COINGECKO_API_URL), `${t.slug}: description ends with the linked credit`);
  // A price answer whose check read the second source credits it after
  // CoinGecko (crypto-kit checkCredited), as its example shows.
  const exCredit = t.discovery?.output?.example?.credit;
  const checked = t.discovery?.output?.example?.check === "hyperliquid-oracle";
  ok(t.credit === COINGECKO_CREDIT && (checked ? exCredit === `${COINGECKO_CREDIT} ${HYPERLIQUID_ATTRIBUTION}` : exCredit === COINGECKO_CREDIT), `${t.slug}: published example carries the credit with the link`);
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
  ok(JSON.stringify(withCredit([1], "c")) === "[1]" && withCredit(null, "c") === null, "withCredit: arrays and null are left as they are");
  // An answer built from several sources credits each: its own credit is
  // kept and the new sentence follows it, once.
  ok(withCredit({ credit: "Own." }, "C.").credit === "Own. C.", "withCredit: an answer's own credit is kept and the new source's sentence follows it");
  ok(withCredit({ credit: "Own. C." }, "C.").credit === "Own. C.", "withCredit: a sentence the credit already holds is not added twice");
  const n = { credit: 7 }; ok(withCredit(n, "C.") === n, "withCredit: a credit that is not a string is left as it is");
  // The 402 sample is read without the answer-only source credits and the
  // source license fields; a CoinGecko credit (keyed, listed) stays.
  const { withoutAnswerOnlyFields, HYPERLIQUID_ATTRIBUTION: HL, SOURCIFY_ATTRIBUTION: SRC, SOURCE_LICENSE_NOTE } = await import("../src/data-attribution.js");
  ok(!("credit" in withoutAnswerOnlyFields({ a: 1, credit: HL })) && withoutAnswerOnlyFields({ a: 1, credit: HL }).a === 1, "withoutAnswerOnlyFields: an answer-only credit leaves the sample");
  ok(withoutAnswerOnlyFields({ credit: `${COINGECKO_CREDIT} ${HL}` }).credit === `${COINGECKO_CREDIT} ${HL}`, "withoutAnswerOnlyFields: a credit holding a listed source's sentence stays whole");
  const lic = withoutAnswerOnlyFields({ sources: {}, licenses: { "a.sol": "MIT" }, licenseNote: SOURCE_LICENSE_NOTE, credit: SRC });
  ok(!("licenses" in lic) && !("licenseNote" in lic) && !("credit" in lic) && "sources" in lic, "withoutAnswerOnlyFields: the source license fields and Sourcify's credit leave the sample");
  const own = { licenses: { x: 1 }, licenseNote: "their own" }; ok(withoutAnswerOnlyFields(own) === own, "withoutAnswerOnlyFields: fields of the same names with other values stay");
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
    const opt = p.discovery.output.optional?.credit;
    ok(!Object.hasOwn(ex, "credit") && opt?.type === "string" && opt.description.split(COINGECKO_CREDIT).length === 2 && ex.steps.every((s) => !Object.hasOwn(s.result || {}, "credit")), `${p.slug}: the credit is a declared optional output, named once, not a key of the example`);
    const schema = responseSchemaFor(p.route.split(" ")[1], ex, p.discovery.output.optional);
    ok(schema.properties?.credit?.type === "string" && !(schema.required || []).includes("credit"), `${p.slug}: the 200 schema types the credit and does not require it`);
    ok(p.description.split(COINGECKO_CREDIT).length === 2, `${p.slug}: description prints the credit once`);
  }
  for (const p of packs.filter((x) => !withCg.includes(x))) ok(!Object.hasOwn(p.discovery.output.example, "credit") && !p.discovery.output.optional, `${p.slug}: no CoinGecko tool, no credit`);
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
  // Keyless, with the public host rate-limiting every CoinGecko read (what a
  // shared CI address meets): each pack that mixes CoinGecko steps with other
  // tools still answers 200, without the credit, and that answer carries
  // every key its published example documents (the catalog sweeps' rule).
  // Four packs, since each refused read waits out the kit's own retry.
  const mixed = withCg.filter((p) => SKILL_PACKS.find((x) => `skill-${x.slug}` === p.slug).toolSlugs.some((s) => !cgSlugs.has(s))).slice(0, 4);
  ok(mixed.length >= 1, `packs that mix CoinGecko steps with other tools (${mixed.length} read)`);
  let graded = 0;
  delete process.env.COINGECKO_API_KEY;
  delete process.env.COINGECKO_API_TIER;
  for (const p of mixed) {
    resetAll();
    respond = () => jsonRes(429, { status: { error_code: 429, error_message: "rate limited" } });
    const stubs = Object.fromEntries(SKILL_PACKS.find((x) => `skill-${x.slug}` === p.slug).toolSlugs.filter((s) => !cgSlugs.has(s)).map((s) => [`GET /api/${s}`, { slug: s, route: `GET /api/${s}`, handler: async () => ({ ok: true }) }]));
    const [tool] = buildSkillTools({ getCatalog: () => ({ ...catalog, ...stubs }) }).filter((x) => x.slug === p.slug);
    let partial;
    try { partial = await tool.handler({ ...tool.discovery.input }, null); } catch { continue; }
    if (partial.steps.some((s) => s.ok && cgSlugs.has(s.slug))) continue;
    graded++;
    const missing = missingExampleKeys(tool.discovery.output.example, partial);
    ok(!Object.hasOwn(partial, "credit") && missing.length === 0, `${p.slug}: with every CoinGecko step rate-limited the 200 has no credit and lacks no documented key (${missing.join(",") || "none missing"})`);
  }
  ok(graded >= 1, `at least one partial pack answer was graded against its example (${graded})`);
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
// The host list a definition declares by name is the two bases' hosts, no more.
ok(Object.isFrozen(CG_API_HOSTS) && [...CG_API_HOSTS].sort().join() === [new URL(CG_DEMO_BASE).hostname, new URL(CG_PRO_BASE).hostname].sort().join(),
  `the exported host list is the hosts of the two API bases (${CG_API_HOSTS.join(", ")})`);
{
  // The daily call budget finds CoinGecko hosts by its own suffix rule: both
  // hosts the endpoint helper can name must fall under it.
  const cgBudget = UPSTREAM_BUDGETS.find((x) => x.name === "coingecko");
  const hosts = [CG_PRO_BASE, CG_DEMO_BASE].map((u) => new URL(u).host);
  ok(Boolean(cgBudget) && hosts.every((h) => h.endsWith(cgBudget.match)), `the upstream budget's host rule covers the demo and the pro host (${hosts.join(", ")})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
