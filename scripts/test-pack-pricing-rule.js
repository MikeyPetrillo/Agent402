#!/usr/bin/env node
// CI guard for the skill-pack pricing rule (scripts/pack-prices.js): recompute
// every pack's price from the live catalog and fail on drift. Needs a booted
// server (TARGET_URL); the rule itself is documented in pack-prices.js.
import { spawnSync } from "node:child_process";
const TARGET = process.env.TARGET_URL || "";
if (!TARGET) { console.error("FAIL - test-pack-pricing-rule.js UNCHECKED (needs TARGET_URL)"); process.exit(1); }
const r = spawnSync(process.execPath, [new URL("./pack-prices.js", import.meta.url).pathname, "--quiet"], { stdio: "inherit", env: { ...process.env, TARGET_URL: TARGET } });
process.exit(r.status ?? 1);
