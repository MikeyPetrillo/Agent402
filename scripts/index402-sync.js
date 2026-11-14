#!/usr/bin/env node
// Keep our 402 Index listings priced at the live catalog price.
//
// 402 Index's own prober never refreshes the MPP listings we registered, so a
// price change on our side left those listings quoting the old figure (and on
// 2026-10-03 they read base units as dollars: $0.08 listed as $80,000). This
// reads our live /api/pricing, lists every 402 Index listing on our domain,
// and PATCHes the ones that carry a price which no longer matches. Listings
// with no price are left alone: they say nothing wrong.
//
// Every write is read back: a listing that does not hold the price we set is
// reported and fails the run.
//
// A listing the index imports itself (`source: "bazaar"`) is written again by
// its importer from the importer's own source, hours after a correction of
// ours. A run after a deploy normally corrects every price that deploy
// changed, so with INDEX402_FLAG_REWRITTEN=1 (the daily run) an imported
// listing of a fixed-price route that is off the catalog price is corrected,
// named, and the run exits 3 (exit 1 when something also failed): most likely
// its source still carries an old price (or the run after the last deploy
// did not complete). The remedy is a paid call to the route through the
// importer's source (bazaar-keepalive.yml with slug_prefix and stale_days=0). A route priced per request (`quoted` or `pricedByModel`
// in /api/pricing) is corrected the same way and never flagged, since the
// importer's source carries the amount of the last call sold.
//
// Env: INDEX402_DOMAIN (default agent402.tools), INDEX402_TOKEN (the domain
// claim's verification token; required unless DRY_RUN=1), PRICING_URL
// (default https://<domain>/api/pricing), INDEX402_API (default
// https://402index.io/api/v1), INDEX402_TIMEOUT_MS (per request, default
// 40000; a request that times out, cannot connect or answers 429 or 5xx is
// asked once more, a 429 after the wait its answer names, at most 65 s),
// INDEX402_RUN_BUDGET_MS (default 780000: past it no further write is
// started, the corrections left are counted and the run fails, so the run
// ends itself inside the job's limit), INDEX402_FLAG_REWRITTEN (above),
// INDEX402_WAIT_SCALE (tests only: multiplies a 429's named wait).
// DRY_RUN=1 prints the plan and writes nothing.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** "$0.08" | 0.08 | "0.080" -> integer micro-dollars, or null. */
export function microUsd(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : null;
}

/** Live catalog price by path, in micro-dollars. */
export function livePrices(pricing) {
  const out = new Map();
  for (const e of pricing?.endpoints || []) {
    const path = e.path || e.route;
    const p = microUsd(e.price ?? e.priceUsd);
    if (path && p !== null) out.set(path, p);
  }
  return out;
}

/** Paths whose charge is set per request: quoted from the input, or priced
 *  by the model the request names. */
export function quotedPaths(pricing) {
  const out = new Set();
  for (const e of pricing?.endpoints || []) {
    const path = e.path || e.route;
    if (path && (e.quoted === true || e.pricedByModel === true)) out.add(path);
  }
  return out;
}

/** Which listings to correct: on our host, carrying a price, and that price
 *  differs from the live one. A listing whose route we no longer sell is
 *  reported, never repriced. Each update says whether the index imports the
 *  listing itself and whether the route is priced per request. */
export function planUpdates(listings, prices, domain, quoted = new Set()) {
  const updates = [], unknown = [];
  for (const l of listings) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (u.hostname !== domain) continue;
    const listed = microUsd(l.price_usd);
    if (listed === null) continue;
    const live = prices.get(u.pathname);
    if (live === undefined) { unknown.push(l); continue; }
    if (live !== listed) updates.push({ id: l.id, url: l.url, protocol: l.protocol, from: listed / 1e6, to: live / 1e6, imported: l.source === "bazaar", quoted: quoted.has(u.pathname) });
  }
  return { updates, unknown };
}

/** The corrections that mean an importer wrote an old price back: imported
 *  listings of fixed-price routes. */
export function rewrittenByImporter(updates) {
  return updates.filter((u) => u.imported && !u.quoted);
}

/** Does a listing read back from the index carry the price we set? */
export function holdsPrice(listing, to) {
  const got = microUsd(listing?.price_usd);
  return got !== null && got === microUsd(to);
}

