#!/usr/bin/env node
// Plans for the Bazaar keep-alive passes, read from a live /api/pricing.
// Reads only (one GET); never signs or pays. The buys are scripts/refresh-bazaar.js's.
//
//   node scripts/keepalive-plan.js tail
//       The scheduled pass above the weekly ceiling: prints the route count,
//       and refuses (exit 3) when the pass total is over MAX_SPEND_USD.
//       Writes slugs= and max_price= to $GITHUB_OUTPUT.
//   node scripts/keepalive-plan.js snapshot <file>
//       Saves slug -> fixed price of the live catalog (the deploy job takes it
//       before it ships a build).
//   node scripts/keepalive-plan.js changed <file>
//       Compares the live catalog with a snapshot: the routes whose fixed price
//       changed, exempt kinds left out. Refuses (exit 3) over MAX_SPEND_USD or
//       over MAX_ROUTES routes (default 25). Writes slugs= and max_price= to
//       $GITHUB_OUTPUT.
//   node scripts/keepalive-plan.js low-water
//       Prints the burner low-water mark in whole USD: one tail pass plus the
//       margin, never under FLOOR_USD.
//
// Env: TARGET_URL (default https://agent402.tools), MAX_SPEND_USD, MAX_ROUTES,
// FLOOR_USD.
//
// The run logs are public: nothing here prints a total, a cap or a price, only
// route counts, slugs and whether a cap held (the low-water mark goes to the
// caller's variable, never to a log line of its own).
// Exit: 0 done (an empty plan included), 2 unreadable catalog or bad usage,
// 3 refused by the spend cap.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  aboveCeilingRoutes, passMicros, microsToUsd, spendCapVerdict, routeCountVerdict,
  priceSnapshot, changedPriceRoutes, burnerLowWaterUsd, PRICE_CHANGE_MAX_ROUTES,
} from "./lib/keepalive-plan.js";

async function readPricing(target) {
  const r = await fetch(`${target.replace(/\/+$/, "")}/api/pricing`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`/api/pricing HTTP ${r.status}`);
  const j = await r.json();
  const rows = j?.endpoints || j?.tools;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("/api/pricing lists no routes");
  return j;
}

function writeOutputs(env, routes) {
  if (!env.GITHUB_OUTPUT) return;
  const max = routes.reduce((m, r) => Math.max(m, r.micros), 0);
  appendFileSync(env.GITHUB_OUTPUT, `slugs=${routes.map((r) => r.slug).join(",")}\nmax_price=${microsToUsd(max)}\ncount=${routes.length}\n`);
}

/** Runs one subcommand; returns the exit code. `log`/`err` and `env` are
 *  injectable so scripts/test-keepalive-plan.js runs it without a process. */
export async function run(argv, { env = process.env, log = console.log, err = console.error, fetchPricing = readPricing } = {}) {
  const [cmd, file] = argv;
  const target = env.TARGET_URL || "https://agent402.tools";
  if (!["tail", "snapshot", "changed", "low-water"].includes(cmd) || ((cmd === "snapshot" || cmd === "changed") && !file)) {
    err("usage: keepalive-plan.js tail | snapshot <file> | changed <file> | low-water");
    return 2;
  }
  let pricing;
  try { pricing = await fetchPricing(target); } catch (e) {
    err(`keepalive-plan: could not read the catalog (${String(e?.message || e).slice(0, 120)})`);
    return 2;
  }
  if (cmd === "low-water") {
    const pass = microsToUsd(passMicros(aboveCeilingRoutes(pricing)));
    log(String(burnerLowWaterUsd(pass, { floorUsd: Number(env.FLOOR_USD) || 0 })));
    return 0;
  }
  if (cmd === "snapshot") {
    writeFileSync(file, JSON.stringify(priceSnapshot(pricing)));
    log(`Saved the fixed prices of ${Object.keys(priceSnapshot(pricing)).length} routes.`);
    return 0;
  }
  let routes;
  if (cmd === "tail") {
    routes = aboveCeilingRoutes(pricing);
    log(`Routes priced above the keep-alive ceiling, exempt kinds left out: ${routes.length}.`);
  } else {
    let before;
    try { before = JSON.parse(readFileSync(file, "utf8")); } catch {
      err("keepalive-plan: no readable snapshot from before the deploy; nothing to compare.");
      return 2;
    }
    routes = changedPriceRoutes(before, priceSnapshot(pricing));
    log(`Routes whose fixed price changed: ${routes.length}${routes.length ? ` (${routes.map((r) => r.slug).join(", ")})` : ""}.`);
    const count = routeCountVerdict(routes, env.MAX_ROUTES ?? PRICE_CHANGE_MAX_ROUTES);
    if (!count.ok) {
      err(`keepalive-plan: refusing: ${routes.length} routes, over the route-count cap.`);
      writeOutputs(env, []);
      return 3;
    }
  }
  if (!routes.length) { writeOutputs(env, routes); return 0; }
  const verdict = spendCapVerdict(routes, env.MAX_SPEND_USD);
  if (!verdict.ok) {
    err(`keepalive-plan: refusing: ${routes.length} routes, ${verdict.reason}.`);
    writeOutputs(env, []);
    return 3;
  }
  writeOutputs(env, routes);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error("keepalive-plan:", e?.message || e); process.exit(2); });
}
