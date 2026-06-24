// Refresh Bazaar metadata for Agent402 listings.
//
// Background: Coinbase's CDP Bazaar harvester captures per-resource metadata
// (description, serviceName, tags) when a payment is observed against that
// resource — it doesn't re-poll the 402 challenge on its own.
//
// Two modes:
//   MODE=stale   (default) — find listings whose serviceName drifted and
//                re-trigger the harvester so they pick up the current name.
//                Used by the daily refresh after renames.
//   MODE=missing — find routes in our catalog that aren't on Bazaar at all
//                and pay the minimum-cost call once each so the harvester
//                registers them. Used after large catalog additions.
//
// Stale mode steps:
//   1) Page Bazaar for our resources whose serviceName !== EXPECT_NAME
//   2) Look up each tool's example from /api/find
//   3) Pay once to make the harvester re-observe metadata
//
// Missing mode steps:
//   1) Fetch /api/pricing (our catalog) and the full Bazaar resource set
//   2) Diff: catalog ∖ Bazaar = routes that have never been observed
//   3) Pull examples from /openapi.json (full coverage, unlike /api/find)
//   4) Pay each from cheapest first, bounded by MAX_SPEND_USD
//   5) Re-verify the missing count
//
// Cost: stale mode is well under $1. Missing mode prints an estimate up
//   front and refuses to run if it exceeds MAX_SPEND_USD. The script is
//   idempotent — already-registered routes drop from the missing set on
//   re-run, so a timed-out run can be safely resumed.
//
// Run: BURNER_KEY=0x... node scripts/refresh-bazaar.js
//   or KEY_FILE=/tmp/agent-key node scripts/refresh-bazaar.js
// Optional env:
//   MODE              "stale" (default) or "missing"
//   SLUGS             comma-separated slug filter for missing-mode (register only these)
//   TARGET_URL        (default https://agent402.tools)
//   EXPECT_NAME       (default "Agent402.tools")
//   MAX_SPEND_USD     missing-mode cost ceiling (default 5)
//   DRY_RUN=1         list the work without paying
//
// Exit codes: 0 = no work remaining · 1 = some routes still missing/stale or errored · 2 = misconfigured.

import { readFileSync, existsSync } from "node:fs";
// viem + @x402/* are loaded lazily so DRY_RUN works without them installed.

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const EXPECT_NAME = process.env.EXPECT_NAME || "Agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const MODE = (process.env.MODE || "stale").toLowerCase();
const MAX_SPEND_USD = Number(process.env.MAX_SPEND_USD || "5");
const SLUGS_FILTER = process.env.SLUGS ? new Set(process.env.SLUGS.split(",").map(s => s.trim())) : null;
const BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_SIZE = 1000;
const HOST = new URL(TARGET).host;

function priceToUsd(s) {
  return Number(String(s || "").replace(/[^\d.]/g, "")) || 0;
}

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

// Missing-mode helpers ----------------------------------------------------

async function loadCatalog() {
  const r = await fetch(`${TARGET}/api/pricing`);
  if (!r.ok) throw new Error(`/api/pricing HTTP ${r.status}`);
  const j = await r.json();
  const tools = j.tools || j.endpoints || [];
  return tools.map((t) => ({
    slug: t.slug,
    method: (t.method || "GET").toUpperCase(),
    path: t.path,
    price: t.price,
    priceUsd: priceToUsd(t.price),
  }));
}

async function loadRegisteredPaths() {
  const reg = new Set();
  const { matches } = await pageBazaar((it) => (it.resource || "").includes(HOST));
  for (const it of matches) {
    try { reg.add(new URL(it.resource).pathname); } catch {}
  }
  return reg;
}

async function loadOpenapiExamples() {
  // Returns Map(`${METHOD} ${path}` → exampleInput object).
  const r = await fetch(`${TARGET}/openapi.json`);
  if (!r.ok) throw new Error(`/openapi.json HTTP ${r.status}`);
  const spec = await r.json();
  const out = new Map();
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    for (const [m, op] of Object.entries(methods)) {
      const key = `${m.toUpperCase()} ${p}`;
      const body = op.requestBody?.content?.["application/json"]?.example;
      if (body && typeof body === "object") {
        out.set(key, body);
        continue;
      }
      const params = (op.parameters || []).filter((x) => x.example !== undefined);
      if (params.length) {
        const obj = {};
        for (const x of params) obj[x.name] = x.example;
        out.set(key, obj);
        continue;
      }
      out.set(key, {}); // no example — try an empty payload
    }
  }
  return out;
}

