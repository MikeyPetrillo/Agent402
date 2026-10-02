// A Base seller below the settlement floor, priced within the unproven ceiling,
// is dispatched by the router after every proven candidate. Its public labels
// must say so on BOTH surfaces a seller reads: the /api/route row (callable now,
// executeViaLane "unproven") and its own /api/index?seller= tool row (which used
// to carry only the seller-level verdict, where a price-less row can never show
// the tier). Two sellers read the seller row, saw "not eligible", and asked.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); process.exit(1); } pass++; console.log(`ok - ${m}`); };
const origin = "https://unproven-seller.example";
const now = Date.now();
const entry = {
  manifest: { name: "Catalog audit", homepage: origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
  payToByNetwork: { "eip155:8453": "0x3D7718d5D868AF1Daae41D757244DE73DF72FB53" },
  evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } },
  tools: [{ seller: origin, method: "POST", route: "/v1/catalog-audit", slug: "catalog-audit", name: "Catalog audit", description: "Validate a product catalog feed for duplicate ids and GTIN checksum errors", category: "data", tags: [], price: 0.01, networks: ["eip155:8453"] }],
};
const dir = mkdtempSync(join(tmpdir(), "a402-unproven-"));
const file = join(dir, "x402-index-cache.json");
writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: 1 }), JSON.stringify([origin, entry])].join("\n") + "\n");
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: file, INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), SOR_BASE_UNPROVEN_MAX_USD: "" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  const base = `http://127.0.0.1:${port}`;
  let detail = null;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/api/index?seller=${encodeURIComponent(origin)}`); if (r.ok) { detail = await r.json(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(detail && detail.origin === origin, "the seeded seller is in the index");
  const tool = (detail.tools || [])[0];
  ok(tool && tool.routerDispatchByChain?.base?.unprovenTier === true && tool.routerDispatchByChain.base.unprovenMaxUsd === 0.01, `the seller's own tool row shows the unproven tier (${JSON.stringify(tool?.routerDispatchByChain?.base)})`);
  ok(detail.routerDispatchByChain?.base?.unprovenTier === undefined, "the seller-level verdict (no single price) still carries no tier");
  const rt = await (await fetch(`${base}/api/route?q=${encodeURIComponent("validate product catalog feed GTIN")}&include=external&top=10`)).json();
  const row = (rt.results || []).find((r) => r.seller === origin);
  ok(row, "the route row is returned");
  ok(row.executeVia && row.executeViaCallableNow === true && row.executeViaLane === "unproven" && row.executeViaWhenEligible === undefined, `the route row is callable now in the unproven lane (${JSON.stringify({ executeVia: !!row.executeVia, now: row.executeViaCallableNow, lane: row.executeViaLane })})`);
  ok(row.routerDispatchEligible === false && row.routerDispatchReason === "settlement_required", "it is still not a proven seller");
} finally { proc.kill("SIGTERM"); }
console.log(`OK: ${pass} passed`);
