// seller-trust and seller-dossier report BOTH router lanes through the server's
// real wiring: a FREE_MODE boot with a seeded index, each tool called through
// its own route, beside the /api/index?seller= row the router's label comes
// from. A seller below the settlement floor with a route inside the Base
// unproven ceiling used to read "not routable" here while its index row (and
// the router) said the unproven lane could pay it.
//
// Rows are stored as the crawler's manifest reader stores them (dollar labels).
// Two proven sellers (a leaderboard snapshot pays each at its own advertised
// wallet) check the proven lane's route-execute tiers, read off EXEC_TIERS.
// A second boot switches the ceiling off and expects the lane to say so.
//
//   node scripts/test-seller-trust-lanes.js
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { EXEC_TIERS } from "../src/tools/route-execute.js";

const TIERS_ASC = [...EXEC_TIERS].sort((a, b) => a.underlyingMaxUsd - b.underlyingMaxUsd);
const tierFor = (usd) => TIERS_ASC.find((t) => usd <= t.underlyingMaxUsd) || null;
const HIGHEST = TIERS_ASC[TIERS_ASC.length - 1];
const OVER_TOP = Number((HIGHEST.underlyingMaxUsd * 1.2).toFixed(4));

let pass = 0;
// A failed check exits at once, so it kills the booted servers itself (a
// finally block does not run past process.exit, and an orphan holds the pipe).
const procs = new Set();
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); for (const p of procs) p.kill("SIGTERM"); process.exit(1); } pass++; console.log(`ok - ${m}`); };

const PAYTO = "0x3D7718d5D868AF1Daae41D757244DE73DF72FB53";
const now = Date.now();
const seller = (origin, price, payTo = PAYTO) => [origin, {
  manifest: { name: "Catalog audit", homepage: origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
  payToByNetwork: { "eip155:8453": payTo },
  evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } },
  tools: [{ seller: origin, method: "POST", route: "/v1/catalog-audit", slug: "catalog-audit", name: "Catalog audit", description: "Validate a product catalog feed", category: "data", tags: [], price, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo } }],
}];
const CHEAP = "https://unproven-cheap.example";
const PRICEY = "https://unproven-pricey.example";
const MID = "https://proven-mid.example", HUGE = "https://proven-huge.example";
const W_MID = "0x1111111111111111111111111111111111111111", W_HUGE = "0x2222222222222222222222222222222222222222";

async function boot(ceiling) {
  const dir = mkdtempSync(join(tmpdir(), "a402-trust-lanes-"));
  const entries = [seller(CHEAP, "$0.005"), seller(PRICEY, "$0.02"), seller(MID, "$0.04", W_MID), seller(HUGE, `$${OVER_TOP}`, W_HUGE)];
  const lbFile = join(dir, "leaderboard-snapshot.json");
  writeFileSync(lbFile, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: new Date(now).toISOString(), windowLabel: "7d",
    leaderboard: [
      { rank: 1, homepage: MID, origins: [MID], wallet: W_MID, wallets: [W_MID], callsSettled: 500, uniqueBuyers: 40 },
      { rank: 2, homepage: HUGE, origins: [HUGE], wallet: W_HUGE, wallets: [W_HUGE], callsSettled: 500, uniqueBuyers: 40 },
    ],
    walletEvidence: { [W_MID]: { callsSettled: 500, uniqueBuyers: 40, origins: [MID] }, [W_HUGE]: { callsSettled: 500, uniqueBuyers: 40, origins: [HUGE] } },
  }));
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: entries.length }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), SOR_BASE_UNPROVEN_MAX_USD: ceiling, LEADERBOARD_SNAPSHOT_FILE: lbFile },
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
    ok(a.body.lanes.unproven.cheapestTier === tierFor(0.005).slug, `the unproven lane names the cheapest tier covering its route (${a.body.lanes.unproven.cheapestTier})`);

    const m = await trust(base, MID);
    const mRow = (await (await fetch(`${base}/api/index?seller=${encodeURIComponent(MID)}`)).json()).tools?.[0];
    ok(mRow?.routerDispatchByChain?.base?.eligible === true, `control: the $0.04 seller's index row is proven-eligible (${JSON.stringify(mRow?.routerDispatchByChain?.base)})`);
    ok(m.body.routableAsProven === true && m.body.routableVia === "proven" && m.body.lanes.proven.cheapestTier === "route-execute-plus" && tierFor(0.04).slug === "route-execute-plus", `a proven $0.04 seller is paid via route-execute-plus (${JSON.stringify(m.body.lanes?.proven)})`);
    ok(!m.body.lanes.proven.tiers.some((t) => t.slug === "route-execute"), "...and not via route-execute");

    const h = await trust(base, HUGE);
    const line = (h.body.lanes?.proven?.blockers || []).find((b) => /highest route-execute tier/.test(b));
    ok(h.body.routableAsProven === false && h.body.routableByOurRouter === false && h.body.lanes.proven.tiers.length === 0, `a proven seller above every tier's cap is not routable (${JSON.stringify(h.body.lanes?.proven)})`);
    ok(line && line.includes(`$${HIGHEST.underlyingMaxUsd}`) && line.includes(HIGHEST.slug), `the blocker names the highest tier's cap (${line})`);
    const md = await dossier(base, MID);
    ok(md.status === 200 && md.body.router.routable === true && md.body.router.routableVia === "proven" && md.body.router.lanes?.proven?.cheapestTier === "route-execute-plus", `the dossier names the same tier for the proven $0.04 seller (${md.body.router.lanes?.proven?.cheapestTier})`);

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
