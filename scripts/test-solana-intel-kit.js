// scripts/test-solana-intel-kit.js
// Offline tests for src/tools/solana-intel-kit.js. No network: globalThis.fetch
// is stubbed per case (same pattern as scripts/test-cert-transparency.js).
//
// Covers: catalog envelope, input validation (400 before any egress), output
// shapes on fixtures cut from live responses (2026-08-22), the upstream error
// mapping (429 -> 503, 5xx -> 502, 400/404 -> 422, non-JSON -> 502, transport
// failure/timeout -> 504), and that every request goes to one of the three
// allowed hosts with the validated mint in the path.

import { SOLANA_INTEL_TOOLS, MINTS, __test, jupiterBase, jupiterHeaders } from "../src/tools/solana-intel-kit.js";

const realFetch = globalThis.fetch;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const h = (slug) => SOLANA_INTEL_TOOLS.find((t) => t.slug === slug).handler;

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const textRes = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

const ALLOWED_HOSTS = new Set(["api.rugcheck.xyz", "api.dexscreener.com", "lite-api.jup.ag", "rpc.test.invalid"]);
let calls = [];
const stub = (handler) => {
  calls = [];
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    const host = new URL(u).host;
    if (!ALLOWED_HOSTS.has(host)) return Promise.reject(new Error("unexpected host " + host));
    if (!opts?.signal) return Promise.reject(new Error("no abort signal"));
    if (!opts?.headers?.["User-Agent"]) return Promise.reject(new Error("no UA"));
    return handler(u, opts);
  };
};
const restore = () => { globalThis.fetch = realFetch; };

async function throws(promise, status, label) {
  try { await promise; ok(false, `${label}: expected ${status}, resolved`); }
  catch (e) { ok(e.statusCode === status, `${label}: ${status} (got ${e.statusCode} "${e.message}")`); }
}

// ----------------------------------------------------------------------------
// Fixtures (trimmed from live responses)
// ----------------------------------------------------------------------------
const JUP = MINTS.JUP, SOL = MINTS.SOL, USDC = MINTS.USDC;
const PUMP = "918p2GRyDLkhsRvtAHaKZg8yrP5kXSe6CYustqTcpump";

