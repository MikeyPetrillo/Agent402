// token-risk-kit — Token & Contract Risk Report. Hand over a token contract
// address (and chain) and get one evidence-based on-chain risk assessment:
// source-code verification, holder concentration (top-1 / top-10 share of
// supply, distinguishing contracts/pools from EOAs), supply and market context,
// and (pro) a deterministic static-pattern scan of the verified source plus a
// web reputation check. Agent-facing (crypto/x402/MPP), for the trading agents
// and desks already on the marketplace.
//
// HONESTY IS THE PRODUCT: this reports EVIDENCE from on-chain signals and NEVER
// a "safe"/"scam" verdict. On-chain checks cannot detect off-chain rug
// mechanisms, social-engineering scams, or future malicious upgrades, and a
// clean report is not an endorsement. The synthesis prompt enforces this framing.
//
// Every probe is keyless and read in-process: GoPlus token_security (name,
// symbol, total supply, holder count and the top holders with their share of
// supply, plus the control-plane flags), DexScreener pairs (price, liquidity,
// volume), and Sourcify through contract-source / contract-abi, with
// solidity-scan as a local ruleset. Nothing is bought per call except the
// synthesis. Settlement-safe (throws >=400 on total failure), WALLET_ONLY, not
// cached. Synthesis gated on OPENROUTER_API_KEY.
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { CONTRACT_TOOLS } from "./contract-kit.js";

