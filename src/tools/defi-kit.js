// DeFi kit - yields, protocol TVL rankings, chain TVL, stablecoin supply,
// protocol fees/revenue and DEX volume from DefiLlama's FREE, keyless
// endpoints (yields.llama.fi, api.llama.fi, stablecoins.llama.fi).
//
// Endpoint audit (live, 2026-08-22): /pools, /chart/{pool}, /protocols,
// /v2/chains, /v2/historicalChainTvl[/{chain}], /stablecoins,
// /stablecoincharts/{all|chain}, /overview/fees[/{chain}] (+dataType=
// dailyRevenue) and /overview/dexs[/{chain}] all answer 200 with no key.
// /overview/derivatives and bridges.llama.fi/bridges answer 402 ("upgrade to
// the paid plan") and are deliberately NOT served here - no bridges tool.
//
// Payload discipline: the bulk documents are big (/pools ~11MB, /protocols
// ~8.6MB, /overview/fees ~4MB, /overview/dexs ~1.8MB, /stablecoins ~0.5MB).
// Each is fetched at most once per CACHE_TTL (5 min), parsed once, reduced
// to a TRIMMED projection (only the fields the tools serve) and kept
// in-process; concurrent cold callers share one in-flight fetch. Handlers
// filter/sort/slice the cached projection and never return more than
// MAX_ROWS rows. If a refresh fails, a stale copy up to STALE_MAX old is
// served (marked `stale: true`) so one upstream blip does not fail a paid
// call. Cold-miss latency measured 0.3-0.4s transfer + parse; the bulk
// fetch carries a 15s timeout (BULK_TIMEOUT_MS) and everything else 10s.
//
// Every handler validates inputs (400) before egress, bounds list sizes,
// maps transport timeout -> 504, upstream 5xx -> 502, 429 -> 503, "unknown
// pool/chain/protocol" -> 422, and never relays an upstream body. Output is
// compact JSON with `source` + `fetchedAt` (the upstream fetch time, which
// is the cache time when served from cache).
//
// Related existing tools (not duplicated): price-feed-kit `defi-tvl` reads
// one protocol's full history document (/protocol/{slug}); dex-kit
// `dex-top-pools` ranks DEX pools by TVL. This kit's `defi-protocol` is the
// cheap profile from the cached /protocols list (metadata, rank, mcap/tvl,
// current per-chain TVL) and `defi-yields` is the full yield screener.
//
// All tools egress -> wallet-only (register in WALLET_ONLY_SLUGS). Offline
// coverage: scripts/test-defi-kit.js (stubbed fetch, fixtures from live
// shapes, cache behaviour, filters, mapping).

const MAX_BODY_BYTES = 24 * 1024 * 1024;  // DefiLlama bulk docs run ~11MB; this is the hard ceiling.
// Refuse an over-large body BEFORE reading it into a string: `res.text()` has
// no cap of its own, so a broken or hostile upstream could push an unbounded
// buffer into memory once per concurrent call.
function assertBodyWithinCap(res, capBytes, label) {
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared && declared > capBytes) {
    const e = new Error(`${label} response is larger than the ${Math.round(capBytes / 1048576)}MB cap`);
    e.statusCode = 502; throw e;
  }
}

const TIMEOUT_MS = 10_000;
const BULK_TIMEOUT_MS = 15_000;
export const CACHE_TTL_MS = 5 * 60_000;
const STALE_MAX_MS = 30 * 60_000;
const MAX_ROWS = 100;
const MAX_POINTS = 3650;
const UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";

const YIELDS_POOLS = "https://yields.llama.fi/pools";
const YIELDS_CHART = (pool) => `https://yields.llama.fi/chart/${encodeURIComponent(pool)}`;
const PROTOCOLS = "https://api.llama.fi/protocols";
const CHAINS = "https://api.llama.fi/v2/chains";
const CHAIN_TVL = (chain) => chain ? `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}` : "https://api.llama.fi/v2/historicalChainTvl";
const STABLECOINS = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
const STABLECOIN_CHARTS = (chain) => `https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(chain || "all")}`;
const OVERVIEW_QS = "excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
const OVERVIEW = (kind, chain, dataType) =>
  `https://api.llama.fi/overview/${kind}${chain ? `/${encodeURIComponent(chain)}` : ""}?${OVERVIEW_QS}${dataType ? `&dataType=${dataType}` : ""}`;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// null/""/booleans stay null (Number(null) is 0, which would turn a missing
// apyBase into a real 0% on the wire).
const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const nowIso = () => new Date().toISOString();
const isoDay = (sec) => {
  const n = Number(sec);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString().slice(0, 10) : null;
};
const pctChange = (now, then) => (now != null && then != null && then !== 0 ? round(((now - then) / then) * 100, 4) : null);
const lower = (s) => String(s ?? "").trim().toLowerCase();

// --- input helpers ----------------------------------------------------------
function takeLimit(raw, dflt, max = MAX_ROWS) {
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`"limit" must be an integer between 1 and ${max}`);
  return n;
}

function takeNonNeg(raw, field) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw bad(`"${field}" must be a non-negative number`);
  return n;
}

function takeBool(raw, field) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  throw bad(`"${field}" must be a boolean`);
}

function takeName(raw, field, { max = 40, re = /^[A-Za-z0-9 .\-_()/&+]+$/, hint = "" } = {}) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw bad(`"${field}" must be a string${hint}`);
  const s = raw.trim();
  if (!s) return null;
  if (s.length > max || !re.test(s)) throw bad(`"${field}" must be 1-${max} chars of letters, digits, spaces or . - _ ( ) / &${hint}`);
  return s;
}

function takeSlug(raw, field, { required = false, max = 80 } = {}) {
  if (raw == null || raw === "") {
    if (required) throw bad(`"${field}" is required`);
    return null;
  }
  if (typeof raw !== "string") throw bad(`"${field}" must be a string`);
  const s = raw.trim().toLowerCase();
  if (!s) {
    if (required) throw bad(`"${field}" is required`);
    return null;
  }
  if (s.length > max || !/^[a-z0-9._-]+$/.test(s)) throw bad(`"${field}" must be a slug (lowercase letters, digits, . _ -) up to ${max} chars`);
  return s;
}

const POOL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function takePoolId(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw bad('"pool" is required (the DefiLlama pool id, a UUID from defi-yields)');
  const s = raw.trim().toLowerCase();
  if (!POOL_ID_RE.test(s)) throw bad('"pool" must be a DefiLlama pool id (UUID) as returned by defi-yields');
  return s;
}

function takeChoice(raw, field, choices, dflt) {
  if (raw == null || raw === "") return dflt;
  const s = lower(raw);
  if (!choices.includes(s)) throw bad(`"${field}" must be one of ${choices.join(", ")}`);
  return s;
}

// Chain names as DefiLlama spells them differ by dataset ("Optimism" in
// yields, "OP Mainnet" in fees/stablecoins; "BSC" vs "Binance"). Normalise a
// few common aliases so a buyer saying "optimism" or "bsc" matches either.
const CHAIN_ALIASES = {
  optimism: "optimism", "op mainnet": "optimism", op: "optimism",
  bsc: "bsc", binance: "bsc", bnb: "bsc", "bnb chain": "bsc", "binance smart chain": "bsc",
  avalanche: "avalanche", avax: "avalanche",
  gnosis: "gnosis", xdai: "gnosis",
  ethereum: "ethereum", eth: "ethereum", mainnet: "ethereum",
  polygon: "polygon", matic: "polygon",
  arbitrum: "arbitrum", "arbitrum one": "arbitrum",
  "zksync era": "zksync era", zksync: "zksync era",
  hyperliquid: "hyperliquid l1", "hyperliquid l1": "hyperliquid l1",
};
const canonChain = (s) => {
  const l = lower(s);
  return CHAIN_ALIASES[l] || l;
};
const chainMatches = (rowChain, want) => canonChain(rowChain) === canonChain(want);

