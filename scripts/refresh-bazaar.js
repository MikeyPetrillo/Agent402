// Refresh Bazaar metadata for Agent402 listings whose serviceName is stale.
//
// Background: Coinbase's CDP Bazaar harvester captures per-resource metadata
// (description, serviceName, tags) when a payment is observed against that
// resource — it doesn't re-poll the 402 challenge on its own. After we
// renamed our serviceName from "Agent402" to "Agent402.tools" (commit 3bede1e),
// the daily paid canary only refreshes /api/hash, so the other ~60 listings
// stayed pinned to the old name.
//
// This script:
//   1) Pages the Bazaar discovery API for our resources
//   2) Filters to ones with the stale serviceName
//   3) Looks up each tool's slug + example from /api/find
//   4) Makes one minimum-cost paid request against each, which triggers
//      the harvester to re-observe and persist the current metadata
//   5) Re-queries the Bazaar and reports how many listings now match
//
// Cost: each route is $0.001–$0.02; the full refresh is well under $1.
// Idempotent: routes already on the new serviceName are skipped.
//
// Run: BURNER_KEY=0x... node scripts/refresh-bazaar.js
//   or KEY_FILE=/tmp/agent-key node scripts/refresh-bazaar.js
// Optional env:
//   TARGET_URL       (default https://agent402.tools)
//   EXPECT_NAME      (default "Agent402.tools")
//   DRY_RUN=1        list stale routes without paying
//
// Exit codes: 0 = no stale routes remain · 1 = some routes still stale or errored · 2 = misconfigured.

import { readFileSync, existsSync } from "node:fs";
// viem + @x402/* are loaded lazily so DRY_RUN works without them installed.

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const EXPECT_NAME = process.env.EXPECT_NAME || "Agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_SIZE = 1000;
const HOST = new URL(TARGET).host;

async function pageBazaar(filter) {
  const matches = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const r = await fetch(`${BAZAAR_URL}?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!r.ok) throw new Error(`Bazaar HTTP ${r.status}`);
    const j = await r.json();
    total = j.pagination?.total || 0;
    const items = j.items || [];
    if (!items.length) break;
    for (const it of items) if (filter(it)) matches.push(it);
    offset += items.length;
    if (offset >= total) break;
  }
  return { matches, total };
}

async function loadStaleRoutes() {
  const { matches, total } = await pageBazaar((it) => {
    const r = it.resource || "";
    return r.includes(HOST) && it.serviceName !== EXPECT_NAME;
  });
  console.log(`Scanned ${total} Bazaar resources; ${matches.length} stale on ${HOST}.`);
  // Normalise to { slug, route, serviceName }
  return matches.map((it) => {
    const u = new URL(it.resource);
    const slug = u.pathname.replace(/^\/api\//, "");
    return { slug, path: u.pathname, serviceName: it.serviceName || "(null)" };
  });
}

async function loadExample(slug) {
  // /api/find returns examples per slug; query by slug to get an exact match.
  const r = await fetch(`${TARGET}/api/find?q=${encodeURIComponent(slug)}`);
  if (!r.ok) return null;
  const j = await r.json();
  const hit = (j.results || []).find((x) => x.slug === slug);
  if (!hit) return null;
  return {
    method: hit.route.split(" ")[0],
    path: hit.route.split(" ")[1],
    example: hit.example || {},
    price: hit.price,
  };
}

function loadKey() {
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) {
    console.error("refresh-bazaar: no BURNER_KEY / KEY_FILE — set one to run paid refresh");
    process.exit(2);
  }
  return pk;
}

async function main() {
  const stale = await loadStaleRoutes();
  if (!stale.length) {
    console.log(`No stale Agent402 Bazaar listings — all serviceNames already "${EXPECT_NAME}". Nothing to do.`);
    process.exit(0);
  }
  console.log(`Will refresh ${stale.length} routes:`);
  stale.forEach((s) => console.log(`  ${s.path} (currently "${s.serviceName}")`));

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — skipping paid requests.");
    process.exit(0);
  }

  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");

  const account = privateKeyToAccount(loadKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payFetch = wrapFetchWithPayment(fetch, client);

  console.log(`Paying from ${account.address} …`);
  const results = { ok: 0, fail: 0, skipped: 0, errors: [] };
  for (const route of stale) {
    const meta = await loadExample(route.slug);
    if (!meta) {
      console.warn(`  SKIP ${route.path} — no example in /api/find for slug "${route.slug}"`);
      results.skipped++;
      continue;
    }
    const method = meta.method;
    const isGet = method === "GET";
    const url = isGet
      ? `${TARGET}${meta.path}?${new URLSearchParams(meta.example).toString()}`
      : `${TARGET}${meta.path}`;
    try {
      const res = await payFetch(url, {
        method,
        headers: isGet ? {} : { "Content-Type": "application/json" },
        body: isGet ? undefined : JSON.stringify(meta.example),
      });
      if (res.status === 200) {
        console.log(`  OK   ${method} ${meta.path} (${meta.price})`);
        results.ok++;
      } else {
        const body = await res.text().catch(() => "");
        console.warn(`  FAIL ${method} ${meta.path} → HTTP ${res.status} ${body.slice(0, 120)}`);
        results.fail++;
        results.errors.push(`${meta.path}: HTTP ${res.status}`);
      }
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
      console.warn(`  FAIL ${method} ${meta.path} → ${msg}`);
      results.fail++;
      results.errors.push(`${meta.path}: ${msg}`);
    }
  }
  console.log(`\nPaid refresh complete: ${results.ok} ok, ${results.fail} failed, ${results.skipped} skipped`);

  // Bazaar harvester is not instant; give it a moment, then re-verify.
  console.log("Waiting 30s for the Bazaar harvester to catch up …");
  await new Promise((r) => setTimeout(r, 30000));
  const after = await loadStaleRoutes();
  if (!after.length) {
    console.log(`All Agent402 listings now show serviceName="${EXPECT_NAME}". Done.`);
    process.exit(0);
  }
  console.log(`Still stale: ${after.length} routes. They may catch up over the next few minutes; re-run to verify.`);
  after.forEach((s) => console.log(`  ${s.path} (still "${s.serviceName}")`));
  process.exit(1);
}

main().catch((e) => {
  console.error("refresh-bazaar: unhandled error", e);
  process.exit(1);
});
