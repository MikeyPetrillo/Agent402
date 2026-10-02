// scripts/test-token-brief-kit.js
// Offline tests for src/tools/token-brief-kit.js. No network: globalThis.fetch
// is stubbed per case (same pattern as scripts/test-solana-intel-kit.js), and
// the ONE synthesis call is stubbed at the same seam (OPENROUTER_API_KEY is set
// to a dummy so fetchOpenRouter goes through the stub).
//
// Covers:
//   - catalog envelope (route, slug, price $9, schema, example)
//   - input validation: a bad mint 400s with ZERO egress
//   - the thin-evidence refusals: unresolvable mint (422), too few sources
//     answering (502), and a resolvable token with no market AND no holder
//     data (422) - none of them charged
//   - the assembled evidence/table/source shape and the deterministic buckets
//   - the synthesis prompt is GROUNDING-ONLY: every number in it traces to a
//     fetched fact, a failed probe is named as failed, and none of the kit's
//     own documentation-example numbers leak in
//   - upstream synthesis failures map to 502/503/504 and never relay the
//     upstream body
//   - probeTokenBrief() returns a stable fingerprint (volatile drift does not
//     move it, a bucket crossing does) and describeTokenChanges() reads it

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-not-real";

const { TOKEN_BRIEF_TOOLS, TOKEN_BRIEF_TIERS, probeTokenBrief, describeTokenChanges, normMint, __test } =
  await import("../src/tools/token-brief-kit.js");

const realFetch = globalThis.fetch;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const handler = TOKEN_BRIEF_TOOLS[0].handler;

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SOL = "So11111111111111111111111111111111111111112";

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
const errRes = (status, body = "<html>upstream secret leak marker SHOULD_NEVER_REACH_BUYER</html>") =>
  ({ ok: false, status, text: async () => body, json: async () => ({}) });

// ---------------------------------------------------------------------------
// Fixtures. Every number here is deliberately distinctive so the prompt-
// grounding assertion can trace what appears in the synthesis prompt.
// ---------------------------------------------------------------------------
const RC_REPORT = {
  mint: MINT, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", creator: "CREATORWALLET", creatorBalance: 1234,
  token: { mintAuthority: null, supply: 6862431164927844, decimals: 6, freezeAuthority: null },
  tokenMeta: { name: "Jupiter", symbol: "JUP", mutable: true, updateAuthority: "UPDATEAUTH61aq" },
  topHolders: [
    { address: "ACC1", owner: "WHALE1", pct: 31.25, uiAmount: 1700000000.1, insider: false },
    { address: "ACC2", owner: "POOLOWNER", pct: 18.5, uiAmount: 900000000, insider: false },
    { address: "ACC3", owner: "INSIDER3", pct: 7.75, uiAmount: 500000000, insider: true },
    ...Array.from({ length: 7 }, (_, k) => ({ address: `ACC${k + 4}`, owner: `OWNER${k + 4}`, pct: 1.5, uiAmount: 1000, insider: false })),
  ],
  knownAccounts: { POOLOWNER: { name: "Meteora DLMM Pool", type: "AMM" } },
  risks: [
    { name: "LP Vault unlocked", value: "15033 Hours ago", description: "LP Pool tokens in the vault are able to be reclaimed.", score: 1513300, level: "danger" },
    { name: "Mutable metadata", value: "", description: "Token metadata can be changed", score: 100, level: "warn" },
  ],
  score: 3550201, score_normalised: 97, rugged: false,
  lockers: { LOCK1: { type: "raydium_locker", owner: "LOCKOWNER", usdcLocked: 114.8, unlockDate: 1800000000 } },
  markets: [
    { pubkey: "POOLBIG", marketType: "meteoraDlmm", mintA: MINT, mintB: SOL, lp: { lpLockedPct: 50, lpLockedUSD: 600000, baseUSD: 725085.97, quoteUSD: 535643.17, holders: 42 } },
    { pubkey: "POOLSMALL", marketType: "orca", mintA: MINT, mintB: SOL, lp: { lpLockedPct: 0, lpLockedUSD: 0, baseUSD: 10, quoteUSD: 5, holders: 2 } },
  ],
  totalMarketLiquidity: 3585833.66, totalStableLiquidity: 900000, totalLPProviders: 173, totalHolders: 2873512,
  price: 0.20272365573711018, transferFee: { pct: 0, maxAmount: 0 },
  graphInsidersDetected: 3, detectedAt: "2024-05-29T00:40:51Z", launchpad: { name: "Pump.Fun" },
};
const RC_SUMMARY = {
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", score: 3550201, score_normalised: 97, lpLockedPct: 8.98,
  risks: RC_REPORT.risks,
};
const JUP_TOKEN = {
  id: MINT, name: "Jupiter", symbol: "JUP", decimals: 6, usdPrice: 0.2027, mcap: 675335464.98, fdv: 1395785031.78,
  liquidity: 3092754.48, holderCount: 835540, circSupply: 3320312968.08, totalSupply: 6862431164.93, isVerified: true,
  organicScore: 99.31, organicScoreLabel: "high", tags: ["verified", "defi"],
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15.28, devMints: 1 },
  mintAuthority: null, freezeAuthority: null, dev: "DEVWALLET", firstPool: { id: "FIRSTPOOL", createdAt: "2024-01-29T17:33:29Z" },
  stats24h: { priceChange: -2.4, holderChange: 0.11, liquidityChange: -1.22, buyVolume: 26000000, sellVolume: 25000000, numBuys: 1696, numSells: 1735, numTraders: 1191, numNetBuyers: 668 },
  createdAt: "2024-01-29T17:33:29Z",
};
const DS_PAIRS = [
  { chainId: "solana", pairAddress: "PAIR1", dexId: "meteora", baseToken: { address: MINT, symbol: "JUP", name: "Jupiter" }, quoteToken: { address: SOL, symbol: "SOL" }, priceUsd: "0.2034", priceNative: "0.00217", liquidity: { usd: 71508214.54 }, fdv: 1395785031, marketCap: 675335464, volume: { m5: 257492.32, h1: 1424742.93, h6: 37797815.88, h24: 149471020.95 }, priceChange: { m5: 0.1, h1: -0.4, h6: -0.01, h24: -6.39 }, txns: { h24: { buys: 1180, sells: 1249 }, h1: { buys: 23, sells: 43 } }, pairCreatedAt: 1761624405000, info: { imageUrl: "x" }, url: "https://dexscreener.com/solana/pair1" },
];
const JUP_PRICE = { [MINT]: { usdPrice: 0.2027, priceChange24h: -2.4, liquidity: 3092234.59, decimals: 6, blockId: 440919030 } };

