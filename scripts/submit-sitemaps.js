#!/usr/bin/env node
// Registers our sitemaps with Bing Webmaster Tools, idempotently: lists the
// feeds Bing already holds for the site, submits only the ones missing.
//
//   BING_WEBMASTER_API_KEY=... node scripts/submit-sitemaps.js            # submit the missing ones
//   BING_WEBMASTER_API_KEY=... node scripts/submit-sitemaps.js --dry-run  # list, submit nothing
//   node scripts/submit-sitemaps.js --dry-run https://agent402.tools/sitemap-tools.xml
//
// Defaults to the sitemap index and the reports sitemap (the two Bing was
// found without); extra URLs on the command line are added to that set.
// BING_SITE_URL overrides the site (default https://agent402.tools/). The key
// is read from the environment and never printed; the operator route
// POST /__operator/search-data/submit-sitemaps submits the configured index
// only, so this is the one place a second feed is registered.
//
// Exit codes: 0 every wanted feed is registered (or was already), 1 a call
// failed, 2 no key.
import { createSearchData } from "../src/search-data.js";

export const DEFAULT_SITEMAPS = ["https://agent402.tools/sitemapindex.xml", "https://agent402.tools/sitemap-reports.xml"];

/** Bing stores feed URLs as given; compare them case-folded on the host and
 *  without a trailing slash so a differently typed copy is not resubmitted. */
export function sameFeed(a, b) {
  const norm = (u) => { try { const x = new URL(String(u).trim()); return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return String(u).trim().replace(/\/+$/, ""); } };
  return norm(a) === norm(b);
}

/** Which of `wanted` Bing does not hold yet, given its feed list. */
export function missingFeeds(wanted, held) {
  return wanted.filter((w) => !held.some((h) => sameFeed(h.url, w)));
}

/** Lists, then submits the missing feeds (none when dryRun). Returns what was
 *  held, what was missing and what was submitted; throws on a failed call. */
export async function syncSitemaps({ sd, wanted = DEFAULT_SITEMAPS, dryRun = false, log = () => {} } = {}) {
  const held = await sd.listBingSitemaps();
  log(`bing holds ${held.length} feed(s): ${held.map((h) => `${h.url}${h.status != null ? ` [${h.status}]` : ""}`).join(", ") || "none"}`);
  const missing = missingFeeds(wanted, held);
  const submitted = [];
  for (const feed of missing) {
    if (dryRun) { log(`would submit ${feed}`); continue; }
    await sd.submitBingSitemap(feed);
    submitted.push(feed);
    log(`submitted ${feed}`);
  }
  for (const w of wanted) if (!missing.includes(w)) log(`already registered ${w}`);
  return { held, missing, submitted, dryRun };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const extra = args.filter((a) => /^https?:\/\//.test(a));
  const wanted = [...new Set([...DEFAULT_SITEMAPS, ...extra])];
  const sd = createSearchData({ env: process.env, store: null, log: () => {} });
  if (!sd.bingOn()) { console.error("submit-sitemaps: BING_WEBMASTER_API_KEY is not set"); process.exit(2); }
  try {
    const r = await syncSitemaps({ sd, wanted, dryRun, log: console.log });
    console.log(dryRun ? `dry run: ${r.missing.length} feed(s) would be submitted` : `${r.submitted.length} feed(s) submitted, ${wanted.length - r.submitted.length} already registered`);
  } catch (e) {
    console.error(`submit-sitemaps: ${e.message}`);
    process.exit(1);
  }
}
