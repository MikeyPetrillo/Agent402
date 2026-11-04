// Locks the resources[] dedup fix (2026-08-16 audit): serviceManifest()
// mapped Object.keys(catalog) straight to URLs with no dedup - a handful of
// tools (e.g. /api/memory) are registered TWICE in the catalog, once per
// HTTP method (GET read, POST write), so their URL appeared twice in
// /.well-known/x402's resources[] with no way for a consumer to tell why.
// x402scan's discovery format wants a flat URL list, not a method-annotated
// one (openapi.json already carries that), so the fix is to dedupe by URL.
//
// Offline - calls serviceManifest() directly with a fixture catalog that
// deliberately includes a GET+POST pair on the same path, so this is a
// non-vacuous check (a catalog with no duplicate paths at all would pass
// trivially and prove nothing).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { serviceManifest } from "../src/discovery.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const FIXTURE_CATALOG = {
  "GET /api/memory": { slug: "memory-get", name: "Memory read" },
  "POST /api/memory": { slug: "memory-post", name: "Memory write" },
  "POST /api/hash": { slug: "hash", name: "Hash" },
};

const manifest = serviceManifest({
  baseUrl: "https://agent402.tools", network: "base", networks: ["base"],
  wallet: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", walletName: "agent402.base.eth",
  catalog: FIXTURE_CATALOG, toolCount: 3, powSlugs: new Set(), powDifficulty: 20, prices: {},
});

ok(Array.isArray(manifest.resources), "manifest.resources is an array");
const memoryUrl = "https://agent402.tools/api/memory";
const memoryCount = manifest.resources.filter((r) => r === memoryUrl).length;
ok(memoryCount === 1, `/api/memory (registered under 2 methods in the fixture) appears exactly once in resources[] (got ${memoryCount})`);
ok(manifest.resources.includes("https://agent402.tools/api/hash"), "a normal, single-method tool is still present");
ok(manifest.resources.length === new Set(manifest.resources).size, "no duplicate URL anywhere in resources[] (general dedup, not just the /api/memory special case)");
ok(manifest.resources.length === 2, `3 catalog entries (2 of which collapse to 1 URL) produce exactly 2 distinct resource URLs (got ${manifest.resources.length})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