const RC_SUMMARY = {
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", tokenType: "", score: 3550201, score_normalised: 97, lpLockedPct: 8.981953660097156,
  risks: [
    { name: "LP Vault unlocked", value: "15033 Hours ago", description: "LP Pool tokens in the vault are able to be reclaimed.", score: 1513300, level: "danger" },
    { name: "Mutable metadata", value: "", description: "Token metadata can be changed", score: 100, level: "warn" },
  ],
};
const RC_SUMMARY_CLEAN = { tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", tokenType: "", risks: [], score: 1, score_normalised: 1, lpLockedPct: 99.9995 };

const RC_REPORT = {
  mint: JUP, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", creator: null, creatorBalance: 0,
  token: { mintAuthority: null, supply: 6862431164927844, decimals: 6, isInitialized: true, freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar" },
  tokenMeta: { name: "Jupiter", symbol: "JUP", uri: "https://static.jup.ag/jup/metadata.json", mutable: true, updateAuthority: "61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV" },
  topHolders: [
    { address: "A1", owner: "O1", amount: 1, decimals: 6, pct: 30, uiAmount: 1700000000.1, insider: false },
    { address: "A2", owner: "POOL", amount: 1, decimals: 6, pct: 20, uiAmount: 1, insider: false },
    { address: "A3", owner: "O3", amount: 1, decimals: 6, pct: 10, uiAmount: 1, insider: true },
    ...Array.from({ length: 17 }, (_, k) => ({ address: `A${k + 4}`, owner: `O${k + 4}`, amount: 1, decimals: 6, pct: 1, uiAmount: 1, insider: false })),
  ],
  knownAccounts: { POOL: { name: "Meteora DLMM Pool", type: "AMM" }, X: { name: "Raydium Locker", type: "LOCKER" } },
  risks: RC_SUMMARY.risks, score: 3550201, score_normalised: 97, rugged: false, tokenType: "",
  fileMeta: { name: "Jupiter", symbol: "JUP", image: "" },
  lockers: { L1: { programID: "P", tokenAccount: "T", owner: "OWN", uri: "", unlockDate: 1800000000, usdcLocked: 114.8, type: "raydium_locker" } },
  markets: [
    { pubkey: "M-small", marketType: "orca", mintA: JUP, mintB: SOL, lp: { lpLockedPct: 0, lpLockedUSD: 0, baseUSD: 10, quoteUSD: 5, holders: 2 } },
    { pubkey: "M-big", marketType: "meteoraDlmm", mintA: JUP, mintB: SOL, lp: { lpLockedPct: 50, lpLockedUSD: 600000, baseUSD: 725085.97, quoteUSD: 535643.17, holders: 0 } },
    { pubkey: "M-mid", marketType: "raydium", mintA: JUP, mintB: USDC, lp: { lpLockedPct: 100, lpLockedUSD: 1000, baseUSD: 500, quoteUSD: 500, holders: 1 } },
  ],
  totalMarketLiquidity: 3585833.6551489453, totalStableLiquidity: 900000, totalLPProviders: 173, totalHolders: 2873512, price: 0.20272365573711018,
  transferFee: { pct: 0, maxAmount: 0, authority: "11111111111111111111111111111111" },
  verification: { mint: JUP, jup_verified: true, jup_strict: true, validated: false, links: [] },
  graphInsidersDetected: 0, detectedAt: "2024-05-29T00:40:51.715431226Z", launchpad: { name: "Pump.Fun", platform: "pump_fun" },
};

const DS_PAIR = (over = {}) => ({
  chainId: "solana", dexId: "meteora", url: "https://dexscreener.com/solana/eoft", pairAddress: "EoFt", labels: ["DLMM"],
  baseToken: { address: JUP, name: "Jupiter", symbol: "JUP" }, quoteToken: { address: "METv", name: "Meteora", symbol: "MET" },
  priceNative: "0.9139", priceUsd: "992.83",
  txns: { m5: { buys: 2, sells: 5 }, h1: { buys: 23, sells: 43 }, h6: { buys: 346, sells: 338 }, h24: { buys: 1180, sells: 1249 } },
  volume: { h24: 149471020.95, h6: 37797815.88, h1: 1424742.93, m5: 257492.32 },
  priceChange: { m5: 0.1, h1: -0.4, h6: -0.01, h24: -6.39 },
  liquidity: { usd: 71508214.54, base: 10384, quote: 56337 }, fdv: 6949791664855, marketCap: 3296507768964,
  pairCreatedAt: Date.now() - 36 * 3_600_000,
  info: { imageUrl: "https://cdn/x.png", websites: [{ url: "https://jup.ag" }], socials: [] },
  ...over,
});

const DS_BOOSTS = [
  { url: "https://dexscreener.com/solana/918p", chainId: "solana", tokenAddress: PUMP, description: "The cats have arrived", links: [{ url: "https://catszn.world" }, { type: "twitter", url: "https://x.com/c" }], totalAmount: 500 },
  { url: "https://dexscreener.com/bsc/0xabc", chainId: "bsc", tokenAddress: "0xabc", totalAmount: 9000 },
  { url: "https://dexscreener.com/solana/xyz", chainId: "solana", tokenAddress: "XyZ", totalAmount: 100 },
];
const DS_PROFILES = [
  { url: "https://dexscreener.com/solana/airg", chainId: "solana", tokenAddress: "AiRG", description: "", links: [{ type: "twitter", url: "https://x.com/a" }], cto: true },
  { url: "https://dexscreener.com/ethereum/0x1", chainId: "ethereum", tokenAddress: "0x1" },
];

const JUP_PRICE = {
  [JUP]: { createdAt: "2024-06-07T10:56:42.584Z", liquidity: 3092234.5859758323, usdPrice: 0.2034850272618111, blockId: 440919030, decimals: 6, priceChange24h: -2.398697059945383 },
  [SOL]: { createdAt: "2024-06-05T08:55:25.527Z", liquidity: 748142746.9005799, usdPrice: 93.70851135305588, blockId: 440919037, decimals: 9, priceChange24h: 3.925281243329954 },
};

const JUP_QUOTE = {
  inputMint: SOL, inAmount: "1000000000", outputMint: USDC, outAmount: "93708783", otherAmountThreshold: "93240240", swapMode: "ExactIn", slippageBps: 50, platformFee: null, priceImpactPct: "0.0012",
  routePlan: [
    { swapInfo: { ammKey: "F", label: "BisonFi", inputMint: SOL, outputMint: "Es9v", inAmount: "1000000000", outAmount: "93720054" }, percent: 100 },
    { swapInfo: { ammKey: "G", label: "SolFi V2", inputMint: "Es9v", outputMint: USDC, inAmount: "93720054", outAmount: "93708783" }, percent: 100 },
  ],
  contextSlot: 440919041, timeTaken: 0.001, swapUsdValue: "93.6989308707019",
};

const JUP_TOKEN = {
  id: JUP, name: "Jupiter", symbol: "JUP", decimals: 6, dev: "JUPh", circSupply: 3320312968.08, totalSupply: 6862431164.927844, tokenProgram: "Tokenkeg",
  mintAuthority: null, freezeAuthority: null, holderCount: 835540, fdv: 1395785031.7767274, mcap: 675335464.9800633, usdPrice: 0.20339512313219738, liquidity: 3092754.4836603072,
  firstPool: { id: "2psp", createdAt: "2024-01-29T17:33:29Z" },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15.283979984372376, devMints: 1 },
  organicScore: 99.31366867390821, organicScoreLabel: "high", isVerified: true, tags: ["strict", "verified", "defi"], createdAt: "2025-07-25T13:18:02Z", updatedAt: "2026-08-22T12:11:21Z",
  stats24h: { priceChange: -2.4, holderChange: 0.1, liquidityChange: -1.2, buyVolume: 26393315.63, sellVolume: 25232958.32, numBuys: 1696, numSells: 1735, numTraders: 1191, numNetBuyers: 668 },
};
// USDC shape: audit block lacks the *Disabled flags, top-level authorities present (live 2026-08-22).
const JUP_TOKEN_USDC = { ...JUP_TOKEN, id: USDC, name: "USD Coin", symbol: "USDC", mintAuthority: "BJE5", freezeAuthority: "7dGb", audit: { topHoldersPercentage: 20 } };
const JUP_TOKEN_OTHER = { ...JUP_TOKEN, id: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", name: "Jupiter Lend USDC", symbol: "jlUSDC" };

try {
  // --------------------------------------------------------------------------
  // Catalog envelope
  // --------------------------------------------------------------------------
  ok(SOLANA_INTEL_TOOLS.length === 9, `9 tools exported (got ${SOLANA_INTEL_TOOLS.length})`);
  const slugs = new Set();
  for (const t of SOLANA_INTEL_TOOLS) {
    ok(typeof t.slug === "string" && t.slug.startsWith("sol-") && !slugs.has(t.slug), `${t.slug}: unique sol- slug`);
    slugs.add(t.slug);
    ok(t.route === `POST /api/${t.slug}`, `${t.slug}: route POST /api/${t.slug}`);
    ok(t.category === "crypto", `${t.slug}: category crypto`);
    const usd = Number(String(t.price).replace("$", ""));
    ok(usd >= 0.001 && usd <= 0.01, `${t.slug}: price ${t.price} within $0.001-$0.01`);
    ok(typeof t.handler === "function", `${t.slug}: has handler`);
    ok(t.discovery && t.discovery.input && t.discovery.inputSchema && t.discovery.output?.example, `${t.slug}: discovery envelope (input, inputSchema, output.example)`);
    ok(!/\u2014|\u2013/.test(t.description + t.name), `${t.slug}: no em/en dashes in copy`);
    ok(Array.isArray(t.tags) && t.tags.includes("solana"), `${t.slug}: tagged solana`);
  }

  // --------------------------------------------------------------------------
  // Pure helpers
  // --------------------------------------------------------------------------
  ok(__test.BASE58_RE.test(JUP) && __test.BASE58_RE.test(SOL) && __test.BASE58_RE.test(USDC), "BASE58_RE accepts SOL/USDC/JUP mints");
  ok(!__test.BASE58_RE.test("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), "BASE58_RE rejects an EVM address");
  ok(!__test.BASE58_RE.test("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvC0"), "BASE58_RE rejects the digit 0");
  ok(__test.takeMint("  " + JUP + " ") === JUP, "takeMint trims whitespace");
  ok(__test.authorityState(null).revoked && __test.authorityState("11111111111111111111111111111111").revoked && !__test.authorityState("7dGb").revoked, "authorityState: null/system program = revoked, pubkey = live");
  ok(__test.takeLimit(undefined, 10, 30) === 10 && __test.takeLimit("7", 10, 30) === 7, "takeLimit default + parse");

  // --------------------------------------------------------------------------
  // Validation (400) - must fire BEFORE any egress
  // --------------------------------------------------------------------------
  stub(() => { throw new Error("egress during validation"); });
  await throws(h("sol-token-safety")({}), 400, "safety: missing mint");
  await throws(h("sol-token-safety")({ mint: "0xabc" }), 400, "safety: EVM address");
  await throws(h("sol-token-report")({ mint: JUP, marketLimit: 99 }), 400, "report: marketLimit over 25");
  await throws(h("sol-token-report")({ mint: JUP, holderLimit: 0 }), 400, "report: holderLimit 0");
  await throws(h("sol-token-holders")({ mint: "short" }), 400, "holders: short mint");
  await throws(h("sol-token-pairs")({ mint: JUP, limit: 31 }), 400, "pairs: limit over 30");
  await throws(h("sol-token-search")({}), 400, "search: missing query");
  await throws(h("sol-token-search")({ query: "x".repeat(81) }), 400, "search: query over 80 chars");
  await throws(h("sol-trending")({ list: "hot" }), 400, "trending: bad list");
  await throws(h("sol-trending")({ limit: "abc" }), 400, "trending: non-numeric limit");
  await throws(h("sol-price")({}), 400, "price: missing mints");
  await throws(h("sol-price")({ mints: [] }), 400, "price: empty mints");
  await throws(h("sol-price")({ mints: Array.from({ length: 51 }, () => JUP) }), 400, "price: 51 mints");
  await throws(h("sol-price")({ mints: [JUP, "bad"] }), 400, "price: one bad mint fails the batch");
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC }), 400, "quote: missing amount");
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "1.5" }), 400, "quote: non-integer amount");
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "-5" }), 400, "quote: negative amount");
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: SOL, amount: "1000" }), 400, "quote: same mint both sides");
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "1000", slippageBps: 9999 }), 400, "quote: slippage over 5000");
  await throws(h("sol-token-lookup")({ query: "" }), 400, "lookup: empty query");
  ok(calls.length === 0, "no egress happened during validation failures");

  // --------------------------------------------------------------------------
  // sol-token-safety
  // --------------------------------------------------------------------------
  stub((url) => {
    if (url.includes("api.rugcheck.xyz")) return Promise.resolve(jsonRes(RC_SUMMARY));
    if (url.includes("lite-api.jup.ag/tokens/v2/search")) return Promise.resolve(jsonRes([JUP_TOKEN_OTHER, JUP_TOKEN]));
    return Promise.reject(new Error("unexpected url " + url));
  });
  let r = await h("sol-token-safety")({ mint: JUP });
  ok(calls.length === 2 && calls.some((c) => c.url === `https://api.rugcheck.xyz/v1/tokens/${JUP}/report/summary`), "safety: RugCheck summary URL carries the mint");
  ok(calls.some((c) => c.url.includes(`/tokens/v2/search?query=${JUP}`)), "safety: Jupiter search URL carries the mint");
  ok(r.score === 3550201 && r.scoreNormalised === 97 && r.lpLockedPct === 8.98, "safety: score, normalised, lpLockedPct");
  ok(r.risks.length === 2 && r.risks[0].level === "danger" && r.riskCounts.danger === 1 && r.riskCounts.warn === 1, "safety: risks shaped + counted");
  ok(r.riskLevel === "danger", "safety: riskLevel danger when a danger risk exists");
  ok(r.token.symbol === "JUP" && r.token.holderCount === 835540 && r.token.isVerified === true, "safety: Jupiter exact-mint match picked (not the first row)");
  ok(r.authorities.mintAuthorityDisabled === true && r.authorities.freezeAuthorityDisabled === true, "safety: authorities from Jupiter audit");
  ok(r.holders.topHoldersPct === 15.28 && r.holders.devMints === 1, "safety: holder facts");
  ok(Array.isArray(r.source) && r.source.includes("rugcheck") && typeof r.fetchedAt === "string", "safety: source + fetchedAt");

  stub((url) => url.includes("rugcheck") ? Promise.resolve(jsonRes(RC_SUMMARY_CLEAN)) : Promise.resolve(jsonRes([])));
  r = await h("sol-token-safety")({ mint: PUMP });
  ok(r.riskLevel === "good" && r.token === null && r.authorities === null, "safety: clean summary -> good; Jupiter miss -> null blocks");

  stub((url) => url.includes("rugcheck") ? Promise.resolve(jsonRes(RC_SUMMARY_CLEAN)) : Promise.resolve(jsonRes([JUP_TOKEN_USDC])));
  r = await h("sol-token-safety")({ mint: USDC });
  ok(r.authorities.mintAuthorityDisabled === false && r.authorities.freezeAuthorityDisabled === false && r.authorities.mintAuthority === "BJE5", "safety: live authorities derived when audit flags are absent");

  // --------------------------------------------------------------------------
  // sol-token-report
  // --------------------------------------------------------------------------
  stub((url) => url === `https://api.rugcheck.xyz/v1/tokens/${JUP}/report` ? Promise.resolve(jsonRes(RC_REPORT)) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-token-report")({ mint: JUP, marketLimit: 2, holderLimit: 3 });
  ok(calls.length === 1, "report: exactly one upstream request");
  ok(r.token.symbol === "JUP" && r.token.decimals === 6 && r.token.supply === 6862431164.93 && r.token.metadataMutable === true, "report: token block (supply scaled by decimals)");
  ok(r.authorities.mint.revoked === true && r.authorities.freeze.revoked === false && r.authorities.freeze.address === "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar", "report: authority state");
  ok(r.holders.rows.length === 3 && r.holders.rows[1].label?.type === "AMM" && r.holders.rows[2].insider === true, "report: holders cut to limit, pool label + insider flag");
  ok(r.holders.concentration.top1Pct === 30 && r.holders.concentration.top20Pct === 77 && r.holders.concentration.top10PctExcludingPools === 48, "report: concentration over all 20 (top1 30, top20 77, top10 ex-pools 48)");
  ok(r.holders.concentration.insiderHolders === 1 && r.holders.concentration.labeledPoolOrLockerAccounts === 1, "report: insider + labelled counts");
  ok(r.markets.total === 3 && r.markets.rows.length === 2 && r.markets.rows[0].pool === "M-big" && r.markets.rows[1].pool === "M-mid", "report: markets sorted by liquidity, cut to limit");
  ok(r.markets.rows[0].liquidityUsd === 1260729.14 && r.markets.rows[0].lpLockedPct === 50, "report: market liquidity + LP lock");
  ok(r.lockers.total === 1 && r.lockers.rows[0].type === "raydium_locker" && r.lockers.rows[0].unlockDate === "2027-01-15T08:00:00.000Z", "report: lockers shaped");
  ok(r.launchpad === "Pump.Fun" && r.totalHolders === 2873512 && r.verification.jupVerified === true && r.transferFee.pct === 0, "report: launchpad/holders/verification/transferFee");
  ok(!("knownAccounts" in r) && JSON.stringify(r).length < 4000, "report: compact (no knownAccounts echo)");
  ok(r.source === "rugcheck" && typeof r.fetchedAt === "string", "report: source + fetchedAt");

  // --------------------------------------------------------------------------
  // sol-token-holders
  // --------------------------------------------------------------------------
  stub(() => Promise.resolve(jsonRes(RC_REPORT)));
  r = await h("sol-token-holders")({ mint: JUP, limit: 2 });
  ok(r.holders.length === 2 && r.holders[0].pct === 30 && r.holders[0].owner === "O1", "holders: rows cut to limit");
  ok(r.concentration.top5Pct === 62 && r.concentration.top10Pct === 67, "holders: top5 62 / top10 67 over all holders");
  ok(r.supply === 6862431164.93 && r.totalHolders === 2873512 && r.symbol === "JUP", "holders: supply/totalHolders/symbol");
  r = await h("sol-token-holders")({ mint: JUP });
  ok(r.holders.length === 20, "holders: default limit 20");
  ok(r.holdersSource === "rugcheck" && r.insiderFlagAvailable === true, "holders: RugCheck path names itself and offers the insider flag");

  // RugCheck stopped populating topHolders for EVERY mint before 2026-09-19
  // (measured: 5 of 5 majors, 200 with an empty array while totalHolders stayed
  // populated). The field is still DECLARED, so nothing threw and the tool sold
  // an empty table with a null concentration at $0.005 - the hollow-200 shape.
  // The RPC fallback restores it. CI holds no SOLANA_RPC_URL, so the live path
  // is unreachable there and this is the only place the logic is pinned.
  const RC_NO_HOLDERS = { ...RC_REPORT, topHolders: [] };
  const RPC = "https://rpc.test.invalid/k";
  const rpcStub = (largest, owners) => (url, opts) => {
    if (new URL(String(url)).host !== "rpc.test.invalid") return Promise.resolve(jsonRes(RC_NO_HOLDERS));
    const body = JSON.parse(opts.body);
    if (body.method === "getTokenLargestAccounts") return Promise.resolve(jsonRes({ result: { value: largest } }));
    if (body.method === "getMultipleAccounts") return Promise.resolve(jsonRes({ result: { value: owners } }));
    return Promise.resolve(jsonRes({ error: { message: "unexpected method" } }));
  };
  // 30% and 10% of the fixture's own raw supply (6862431164927844), so the
  // assertion below is about the pct DENOMINATOR, not about round numbers.
  const LARGEST = [
    { address: "TA1", amount: "2058729349478353", uiAmount: 2058729349.478 },
    { address: "TA2", amount: "686243116492784", uiAmount: 686243116.493 },
  ];
  const OWNERS = [
    { data: { parsed: { info: { owner: "W1" } } } },
    { data: { parsed: { info: { owner: "W2" } } } },
  ];
  const prevRpc = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = RPC;
  stub(rpcStub(LARGEST, OWNERS));
  r = await h("sol-token-holders")({ mint: JUP, limit: 10 });
  ok(r.holders.length === 2, "holders: RPC fallback fills the table RugCheck emptied");
  ok(r.holders[0].tokenAccount === "TA1" && r.holders[0].owner === "W1", "holders: RPC rows carry the owner wallet, not just the token account");
  // pct is a share of the mint's own raw supply, the figure RugCheck published,
  // never a share of the top 20 (which would read 75% for a 3-of-4 holder).
  ok(r.holders[0].pct === 30 && r.holders[1].pct === 10, "holders: RPC pct is measured against total supply");
  ok(r.concentration && r.concentration.top1Pct === 30, "holders: concentration is computed on the fallback rows");
  ok(r.holdersSource === "solana-rpc" && r.source === "rugcheck+rpc", "holders: the fallback names its own source");
  // The insider flag only exists on the RugCheck path. Saying so is the
  // difference between "no insiders" and "we did not measure insiders".
  ok(r.insiderFlagAvailable === false && r.holders.every((x) => x.insider === false), "holders: insider flag declared unavailable on the RPC path");
  ok(!r.note, "holders: a filled table carries no empty-data note");
  // sol-token-report shares the block and had the same hollow shape.
  stub(rpcStub(LARGEST, OWNERS));
  r = await h("sol-token-report")({ mint: JUP });
  ok((r.holders?.rows || []).length === 2 && r.holders.concentration.top1Pct === 30, "report: the same fallback fills its holders block");
  // An RPC that answers nothing degrades to the honest empty, never a crash and
  // never an invented table.
  stub(rpcStub([], []));
  r = await h("sol-token-holders")({ mint: JUP });
  ok(r.holders.length === 0 && r.concentration === null && r.holdersSource === null, "holders: a silent RPC leaves an honest empty");
  ok(/no top-holder table/i.test(String(r.note)), "holders: the empty case says why, naming both sources");
  // With no RPC configured at all the fallback is skipped, not attempted.
  process.env.SOLANA_RPC_URL = "";
  stub(() => Promise.resolve(jsonRes(RC_NO_HOLDERS)));
  r = await h("sol-token-holders")({ mint: JUP });
  ok(r.holders.length === 0 && calls.every((c) => new URL(c.url).host === "api.rugcheck.xyz"), "holders: no RPC configured means no RPC call");
  if (prevRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = prevRpc;

  // --------------------------------------------------------------------------
  // sol-token-pairs
  // --------------------------------------------------------------------------
  stub((url) => url === `https://api.dexscreener.com/token-pairs/v1/solana/${JUP}`
    ? Promise.resolve(jsonRes([DS_PAIR({ pairAddress: "small", liquidity: { usd: 100 } }), DS_PAIR(), DS_PAIR({ chainId: "ethereum", pairAddress: "eth" })]))
    : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-token-pairs")({ mint: JUP, limit: 5 });
  ok(r.totalPairs === 2 && r.pairs[0].pairAddress === "EoFt" && r.pairs[1].pairAddress === "small", "pairs: solana-only, sorted by liquidity");
  const p0 = r.pairs[0];
  ok(p0.priceUsd === 992.83 && p0.priceNative === 0.9139 && p0.liquidityUsd === 71508214.54 && p0.volume.h24 === 149471020.95, "pairs: numeric strings parsed");
  ok(p0.txns24h.buys === 1180 && p0.txns1h.sells === 43 && p0.priceChangePct.h24 === -6.39, "pairs: txns + price change");
  ok(p0.ageHours > 35 && p0.ageHours < 37 && typeof p0.pairCreatedAt === "string", "pairs: age in hours from pairCreatedAt");
  ok(p0.hasProfile === true && p0.labels[0] === "DLMM" && p0.quote.symbol === "MET", "pairs: profile flag, labels, quote");
  ok(r.totals.liquidityUsd === 71508314.54 && r.totals.txns24h === 4858, "pairs: totals summed across solana pairs");

  // --------------------------------------------------------------------------
  // sol-token-search
  // --------------------------------------------------------------------------
  stub((url) => url.startsWith("https://api.dexscreener.com/latest/dex/search?q=JUP%20token")
    ? Promise.resolve(jsonRes({ schemaVersion: "1.0.0", pairs: [DS_PAIR({ pairAddress: "first", liquidity: { usd: 1 }, info: undefined }), DS_PAIR({ chainId: "robinhood", pairAddress: "rh" }), DS_PAIR({ pairAddress: "second" })] }))
    : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-token-search")({ query: "JUP token", limit: 10 });
  ok(r.totalSolanaPairs === 2 && r.pairs[0].pairAddress === "first" && r.pairs[1].pairAddress === "second", "search: solana-only, upstream relevance order kept (not re-sorted by liquidity)");
  ok(r.pairs[0].hasProfile === false && r.pairs[1].hasProfile === true, "search: hasProfile distinguishes bare pairs");
  ok(r.query === "JUP token" && r.source === "dexscreener", "search: echoes query + source");
  stub(() => Promise.resolve(jsonRes({ schemaVersion: "1.0.0", pairs: [] })));
  r = await h("sol-token-search")({ query: "zzzz" });
  ok(r.totalSolanaPairs === 0 && r.pairs.length === 0, "search: no match -> empty list, not an error");

  // --------------------------------------------------------------------------
  // sol-trending
  // --------------------------------------------------------------------------
  stub((url) => {
    if (url === "https://api.dexscreener.com/token-boosts/top/v1") return Promise.resolve(jsonRes(DS_BOOSTS));
    if (url === "https://api.dexscreener.com/token-profiles/latest/v1") return Promise.resolve(jsonRes(DS_PROFILES));
    return Promise.reject(new Error("bad url " + url));
  });
  r = await h("sol-trending")({ limit: 10 });
  ok(calls.length === 2, "trending: both lists fetched in one call");
  ok(r.boosts.length === 2 && r.boosts[0].mint === PUMP && r.boosts[0].boostAmount === 500 && r.boosts[0].links.length === 2, "trending: boosts solana-only, amount + links");
  ok(r.profiles.length === 1 && r.profiles[0].mint === "AiRG" && r.profiles[0].communityTakeover === true, "trending: profiles solana-only, cto flag");
  ok(r.counts.boostsSolana === 2 && r.counts.boostsAll === 3 && r.counts.profilesSolana === 1 && r.counts.profilesAll === 2, "trending: counts");
  stub((url) => url.endsWith("/token-boosts/top/v1") ? Promise.resolve(jsonRes(DS_BOOSTS)) : Promise.reject(new Error("profiles must not be fetched: " + url)));
  r = await h("sol-trending")({ list: "boosts", limit: 1 });
  ok(calls.length === 1 && r.boosts.length === 1 && r.profiles === null, "trending: list=boosts fetches one endpoint, profiles null");

  // --------------------------------------------------------------------------
  // sol-price
  // --------------------------------------------------------------------------
  stub((url) => url === `https://lite-api.jup.ag/price/v3?ids=${SOL},${JUP},${PUMP}` ? Promise.resolve(jsonRes(JUP_PRICE)) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-price")({ mints: [SOL, JUP, PUMP, JUP] });
  ok(r.count === 2 && r.missing.length === 1 && r.missing[0] === PUMP, "price: duplicates collapsed, unknown mint listed as missing");
  ok(r.prices[SOL].priceUsd === 93.70851135305588 && r.prices[SOL].decimals === 9 && r.prices[JUP].priceChange24hPct === -2.3987, "price: fields shaped");
  stub((url) => url.endsWith(`?ids=${SOL}`) ? Promise.resolve(jsonRes(JUP_PRICE)) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-price")({ mints: SOL });
  ok(r.count === 1 && Object.keys(r.prices)[0] === SOL, "price: comma-string input accepted");

  // --------------------------------------------------------------------------
  // sol-swap-quote
  // --------------------------------------------------------------------------
  stub((url) => url === `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=1000000000&slippageBps=50`
    ? Promise.resolve(jsonRes(JUP_QUOTE)) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "1000000000" });
  ok(r.outAmount === "93708783" && r.minOutAmount === "93240240" && r.slippageBps === 50, "quote: default slippage 50, amounts as strings");
  ok(r.priceImpactPct === 0.0012 && r.swapUsdValue === 93.6989 && r.hops === 2, "quote: price impact, usd value, hop count");
  ok(r.route[0].label === "BisonFi" && r.route[1].label === "SolFi V2" && r.route[1].outputMint === USDC && r.route[0].percent === 100, "quote: route labels in hop order");
  ok(r.contextSlot === 440919041 && r.source === "jupiter", "quote: contextSlot + source");
  stub((url) => url.includes("amount=5000&slippageBps=100") ? Promise.resolve(jsonRes(JUP_QUOTE)) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: 5000, slippageBps: 100 });
  ok(r.slippageBps === 100, "quote: numeric amount + custom slippage ride the URL");

  // --------------------------------------------------------------------------
  // sol-token-lookup
  // --------------------------------------------------------------------------
  stub((url) => url === `https://lite-api.jup.ag/tokens/v2/search?query=${JUP}` ? Promise.resolve(jsonRes([JUP_TOKEN_OTHER, JUP_TOKEN])) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-token-lookup")({ query: JUP, limit: 5 });
  ok(r.count === 2 && r.tokens[0].mint === JUP && r.tokens[1].symbol === "jlUSDC", "lookup: exact mint match sorted first");
  const t0 = r.tokens[0];
  ok(t0.holderCount === 835540 && t0.marketCapUsd === 675335464.9800633 && t0.organicScore === 99.31 && t0.isVerified === true, "lookup: profile fields");
  ok(t0.audit.mintAuthorityDisabled === true && t0.audit.topHoldersPct === 15.28 && t0.firstPool.id === "2psp", "lookup: audit + first pool");
  ok(t0.stats24h.numTraders === 1191 && t0.stats24h.priceChangePct === -2.4, "lookup: 24h stats");
  stub((url) => url.includes("query=cat%20season") ? Promise.resolve(jsonRes([JUP_TOKEN_OTHER, JUP_TOKEN])) : Promise.reject(new Error("bad url " + url)));
  r = await h("sol-token-lookup")({ query: "cat season", limit: 1 });
  ok(r.count === 1 && r.tokens.length === 1 && r.tokens[0].symbol === "jlUSDC", "lookup: name query keeps upstream order, limit honoured");

  // --------------------------------------------------------------------------
  // Upstream error mapping (every class, no body relayed)
  // --------------------------------------------------------------------------
  const SECRET_BODY = "UPSTREAM-SECRET-DETAIL-xyz";
  stub(() => Promise.resolve(textRes(SECRET_BODY, 429)));
  await throws(h("sol-token-safety")({ mint: JUP }), 503, "429 -> 503");
  stub(() => Promise.resolve(textRes(SECRET_BODY, 500)));
  await throws(h("sol-token-report")({ mint: JUP }), 502, "500 -> 502");
  stub(() => Promise.resolve(textRes(SECRET_BODY, 503)));
  await throws(h("sol-token-pairs")({ mint: JUP }), 502, "503 -> 502");
  stub(() => Promise.resolve(textRes(SECRET_BODY, 502)));
  await throws(h("sol-trending")({}), 502, "502 -> 502");
  stub(() => Promise.resolve(jsonRes({ error: SECRET_BODY }, 400)));
  await throws(h("sol-token-holders")({ mint: JUP }), 422, "upstream 400 (invalid mint) -> 422");
  stub(() => Promise.resolve(jsonRes({ error: SECRET_BODY, errorCode: "TOKEN_NOT_TRADABLE" }, 400)));
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "1" }), 422, "quote upstream 400 -> 422");
  stub(() => Promise.resolve(textRes("Route not found", 404)));
  await throws(h("sol-price")({ mints: [SOL] }), 422, "404 -> 422");
  stub(() => Promise.resolve(textRes(SECRET_BODY, 403)));
  await throws(h("sol-token-lookup")({ query: "x" }), 502, "403 -> 502");
  stub(() => Promise.resolve(textRes("<html>cloudflare</html>", 200)));
  await throws(h("sol-token-search")({ query: "x" }), 502, "non-JSON 200 -> 502");
  // Transport failure / timeout: AbortSignal.timeout rejects with TimeoutError.
  stub(() => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
  await throws(h("sol-token-safety")({ mint: JUP }), 504, "timeout -> 504");
  stub(() => Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })));
  await throws(h("sol-swap-quote")({ inputMint: SOL, outputMint: USDC, amount: "1" }), 504, "connection reset -> 504");
  // One leg failing fails the parallel tool (no half answers billed as whole).
  stub((url) => url.includes("rugcheck") ? Promise.resolve(jsonRes(RC_SUMMARY)) : Promise.resolve(textRes("x", 500)));
  await throws(h("sol-token-safety")({ mint: JUP }), 502, "safety: Jupiter leg 500 -> whole call 502");

  // No upstream body text may reach the buyer on any error path.
  const errs = [];
  for (const [status, body] of [[429, SECRET_BODY], [500, SECRET_BODY], [400, JSON.stringify({ error: SECRET_BODY })], [418, SECRET_BODY]]) {
    stub(() => Promise.resolve(textRes(body, status)));
    try { await h("sol-token-safety")({ mint: JUP }); } catch (e) { errs.push(e.message); }
  }
  ok(errs.length === 4 && errs.every((m) => !m.includes(SECRET_BODY) && !m.includes("xyz")), "no upstream error body is relayed in any error message");

  // The timeout signal is an AbortSignal with a bounded deadline on every call.
  stub((url, opts) => { ok(opts.signal instanceof AbortSignal, "request carries an AbortSignal (timeout)"); return Promise.resolve(jsonRes(JUP_PRICE)); });
  await h("sol-price")({ mints: [SOL] });
} finally {
  restore();
}

