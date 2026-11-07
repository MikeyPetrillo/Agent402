// The live rail scan behind /revenue runs once per period across containers
// (src/revenue-live.js): with a shared store the refresh runs under a lease
// and saves the whole snapshot, and a container whose copy is stale adopts a
// saved snapshot younger than the TTL instead of scanning, a boot included.
// Without a shared store each process scans on its own, as before. Also pins
// the refresh cadences (src/refresh-cadence.js) and the copy that states them.
// Offline: the scan, the store and the lease are injected; two module
// instances stand in for two replicas.

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const H = 3_600_000;
const cad = await import("../src/refresh-cadence.js");
ok(cad.REVENUE_SNAPSHOT_DEFAULT_TTL_MS === 4 * H && cad.REVENUE_SNAPSHOT_TTL_MS === 4 * H, "the live rail scan refreshes every 4 hours by default");
ok(cad.LEADERBOARD_DEFAULT_REFRESH_MS === 4 * H && cad.LEADERBOARD_REFRESH_MS === 4 * H, "the Base seller leaderboard refreshes every 4 hours by default");
ok(cad.cadenceWords(4 * H) === "every 4 hours" && cad.cadenceWords(H) === "hourly" && cad.cadenceWords(30 * 60_000) === "every 30 minutes" && cad.cadenceBadge(4 * H) === "EVERY 4H", "the cadence words follow the value");

// The env overrides are read at import: a child process with them set.
{
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", 'const c = await import("./src/refresh-cadence.js"); console.log(JSON.stringify([c.REVENUE_SNAPSHOT_TTL_MS, c.LEADERBOARD_REFRESH_MS, c.leaderboardCadence(), c.revenueSnapshotCadence()]));'],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, REVENUE_SNAPSHOT_TTL_MS: String(2 * H), LEADERBOARD_REFRESH_MS: String(H) } }).toString().trim();
  ok(out === JSON.stringify([2 * H, H, "hourly", "every 2 hours"]), `REVENUE_SNAPSHOT_TTL_MS and LEADERBOARD_REFRESH_MS override the defaults, and the copy follows (${out})`);
}

// --- one scan per period across two replicas
let clock = Date.parse("2026-10-23T04:00:00Z");
const now = () => clock;
let scans = 0;
// A stub scan returns a row for every rail the real scan reads now (Base
// first, the rest empty), the way refreshSnapshot does.
let EVM_OF = null; // set once the first module instance is imported
const liveLabels = () => [...Object.values(EVM_OF).map((c) => c.label), "Solana", "Stellar", "Algorand"];
const scan = async () => { scans++; return { spec: "agent402-revenue/1", asOf: new Date(clock).toISOString(), rails: [{ rail: "Base", balance: scans, recent: Array.from({ length: 80 }, (_, i) => ({ when: i, tx: "0x" + i })) }, ...liveLabels().filter((l) => l !== "Base").map((rail) => ({ rail, balance: 0, recent: [] }))] }; };
const shared = { body: null, saves: 0 };
const store = { read: async () => (shared.body ? JSON.parse(JSON.stringify(shared.body)) : null), save: async (s) => { shared.saves++; shared.body = JSON.parse(JSON.stringify(s)); return true; } };
let held = false;
const lease = async (fn) => { if (held) return { skipped: "leased", reason: "held" }; held = true; try { return await fn(); } finally { held = false; } };

// Every real rail has graduated, so the offer below rehearses on a synthetic
// gated read-config (the NODE_ENV=test seam in src/revenue-live.js).
process.env.NODE_ENV = "test";
process.env.REVENUE_TEST_GATED_EVM = JSON.stringify({ testgated: { caip2: "eip155:999001", label: "Testgated", asset: "USDC", span: 1000, token: "0x0000000000000000000000000000000000000001", rpcs: ["http://127.0.0.1:9"], explorer: (a) => a, tx: (h) => h } });
const A = await import("../src/revenue-live.js?replica=a");
const B = await import("../src/revenue-live.js?replica=b");
EVM_OF = A.EVM;
A._setRevenueSnapshotDepsForTest({ scan, store, lease, now });
B._setRevenueSnapshotDepsForTest({ scan, store, lease, now });
// A cold process may first answer the saved last-good reading (a local file)
// while its refresh runs; settle reads again once the refresh has landed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (M) => { await M.revenueSnapshot({}); await sleep(20); return M.revenueSnapshot({}); };

