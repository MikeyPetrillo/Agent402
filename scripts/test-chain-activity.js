// Offline unit tests for the 30-day activity scanners feeding /base /polygon
// /arbitrum /solana /robinhood — the pure record parsers (fixtures, no
// network) plus the honest "unavailable" shape each scanner returns when its
// data source is absent. Bucketing correctness is already covered by
// scripts/test-stellar-activity.js (bucketStellarActivity is chain-agnostic
// and reused here, not re-tested). Also covers the market-page render with a
// fixture non-null activity for one EVM chain.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  parseEvmTransfer, evmActivity,
  parseSolanaTransfer, solanaActivity,
  parseRobinhoodTransfer, robinhoodActivity,
} from "../src/revenue-live.js";
import { marketPage } from "../src/market-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- parseEvmTransfer (Alchemy alchemy_getAssetTransfers record) -----------
const evmTransfer = {
  value: 0.001,
  from: "0xABF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
  to: "0xFEDA7403aAbe9A492ED70E810b396d8548a4A022",
  hash: "0xabc",
  metadata: { blockTimestamp: "2026-07-10T04:15:00.000Z" },
};
let e = parseEvmTransfer(evmTransfer);
ok(e && e.usd === 0.001 && e.when === "2026-07-10T04:15:00.000Z" && e.from === "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
  "parseEvmTransfer: value/blockTimestamp/from mapped correctly, from lowercased");
ok(parseEvmTransfer({ ...evmTransfer, value: 0 }) === null, "parseEvmTransfer: zero value rejected");
ok(parseEvmTransfer({ ...evmTransfer, value: -1 }) === null, "parseEvmTransfer: negative value rejected");
ok(parseEvmTransfer({ ...evmTransfer, value: "not-a-number" }) === null, "parseEvmTransfer: unparseable value rejected");
ok(parseEvmTransfer(null) === null, "parseEvmTransfer: null record rejected");

// --- parseSolanaTransfer (getTransaction result, mirrors
//     test-revenue-scan-solana.js's fixture style) --------------------------
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "AgentRevenueWa11etXXXXXXXXXXXXXXXXXXXXXXXXX";
const BUYER = "BuyerWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const bal = (owner, uiAmount, mint = USDC) => ({ owner, mint, uiTokenAmount: { uiAmount } });
const settleTxn = {
  blockTime: 1783780428,
  meta: {
    preTokenBalances: [bal(BUYER, 10), bal(OWNER, 1)],
    postTokenBalances: [bal(BUYER, 9.995), bal(OWNER, 1.005)],
  },
};
e = parseSolanaTransfer(settleTxn, OWNER);
ok(e && Math.abs(e.usd - 0.005) < 1e-9 && e.from === BUYER && e.when === "2026-07-11T14:33:48.000Z",
  "parseSolanaTransfer: delta/payer/blockTime decoded (reuses usdcDeltaForOwner/payerFromMeta)");
const outTxn = { blockTime: 1783780428, meta: { preTokenBalances: [bal(OWNER, 5)], postTokenBalances: [bal(OWNER, 3)] } };
ok(parseSolanaTransfer(outTxn, OWNER) === null, "parseSolanaTransfer: outgoing delta rejected");
ok(parseSolanaTransfer(null, OWNER) === null, "parseSolanaTransfer: null tx rejected");

// --- parseRobinhoodTransfer (Blockscout tokentx record, shape verified live
//     2026-07-11 against the real USDG contract on Robinhood Chain) --------
const WALLET_RH = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const rhTransfer = { value: "1000", timeStamp: "1783780431", from: "0xfeda7403aabe9a492ed70e810b396d8548a4a022", to: WALLET_RH.toUpperCase(), tokenSymbol: "USDG", tokenDecimal: "6" };
e = parseRobinhoodTransfer(rhTransfer, WALLET_RH);
ok(e && e.usd === 0.001 && e.from === "0xfeda7403aabe9a492ed70e810b396d8548a4a022" && e.when === "2026-07-11T14:33:51.000Z",
  "parseRobinhoodTransfer: atomic value /1e6, timeStamp, from decoded (to matched case-insensitively)");
