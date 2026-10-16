// seller-trust and seller-dossier report BOTH router lanes through the server's
// real wiring: a FREE_MODE boot with a seeded index, each tool called through
// its own route, beside the /api/index?seller= row the router's label comes
// from. A seller below the settlement floor with a route inside the Base
// unproven ceiling used to read "not routable" here while its index row (and
// the router) said the unproven lane could pay it.
//
// Rows are stored as the crawler's manifest reader stores them (dollar labels).
// A second boot switches the ceiling off and expects the lane to say so.
//
//   node scripts/test-seller-trust-lanes.js
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let pass = 0;
// A failed check exits at once, so it kills the booted servers itself (a
// finally block does not run past process.exit, and an orphan holds the pipe).
const procs = new Set();
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); for (const p of procs) p.kill("SIGTERM"); process.exit(1); } pass++; console.log(`ok - ${m}`); };

const PAYTO = "0x3D7718d5D868AF1Daae41D757244DE73DF72FB53";
const now = Date.now();
const seller = (origin, price) => [origin, {
  manifest: { name: "Catalog audit", homepage: origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
  payToByNetwork: { "eip155:8453": PAYTO },
  evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } },
  tools: [{ seller: origin, method: "POST", route: "/v1/catalog-audit", slug: "catalog-audit", name: "Catalog audit", description: "Validate a product catalog feed", category: "data", tags: [], price, networks: ["eip155:8453"] }],
}];
const CHEAP = "https://unproven-cheap.example";
const PRICEY = "https://unproven-pricey.example";

async function boot(ceiling) {
  const dir = mkdtempSync(join(tmpdir(), "a402-trust-lanes-"));
  const entries = [seller(CHEAP, "$0.005"), seller(PRICEY, "$0.02")];
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: entries.length }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), SOR_BASE_UNPROVEN_MAX_USD: ceiling },
    stdio: ["ignore", "ignore", "inherit"],
  });
  procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  let detail = null;
  for (let i = 0; i < 180 && !detail; i++) {
    try { const r = await fetch(`${base}/api/index?seller=${encodeURIComponent(CHEAP)}`); if (r.ok) detail = await r.json(); } catch {}
    if (!detail) await new Promise((r) => setTimeout(r, 500));
  }
  return { proc, base, detail };
}
const trust = async (base, origin) => { const r = await fetch(`${base}/api/x402/seller-trust?origin=${encodeURIComponent(origin)}`); return { status: r.status, body: await r.json() }; };
const dossier = async (base, origin) => {
  const r = await fetch(`${base}/api/seller-dossier`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- default ceiling
{
  const { proc, base, detail } = await boot("");
  try {
    ok(detail && detail.origin === CHEAP, "the seeded seller is in the index");
    const row = detail.tools?.[0];
    ok(row?.price === "$0.005" && row.routerDispatchByChain?.base?.unprovenTier === true, `its index tool row carries the unproven tier (${JSON.stringify(row?.routerDispatchByChain?.base)})`);

    const a = await trust(base, CHEAP);
    ok(a.status === 200 && a.body.listed === true, `seller-trust answers through its route (${a.status})`);
    ok(a.body.lanes?.proven?.eligible === false && a.body.routableAsProven === false, "below the floor: not proven");
    ok(a.body.lanes?.unproven?.eligible === true && a.body.lanes.unproven.maxUsd === row.routerDispatchByChain.base.unprovenMaxUsd && a.body.lanes.unproven.cheapestUsd === 0.005, `the unproven lane is eligible at the ceiling the index row shows (${JSON.stringify(a.body.lanes?.unproven)})`);
    ok(a.body.routableByOurRouter === true && a.body.routableVia === "unproven" && a.body.blockers.length === 0, "routableByOurRouter is true through the unproven lane");

    const b = await trust(base, PRICEY);
    ok(b.status === 200 && b.body.lanes?.proven?.eligible === false && b.body.lanes?.unproven?.eligible === false, "a $0.02-only seller below the floor: neither lane");
    ok(b.body.routableByOurRouter === false && /unproven ceiling/.test(b.body.lanes.unproven.reason || ""), `the refusal names the ceiling (${b.body.lanes?.unproven?.reason})`);

    const d = await dossier(base, CHEAP);
    ok(d.status === 200 && d.body?.router, `seller-dossier answers through its route (${d.status})`);
    ok(d.body.router.eligible === false && d.body.router.lanes?.unproven?.eligible === true && d.body.router.routable === true && d.body.router.routableVia === "unproven", `the dossier's router block reports the unproven lane (${JSON.stringify({ eligible: d.body.router.eligible, routable: d.body.router.routable, lanes: d.body.router.lanes })})`);
    ok(d.body.flags.some((f) => /Base unproven lane/.test(f)), "the dossier flags the unproven lane");
  } finally { proc.kill("SIGTERM"); }
}

// ---- ceiling switched off
{
  const { proc, base, detail } = await boot("off");
  try {
    ok(detail && detail.tools?.[0]?.routerDispatchByChain?.base?.unprovenTier === undefined, "with the ceiling off the index row carries no tier");
    const a = await trust(base, CHEAP);
    ok(a.status === 200 && a.body.lanes?.unproven?.eligible === false && a.body.lanes.unproven.maxUsd === 0 && /switched off/.test(a.body.lanes.unproven.reason || ""), `the unproven lane is ineligible and says the ceiling is off (${JSON.stringify(a.body.lanes?.unproven)})`);
    ok(a.body.routableByOurRouter === false && a.body.routableVia === null, "and the seller is not routable");
    const d = await dossier(base, CHEAP);
    ok(d.status === 200 && d.body.router.routable === false && d.body.router.lanes?.unproven?.eligible === false, "the dossier agrees");
  } finally { proc.kill("SIGTERM"); }
}
console.log(`OK: ${pass} passed`);
process.exit(0);
