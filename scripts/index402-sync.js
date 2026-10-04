#!/usr/bin/env node
// Keep our 402 Index listings priced at the live catalog price.
//
// 402 Index's own prober never refreshes the MPP listings we registered, so a
// price change on our side left those listings quoting the old figure (and on
// 2026-10-03 they read base units as dollars: $0.08 listed as $80,000). This
// reads our live /api/pricing, lists every 402 Index listing on our domain,
// and PATCHes the ones that carry a price which no longer matches. Listings
// with no price (the Bazaar-sourced x402 rows) are left alone: they say
// nothing wrong, and pricing hundreds of rows we did not register is their
// importer's job, not ours.
//
// Env: INDEX402_DOMAIN (default agent402.tools), INDEX402_TOKEN (the domain
// claim's verification token; required unless DRY_RUN=1), PRICING_URL
// (default https://<domain>/api/pricing), INDEX402_API (default
// https://402index.io/api/v1). DRY_RUN=1 prints the plan and writes nothing.
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

/** Which listings to correct: on our host, carrying a price, and that price
 *  differs from the live one. A listing whose route we no longer sell is
 *  reported, never repriced. */
export function planUpdates(listings, prices, domain) {
  const updates = [], unknown = [];
  for (const l of listings) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (u.hostname !== domain) continue;
    const listed = microUsd(l.price_usd);
    if (listed === null) continue;
    const live = prices.get(u.pathname);
    if (live === undefined) { unknown.push(l); continue; }
    if (live !== listed) updates.push({ id: l.id, url: l.url, protocol: l.protocol, from: listed / 1e6, to: live / 1e6 });
  }
  return { updates, unknown };
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw Object.assign(new Error(`${init?.method || "GET"} ${url} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`), { status: res.status });
  return body;
}

async function main() {
  const domain = process.env.INDEX402_DOMAIN || "agent402.tools";
  const api = (process.env.INDEX402_API || "https://402index.io/api/v1").replace(/\/+$/, "");
  const pricingUrl = process.env.PRICING_URL || `https://${domain}/api/pricing`;
  const token = process.env.INDEX402_TOKEN || "";
  const dry = process.env.DRY_RUN === "1";
  if (!token && !dry) { console.error("INDEX402_TOKEN is not set (DRY_RUN=1 to plan without it)"); process.exit(1); }

  const prices = livePrices(await getJson(pricingUrl));
  if (prices.size < 100) throw new Error(`pricing read looks incomplete (${prices.size} priced routes) - refusing to act on it`);

  const listings = [];
  for (let offset = 0; offset < 20_000; offset += 200) {
    const page = (await getJson(`${api}/services?q=${encodeURIComponent(domain)}&limit=200&offset=${offset}`)).services || [];
    listings.push(...page);
    if (page.length < 200) break;
  }
  const { updates, unknown } = planUpdates(listings, prices, domain);
  console.log(`${listings.length} listings read, ${prices.size} live prices, ${updates.length} to correct, ${unknown.length} priced listing(s) on routes we no longer sell`);
  for (const l of unknown) console.log(`  not sold: ${l.protocol} ${l.url} (listed $${l.price_usd})`);

  let failed = 0;
  for (const u of updates) {
    console.log(`  ${dry ? "would set" : "set"} ${u.protocol} ${u.url}: $${u.from} -> $${u.to}`);
    if (dry) continue;
    try {
      await getJson(`${api}/services/${u.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, verification_token: token, price_usd: u.to }),
      });
    } catch (e) { failed++; console.error(`  FAILED ${u.url}: ${e.message}`); }
  }
  if (failed) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main().catch((e) => { console.error(e.message); process.exit(1); });
