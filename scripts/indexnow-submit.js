// Submit the site's URLs to IndexNow (api.indexnow.org), the index shared by
// Bing/Copilot, DuckDuckGo, Yahoo, Seznam and Naver.
//
//   INDEXNOW_KEY=<key> node scripts/indexnow-submit.js [--urls a,b] [--state file] [--since YYYY-MM-DD] [--dry-run]
//
// Without --urls it walks /sitemapindex.xml (every child sitemap) plus the
// legacy /sitemap.xml and dedupes. With --state, only URLs absent from the
// previous run's URL set are submitted (all of them when the file is missing),
// and the new set is written back. --since submits URLs whose sitemap lastmod
// is on or after that date. Batches of 10,000 per POST.
//
// The key must match what the server exposes at /{key}.txt (INDEXNOW_KEY on
// Railway). Exit 0 when every batch is accepted (200/202) or nothing changed,
// 1 otherwise. Best-effort: the sitemap remains the source of truth.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { collectSitemapUrls, selectChanged, pingIndexNow } from "../src/indexnow.js";

const BASE = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const KEY = (process.env.INDEXNOW_KEY || "").trim();
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes("--dry-run");

function readState(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j.urls) ? j.urls : null;
  } catch { return null; }
}

async function main() {
  if (!KEY) { console.error("INDEXNOW_KEY is not set - nothing to submit."); process.exit(1); }
  const host = new URL(BASE).host;
  const keyUrl = `${BASE}/${KEY}.txt`;
  const keyRes = await fetch(keyUrl, { signal: AbortSignal.timeout(15000) });
  const keyBody = (await keyRes.text()).trim();
  if (keyRes.status !== 200 || keyBody !== KEY) {
    console.error(`key file check failed: ${keyUrl} -> HTTP ${keyRes.status}`);
    process.exit(1);
  }
  console.error(`key file OK: ${keyUrl}`);

  const statePath = arg("--state");
  const since = arg("--since");
  const urlsArg = arg("--urls");
  let urlList;
  let entries = null;
  if (urlsArg) {
    urlList = urlsArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const r = await collectSitemapUrls(BASE);
    for (const e of r.errors) console.error(`sitemap read failed: ${e}`);
    console.error(`read ${r.sitemaps.length} sitemap(s), ${r.urls.length} URL(s)`);
    if (!r.urls.length) { console.error("no URLs found - refusing to write an empty state"); process.exit(1); }
    entries = r.urls;
    const previous = readState(statePath);
    if (statePath) console.error(previous ? `state: ${previous.length} URL(s) from the previous run` : "state: none, submitting everything");
    urlList = selectChanged(entries, { previous, since });
  }
  console.error(`submitting ${urlList.length} URL(s) for ${host}${DRY ? " (dry run)" : ""}`);
  const result = DRY ? { ok: true, batches: [] } : await pingIndexNow({ host, key: KEY, keyLocation: keyUrl, urls: urlList });
  console.log(JSON.stringify({ ok: result.ok, urls: urlList.length, batches: result.batches }));
  // Advance the state only after every batch was accepted, so a failed ping retries next time.
  if (statePath && entries && result.ok && !DRY) {
    writeFileSync(statePath, JSON.stringify({ at: new Date().toISOString(), urls: entries.map((e) => e.loc) }));
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