// --- egress -----------------------------------------------------------------
async function rawFetch(url, { timeout = TIMEOUT_MS, label = "DefiLlama" } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    console.warn(`[defi] ${label} unreachable: ${err?.name ?? err?.code ?? err?.message}`);
    throw bad(`${label} request timed out or was unreachable`, 504);
  }
  let text = "";
  assertBodyWithinCap(res, MAX_BODY_BYTES, "Upstream");
  try { text = await res.text(); } catch { text = ""; }
  if (res.status === 429) throw bad(`${label} rate limit reached upstream - retry shortly`, 503);
  return { status: res.status, text };
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw bad("DefiLlama returned a non-JSON response", 502); }
}

// GET + decode with the standard status mapping. `notFound` (a message) turns
// 400/404 into a 422 - the shapes DefiLlama really uses for an unknown pool
// ("invalid configID!", 400) or chain (nginx 404).
async function llamaGet(url, { timeout, notFound } = {}) {
  const { status, text } = await rawFetch(url, { timeout });
  if (status === 402) throw bad("DefiLlama moved this dataset behind a paid plan - not available here", 502);
  if (status >= 500) throw bad(`DefiLlama upstream HTTP ${status} - try again later`, 502);
  if ((status === 400 || status === 404) && notFound) throw bad(notFound, 422);
  if (status >= 400) throw bad("DefiLlama refused the request", 502);
  return parseJson(text);
}

// --- cache -------------------------------------------------------------------
// key -> { value, fetchedAt, promise }. `load` returns the TRIMMED projection;
// the raw upstream document is dropped as soon as it is reduced.
const cache = new Map();

async function cached(key, load, { ttl = CACHE_TTL_MS } = {}) {
  const now = Date.now();
  const entry = cache.get(key) || {};
  if (entry.value !== undefined && now - entry.fetchedAt < ttl) {
    return { value: entry.value, fetchedAt: entry.fetchedAt, cached: true, stale: false };
  }
  if (!entry.promise) {
    entry.promise = (async () => {
      const value = await load();
      return { value, fetchedAt: Date.now() };
    })();
    cache.set(key, entry);
  }
  try {
    const fresh = await entry.promise;
    entry.value = fresh.value;
    entry.fetchedAt = fresh.fetchedAt;
    return { value: fresh.value, fetchedAt: fresh.fetchedAt, cached: false, stale: false };
  } catch (err) {
    if (entry.value !== undefined && now - entry.fetchedAt < STALE_MAX_MS) {
      console.warn(`[defi] refresh of ${key} failed (${err?.message}); serving stale copy`);
      return { value: entry.value, fetchedAt: entry.fetchedAt, cached: true, stale: true };
    }
    throw err;
  } finally {
    entry.promise = null;
  }
}

function meta(source, hit) {
  return {
    source,
    fetchedAt: new Date(hit.fetchedAt).toISOString(),
    cached: hit.cached,
    ...(hit.stale ? { stale: true } : {}),
  };
}

// --- loaders (trimmed projections) -----------------------------------------
const capList = (arr, n = 8) => (Array.isArray(arr) ? arr.slice(0, n) : []);

function trimPool(p) {
  return {
    pool: p.pool,
    chain: p.chain ?? null,
    project: p.project ?? null,
    symbol: p.symbol ?? null,
    tvlUsd: num(p.tvlUsd) ?? 0,
    apy: num(p.apy),
    apyBase: num(p.apyBase),
    apyReward: num(p.apyReward),
    apyPct1D: num(p.apyPct1D),
    apyPct7D: num(p.apyPct7D),
    apyPct30D: num(p.apyPct30D),
    apyMean30d: num(p.apyMean30d),
    stablecoin: p.stablecoin === true,
    ilRisk: p.ilRisk ?? null,
    exposure: p.exposure ?? null,
    poolMeta: typeof p.poolMeta === "string" ? p.poolMeta.slice(0, 80) : null,
    rewardTokens: capList(p.rewardTokens, 5),
    underlyingTokens: capList(p.underlyingTokens, 5),
    volumeUsd1d: num(p.volumeUsd1d),
    volumeUsd7d: num(p.volumeUsd7d),
    outlier: p.outlier === true,
    prediction: p.predictions && p.predictions.predictedClass
      ? { class: String(p.predictions.predictedClass), probability: num(p.predictions.predictedProbability) }
      : null,
  };
}

async function yieldPools() {
  return cached("pools", async () => {
    const json = await llamaGet(YIELDS_POOLS, { timeout: BULK_TIMEOUT_MS });
    if (!json || !Array.isArray(json.data)) throw bad("DefiLlama returned an unexpected response shape", 502);
    return json.data.filter((p) => p && typeof p.pool === "string").map(trimPool);
  });
}

// chainTvls on /protocols carries pseudo keys (borrowed, staking, pool2, ...)
// and per-chain suffixed variants (Base-borrowed). Only bare chain keys are
// TVL; the suffixed ones are summarised separately so they are never summed
// into TVL (that double-counts and folds in borrowed value).
const PSEUDO_TVL_KEYS = new Set(["borrowed", "staking", "pool2", "offers", "treasury", "vesting", "masterchef", "dcAndLsOverlap"]);
function splitChainTvls(obj) {
  const chains = [];
  const extras = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const n = num(v);
    if (n == null) continue;
    if (PSEUDO_TVL_KEYS.has(k)) { extras[k] = (extras[k] || 0) + n; continue; }
    const dash = k.indexOf("-");
    if (dash > 0) {
      const kind = k.slice(dash + 1);
      if (PSEUDO_TVL_KEYS.has(kind)) extras[kind] = (extras[kind] || 0) + n;
      continue;
    }
    if (n > 0) chains.push({ chain: k, tvlUsd: n });
  }
  chains.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return { chains, extras };
}

