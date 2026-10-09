// Every scheduled loop runs under a lease (src/state-db.js leased): while
// another container holds the lease, the tick answers { skipped: "leased" }
// and does nothing. This drives the real wrapped ticks of three stores against
// a Postgres (required under CI) and checks the lease names the modules use.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-leased-loops" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "leased-"));
const quiet = () => {};
try {
  const { createFollowups } = await import("../src/followups.js");
  let sends = 0;
  const fu = createFollowups({ storePath: join(DIR, "followups.json"), sendEmail: async () => { sends++; return true; }, secret: "s", monitorFor: () => ({ product: "p", label: "l", priceUsd: "$1" }), log: quiet, now: () => Date.now() });
  await fu.ready();
  fu.enqueue({ sessionId: "cs_1", email: "a@x.test", product: "p", kind: "k", label: "l", input: "i" });
  await fu.flush();
  await sdb.leases.acquire("followups-tick", { owner: "other-container", ttlMs: 60_000 });
  const r1 = await fu.tick();
  ok(r1.skipped === "leased" && sends === 0, "followups: the tick is skipped while another container holds its lease");
  await sdb.leases.release("followups-tick", { owner: "other-container" });
  const r2 = await fu.tick();
  ok(r2.skipped !== "leased" && typeof r2.monitor === "number" && (await sdb.leases.holder("followups-tick")) === null, "followups: the tick runs under the lease and releases it");

  const { createFreeAlerts } = await import("../src/free-alerts.js");
  const fa = createFreeAlerts({ storePath: join(DIR, "free-alerts.json"), probes: {}, validators: {}, sendEmail: async () => true, secret: "s", log: quiet });
  await fa.ready();
  await sdb.leases.acquire("free-alerts-tick", { owner: "other-container", ttlMs: 60_000 });
  ok((await fa.tick()).skipped === "leased", "free-alerts: skipped under another holder");
  await sdb.leases.release("free-alerts-tick", { owner: "other-container" });
  ok((await fa.tick()).skipped !== "leased", "free-alerts: runs once the lease is free");

  const { createWalletDigest } = await import("../src/wallet-digest.js");
  const wd = createWalletDigest({ storePath: join(DIR, "wallet-digest.json"), sendEmail: async () => true, secret: "s", usage: () => ({}), verifySignature: async () => true, log: quiet });
  await wd.ready();
  await sdb.leases.acquire("wallet-digest-tick", { owner: "other-container", ttlMs: 60_000 });
  ok((await wd.tick()).skipped === "leased", "wallet-digest: skipped under another holder");
  await sdb.leases.release("wallet-digest-tick", { owner: "other-container" });

  // Every loop the volume made single-writer names a lease (source check, so
  // a loop added later without one fails here).
  const expect = {
    "src/tweet-queue.js": "tweet-queue-tick", "src/mpp-reconcile.js": "mpp-reconcile-run", "src/stripe-shadow-ledger.js": "stripe-shadow-drain",
    "src/leaderboard.js": "leaderboard-refresh", "src/mpp-leaderboard.js": "mpp-leaderboard-refresh", "src/solana-leaderboard.js": "solana-leaderboard-refresh",
    "src/mpp-index.js": "mpp-index-crawl", "src/x402-index.js": "x402-index-crawl", "src/revenue-ledger.js": "revenue-ledger-tick",
    "src/backup.js": "backup-nightly", "src/monitor-scheduler.js": "monitor-scheduler",
  };
  for (const [file, name] of Object.entries(expect)) {
    const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    ok(src.includes(`"${name}"`), `${file} names its lease ${name}`);
  }
  // The helper itself without a database runs the function.
  const r = await sdb.withLease("any", { ttlMs: 1000 }, async () => 1);
  ok(r.ran && r.result === 1, "withLease with a database acquires and runs");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
