#!/usr/bin/env node
// Listing coverage, read-only: for every priced route this host serves, does
// each registry hold a row for it on each chain it sells on?
//
//   Bazaar   the CDP discovery index. A row is minted by a settled payment the
//            CDP facilitator observes on the canonical URL, and its `accepts`
//            is harvested from the live 402 at that settlement, so a row may
//            exist for a route and still lack a chain added after its last
//            CDP-observed settlement.
//   PayAI    the PayAI facilitator registry, same shape, harvested from the
//            settlements PayAI facilitates. A route is listed there once a
//            payment on it settles through PayAI, so a chain whose boot order
//            puts another facilitator first never refreshes a row there
//            (src/settle-preference.js is the way to settle one on purpose).
//
// Both walks are the only correct one (limit=1000, advance by rows received,
// stop on pagination.total); the Bazaar is walked twice and the walks are
// unioned, so a page shift between requests cannot read as a missing row.
//
//   node scripts/listing-coverage.js                 # table
//   node scripts/listing-coverage.js --json          # the full measurement
//   node scripts/listing-coverage.js --missing       # the missing routes per registry and chain
//   node scripts/listing-coverage.js --chains base,solana,polygon
//
// Env: TARGET_URL (default https://agent402.tools), LISTING_ORIGIN (the origin
// the registries know us by; default TARGET_URL), PAYAI_REGISTRY_URL,
// BAZAAR_REGISTRY_URL, LISTING_WALKS (Bazaar walks to union, default 2).
// Keyless: both registries are public reads, and nothing here pays.
import { pathToFileURL } from "node:url";
import { walkRegistry, routeKey, originKey, DEFAULT_REGISTRY_URL as PAYAI_REGISTRY_URL } from "./payai-solana-sweep.js";

export const BAZAAR_REGISTRY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

/** Rail alias (as /api/pricing payment.networks names them) -> CAIP-2. */
export const CHAINS = {
  base: "eip155:8453",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  avalanche: "eip155:43114",
  sei: "eip155:1329",
  optimism: "eip155:10",
  monad: "eip155:143",
  celo: "eip155:42220",
  robinhood: "eip155:4663",
  stellar: "stellar:pubnet",
  algorand: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
};
export const DEFAULT_CHAINS = ["base", "solana"];