function trimProtocol(p) {
  const { chains: chainTvls, extras } = splitChainTvls(p.chainTvls);
  const tvlUsd = num(p.tvl) ?? 0;
  const mcapRaw = num(p.mcap);
  const mcap = mcapRaw != null && mcapRaw > 0 ? mcapRaw : null;
  return {
    id: p.id != null ? String(p.id) : null,
    name: p.name ?? null,
    slug: p.slug ?? null,
    category: p.category ?? null,
    chains: Array.isArray(p.chains) ? p.chains.slice(0, 40) : [],
    tvlUsd,
    change1hPct: num(p.change_1h),
    change1dPct: num(p.change_1d),
    change7dPct: num(p.change_7d),
    mcapUsd: mcap,
    mcapTvl: mcap != null && tvlUsd > 0 ? round(mcap / tvlUsd, 4) : null,
    symbol: p.symbol && p.symbol !== "-" ? String(p.symbol) : null,
    address: typeof p.address === "string" ? p.address : null,
    geckoId: p.gecko_id ?? null,
    url: typeof p.url === "string" ? p.url.slice(0, 200) : null,
    twitter: typeof p.twitter === "string" ? p.twitter : null,
    audits: num(p.audits),
    auditLinks: capList(p.audit_links, 5),
    listedAt: p.listedAt != null ? isoDay(p.listedAt) : null,
    parentProtocol: typeof p.parentProtocol === "string" ? p.parentProtocol.replace(/^parent#/, "") : null,
    description: typeof p.description === "string" ? p.description.slice(0, 280) : null,
    logo: typeof p.logo === "string" ? p.logo : null,
    chainTvls,
    borrowedUsd: extras.borrowed ?? null,
    stakingUsd: extras.staking ?? null,
    pool2Usd: extras.pool2 ?? null,
  };
}

export async function protocols() {
  return cached("protocols", async () => {
    const json = await llamaGet(PROTOCOLS, { timeout: BULK_TIMEOUT_MS });
    if (!Array.isArray(json)) throw bad("DefiLlama returned an unexpected response shape", 502);
    const rows = json.filter((p) => p && typeof p.slug === "string").map(trimProtocol);
    rows.sort((a, b) => b.tvlUsd - a.tvlUsd);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  });
}

async function chainsList() {
  return cached("chains", async () => {
    const json = await llamaGet(CHAINS);
    if (!Array.isArray(json)) throw bad("DefiLlama returned an unexpected response shape", 502);
    const rows = json
      .filter((c) => c && typeof c.name === "string")
      .map((c) => ({
        name: c.name,
        tvlUsd: num(c.tvl) ?? 0,
        tokenSymbol: c.tokenSymbol ?? null,
        chainId: num(c.chainId),
        geckoId: c.gecko_id ?? null,
      }));
    rows.sort((a, b) => b.tvlUsd - a.tvlUsd);
    return rows;
  });
}

function trimStablecoin(s) {
  const pegType = typeof s.pegType === "string" ? s.pegType : null;
  const circ = pegType ? num(s.circulating?.[pegType]) : null;
  const prevDay = pegType ? num(s.circulatingPrevDay?.[pegType]) : null;
  const prevWeek = pegType ? num(s.circulatingPrevWeek?.[pegType]) : null;
  const prevMonth = pegType ? num(s.circulatingPrevMonth?.[pegType]) : null;
  const price = num(s.price);
  // circulating is in peg units; only USD-pegged supply is USD without a price.
  const circulatingUsd = circ == null ? null : pegType === "peggedUSD" ? circ : price != null ? circ * price : null;
  const chainCirc = [];
  for (const [chain, v] of Object.entries(s.chainCirculating || {})) {
    const c = pegType ? num(v?.current?.[pegType]) : null;
    if (c != null && c > 0) chainCirc.push({ chain, circulating: c });
  }
  chainCirc.sort((a, b) => b.circulating - a.circulating);
  return {
    id: s.id != null ? String(s.id) : null,
    name: s.name ?? null,
    symbol: s.symbol ?? null,
    geckoId: s.gecko_id ?? null,
    pegType,
    pegCurrency: pegType ? pegType.replace(/^pegged/, "") : null,
    pegMechanism: s.pegMechanism === "crytpo-backed" ? "crypto-backed" : (s.pegMechanism ?? null),
    price,
    pegDeviationPct: price != null && pegType === "peggedUSD" ? round((price - 1) * 100, 4) : null,
    circulating: circ,
    circulatingUsd,
    change1dPct: pctChange(circ, prevDay),
    change7dPct: pctChange(circ, prevWeek),
    change30dPct: pctChange(circ, prevMonth),
    chainCount: chainCirc.length,
    chainCirculating: chainCirc,
  };
}

async function stablecoins() {
  return cached("stablecoins", async () => {
    const json = await llamaGet(STABLECOINS);
    if (!json || !Array.isArray(json.peggedAssets)) throw bad("DefiLlama returned an unexpected response shape", 502);
    const rows = json.peggedAssets.filter((s) => s && typeof s.name === "string").map(trimStablecoin);
    rows.sort((a, b) => (b.circulatingUsd ?? 0) - (a.circulatingUsd ?? 0));
    return rows;
  });
}

function trimOverviewRow(p) {
  return {
    name: p.displayName || p.name || null,
    slug: p.slug || p.module || null,
    category: p.category ?? null,
    protocolType: p.protocolType ?? "protocol",
    chains: capList(p.chains, 12),
    chainCount: Array.isArray(p.chains) ? p.chains.length : 0,
    total24hUsd: num(p.total24h),
    total7dUsd: num(p.total7d),
    total30dUsd: num(p.total30d),
    total1yUsd: num(p.total1y),
    totalAllTimeUsd: num(p.totalAllTime),
    change1dPct: num(p.change_1d),
    change7dPct: num(p.change_7d),
    change1mPct: num(p.change_1m),
  };
}

// /overview/{fees|dexs}[/{chain}]. The chain-scoped document is a separate
// fetch per chain; an unknown chain 500s upstream, so chain names are checked
// against the (cached) global document's allChains first.
async function overview(kind, { chain = null, dataType = null } = {}) {
  const key = `overview:${kind}:${dataType || "default"}:${chain ? canonChain(chain) : "all"}`;
  return cached(key, async () => {
    const json = await llamaGet(OVERVIEW(kind, chain, dataType), { timeout: BULK_TIMEOUT_MS });
    if (!json || !Array.isArray(json.protocols)) throw bad("DefiLlama returned an unexpected response shape", 502);
    const rows = json.protocols.filter((p) => p && (p.name || p.displayName)).map(trimOverviewRow);
    rows.sort((a, b) => (b.total24hUsd ?? 0) - (a.total24hUsd ?? 0));
    return {
      chain: json.chain ?? null,
      allChains: Array.isArray(json.allChains) ? json.allChains.slice(0, 200) : [],
      totals: {
        total24hUsd: num(json.total24h),
        total7dUsd: num(json.total7d),
        total30dUsd: num(json.total30d),
        change1dPct: num(json.change_1d),
        change7dPct: num(json.change_7d),
        change1mPct: num(json.change_1m),
      },
      rows,
    };
  });
}

async function resolveOverviewChain(kind, chain, dataType) {
  if (!chain) return null;
  const global = await overview(kind, { dataType });
  const hit = global.value.allChains.find((c) => chainMatches(c, chain));
  if (!hit) throw bad(`DefiLlama has no ${kind === "dexs" ? "DEX volume" : "fees"} data for chain "${chain}" - use a chain name as DefiLlama lists it (e.g. Ethereum, Base, Solana, Arbitrum, BSC)`, 422);
  return hit;
}

function summarisePoints(points, valueKey) {
  const vals = points.map((p) => p[valueKey]).filter((v) => v != null);
  if (!vals.length) return { latest: null, first: null, min: null, max: null, mean: null, changePct: null };
  const latest = vals[vals.length - 1];
  const first = vals[0];
  return {
    latest,
    first,
    min: Math.min(...vals),
    max: Math.max(...vals),
    mean: round(vals.reduce((a, b) => a + b, 0) / vals.length, 6),
    changePct: pctChange(latest, first),
  };
}

// --- shared overview tool builder (fees + dex volume) -----------------------
function overviewTool({ kind, slug, name, price, description, tags, sourceName, metrics, unit, example }) {
  const props = {
    chain: { type: "string", description: "Optional chain scope as DefiLlama names it (Ethereum, Base, Solana, Arbitrum, BSC, OP Mainnet...). Case-insensitive; common aliases accepted. Omit for all chains." },
    category: { type: "string", description: "Optional category filter (Dexs, Lending, Derivatives, Liquid Staking, ...). Case-insensitive exact match." },
    search: { type: "string", description: "Optional name/slug substring filter (case-insensitive)." },
    type: { type: "string", description: 'Row type: "protocol" (default), "chain" (chain-level rows such as network gas fees), or "all".' },
    limit: { type: "number", description: "Rows to return (default 25, max 100)." },
  };
  if (metrics) props.metric = { type: "string", description: `"${metrics[0]}" (default) or "${metrics[1]}".` };
  return {
    route: `POST /api/${slug}`,
    name,
    slug,
    category: "crypto",
    price,
    description,
    tags,
    discovery: {
      bodyType: "json",
      input: example.input,
      inputSchema: { properties: props, required: [] },
      output: { example: example.output },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 25);
      const chain = takeName(i.chain, "chain");
      const category = takeName(i.category, "category");
      const search = takeName(i.search, "search", { max: 60 });
      const type = takeChoice(i.type, "type", ["protocol", "chain", "all"], "protocol");
      const metric = metrics ? takeChoice(i.metric, "metric", metrics, metrics[0]) : null;
      const dataType = metric === "revenue" ? "dailyRevenue" : null;
      const scopeChain = await resolveOverviewChain(kind, chain, dataType);
      const hit = await overview(kind, { chain: scopeChain, dataType });
      let rows = hit.value.rows;
      if (type !== "all") rows = rows.filter((r) => r.protocolType === type);
      if (category) rows = rows.filter((r) => lower(r.category) === lower(category));
      if (search) {
        const s = lower(search);
        rows = rows.filter((r) => lower(r.name).includes(s) || lower(r.slug).includes(s));
      }
      const matched = rows.length;
      const out = rows.slice(0, limit).map((r, idx) => ({ rank: idx + 1, ...r }));
      return {
        ...meta(sourceName, hit),
        ...(metric ? { metric } : {}),
        unit,
        chain: scopeChain || null,
        totals: hit.value.totals,
        chains: scopeChain ? undefined : hit.value.allChains.slice(0, 40),
        matched,
        count: out.length,
        [kind === "dexs" ? "dexs" : "protocols"]: out,
      };
    },
  };
}

