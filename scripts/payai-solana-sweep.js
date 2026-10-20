#!/usr/bin/env node
// PayAI Solana listing sweep (ops, read-only).
//
// Compares the routes this host sells on Solana with the rows the PayAI
// facilitator registry lists for this host with a Solana mainnet accept, and
// prints the two differences:
//
//   missing  routes we sell on Solana that the registry does not list
//   stale    rows the registry lists under our origin that we no longer serve
//
// Sources, both free reads:
//   GET <TARGET_URL>/api/pricing     every priced route; `identityBound: true`
//                                    marks the EVM-only identity routes and
//                                    `networks` (CAIP-2) the restricted ones,
//                                    so a Solana-payable route is one with
//                                    neither restriction or with a solana:
//                                    entry in `networks`.
//   GET <PAYAI_REGISTRY_URL>         paginated {items, pagination:{total}};
//                                    walked with limit=1000, advanced by the
//                                    rows received, stopped on `total` (a
//                                    page-1 sample once produced a false
//                                    "0 rows for this seller").
//
// The registry is settlement-harvested: a route appears after someone settles
// a Solana payment on it through the facilitator. A `missing` row therefore
// reads "never settled on Solana there", not "broken", and this script never
// registers anything; the paid registration pass is deploy.yml's
// bazaar-solana job.
//
// The registry read is keyless. PAYAI_API_KEY_ID / PAYAI_API_KEY_SECRET (the
// facilitator's settlement credentials on Railway) are not needed to read it
// and are never sent by this script.
//
//   node scripts/payai-solana-sweep.js            # against production
//   TARGET_URL=http://127.0.0.1:3000 node scripts/payai-solana-sweep.js
//   --json   machine-readable output
//
// Env: TARGET_URL (default https://agent402.tools), PAYAI_REGISTRY_URL,
// SOLANA_CAIP2 (default mainnet), PAYAI_SWEEP_ORIGIN (the origin the registry
// knows us by; default TARGET_URL).
import { pathToFileURL } from "node:url";

export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const DEFAULT_REGISTRY_URL = "https://facilitator.payai.network/discovery/resources";
const PAGE = 1000;

/** The origin as a comparable key: scheme + lowercased host, no trailing slash. */
export function originKey(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host.toLowerCase()}`; } catch { return null; }
}
/** A resource URL as a comparable route key: lowercased host + path, no
 *  query, no hash, no trailing slash (registries record settled URLs
 *  verbatim, so one route can appear with several query strings). */
export function routeKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.host.toLowerCase()}${path}`;
  } catch { return null; }
}

/** The priced routes a /api/pricing document sells on the given Solana chain. */
export function solanaRoutesFromPricing(pricing, { caip2 = SOLANA_MAINNET_CAIP2 } = {}) {
  const railOn = !Array.isArray(pricing?.payment?.networks) || pricing.payment.networks.includes("solana");
  const out = [];
  for (const e of Array.isArray(pricing?.endpoints) ? pricing.endpoints : []) {
    if (!e || typeof e.path !== "string") continue;
    if (e.identityBound === true) continue;
    if (Array.isArray(e.networks) && !e.networks.includes(caip2)) continue;
    out.push({ path: e.path, slug: e.slug || null, method: e.method || "POST" });
  }
  return { railOn, routes: out };
}

/** The registry rows under `origin` that carry an accept on the given chain. */
export function solanaRowsFromRegistry(items, origin, { caip2 = SOLANA_MAINNET_CAIP2 } = {}) {
  const want = originKey(origin);
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const res = typeof it?.resource === "string" ? it.resource : null;
    if (!res || originKey(res) !== want) continue;
    const accepts = Array.isArray(it.accepts) ? it.accepts : [];
    if (!accepts.some((a) => a && a.network === caip2)) continue;
    out.push({ resource: res, lastUpdated: it.lastUpdated || null });
  }
  return out;
}

/** The diff: routes sold on Solana but not listed, and listed rows no longer
 *  served. Pure, so the test can drive it from fixtures. */