// Keyless control-plane facts the report used to disclaim as "not visible
// here": GoPlus token_security (honeypot, proxy, mintable, hidden owner, taxes,
// pausable, blacklist, LP holders, DEX liquidity) and DexScreener pairs, plus
// the Sourcify ABI (the privileged function names ARE the owner privileges).
// Measured on BRETT/Base 2026-08-26: every field below answered.
// Celo (42220) is NOT here, and that is the whole list's rule: an advertised
// chain must be one the token-security probe actually serves. GoPlus answers
// code 2022 "The main chain is not supported" for it, and since that probe
// became the only source of supply and holders every Celo call could only
// refuse. It was advertised while the explorer legs carried it, and left with
// them on 2026-09-22. bsc arrived the same day - it was never in the explorer
// map and GoPlus serves it. The three maps below are pinned equal in
// scripts/test-report-inputs.js so a chain can never be offered by one and
// missing from another.
export const GOPLUS_CHAIN_IDS = { base: 8453, ethereum: 1, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, gnosis: 100 };
export const DEXSCREENER_CHAINS = { base: "base", ethereum: "ethereum", polygon: "polygon", arbitrum: "arbitrum", optimism: "optimism", bsc: "bsc", gnosis: "gnosischain" };
const KEYLESS_TIMEOUT_MS = 12_000;
// A non-2xx from a keyless probe is a fact about the SOURCE, never about the
// caller's token: both probes answer 200 with an empty result when they hold
// no record, so there is no status here that means "your address is wrong".
// 422 is reserved for that answer and minted only where it is read.
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KEYLESS_TIMEOUT_MS) });
  if (!res.ok) throw bad(`upstream HTTP ${res.status}`, res.status === 429 ? 503 : 502);
  return res.json();
}
const flag = (v) => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : null);
export async function probeGoPlus({ chain, address }) {
  const id = GOPLUS_CHAIN_IDS[chain];
  if (!id) throw bad(`GoPlus does not cover ${chain}`, 422);
  const j = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address.toLowerCase()}`);
  const r = j?.result?.[address.toLowerCase()] || Object.values(j?.result || {})[0];
  if (!r) throw bad("GoPlus has no record for this token", 422);
  return shapeGoPlus(r);
}
export function shapeGoPlus(r) {
  const num = (v) => (v == null || v === "" ? null : Number(v));
  // GoPlus lists a token's top holders (up to 10) with `percent` as a fraction
  // of total supply; the report reads concentration from these rows.
  const pctOf = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e4);
  return {
    tokenName: r.token_name || null, tokenSymbol: r.token_symbol || null,
    totalSupply: r.total_supply == null || r.total_supply === "" ? null : String(r.total_supply),
    topHolders: Array.isArray(r.holders) ? r.holders.slice(0, 10).map((h) => ({ address: h.address || null, tag: h.tag || null, isContract: flag(h.is_contract), percent: pctOf(h.percent), locked: flag(h.is_locked) })) : [],
    openSource: flag(r.is_open_source), proxy: flag(r.is_proxy), mintable: flag(r.is_mintable), honeypot: flag(r.is_honeypot),
    ownerAddress: r.owner_address || null, ownerRenounced: /^0x0{40}$/i.test(String(r.owner_address || "")) ? true : (r.owner_address ? false : null),
    hiddenOwner: flag(r.hidden_owner), canTakeBackOwnership: flag(r.can_take_back_ownership), ownerChangeBalance: flag(r.owner_change_balance),
    buyTaxPct: num(r.buy_tax) == null ? null : num(r.buy_tax) * 100, sellTaxPct: num(r.sell_tax) == null ? null : num(r.sell_tax) * 100,
    cannotSellAll: flag(r.cannot_sell_all), cannotBuy: flag(r.cannot_buy), transferPausable: flag(r.transfer_pausable), blacklist: flag(r.is_blacklisted), whitelist: flag(r.is_whitelisted),
    slippageModifiable: flag(r.slippage_modifiable), tradingCooldown: flag(r.trading_cooldown), antiWhale: flag(r.is_anti_whale), antiWhaleModifiable: flag(r.anti_whale_modifiable), selfdestruct: flag(r.selfdestruct), externalCall: flag(r.external_call),
    holderCount: num(r.holder_count), lpHolderCount: num(r.lp_holder_count), lpTotalSupply: num(r.lp_total_supply),
    lpLockedPct: Array.isArray(r.lp_holders) ? Math.round(r.lp_holders.filter((h) => flag(h.is_locked)).reduce((a, h) => a + (Number(h.percent) || 0), 0) * 10000) / 100 : null,
    lpTopHolders: Array.isArray(r.lp_holders) ? r.lp_holders.slice(0, 5).map((h) => ({ address: h.address, tag: h.tag || null, percent: Math.round((Number(h.percent) || 0) * 10000) / 100, locked: flag(h.is_locked), isContract: flag(h.is_contract) })) : [],
    dexes: Array.isArray(r.dex) ? r.dex.slice(0, 6).map((d) => ({ name: d.name, type: d.liquidity_type, liquidityUsd: num(d.liquidity), pair: d.pair })) : [],
    creatorAddress: r.creator_address || null, creatorPct: num(r.creator_percent) == null ? null : num(r.creator_percent) * 100, ownerPct: num(r.owner_percent) == null ? null : num(r.owner_percent) * 100,
    trustList: flag(r.trust_list), fakeToken: r.fake_token ? { value: flag(r.fake_token.value), trueTokenAddress: r.fake_token.true_token_address || null } : null,
  };
}
export async function probeDexPairs({ chain, address }) {
  const c = DEXSCREENER_CHAINS[chain];
  if (!c) throw bad(`DexScreener does not cover ${chain}`, 422);
  const arr = await getJson(`https://api.dexscreener.com/token-pairs/v1/${c}/${address}`);
  const pairs = (Array.isArray(arr) ? arr : []).map((p) => ({
    dex: p.dexId || null, pair: p.pairAddress || null, baseAddress: p.baseToken?.address || null, quote: p.quoteToken?.symbol || null, priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    liquidityUsd: Number(p.liquidity?.usd) || 0, volume24h: Number(p.volume?.h24) || 0, volume1h: Number(p.volume?.h1) || 0,
    buys24h: Number(p.txns?.h24?.buys) || 0, sells24h: Number(p.txns?.h24?.sells) || 0, buys1h: Number(p.txns?.h1?.buys) || 0, sells1h: Number(p.txns?.h1?.sells) || 0,
    fdv: p.fdv != null ? Number(p.fdv) : null, marketCap: p.marketCap != null ? Number(p.marketCap) : null, createdAt: p.pairCreatedAt ? new Date(Number(p.pairCreatedAt)).toISOString() : null,
    hasProfile: Boolean(p.info && (p.info.imageUrl || (p.info.websites || []).length || (p.info.socials || []).length)),
    websites: Array.isArray(p.info?.websites) ? p.info.websites.map((w) => w.url).filter(Boolean).slice(0, 2) : [],
  })).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { totalPairs: pairs.length, liquidityUsd: pairs.reduce((a, p) => a + p.liquidityUsd, 0), volume24h: pairs.reduce((a, p) => a + p.volume24h, 0), txns24h: pairs.reduce((a, p) => a + p.buys24h + p.sells24h, 0), pairs: pairs.slice(0, 8) };
}
// Function names that ARE owner privileges: what an ABI can tell a reader that
// a verification badge cannot.
const PRIVILEGE_RE = /^(mint|burnFrom|pause|unpause|blacklist|unblacklist|setBlacklist|addToBlacklist|removeFromBlacklist|setFee|setFees|setTax|setTaxes|setBuyTax|setSellTax|setMaxTx|setMaxTxAmount|setMaxWallet|setSwapAndLiquify|excludeFromFee|excludeFromFees|includeInFee|setTradingEnabled|enableTrading|openTrading|setRouter|updateRouter|transferOwnership|renounceOwnership|upgradeTo|upgradeToAndCall|setImplementation|rescueTokens|withdrawTokens|clearStuckBalance|setCooldown|setLimits|setAntiWhale|setMaxHolding|freeze|unfreeze|setWhitelist|addWhitelist|lockTokens|disableTransfers|setTransfersEnabled)$/i;
export function privilegedFunctions(abi) {
  const fns = (Array.isArray(abi) ? abi : []).filter((x) => x && x.type === "function" && x.name);
  return { total: fns.length, privileged: fns.map((f) => f.name).filter((n) => PRIVILEGE_RE.test(n)).sort(), writable: fns.filter((f) => !/^(view|pure)$/.test(String(f.stateMutability || ""))).length };
}

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
const GROUND = "google/gemini-3.6-flash"; // grounded web search + read. gemini-3.6-flash since 2026-09-23 (2.5-flash expires upstream 2026-10-20); it reasons by default, so the search call passes reasoning:low - measured: default spent 460 of 600 tokens thinking, low returned the full cited answer at the same cost.
export const TOKEN_RISK_MODELS = [SYNTH, GROUND];