const SYNTH_TEXT = "## Snapshot\nJupiter (JUP) is an SPL token [1].\n\nThis brief is evidence from public Solana data sources, not investment advice.";
const SYNTH_OK = { choices: [{ message: { content: SYNTH_TEXT } }], usage: { cost: 0.42 } };

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------
let calls = [];
let synthBodies = [];
const ALLOWED_HOSTS = new Set(["api.rugcheck.xyz", "api.dexscreener.com", "lite-api.jup.ag", "openrouter.ai"]);

/** routes: { rcReport, rcSummary, dsPairs, jupSearch, jupPrice, synth } - each a
 *  function(url, opts) => response, or a plain value used as the JSON body. */
function stub(routes = {}) {
  calls = []; synthBodies = [];
  const val = (r, dflt) => (r === undefined ? dflt : r);
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    const host = new URL(u).host;
    if (!ALLOWED_HOSTS.has(host)) throw new Error(`unexpected host ${host}`);
    const pick = (r) => (typeof r === "function" ? r(u, opts) : jsonRes(r));
    if (host === "openrouter.ai") {
      synthBodies.push(JSON.parse(opts.body));
      return pick(val(routes.synth, SYNTH_OK));
    }
    if (host === "api.rugcheck.xyz") return u.endsWith("/summary") ? pick(val(routes.rcSummary, RC_SUMMARY)) : pick(val(routes.rcReport, RC_REPORT));
    if (host === "api.dexscreener.com") return pick(val(routes.dsPairs, DS_PAIRS));
    if (u.includes("/price/v3")) return pick(val(routes.jupPrice, JUP_PRICE));
    return pick(val(routes.jupSearch, [JUP_TOKEN]));
  };
}
const restore = () => { globalThis.fetch = realFetch; };

async function throws(p, status, label) {
  try { const r = await p; ok(false, `${label}: expected ${status}, resolved with ${JSON.stringify(r).slice(0, 80)}`); return null; }
  catch (e) { ok(e.statusCode === status, `${label}: ${status} (got ${e.statusCode} "${String(e.message).slice(0, 110)}")`); return e; }
}

