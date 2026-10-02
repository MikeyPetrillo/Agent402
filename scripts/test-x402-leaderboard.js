// Unit tests for the x402 leaderboard's pure helpers — the parts that decide
// who shows up on the leaderboard and how their volume gets credited. No network.
import {
  baseUsdcPayToFromItem,
  extractWalletsFromBazaar,
  aggregateLeaderboard,
  initWalletAccumulator,
  foldTransfers,
  finalizeLeaderboard,
  canonicalHost,
  rankBy,
  mergeCrawledWallets,
  advertisedMicroUsd,
  priceMatches,
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

// --- split accumulator (init/fold/finalize) is byte-identical to the wrapper ---
// This is the memory-fix refactor's behavior lock: aggregateLeaderboard is now
// a thin wrapper around initWalletAccumulator + foldTransfers + finalizeLeaderboard.
// runLeaderboard calls the split pieces directly, folding one block-chunk's
// transfers at a time instead of collecting every transfer into one array —
// so the split MUST produce the exact same ranked output as the all-at-once
// wrapper for the same inputs, whether folded in one batch or many.
const split1 = (() => {
  const acc = initWalletAccumulator(sellers);
  foldTransfers(acc, transfers);
  return finalizeLeaderboard(acc);
})();
eq(split1, aggregateLeaderboard(transfers, sellers), "init+fold(all)+finalize === aggregateLeaderboard (single batch)");

const split2 = (() => {
  const acc = initWalletAccumulator(sellers);
  const mid = Math.ceil(transfers.length / 2);
  foldTransfers(acc, transfers.slice(0, mid));
  foldTransfers(acc, transfers.slice(mid));
  return finalizeLeaderboard(acc);
})();
eq(split2, aggregateLeaderboard(transfers, sellers), "init+fold(batch1)+fold(batch2)+finalize === aggregateLeaderboard(concat)");

// explicit maxCallUsd threading through the split path
const capTransfers = [
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x1", usd: 0.2 },
  { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payer: "0x2", usd: 0.4 },
];
const split4 = (() => {
  const acc = initWalletAccumulator(sellers);
  foldTransfers(acc, capTransfers, 0.3);
  return finalizeLeaderboard(acc, { maxCallUsd: 0.3 });
})();
eq(split4, aggregateLeaderboard(capTransfers, sellers, { maxCallUsd: 0.3 }), "custom maxCallUsd threads through split path identically");

// --- canonicalHost ----------------------------------------------------------

eq(canonicalHost("https://example.com/x"), "example.com", "host lowercased");
eq(canonicalHost("HTTPS://Example.com/y"), "example.com", "host lowercased even when scheme is upper");
eq(canonicalHost("https://www.example.com/x"), "example.com", "leading www. stripped");
eq(canonicalHost("https://api.example.com/x"), "api.example.com", "non-www subdomain preserved (could be a different product)");
ok(canonicalHost("javascript:alert(1)") === null, "non-http(s) scheme → null");
ok(canonicalHost(null) === null, "null → null");
ok(canonicalHost("not a url") === null, "garbage → null");

// --- per-operator (host) merge ----------------------------------------------

// Same operator running two wallets under one website: the row count drops from
// 2 → 1, volumes sum, both wallets are listed, and a buyer that hit both
// wallets is counted once (not twice).
const sharedSiteSellers = [
  { wallet: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", name: "Foo (ops-a)", network: "base", origins: ["https://foo.io"], homepage: "https://foo.io", endpoints: 3 },
  { wallet: "0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2", name: "Foo (ops-b)", network: "base", origins: ["https://foo.io"], homepage: "https://foo.io", endpoints: 2 },
  { wallet: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", name: "Solo", network: "base", origins: ["https://solo.io"], homepage: "https://solo.io", endpoints: 1 },
];
const sharedSiteTransfers = [
  // Wallet A: 2 calls, buyers X and Y
  { wallet: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", payer: "0xpx", usd: 0.02 },
  { wallet: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", payer: "0xpy", usd: 0.02 },
  // Wallet B: 1 call, buyer Y (so unioned that's still 2 unique, not 3)
  { wallet: "0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2", payer: "0xpy", usd: 0.01 },
  // Solo: 1 call
  { wallet: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", payer: "0xpz", usd: 0.04 },
];
const merged = aggregateLeaderboard(sharedSiteTransfers, sharedSiteSellers);
eq(merged.length, 2, "two operators after merge (was three wallets)");
// Foo: $0.05 across two wallets; Solo: $0.04 single wallet → Foo ranks first.
eq(merged[1].name, "Solo", "Solo ranks second at $0.04");
eq(merged[0].callsSettled, 3, "Foo: 2 + 1 = 3 settled calls across both wallets");
eq(merged[0].totalUsd, 0.05, "Foo: $0.02 + $0.02 + $0.01 = $0.05");
eq(merged[0].uniqueBuyers, 2, "Foo: buyer Y unioned across wallets (not double-counted)");
eq(merged[0].walletCount, 2, "Foo: two wallets reported in one row");
eq(merged[0].wallets.length, 2, "Foo: wallets[] has both addresses");
eq(merged[0].wallet, merged[0].wallets[0], "Foo: primary wallet = highest-volume member");
eq(merged[0].endpoints, 5, "Foo: endpoint counts sum across wallets (3 + 2 = 5)");

// Same proof against the operator-merge fixture (multi-wallet grouping), but
// folded one transfer at a time — the closest analogue to how runLeaderboard
// folds one block-chunk's decoded transfers at a time during the scan.
const splitMerged = (() => {
  const acc = initWalletAccumulator(sharedSiteSellers);
  for (const t of sharedSiteTransfers) foldTransfers(acc, [t]);
  return finalizeLeaderboard(acc);
})();
eq(splitMerged, aggregateLeaderboard(sharedSiteTransfers, sharedSiteSellers), "per-transfer fold === aggregateLeaderboard (operator-merge fixture)");

// www. equivalence: two listings under the same root with one explicitly on
// www. and one bare should merge into a single row.
const wwwSellers = [
  { wallet: "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", name: "WwwOp", network: "base", origins: ["https://www.www-op.io"], homepage: "https://www.www-op.io", endpoints: 1 },
  { wallet: "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", name: "WwwOp", network: "base", origins: ["https://www-op.io"], homepage: "https://www-op.io", endpoints: 1 },
];
const wwwTransfers = [
  { wallet: "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", payer: "0xq1", usd: 0.01 },
  { wallet: "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", payer: "0xq2", usd: 0.01 },
];
const wwwMerged = aggregateLeaderboard(wwwTransfers, wwwSellers);
eq(wwwMerged.length, 1, "www. and bare host merge into one row");
eq(wwwMerged[0].walletCount, 2, "merged row carries both wallets");

// No homepage → no merging (operators with no website stay independent).
const noSiteSellers = [
  { wallet: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1", name: "NoSiteA", network: "base", origins: [], homepage: null, endpoints: 1 },
  { wallet: "0xd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2", name: "NoSiteB", network: "base", origins: [], homepage: null, endpoints: 1 },
];
const noSiteRanked = aggregateLeaderboard([], noSiteSellers);
eq(noSiteRanked.length, 2, "two wallets with no homepage stay as two rows (no merging into a 'null-host' bucket)");

// --- rankBy ------------------------------------------------------------------

// The pure re-ranker that powers the /leaderboard sort toggle.
// Two lenses on the same snapshot: USDC earned (default, matches the on-chain
// volume story) and total calls served (matches the agent-traffic story).
const rankByInput = [
  { name: "Whale", totalUsd: 5.0, callsSettled: 10 },
  { name: "Volume", totalUsd: 0.5, callsSettled: 100 },
  { name: "Mid", totalUsd: 1.0, callsSettled: 20 },
];

const byUsd = rankBy(rankByInput, "usd");
eq(byUsd.map((r) => r.name), ["Whale", "Mid", "Volume"], "rankBy('usd'): orders by totalUsd desc");
eq(byUsd.map((r) => r.rank), [1, 2, 3], "rankBy('usd'): rank field re-numbered 1..N");
eq(rankBy(rankByInput).map((r) => r.name), ["Whale", "Mid", "Volume"], "rankBy() defaults to 'usd'");

const byCalls = rankBy(rankByInput, "calls");
eq(byCalls.map((r) => r.name), ["Volume", "Mid", "Whale"], "rankBy('calls'): orders by callsSettled desc");
eq(byCalls.map((r) => r.rank), [1, 2, 3], "rankBy('calls'): rank field re-numbered 1..N");

// Tiebreaker chain — primary metric ties, secondary metric breaks, name as last resort.
const tieRows = [
  { name: "Bravo", totalUsd: 1.0, callsSettled: 5 },
  { name: "Alpha", totalUsd: 1.0, callsSettled: 5 },
  { name: "Charlie", totalUsd: 1.0, callsSettled: 7 }, // higher calls → breaks usd tie under 'usd'
];
const tieByUsd = rankBy(tieRows, "usd");
eq(tieByUsd.map((r) => r.name), ["Charlie", "Alpha", "Bravo"], "rankBy('usd'): callsSettled breaks usd tie, then name");

const tieByCalls = rankBy(
  [
    { name: "Bravo", totalUsd: 0.5, callsSettled: 10 },
    { name: "Alpha", totalUsd: 0.5, callsSettled: 10 },
    { name: "Charlie", totalUsd: 0.9, callsSettled: 10 }, // higher usd → breaks calls tie under 'calls'
  ],
  "calls"
);
eq(tieByCalls.map((r) => r.name), ["Charlie", "Alpha", "Bravo"], "rankBy('calls'): totalUsd breaks calls tie, then name");

// Garbage inputs don't crash.
eq(rankBy(null), [], "rankBy(null) → []");
eq(rankBy(undefined), [], "rankBy(undefined) → []");
eq(rankBy([]), [], "rankBy([]) → []");

// rankBy is pure — original array order untouched.
const original = [
  { name: "A", totalUsd: 0.1, callsSettled: 1 },
  { name: "B", totalUsd: 0.5, callsSettled: 5 },
];
const snap = original.map((r) => r.name);
rankBy(original, "calls");
eq(original.map((r) => r.name), snap, "rankBy does not mutate input array");

// --- mergeCrawledWallets -----------------------------------------------------
// The Base scan drew its wallets from the Bazaar alone, so an origin we indexed
// ourselves - payTo read from its own live 402 - could settle any volume and
// stay settled:null, which dispatchEligibility reads as settlement_required
// forever. Reported by a seller absent from all 15,636 Bazaar items. The Solana
// board already scans every payTo the index knows; this is its Base twin.
{
  const bazaar = [
    { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", network: "base", name: "Known", origins: ["https://known.example"], homepage: "https://known.example", endpoints: 7 },
  ];
  const crawled = new Map([
    // Same wallet the Bazaar knows, seen by us at a SECOND origin.
    ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new Set(["https://known.example", "https://also-known.example"])],
    // A wallet only our crawl knows: the reported case.
    ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", new Set(["https://selfregistered.example"])],
    ["not-an-address", new Set(["https://junk.example"])],
  ]);
  const { merged, added } = mergeCrawledWallets(bazaar, crawled, { key: "base" });
  ok(added === 1, "one wallet added: the crawl-only one");
  ok(merged.length === 2, "the junk key is refused and the known wallet is not duplicated");
  const fresh = merged.find((r) => r.wallet === "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  ok(!!fresh, "the crawl-only wallet is in the scan list");
  ok(fresh.network === "base", "it carries the chain KEY, like Bazaar rows, not a CAIP-2 id");
  ok(fresh.source === "crawl", "its provenance says crawl");
  ok(fresh.endpoints >= 1, "endpoints is non-zero so a maxWalletsScan cap does not drop crawled wallets first");
  const kept = merged.find((r) => r.wallet === "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  ok(kept.name === "Known" && kept.endpoints === 7, "a wallet the Bazaar names keeps the Bazaar's name and count");
  // Compared as PARSED origins, not by substring: CodeQL reads a bare
  // includes() against a URL as incomplete sanitization, and the repo's rule
  // after the 2026-09-18 batch is to compare the parsed host rather than
  // suppress the alert - in a test as much as in served code.
  const keptOrigins = new Set(kept.origins.map((u) => new URL(u).origin));
  ok(keptOrigins.has("https://also-known.example"), "origins only our crawl knows are unioned in");
  ok(kept.source === "both", "and its provenance says both");
  const none = mergeCrawledWallets(bazaar, null, { key: "base" });
  ok(none.added === 0 && none.merged === bazaar, "no map is a no-op, never a thrown scan");
}

// The merge is only worth anything if the SCAN calls it: a unit test on the
// pure helper passes whether or not runLeaderboard ever reaches it. Pinned from
// source, and the server must supply the seam (nothing in this module may
// import the index).
{
  const { readFileSync } = await import("node:fs");
  const lb = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  ok(/mergeCrawledWallets\(sellers, opts\.crawledWallets\(chain\), chain, typeof opts\.crawledPrices === "function" \? opts\.crawledPrices\(chain\) : null\)/.test(lb), "runLeaderboard folds the crawled wallets, and their listed prices, into the scan list");
  ok(lb.indexOf("mergeCrawledWallets(sellers, opts.crawledWallets") > lb.indexOf("extractWalletsFromBazaar({ items }"), "and does it after the Bazaar extraction, so Bazaar names win");
  ok(!/from "\.\/x402-index\.js"/.test(lb), "the leaderboard still imports nothing from the index");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/startLeaderboardRefresh\(\{[\s\S]{0,300}crawledWallets:/.test(srv), "the server supplies crawledWallets at boot");
  ok(/crawledWallets: \(chain\) => allPayToOrigins\(/.test(srv), "from allPayToOrigins, the same source the Solana board uses");
  ok(/crawledPrices: \(chain\) => allPayToPrices\(/.test(srv), "and the listed prices from allPayToPrices");
}

// --- crawl-only wallets carry the prices their own routes publish (2026-09-30)
// A wallet only our crawl knows (PayAI catalog, self-registration) had no
// prices, so priceMatches could never read one of its transfers as a purchase
// at a listed price. For a wallet the Bazaar lists, the Bazaar's prices stand.
{
  const bazaarPrices = new Set([5000]);
  const bazaar = [{ wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", network: "base", name: "Known", origins: ["https://known.example"], homepage: "https://known.example", endpoints: 3, prices: bazaarPrices }];
  const crawled = new Map([
    ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new Set(["https://known.example"])],
    ["0xcccccccccccccccccccccccccccccccccccccccc", new Set(["https://payai-only.example"])],
    ["0xdddddddddddddddddddddddddddddddddddddddd", new Set(["https://unpriced.example"])],
  ]);
  const prices = new Map([
    ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new Set([999999])],
    ["0xcccccccccccccccccccccccccccccccccccccccc", new Set([10000, 50000])],
  ]);
  const { merged } = mergeCrawledWallets(bazaar, crawled, { key: "base" }, prices);
  const known = merged.find((r) => r.wallet.startsWith("0xaaaa"));
  ok(known.prices === bazaarPrices && known.prices.size === 1 && known.prices.has(5000), "a Bazaar-listed wallet keeps the Bazaar's prices, never the index's");
  const payai = merged.find((r) => r.wallet.startsWith("0xcccc"));
  ok(payai.prices instanceof Set && payai.prices.has(10000) && payai.prices.has(50000), "a crawl-only wallet carries its own listed prices");
  ok(priceMatches(10000, payai.prices) && !priceMatches(30000, payai.prices), "so its transfers match a listed price, and only a listed one");
  const bare = merged.find((r) => r.wallet.startsWith("0xdddd"));
  ok(bare.prices instanceof Set && bare.prices.size === 0, "a crawl-only wallet with no readable price carries an empty set, not undefined");
  const noMap = mergeCrawledWallets([], crawled, { key: "base" });
  ok(noMap.merged.every((r) => r.prices instanceof Set && r.prices.size === 0), "no price map: every crawl-only row gets an empty set");
}

// ---- v1 `base` listings ----
// A registry that mixes x402 v1 listings in names Base by its shorthand;
// those accepts are read as Base mainnet, and only Base mainnet.
{
  const V1_WALLET = "0x3333333333333333333333333333333333333333";
  const v1 = {
    resource: "https://v1.example/api/report",
    accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "1500000", asset: USDC, payTo: V1_WALLET }],
  };
  eq(baseUsdcPayToFromItem(v1), { wallet: V1_WALLET, network: "base" }, "a v1 listing on `base` is read as Base mainnet");
  ok(advertisedMicroUsd(v1) === 1500000, "and its v1 maxAmountRequired is its advertised price, from the same accept");
  ok(baseUsdcPayToFromItem({ accepts: [{ network: "base-sepolia", asset: USDC, payTo: V1_WALLET }] }) === null,
    "v1 base-sepolia stays out, like its CAIP-2 twin");
  ok(baseUsdcPayToFromItem({ accepts: [{ network: "solana", payTo: V1_WALLET }] }) === null,
    "a v1 shorthand for another chain is not read as Base");
  ok(baseUsdcPayToFromItem({ accepts: [{ network: "base", asset: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", payTo: V1_WALLET }] }) === null,
    "a v1 `base` accept in another token is still skipped");
}

// ---- our own payments are not a seller's evidence (2026-09-19) ----
// Found verifying three transfers a seller offered as proof that his row was
// mis-measured: one was our own Base spending wallet, paying him because a
// third party had bought a seller-payability check against his endpoint. A
// payment made to TEST whether a seller can be paid is the clearest possible
// thing that is not demand, and these counts feed the router's own gate.
{
  const OURS = "0x77065d81e18ad403bcd6e9a0616b288e16744121";
  const sellers = [{ wallet: "0xseller", name: "S", origins: ["https://s.example"], endpoints: 1, network: "base" }];
  const transfers = [
    { wallet: "0xseller", payer: "0xaaa1", usd: 0.005 },
    { wallet: "0xseller", payer: OURS, usd: 0.005 },
    { wallet: "0xseller", payer: "0xbbb2", usd: 0.005 },
  ];
  const withOurs = aggregateLeaderboard(transfers, sellers, { ourWallets: new Set() })[0];
  const without = aggregateLeaderboard(transfers, sellers, { ourWallets: new Set([OURS]) })[0];
  ok(withOurs.callsSettled === 3 && withOurs.uniqueBuyers === 3, "counting everything sees three settlements from three payers (the old behaviour)");
  ok(without.callsSettled === 2 && without.uniqueBuyers === 2, "excluding our wallet leaves the two genuine outside settlements");
  ok(Math.abs(without.totalUsd - 0.01) < 1e-9, "and the dollars drop with them, so totalUsd cannot disagree with callsSettled");

  // Whole-row skip, not payer-only: counting the call while dropping the payer
  // would leave callsSettled overstating what uniqueBuyers reports.
  const onlyOurs = aggregateLeaderboard([{ wallet: "0xseller", payer: OURS, usd: 0.005 }], sellers, { ourWallets: new Set([OURS]) })[0];
  ok(onlyOurs.callsSettled === 0 && onlyOurs.uniqueBuyers === 0 && onlyOurs.totalUsd === 0, "a seller whose ONLY settlement came from us has no evidence at all, rather than one anonymous call");

  // Case-insensitive: an address from a log is lowercase, one from config may not be.
  const mixed = aggregateLeaderboard([{ wallet: "0xseller", payer: OURS.toUpperCase().replace("0X", "0x"), usd: 0.005 }], sellers, { ourWallets: new Set([OURS]) })[0];
  ok(mixed.callsSettled === 0, "the match is case-insensitive, so a checksummed address is still ours");

  // ...and the SAME must hold when the mixed case is in the SET rather than in
  // the transfer. The first cut normalized only when ourWallets arrived as an
  // array and took a Set as-is, because OUR_EVM_WALLETS happens to be
  // lowercase. A caller holding checksummed addresses would therefore have
  // excluded nothing, silently, and the board would have looked MORE
  // flattering rather than failing loudly - the direction that never gets
  // noticed. Verified against the old expression: it returned false here.
  const mixedSet = aggregateLeaderboard([{ wallet: "0xseller", payer: OURS, usd: 0.005 }], sellers,
    { ourWallets: new Set([OURS.toUpperCase().replace("0X", "0x")]) })[0];
  ok(mixedSet.callsSettled === 0, "a checksummed address IN THE SET still excludes, so the rule cannot fail open on a caller's casing");

  // Default (no ourWallets passed) must stay byte-identical to before.
  const dflt = aggregateLeaderboard(transfers, sellers, { ourWallets: null })[0];
  ok(dflt.callsSettled === 3, "passing no wallet set changes nothing, so every existing caller and test stays honest");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