const a1 = await settle(A);
ok(scans === 1 && shared.saves === 1 && a1.rails[0].balance === 1, "the first replica scans once and saves the snapshot for the other");
ok(shared.body.rails[0].recent.length === 50 && JSON.stringify(shared.body).length < 64 * 1024, `the saved copy caps recent rows per rail (${shared.body.rails[0].recent.length}) and stays small (${JSON.stringify(shared.body).length} bytes)`);
const b1 = await settle(B);
ok(scans === 1 && b1.rails[0].balance === 1 && b1.asOf === a1.asOf, "the second replica adopts the saved snapshot instead of scanning");

clock += 3 * H;
await A.revenueSnapshot({}); await B.revenueSnapshot({});
ok(scans === 1, "inside the 4-hour period neither replica scans again");

clock += 2 * H; // 5 h after the scan: both copies are stale
const a2p = A.revenueSnapshot({});
const a2 = await a2p;
ok(a2.rails[0].balance === 1, "a stale replica serves what it has at once (stale-while-revalidate)");
await new Promise((r) => setTimeout(r, 20));
ok(scans === 2 && shared.saves === 2, "one replica rescans once the period has passed");
const b2first = await B.revenueSnapshot({});
await new Promise((r) => setTimeout(r, 20));
const b2 = await B.revenueSnapshot({});
ok(scans === 2 && b2first.rails[0].balance === 1 && b2.rails[0].balance === 2, "the other adopts that rescan instead of scanning: one scan per period across both");

// A boot: a fresh process adopts a fresh saved snapshot without scanning.
const C = await import("../src/revenue-live.js?replica=c");
C._setRevenueSnapshotDepsForTest({ scan, store, lease, now });
const c1 = await settle(C);
ok(scans === 2 && c1.rails[0].balance === 2, "a booting replica adopts the fresh saved snapshot without scanning");

// While another container holds the lease, a stale replica keeps serving and
// does not scan; it looks again after a short pause.
clock += 5 * H;
held = true;
const d1 = await C.revenueSnapshot({});
await new Promise((r) => setTimeout(r, 20));
ok(scans === 2 && d1.rails[0].balance === 2, "with the lease held elsewhere the replica serves its copy and does not scan");
held = false;
await C.revenueSnapshot({});
await new Promise((r) => setTimeout(r, 20));
ok(scans === 2, "...and does not retry on every request (a short pause first)");
clock += 31_000;
await C.revenueSnapshot({});
await new Promise((r) => setTimeout(r, 20));
ok(scans === 3, "...then scans once the pause is over and the lease is free");

// No shared store: each process scans on its own, as before.
const E = await import("../src/revenue-live.js?replica=e");
const F = await import("../src/revenue-live.js?replica=f");
E._setRevenueSnapshotDepsForTest({ scan, store: null, now });
F._setRevenueSnapshotDepsForTest({ scan, store: null, now });
const before = scans;
await settle(E); await settle(F);
ok(scans === before + 2, "without a shared store each process scans for itself");

