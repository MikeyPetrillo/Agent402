// A store whose first load failed during a database outage waits on a
// backoff timer (up to STATE_STORE_RETRY_MAX_MS, a minute by default). When
// the database answers again the wait is cut short: the load runs at once,
// so the status word reads "on" within moments of the recovery instead of
// after the longest backoff. While the database stays down nothing is sent
// to it faster than the backoff allows, apart from the state database's own
// recovery check.
// Requires STATE_DATABASE_URL (CI fails without it).
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
const { url } = requireTestPg({ label: "test-store-retry-recovery-pg" });
const relay = await startPgRelay(url);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1000";
process.env.STATE_STORE_RETRY_MS = "30000"; // far longer than the test waits
process.env.STATE_STORE_RETRY_MAX_MS = "30000";
process.env.STATE_DB_RECOVERY_PROBE_MS = "300";
const sdb = await import("../src/state-db.js");
const { retryingLoad, unloadedStores } = await import("../src/store-retry.js");
sdb.setUnloadedStoresProbe(unloadedStores, "store-retry");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(50); } return false; };

await sdb.stateQuery("SELECT 1"); // schema in place before the outage

// ---- a failed first load runs again as soon as a statement succeeds ----------
{
  relay.cut();
  let attempts = 0;
  const load = retryingLoad("recovery store a", async () => { attempts++; await sdb.stateQuery("SELECT 1 AS a"); return "a"; }, { log: () => {} });
  await load.ready().catch(() => {});
  ok(!load.isLoaded() && attempts === 1, `the load failed during the outage (attempts ${attempts})`);
  // The tracked registration (an anonymous store-N in the server) follows the retry.
  sdb.trackStoreReady(load.eventually);
  await wait(1500);
  ok(attempts === 1, `no retry before the backoff while the database is down (attempts ${attempts})`);
  relay.heal();
  const t0 = Date.now();
  await sdb.stateQuery("SELECT 2").catch(() => {}); // another store's statement lands first
  const landed = await until(() => load.isLoaded(), 5000);
  ok(landed, `the load landed ${Date.now() - t0} ms after the database answered (backoff 30 s)`);
  ok(!unloadedStores().includes("recovery store a"), "the store left the unloaded list");
}

// ---- with no other statement, the recovery check finds the database ---------
{
  relay.cut();
  let attempts = 0;
  const load = retryingLoad("recovery store b", async () => { attempts++; await sdb.stateQuery("SELECT 1 AS b"); return "b"; }, { log: () => {} });
  sdb.trackStoreReady(load.eventually);
  await load.ready().catch(() => {});
  ok(!load.isLoaded(), "the second load failed during the outage");
  ok(sdb.stateDbStatus() === "degraded", `the word reads degraded during the outage (${sdb.stateDbStatus()})`);
  await wait(1000);
  relay.heal();
  const t0 = Date.now();
  const landed = await until(() => load.isLoaded() && sdb.stateDbStatus() === "on", 5000);
  ok(landed, `the word reads on ${Date.now() - t0} ms after the database answered, with no other caller (${sdb.stateDbStatus()})`);
}

// ---- the check stops once the database answers ------------------------------
{
  const before = sdb.__recoveryProbeRuns?.() ?? 0;
  await wait(1200);
  const after = sdb.__recoveryProbeRuns?.() ?? 0;
  ok(after === before, `no recovery check runs while the database is healthy (${before} -> ${after})`);
}

await sdb.__dropStateSchema().catch(() => {});
await sdb.closeStateDb();
await relay.close();
console.log(`\ntest-store-retry-recovery-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
