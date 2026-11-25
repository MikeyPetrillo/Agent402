#!/usr/bin/env node
// A rail we accept money on must have a name, or its revenue reads as a hex id.
//
//   node scripts/test-chain-names.js          (offline)
//
// WHY: Sei and Optimism shipped as payment rails without an entry in
// CAIP2_NAMES, so every settlement on them was booked under its raw CAIP-2 id
// and shown that way on the PUBLIC /api/stats - "eip155:10" rather than
// "optimism". Nothing was lost on-chain, but the named bucket and the id
// bucket are different counters, so per-chain revenue read low for both and a
// reader comparing rails would have drawn the wrong conclusion.
//
// The same gap left older chains split across two rows at once: monad 19
// beside eip155:143 42, celo 35 beside eip155:42220 16, stellar beside
// stellar:pubnet. Those are historical counters from before their entry
// existed, which is why the merge happens at read time.
//
// This is the guard that makes adding a rail without naming it fail loudly.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { KNOWN_CAIP2, mergeNetworkCounters } from "../src/stats.js";
import { NETWORKS } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// 1. Every chain the server CAN offer must be nameable. Sourced from the static
//    NETWORKS map rather than railStatus(), which reads boot state and is empty
//    offline - the first version of this test called it and cheerfully passed
//    while checking zero rails, which is the same vacuous-green failure the
//    rest of this audit kept finding.
const mainnet = Object.entries(NETWORKS).filter(([n]) => !/sepolia|devnet|testnet/i.test(n));
ok(mainnet.length >= 12, `NETWORKS lists the mainnet rails to check (${mainnet.length})`);
const unnamed = mainnet.filter(([, caip2]) => caip2 && !KNOWN_CAIP2[caip2]);
ok(unnamed.length === 0,
  `every offerable chain's CAIP-2 id has a name${unnamed.length ? ` (unnamed: ${unnamed.map(([n, c]) => `${n}=${c}`).join(", ")})` : ""}`);

// The two that shipped unnamed, pinned by id so a revert is caught.
ok(KNOWN_CAIP2["eip155:10"] === "optimism", "optimism (eip155:10) is named");
ok(KNOWN_CAIP2["eip155:1329"] === "sei", "sei (eip155:1329) is named");

// 2. The read-time merge folds an id bucket into its named one, so one chain
//    is one row. This is what stops the public surface understating a rail.
const merged = mergeNetworkCounters([
  ["monad", 19], ["eip155:143", 42],
  ["celo", 35], ["eip155:42220", 16],
  ["base", 6828],
]);
ok(merged.monad === 61, `monad's two counters merge to one row (${merged.monad})`);
ok(merged.celo === 51, `celo's two counters merge to one row (${merged.celo})`);
ok(!("eip155:143" in merged) && !("eip155:42220" in merged),
  "the raw id rows are gone, not served alongside the named ones");
ok(merged.base === 6828, "a chain with only one spelling is unchanged");

// 3. An id we genuinely cannot name must still appear rather than vanish.
//    Silently dropping revenue would be far worse than showing a hex id.
const unknown = mergeNetworkCounters([["eip155:99999", 7], ["base", 1]]);
ok(unknown["eip155:99999"] === 7,
  "an unnameable chain still reports its count under the raw id - never dropped");

// 4. Totals are conserved. A merge that loses or duplicates a call would be a
//    worse defect than the split it fixes.
const before = [["monad", 19], ["eip155:143", 42], ["stellar", 71], ["stellar:pubnet", 20], ["x:1", 3]];
const sumBefore = before.reduce((a, [, n]) => a + n, 0);
const sumAfter = Object.values(mergeNetworkCounters(before)).reduce((a, n) => a + n, 0);
ok(sumBefore === sumAfter, `merging conserves the total (${sumBefore} -> ${sumAfter})`);

// 5. Pages and answers show each chain's official name (src/rails.js), while
//    the snapshot's rail label, the counters and the URLs keep their keys.
{
  const { revenuePage, publicRevenueSnapshot, liveScanRailLabels } = await import("../src/revenue-live.js");
  const { RAILS, chainDisplayName } = await import("../src/rails.js");
  const labels = liveScanRailLabels();
  const snap = {
    asOf: "2026-11-24T00:00:00.000Z",
    rails: labels.map((rail) => ({ rail, asset: "USDC", wallet: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", recent: [] })),
    allTime: { allTimeInboundCount: 0, allTimeExternalCount: 0, allTimeExternalUsd: 0, perChain: {} },
    standing: {},
  };
  const html = revenuePage("https://example.test", snap);
  const x402Rows = html.slice(html.indexOf('data-rv-live="rails"'), html.indexOf("</tbody>", html.indexOf('data-rv-live="rails"')));
  const cells = [...x402Rows.matchAll(/<td><strong>([^<]+)<\/strong> <span/g)].map((m) => m[1]);
  const official = new Set(RAILS.map((r) => r.name));
  ok(cells.length === labels.length && cells.every((c) => official.has(c)), `every /revenue chain row shows its official name (${cells.filter((c) => !official.has(c)).join(", ") || "all"})`);
  for (const n of ["OP Mainnet", "Arbitrum One", "Avalanche C-Chain", "Robinhood Chain"]) ok(cells.includes(n), `/revenue names ${n}`);
  ok(!cells.some((c) => /^(Optimism|Arbitrum|Avalanche)$/.test(c)), "/revenue shows no short chain name as a display name");
  const pub = publicRevenueSnapshot(snap);
  ok(pub.rails.every((r, i) => r.rail === labels[i]), "/api/revenue keeps each rail's label unchanged (a join key)");
  ok(pub.rails.every((r) => official.has(r.name)), `/api/revenue gives each rail its official name (${pub.rails.filter((r) => !official.has(r.name)).map((r) => r.rail).join(", ") || "all"})`);
  ok(pub.rails.find((r) => r.rail === "Optimism")?.name === "OP Mainnet" && chainDisplayName("optimism") === "OP Mainnet", "OP Mainnet is read from the one name source");
  // A chain page's host line ("outside buyers on <chain> only") reads the same source.
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/networkLabel: chainKey \? chainDisplayName\(chainKey\) : null/.test(server), "the chain pages' host figures name the chain with chainDisplayName");
}

// 6. Tool descriptions, the curated Bazaar listings and the flagship list name
//    chains officially. A param's value list keeps its keys (lowercase).
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const SHORT = /\b(Optimism\b(?!:)|Arbitrum\b(?! One| Orbit| Sepolia)|Avalanche\b(?! C-Chain| Fuji)|Robinhood\b(?! Chain))/;
  const files = [...readdirSync(new URL("../src/tools/", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => `src/tools/${f}`), "src/mpp-flagship.js"];
  const hits = [];
  for (const f of files) {
    readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (!/description|why:|^"|^`/.test(t)) return;
      if (/label: "Optimism: /.test(t)) return; // a contract's own label
      if (SHORT.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  ok(hits.length === 0, `tool descriptions name chains officially (${hits.slice(0, 6).join(", ") || "none"})`);
  const { BAZAAR_DESCRIPTIONS } = await import("../src/payments.js");
  const curated = Object.entries(BAZAAR_DESCRIPTIONS).filter(([, d]) => SHORT.test(d)).map(([k]) => k);
  ok(curated.length === 0, `curated Bazaar listings name chains officially (${curated.join(", ") || "none"})`);
  ok(SHORT.test("on Arbitrum or Optimism") && !SHORT.test("on Arbitrum One or OP Mainnet (an Arbitrum Orbit chain)"), "CONTROL: the check catches a short name and passes the official ones");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
