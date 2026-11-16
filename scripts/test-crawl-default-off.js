#!/usr/bin/env node
// The seller crawlers (x402 index, MPP index) run on a production boot only.
//
// Every CI server, every test that spawned src/server.js and every local boot
// used to start both crawlers unless a switch said "off", and each one ran a
// full pass over every indexed seller's host: sellers saw crawl traffic from
// dozens of addresses an hour while production's own crawl is one service.
// src/crawl-switch.js now starts them only on a production boot or an explicit
// X402_INDEX_CRAWL=on / MPP_INDEX_CRAWL=on, and never under CI by default.
//
// This suite proves it four ways:
//   1. the decision table (src/crawl-switch.js), env by env;
//   2. a booted server with CI=true and FREE_MODE, no switch, first crawl due
//      at once: in 20 s the crawler modules attempt no request to a non-local
//      host (scripts/lib/crawl-egress-preload.js records every attempt and its
//      caller, and refuses non-loopback hosts so nothing leaves the machine);
//   3. the live control: the same boot with both switches "on" does record
//      crawler attempts, so (2) cannot pass on a recorder that sees nothing;
//   4. no workflow step boots src/server.js with a crawl forced on, and no
//      test forces one on without a stub (first crawl deferred, or loopback only).
import "./lib/offline-stores.js";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlSwitch } from "../src/crawl-switch.js";
import { configuredRouterWorkers } from "../src/router-pool.js";
import { bootServer } from "./lib/boot-server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { failed++; console.log(`  FAIL ${msg}`); } };

// ---- 1. decision table ------------------------------------------------------
console.log("crawl switch decision");
const on = (env) => crawlSwitch("X402_INDEX_CRAWL", env).on;
ok(on({}) === false, "no switch, no CI, not production: off (a local or agent boot)");
ok(on({ CI: "true" }) === false, "CI set: off");
ok(on({ CI: "true", NODE_ENV: "production" }) === false, "CI set wins over NODE_ENV=production");
ok(on({ NODE_ENV: "production" }) === true, "NODE_ENV=production: on (the image sets it)");
ok(on({ RAILWAY_ENVIRONMENT_NAME: "production" }) === true, "Railway production environment: on");
ok(on({ NODE_ENV: "production", FREE_MODE: "true" }) === false, "FREE_MODE is never a production boot: off");
ok(on({ CI: "true", X402_INDEX_CRAWL: "on" }) === true, "an explicit on crawls under CI (a test with a stub)");
ok(on({ X402_INDEX_CRAWL: "ON " }) === true, "the switch reads case and whitespace loosely");
ok(on({ NODE_ENV: "production", X402_INDEX_CRAWL: "off" }) === false, "an explicit off wins in production");
ok(on({ CI: "false", NODE_ENV: "production" }) === true, "CI=false is not CI");
ok(on({ X402_INDEX_CRAWL: "" , NODE_ENV: "development" }) === false, "an empty switch is the default, not on");
ok(crawlSwitch("MPP_INDEX_CRAWL", { NODE_ENV: "production", X402_INDEX_CRAWL: "off" }).on === true, "each crawler reads its own switch");
ok(/CI/.test(crawlSwitch("X402_INDEX_CRAWL", { CI: "1" }).reason), "the reason names CI");
ok(configuredRouterWorkers({ CI: "true" }) === 0 && configuredRouterWorkers({ NODE_ENV: "production" }) === 1, "the router worker default follows the crawl decision");

// ---- 2 and 3. booted servers -----------------------------------------------
const PRELOAD = join(ROOT, "scripts", "lib", "crawl-egress-preload.js");
// The files whose requests are crawl traffic: the two crawlers and the
// registry readers they call.
const CRAWLER_FILES = /(^|,)(x402-index|mpp-index)\.js(,|$)/;
const WINDOW_MS = Number(process.env.CRAWL_GUARD_WINDOW_MS) || 20_000;

