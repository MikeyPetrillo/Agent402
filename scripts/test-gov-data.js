#!/usr/bin/env node
// gov-data must call Catalog API v4 — the CKAN v3 proxy 404s forever on
// catalog-old.data.gov (issue #730 / Algorand rail canary 2026-08-10).
//
//   node scripts/test-gov-data.js                 (offline + live DEMO_KEY probe)
//   GOV_DATA_OFFLINE=1 node scripts/test-gov-data.js   (source contract only)
//
// WHY: a hand-maintained upstream URL can silently rot while FREE_MODE CI
// treats gov-data as NETWORK-lenient and the weekly Algorand rail canary is
// the first hard fail. Pin the path so a regression back to /v3 fails CI.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { GOV_TOOLS } from "../src/tools/gov-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/tools/gov-kit.js", import.meta.url), "utf8");

// Pull only the gov-data tool body so college-lookup/fec (also DATA_GOV) don't
// dilute the assertions.
const start = src.indexOf('slug: "gov-data"');
const next = src.indexOf("slug: \"weather-alerts\"", start);
ok(start >= 0 && next > start, "gov-data tool block is found");
const body = start >= 0 && next > start ? src.slice(start, next) : "";

ok(!/`https:\/\/api\.gsa\.gov\/technology\/datagov\/v3/.test(body),
  "gov-data does not call the retired datagov/v3 CKAN proxy");
ok(!/package_search\?/.test(body), "gov-data does not call CKAN package_search");
ok(/`https:\/\/api\.gsa\.gov\/technology\/datagov\/v4\/search\?/.test(body),
  "gov-data calls Catalog API v4 /search");
ok(/per_page=\$\{rows\}/.test(body) || /per_page=\$\{/.test(body), "gov-data passes per_page (v4 pagination), not CKAN rows=");
ok(/["']x-api-key["']/.test(body) && /DATA_GOV_API_KEY/.test(body), "gov-data still sends x-api-key (DATA_GOV_API_KEY / DEMO_KEY)");
ok(/hasMore/.test(body), "gov-data surfaces hasMore (v4 has no catalog-wide count)");

const tool = GOV_TOOLS.find((t) => t.slug === "gov-data");
ok(Boolean(tool?.handler), "gov-data handler is exported");
ok(tool?.discovery?.input?.q === "electric vehicle charging stations", "discovery example query is stable");

if (process.env.GOV_DATA_OFFLINE === "1") {
  console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed (offline)`);
  process.exit(fail ? 1 : 0);
}

// Live probe — the class that bit production. A 404 here is a hard fail; 429
// from DEMO_KEY rate limits is a soft skip (Railway has a real key).
try {
  const out = await tool.handler({ q: "electric vehicle charging stations", rows: 3 });
  ok(out && out.query === "electric vehicle charging stations", "live handler echoes query");
  ok(typeof out.totalFound === "number" && out.totalFound >= 1, `live handler returns ≥1 result (got ${out?.totalFound})`);
  ok(Array.isArray(out.results) && out.results.length >= 1, "live handler returns results[]");
  const first = out.results[0];
  ok(typeof first.title === "string" && first.title.length > 0, "first result has a title");
  ok(typeof first.datasetUrl === "string" && first.datasetUrl.startsWith("https://catalog.data.gov/dataset/"),
    "first result datasetUrl points at catalog.data.gov");
  ok(Array.isArray(first.resources), "first result has resources[]");
} catch (e) {
  const msg = String(e?.message || e);
  if (/\b429\b|rate.?limit/i.test(msg)) {
    console.log(`skip - live DEMO_KEY probe rate-limited (${msg.slice(0, 120)})`);
  } else {
    ok(false, `live handler must succeed against Catalog API v4 (got: ${msg.slice(0, 200)})`);
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
