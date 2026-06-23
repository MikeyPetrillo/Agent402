// scripts/test-nft-market-kit.js
// Offline tests for src/tools/nft-market-kit.js. No keys, no network by
// default — every handler is gated on ALCHEMY_API_KEY and short-circuits to
// 503. Live calls opt-in via NFT_LIVE_TEST=1 with ALCHEMY_API_KEY set.

import { NFT_MARKET_TOOLS, __test } from "../src/tools/nft-market-kit.js";

const { takeAddress, takeTokenId, pickNetwork, NETWORKS } = __test;

const h = (slug) => NFT_MARKET_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(NFT_MARKET_TOOLS.length === 3, `3 tools exported (got ${NFT_MARKET_TOOLS.length})`);

const expectedSlugs = ["nft-collection", "nft-floor", "nft-sales"];
for (const slug of expectedSlugs) {
  ok(!!NFT_MARKET_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of NFT_MARKET_TOOLS) {
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
ok(takeAddress("0x" + "a".repeat(40)) === "0x" + "a".repeat(40), "takeAddress: valid lowercased passthrough");
ok(takeAddress("0x" + "A".repeat(40)) === "0x" + "a".repeat(40), "takeAddress: uppercase → lowercased");
ok(takeAddress("  0x" + "a".repeat(40) + "  ") === "0x" + "a".repeat(40), "takeAddress: trims whitespace");

try { takeAddress("not-an-address"); fail++; console.error("ASSERT FAIL - takeAddress: bad should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeAddress: bad → 400"); } else { fail++; console.error("ASSERT FAIL - bad statusCode"); } }

ok(takeTokenId(0) === "0", "takeTokenId: number 0");
ok(takeTokenId(1234) === "1234", "takeTokenId: number");
ok(takeTokenId("1234") === "1234", "takeTokenId: decimal string");
ok(takeTokenId("0x4d2") === "1234", "takeTokenId: hex string");
ok(takeTokenId(" 99 ") === "99", "takeTokenId: trims");

try { takeTokenId(-1); fail++; console.error("ASSERT FAIL - takeTokenId: negative should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeTokenId: negative → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

try { takeTokenId("abc"); fail++; console.error("ASSERT FAIL - takeTokenId: alpha should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeTokenId: alpha → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

try { takeTokenId(""); fail++; console.error("ASSERT FAIL - takeTokenId: empty should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeTokenId: empty → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

ok(pickNetwork("ethereum").subdomain === "eth-mainnet", "pickNetwork: ethereum");
ok(pickNetwork("BASE").subdomain === "base-mainnet", "pickNetwork: case-insensitive");
ok(pickNetwork(undefined).name === "ethereum", "pickNetwork: default → ethereum");
ok(pickNetwork(undefined, "base").name === "base", "pickNetwork: respects custom default");

try { pickNetwork("solana"); fail++; console.error("ASSERT FAIL - bad network should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - pickNetwork: bad → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

// All 5 chains supported
for (const n of ["ethereum", "base", "polygon", "arbitrum", "optimism"]) {
  ok(NETWORKS[n] && NETWORKS[n].subdomain && NETWORKS[n].chainId, `NETWORKS contains ${n}`);
}

// ----------------------------------------------------------------------------
// Input validation — all 5 tools (no key needed; takeAddress/takeTokenId
// throw before requireAlchemyKey is called)
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// nft-collection
await throws(h("nft-collection")({}), 400, "nft-collection: missing contract");
await throws(h("nft-collection")({ contract: "not-an-address" }), 400, "nft-collection: bad contract");
await throws(h("nft-collection")({ contract: "0x" + "a".repeat(40), network: "solana" }), 400, "nft-collection: bad network");

// nft-floor
await throws(h("nft-floor")({}), 400, "nft-floor: missing contract");
await throws(h("nft-floor")({ contract: "not-an-address" }), 400, "nft-floor: bad contract");

// nft-sales
await throws(h("nft-sales")({}), 400, "nft-sales: missing contract");
await throws(h("nft-sales")({ contract: "not-an-address" }), 400, "nft-sales: bad contract");
await throws(h("nft-sales")({ contract: "0x" + "a".repeat(40), tokenId: "bad" }), 400, "nft-sales: bad tokenId");

// ----------------------------------------------------------------------------
// 503 path — Alchemy not configured (verifies the gate)
// ----------------------------------------------------------------------------
const savedKey = process.env.ALCHEMY_API_KEY;
delete process.env.ALCHEMY_API_KEY;

await throws(h("nft-collection")({ contract: "0x" + "a".repeat(40) }), 503, "nft-collection: 503 without ALCHEMY_API_KEY");
await throws(h("nft-floor")({ contract: "0x" + "a".repeat(40) }), 503, "nft-floor: 503 without ALCHEMY_API_KEY");
await throws(h("nft-sales")({ contract: "0x" + "a".repeat(40) }), 503, "nft-sales: 503 without ALCHEMY_API_KEY");

if (savedKey) process.env.ALCHEMY_API_KEY = savedKey;

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.NFT_LIVE_TEST === "1" && process.env.ALCHEMY_API_KEY) {
  console.log("\n--- live tests ---");
  const BAYC = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
  try {
    const col = await h("nft-collection")({ contract: BAYC });
    ok(col.name?.includes("Bored") || col.symbol === "BAYC", `live nft-collection: BAYC resolved (${col.name})`);

    const fl = await h("nft-floor")({ contract: BAYC });
    ok(fl.openSea && typeof fl.openSea.available === "boolean", `live nft-floor: BAYC floor query returned`);

    const sa = await h("nft-sales")({ contract: BAYC, limit: 3 });
    ok(typeof sa.count === "number", `live nft-sales: BAYC sales count=${sa.count}`);
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
