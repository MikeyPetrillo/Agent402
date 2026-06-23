// scripts/test-onchain-identity-kit.js
// Offline tests for src/tools/onchain-identity-kit.js. No keys, no network
// by default. Live calls opt-in via IDENTITY_LIVE_TEST=1.

import { ONCHAIN_IDENTITY_TOOLS, __test } from "../src/tools/onchain-identity-kit.js";

const { takeAddress, pickEasNetwork, ENS_API, WARPCAST_API, EAS_INDEXERS } = __test;

const h = (slug) => ONCHAIN_IDENTITY_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(ONCHAIN_IDENTITY_TOOLS.length === 4, `4 tools exported (got ${ONCHAIN_IDENTITY_TOOLS.length})`);

const expectedSlugs = ["ens-bulk-resolve", "farcaster-profile", "farcaster-by-address", "eas-attestations"];
for (const slug of expectedSlugs) {
  ok(!!ONCHAIN_IDENTITY_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of ONCHAIN_IDENTITY_TOOLS) {
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

try { takeAddress("not-an-address"); fail++; console.error("ASSERT FAIL - takeAddress: bad input should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeAddress: bad input → 400"); } else { fail++; console.error("ASSERT FAIL - bad statusCode"); } }

try { takeAddress("0xshort"); fail++; console.error("ASSERT FAIL - takeAddress: too-short should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeAddress: short → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

try { takeAddress(123); fail++; console.error("ASSERT FAIL - takeAddress: non-string should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - takeAddress: non-string → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

ok(pickEasNetwork("mainnet").url === EAS_INDEXERS.mainnet, "pickEasNetwork: mainnet");
ok(pickEasNetwork("BASE").url === EAS_INDEXERS.base, "pickEasNetwork: case-insensitive");
ok(pickEasNetwork(undefined).url === EAS_INDEXERS.mainnet, "pickEasNetwork: default → mainnet");

try { pickEasNetwork("fantom"); fail++; console.error("ASSERT FAIL - bad network should throw"); }
catch (e) { if (e.statusCode === 400) { pass++; console.log("ok - pickEasNetwork: bad → 400"); } else { fail++; console.error("ASSERT FAIL"); } }

// Endpoint URLs are well-known constants — confirm they didn't drift.
ok(ENS_API === "https://api.ensideas.com/ens", "ENS_API constant unchanged");
ok(WARPCAST_API === "https://api.warpcast.com/v2", "WARPCAST_API constant unchanged");
ok(EAS_INDEXERS.base === "https://base.easscan.org/graphql", "EAS_INDEXERS.base unchanged");

// ----------------------------------------------------------------------------
// Input validation — all 5 tools
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// ens-bulk-resolve
await throws(h("ens-bulk-resolve")({}), 400, "ens-bulk-resolve: missing addresses");
await throws(h("ens-bulk-resolve")({ addresses: [] }), 400, "ens-bulk-resolve: empty array");
await throws(h("ens-bulk-resolve")({ addresses: ["not-an-address"] }), 400, "ens-bulk-resolve: bad address");
await throws(h("ens-bulk-resolve")({ addresses: ["0x" + "a".repeat(40), "bad"] }), 400, "ens-bulk-resolve: one bad in batch");
await throws(h("ens-bulk-resolve")({ addresses: new Array(51).fill("0x" + "a".repeat(40)) }), 400, "ens-bulk-resolve: too many addresses");

// farcaster-profile
await throws(h("farcaster-profile")({}), 400, "farcaster-profile: missing fid+username");
await throws(h("farcaster-profile")({ username: "" }), 400, "farcaster-profile: empty username + no fid");

// farcaster-by-address
await throws(h("farcaster-by-address")({}), 400, "farcaster-by-address: missing address");
await throws(h("farcaster-by-address")({ address: "not-an-address" }), 400, "farcaster-by-address: bad address");

// eas-attestations
await throws(h("eas-attestations")({}), 400, "eas-attestations: missing address");
await throws(h("eas-attestations")({ address: "not-an-address" }), 400, "eas-attestations: bad address");
await throws(h("eas-attestations")({ address: "0x" + "a".repeat(40), network: "fantom" }), 400, "eas-attestations: bad network");
await throws(h("eas-attestations")({ address: "0x" + "a".repeat(40), role: "spectator" }), 400, "eas-attestations: bad role");

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.IDENTITY_LIVE_TEST === "1") {
  console.log("\n--- live tests ---");
  try {
    const ens = await h("ens-bulk-resolve")({ addresses: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"] });
    ok(ens.count === 1, `live ens-bulk-resolve: count=1`);
    ok(ens.results[0].name === "vitalik.eth", `live ens-bulk-resolve: vitalik.eth resolved (got ${ens.results[0].name})`);

    const fc = await h("farcaster-profile")({ username: "dwr.eth" });
    ok(typeof fc.fid === "number", `live farcaster-profile: dwr.eth fid (${fc.fid})`);

    const eas = await h("eas-attestations")({ address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", network: "mainnet", limit: 3 });
    ok(typeof eas.count === "number", `live eas-attestations: count returned (${eas.count})`);
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