const timeoutMs = () => {
  const n = Number(process.env.INDEX402_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 40_000;
};
const runBudgetMs = () => {
  const n = Number(process.env.INDEX402_RUN_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 780_000;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a 429 asks us to wait, in ms: Retry-After, else the reset of the
 *  rate-limit window, bounded; null when the answer names neither. */
export function waitNamedBy(headers) {
  const get = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k]);
  const after = Number(get("retry-after"));
  const reset = Number((/reset=(\d+)/.exec(String(get("ratelimit") || "")) || [])[1] ?? get("ratelimit-reset"));
  const s = Number.isFinite(after) && after > 0 ? after : Number.isFinite(reset) && reset > 0 ? reset : null;
  return s === null ? null : Math.min(s, 65) * 1000;
}

/** The claim token never reaches a log, whatever an answer echoes back. */
function withoutToken(text) {
  const token = process.env.INDEX402_TOKEN || "";
  return token ? String(text).split(token).join("[token]") : String(text);
}

async function askOnce(url, init) {
  const method = init?.method || "GET";
  let res, text;
  try {
    // One limit covers the headers and the body: an answer that starts and
    // then stalls is no answer.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs()) });
    text = await res.text();
  } catch (e) {
    const why = e?.name === "TimeoutError" ? `no answer within ${timeoutMs()} ms` : (e?.cause?.code || e?.message || "request failed");
    throw Object.assign(new Error(withoutToken(`${method} ${url} -> ${why}`)), { again: true });
  }
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw Object.assign(new Error(withoutToken(`${method} ${url} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)), { status: res.status, again: res.status === 429 || res.status >= 500, waitMs: res.status === 429 ? waitNamedBy(res.headers) : null });
  return body;
}

/** One request, asked once more when the first got no usable answer. Every
 *  request here is a read or a write of one fixed value, so asking again is safe. */
async function getJson(url, init) {
  try { return await askOnce(url, init); } catch (e) {
    if (!e.again) throw e;
    console.error(`  retrying once: ${e.message}`);
    const scale = Number(process.env.INDEX402_WAIT_SCALE);
    await sleep(e.waitMs != null ? e.waitMs * (Number.isFinite(scale) && scale > 0 ? scale : 1) : Math.min(2000, timeoutMs()));
    return askOnce(url, init);
  }
}

async function main() {
  const domain = process.env.INDEX402_DOMAIN || "agent402.tools";
  const api = (process.env.INDEX402_API || "https://402index.io/api/v1").replace(/\/+$/, "");
  const pricingUrl = process.env.PRICING_URL || `https://${domain}/api/pricing`;
  const token = process.env.INDEX402_TOKEN || "";
  const dry = process.env.DRY_RUN === "1";
  const stopWritesAt = Date.now() + runBudgetMs();
  if (!token && !dry) { console.error("INDEX402_TOKEN is not set (DRY_RUN=1 to plan without it)"); process.exit(1); }

  const pricing = await getJson(pricingUrl);
  const prices = livePrices(pricing);
  if (prices.size < 100) throw new Error(`pricing read looks incomplete (${prices.size} priced routes) - refusing to act on it`);

  const listings = [];
  for (let offset = 0; offset < 20_000; offset += 200) {
    const page = (await getJson(`${api}/services?q=${encodeURIComponent(domain)}&limit=200&offset=${offset}`)).services || [];
    listings.push(...page);
    if (page.length < 200) break;
  }
  const { updates, unknown } = planUpdates(listings, prices, domain, quotedPaths(pricing));
  console.log(`${listings.length} listings read, ${prices.size} live prices, ${updates.length} to correct, ${unknown.length} priced listing(s) on routes we no longer sell`);
  for (const l of unknown) console.log(`  not sold: ${l.protocol} ${l.url} (listed $${l.price_usd})`);

  let failed = 0;
  for (const [i, u] of updates.entries()) {
    if (!dry && Date.now() > stopWritesAt) {
      const left = updates.length - i;
      failed += left;
      console.error(`  run budget of ${runBudgetMs()} ms spent: ${left} correction(s) left for the next run`);
      break;
    }
    console.log(`  ${dry ? "would set" : "set"} ${u.protocol} ${u.url}: $${u.from} -> $${u.to}`);
    if (dry) continue;
    try {
      await getJson(`${api}/services/${u.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, verification_token: token, price_usd: u.to }),
      });
      const after = await getJson(`${api}/services/${u.id}`);
      if (!holdsPrice(after, u.to)) { failed++; console.error(`  NOT HELD ${u.url}: set $${u.to}, the index reads $${after?.price_usd}`); }
    } catch (e) { failed++; console.error(`  FAILED ${u.url}: ${e.message}`); }
  }
  const rewritten = process.env.INDEX402_FLAG_REWRITTEN === "1" ? rewrittenByImporter(updates) : [];
  for (const u of rewritten) console.error(`  REWRITTEN ${u.url}: the index's own source carries $${u.from}, the catalog price is $${u.to}`);
  if (rewritten.length) console.error(`${rewritten.length} imported listing(s) of a fixed-price route were off the catalog price on the daily run: most likely the importer's source still carries an old price for them (or the run after the last deploy did not complete). A paid call to the route through that source refreshes it (bazaar-keepalive.yml with slug_prefix and stale_days=0).`);
  if (failed) process.exit(1);
  if (rewritten.length) process.exit(3);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main().catch((e) => { console.error(e.message); process.exit(1); });