async function bootAndRecord(label, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), `a402-crawl-${label}-`));
  const log = join(dir, "egress.log");
  writeFileSync(log, "");
  const srv = await bootServer({
    stores: `crawl-${label}`,
    args: ["--import", PRELOAD],
    env: {
      FREE_MODE: "true", CI: "true", CRAWL_EGRESS_LOG: log,
      // Neither switch set: the default is what is under test.
      X402_INDEX_CRAWL: "", MPP_INDEX_CRAWL: "",
      // A crawler that did start would crawl inside the window, not 30 s later.
      INDEX_FIRST_CRAWL_DELAY_MS: "0",
      X402_SYNC_ON_START: "false", REDIS_URL: "", STATE_DATABASE_URL: "",
      ...extraEnv,
    },
  });
  try {
    await new Promise((r) => setTimeout(r, WINDOW_MS));
  } finally {
    await srv.stop();
  }
  const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => { const [host, file] = l.split("\t"); return { host, file }; });
  const nonLocal = rows.filter((r) => !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(r.host));
  const crawl = nonLocal.filter((r) => CRAWLER_FILES.test(r.file));
  return { log: srv.log(), rows, nonLocal, crawl };
}

console.log(`booted with CI=true FREE_MODE=true and no switch (${WINDOW_MS / 1000} s)`);
const off = await bootAndRecord("default", {});
ok(/\[index\] crawler off \(CI is set/.test(off.log), "the x402 crawler reports itself off because CI is set");
ok(/\[mpp-index\] crawler off \(CI is set/.test(off.log), "the MPP crawler reports itself off because CI is set");
ok(off.crawl.length === 0, `no crawler request to a non-local host (${off.crawl.length}: ${[...new Set(off.crawl.map((r) => `${r.host}<-${r.file}`))].slice(0, 6).join(", ")})`);

console.log(`live control: the same boot with X402_INDEX_CRAWL=on and MPP_INDEX_CRAWL=on (${WINDOW_MS / 1000} s, non-loopback refused)`);
const forced = await bootAndRecord("forced", { X402_INDEX_CRAWL: "on", MPP_INDEX_CRAWL: "on" });
const by = (name) => forced.crawl.filter((r) => r.file.split(",").includes(name)).length;
ok(by("x402-index.js") > 0, `the recorder sees the x402 crawler's requests when it is on (${by("x402-index.js")})`);
ok(by("mpp-index.js") > 0, `the recorder sees the MPP crawler's requests when it is on (${by("mpp-index.js")})`);

// ---- 4. workflows and tests never force a crawl without a stub -------------
console.log("workflows and tests");
const FORCE_ON = /\b(X402|MPP)_INDEX_CRAWL\s*(=|:)\s*["']?(on|true|1|yes)\b/i;
const wfDir = join(ROOT, ".github", "workflows");
let wfBoots = 0;
const wfForced = [];
for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
  const text = readFileSync(join(wfDir, f), "utf8");
  if (/src\/server\.js|docker run/.test(text)) wfBoots++;
  text.split("\n").forEach((line, i) => { if (FORCE_ON.test(line)) wfForced.push(`${f}:${i + 1}`); });
}
ok(wfBoots > 0, `the scan reads the workflows that boot a server (${wfBoots})`);
ok(wfForced.length === 0, `no workflow forces a crawler on; CI boots crawl nothing (${wfForced.join(", ") || "none"})`);

// A test may turn a crawler on to serve its warm-started index, with the first
// crawl deferred past its run, or against loopback stubs only.
const STUB = /INDEX_FIRST_CRAWL_DELAY_MS\s*:\s*["']?9{6,}|loopback-only-preload|crawl-egress-preload/;
const scriptsDir = join(ROOT, "scripts");
const unstubbed = [];
let forcing = 0;
for (const f of readdirSync(scriptsDir).filter((n) => /\.(m?js)$/.test(n) && n !== "test-crawl-default-off.js")) {
  const text = readFileSync(join(scriptsDir, f), "utf8");
  // A line that hands the switch to a pure decision function boots nothing.
  const bootLines = text.split("\n").filter((l) => FORCE_ON.test(l) && !/\b(revenueWarmupEnabled|crawlSwitch|configuredRouterWorkers)\(/.test(l));
  if (!bootLines.length) continue;
  forcing++;
  if (bootLines.some((l) => /MPP_INDEX_CRAWL\s*(=|:)\s*["']?(on|true|1|yes)\b/i.test(l)) && !/loopback-only-preload|crawl-egress-preload/.test(text)) unstubbed.push(`${f} (MPP crawl has no deferral; loopback only)`);
  else if (!STUB.test(text)) unstubbed.push(f);
}
ok(forcing > 0, `the scan finds the tests that turn the crawler on (${forcing})`);
ok(unstubbed.length === 0, `every test that turns a crawler on defers the first crawl or stays on loopback (${unstubbed.join(", ") || "all do"})`);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
