// The environment for a booted test server that keeps its own state: every
// store a server writes to a file (the SQLite ledgers, stats, memory, PoW,
// status, the traffic and wish logs, the hang-up and late-settle books) is
// pointed into a fresh temp directory of its own.
//
// Why it exists: without /data each store defaults to a fixed name under
// /tmp, and MEMORY_DB_FILE or STATS_DB_DIR exported in a shell names one file
// for every child. Two servers on one file read each other's counts (a
// /api/stats delta off by the other run's calls) and contend for one SQLite
// write lock (SQLITE_BUSY), so a suite that passed alone failed beside
// another. Spread it AFTER `...process.env`:
//   env: { ...process.env, ...ownStoreEnv("mcp-mpp"), PORT: ... }
// Each call is a new directory, so two servers of one suite get two.
//
// The state database is switched off for the server (with one, these files
// are only import sources and the stores are rows every server shares).
// REDIS_URL is left as the caller has it: a suite that must not see Redis
// imports ./file-mode.js, and one that shares Redis on purpose scopes its keys
// with its own SHARED_LIMITS_PREFIX.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeEnv } from "./state-stores.mjs";

export function ownStoreEnv(label = "server") {
  const dir = mkdtempSync(join(tmpdir(), `a402-${label}-`));
  return {
    ...storeEnv(dir),
    STATE_DATABASE_URL: "", LEDGER_JOURNAL_REDIS: "",
    TRAFFIC_DIR: join(dir, "traffic"),
    HANGUP_FORGIVE_FILE: join(dir, "hangup-forgiveness.json"),
    LATE_SETTLE_FILE: join(dir, "late-settlements.json"),
  };
}
