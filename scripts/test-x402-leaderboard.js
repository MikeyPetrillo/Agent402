// Unit tests for the x402 leaderboard's pure helpers — the parts that decide
// who shows up on the leaderboard and how their volume gets credited. No network.
import {
  baseUsdcPayToFromItem,
  extractWalletsFromBazaar,
  aggregateLeaderboard,
} from "../src/leaderboard.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (got ${JSON.stringify(a)})`);

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// --- baseUsdcPayToFromItem ---------------------------------------------------

// Real Bazaar shape: accepts[] with multiple networks. Only the Base-mainnet
// USDC one should be picked, and the address gets lowercased.
const realItem = {
  serviceName: "Acme",
  resource: "https://acme.example/api/x",
  accepts: [
    { network: "eip155:8453", asset: USDC, payTo: "0xABCDEF0000000000000000000000000000001234", scheme: "exact" },
    { network: "eip155:137", asset: "0xdead", payTo: "0x9999999999999999999999999999999999999999" },
    { network: "eip155:8453", asset: USDC, payTo: "0xABCDEF0000000000000000000000000000001234", scheme: "exact", extra: { assetTransferMethod: "permit2" } },
  ],
};
eq(
  baseUsdcPayToFromItem(realItem),
  { wallet: "0xabcdef0000000000000000000000000000001234", network: "base" },
  "picks Base-mainnet USDC payTo and lowercases it"
);

// Polygon-only listing — no Base entry, so no row.
ok(
  baseUsdcPayToFromItem({ accepts: [{ network: "eip155:137", asset: "0xdead", payTo: "0x1111111111111111111111111111111111111111" }] }) === null,
  "Polygon-only listing → null"
);

// Base-sepolia (test) → null. CAIP-2 id for Base Sepolia is eip155:84532; not
// 8453, so the strict equality check filters it out cleanly.
ok(
  baseUsdcPayToFromItem({ accepts: [{ network: "eip155:84532", asset: USDC, payTo: "0x1111111111111111111111111111111111111111" }] }) === null,
  "Base-sepolia listing → null"
);