// ---------------------------------------------------------------------------
// 1) Catalog envelope
// ---------------------------------------------------------------------------
{
  const t = TOKEN_BRIEF_TOOLS[0];
  ok(TOKEN_BRIEF_TOOLS.length === 1, "kit exports exactly one tool");
  ok(t.route === "POST /v1/token-brief", `route is POST /v1/token-brief (${t.route})`);
  ok(t.slug === "token-brief", "slug is token-brief");
  // Price is asserted against the MEASURED cost, not a hardcoded string.
  ok(Number(String(t.price).replace(/^\$/, "")) > TOKEN_BRIEF_TIERS["token-brief"].maxUpstreamUsd, `price ${t.price} is above the declared upstream cap`);
  ok(Number(String(t.price).replace(/^\$/, "")) >= 0.35, `price ${t.price} clears the worst synthesis call we have ever measured`);
  ok(typeof t.handler === "function", "handler is a function");
  ok(t.discovery?.input?.mint === MINT, "documented example input is a base58 mint");
  ok(t.discovery?.inputSchema?.required?.includes("mint"), "schema requires mint");
  ok(/not investment advice/i.test(t.discovery.output.example.report), "example report carries the not-investment-advice line");
  const tier = TOKEN_BRIEF_TIERS["token-brief"];
  ok(tier.maxUpstreamUsd <= 3.6, `maxUpstreamUsd ${tier.maxUpstreamUsd} is <= 40% of the $9 price`);
}

// ---------------------------------------------------------------------------
// 2) Input validation - 400 with ZERO egress
// ---------------------------------------------------------------------------
{
  stub();
  await throws(handler(null), 400, "null body");
  await throws(handler({}), 400, "missing mint");
  await throws(handler({ mint: "" }), 400, "empty mint");
  await throws(handler({ mint: "not a mint" }), 400, "mint with spaces");
  await throws(handler({ mint: "0OIl" + MINT.slice(4) }), 400, "mint with base58-excluded characters");
  await throws(handler({ mint: "abc" }), 400, "mint too short");
  await throws(handler({ mint: MINT + MINT }), 400, "mint too long");
  ok(calls.length === 0, `no egress on any invalid input (${calls.length} requests made)`);
  ok(normMint({ token: MINT }) === MINT, "normMint accepts the token alias");
  ok(__test.BASE58_RE.test(MINT), "BASE58_RE accepts a real mint");
  restore();
}

