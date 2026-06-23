// scripts/test-mev-and-l2-kit.js
// Offline tests for src/tools/mev-and-l2-kit.js. No keys, no network by default.
// Live calls are opt-in via MEV_LIVE_TEST=1; Alchemy paths additionally need
// ALCHEMY_API_KEY.

import { MEV_AND_L2_TOOLS, __test } from "../src/tools/mev-and-l2-kit.js";

const { weiToEth, hexToInt, hexToBigNumber, shortPubkey, pickNetwork, NETWORKS, IS_L2 } = __test;

const h = (slug) => MEV_AND_L2_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(MEV_AND_L2_TOOLS.length === 5, `5 tools exported (got ${MEV_AND_L2_TOOLS.length})`);

const expectedSlugs = ["mev-recent-blocks", "mev-builder-share", "mev-block-payment", "l2-tvl", "l2-gas-comparison"];
for (const slug of expectedSlugs) {
  ok(!!MEV_AND_L2_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of MEV_AND_L2_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(d.bodyType === "json", `${t.slug}: bodyType=json`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(weiToEth("1000000000000000000") === 1, "weiToEth: 1e18 wei → 1 ETH");
ok(weiToEth("500000000000000000") === 0.5, "weiToEth: 5e17 wei → 0.5 ETH");
ok(weiToEth("0") === 0, "weiToEth: 0 → 0");
ok(weiToEth(null) === null, "weiToEth: null → null");
ok(weiToEth("not-a-number") === null, "weiToEth: bad string → null");

ok(hexToInt("0x10") === 16, "hexToInt: 0x10 → 16");
ok(hexToInt("0xff") === 255, "hexToInt: 0xff → 255");
ok(hexToInt("0x0") === 0, "hexToInt: 0x0 → 0");
ok(hexToInt("nope") === null, "hexToInt: bad prefix → null");
ok(hexToInt(null) === null, "hexToInt: null → null");

ok(hexToBigNumber("0x10") === 16n, "hexToBigNumber: 0x10 → 16n");
ok(hexToBigNumber("0xde0b6b3a7640000") === 1000000000000000000n, "hexToBigNumber: 0xde0b6b3a7640000 → 1e18");
ok(hexToBigNumber("nope") === null, "hexToBigNumber: bad prefix → null");

ok(shortPubkey("0x" + "a".repeat(96)) === "0xaaaaaaaa…aaaaaa", `shortPubkey: 96-char a's → 0xaaaaaaaa…aaaaaa (got ${shortPubkey("0x" + "a".repeat(96))})`);
ok(shortPubkey(null) === null, "shortPubkey: null passthrough");
ok(shortPubkey("0xshort") === "0xshort", "shortPubkey: too short → passthrough");

// pickNetwork
ok(pickNetwork("base").chainId === 8453, "pickNetwork: base → 8453");
ok(pickNetwork("ETHEREUM").chainId === 1, "pickNetwork: case-insensitive");
ok(pickNetwork(undefined).chainId === 1, "pickNetwork: default → ethereum");

try { pickNetwork("solana"); fail++; console.error("ASSERT FAIL - pickNetwork: bad network should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - pickNetwork: bad network → 400"); } else { fail++; console.error("ASSERT FAIL - bad statusCode"); } }

ok(IS_L2.has("base"), "IS_L2: base is L2");
ok(IS_L2.has("arbitrum"), "IS_L2: arbitrum is L2");
ok(!IS_L2.has("ethereum"), "IS_L2: ethereum is NOT L2");

// ----------------------------------------------------------------------------
// Input validation
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// mev-block-payment requires one of slot/blockNumber
await throws(h("mev-block-payment")({}), 400, "mev-block-payment: missing slot+blockNumber");
await throws(h("mev-block-payment")({ slot: "not-a-number", blockNumber: "also-not" }), 400, "mev-block-payment: non-numeric inputs");

// l2-gas-comparison requires Alchemy key (or empty network filter)
await throws(h("l2-gas-comparison")({ networks: ["solana", "tezos"] }), 400, "l2-gas-comparison: all-bad networks → 400");

// Alchemy 503 path for l2-gas-comparison
const stashedKey = process.env.ALCHEMY_API_KEY;
delete process.env.ALCHEMY_API_KEY;
await throws(h("l2-gas-comparison")({ networks: ["base"] }), 503, "l2-gas-comparison: 503 without ALCHEMY_API_KEY");
if (stashedKey) process.env.ALCHEMY_API_KEY = stashedKey;

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.MEV_LIVE_TEST === "1") {
  console.log("\n--- live tests ---");
  try {
    const recent = await h("mev-recent-blocks")({ limit: 3 });
    ok(typeof recent.count === "number" && recent.count > 0, `live mev-recent-blocks: count=${recent.count}`);
    ok(Array.isArray(recent.blocks), "live mev-recent-blocks: blocks array");
    if (recent.blocks[0]) {
      ok(typeof recent.blocks[0].blockNumber === "number", "live mev-recent-blocks: blockNumber numeric");
      ok(typeof recent.blocks[0].builderPubkey === "string", "live mev-recent-blocks: builderPubkey string");
    }

    const share = await h("mev-builder-share")({ window: 50 });
    ok(typeof share.uniqueBuilders === "number" && share.uniqueBuilders > 0, `live mev-builder-share: uniqueBuilders=${share.uniqueBuilders}`);
    ok(Array.isArray(share.builders), "live mev-builder-share: builders array");

    const tvl = await h("l2-tvl")({ limit: 5 });
    ok(typeof tvl.count === "number" && tvl.count > 0, `live l2-tvl: count=${tvl.count}`);
    ok(Array.isArray(tvl.chains), "live l2-tvl: chains array");

    if (process.env.ALCHEMY_API_KEY) {
      const gas = await h("l2-gas-comparison")({ networks: ["base", "arbitrum"] });
      ok(Array.isArray(gas.networks), "live l2-gas-comparison: networks array");
      ok(typeof gas.queriedAt === "string", "live l2-gas-comparison: queriedAt");
    }
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