// Non-USDC asset on Base → null (some sellers might list other assets).
ok(
  baseUsdcPayToFromItem({ accepts: [{ network: "eip155:8453", asset: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", payTo: "0x1111111111111111111111111111111111111111" }] }) === null,
  "Non-USDC asset on Base → null"
);

// Asset omitted on a Base entry → treat as USDC (some listings omit it).
eq(
  baseUsdcPayToFromItem({ accepts: [{ network: "eip155:8453", payTo: "0x2222222222222222222222222222222222222222" }] }),
  { wallet: "0x2222222222222222222222222222222222222222", network: "base" },
  "Base entry without asset field → assumed USDC"
);

// Garbage / malformed payTo → null.
ok(baseUsdcPayToFromItem({ accepts: [{ network: "eip155:8453", payTo: "0xnope" }] }) === null, "bad address → null");
ok(baseUsdcPayToFromItem(null) === null, "null item → null");
ok(baseUsdcPayToFromItem({}) === null, "no accepts → null");

// --- extractWalletsFromBazaar -----------------------------------------------

// A real-world shape: one seller with two listings under the same wallet, a
// second seller with one listing, a Polygon-only listing that's dropped, and a
// non-mainnet listing that's also dropped.
const sample = {
  resources: [
    {
      serviceName: "Big Seller",
      resource: "https://big.example/api/a",
      accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa" }],
    },
    {
      serviceName: "Big Seller",
      resource: "https://big.example/api/b",
      accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa" }],
    },
    {
      serviceName: "Mid Seller",
      resource: "https://mid.example/api/x",
      accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb" }],
    },
    {
      serviceName: "Polygon Only",
      resource: "https://poly.example/api/y",
      accepts: [{ network: "eip155:137", asset: "0xdead", payTo: "0x9999999999999999999999999999999999999999" }],
    },
  ],
};
const wallets = extractWalletsFromBazaar(sample);
eq(wallets.length, 2, "two unique Base-mainnet wallets (Polygon-only dropped)");
const big = wallets.find((w) => w.wallet.startsWith("0xaaaa"));
eq(big.name, "Big Seller", "wallet picks up its serviceName");
eq(big.endpoints, 2, "wallet aggregates endpoint count across listings");
eq(big.origins.length, 1, "two listings under one origin collapse to one origin");
eq(big.homepage, "https://big.example", "homepage = first origin");

// Two listings under one wallet but with different serviceNames → pick the most
// common one (and break ties alphabetically).
const mixed = extractWalletsFromBazaar({ resources: [
  { serviceName: "Foo", resource: "https://x.io/a", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xCCCCcccCCCCcccCCCCcccCCCCcccCCCCcccCCCC0" }] },
  { serviceName: "Foo", resource: "https://x.io/b", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xCCCCcccCCCCcccCCCCcccCCCCcccCCCCcccCCCC0" }] },
  { serviceName: "Bar", resource: "https://x.io/c", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xCCCCcccCCCCcccCCCCcccCCCCcccCCCCcccCCCC0" }] },
] });
eq(mixed[0].name, "Foo", "most-common serviceName wins");
eq(mixed[0].endpoints, 3, "endpoint count across all listings");

// Brand-rename lag: most of the wallet's listings still carry the old short
// name in the crawler's cache, but a few fresh ones publish the canonical
// domain-shaped extension. The new name should win even though it's outvoted —
// this is what happens when an existing seller renames "Acme" → "Acme.tools"
// and the Bazaar harvester drains gradually instead of atomically.
const renamed = extractWalletsFromBazaar({ resources: [
  ...Array.from({ length: 63 }, (_, i) => ({
    serviceName: "Acme", resource: `https://acme.tools/api/x${i}`,
    accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xDDDDdddDDDDdddDDDDdddDDDDdddDDDDdddDDDD0" }],
  })),
  { serviceName: "Acme.tools", resource: "https://acme.tools/api/fresh",
    accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xDDDDdddDDDDdddDDDDdddDDDDdddDDDDdddDDDD0" }] },
] });
eq(renamed[0].name, "Acme.tools", "domain-shaped extension wins over outvoted prefix");
eq(renamed[0].endpoints, 64, "endpoint count still sums everything");

// Unrelated longer names that don't extend the top name shouldn't get promoted.
const unrelated = extractWalletsFromBazaar({ resources: [
  { serviceName: "Short", resource: "https://s.io/a", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEE0" }] },
  { serviceName: "Short", resource: "https://s.io/b", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEE0" }] },
  { serviceName: "Something Different", resource: "https://s.io/c", accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEEeeeEEEE0" }] },
] });
eq(unrelated[0].name, "Short", "longer-but-unrelated name does NOT win over majority");

// Empty / weird payloads.
eq(extractWalletsFromBazaar({}), [], "empty payload → []");
eq(extractWalletsFromBazaar(null), [], "null payload → []");
eq(extractWalletsFromBazaar({ items: [{ accepts: [{ network: "eip155:8453", asset: USDC, payTo: "0xddddddddddddddddddddddddddddddddddddddDD" }], resource: "https://y.io/x" }] }).length, 1, "accepts items[] shape too");

// --- aggregateLeaderboard ----------------------------------------------------

const sellers = [
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Big Seller", network: "base", origins: ["https://big.io"], homepage: "https://big.io", endpoints: 5 },
  { wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Mid Seller", network: "base", origins: ["https://mid.io"], homepage: "https://mid.io", endpoints: 2 },
  { wallet: "0xcccccccccccccccccccccccccccccccccccccccc", name: "Zero Seller", network: "base", origins: ["https://zero.io"], homepage: "https://zero.io", endpoints: 1 },
];

const transfers = [
  // Big: 3 calls, 3 distinct buyers, $0.030 total
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x111", usd: 0.01 },
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x222", usd: 0.01 },
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x333", usd: 0.01 },
  // Mid: 2 calls, 1 buyer (repeat), $0.010 total
  { wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", payer: "0x444", usd: 0.005 },
  { wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", payer: "0x444", usd: 0.005 },
  // Big also gets a $1 inbound (over ceiling — funding/swap, not a per-call buy → IGNORED)
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x555", usd: 1.0 },
  // Transfer to an unknown wallet → no row in leaderboard
  { wallet: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", payer: "0x666", usd: 0.01 },
];

const ranked = aggregateLeaderboard(transfers, sellers);
eq(ranked.map((r) => r.rank), [1, 2, 3], "ranks are 1..N");
eq(ranked[0].name, "Big Seller", "biggest volume ranks first");
eq(ranked[0].callsSettled, 3, "Big has 3 in-ceiling settlements (the $1 inbound is excluded)");
eq(ranked[0].totalUsd, 0.03, "Big totalUsd = $0.03 (excludes over-ceiling)");
eq(ranked[0].uniqueBuyers, 3, "Big has 3 unique buyers");
eq(ranked[0].endpoints, 5, "endpoint count carried through to ranked row");
eq(ranked[1].name, "Mid Seller", "second place");
eq(ranked[1].callsSettled, 2, "Mid has 2 settlements");
eq(ranked[1].uniqueBuyers, 1, "Mid: 1 buyer (repeat purchases counted once)");
eq(ranked[2].name, "Zero Seller", "seller with no transfers still appears at the bottom");
eq(ranked[2].callsSettled, 0, "Zero: 0 settlements");
eq(ranked[2].totalUsd, 0, "Zero: $0 totalUsd");

// Tie-break: equal volume + equal calls → alphabetical name.
const tieSellers = [
  { wallet: "0x1000000000000000000000000000000000000000", name: "Bravo", network: "base", origins: ["https://b.io"], homepage: "https://b.io", endpoints: 1 },
  { wallet: "0x2000000000000000000000000000000000000000", name: "Alpha", network: "base", origins: ["https://a.io"], homepage: "https://a.io", endpoints: 1 },
];
const tieTransfers = [
  { wallet: "0x1000000000000000000000000000000000000000", payer: "0x1", usd: 0.01 },
  { wallet: "0x2000000000000000000000000000000000000000", payer: "0x2", usd: 0.01 },
];
const tied = aggregateLeaderboard(tieTransfers, tieSellers);
eq(tied[0].name, "Alpha", "tie-break: alphabetical when volume + calls equal");

// Empty inputs.
eq(aggregateLeaderboard([], []), [], "empty inputs → empty ranking");
eq(aggregateLeaderboard([], sellers).length, sellers.length, "zero transfers → every seller appears with zero volume");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