export const TOKEN_RISK_TIERS = {
  "token-risk": { price: "$0.60", maxUpstreamUsd: 0.35, scan: false, web: 0, synthMaxTokens: 3500, words: "~1,200" },
  "token-risk-pro": { price: "$0.85", maxUpstreamUsd: 0.5, scan: true, web: 1, synthMaxTokens: 5000, words: "~1,900" },
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const PROBE_TIMEOUT_MS = 22_000;
const SEARCH_TIMEOUT_MS = 45_000;
const SYNTH_TIMEOUT_MS = 120_000;
// Chains covered by BOTH the token-security probe and Sourcify source
// verification. Advertised here, keyed in GOPLUS_CHAIN_IDS and DEXSCREENER_CHAINS,
// and named by the 400 below: one list, three uses, so the contract a buyer
// reads on /openapi.json is the one the handler enforces.
export const CHAINS = new Set(["base", "ethereum", "polygon", "arbitrum", "optimism", "bsc", "gnosis"]);
const CHAINS_PROSE = `${[...CHAINS].join(", ")} (default base)`;
const fmtUsdLoose = (v) => (v == null || !Number.isFinite(Number(v)) ? "unknown" : Number(v) >= 1e6 ? `$${(Number(v) / 1e6).toFixed(2)}M` : Number(v) >= 1e3 ? `$${(Number(v) / 1e3).toFixed(1)}k` : `$${Number(v).toFixed(0)}`);

function H(slug) {
  const t = CONTRACT_TOOLS.find((x) => x.slug === slug);
  if (!t) throw bad(`token-risk: missing dependency '${slug}'`, 500);
  return t.handler;
}
async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
// `status` rides back because a caller has to tell "the source answered and
// held nothing" (422) from "the source did not answer" (502/503/504, or no
// status at all for a timeout or a socket error). Those need opposite words.
async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e), status: Number(e?.statusCode) || null }; }
}
// The statuses that mean "not this buyer's fault"; anything else a probe
// reports is normalised to 503 rather than relayed.
const UNAVAILABLE_STATUS = new Set([502, 503, 504]);
// Best-effort extraction of Solidity source text from contract-source output,
// whatever shape it returns the files in.
function extractSource(cs) {
  if (!cs) return "";
  const parts = [];
  const push = (x) => { if (typeof x === "string" && x.includes("pragma")) parts.push(x); };
  for (const key of ["source", "sourceCode", "content"]) push(cs[key]);
  const files = cs.sources || cs.files || cs.sourceFiles;
  if (Array.isArray(files)) for (const f of files) push(typeof f === "string" ? f : (f?.content || f?.source));
  else if (files && typeof files === "object") for (const k of Object.keys(files)) push(files[k]?.content || files[k]);
  return parts.join("\n\n").slice(0, 500 * 1024);
}
const fmtPct = (n) => (n == null ? "?" : `${n.toFixed(2)}%`);
// Burn / dead addresses hold supply that is out of circulation. They are EOAs
// (no bytecode) so a holder list reports them as non-contracts; without this
// they'd be labeled a large "wallet", misreading burned supply as concentration risk.
function isBurn(a) {
  const s = String(a || "").toLowerCase().replace(/^0x/, "");
  return /^0{40}$/.test(s) || /^0*0*dead$/.test(s) || /0{6,}dead$/.test(s) || s === "000000000000000000000000000000000000dead";
}
const holderType = (r) => (r.burn ? "burn/dead" : r.isContract ? "contract" : "EOA");

