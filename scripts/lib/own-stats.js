// Gives a test process, and every child it spawns with `{ ...process.env }`,
// a stats store of its own.
//
// Why it exists: without /data, src/stats.js opens agent402-stats.db in the
// system temp directory unless STATS_DB_DIR names another one. Every suite that
// boots src/server.js (or imports a module that reaches src/stats.js) then
// writes one machine-wide file: its rows outlive the run, a suite reads counts
// another suite left, a table can sit at its row cap before the suite's first
// call, and two suites running side by side contend for one SQLite write lock.
// A fresh CI container starts with no file, so only a developer's machine or a
// runner shared by several lanes saw it.
//
// A side-effect import: when STATS_DB_DIR is unset it is pointed at a fresh
// temp directory, removed when this process exits. A value the caller already
// exported (a parent suite's directory, a path the suite chose) is kept, so a
// suite and its children share one store, as they did on the default path.
// The state database is left as the caller has it: with one, the file is only
// an import source and the tally lives in the database.
//
// ./offline-stores.js and ./file-mode.js import this, so an offline suite has
// it already. A suite that runs on a real store imports it directly:
//   import "./lib/own-stats.js";
// ownStoreEnv() (./own-stores.js) and bootServer() (./boot-server.js) name
// their own directory for the server they boot and take precedence there.
// scripts/test-stats-store-hygiene.js keeps every suite on one of these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!String(process.env.STATS_DB_DIR || "").trim()) {
  const dir = mkdtempSync(join(tmpdir(), "a402-stats-"));
  process.env.STATS_DB_DIR = dir;
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}