export function diffListing({ ours, listed, origin }) {
  const host = originKey(origin);
  const ourKeys = new Map();
  for (const r of ours) {
    const key = routeKey(`${host}${r.path}`);
    if (key && !ourKeys.has(key)) ourKeys.set(key, r);
  }
  const listedKeys = new Map();
  for (const row of listed) {
    const key = routeKey(row.resource);
    if (!key) continue;
    const cur = listedKeys.get(key);
    if (!cur || String(row.lastUpdated || "") > String(cur.lastUpdated || "")) listedKeys.set(key, row);
  }
  const missing = [...ourKeys.entries()].filter(([k]) => !listedKeys.has(k)).map(([, r]) => r);
  const stale = [...listedKeys.entries()].filter(([k]) => !ourKeys.has(k)).map(([, row]) => row);
  return {
    counts: { ours: ourKeys.size, listed: listedKeys.size, listedRows: listed.length, missing: missing.length, stale: stale.length },
    missing,
    stale,
  };
}

async function getJson(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Every row of the registry. limit=1000, advance by the rows received, stop
 *  on pagination.total; a short page before the total is a transport fault,
 *  not the end. */
export async function walkRegistry(base, { fetchJson = getJson, page = PAGE, log = () => {} } = {}) {
  const items = [];
  let offset = 0, total = null;
  for (;;) {
    const sep = base.includes("?") ? "&" : "?";
    const body = await fetchJson(`${base}${sep}limit=${page}&offset=${offset}`);
    const batch = Array.isArray(body?.items) ? body.items : [];
    const t = Number(body?.pagination?.total);
    if (Number.isFinite(t)) total = t;
    items.push(...batch);
    offset += batch.length;
    log(`  registry: ${items.length}${total != null ? ` of ${total}` : ""} rows`);
    if (!batch.length) {
      if (total != null && items.length < total) throw new Error(`registry walk stopped short: ${items.length} of ${total} rows (empty page at offset ${offset})`);
      break;
    }
    if (total != null && items.length >= total) break;
  }
  return { items, total: total ?? items.length };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes("--json");
  const target = (env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
  const origin = (env.PAYAI_SWEEP_ORIGIN || target).replace(/\/+$/, "");
  const registry = env.PAYAI_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  const caip2 = env.SOLANA_CAIP2 || SOLANA_MAINNET_CAIP2;
  const say = (m) => { if (!json) console.log(m); };

  say(`pricing: ${target}/api/pricing`);
  const pricing = await getJson(`${target}/api/pricing`);
  const { railOn, routes } = solanaRoutesFromPricing(pricing, { caip2 });
  if (!railOn) {
    say(`Solana is not among the rails ${target} advertises; nothing to compare.`);
    if (json) console.log(JSON.stringify({ skipped: "solana rail not advertised", target }, null, 2));
    return 0;
  }
  say(`  ${routes.length} of ${(pricing.endpoints || []).length} priced routes accept ${caip2}`);

  say(`registry: ${registry}`);
  const { items, total } = await walkRegistry(registry, { log: say });
  const listed = solanaRowsFromRegistry(items, origin, { caip2 });
  say(`  ${listed.length} rows under ${originKey(origin)} with a ${caip2} accept (registry total ${total})`);

  const diff = diffListing({ ours: routes, listed, origin });
  if (json) {
    console.log(JSON.stringify({ target, origin, registry, caip2, registryTotal: total, ...diff }, null, 2));
    return 0;
  }
  say("");
  say(`listed and served: ${diff.counts.ours - diff.counts.missing} routes`);
  say(`missing (sold on Solana, not listed; the registry lists a route once a Solana payment settles on it): ${diff.counts.missing}`);
  for (const r of diff.missing) say(`  ${r.method} ${r.path}`);
  say(`stale (listed under our origin, no longer served): ${diff.counts.stale}`);
  for (const row of diff.stale) say(`  ${row.resource}${row.lastUpdated ? `  (last updated ${row.lastUpdated})` : ""}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`payai-solana-sweep: ${e?.message || e}`); process.exit(2); });
}