// =============================================================================
export const DEFI_TOOLS = [
  // ===========================================================================
  // defi-yields - yield pool screener over DefiLlama Yields (/pools).
  // ===========================================================================
  {
    route: "POST /api/defi-yields",
    name: "DeFi yield screener",
    slug: "defi-yields",
    category: "crypto",
    price: "$0.002",
    description:
      "Screen DeFi yield pools (lending, LP, staking, vaults) across every chain from DefiLlama's free Yields dataset: filter by chain, project, token symbol, stablecoin-only, minimum TVL and minimum/maximum APY; sort by apy or tvl; limit up to 100. Each row carries pool id, project, chain, symbol, TVL, total/base/reward APY, 1d/7d/30d APY change, 30d mean APY, IL risk, exposure (single/multi), reward tokens and DefiLlama's outlier flag. The ~11MB upstream document is fetched once per 5 minutes and served from an in-process cache, so answers are bounded and fast. Keyless public data.",
    tags: ["crypto", "defi", "yield", "apy", "tvl", "pools", "defillama", "screener", "stablecoin"],
    discovery: {
      bodyType: "json",
      input: { chain: "Base", stablecoinOnly: true, minTvlUsd: 1000000, sort: "apy", limit: 5 },
      inputSchema: {
        properties: {
          chain: { type: "string", description: "Chain name as DefiLlama uses it (Ethereum, Base, Arbitrum, Solana, BSC, Optimism...). Case-insensitive, common aliases accepted. Omit for all chains." },
          project: { type: "string", description: "Project slug substring (aave-v3, uniswap-v3, morpho, pendle, curve-dex...). Case-insensitive." },
          symbol: { type: "string", description: "Token symbol filter, e.g. USDC or WETH-USDC; matches any leg of the pool symbol (case-insensitive)." },
          stablecoinOnly: { type: "boolean", description: "true = only stablecoin pools." },
          minTvlUsd: { type: "number", description: "Minimum pool TVL in USD (default 10000; pass 0 for no floor)." },
          minApy: { type: "number", description: "Minimum total APY in percent." },
          maxApy: { type: "number", description: "Maximum total APY in percent (drops headline outliers)." },
          exposure: { type: "string", description: '"single" or "multi" asset exposure.' },
          excludeOutliers: { type: "boolean", description: "Drop pools DefiLlama flags as APY outliers (default true)." },
          sort: { type: "string", description: '"tvl" (default) or "apy", descending.' },
          limit: { type: "number", description: "Rows to return (default 20, max 100)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-yields", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true,
          filters: { chain: "Base", project: null, symbol: null, stablecoinOnly: true, minTvlUsd: 1000000, minApy: null, maxApy: null, exposure: null, excludeOutliers: true },
          sort: "apy", matched: 42, count: 1,
          pools: [{ pool: "54e9b138-3146-4c1f-8dce-1cb948f5ef96", chain: "Base", project: "morpho-v1", symbol: "USDC", tvlUsd: 25000000, apy: 6.1, apyBase: 4.9, apyReward: 1.2, apyPct1D: -0.04, apyPct7D: 0.5, apyPct30D: -0.05, apyMean30d: 5.8, stablecoin: true, ilRisk: "no", exposure: "single", poolMeta: null, rewardTokens: [], underlyingTokens: ["0x8335..."], volumeUsd1d: null, volumeUsd7d: null, outlier: false, prediction: { class: "Stable/Up", probability: 67 } }],
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 20);
      const chain = takeName(i.chain, "chain");
      const project = takeSlug(i.project, "project");
      const symbol = takeName(i.symbol, "symbol", { max: 40, re: /^[A-Za-z0-9 .\-_/+]+$/ });
      const stablecoinOnly = takeBool(i.stablecoinOnly, "stablecoinOnly") === true;
      const minTvlRaw = takeNonNeg(i.minTvlUsd, "minTvlUsd");
      const minTvlUsd = minTvlRaw == null ? 10_000 : minTvlRaw;
      const minApy = takeNonNeg(i.minApy, "minApy");
      const maxApy = takeNonNeg(i.maxApy, "maxApy");
      if (minApy != null && maxApy != null && maxApy < minApy) throw bad('"maxApy" must be >= "minApy"');
      const exposure = takeChoice(i.exposure, "exposure", ["single", "multi"], null);
      const excludeOutliers = takeBool(i.excludeOutliers, "excludeOutliers") !== false;
      const sort = takeChoice(i.sort, "sort", ["tvl", "apy"], "tvl");

      const hit = await yieldPools();
      const symParts = symbol ? lower(symbol).split(/[-/ ]+/).filter(Boolean) : [];
      let rows = hit.value;
      if (chain) rows = rows.filter((p) => chainMatches(p.chain, chain));
      if (project) rows = rows.filter((p) => lower(p.project).includes(project));
      if (symParts.length) {
        rows = rows.filter((p) => {
          const legs = lower(p.symbol).split(/[-/ ]+/);
          return symParts.every((s) => legs.includes(s));
        });
      }
      if (stablecoinOnly) rows = rows.filter((p) => p.stablecoin);
      if (minTvlUsd > 0) rows = rows.filter((p) => p.tvlUsd >= minTvlUsd);
      if (minApy != null) rows = rows.filter((p) => p.apy != null && p.apy >= minApy);
      if (maxApy != null) rows = rows.filter((p) => p.apy != null && p.apy <= maxApy);
      if (exposure) rows = rows.filter((p) => p.exposure === exposure);
      if (excludeOutliers) rows = rows.filter((p) => !p.outlier);
      const matched = rows.length;
      const sorted = [...rows].sort((a, b) => (sort === "apy" ? (b.apy ?? -Infinity) - (a.apy ?? -Infinity) : b.tvlUsd - a.tvlUsd));
      const out = sorted.slice(0, limit);
      return {
        ...meta("defillama-yields", hit),
        filters: { chain, project, symbol, stablecoinOnly, minTvlUsd, minApy, maxApy, exposure, excludeOutliers },
        sort,
        matched,
        count: out.length,
        pools: out,
      };
    },
  },

  // ===========================================================================
  // defi-yield-history - one pool's APY / TVL history (/chart/{pool}).
  // ===========================================================================
  {
    route: "POST /api/defi-yield-history",
    name: "DeFi yield pool history",
    slug: "defi-yield-history",
    category: "crypto",
    price: "$0.002",
    description:
      "Daily APY and TVL history for one DeFi yield pool (DefiLlama pool id from defi-yields): per-day total/base/reward APY and TVL, most recent `limit` days (default 90, max 3650), plus a summary (latest, min, max, mean APY and TVL change over the window). Unknown pool ids answer 422. Keyless public data.",
    tags: ["crypto", "defi", "yield", "apy", "history", "tvl", "defillama", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { pool: "54e9b138-3146-4c1f-8dce-1cb948f5ef96", limit: 7 },
      inputSchema: {
        properties: {
          pool: { type: "string", description: "DefiLlama pool id (UUID) as returned by defi-yields." },
          limit: { type: "number", description: "Most recent days to return (default 90, max 3650)." },
        },
        required: ["pool"],
      },
      output: {
        example: {
          source: "defillama-yields", fetchedAt: "2026-08-22T12:00:00.000Z",
          pool: "54e9b138-3146-4c1f-8dce-1cb948f5ef96", totalPoints: 170, count: 2,
          summary: { apy: { latest: 3.51, first: 3.9, min: 3.2, max: 3.9, mean: 3.6, changePct: -10 }, tvlUsd: { latest: 546610322, first: 579045934, min: 540000000, max: 580000000, mean: 560000000, changePct: -5.6 } },
          points: [{ date: "2026-08-21", tvlUsd: 548000000, apy: 3.6, apyBase: null, apyReward: 3.6 }, { date: "2026-08-22", tvlUsd: 546610322, apy: 3.51, apyBase: null, apyReward: 3.51 }],
        },
      },
    },
    handler: async (i = {}) => {
      const pool = takePoolId(i.pool);
      const limit = takeLimit(i.limit, 90, MAX_POINTS);
      const json = await llamaGet(YIELDS_CHART(pool), { notFound: "DefiLlama has no yield pool with that id" });
      if (!json || !Array.isArray(json.data)) throw bad("DefiLlama returned an unexpected response shape", 502);
      if (!json.data.length) throw bad("DefiLlama has no yield pool with that id", 422);
      const all = json.data
        .filter((p) => p && p.timestamp)
        .map((p) => ({
          date: String(p.timestamp).slice(0, 10),
          tvlUsd: num(p.tvlUsd),
          apy: num(p.apy),
          apyBase: num(p.apyBase),
          apyReward: num(p.apyReward),
        }));
      const points = all.slice(-limit);
      return {
        source: "defillama-yields",
        fetchedAt: nowIso(),
        pool,
        totalPoints: all.length,
        count: points.length,
        summary: { apy: summarisePoints(points, "apy"), tvlUsd: summarisePoints(points, "tvlUsd") },
        points,
      };
    },
  },

  // ===========================================================================
  // defi-protocols - protocols ranked by TVL (/protocols, cached).
  // ===========================================================================
  {
    route: "POST /api/defi-protocols",
    name: "DeFi protocols ranked by TVL",
    slug: "defi-protocols",
    category: "crypto",
    price: "$0.002",
    description:
      "DeFi protocols ranked by current TVL from DefiLlama's free protocol list: filter by category (Lending, Dexs, Liquid Staking, CDP, Yield...), chain (ranks by that chain's TVL), or a name search; limit up to 100. Rows carry global rank, name, slug, category, chains, TVL, 1h/1d/7d TVL change, market cap and mcap/TVL. CEX rows are excluded unless category is CEX or includeCex is true. The ~8.6MB upstream document is cached 5 minutes in-process. Keyless public data.",
    tags: ["crypto", "defi", "tvl", "protocols", "ranking", "defillama", "lending", "dex"],
    discovery: {
      bodyType: "json",
      input: { category: "Lending", limit: 5 },
      inputSchema: {
        properties: {
          category: { type: "string", description: "Category filter (Lending, Dexs, Liquid Staking, Restaking, CDP, Yield, Derivatives, Bridge, RWA, CEX...). Case-insensitive exact match." },
          chain: { type: "string", description: "Chain filter as DefiLlama names it (Ethereum, Base, Solana, Arbitrum...). Rows are then ranked by TVL on that chain." },
          search: { type: "string", description: "Name/slug substring filter (case-insensitive)." },
          includeCex: { type: "boolean", description: "Include centralized-exchange reserve rows (default false)." },
          minTvlUsd: { type: "number", description: "Minimum TVL in USD." },
          limit: { type: "number", description: "Rows to return (default 25, max 100)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-protocols", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true,
          filters: { category: "Lending", chain: null, search: null, includeCex: false, minTvlUsd: null },
          totalTvlUsd: 48000000000, matched: 600, count: 1,
          protocols: [{ rank: 3, name: "Aave V3", slug: "aave-v3", category: "Lending", chains: ["Ethereum", "Base", "Arbitrum"], chainCount: 21, tvlUsd: 17023522168, change1hPct: 0.02, change1dPct: 0.8, change7dPct: 2.4, mcapUsd: 3200000000, mcapTvl: 0.188, symbol: "AAVE", parentProtocol: "aave" }],
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 25);
      const category = takeName(i.category, "category");
      const chain = takeName(i.chain, "chain");
      const search = takeName(i.search, "search", { max: 60 });
      const includeCex = takeBool(i.includeCex, "includeCex") === true;
      const minTvlUsd = takeNonNeg(i.minTvlUsd, "minTvlUsd");

      const hit = await protocols();
      let rows = hit.value;
      if (category) rows = rows.filter((p) => lower(p.category) === lower(category));
      else if (!includeCex) rows = rows.filter((p) => p.category !== "CEX");
      if (search) {
        const s = lower(search);
        rows = rows.filter((p) => lower(p.name).includes(s) || lower(p.slug).includes(s));
      }
      let chainName = null;
      let scored = rows.map((p) => ({ p, v: p.tvlUsd }));
      if (chain) {
        scored = [];
        for (const p of rows) {
          const ct = p.chainTvls.find((c) => chainMatches(c.chain, chain));
          if (ct) { chainName = chainName || ct.chain; scored.push({ p, v: ct.tvlUsd }); }
        }
        scored.sort((a, b) => b.v - a.v);
      }
      if (minTvlUsd != null) scored = scored.filter((x) => x.v >= minTvlUsd);
      const matched = scored.length;
      const totalTvlUsd = round(scored.reduce((a, x) => a + x.v, 0), 2);
      const out = scored.slice(0, limit).map(({ p, v }) => ({
        rank: p.rank,
        name: p.name,
        slug: p.slug,
        category: p.category,
        chains: p.chains.slice(0, 8),
        chainCount: p.chains.length,
        tvlUsd: p.tvlUsd,
        ...(chain ? { chainTvlUsd: v } : {}),
        change1hPct: p.change1hPct,
        change1dPct: p.change1dPct,
        change7dPct: p.change7dPct,
        mcapUsd: p.mcapUsd,
        mcapTvl: p.mcapTvl,
        symbol: p.symbol,
        parentProtocol: p.parentProtocol,
      }));
      return {
        ...meta("defillama-protocols", hit),
        filters: { category, chain: chainName || chain || null, search, includeCex, minTvlUsd },
        totalTvlUsd,
        matched,
        count: out.length,
        protocols: out,
      };
    },
  },

  // ===========================================================================
  // defi-protocol - one protocol's profile from the cached /protocols list.
  // ===========================================================================
  {
    route: "POST /api/defi-protocol",
    name: "DeFi protocol profile",
    slug: "defi-protocol",
    category: "crypto",
    price: "$0.002",
    description:
      "Profile of one DeFi protocol by DefiLlama slug (aave-v3, uniswap-v3, lido, morpho-v1...): TVL rank among all protocols, category, chains, current TVL by chain (borrowed/staking/pool2 reported separately, never summed into TVL), 1h/1d/7d TVL change, market cap and mcap/TVL, token symbol + address, website, X handle, audit count/links, listing date and parent protocol. Unknown slugs answer 422 with up to 5 name suggestions. Served from the cached protocol list (no per-protocol history fetch; use defi-tvl for a protocol's full TVL history). Keyless public data.",
    tags: ["crypto", "defi", "protocol", "tvl", "mcap", "defillama", "profile"],
    discovery: {
      bodyType: "json",
      input: { protocol: "aave-v3" },
      inputSchema: {
        properties: {
          protocol: { type: "string", description: "DefiLlama protocol slug (lowercase, hyphenated), e.g. aave-v3, uniswap-v3, lido, morpho-v1." },
        },
        required: ["protocol"],
      },
      output: {
        example: {
          source: "defillama-protocols", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true,
          protocol: { rank: 3, name: "Aave V3", slug: "aave-v3", category: "Lending", chains: ["Ethereum", "Base"], chainCount: 21, tvlUsd: 17023522168, change1hPct: 0.02, change1dPct: 0.8, change7dPct: 2.4, mcapUsd: 3200000000, mcapTvl: 0.188, symbol: "AAVE", address: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", geckoId: null, url: "https://aave.com", twitter: "aave", audits: 2, auditLinks: ["https://aave.com/security"], listedAt: "2022-04-01", parentProtocol: "aave", description: "Earn interest, borrow assets, and build applications", logo: "https://icons.llamao.fi/icons/protocols/aave-v3", chainTvls: [{ chain: "Ethereum", tvlUsd: 12000000000 }], borrowedUsd: 9000000000, stakingUsd: null, pool2Usd: null },
        },
      },
    },
    handler: async (i = {}) => {
      const slug = takeSlug(i.protocol, "protocol", { required: true });
      const hit = await protocols();
      const p = hit.value.find((r) => r.slug === slug);
      if (!p) {
        const s = slug.replace(/-/g, " ");
        const suggestions = hit.value
          .filter((r) => lower(r.name).includes(s) || r.slug.includes(slug))
          .slice(0, 5)
          .map((r) => r.slug);
        throw bad(`DefiLlama lists no protocol with slug "${slug}"${suggestions.length ? ` - did you mean: ${suggestions.join(", ")}` : ""}`, 422);
      }
      const { rank, ...rest } = p;
      return {
        ...meta("defillama-protocols", hit),
        protocol: { rank, ...rest, chains: p.chains.slice(0, 40), chainCount: p.chains.length, chainTvls: p.chainTvls.slice(0, 40) },
      };
    },
  },

  // ===========================================================================
  // defi-chains - chains ranked by TVL (/v2/chains).
  // ===========================================================================
  {
    route: "POST /api/defi-chains",
    name: "DeFi TVL by chain",
    slug: "defi-chains",
    category: "crypto",
    price: "$0.002",
    description:
      "Blockchains ranked by DeFi TVL from DefiLlama's free chain list: name, TVL in USD, share of total DeFi TVL, native token symbol, EVM chain id and CoinGecko id; optional name search and minimum TVL; limit up to 100 (default 25). Totals carry the all-chain TVL and chain count. Keyless public data.",
    tags: ["crypto", "defi", "tvl", "chains", "ranking", "defillama", "l1", "l2"],
    discovery: {
      bodyType: "json",
      input: { limit: 5 },
      inputSchema: {
        properties: {
          search: { type: "string", description: "Chain name substring (case-insensitive)." },
          minTvlUsd: { type: "number", description: "Minimum chain TVL in USD." },
          limit: { type: "number", description: "Rows to return (default 25, max 100)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-chains", fetchedAt: "2026-08-22T12:00:00.000Z", cached: false,
          totals: { totalTvlUsd: 120000000000, chainCount: 462 }, matched: 462, count: 1,
          chains: [{ rank: 1, name: "Ethereum", tvlUsd: 70000000000, sharePct: 58.3, tokenSymbol: "ETH", chainId: 1, geckoId: "ethereum" }],
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 25);
      const search = takeName(i.search, "search");
      const minTvlUsd = takeNonNeg(i.minTvlUsd, "minTvlUsd");
      const hit = await chainsList();
      const all = hit.value;
      const totalTvlUsd = all.reduce((a, c) => a + c.tvlUsd, 0);
      let rows = all.map((c, idx) => ({ rank: idx + 1, ...c, sharePct: totalTvlUsd > 0 ? round((c.tvlUsd / totalTvlUsd) * 100, 4) : null }));
      if (search) {
        const s = lower(search);
        rows = rows.filter((c) => lower(c.name).includes(s) || chainMatches(c.name, search));
      }
      if (minTvlUsd != null) rows = rows.filter((c) => c.tvlUsd >= minTvlUsd);
      const out = rows.slice(0, limit);
      return {
        ...meta("defillama-chains", hit),
        totals: { totalTvlUsd: round(totalTvlUsd, 2), chainCount: all.length },
        matched: rows.length,
        count: out.length,
        chains: out,
      };
    },
  },

  // ===========================================================================
  // defi-chain-tvl-history - daily TVL series for a chain or all of DeFi.
  // ===========================================================================
  {
    route: "POST /api/defi-chain-tvl-history",
    name: "DeFi chain TVL history",
    slug: "defi-chain-tvl-history",
    category: "crypto",
    price: "$0.002",
    description:
      "Daily TVL history for one chain (Ethereum, Base, Solana, Arbitrum...) or for all of DeFi (chain \"all\") from DefiLlama's free historical chain TVL endpoint: most recent `days` points (default 90, max 3650) as date + TVL in USD, with a summary (latest, first, min, max, mean, change over the window). Unknown chains answer 422. Keyless public data.",
    tags: ["crypto", "defi", "tvl", "history", "chain", "defillama", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { chain: "Base", days: 7 },
      inputSchema: {
        properties: {
          chain: { type: "string", description: 'Chain name as DefiLlama spells it (Ethereum, Base, Solana, Arbitrum, Optimism, BSC...) or "all" for total DeFi TVL. Default "all".' },
          days: { type: "number", description: "Most recent days to return (default 90, max 3650)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-chain-tvl", fetchedAt: "2026-08-22T12:00:00.000Z",
          chain: "Base", totalPoints: 1165, count: 2,
          summary: { latest: 5432285625, first: 5242607753, min: 5242607753, max: 5432285625, mean: 5337446689, changePct: 3.6 },
          points: [{ date: "2026-08-21", tvlUsd: 5242607753 }, { date: "2026-08-22", tvlUsd: 5432285625 }],
        },
      },
    },
    handler: async (i = {}) => {
      const days = takeLimit(i.days ?? i.limit, 90, MAX_POINTS);
      const chainRaw = takeName(i.chain, "chain");
      const isAll = !chainRaw || lower(chainRaw) === "all";
      // Resolve the chain's canonical spelling from the (cached) chain list so
      // "base" and "optimism" reach the endpoint as DefiLlama names them.
      let chain = null;
      if (!isAll) {
        const list = await chainsList();
        const found = list.value.find((c) => chainMatches(c.name, chainRaw)) || list.value.find((c) => lower(c.name) === lower(chainRaw));
        if (!found) throw bad(`DefiLlama lists no chain "${chainRaw}" - use a chain name as DefiLlama spells it (e.g. Ethereum, Base, Solana, Arbitrum) or "all"`, 422);
        chain = found.name;
      }
      const json = await llamaGet(CHAIN_TVL(chain), { notFound: `DefiLlama has no TVL history for chain "${chainRaw}"` });
      if (!Array.isArray(json)) throw bad("DefiLlama returned an unexpected response shape", 502);
      const all = json
        .filter((p) => p && p.date != null)
        .map((p) => ({ date: isoDay(p.date), tvlUsd: num(p.tvl) }))
        .filter((p) => p.date);
      const points = all.slice(-days);
      return {
        source: "defillama-chain-tvl",
        fetchedAt: nowIso(),
        chain: chain || "all",
        totalPoints: all.length,
        count: points.length,
        summary: summarisePoints(points, "tvlUsd"),
        points,
      };
    },
  },

  // ===========================================================================
  // stablecoins - circulating supply by asset (/stablecoins).
  // ===========================================================================
  {
    route: "POST /api/stablecoins",
    name: "Stablecoin supply by asset",
    slug: "stablecoins", aliases: ["stablecoin-supply-by-asset", "stablecoin-supply"],
    category: "crypto",
    price: "$0.003",
    description:
      "Stablecoins ranked by circulating supply from DefiLlama's free stablecoin dataset: name, symbol, peg currency and type (USD, EUR, JPY, VAR...), peg mechanism (fiat-backed, crypto-backed, algorithmic), current price and USD peg deviation, circulating supply in peg units and USD, 1d/7d/30d supply change, and per-chain circulation (top chains + count). Filter by peg currency, mechanism, chain (then ranked by supply on that chain) or a name/symbol search; limit up to 100. Totals carry matched circulating USD. Keyless public data.",
    tags: ["crypto", "stablecoin", "supply", "circulating", "usdt", "usdc", "defillama", "peg"],
    discovery: {
      bodyType: "json",
      input: { peg: "USD", limit: 5 },
      inputSchema: {
        properties: {
          peg: { type: "string", description: 'Peg currency filter: USD (default), EUR, JPY, GBP, CHF, VAR, ... or "all".' },
          mechanism: { type: "string", description: '"fiat-backed", "crypto-backed" or "algorithmic".' },
          chain: { type: "string", description: "Chain filter as DefiLlama names it (Ethereum, Tron, Solana, Base, BSC, Arbitrum...). Rows are then ranked by circulation on that chain." },
          search: { type: "string", description: "Name/symbol substring filter (case-insensitive)." },
          limit: { type: "number", description: "Rows to return (default 20, max 100)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-stablecoins", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true,
          filters: { peg: "USD", mechanism: null, chain: null, search: null },
          totals: { circulatingUsd: 307000000000, assetCount: 300 }, matched: 300, count: 1,
          stablecoins: [{ rank: 1, id: "1", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", pegCurrency: "USD", pegMechanism: "fiat-backed", price: 0.9998, pegDeviationPct: -0.02, circulating: 183181226868, circulatingUsd: 183181226868, change1dPct: 0.08, change7dPct: 0.01, change30dPct: 0.01, chainCount: 120, chains: [{ chain: "Tron", circulating: 90000000000 }] }],
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 20);
      const pegRaw = takeName(i.peg ?? i.pegType, "peg", { max: 12, re: /^[A-Za-z]+$/ });
      const peg = pegRaw == null ? "USD" : lower(pegRaw) === "all" ? null : pegRaw.replace(/^pegged/i, "").toUpperCase();
      const mechanism = takeChoice(i.mechanism, "mechanism", ["fiat-backed", "crypto-backed", "algorithmic"], null);
      const chain = takeName(i.chain, "chain");
      const search = takeName(i.search, "search", { max: 60 });

      const hit = await stablecoins();
      let rows = hit.value;
      if (peg) rows = rows.filter((s) => s.pegCurrency && s.pegCurrency.toUpperCase() === peg);
      if (mechanism) rows = rows.filter((s) => s.pegMechanism === mechanism);
      if (search) {
        const q = lower(search);
        rows = rows.filter((s) => lower(s.name).includes(q) || lower(s.symbol).includes(q));
      }
      let chainName = null;
      let scored = rows.map((s) => ({ s, onChain: null }));
      if (chain) {
        scored = [];
        for (const s of rows) {
          const c = s.chainCirculating.find((x) => chainMatches(x.chain, chain));
          if (c) { chainName = chainName || c.chain; scored.push({ s, onChain: c.circulating }); }
        }
        scored.sort((a, b) => b.onChain - a.onChain);
      }
      const matched = scored.length;
      const circulatingUsd = round(scored.reduce((a, x) => a + (x.s.circulatingUsd ?? 0), 0), 2);
      const out = scored.slice(0, limit).map(({ s, onChain }, idx) => {
        const { chainCirculating, ...rest } = s;
        return {
          rank: idx + 1,
          ...rest,
          ...(chain ? { chainCirculating: onChain } : {}),
          chains: chainCirculating.slice(0, 8),
        };
      });
      return {
        ...meta("defillama-stablecoins", hit),
        filters: { peg, mechanism, chain: chainName || chain || null, search },
        totals: { circulatingUsd, assetCount: matched },
        matched,
        count: out.length,
        stablecoins: out,
      };
    },
  },

  // ===========================================================================
  // stablecoin-supply-history - total circulating over time (/stablecoincharts).
  // ===========================================================================
  {
    route: "POST /api/stablecoin-supply-history",
    name: "Stablecoin supply history",
    slug: "stablecoin-supply-history",
    category: "crypto",
    price: "$0.002",
    description:
      "Daily total stablecoin circulating supply (in USD) over time from DefiLlama's free stablecoin charts, for all chains or one chain (Ethereum, Tron, Solana, Base...): most recent `days` points (default 90, max 3650) for a peg currency (USD default; EUR, JPY, ... or all pegs summed), with a summary (latest, first, min, max, mean, change over the window). Unknown chains answer 422. Keyless public data.",
    tags: ["crypto", "stablecoin", "supply", "history", "defillama", "timeseries", "usd"],
    discovery: {
      bodyType: "json",
      input: { chain: "all", days: 7 },
      inputSchema: {
        properties: {
          chain: { type: "string", description: 'Chain name as DefiLlama spells it, or "all" (default).' },
          peg: { type: "string", description: 'Peg currency: USD (default), EUR, JPY, ... or "all" to sum every peg in USD.' },
          days: { type: "number", description: "Most recent days to return (default 90, max 3650)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-stablecoins", fetchedAt: "2026-08-22T12:00:00.000Z",
          chain: "all", peg: "USD", totalPoints: 3189, count: 2,
          summary: { latest: 308487484274, first: 307734935324, min: 307734935324, max: 308487484274, mean: 308111209799, changePct: 0.24 },
          points: [{ date: "2026-08-21", circulatingUsd: 307734935324 }, { date: "2026-08-22", circulatingUsd: 308487484274 }],
        },
      },
    },
    handler: async (i = {}) => {
      const days = takeLimit(i.days ?? i.limit, 90, MAX_POINTS);
      const chainRaw = takeName(i.chain, "chain");
      const isAll = !chainRaw || lower(chainRaw) === "all";
      const pegRaw = takeName(i.peg ?? i.pegType, "peg", { max: 12, re: /^[A-Za-z]+$/ });
      const peg = pegRaw == null ? "USD" : lower(pegRaw) === "all" ? null : pegRaw.replace(/^pegged/i, "").toUpperCase();
      const pegKey = peg ? `pegged${peg}` : null;
      let chain = null;
      if (!isAll) {
        // Canonical spelling from the cached stablecoin chain list ("OP Mainnet", "BSC").
        const list = await stablecoins();
        const names = new Set();
        for (const s of list.value) for (const c of s.chainCirculating) names.add(c.chain);
        chain = [...names].find((n) => chainMatches(n, chainRaw)) || null;
        if (!chain) throw bad(`DefiLlama has no stablecoin data for chain "${chainRaw}" - use a chain name as DefiLlama spells it (e.g. Ethereum, Tron, Solana, Base) or "all"`, 422);
      }
      const json = await llamaGet(STABLECOIN_CHARTS(chain), { notFound: `DefiLlama has no stablecoin history for chain "${chainRaw}"` });
      if (!Array.isArray(json)) throw bad("DefiLlama returned an unexpected response shape", 502);
      const all = json
        .filter((p) => p && p.date != null && p.totalCirculatingUSD)
        .map((p) => {
          const t = p.totalCirculatingUSD;
          const v = pegKey ? num(t[pegKey]) : Object.values(t).reduce((a, x) => a + (num(x) ?? 0), 0);
          return { date: isoDay(p.date), circulatingUsd: v == null ? null : round(v, 2) };
        })
        .filter((p) => p.date);
      const points = all.slice(-days);
      return {
        source: "defillama-stablecoins",
        fetchedAt: nowIso(),
        chain: chain || "all",
        peg: peg || "all",
        totalPoints: all.length,
        count: points.length,
        summary: summarisePoints(points, "circulatingUsd"),
        points,
      };
    },
  },

  // ===========================================================================
  // defi-fees - protocol fees / revenue ranking (/overview/fees, free).
  // ===========================================================================
  overviewTool({
    kind: "fees",
    slug: "defi-fees",
    name: "DeFi protocol fees and revenue",
    price: "$0.002",
    description:
      "Protocols ranked by fees paid by users (or by protocol revenue with metric \"revenue\") over the last 24h from DefiLlama's free fees overview: per-protocol 24h/7d/30d/1y/all-time totals with 1d/7d/30d change, category and chains; optional chain scope, category filter and name search; chain-level rows (network gas fees) via type \"chain\"; sector totals. limit up to 100. Keyless public data.",
    tags: ["crypto", "defi", "fees", "revenue", "protocols", "ranking", "defillama"],
    sourceName: "defillama-fees",
    metrics: ["fees", "revenue"],
    unit: "USD",
    example: {
      input: { metric: "fees", limit: 5 },
      output: {
        source: "defillama-fees", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true, metric: "fees", unit: "USD", chain: null,
        totals: { total24hUsd: 75393517, total7dUsd: 423480844, total30dUsd: 1800000000, change1dPct: 6.68, change7dPct: 2.1, change1mPct: 10.2 },
        chains: ["Solana", "Ethereum", "Base"], matched: 2500, count: 1,
        protocols: [{ rank: 1, name: "Tether", slug: "tether", category: "Stablecoin Issuer", protocolType: "protocol", chains: ["Ethereum"], chainCount: 1, total24hUsd: 15900806, total7dUsd: 111368600, total30dUsd: 481404902, total1yUsd: 5800000000, totalAllTimeUsd: 20000000000, change1dPct: 0, change7dPct: -0.03, change1mPct: 1.2 }],
      },
    },
  }),

  // ===========================================================================
  // defi-dex-volume - DEX volume ranking (/overview/dexs, free).
  // ===========================================================================
  overviewTool({
    kind: "dexs",
    slug: "defi-dex-volume",
    name: "DEX volume by protocol",
    price: "$0.001",
    description:
      "Decentralized exchanges ranked by 24h spot trading volume from DefiLlama's free DEX overview: per-DEX 24h/7d/30d/1y/all-time volume with 1d/7d/30d change, category and chains; optional chain scope (Ethereum, Base, Solana, Arbitrum...), category filter and name search; sector totals and the list of chains with DEX volume. limit up to 100. Keyless public data.",
    tags: ["crypto", "defi", "dex", "volume", "trading", "ranking", "defillama", "uniswap"],
    sourceName: "defillama-dexs",
    metrics: null,
    unit: "USD",
    example: {
      input: { chain: "Base", limit: 5 },
      output: {
        source: "defillama-dexs", fetchedAt: "2026-08-22T12:00:00.000Z", cached: true, unit: "USD", chain: "Base",
        totals: { total24hUsd: 1200000000, total7dUsd: 9000000000, total30dUsd: 40000000000, change1dPct: -3.1, change7dPct: 4.2, change1mPct: 11 },
        matched: 60, count: 1,
        dexs: [{ rank: 1, name: "Aerodrome Slipstream", slug: "aerodrome-slipstream", category: "Dexs", protocolType: "protocol", chains: ["Base"], chainCount: 1, total24hUsd: 600000000, total7dUsd: 4500000000, total30dUsd: 20000000000, total1yUsd: 250000000000, totalAllTimeUsd: 400000000000, change1dPct: -2.5, change7dPct: 3.9, change1mPct: 9.8 }],
      },
    },
  }),
];

// Exported for the offline test: endpoint constants, the cache (so tests can
// reset it and observe hits), and the pure helpers.
export const __test = {
  YIELDS_POOLS, YIELDS_CHART, PROTOCOLS, CHAINS, CHAIN_TVL, STABLECOINS, STABLECOIN_CHARTS, OVERVIEW,
  CACHE_TTL_MS, STALE_MAX_MS, BULK_TIMEOUT_MS, TIMEOUT_MS,
  resetCache: () => cache.clear(),
  cacheKeys: () => [...cache.keys()],
  ageCache: (key, ms) => { const e = cache.get(key); if (e) e.fetchedAt -= ms; },
  chainMatches, canonChain, splitChainTvls, trimPool, trimProtocol, trimStablecoin, trimOverviewRow, summarisePoints,
};