async function runMissingMode() {
  const [catalog, registered, examples] = await Promise.all([
    loadCatalog(),
    loadRegisteredPaths(),
    loadOpenapiExamples(),
  ]);
  const missing = catalog
    .filter((t) => !registered.has(t.path))
    .filter((t) => !SLUGS_FILTER || SLUGS_FILTER.has(t.slug))
    .sort((a, b) => b.priceUsd - a.priceUsd); // expensive first — skill packs register before timeout
  console.log(`Catalog: ${catalog.length} · already on Bazaar: ${registered.size} · missing: ${missing.length}`);
  if (!missing.length) {
    console.log("Nothing to register.");
    return 0;
  }

  const estCost = missing.reduce((s, t) => s + t.priceUsd, 0);
  console.log(`Estimated total cost to register all missing routes: $${estCost.toFixed(3)}`);
  if (estCost > MAX_SPEND_USD) {
    console.error(`Estimate exceeds MAX_SPEND_USD=$${MAX_SPEND_USD}. Refusing to run. Raise MAX_SPEND_USD or filter the set.`);
    return 2;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — listing the work without paying:");
    for (const t of missing.slice(0, 20)) console.log(`  ${t.method} ${t.path} (${t.price})`);
    if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);
    return 0;
  }

  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const account = privateKeyToAccount(loadKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payFetch = wrapFetchWithPayment(fetch, client);
  console.log(`Paying from ${account.address} · spending up to $${estCost.toFixed(3)} …`);

  const results = { ok: 0, fail: 0, errors: [] };
  for (let i = 0; i < missing.length; i++) {
    const t = missing[i];
    const key = `${t.method} ${t.path}`;
    const example = examples.get(key) || {};
    const isGet = t.method === "GET";
    const url = isGet
      ? `${TARGET}${t.path}${Object.keys(example).length ? "?" + new URLSearchParams(example).toString() : ""}`
      : `${TARGET}${t.path}`;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await payFetch(url, {
          method: t.method,
          headers: isGet ? {} : { "Content-Type": "application/json" },
          body: isGet ? undefined : JSON.stringify(example),
        });
        lastStatus = res.status;
        if (res.status === 200) {
          results.ok++;
          if (i % 50 === 0 || i === missing.length - 1) console.log(`  [${i + 1}/${missing.length}] OK ${key} (${t.price})`);
          break;
        }
        // 402 = facilitator hiccup (settlement timeout); retry after a pause.
        // 502/503/504 = upstream flap; also worth retrying.
        if ((res.status === 402 || res.status >= 502) && attempt < 2) {
          console.warn(`  RETRY ${key} → HTTP ${res.status} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const body = await res.text().catch(() => "");
        console.warn(`  FAIL ${key} → HTTP ${res.status} ${body.slice(0, 120)}`);
        results.fail++;
        results.errors.push(`${t.path}: HTTP ${res.status}`);
        break;
      } catch (e) {
        if (attempt < 2) {
          console.warn(`  RETRY ${key} → ${(e.message || "").slice(0, 80)} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
        console.warn(`  FAIL ${key} → ${msg}`);
        results.fail++;
        results.errors.push(`${t.path}: ${msg}`);
        break;
      }
    }
  }
  console.log(`\nRegistration pass complete: ${results.ok} ok, ${results.fail} failed.`);

  // Bazaar harvester is not instant. Give it ~60s then re-verify.
  console.log("Waiting 60s for the Bazaar harvester to catch up …");
  await new Promise((r) => setTimeout(r, 60000));
  const afterReg = await loadRegisteredPaths();
  const stillMissing = catalog.filter((t) => !afterReg.has(t.path));
  console.log(`After: ${afterReg.size} registered, ${stillMissing.length} still missing (harvester may continue to catch up).`);
  return stillMissing.length === 0 ? 0 : 1;
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
  if (MODE === "missing") {
    process.exit(await runMissingMode());
  }
  if (MODE !== "stale") {
    console.error(`Unknown MODE="${MODE}". Use "stale" or "missing".`);
    process.exit(2);
  }
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
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await payFetch(url, {
          method,
          headers: isGet ? {} : { "Content-Type": "application/json" },
          body: isGet ? undefined : JSON.stringify(meta.example),
        });
        lastStatus = res.status;
        if (res.status === 200) {
          console.log(`  OK   ${method} ${meta.path} (${meta.price})`);
          results.ok++;
          break;
        }
        if ((res.status === 402 || res.status >= 502) && attempt < 2) {
          console.warn(`  RETRY ${method} ${meta.path} → HTTP ${res.status} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const body = await res.text().catch(() => "");
        console.warn(`  FAIL ${method} ${meta.path} → HTTP ${res.status} ${body.slice(0, 120)}`);
        results.fail++;
        results.errors.push(`${meta.path}: HTTP ${res.status}`);
        break;
      } catch (e) {
        if (attempt < 2) {
          console.warn(`  RETRY ${method} ${meta.path} → ${(e.message || "").slice(0, 80)} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
        console.warn(`  FAIL ${method} ${meta.path} → ${msg}`);
        results.fail++;
        results.errors.push(`${meta.path}: ${msg}`);
        break;
      }
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
