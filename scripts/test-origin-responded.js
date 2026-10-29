#!/usr/bin/env node
// A registry listing about a seller is not the seller answering.
//
//   node scripts/test-origin-responded.js
//
// WHY: ~32% of our index (742 of 2,296 crawled origins) reached us only as
// `bazaar-fallback` — the manifest fetch failed AND the OpenAPI fetch failed,
// so every field was synthesised from a third-party registry row. The crawl was
// still recorded as successful, because it completed, so those origins sat at
// health 1 / routable true and the marketplace rendered them "healthy". Sampling
// 60 live: 28 returned 404 or 301, several of them marked perfectly healthy.
//
// This is the exact defect we diagnosed in a third party the same day — a seller
// at health 1 with dead paid routes — at scale, in our own data, on a public
// page. A crawl completing is not a seller answering.
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { loadPersistedIndexCache, indexSnapshot, sellerDetail, routableSellerSummaries } from "../src/x402-index.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const tool = (o) => ({ slug: "t", price: 0.002, method: "GET", seller: o, route: "/api/t", networks: ["eip155:8453"] });
const entry = (o, extra) => [o, { origin: o, fetchedAt: Date.now(), history: [1], tools: [tool(o)], ...extra }];

const dir = mkdtempSync(join(tmpdir(), "a402-resp-"));
const file = join(dir, "cache.json");
writeFileSync(file, JSON.stringify({ entries: [
  entry("https://answered.test", { originResponded: true }),
  entry("https://registryonly.test", { originResponded: false, source: "bazaar-fallback" }),
  entry("https://legacy.test", {}), // predates the field
]}));
loadPersistedIndexCache(file);

const snap = indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "x" });
const row = (o) => (snap.sellers || []).find((s) => s.origin === o);

// --- the core rule ---------------------------------------------------------
ok(row("https://registryonly.test")?.routable === false,
  "a registry-only origin is NOT routable — we have no evidence it works");
ok(row("https://answered.test")?.routable === true, "an origin that answered stays routable");

// --- absence of the field must not demote anyone ---------------------------
// Entries predating this field carry no signal either way. Demoting them would
// punish sellers for a gap in OUR data, the same rule the payTo match follows.
ok(row("https://legacy.test")?.routable === true,
  "an entry predating the field keeps the old behaviour rather than being demoted");

// --- the field must reach EVERY accessor a consumer reads ------------------
// It was added to two of three first, and totals silently counted every seller
// as responded. A field present on some accessors is the inert-signal defect.
ok(row("https://registryonly.test")?.originResponded === false,
  "indexSnapshot carries originResponded (read by /api/index and the market pages)");
ok(sellerDetail("registryonly.test")?.originResponded === false,
  "sellerDetail carries it (read by seller-trust)");
// The history legend describes every write of a 1: a parsed manifest or a
// route list read from OpenAPI, agents.json or llms.txt.
ok(/1 = the crawl found routes \(the manifest parsed, or an OpenAPI, agents\.json or llms\.txt read listed them\), 0 = it found none/.test(String(sellerDetail("registryonly.test")?.historyLegend)),
  "sellerDetail's history legend names the fallback reads that also write a 1");
// routableSellerSummaries filters on isRoutable, so a registry-only origin is
// now ABSENT from it entirely — the router never even considers it. That is
// stronger than carrying the flag, and it is the property that matters: the
// spend gate cannot pick a seller we have never heard answer.
ok(!routableSellerSummaries().some((s) => s.origin === "https://registryonly.test"),
  "a registry-only origin is absent from the router's candidate pool entirely");
const answered = routableSellerSummaries().find((s) => s.origin === "https://answered.test");
ok(Boolean(answered) && answered.originResponded === true,
  "and a seller that answered is present, carrying the flag");

// --- the published count must exclude registry-only records ----------------
ok(snap.totals.respondedOrigins === snap.totals.sellers - 1,
  `respondedOrigins excludes the registry-only record (${snap.totals.respondedOrigins} of ${snap.totals.sellers})`);

// --- the HEALTH history must tell the same story as the flag ---------------
// The fix above set originResponded honestly and left the health history being
// rolled as a SUCCESS on the same branch, so a registry-only origin published
// health 1 while answering nothing. Reported from outside 2026-09-11: an origin
// whose root, /.well-known/x402, /openapi.json and /llms.txt all answer 404 was
// still routable at health 1 with a four-tool catalogue synthesised entirely
// from a registry row. Two fields, one condition, read once - so pin that the
// crawl branch derives BOTH from the same expression. A behavioural test cannot
// reach this line (it needs a live crawl of a dead origin), and the failure it
// guards is silent: the entry looks healthy, which is the whole problem.
{
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf('source: openapiTools.length ? "openapi-fallback" : "bazaar-fallback"'));
  const head = branch.slice(0, 2400);
  ok(/history: rollHistory\(prev, openapiTools\.length > 0\)/.test(head),
    "the fallback branch records crawl health from whether the ORIGIN answered, never from the crawl merely completing");
  ok(/originResponded: openapiTools\.length > 0/.test(head),
    "...the same condition originResponded is derived from, so the two cannot drift apart again");
  ok(!/history: rollHistory\(prev, true\)/.test(head),
    "and an unconditional success is gone from that branch");
}

// A stale record that still claims a healthy history is judged on the flag, not
// on the history - otherwise one ancient success launders an origin forever.
writeFileSync(file, JSON.stringify({ entries: [
  entry("https://staleheal.test", { originResponded: false, source: "bazaar-fallback", history: [1, 1, 1] }),
]}));
loadPersistedIndexCache(file);
ok(!routableSellerSummaries().some((s) => s.origin === "https://staleheal.test"),
  "a registry-only origin carrying a perfect health history is still kept out of the router's pool");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
