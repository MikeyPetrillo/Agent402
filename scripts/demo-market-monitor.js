// Agent402 — Market Monitor demo
//
// A self-contained demo showing an agent autonomously paying for crypto market
// data on a loop. Uses the agent402-client SDK with proof-of-work (free, no
// wallet) by default, or real USDC if AGENT_KEY is set.
//
// Usage:
//   node scripts/demo-market-monitor.js               # single run
//   node scripts/demo-market-monitor.js --loop        # repeat every 60s
//   node scripts/demo-market-monitor.js --loop 30     # repeat every 30s
//   AGENT_KEY=0x... node scripts/demo-market-monitor.js --loop
//
// Environment:
//   TARGET_URL   — Agent402 instance (default: https://agent402.tools)
//   AGENT_KEY    — private key for x402 USDC payment (optional; PoW if unset)

import { Agent402 } from "../client/index.js";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const AGENT_KEY = process.env.AGENT_KEY;

// Parse --loop flag and optional interval
const args = process.argv.slice(2);
const loopIdx = args.indexOf("--loop");
const LOOP = loopIdx !== -1;
const INTERVAL = LOOP && args[loopIdx + 1] && !args[loopIdx + 1].startsWith("-")
  ? Math.max(parseInt(args[loopIdx + 1], 10) || 60, 10)
  : 60;

// Terminal colors
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const magenta = (s) => `\x1b[35m${s}\x1b[0m`;

const ts = () => dim(`[${new Date().toISOString().slice(11, 19)}]`);
const log = (s = "") => console.log(s);

log();
log(bold("  Agent402 — Crypto Market Monitor"));
if (!AGENT_KEY) {
  log(yellow("  ⚠ AGENT_KEY not set — this demo calls wallet-only tools (crypto-price,"));
  log(yellow("    crypto-trending) which require USDC payment."));
  log(yellow("    Set AGENT_KEY=0x<private-key-with-USDC-on-Base> to run."));
  log();
  process.exit(1);
}
log(dim(`  target: ${TARGET} | payment: USDC (x402) | mode: ${LOOP ? `loop (${INTERVAL}s)` : "single run"}`));
log(dim("─".repeat(70)));

// Build client
let client;
if (AGENT_KEY) {
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount } = await import("viem/accounts");
  const xClient = new x402Client();
  registerExactEvmScheme(xClient, { signer: privateKeyToAccount(AGENT_KEY) });
  const payFetch = wrapFetchWithPayment(fetch, xClient);
  client = new Agent402({ baseUrl: TARGET, fetch: payFetch });
} else {
  client = new Agent402({ baseUrl: TARGET, cache: false });
}

let totalCalls = 0;
let totalCostUsd = 0;
let iteration = 0;

async function callTool(slug, params) {
  const start = performance.now();
  log(`${ts()} ${cyan("CALL")} ${slug} ${dim(JSON.stringify(params))}`);
  const result = await client.call(slug, params, { cache: false });
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  const cat = await client._loadCatalog();
  const price = cat.get(slug)?.price || "$0.00";
  const priceNum = parseFloat(String(price).replace(/[^0-9.]/g, "")) || 0;
  totalCalls++;
  totalCostUsd += priceNum;
  log(`${ts()} ${green(" OK ")} ${slug} ${dim(`(${elapsed}s, ${AGENT_KEY ? price + " USDC" : "PoW free"})`)}`);
  return result;
}

function colorChange(pct) {
  if (pct == null) return "N/A";
  const s = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  return pct >= 0 ? green(s) : red(s);
}

function fmtPrice(n) {
  if (n == null) return "N/A";
  if (n >= 1000) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function fmtVol(n) {
  if (n == null) return "N/A";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(0) + "M";
  return "$" + n.toLocaleString();
}

async function run() {
  iteration++;
  const runStart = performance.now();

  log();
  if (LOOP) log(bold(`--- Iteration #${iteration} ---`));

  // 1. Crypto prices for BTC + ETH
  const prices = await callTool("crypto-price", { coins: "BTC,ETH", currency: "usd" });

  // 2. Trending coins
  const trending = await callTool("crypto-trending", {});

  const runElapsed = ((performance.now() - runStart) / 1000).toFixed(1);

  // --- Print market brief ---
  log();
  log(bold("  CRYPTO MARKET BRIEF") + dim(`  ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`));
  log(dim("  " + "─".repeat(50)));
  log();

  // BTC
  const btc = prices.coins?.bitcoin;
  if (btc) {
    log(`  ${bold("BTC")}  ${fmtPrice(btc.price)}  ${colorChange(btc.change24hPct)}  vol: ${fmtVol(btc.volume24h)}`);
  }

  // ETH
  const eth = prices.coins?.ethereum;
  if (eth) {
    log(`  ${bold("ETH")}  ${fmtPrice(eth.price)}  ${colorChange(eth.change24hPct)}  vol: ${fmtVol(eth.volume24h)}`);
  }

  log();
  log(`  ${bold("TRENDING")} ${dim("(top coins by search activity, last 24h)")}`);
  const coins = (trending.coins || []).slice(0, 7);
  if (coins.length === 0) {
    log(`  ${dim("  No trending data available")}`);
  } else {
    for (const c of coins) {
      const rank = c.marketCapRank ? dim(`#${c.marketCapRank}`) : "";
      log(`  ${yellow(c.symbol?.padEnd(8) || "?")} ${(c.name || "").padEnd(20)} ${rank}`);
    }
  }

  log();
  log(dim(`  ── round: ${runElapsed}s | calls this session: ${totalCalls} | cumulative cost: $${totalCostUsd.toFixed(3)} ${AGENT_KEY ? "USDC" : "(PoW)"}`));

  if (!LOOP) {
    log();
    process.exit(0);
  }
}

// Run once immediately
await run();

// If looping, set up interval
if (LOOP) {
  log();
  log(dim(`  Next update in ${INTERVAL}s (Ctrl+C to stop)`));

  const loop = async () => {
    while (true) {
      await new Promise((r) => setTimeout(r, INTERVAL * 1000));
      try {
        await run();
        log();
        log(dim(`  Next update in ${INTERVAL}s (Ctrl+C to stop)`));
      } catch (e) {
        log(`${ts()} ${red("ERR")} ${e.message}`);
        log(dim(`  Retrying in ${INTERVAL}s...`));
      }
    }
  };
  loop();
}