ok(parseRobinhoodTransfer({ ...rhTransfer, to: "0x0000000000000000000000000000000000dead" }, WALLET_RH) === null,
  "parseRobinhoodTransfer: transfer to a different address rejected");
ok(parseRobinhoodTransfer({ ...rhTransfer, value: "0" }, WALLET_RH) === null, "parseRobinhoodTransfer: zero value rejected");
ok(parseRobinhoodTransfer(null, WALLET_RH) === null, "parseRobinhoodTransfer: null record rejected");

// --- Unavailable shape: no data source, no network attempted --------------
// evmActivity: no ALCHEMY_API_KEY (ambient env in this sandbox/CI has none set).
delete process.env.ALCHEMY_API_KEY;
let a = await evmActivity("base", "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
ok(a.error != null && Array.isArray(a.buckets) && a.buckets.length === 0, "evmActivity: no ALCHEMY_API_KEY -> unavailable shape, no throw");
a = await evmActivity("notachain", "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
ok(a.error === "unsupported chain" && a.buckets.length === 0, "evmActivity: unsupported chain -> unavailable shape");
a = await evmActivity("base", null);
ok(a.error != null && a.buckets.length === 0, "evmActivity: no wallet -> unavailable shape");

// solanaActivity / robinhoodActivity: no wallet -> unavailable, no network attempted.
a = await solanaActivity(null);
ok(a.error === "SOLANA_WALLET_ADDRESS unset" && a.buckets.length === 0 && a.totals.tx === 0,
  "solanaActivity: no wallet -> unavailable shape, no throw");
a = await robinhoodActivity(null);
ok(a.error === "WALLET_ADDRESS unset" && a.buckets.length === 0 && a.totals.tx === 0,
  "robinhoodActivity: no wallet -> unavailable shape, no throw");
// Host decision pinned (2026-09-18): Blockscout's per-instance API stays the
// source until a key is on Railway (api.blockscout.com/4663 answers 402 keyless,
// probed that day), and an edge challenge (the 403 HTML the legacy host served
// a residential probe) is reported as the honest unavailable shape, not thrown
// and never read as "no transfers".
{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: false, status: 403, headers: { get: () => "text/html" }, json: async () => { throw new Error("html"); }, text: async () => "<html>Just a moment...</html>" }; };
  a = await robinhoodActivity("0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
  ok(a.error === "Blockscout HTTP 403" && a.buckets.length === 0 && a.totals.tx === 0, `robinhoodActivity: an edge 403 page -> error named, empty buckets, no throw (got ${a.error})`);
  ok(seen.length === 2 && seen.every((u) => u.startsWith("https://robinhoodchain.blockscout.com/api?module=account&action=tokentx")), `robinhoodActivity: legacy per-instance host, one retry (${seen.length} calls)`);
  ok(!seen.some((u) => new URL(u).hostname === "api.blockscout.com"), "robinhoodActivity: the keyless read never asks api.blockscout.com (402 without a key)");
  globalThis.fetch = realFetch;
}

// --- Market-page render: fixture non-null activity shows the cards --------
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 2, tools: [{ slug: "hash", name: "Hash", category: "encoding", price: 0.001 }] };
const buckets = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i + 11).padStart(2, "0")}`, tx: i === 29 ? 3 : 0, usd: i === 29 ? 0.006 : 0, buyers: i === 29 ? 2 : 0 }));
const fixtureActivity = { rail: "Base", wallet: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", days: 30, truncated: false, error: null, buckets, totals: { tx: 3, usd: 0.006, buyers: 2, internalTx: 1, internalUsd: 0.001 } };
let html = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: fixtureActivity, wallet: fixtureActivity.wallet });
ok(html.includes("TRANSACTIONS") && html.includes("VOLUME") && html.includes("BUYERS"), "market-page: fixture activity renders the Transactions/Volume/Buyers cards");
ok(html.includes(">3<") && html.includes("$0.006") && html.includes(">2<"), "market-page: activity totals rendered as given, never invented");
html = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null, wallet: fixtureActivity.wallet });
ok(html.includes("activity scan temporarily unavailable"), "market-page: null activity renders the honest unavailable line");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