// `deps` is the test seam: the keyless probes, the in-process contract tools
// and the model call can each be replaced so the handler runs offline.
function makeTokenRiskHandlerInner(tierSlug, deps = {}) {
  const t = TOKEN_RISK_TIERS[tierSlug];
  const goplus = deps.probeGoPlus || probeGoPlus;
  const dexPairs = deps.probeDexPairs || probeDexPairs;
  const tool = deps.tool || H;
  const ask = deps.chat || chat;
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"address": "0x…", "chain": "base"}');
    const address = String(input.address ?? input.token ?? "").trim();
    if (!ADDR_RE.test(address)) throw bad('"address" must be a token contract address (0x + 40 hex chars)');
    const chain = String(input.chain ?? "base").trim().toLowerCase();
    if (!CHAINS.has(chain)) throw bad(`"chain" must be one of: ${CHAINS_PROSE}`);
    const user = safeUser(req);

    // 1) ON-CHAIN PROBES (parallel, each non-fatal).
    const [srcR, gpR, dexR, abiR] = await Promise.all([
      settle(tool("contract-source")({ address, network: chain }), PROBE_TIMEOUT_MS),
      settle(goplus({ chain, address }), PROBE_TIMEOUT_MS),
      settle(dexPairs({ chain, address }), PROBE_TIMEOUT_MS),
      settle(tool("contract-abi")({ address, network: chain }), PROBE_TIMEOUT_MS),
    ]);
    const src = srcR.ok ? srcR.data : null;
    const gp = gpR.ok ? gpR.data : null;
    const dex = dexR.ok ? dexR.data : null;
    const abiInfo = abiR.ok ? privilegedFunctions(abiR.data?.abi) : null;
    const holders = Array.isArray(gp?.topHolders) ? gp.topHolders : [];
    // An OUTAGE IS NOT THE BUYER'S MISTAKE. The token-security probe is the
    // only source of supply and holders, so when it fails there is no report to
    // sell either way - but a rate limit, an upstream error or a timeout must
    // say the source is down, not tell a buyer to check an address that is
    // correct. 422 from the probe is its considered answer ("no record for this
    // token", "chain not covered"); every other outcome is the source itself.
    // Both are >= 400, so settlement is cancelled and nobody pays; what differs
    // is the words and the class a monitor files it under.
    if (!gp && gpR.status !== 422) {
      throw bad(`The token-security source is unavailable (${gpR.error}), so the risk report for "${address}" on ${chain} could not be produced. Not charged; try again shortly.`,
        UNAVAILABLE_STATUS.has(gpR.status) ? gpR.status : 503);
    }
    // Minimum evidence: a RISK report needs on-chain token facts (supply) or the
    // holder distribution, and the token-security record is where both come
    // from. Verified source (Sourcify) or DEX pairs alone are not a risk
    // assessment and must not be sold as one. Not charged.
    if (!gp || (gp.totalSupply == null && !holders.length)) {
      const why = gp ? "the token-security record carried neither supply nor holders" : `the token-security probe failed: ${gpR.error}`;
      const also = [src ? "the contract source" : null, dex ? "the DEX pairs" : null].filter(Boolean);
      throw bad(`Could not read token "${address}" on ${chain} (${why}${also.length ? `; only ${also.join(" and ")} ${also.length > 1 ? "were" : "was"} readable` : ""}). Confirm the address and chain. Not charged.`, 422);
    }

    const totalSupply = gp.totalSupply;
    const ranked = holders.map((h) => ({
      address: h.address || null,
      isContract: h.isContract === true,
      burn: isBurn(h.address),
      name: h.tag || null,
      locked: h.locked === true,
      share: h.percent,
    }));
    const top1 = ranked[0]?.share ?? null;
    const top10 = Math.round(ranked.slice(0, 10).reduce((a, r) => a + (r.share || 0), 0) * 1e4) / 1e4 || null;
    const verified = src ? !!src.verified : null;

    // 2) PRO: static scan of the verified source + one web reputation check.
    let scan = null, scanErr = null, web = null;
    let spent = 0;
    if (t.scan && verified) {
      const source = extractSource(src);
      if (source.trim()) {
        const r = await settle(tool("solidity-scan")({ source }), PROBE_TIMEOUT_MS);
        if (r.ok) scan = r.data; else scanErr = r.error;
      } else scanErr = "verified source text was not extractable from the verification record";
    }
    if (t.web) {
      const q = `${gp.tokenName || address} ${gp.tokenSymbol || ""} token ${chain} scam OR rug OR honeypot OR audit reputation`.trim();
      const wr = await ask({ model: GROUND, reasoning: { effort: "low" }, messages: [{ role: "user", content: `Search the web for the reputation of this crypto token and answer with SPECIFIC facts and citations - any scam/rug/honeypot reports, audits, or notable coverage. If you find nothing credible, say so. Token: ${q}` }], max_tokens: 600, plugins: [{ id: "web", engine: "exa", max_results: 5 }] }, SEARCH_TIMEOUT_MS, user).catch(() => null);
      if (wr) { web = { answer: textOf(wr), sources: (wr?.choices?.[0]?.message?.annotations || []).map((a) => a?.url_citation || a).filter((c) => c?.url).map((c) => ({ title: String(c.title || c.url).slice(0, 160), url: String(c.url) })) }; spent += costOf(wr); }
    }

    // 3) GROUNDING BLOCKS.
    // A DexScreener pair's price, market cap and FDV describe its BASE token, so
    // only a pair that lists this token as the base can supply them; the
    // deepest pair for a stablecoin usually quotes it (AERO/USDC is AERO's price).
    const top = dex?.pairs?.find((p) => String(p.baseAddress || "").toLowerCase() === address.toLowerCase()) || null;
    const infoBlock = `Name ${gp.tokenName || "?"} (${gp.tokenSymbol || "?"}). Total supply ${totalSupply ?? "unknown"} (whole tokens, per GoPlus). Holder count ${gp.holderCount ?? "unknown"}. ` +
      (top
        ? `Market (deepest DEX pair with this token as base): price ${top.priceUsd != null ? `$${top.priceUsd}` : "unknown"}, market cap ${fmtUsdLoose(top.marketCap)}, FDV ${fmtUsdLoose(top.fdv)}.`
        : `Market price and cap were NOT checked (${dex ? "no listed DEX pair has this token as its base" : "the DexScreener probe failed"}).`);
    const verifyBlock = src
      ? (verified ? `Source is VERIFIED (${src.match || "match"}) - compiler ${src.compiler?.version || "?"}, verified at ${src.verifiedAt || "?"}.` : "Source is NOT VERIFIED on Sourcify - the contract's code cannot be independently reviewed. This is a notable risk signal (though some legitimate contracts are unverified).")
      : `contract-source probe FAILED: ${srcR.error}`;
    const holderBlock = ranked.length
      ? `Top holders as listed by GoPlus (up to 10; share of total supply; [burn/dead] = out of circulation, [contract] = pool/bridge/staking/etc., [EOA] = externally-owned wallet):\n` + ranked.map((r, i) => `${i + 1}. ${r.address || "?"} - ${fmtPct(r.share)} [${holderType(r)}]${r.locked ? " LOCKED" : ""}${r.name ? ` (${r.name})` : ""}`).join("\n") + `\nConcentration: top holder ${fmtPct(top1)}, top ${Math.min(ranked.length, 10)} ${fmtPct(top10)} of supply (this includes any burn/dead and pool/contract holders - weigh those differently from wallet concentration).`
      : "The token-security record listed no holders; holder concentration was NOT checked.";
    const scanBlock = t.scan
      ? (scan ? `Static pattern scan (heuristic, not an audit) of the verified source: ${scan.summary ? JSON.stringify(scan.summary) : `${(scan.findings || []).length} findings`}. Findings: ${(scan.findings || []).slice(0, 25).map((f) => `${f.severity || "?"}: ${f.title || f.rule || f.pattern || "finding"}${f.line ? ` (line ${f.line})` : ""}`).join("; ") || "none"}.`
              : `Static scan not run: ${scanErr || "source unavailable"}.`)
      : "";
    const webBlock = web ? `WEB REPUTATION: ${web.answer || "(no answer)"}` : "";
    const yn = (v) => (v === true ? "YES" : v === false ? "no" : "unknown");
    const pctS = (v) => (v == null ? "unknown" : `${Number(v).toFixed(2)}%`);
    // No "the token-security probe failed" arm here or in the liquidity block:
    // past the refusal above `gp` is always present, and a branch that can
    // never run is a claim nothing checks.
    const controlBlock = [
      `GoPlus token_security (keyless, checked): open source ${yn(gp.openSource)}; PROXY (upgradeable) ${yn(gp.proxy)}; MINTABLE ${yn(gp.mintable)}; HONEYPOT ${yn(gp.honeypot)}; owner ${gp.ownerAddress || "unknown"} (renounced ${yn(gp.ownerRenounced)}, owner holds ${pctS(gp.ownerPct)}); hidden owner ${yn(gp.hiddenOwner)}; can take back ownership ${yn(gp.canTakeBackOwnership)}; owner can change balances ${yn(gp.ownerChangeBalance)}; buy tax ${pctS(gp.buyTaxPct)}, sell tax ${pctS(gp.sellTaxPct)}; cannot sell all ${yn(gp.cannotSellAll)}; transfers pausable ${yn(gp.transferPausable)}; blacklist ${yn(gp.blacklist)}; whitelist ${yn(gp.whitelist)}; slippage modifiable ${yn(gp.slippageModifiable)}; trading cooldown ${yn(gp.tradingCooldown)}; anti-whale ${yn(gp.antiWhale)} (modifiable ${yn(gp.antiWhaleModifiable)}); selfdestruct ${yn(gp.selfdestruct)}; external calls ${yn(gp.externalCall)}; creator ${gp.creatorAddress || "unknown"} holds ${pctS(gp.creatorPct)}${gp.fakeToken?.value ? `; FLAGGED AS A FAKE of ${gp.fakeToken.trueTokenAddress || "another token"}` : ""}${gp.trustList ? "; on GoPlus trust list" : ""}.`,
      abiInfo
        ? `ABI (Sourcify): ${abiInfo.total} functions, ${abiInfo.writable} state-changing; PRIVILEGED functions present: ${abiInfo.privileged.length ? abiInfo.privileged.join(", ") : "none of the known owner-privilege names"}. (A privileged function is a capability, not proof of use - who can call it is the owner question above.)`
        : `ABI probe ${abiR.ok ? "returned no ABI" : `FAILED (${abiR.error})`} - the contract's function surface was NOT inspected.`,
    ].join("\n");
    const liquidityBlock = [
      dex
        ? `DexScreener: ${dex.totalPairs} pair(s), combined liquidity ${fmtUsdLoose(dex.liquidityUsd)}, 24h volume ${fmtUsdLoose(dex.volume24h)}, 24h transactions ${dex.txns24h}. Deepest pairs: ${dex.pairs.slice(0, 5).map((p) => `${p.dex} ${p.quote || "?"} pair ${p.pair} liquidity ${fmtUsdLoose(p.liquidityUsd)}, 24h vol ${fmtUsdLoose(p.volume24h)}, buys/sells 24h ${p.buys24h}/${p.sells24h}, 1h ${p.buys1h}/${p.sells1h}${p.createdAt ? `, created ${p.createdAt.slice(0, 10)}` : ""}${p.hasProfile ? ", profile yes" : ", profile NO"}`).join("; ") || "none"}.`
        : `DexScreener probe FAILED (${dexR.error}) - liquidity and trading activity were NOT checked; say so.`,
      `LP (GoPlus): ${gp.lpHolderCount ?? "unknown"} LP holders; LP locked ${pctS(gp.lpLockedPct)} of LP supply; top LP holders ${gp.lpTopHolders.map((h) => `${h.address}${h.tag ? ` (${h.tag})` : ""} ${h.percent}%${h.locked ? " LOCKED" : ""}`).join("; ") || "none listed"}; DEX liquidity per GoPlus ${gp.dexes.map((d) => `${d.name} ${fmtUsdLoose(d.liquidityUsd)}`).join(", ") || "none listed"}.`,
    ].filter(Boolean).join("\n");

    // 4) SYNTHESIZE - evidence-based, NEVER a definitive safe/scam verdict.
    const synthPrompt = `You are a blockchain analyst writing a TOKEN & CONTRACT RISK REPORT on ${address} (${chain}) that will be SOLD to a paying customer. It must be scrupulously honest and evidence-based.

=== ABSOLUTE RULES ===
1. Use ONLY the on-chain probe data and (if present) web reputation below. Never invent a holder, figure, finding, or fact.
2. This is an EVIDENCE-BASED RISK ASSESSMENT, NOT financial advice and NOT a guarantee. NEVER declare the token "safe", "legitimate", "a scam", or "a rug". Instead describe the concrete risk SIGNALS and what they do and do not tell us. Disclaim ONLY what was not checked: the CONTROL & UPGRADEABILITY block says whether the contract is a proxy, mintable, pausable, taxed, blacklistable and who owns it, and the LIQUIDITY block says what is tradable where - report those as checked facts. What no on-chain check can see: off-chain promises, social-engineering, a FUTURE upgrade if the contract is a proxy or the owner is not renounced (say that conditionally), and anything a probe marked FAILED. A clean report is NOT an endorsement - the reader must do their own research. A GAP IN THIS MATERIAL IS NEVER A FINDING ABOUT THE TOKEN: a failed probe is "not checked here", never "hidden" or "undisclosed".
3. Interpret holder concentration CAREFULLY using the LABELS given ([burn/dead], [contract], [EOA]): [burn/dead] holdings are supply OUT of circulation (not concentration risk); [contract] holdings are pools/bridges/staking contracts (weigh differently from a person's wallet); only large [EOA] holdings are true single-wallet concentration. Never call burned or pool-held supply "concentration risk"; say which kind each large holder is.
4. Treat an UNVERIFIED source as a real but not conclusive signal; treat static-scan findings as heuristic triage, not a formal audit.

Write a clear, structured report of up to ${t.words} words: SNAPSHOT (what the token is, supply, holders, market context), CONTROL & UPGRADEABILITY (proxy, mint, pause, taxes, blacklist, owner - from the checked flags and the ABI), LIQUIDITY & TRADING (pairs, depth, volume, LP lock), SOURCE VERIFICATION, HOLDER CONCENTRATION (with the contract-vs-EOA nuance), ${t.scan ? "STATIC CODE SIGNALS, " : ""}${t.web ? "REPUTATION & CONTEXT, " : ""}and a RISK SUMMARY that lists the specific signals found (elevated, neutral, or reassuring) and closes with the plain caveat that this is not advice and not exhaustive. Do NOT write a sources section.

=== TOKEN INFO ===\n${infoBlock}
=== CONTROL & UPGRADEABILITY (checked) ===\n${controlBlock}
=== LIQUIDITY & TRADING (checked) ===\n${liquidityBlock}
=== SOURCE VERIFICATION ===\n${verifyBlock}
=== HOLDER CONCENTRATION ===\n${holderBlock}${t.scan ? `\n=== STATIC SCAN ===\n${scanBlock}` : ""}${t.web && webBlock ? `\n=== WEB REPUTATION ===\n${webBlock}` : ""}`;

    const sd = await ask({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Token risk synthesis produced nothing - not charged", 502);
    const report = prose;

    // 5) DATA APPENDIX.
    const tables = [];
    if (ranked.length) tables.push({
      name: "holders", label: "Top holders",
      columns: ["Rank", "Address", "Share of supply", "Type", "Label"],
      rows: ranked.map((r, i) => [String(i + 1), r.address || "", fmtPct(r.share), holderType(r), [r.name, r.locked ? "locked" : null].filter(Boolean).join(", ")]),
    });
    if (scan?.findings?.length) tables.push({
      name: "scan-findings", label: "Static scan findings",
      columns: ["Severity", "Finding", "Line"],
      rows: scan.findings.map((f) => [String(f.severity || ""), String(f.title || f.rule || f.pattern || ""), String(f.line ?? "")]),
    });

    const sources = (web?.sources || []).map((s, i) => ({ n: i + 1, ...s }));
    const meta = {
      tier: tierSlug, address, chain,
      name: gp.tokenName ?? null, symbol: gp.tokenSymbol ?? null,
      verified_source: verified, holder_count: gp.holderCount ?? null,
      top1_share_pct: top1, top10_share_pct: top10,
      scan_findings: scan?.findings?.length ?? null,
      probes: { tokenSecurity: gpR.ok, dexPairs: dexR.ok, source: srcR.ok, abi: abiR.ok, scan: !!scan },
      synthesis_model: SYNTH,
      disclaimer: "Evidence-based on-chain risk signals only. Not financial advice, not a guarantee, not exhaustive. On-chain analysis cannot detect off-chain or social scams.",
    };
    const out = { report, address, chain, sources, tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { infoBlock, verifyBlock, holderBlock, scanBlock, webBlock };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(TOKEN_RISK_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["address"],
  properties: {
    address: { type: "string", description: "Token contract address (0x + 40 hex)." },
    chain: { type: "string", description: `Chain, one of: ${CHAINS_PROSE}.` },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Token & Contract Risk Report: EXAMPLE (0x…)\n\n## Snapshot\n...\n\n## Risk summary\n... This is not financial advice and not exhaustive.",
  address: "0x0000000000000000000000000000000000000000", chain: "base",
  sources: [],
  tables: [{ name: "holders", label: "Top holders", columns: ["Rank", "Address", "Share of supply", "Type", "Label"], rows: [["1", "0x…", "42.10%", "contract", "Uniswap V3 Pool"]] }],
  meta: { tier: "token-risk", address: "0x…", chain: "base", name: "Example", symbol: "EXMP", verified_source: true, holder_count: 1234, top1_share_pct: 42.1, top10_share_pct: 71.5, synthesis_model: "anthropic/claude-opus-5", disclaimer: "Evidence-based on-chain risk signals only. Not financial advice." },
};

export const TOKEN_RISK_TOOLS = [
  {
    route: "POST /v1/token-risk", name: "Token & contract risk report (on-chain evidence)", slug: "token-risk", category: "llm", price: TOKEN_RISK_TIERS["token-risk"].price,
    description: "Hand over a token contract address (and chain) and get one evidence-based on-chain risk report: whether the source is verified, holder concentration (top-1 / top-10 share of supply, distinguishing pools/contracts from wallets), and supply + market context, with a top-holders appendix. Evidence, never a 'safe' or 'scam' verdict - on-chain checks can't see off-chain rugs, so a clean report is not an endorsement. USDC (x402/MPP). Not cached.",
    tags: ["crypto", "token", "risk", "rug", "holders", "concentration", "contract", "verified-source", "onchain", "agent", "premium"],
    discovery: { bodyType: "json", input: { address: "0x4200000000000000000000000000000000000006", chain: "base" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeTokenRiskHandler("token-risk"),
  },
  {
    route: "POST /v1/token-risk/pro", name: "Token & contract risk report - PRO (static scan + reputation)", slug: "token-risk-pro", category: "llm", price: TOKEN_RISK_TIERS["token-risk-pro"].price,
    description: "The deeper tier: everything in the standard report plus a deterministic static-pattern scan of the verified source (tx.origin auth, delegatecall, selfdestruct, unchecked calls, reentrancy surface, etc. - heuristic triage, not a formal audit) and a web reputation check. Still evidence, never a verdict. USDC (x402/MPP). Not cached.",
    tags: ["crypto", "token", "risk", "rug", "static-analysis", "solidity", "reputation", "contract", "onchain", "agent", "premium"],
    discovery: { bodyType: "json", input: { address: "0x4200000000000000000000000000000000000006", chain: "base" }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "token-risk-pro" } } } },
    handler: makeTokenRiskHandler("token-risk-pro"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeTokenRiskHandler(tierSlug, deps) {
  const run = makeTokenRiskHandlerInner(tierSlug, deps);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(TOKEN_RISK_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