// RugCheck answers "unable to generate report" for every mint while its report
// builder is down (2026-09-25): that is a retryable upstream 503, never a 422
// blaming the buyer's mint. A genuinely invalid mint still reads 422.
{
  const JUPM = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  stub(async () => jsonRes({ error: "unable to generate report" }, 400));
  await throws(h("sol-token-report")({ mint: JUPM }), 503, "rugcheck outage (400 unable to generate report) is upstream, not the mint");
  stub(async () => jsonRes({ error: "unable to generate report" }, 404));
  await throws(h("sol-token-report")({ mint: JUPM }), 503, "rugcheck outage (404 unable to generate report) is upstream, not the mint");
  stub(async () => jsonRes({ error: "invalid token mint" }, 400));
  await throws(h("sol-token-report")({ mint: JUPM }), 422, "an invalid mint still reads 422");
  restore();
}

// Jupiter base and key are variables, so moving off the deprecated lite-api is
// a Railway change. The key is sent only to the configured Jupiter host.
ok(jupiterBase({}) === "https://lite-api.jup.ag", "Jupiter: the default base is today's lite-api");
ok(jupiterBase({ JUPITER_API_BASE: "https://api.jup.ag/" }) === "https://api.jup.ag", "Jupiter: JUPITER_API_BASE switches the host (trailing slash dropped)");
ok(jupiterBase({ JUPITER_API_BASE: "http://evil.example" }) === "https://lite-api.jup.ag" && jupiterBase({ JUPITER_API_BASE: "https://x.example/path" }) === "https://lite-api.jup.ag", "Jupiter: a non-https or path-bearing base is refused, falling back to the default");
const kenv = { JUPITER_API_BASE: "https://api.jup.ag", JUPITER_API_KEY: "k-test" };
ok(jupiterHeaders("https://api.jup.ag/price/v3?ids=x", kenv)["x-api-key"] === "k-test", "Jupiter: the key rides requests to the configured host");
ok(!jupiterHeaders("https://api.rugcheck.xyz/v1/x", kenv)["x-api-key"] && !jupiterHeaders("https://api.jup.ag.evil.example/x", kenv)["x-api-key"], "Jupiter: the key never goes to another host, including a lookalike");
ok(Object.keys(jupiterHeaders("https://lite-api.jup.ag/price/v3", {})).length === 0, "Jupiter: no key configured, no header");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
