// x402 Leaderboard CLI — wraps src/leaderboard.js#runLeaderboard for the shell.
//
// Output:
//   stderr — human leaderboard (top N + "you are here" row)
//   stdout — full JSON snapshot
//
// Best-effort: any pipeline failure → empty snapshot, exit 0 (same contract as
// scripts/revenue-scan.js so it can run on a heartbeat without false pages).
//
// Env knobs are documented in src/leaderboard.js (BAZAAR_URL, SPAN_BLOCKS,
// MAX_CALL_USD, WALLET_CHUNK, MAX_WALLETS_SCAN, BASE_RPCS, …). CLI-only:
//   TOP_N         how many rows to print in the human table (default 25)
//   SELF_WALLET   used by the "YOU ARE HERE" marker (default = Agent402's payTo)

import { fileURLToPath } from "node:url";
import { runLeaderboard } from "../src/leaderboard.js";

const TOP_N = parseInt(process.env.TOP_N || "25", 10);
const SELF_WALLET = (process.env.SELF_WALLET || "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0").toLowerCase();
const log = (...a) => console.error(...a);

async function main() {
  let snap;
  try {
    snap = await runLeaderboard({ onProgress: (m) => log(m) });
  } catch (e) {
    log(`leaderboard skipped (transient): ${e.message}`);
    console.log(JSON.stringify({
      spec: "x402-leaderboard/1",
      asOf: new Date().toISOString(),
      leaderboard: [],
      scanSkipped: true,
      reason: e.message,
    }, null, 2));
    process.exit(0);
  }

  const ranked = snap.leaderboard || [];
  const top = ranked.slice(0, TOP_N);
  log(`\n  rank  name                                   callsSettled  totalUsd  uniqueBuyers`);
  log(`  ----  -------------------------------------  ------------  --------  ------------`);
  for (const r of top) {
    const name = (r.name || "").slice(0, 37).padEnd(37);
    log(`  ${String(r.rank).padStart(4)}  ${name}  ${String(r.callsSettled).padStart(12)}  $${r.totalUsd.toFixed(4).padStart(7)}  ${String(r.uniqueBuyers).padStart(12)}`);
  }
  if (ranked.length > top.length) log(`  …and ${ranked.length - top.length} more sellers with zero settled volume in this window.`);

  // "You are here" — surface Agent402's own row even when we're out of the top N.
  const self = ranked.find((r) => r.wallet === SELF_WALLET);
  if (self && self.rank > top.length) {
    log(`\n  YOU ARE HERE → rank ${self.rank}/${ranked.length}: ${self.name} — ${self.callsSettled} calls, $${self.totalUsd.toFixed(4)}, ${self.uniqueBuyers} buyers (${self.endpoints} endpoints listed)`);
  } else if (self) {
    log(`\n  YOU ARE HERE → rank ${self.rank}/${ranked.length} (shown above).`);
  }

  console.log(JSON.stringify(snap, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
