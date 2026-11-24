#!/usr/bin/env node
// agent402-openclaw is renamed to agent402-model-provider. This last release forwards to it:
// change the dependency and the import specifier; nothing else changes.
// Runs the new package's command with the same arguments.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// Written before the command runs: a process that exits right after it would
// never print a warning queued for the next tick.
console.error("agent402-openclaw is renamed to agent402-model-provider (same API): npm i agent402-model-provider, then import from \"agent402-model-provider\". This name gets no further releases.");

const entry = createRequire(import.meta.url).resolve("agent402-model-provider");
const r = spawnSync(process.execPath, [join(dirname(entry), "cli.js"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