/** A chain name or CAIP-2 id -> { name, caip2 }, or null when unknown. */
export function chainOf(nameOrCaip2) {
  const s = String(nameOrCaip2 || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (CHAINS[lower]) return { name: lower, caip2: CHAINS[lower] };
  const hit = Object.entries(CHAINS).find(([, c]) => c === s);
  return hit ? { name: hit[0], caip2: hit[1] } : null;
}

export function priceToUsd(s) {
  const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a /api/pricing endpoint sells on a chain. identityBound routes are
 * keyed on the signed EIP-3009 payer and are EVM-exact only; a `networks` list
 * restricts the route to those CAIP-2 ids; otherwise the route sells on every
 * rail the host advertises.
 */
export function routeSellsOn(endpoint, chain, railsAdvertised) {
  if (!endpoint || !chain) return false;
  if (Array.isArray(railsAdvertised) && !railsAdvertised.includes(chain.name)) return false;
  if (endpoint.identityBound === true) return chain.caip2.startsWith("eip155:");
  if (Array.isArray(endpoint.networks)) return endpoint.networks.includes(chain.caip2);
  return true;
}

/** Registry rows under `origin`, keyed by route: the union of the accepts' networks and the newest lastUpdated. */
export function rowsByRoute(items, origin) {
  const want = originKey(origin);
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const res = typeof it?.resource === "string" ? it.resource : null;
    if (!res || originKey(res) !== want) continue;
    const key = routeKey(res);
    if (!key) continue;
    const cur = out.get(key) || { networks: new Set(), lastUpdated: null, rows: 0, resource: res };
    for (const a of Array.isArray(it.accepts) ? it.accepts : []) if (a && typeof a.network === "string") cur.networks.add(a.network);
    if (it.lastUpdated && String(it.lastUpdated) > String(cur.lastUpdated || "")) cur.lastUpdated = it.lastUpdated;
    cur.rows++;
    out.set(key, cur);
  }
  return out;
}

/**
 * Pure: the coverage table from the three documents. `chains` are names or
 * CAIP-2 ids. Per route and chain: whether the route sells there, and whether
 * each registry holds a row whose accepts carry that chain (null when the
 * route does not sell there, so it is neither listed nor missing).
 */
export function coverageFor({ pricing, bazaarItems = [], payaiItems = [], origin, chains = DEFAULT_CHAINS }) {
  const host = originKey(origin);
  if (!host) throw new Error(`coverageFor: bad origin ${origin}`);
  const chainList = chains.map((c) => chainOf(c) || (() => { throw new Error(`unknown chain ${c}`); })());
  const rails = Array.isArray(pricing?.payment?.networks) ? pricing.payment.networks : null;
  const registries = { bazaar: rowsByRoute(bazaarItems, origin), payai: rowsByRoute(payaiItems, origin) };
  const routes = [];
  const seen = new Set();
  for (const e of Array.isArray(pricing?.endpoints) ? pricing.endpoints : []) {
    if (!e || typeof e.path !== "string") continue;
    const key = routeKey(`${host}${e.path}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = {
      method: e.method || "POST", path: e.path, slug: e.slug || null, price: e.price || null,
      priceUsd: priceToUsd(e.price), quoted: e.quoted === true, identityBound: e.identityBound === true, computePayable: e.computePayable === true, modelBacked: e.modelBacked === true,
      sells: {}, bazaar: {}, payai: {},
      bazaarRow: registries.bazaar.has(key), payaiRow: registries.payai.has(key),
    };
    for (const ch of chainList) {
      const sells = routeSellsOn(e, ch, rails);
      row.sells[ch.name] = sells;
      for (const reg of ["bazaar", "payai"]) {
        const r = registries[reg].get(key);
        row[reg][ch.name] = sells ? !!(r && r.networks.has(ch.caip2)) : null;
      }
    }
    routes.push(row);
  }
  const summary = { routes: routes.length, bazaarRows: registries.bazaar.size, payaiRows: registries.payai.size, bazaar: {}, payai: {} };
  for (const ch of chainList) {
    for (const reg of ["bazaar", "payai"]) {
      const eligible = routes.filter((r) => r.sells[ch.name]);
      const listed = eligible.filter((r) => r[reg][ch.name] === true).length;
      summary[reg][ch.name] = { caip2: ch.caip2, eligible: eligible.length, listed, missing: eligible.length - listed };
    }
  }
  return { origin: host, chains: chainList, routes, summary };
}

/** The routes a registry lacks on a chain. */
export function missingIn(coverage, registry, chainName) {
  return coverage.routes.filter((r) => r.sells[chainName] && r[registry][chainName] === false);
}

/** `${METHOD} ${path}` -> example input, from an OpenAPI document (body example, else parameter examples, else {}). */
export function examplesFromOpenapi(spec) {
  const out = new Map();
  for (const [p, methods] of Object.entries(spec?.paths || {})) {
    for (const [m, op] of Object.entries(methods || {})) {
      const key = `${m.toUpperCase()} ${p}`;
      const body = op?.requestBody?.content?.["application/json"]?.example;
      if (body && typeof body === "object") { out.set(key, body); continue; }
      const params = (op?.parameters || []).filter((x) => x && x.example !== undefined);
      if (params.length) { out.set(key, Object.fromEntries(params.map((x) => [x.name, x.example]))); continue; }
      out.set(key, {});
    }
  }
  return out;
}

export function renderTable(coverage) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  lines.push(`${pad("registry", 9)} ${pad("chain", 9)} ${pad("caip2", 42)} ${num("sells", 6)} ${num("listed", 7)} ${num("missing", 8)}`);
  for (const reg of ["bazaar", "payai"]) {
    for (const ch of coverage.chains) {
      const s = coverage.summary[reg][ch.name];
      lines.push(`${pad(reg, 9)} ${pad(ch.name, 9)} ${pad(s.caip2, 42)} ${num(s.eligible, 6)} ${num(s.listed, 7)} ${num(s.missing, 8)}`);
    }
  }
  lines.push(`routes ${coverage.summary.routes} · bazaar rows for ${coverage.origin}: ${coverage.summary.bazaarRows} · payai rows: ${coverage.summary.payaiRows}`);
  return lines.join("\n");
}

async function getJson(url, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Walk a registry `walks` times and union the rows by resource + lastUpdated. */
export async function walkUnion(base, { walks = 1, fetchJson = getJson, log = () => {} } = {}) {
  const byKey = new Map();
  let total = 0;
  for (let i = 0; i < walks; i++) {
    const r = await walkRegistry(base, { fetchJson, log });
    total = r.total;
    for (const it of r.items) {
      const k = `${it?.resource}|${it?.lastUpdated || ""}|${JSON.stringify((it?.accepts || []).map((a) => a?.network))}`;
      if (!byKey.has(k)) byKey.set(k, it);
    }
  }
  return { items: [...byKey.values()], total };
}

/** Walk a registry in full passes until two consecutive passes agree on the
 *  feed's total and on the set of rows `isOurs` selects (keyed by `keyOf`).
 *  The feed indexes with a lag, so one walk can come back partially populated;
 *  two passes always run, and a disagreement buys one more (up to `maxPasses`).
 *  A caller that acts on "absent" should treat a key as absent only when it is
 *  absent from every pass: `items` is every pass's selected rows, so a key
 *  present in any pass is present. Each pass is walkRegistry's full walk (a
 *  short page before pagination.total never ends it). */
export async function walkAgreed(base, { isOurs = () => true, keyOf = (it) => it?.resource, minPasses = 2, maxPasses = 3, fetchJson = getJson, log = () => {} } = {}) {
  const passes = [];
  const walk = async () => {
    const r = await walkRegistry(base, { fetchJson });
    const items = r.items.filter(isOurs);
    const keys = new Set(items.map(keyOf).filter((k) => k != null && k !== ""));
    passes.push({ total: r.total, rows: items.length, keys, items });
    log(`  feed pass ${passes.length}: ${r.total} rows in the feed, ${keys.size} of ours`);
  };
  const same = (a, b) => a.total === b.total && a.keys.size === b.keys.size && [...a.keys].every((k) => b.keys.has(k));
  const passFloor = Math.max(2, minPasses);
  while (passes.length < passFloor) await walk();
  let agreed = same(passes.at(-1), passes.at(-2));
  while (!agreed && passes.length < Math.max(passFloor, maxPasses)) {
    await walk();
    agreed = same(passes.at(-1), passes.at(-2));
  }
  return { passes, agreed, items: passes.flatMap((p) => p.items), total: passes.at(-1).total };
}

/** The live measurement: /api/pricing plus both registries. */
export async function measureCoverage({ target, origin, chains = DEFAULT_CHAINS, bazaarUrl = BAZAAR_REGISTRY_URL, payaiUrl = PAYAI_REGISTRY_URL, walks = 2, fetchJson = getJson, log = () => {} } = {}) {
  const t = String(target || "https://agent402.tools").replace(/\/+$/, "");
  const o = String(origin || t).replace(/\/+$/, "");
  log(`pricing: ${t}/api/pricing`);
  const pricing = await fetchJson(`${t}/api/pricing`);
  log(`bazaar: ${bazaarUrl} (${walks} walk${walks === 1 ? "" : "s"})`);
  const bazaar = await walkUnion(bazaarUrl, { walks, fetchJson, log });
  log(`payai: ${payaiUrl}`);
  const payai = await walkUnion(payaiUrl, { walks: 1, fetchJson, log });
  const coverage = coverageFor({ pricing, bazaarItems: bazaar.items, payaiItems: payai.items, origin: o, chains });
  return { ...coverage, target: t, registryTotals: { bazaar: bazaar.total, payai: payai.total }, measuredAt: new Date().toISOString() };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : null;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes("--json");
  const showMissing = argv.includes("--missing");
  const chains = String(flag(argv, "--chains") || env.LISTING_CHAINS || DEFAULT_CHAINS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const say = (m) => { if (!json) console.log(m); };
  const coverage = await measureCoverage({
    target: env.TARGET_URL, origin: env.LISTING_ORIGIN, chains,
    bazaarUrl: env.BAZAAR_REGISTRY_URL || BAZAAR_REGISTRY_URL, payaiUrl: env.PAYAI_REGISTRY_URL || PAYAI_REGISTRY_URL,
    walks: Math.max(1, Number(env.LISTING_WALKS || 2) || 2), log: say,
  });
  if (json) { console.log(JSON.stringify(coverage, null, 2)); return 0; }
  say("");
  say(renderTable(coverage));
  if (showMissing) {
    for (const reg of ["bazaar", "payai"]) {
      for (const ch of coverage.chains) {
        const miss = missingIn(coverage, reg, ch.name);
        say(`\n${reg} / ${ch.name}: ${miss.length} missing`);
        for (const r of miss) say(`  ${r.method} ${r.path} (${r.price}${r.quoted ? ", quoted" : ""})`);
      }
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`listing-coverage: ${e?.message || e}`); process.exit(2); });
}