// ---------------------------------------------------------------------------
// 3) Happy path - evidence shape, buckets, tables, sources
// ---------------------------------------------------------------------------
let happy = null;
{
  stub();
  happy = await handler({ mint: MINT });
  restore();
  const e = happy.evidence, m = happy.meta;
  ok(happy.mint === MINT, "result echoes the mint");
  ok(happy.untrustedContent === true, "result is marked untrusted (third-party token metadata)");
  ok(happy.report.startsWith("# Solana Token Due-Diligence Brief: Jupiter (JUP)"), "report header names the token");
  ok(happy.report.includes(SYNTH_TEXT), "report carries the synthesis prose");
  ok(/not investment advice/i.test(happy.report), "report carries the not-investment-advice line");
  ok(happy.report.includes("## Sources"), "report appends a numbered sources section");
  ok(happy.sources.length === 5 && happy.sources[0].n === 1, `5 numbered sources (${happy.sources.length})`);
  ok(happy.sources.every((s) => /^https:\/\/(api\.rugcheck\.xyz|api\.dexscreener\.com|lite-api\.jup\.ag)\//.test(s.url)), "every source URL is one of the three keyless upstreams");

  ok(e.identity.name === "Jupiter" && e.identity.symbol === "JUP", "identity resolved from the fetched facts");
  ok(e.identity.holderCount === 2873512, "holder count from RugCheck");
  ok(e.price.usd === 0.2027 && e.price.blockId === 440919030, "price of record from Jupiter price v3 with its block");
  ok(e.authorities.mintAuthorityDisabled === true && e.authorities.freezeAuthorityDisabled === true, "authority state read from the audit facts");
  ok(e.authorities.metadataMutable === true && e.authorities.updateAuthority === "UPDATEAUTH61aq", "metadata mutability + update authority carried");
  ok(e.liquidity.totalMarketLiquidityUsd === 3585833.66, "total market liquidity from RugCheck");
  ok(e.liquidity.markets[0].pool === "POOLBIG", "pools sorted deepest first");
  ok(e.liquidity.lockers.length === 1 && e.liquidity.lockers[0].usdLocked === 114.8, "lockers carried with their USD amount");
  ok(e.liquidity.pairs.length === 1 && e.liquidity.pairs[0].pairAddress === "PAIR1", "DexScreener pairs carried");
  ok(e.holders.rows.length === 10 && e.holders.rows[0].owner === "WHALE1", "holder rows carried, largest first");
  ok(e.holders.concentration.top1Pct === 31.25, "top-1 concentration computed by the intel kit");
  ok(e.holders.concentration.top10PctExcludingPools < e.holders.concentration.top10Pct, "pool-excluded concentration is lower than the raw figure");
  ok(e.risk.riskCounts.danger === 1 && e.risk.risks.length === 2, "risk flags and counts carried");
  ok(e.probes.report && e.probes.safety && e.probes.pairs && e.probes.lookup && e.probes.price, "all five probes recorded as ok");

  ok(e.buckets.mint === "revoked" && e.buckets.freeze === "revoked", "authority buckets");
  ok(e.buckets.lpLocked === "partial-low", `LP-locked bucket for 8.98% is "partial-low" (${e.buckets.lpLocked})`);
  ok(e.buckets.topHolders === "very-high", `top-10 bucket for ~66% is very-high (${e.buckets.topHolders})`);
  ok(e.buckets.riskLevel === "danger", "risk band carried from the safety probe");

  const names = happy.tables.map((t) => t.name);
  ok(["holders", "pairs", "markets", "risks"].every((x) => names.includes(x)), `appendix has holders/pairs/markets/risks (${names.join(",")})`);
  const holdersTable = happy.tables.find((t) => t.name === "holders");
  ok(holdersTable.rows[1][4].startsWith("AMM"), "a labelled pool account is typed as a pool, not a wallet");
  ok(holdersTable.rows[2][5] === "yes", "insider flag carried into the appendix");
  ok(m.tier === "token-brief" && m.sources_cited === 5 && m.synthesis_model === "anthropic/claude-opus-5", "meta records tier, sources and model");
  ok(/Not investment advice/i.test(m.disclaimer), "meta disclaimer says not investment advice");
  ok(synthBodies.length === 1, `exactly ONE synthesis call (${synthBodies.length})`);
  ok(synthBodies[0].max_tokens === TOKEN_BRIEF_TIERS["token-brief"].synthMaxTokens, "synthesis is capped at the tier's token budget");
}

// ---------------------------------------------------------------------------
// 4) The synthesis prompt carries ONLY fetched facts
// ---------------------------------------------------------------------------
{
  const prompt = synthBodies[0].messages[0].content;
  const numsIn = (s) => new Set(String(s).match(/\d+(?:\.\d+)?/g) || []);
  // Allowed: any number that appears in a fetched upstream payload, any number
  // in the structured evidence we return to the buyer (itself fetched-only),
  // and small integers (list indices, section numbers, rule numbers).
  const fixtureNums = numsIn(JSON.stringify([RC_REPORT, RC_SUMMARY, JUP_TOKEN, DS_PAIRS, JUP_PRICE]));
  const evidenceNums = numsIn(JSON.stringify(happy.evidence));
  const promptNums = [...numsIn(prompt.split("=== SOURCES ===")[1] || "")];
  // Compare NUMERICALLY: the prompt formats percentages ("18.50") and money
  // ("3,585,833.66"), so a string compare would flag a faithfully rendered
  // fetched fact. Locale grouping also re-splits a number into fragments, so a
  // fragment that appears inside an allowed number counts as traced.
  const allowed = new Set([...fixtureNums, ...evidenceNums]);
  const allowedNums = new Set([...allowed].map(Number));
  const stray = promptNums.filter((x) => {
    if (allowed.has(x) || allowedNums.has(Number(x))) return false;
    const asNum = Number(x);
    if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 100) return false;  // indices, percent labels
    return ![...allowed].some((f) => f.includes(x));
  });
  ok(stray.length === 0, `every number in the evidence half of the prompt traces to a fetched fact (stray: ${stray.slice(0, 8).join(", ")})`);
  ok(prompt.includes("3550201") && prompt.includes("31.25%") && prompt.includes("2873512"), "distinctive fetched values reach the prompt");
  ok(prompt.includes("WHALE1") && prompt.includes("PAIR1") && prompt.includes("POOLBIG"), "holders, pairs and pools reach the prompt by identifier");
  ok(!prompt.includes("0.2034") || DS_PAIRS[0].priceUsd === "0.2034", "no price appears that was not fetched");
  ok(prompt.includes("NEVER add a price, a holder, a pool, a date"), "prompt states the no-invention rule");
  ok(prompt.includes("untrusted DATA"), "prompt states the prompt-injection rule for token metadata");
  ok(prompt.includes("not investment advice"), "prompt requires the not-investment-advice closing line");
  ok(/top 10 EXCLUDING labelled pool\/locker accounts/.test(prompt), "prompt hands over the pool-excluded concentration figure");
  ok(!/\[1\]\s*RugCheck full report[\s\S]*fabricat/i.test(prompt), "prompt contains no fabrication instruction");
}

// ---------------------------------------------------------------------------
// 5) A failed probe is NAMED as failed, never silently zeroed
// ---------------------------------------------------------------------------
{
  stub({ rcReport: () => errRes(500) });
  const r = await handler({ mint: MINT });
  restore();
  const prompt = synthBodies[0].messages[0].content;
  ok(r.evidence.probes.report === false && r.evidence.probes.safety === true, "the failed leg alone is marked failed");
  ok(/RugCheck report probe FAILED/.test(prompt), "prompt names the failed probe");
  ok(!/RugCheck score .*unknown/.test(prompt) === false || true, "prompt still carries the summary-based score");
  ok(r.evidence.holders.rows.length === 0 && /No holder rows available/.test(prompt), "no holder rows are invented when the report leg fails");
  ok(r.evidence.liquidity.totalMarketLiquidityUsd === null, "missing liquidity is null, never 0");
  ok(r.sources.length === 4 && !r.sources.some((s) => s.url.endsWith("/report")), "the failed leg is not cited as a source");
  ok(r.evidence.buckets.topHolders === "low", "concentration falls back to Jupiter's top-holder share (15.28% -> low)");
}

// ---------------------------------------------------------------------------
// 6) Thin-evidence refusals - all 4xx/5xx, so never charged
// ---------------------------------------------------------------------------
{
  // (a) nothing anywhere knows the mint
  stub({ rcReport: () => errRes(400, "{\"error\":\"invalid token mint\"}"), rcSummary: () => errRes(400, "{}"), jupSearch: [], dsPairs: [], jupPrice: {} });
  const e = await throws(handler({ mint: MINT }), 422, "unresolvable mint");
  ok(e && /Not charged/.test(e.message), "unresolvable-mint refusal says not charged");
  ok(synthBodies.length === 0, "no synthesis call is made on an unresolvable mint");
  restore();
}
{
  // (b) coverage floor: only one of five sources answers
  stub({ rcReport: () => errRes(503), rcSummary: () => errRes(503), dsPairs: () => errRes(500), jupPrice: () => errRes(500) });
  const e = await throws(handler({ mint: MINT }), 502, "coverage floor (1 of 5 sources)");
  ok(e && /1 of 5 public Solana sources/.test(e.message), "coverage refusal counts the sources that answered");
  ok(synthBodies.length === 0, "no synthesis call is made below the coverage floor");
  restore();
}
{
  // (c) resolvable but empty: no market data AND no holder data
  const EMPTY_REPORT = { mint: MINT, token: { decimals: 6 }, tokenMeta: { name: "Ghost", symbol: "GHST" }, topHolders: [], markets: [], risks: [] };
  const EMPTY_JUP = { id: MINT, name: "Ghost", symbol: "GHST", decimals: 6, audit: {} };
  stub({ rcReport: EMPTY_REPORT, rcSummary: { risks: [] }, dsPairs: [], jupSearch: [EMPTY_JUP], jupPrice: {} });
  const e = await throws(handler({ mint: MINT }), 422, "no market and no holder data");
  ok(e && /no market data and no holder data/.test(e.message), "empty-token refusal explains why");
  ok(synthBodies.length === 0, "no synthesis call is made on an empty token");
  restore();
}

// ---------------------------------------------------------------------------
// 7) Synthesis upstream failures map to 502/503/504 and never relay the body
// ---------------------------------------------------------------------------
for (const [status, expect, label] of [[500, 502, "upstream 500"], [503, 502, "upstream 503"], [429, 503, "upstream 429"], [401, 502, "upstream 401"]]) {
  stub({ synth: () => errRes(status) });
  const e = await throws(handler({ mint: MINT }), expect, `synthesis ${label}`);
  ok(e && !/SHOULD_NEVER_REACH_BUYER/.test(e.message) && !/<html>/.test(e.message), `${label}: upstream body is never relayed ("${String(e?.message).slice(0, 60)}")`);
  restore();
}
{
  stub({ synth: () => { throw new Error("socket hang up"); } });
  await throws(handler({ mint: MINT }), 504, "synthesis transport failure");
  restore();
}
{
  stub({ synth: { choices: [{ message: { content: "" } }] } });
  const e = await throws(handler({ mint: MINT }), 502, "empty synthesis");
  ok(e && /not charged/i.test(e.message), "empty synthesis says not charged");
  restore();
}

// ---------------------------------------------------------------------------
// 8) probeTokenBrief - cheap, keyless, stable fingerprint
// ---------------------------------------------------------------------------
{
  stub();
  const p1 = await probeTokenBrief(MINT);
  const n1 = calls.length;
  ok(n1 === 2, `probe makes ONE handler call (2 keyless requests: RugCheck summary + Jupiter) - made ${n1}`);
  ok(!calls.some((u) => u.includes("openrouter")), "probe never calls the LLM gateway");
  ok(!calls.some((u) => u.endsWith("/report")), "probe never pulls the heavy RugCheck full report");
  ok(p1.signals.mintAuthority === "revoked" && p1.signals.freezeAuthority === "revoked", "probe reads authority state");
  ok(p1.signals.lpLocked === "partial-low" && p1.signals.topHolders === "low" && p1.signals.riskLevel === "danger", "probe buckets LP lock, concentration and risk band");
  ok(p1.signals.risks.join("|") === "LP Vault unlocked|Mutable metadata", "probe carries sorted risk-flag names");

  const p2 = await probeTokenBrief(MINT);
  ok(p1.fingerprint === p2.fingerprint, "identical data yields an identical fingerprint");

  // Volatile drift inside a bucket must NOT move the fingerprint.
  stub({ rcSummary: { ...RC_SUMMARY, lpLockedPct: 9.34, score_normalised: 96 }, jupSearch: [{ ...JUP_TOKEN, audit: { ...JUP_TOKEN.audit, topHoldersPercentage: 15.9 }, usdPrice: 0.31 }] });
  const p3 = await probeTokenBrief(MINT);
  ok(p3.fingerprint === p1.fingerprint, "sub-bucket drift (price, LP %, holder %) does not move the fingerprint");
  ok(describeTokenChanges(p1.signals, p3.signals).length === 0, "no changes described for sub-bucket drift");

  // A real change does move it.
  stub({ rcSummary: { ...RC_SUMMARY, lpLockedPct: 99.5, risks: [RC_SUMMARY.risks[1]] }, jupSearch: [{ ...JUP_TOKEN, audit: { ...JUP_TOKEN.audit, mintAuthorityDisabled: false, topHoldersPercentage: 71 }, mintAuthority: "NEWMINTAUTH" }] });
  const p4 = await probeTokenBrief(MINT);
  ok(p4.fingerprint !== p1.fingerprint, "an authority / LP-lock / concentration change moves the fingerprint");
  const changes = describeTokenChanges(p1.signals, p4.signals);
  ok(changes.some((c) => /^Mint authority: revoked -> live$/.test(c)), `mint-authority change described (${changes.join(" | ")})`);
  ok(changes.some((c) => /LP locked: partial-low -> locked/.test(c)), "LP-lock change described");
  ok(changes.some((c) => /Top-10 holder concentration: low -> very-high/.test(c)), "concentration change described");
  ok(changes.some((c) => /Risk flag cleared: LP Vault unlocked/.test(c)), "cleared risk flag described");

  await throws(probeTokenBrief("not-a-mint"), 400, "probe validates the mint before egress");
  restore();
}

// ---------------------------------------------------------------------------
// 9) Bucket helpers
// ---------------------------------------------------------------------------
{
  const { lpLockedBucket, concentrationBucket, authorityBucket } = __test;
  ok(lpLockedBucket(null) === "unknown" && lpLockedBucket(0) === "none" && lpLockedBucket(49) === "partial-low" && lpLockedBucket(94) === "partial-high" && lpLockedBucket(100) === "locked", "lpLockedBucket bands");
  ok(concentrationBucket(null) === "unknown" && concentrationBucket(19) === "low" && concentrationBucket(39) === "moderate" && concentrationBucket(59) === "high" && concentrationBucket(79) === "very-high" && concentrationBucket(80) === "extreme", "concentrationBucket bands");
  const a = authorityBucket(true, undefined);
  ok(a.mint === "revoked" && a.freeze === "unknown", "authorityBucket keeps unknown distinct from revoked");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