// --- a failed scan keeps the last snapshot and retries after a pause, not on every request
{
  const M = await import("../src/revenue-live.js?replica=fail");
  let tries = 0, failing = false;
  const flaky = async (o) => { tries++; if (failing) throw new Error("rpc down"); return scan(o); };
  M._setRevenueSnapshotDepsForTest({ scan: flaky, store: null, now });
  const first = await settle(M);
  clock += 5 * H; failing = true;
  const tries0 = tries;
  const kept = await M.revenueSnapshot({}); await sleep(20);
  await M.revenueSnapshot({}); await sleep(20);
  await M.revenueSnapshot({}); await sleep(20);
  ok(kept.asOf === first.asOf && tries === tries0 + 1, `a failed scan keeps serving the last snapshot and does not rescan on every request (${tries - tries0} tries)`);
  clock += 31_000; failing = false;
  await M.revenueSnapshot({}); await sleep(20);
  const after = await M.revenueSnapshot({});
  ok(tries === tries0 + 2 && after.asOf !== first.asOf, "...and scans again once the pause is over");
}

// --- a rail offered after a snapshot was taken makes that snapshot due, a
// boot's adopted copy included (production 2026-11-06: a deploy that offered a
// gated rail adopted a saved snapshot younger than the period, so the live
// read carried no row for that rail until the period ran out).
{
  const { GATED_EVM } = A;
  const [gKey, gCfg] = Object.entries(GATED_EVM).find(([k]) => !A.EVM[k]) || [];
  ok(Boolean(gKey), "a gated rail with a read-config is available to offer in this test");
  const { markGatedRailOffered } = await import("../src/gated-rails.js");
  // One replica's saved snapshot, taken before the offer, inside its period.
  clock += 5 * H;
  const G = await import("../src/revenue-live.js?replica=g");
  G._setRevenueSnapshotDepsForTest({ scan, store, lease, now });
  const g0 = await settle(G);
  const preScans = scans;
  ok(g0.rails.every((r) => r.rail !== gCfg.label), "the saved snapshot predates the gated rail");
  ok(typeof G.revenueSnapshotFreshness === "function" && G.revenueSnapshotFreshness(g0, clock) === "fresh", "before the offer the saved snapshot reads fresh");
  clock += 60_000;
  markGatedRailOffered(gCfg.caip2);
  ok(Boolean(G.EVM[gKey]), "the offer activates the rail's read-config");
  ok(G.revenueSnapshotFreshness?.(g0, clock) === "due", `inside the grace a snapshot missing the newly offered rail reads due (${G.revenueSnapshotFreshness?.(g0, clock)})`);
  ok(G.revenueCadenceFields(g0, clock).nextRefreshAt === new Date(clock).toISOString(), "its nextRefreshAt is now, not the end of its period");
  // A booting replica must not adopt the saved copy that lacks the rail.
  const H2 = await import("../src/revenue-live.js?replica=h");
  H2._setRevenueSnapshotDepsForTest({ scan, store, lease, now });
  const h1 = await settle(H2);
  ok(scans === preScans + 1 && h1.rails.some((r) => r.rail === gCfg.label), `a boot after the offer rescans instead of adopting the saved copy without the rail (${scans - preScans} scan(s))`);
  // A running replica whose own copy predates the offer adopts that rescan.
  await G.revenueSnapshot({}); await sleep(20);
  const g1 = await G.revenueSnapshot({});
  ok(scans === preScans + 1 && g1.rails.some((r) => r.rail === gCfg.label), "a running replica's copy without the rail is replaced (adopted, no second scan)");
  ok(G.revenueSnapshotFreshness(g1, clock) === "fresh" && G.revenueLiveStatus().status === "fresh", "and its freshness reads fresh again");
  // Past the grace with no refresh landing, the word reads stale.
  ok(G.revenueSnapshotFreshness(g0, clock + G.REVENUE_SNAPSHOT_GRACE_MS) === "stale", "a copy still missing the rail past the grace reads stale");
  ok(G.revenueSnapshotFreshness(g1, clock + 4 * H + 10 * 60_000) === "due" && G.revenueSnapshotFreshness(g1, clock + 4 * H + G.REVENUE_SNAPSHOT_GRACE_MS) === "stale", "past its period it reads due, then stale past the grace");
  ok(G.revenueSnapshotFreshness(null, clock) === "cold", "nothing read yet reads cold");
  const pub = G.publicRevenueBody(g0, {});
  ok(pub.freshness === "due" && typeof pub.freshness === "string", "the public /api/revenue body carries the freshness word");
}

