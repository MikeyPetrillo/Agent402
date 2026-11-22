#!/usr/bin/env node
// scripts/test-evm-boot-resume.js against a REAL state database: the two
// boots share one schema, so every scan state (the revenue snapshot, the
// window scans, the activity charts' records, the ledger cursors, the board)
// is read back from Postgres by the second boot.
//   STATE_DATABASE_URL=postgres://... node scripts/test-evm-boot-resume-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-evm-boot-resume-pg" });
globalThis.__evmBootResumePg = true;
await import("./test-evm-boot-resume.js");
