#!/usr/bin/env node
// Consumers must only read fields the PRODUCERS actually emit.
//
//   node scripts/test-producer-shapes.js
//
// WHY: this exact defect shipped four times in one day, and twice AFTER a test
// was written to prevent it.
//
//   * provenByChain() read `payToByNetwork` off routableSellerSummaries(),
//     which did not emit it -> the router's chain evidence was empty, always.
//   * probePaywall() filtered on `t.url`, which NO tool producer emits ->
//     the paywall signal was permanently null.
//   * advertisedPayToEvidence() read `payToByNetwork` off sellerDetail(),
//     which did not emit it -> the paid seller-trust tool reported "advertises
//     no payTo" for every seller.
//
// Every one passed its own unit tests, because those tests built the input by
// hand. A fixture cannot notice that it is fiction: the test asserts the
// function works on the shape the AUTHOR imagined, and production hands it a
// different one. Unit tests over hand-built objects are structurally incapable
// of catching this, no matter how many you write.
//
// So this asserts the CONTRACT BETWEEN modules, using real producer output and
// no fixtures: for each (producer, consumer) pair, the fields the consumer
// reads must exist on what the producer returns.
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { bazaarItemToTool, normaliseOpenapiTools, routableSellerSummaries, sellerDetail, loadPersistedIndexCache } from "../src/x402-index.js";
import { baseNetworkPayTo } from "../src/settlement-proof.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

const BASE = "eip155:8453";
const ADDR = "0x" + "a".repeat(40);

// --- 1. TOOL ROWS: what every tool producer must emit ----------------------
// probePaywall derives its target as `${t.seller}${t.route}` — the same way
// routeQuery builds a callable url. Both fields must exist on every producer,
// and `url` must NOT be relied on, because none of them set it.
{
  const fromBazaar = bazaarItemToTool(
    { resource: "https://seller.example/api/thing", method: "GET", name: "T", description: "d",
      accepts: [{ network: BASE, payTo: ADDR, amount: "2000", asset: "0x" + "b".repeat(40) }] },
    "https://seller.example"
  );
  const fromOpenapi = normaliseOpenapiTools(
    { paths: { "/api/x": { get: { summary: "s", "x-price": "$0.002" } } } },
    "https://seller.example"
  )[0];

  for (const [name, row] of [["bazaarItemToTool", fromBazaar], ["normaliseOpenapiTools", fromOpenapi]]) {
    ok(has(row, "seller") && typeof row.seller === "string", `${name} emits a string \`seller\` (probePaywall target half 1)`);
    ok(has(row, "route") && String(row.route).startsWith("/"), `${name} emits a rooted \`route\` (probePaywall target half 2)`);
    ok(has(row, "price"), `${name} emits \`price\` (the paid-route filter)`);
    // The trap, pinned explicitly: a consumer that filters on `url` matches
    // nothing and fails silently.
    ok(!has(row, "url"), `${name} does NOT emit \`url\` — consumers must derive seller+route, never read t.url`);
  }
  ok(has(fromBazaar, "payToByNetwork"), "bazaarItemToTool emits payToByNetwork (the only source of a seller payTo)");
}

// --- 2. SELLER ACCESSORS: the fields their consumers actually read ----------
{
  const dir = mkdtempSync(join(tmpdir(), "a402-shape-"));
  const file = join(dir, "cache.json");
  writeFileSync(file, JSON.stringify({
    entries: [["https://s.example", {
      origin: "https://s.example", fetchedAt: Date.now(), health: 1,
      tools: [{ slug: "t", name: "t", price: 0.002, method: "GET",
        seller: "https://s.example", route: "/api/t",
        networks: [BASE], payToByNetwork: { [BASE]: ADDR } }],
    }]],
  }));
  loadPersistedIndexCache(file);

  // provenByChain / unattributedMerchants read payToByNetwork off THIS.
  const summaries = routableSellerSummaries();
  const remote = summaries.find((s) => s.origin === "https://s.example");
  ok(Boolean(remote), "routableSellerSummaries returns the crawled seller");
  ok(has(remote, "payToByNetwork"), "routableSellerSummaries emits payToByNetwork (read by provenByChain)");
  ok(baseNetworkPayTo(remote) === ADDR.toLowerCase(),
    `baseNetworkPayTo resolves an address from the REAL accessor (got ${baseNetworkPayTo(remote)})`);

  // advertisedPayToEvidence reads payToByNetwork off THIS one — server.js
  // passes sellerDetail()'s return as its `seller` argument.
  const detail = sellerDetail("s.example");
  ok(Boolean(detail), "sellerDetail returns the crawled seller");
  ok(has(detail, "payToByNetwork"), "sellerDetail emits payToByNetwork (read by advertisedPayToEvidence)");
  ok(baseNetworkPayTo(detail) === ADDR.toLowerCase(),
    `baseNetworkPayTo resolves an address from sellerDetail too (got ${baseNetworkPayTo(detail)})`);
  ok(has(detail, "paywall"), "sellerDetail emits paywall (read by the seller-trust tool)");

  rmSync(dir, { recursive: true, force: true });
}

// A SELLER CAN SEE THEIR OWN PUBLISHED TEXT (2026-09-18). sellerDetail's tool
// projection carried method/route/slug/name/price and dropped description and
// tags, so the surface a seller checks after editing their OpenAPI could not
// tell them the edit had landed - measured on a seller who deployed a
// description and eight tags we had asked for and saw neither here, while the
// index held both the whole time. Their own document, echoed back.
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a402-detail-"));
  const file = join(dir, "cache.json");
  writeFileSync(file, JSON.stringify({ entries: [["https://meta.example", {
    manifest: { name: "Meta" },
    tools: [{ route: "/v1/compare", method: "POST", slug: "compare", name: "Rank a field", description: "Compare and rank candidates against the current task", tags: ["compare", "rank"], price: 0.01 }],
    fetchedAt: Date.now(), error: null, history: [true],
  }]] }));
  loadPersistedIndexCache(file);
  const d = sellerDetail("https://meta.example");
  const row = (d?.tools || [])[0] || {};
  ok((row.description || "").includes("rank candidates"), "sellerDetail echoes the seller's own description");
  ok(Array.isArray(row.tags) && row.tags.includes("compare"), "sellerDetail echoes the seller's own tags");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