// --- the copy states the cadence from the constant
const { readFileSync } = await import("node:fs");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
ok(/revenueLive: \(\(\) => \{ try \{ return revenueLiveStatus\(\); \}/.test(src("server.js")), "/api/gateway-status carries the revenueLive word");
ok(!/EVM\.ink \?/.test(src("revenue-live.js")) && /Object\.keys\(EVM\)/.test(src("revenue-live.js")), "the live scan reads every active EVM read-config, not a typed list");
ok(/refreshed \$\{revenueSnapshotCadence\(\)\}/.test(src("revenue-live.js")), "/revenue prints the live scan's cadence from the constant");
ok(/refreshed \$\{revenueLedgerCadence\(\)\}/.test(src("revenue-live.js")), "/revenue prints the ledger's cadence from the constant");
ok(/allCaughtUp \? REVENUE_LEDGER_SYNC_MS :/.test(src("revenue-ledger.js")), "the ledger waits the constant the page prints");
const TYPED_HOURLY = /[Hh]ourly (on-chain )?snapshot|refreshe[sd] hourly|>HOURLY</;
const pages = ["ledger-leaderboard.js", "what-is-x402.js", "pages.js", "tools/x402-kit.js"];
ok(pages.every((f) => /leaderboardCadence\(\)/.test(src(f)) && !TYPED_HOURLY.test(src(f))), "every leaderboard surface says the cadence from the constant, none says hourly");
// The home page links to /leaderboard and shows no board, so it states no
// cadence; it must never type one either.
ok(!TYPED_HOURLY.test(src("ledger-home.js")) && /href="\/leaderboard"/.test(src("ledger-home.js")), "the home page links to /leaderboard and types no cadence");
const { ledgerLeaderboardPage } = await import("../src/ledger-leaderboard.js");
let html = "";
try { html = String(await ledgerLeaderboardPage({ snapshot: { rows: [], totalSellers: 0, asOf: new Date(clock).toISOString(), windowLabel: "7d" } }) || ""); } catch { html = ""; }
ok(html.length > 1000 && /every 4 hours/.test(html) && /EVERY 4H/.test(html) && !/\$\{/.test(html), "the rendered leaderboard page says every 4 hours with no unrendered template text");

// The status Worker pages on the word too: stale pages, fresh and due clear, cold and absent do neither.
{
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const TITLE = "Live revenue read is stale";
  const j = (gw) => judge({ gateway: gw })[TITLE];
  ok(ALARMS.some((a) => a.title === TITLE) && j({ revenueLive: { status: "stale" } }) === "bad" && j({ revenueLive: { status: "fresh" } }) === "good" && j({ revenueLive: { status: "due" } }) === "good" && j({ revenueLive: { status: "cold" } }) === "quiet" && j({}) === "quiet", "status Worker: stale pages, fresh and due clear, cold and absent do neither");
}
// The heartbeat pages on the word: stale opens one issue, fresh and due close it.
{
  const hb = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  const step = hb.slice(hb.indexOf("- name: Live revenue read check"), hb.indexOf("# Refunds owed (src/refund-ledger.js)"));
  ok(/jq -r '\.revenueLive\.status \/\/ "unknown"'/.test(step) && /\n\s+stale\)\n\s+if \[ -z "\$OPEN" \]; then\n\s+gh issue create/.test(step) && /fresh\|due\)\n\s+if \[ -n "\$OPEN" \]; then\n\s+gh issue close/.test(step) && !/\$\{\{/.test(step), "heartbeat: stale opens the issue, fresh and due close it, nothing interpolated into the shell");
}

console.log(`\ntest-revenue-shared-scan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
