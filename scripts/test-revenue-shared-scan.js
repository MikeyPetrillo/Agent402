// The live rail scan behind /revenue runs once per period across containers
// (src/revenue-live.js): with a shared store the refresh runs under a lease
// and saves the whole snapshot, and a container whose copy is stale adopts a
// saved snapshot younger than the TTL instead of scanning, a boot included.
// Without a shared store each process scans on its own, as before. Also pins
// the refresh cadences (src/refresh-cadence.js) and the copy that states them.
// Offline: the scan, the store and the lease are injected; two module
// instances stand in for two replicas.

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
    { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, REVENUE_SNAPSHOT_TTL_MS: String(2 * H), LEADERBOARD_REFRESH_MS: String(H) } }).toString().trim();
  ok(out === JSON.stringify([2 * H, H, "hourly", "every 2 hours"]), `REVENUE_SNAPSHOT_TTL_MS and LEADERBOARD_REFRESH_MS override the defaults, and the copy follows (${out})`);
}

// --- one scan per period across two replicas
let clock = Date.parse("2026-10-23T04:00:00Z");
const now = () => clock;
let scans = 0;
const scan = async () => { scans++; return { spec: "agent402-revenue/1", asOf: new Date(clock).toISOString(), rails: [{ rail: "Base", balance: scans, recent: Array.from({ length: 80 }, (_, i) => ({ when: i, tx: "0x" + i })) }] }; };
const shared = { body: null, saves: 0 };
const store = { read: async () => (shared.body ? JSON.parse(JSON.stringify(shared.body)) : null), save: async (s) => { shared.saves++; shared.body = JSON.parse(JSON.stringify(s)); return true; } };
let held = false;
const lease = async (fn) => { if (held) return { skipped: "leased", reason: "held" }; held = true; try { return await fn(); } finally { held = false; } };

const A = await import("../src/revenue-live.js?replica=a");
const B = await import("../src/revenue-live.js?replica=b");
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

// --- the copy states the cadence from the constant
const { readFileSync } = await import("node:fs");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
ok(/refreshed \$\{revenueSnapshotCadence\(\)\}/.test(src("revenue-live.js")), "/revenue prints the live scan's cadence from the constant");
const pages = ["ledger-leaderboard.js", "ledger-home.js", "what-is-x402.js", "pages.js", "tools/x402-kit.js"];
ok(pages.every((f) => /leaderboardCadence\(\)/.test(src(f)) && !/[Hh]ourly (on-chain )?snapshot|refreshe[sd] hourly|>HOURLY</.test(src(f))), "every leaderboard surface says the cadence from the constant, none says hourly");
const { ledgerLeaderboardPage } = await import("../src/ledger-leaderboard.js");
let html = "";
try { html = String(await ledgerLeaderboardPage({ snapshot: { rows: [], totalSellers: 0, asOf: new Date(clock).toISOString(), windowLabel: "7d" } }) || ""); } catch { html = ""; }
ok(html.length > 1000 && /every 4 hours/.test(html) && /EVERY 4H/.test(html) && !/\$\{/.test(html), "the rendered leaderboard page says every 4 hours with no unrendered template text");

console.log(`\ntest-revenue-shared-scan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
