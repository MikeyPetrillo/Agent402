// Offline unit test for the leaderboard's per-chain scan config.
//
// The leaderboard ranked one of our eleven rails. Generalising it is mostly about
// NOT getting the chain wrong: scanning Base's USDC address against Polygon's
// RPC would silently return nothing and look like "no activity" rather than a
// bug, so the config is asserted here rather than trusted.
//
// Run: node scripts/test-leaderboard-chains.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { chainScanConfig, rankableChains, baseUsdcPayToFromItem } from "../src/leaderboard.js";
import { NETWORKS } from "../src/payments.js";
import { EVM } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.error(`FAIL - ${n}`); } };

// ── Config integrity ────────────────────────────────────────────────────────
{
  const chains = rankableChains();
  check("every EVM rail we settle on is rankable", chains.length === Object.keys(EVM).length);
  check("base is present and first-class", chains.some((c) => c.key === "base"));

  for (const c of chains) {
    check(`${c.key}: caip2 matches the payments network map`, c.caip2 === NETWORKS[c.key]);
    check(`${c.key}: token is a lowercase 0x address`, /^0x[0-9a-f]{40}$/.test(c.token));
    check(`${c.key}: has at least one RPC`, Array.isArray(c.rpcs) && c.rpcs.length > 0);
    check(`${c.key}: span is a positive block count`, Number.isFinite(c.spanBlocks) && c.spanBlocks > 0);
  }

  // The bug this guards: two chains sharing a token address would mean one is
  // scanning the other's contract, which returns plausible-looking nothing.
  const tokens = chains.map((c) => c.token);
  check("no two chains share a USDC address", new Set(tokens).size === tokens.length);
  const caips = chains.map((c) => c.caip2);
  check("no two chains share a CAIP-2 id", new Set(caips).size === caips.length);

  check("an unknown chain is refused, never silently Base", chainScanConfig("dogecoin") === null);
  check("an empty chain key defaults to base", chainScanConfig("")?.key === "base");
}

// ── payTo extraction credits the right rail ─────────────────────────────────
{
  const base = chainScanConfig("base");
  const poly = chainScanConfig("polygon");
  const item = {
    accepts: [
      { network: base.caip2, asset: base.token, payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { network: poly.caip2, asset: poly.token, payTo: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ],
  };
  check("base scan picks the base payTo", baseUsdcPayToFromItem(item, base).wallet === "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  check("polygon scan picks the polygon payTo", baseUsdcPayToFromItem(item, poly).wallet === "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  check("polygon scan tags the row with its own chain", baseUsdcPayToFromItem(item, poly).network === "polygon");
  check("default (no chain arg) stays base — existing callers unchanged", baseUsdcPayToFromItem(item).network === "base");

  // A listing on another chain must not be credited to the chain being scanned.
  const otherOnly = { accepts: [{ network: poly.caip2, asset: poly.token, payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }] };
  check("a polygon-only listing is invisible to the base scan", baseUsdcPayToFromItem(otherOnly, base) === null);

  // Right chain, wrong token (someone else's stablecoin) must not count.
  const wrongToken = { accepts: [{ network: base.caip2, asset: "0x0000000000000000000000000000000000000001", payTo: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }] };
  check("right chain but wrong asset is not credited", baseUsdcPayToFromItem(wrongToken, base) === null);

  // Testnets share the eip155 shape; only the configured mainnet id counts.
  const testnet = { accepts: [{ network: "eip155:84532", asset: base.token, payTo: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE" }] };
  check("testnet settlements stay out of the ranking", baseUsdcPayToFromItem(testnet, base) === null);
}

console.log(`\ntest-leaderboard-chains: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
