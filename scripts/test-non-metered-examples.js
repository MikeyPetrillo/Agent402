#!/usr/bin/env node
// Strict FREE_MODE sweep of paid catalog tools that do NOT burn Mike's metered
// third-party keys. Unlike scripts/test-all.js NETWORK leniency (which treats
// 502/503/504 as green), this suite FAILS on those statuses — that hole is how
// gov-data stayed green while its upstream was permanently dead (issue #730).
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-non-metered-examples.js
//   node scripts/test-non-metered-examples.js   # boots its own FREE_MODE server
//
// WHY: test-all.js puts free-public tools (gov-data, weather, EDGAR, …) in
// NETWORK and only fails status>=500 excluding 502/503/504. Handlers map a
// dead upstream to 502, so a permanently broken tool is a green [test] run.
// The weekly Algorand rail canary caught gov-data; customers should never be
// first. This is the FREE_MODE CI guard for that class.
//
// SCOPE FILTER (documented, deliberate):
//   IN  — price > 0 AND documented OpenAPI example does not spend Brave /
//         OpenAI / OpenRouter / E2B / Blockscout-buyer / FRED / Neynar /
//         Alchemy-hard / CDP keys. Free-public APIs (data.gov DEMO_KEY,
//         weather.gov, CoinGecko keyless, Nominatim, Open-Meteo, …) stay IN
//         even when they live in WALLET_ONLY_SLUGS.
//   OUT — METERED_SLUGS below; skill packs whose toolSlugs reach any of those;
//         workflows OpenAPI category (composition, not paywalled tools);
//         zero/free price endpoints.
// Identity-bound memory / my-usage are OUT via METERED_SLUGS (payment=identity,
// need a wallet even in FREE_MODE for real semantics).
//
// STRICTNESS: HTTP 200 and no body.error. 502/503/504 FAIL after one retry on
// timeout/502/503/504/429. Upstream *rate limits* (429, or 502/503 whose body
// says rate-limit) soft-skip LOUDLY after that retry — same doctrine as
// test-gov-data.js's DEMO_KEY 429 path — so a throttle is not a deploy block,
// while a permanently dead upstream (gov-data's retired v3 → bare 502) still
// fails. render/screenshot skip LOUDLY only when Playwright Chromium is
// missing locally (CI installs chromium — those must pass there).
//
// Also soft-skip LOUDLY (after retry) free-public flakes that are NOT the
// dead-tool class and would otherwise thrash [test]:
//   • media-info / audio-convert / audio-normalize — example URLs are third-
//     party Wikimedia; handlers are covered by scripts/test-media.js on a
//     local ffmpeg tone. A 422 "media could not be processed" / content-type
//     paste-error after retry is "source host flaked", not "tool is gone".
//   • price-feed kit 502 "malformed JSON" — DeFiLlama/CoinGecko occasionally
//     return garbage bodies; a bare outage 502 without that wording still fails.
//   • client-side AbortSignal timeouts (status 0) — FREE_MODE sweeps under
//     concurrency hit slow free-public hosts; a permanently dead tool returns
//     502/503 quickly, not a 25s hang twice. Server 504 after retry still fails.
//
// CONTROL: grading asserts 502 would fail (the NETWORK hole), gov-data must be
// in-scope, and a planted Brave slug must be out-of-scope — vacuous green is
// refused (floor on in-scope count).
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { SKILL_PACKS } from "../src/skills.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { missingDocumentedKeys, emptyPromisedArrays } from "./sweep-shape.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.NON_METERED_PORT) || 3143;
const EXTERNAL = Boolean(process.env.TARGET_URL);
const TARGET = process.env.TARGET_URL || `http://127.0.0.1:${PORT}`;
// Keep concurrency modest — many in-scope tools share free-public upstreams
// (CoinGecko keyless, data.gov DEMO_KEY) and a thundering herd just rate-limits.
const CONCURRENCY = Number(process.env.NON_METERED_CONCURRENCY) || 3;
const TIMEOUT_MS = Number(process.env.NON_METERED_TIMEOUT_MS) || 25_000;
const SKILL_TIMEOUT_MS = Number(process.env.NON_METERED_SKILL_TIMEOUT_MS) || 55_000;
// Floor so a broken filter that empties the work list cannot pass silently.
const MIN_IN_SCOPE = Number(process.env.NON_METERED_MIN_IN_SCOPE) || 350;
// Backoff for the upstream-5xx class. The first entry is the original single
// retry; the rest are the added time that lets a provider wobble clear.
const RETRY_BACKOFF_MS = [1500, 8000, 20000];
// Past this many distinct tools needing escalation, it is an outage rather than
// a blip and more waiting proves nothing.
const ESCALATE_MAX = Number(process.env.NON_METERED_ESCALATE_MAX) || 12;
// COINGECKO IS SAMPLED, NOT SWEPT.
//
// Keyless CoinGecko is 30 requests/min SHARED PER IP, and GitHub runners share
// address space. This sweep drove all 19 CoinGecko-backed examples every run
// and went straight through that budget - and a blown CoinGecko budget answers
// with TIMEOUTS rather than 429s, so the rate-limit lane never matched it and
// the escalated backoff just retried into an allowance that was already spent.
// Measured 2026-08-24: nine tools escalated to four attempts, four recovered,
// and the run failed while CoinGecko answered a laptop in 167ms.
//
// A key raises the ceiling but does not make it free: CI would then spend the
// Demo plan's monthly quota on every push, which is the trap the Brave notes at
// the top of this file already record. So the answer is fewer calls, not more
// budget: TWO of the family are exercised live per run.
//
// The two ROTATE by commit, so every tool is covered across runs rather than
// the same two forever - and deterministically, so a re-run of the same commit
// tests the same pair and a failure reproduces. The rest are skipped LOUDLY and
// named, because a skip nobody can see is how a dead tool hides.
const COINGECKO_SLUGS = new Set([
  "crypto-price", "crypto-market", "crypto-history", "crypto-trending", "crypto-global", "stablecoin-peg",
  "coin-price-by-contract", "coin-profile", "coin-history", "coin-ohlc", "coin-market-chart-range",
  "coin-categories", "global-defi", "exchanges", "exchange-tickers", "exchange-rates", "coin-search",
  "coins-list", "price-coingecko",
  "rwa-list", "rwa-markets", "rwa-asset", "rwa-issuers", "rwa-issuer",
]);
const CG_SAMPLE_SIZE = Number(process.env.NON_METERED_CG_SAMPLE) || 2;

/** The CoinGecko slugs to exercise live on THIS commit. */
export function coingeckoSample(sha = process.env.GITHUB_SHA || "local", size = CG_SAMPLE_SIZE) {
  const all = [...COINGECKO_SLUGS].sort();
  if (size >= all.length) return new Set(all);
  let h = 0;
  for (const ch of String(sha)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % all.length;
  const out = new Set();
  for (let i = 0; i < size; i++) out.add(all[(start + i) % all.length]);
  return out;
}
const CG_LIVE = coingeckoSample();
let skippedCoingecko = 0;

const escalatedTools = new Set();
const retryStats = [];

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; failures.push(msg); console.error(`FAIL - ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Metered upstream exclusion oracle ──────────────────────────────────────
// Tools whose example answers burn Mike's third-party budget / buyer wallet /
// identity surface. Keep in sync with the class of spend — adding a new keyed
// upstream means listing its slugs here (and skill packs resolve transitively).
const METERED_SLUGS = new Set([
  // Brave Search subscription
  "search", "search-news", "search-images", "search-videos", "search-suggest", "answer", "multi-search",
  "llm-context",      // Brave /llm/context - same subscription, billed per call
  "research-company", // calls search-news handler in-process
  // OpenAI
  "llm", "llm-pro", "llm-premium",
  "image-gen", "image-gen-hd", "image-gen-premium",
  "tts", "tts-hd", "transcribe", "transcribe-pro",
  "embed", "embed-large", "moderate",
  // OpenRouter gateway
  "v1-chat-nano", "v1-chat-auto", "v1-chat-grounded", "v1-chat-ox", "v1-chat", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered",
  "v1-embeddings", "v1-rerank", "v1-images", "v1-audio-speech",
  "v1-chat-nano-messages", "v1-chat-auto-messages", "v1-chat-messages", "v1-chat-pro-messages", "v1-chat-premium-messages", "v1-chat-metered-messages",
  "v1-chat-nano-responses", "v1-chat-auto-responses", "v1-chat-responses", "v1-chat-pro-responses", "v1-chat-premium-responses", "v1-chat-metered-responses",
  // Calls the v1-chat gateway handler in-process — same OpenRouter key dependency.
  "pdf-summarize",
  // research-deep composites — fan out to grounded search + rerank + synthesis
  // over OpenRouter (503 without OPENROUTER_API_KEY), same key dependency.
  "research", "research-pro", "research-max",
  "dossier", "dossier-max",
  // fund-report composites — SEC 13F diff + grounded search + Opus synthesis
  // over OpenRouter (503 without OPENROUTER_API_KEY), same key dependency.
  "fund-report", "fund-report-max",
  // domain-audit composites — live probes + Opus synthesis over OpenRouter.
  "domain-audit", "domain-audit-pro",
  // recall-report - openFDA probes + Opus synthesis over OpenRouter.
  "recall-report", "insider-report", "market-brief", "token-brief", "filing-report", "linkedin-article",
  // ticker-pack - runs the dossier + insider composites in-process.
  "ticker-pack",
  // token-risk composites — Blockscout x402 buys (upstream-buyer wallet) +
  // Opus synthesis over OpenRouter; metered upstream both ways.
  "token-risk", "token-risk-pro",
  // E2B
  "code-run", "code-run-pro",
  // Blockscout x402 buyer wallet
  "contract-inspect", "address-profile", "token-info", "token-holders", "tx-inspect",
  // Route-and-execute can buy external sellers
  "route-execute", "route-execute-max", "route-execute-plus",
  // Identity-bound (payment = identity)
  "memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
  "my-usage",
  // FRED keyed (503 without FRED_API_KEY / FRED_API_KEY_V2)
  "fred-series", "fred-search", "fred-series-info", "fred-release-calendar",
  "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds",
  "fred-release-observations",
  // Neynar / Farcaster
  "farcaster-profile", "farcaster-by-address",
  "fc-cast-search", "fc-channel-feed", "fc-trending", "fc-user-casts", "fc-cast",
  "fc-cast-replies", "fc-channel", "fc-user-search", "fc-cast-metrics",
  // X API v2 app-only bearer (per-post read billing) and the enrichment
  // providers - each lists only with its own key, and 503s without it.
  "x-search-recent", "x-user", "x-user-tweets", "x-tweet", "x-users-lookup",
  "hunter-domain-search", "hunter-email-finder", "hunter-email-verify", "hunter-company",
  "apollo-people-search", "apollo-org-enrich", "apollo-person-match",
  // OpenRouter Image + Video APIs (flat per-image / per-second upstream price).
  "v1-images-fast", "v1-images-pro", "v1-videos",
  // Alchemy hard-require (compute units) — publicJsonRpc-backed tools stay IN
  "wallet-balance", "token-metadata", "token-price", "wallet-transactions",
  "asset-transfers", "token-balances", "token-allowance", "tx-receipt",
  "block-receipts", "token-price-history",
  "nft-holdings", "nft-metadata", "gas-snapshot", "eth-call",
  "dex-pair", "dex-pool", "dex-quote",
  "nft-collection", "nft-floor",
  "l2-gas-comparison",
  // CDP (Coinbase Developer Platform keys)
  "wallet-balances", "testnet-fund", "onramp-link", "onchain-sql", "onchain-sql-schema",
]);

const BROWSER_SLUGS = new Set(["render", "screenshot"]);
// Handlers proven offline by scripts/test-media.js; live examples depend on
// Wikimedia (same URL for all three). Soft-skip source-host flakes only.
const MEDIA_EXAMPLE_SLUGS = new Set(["media-info", "audio-convert", "audio-normalize"]);

const METERED_PACK_SLUGS = new Set();
for (const p of SKILL_PACKS) {
  const hits = (p.toolSlugs || []).filter((s) => METERED_SLUGS.has(s));
  if (hits.length) METERED_PACK_SLUGS.add(p.slug);
}

// Upstreams whose edge BLOCKS GitHub runners: Kalshi's Cloudflare answered the
// sweep an HTML 403 page on 2026-08-28 (both examples, same run) while the same
// request answered 200 from a laptop and from production. A strict sweep
// cannot tell that block from a dead tool, and the lenient test-all NETWORK
// set still calls them every run; production is watched by the tool alert.
const RUNNER_BLOCKED_SLUGS = new Set(["kalshi-markets", "kalshi-event"]);

function excludeReason(slug, path) {
  if (METERED_SLUGS.has(slug)) return "metered_upstream_key_or_buyer";
  if (RUNNER_BLOCKED_SLUGS.has(slug)) return "upstream_blocks_github_runners";
  const packName = slug.startsWith("skill-") ? slug.slice(6) : null;
  if (packName && METERED_PACK_SLUGS.has(packName)) return "skill_pack_reaches_metered";
  if (path.startsWith("/api/skill/")) {
    const name = path.slice("/api/skill/".length);
    if (METERED_PACK_SLUGS.has(name)) return "skill_pack_reaches_metered";
  }
  return null;
}

function parsePrice(p) {
  if (typeof p === "number") return p;
  return Number(String(p ?? "").replace(/[^0-9.]/g, "")) || 0;
}

/** Strict success: 200 and no body.error. 502/503/504 are HARD fails (unlike test-all NETWORK). */
function isStrictPass(status, body) {
  return status === 200 && !(body && body.error);
}

/** True when a response should fail the suite after retries are exhausted. */
function isStrictFailure(status, body, threw) {
  if (threw) return true;
  if (isStrictPass(status, body)) return false;
  return true;
}

function isBrowserUnavailable(status, body, threw) {
  const msg = String(threw || (body && (body.error || body.message)) || "");
  return status === 503 && /browser unavailable|Executable doesn't exist|chromium|playwright/i.test(msg);
}

function errText(body, threw) {
  return String(threw || (body && (body.error || body.message)) || "");
}

function isRateLimited(status, body, threw) {
  if (status === 429) return true;
  // Match explicit rate-limit wording (incl. "Source URL returned HTTP 429"
  // from fetch-guard). Do NOT match bare "retry shortly" — that also rides
  // capacity 503s which must still fail the suite.
  return /\b429\b|rate.?limit|throttl/i.test(errText(body, threw));
}

/** Wikimedia (or similar) media-source flake — NOT a dead tool (test-media covers handlers). */
function isUpstreamMediaSourceFlake(slug, status, body, threw) {
  if (!MEDIA_EXAMPLE_SLUGS.has(slug)) return false;
  const msg = errText(body, threw);
  // Generic ffprobe/ffmpeg failure after a bad/truncated download, or the
  // content-type pre-screen when the host served a webpage/JSON error page.
  if (status === 422 && /media could not be processed|Content-Type .+ not audio\/video|webpage URL/i.test(msg)) {
    return true;
  }
  // Fetch-guard upstream HTTP errors on the example media URL.
  if ((status === 502 || status === 503 || status === 504) && /Source URL returned HTTP|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return true;
  }
  return false;
}

/** Free price-feed hosts occasionally return non-JSON bodies → 502. Narrow match only. */
function isTransientMalformedPriceFeed(status, body, threw) {
  return status === 502 && /Price feed upstream returned malformed JSON/i.test(errText(body, threw));
}

/**
 * crt.sh (the free Certificate Transparency mirror behind cert-transparency)
 * relays its own 5xx through our handler as a quoted upstream status. That is a
 * third-party outage on a free public service, not a dead tool: the message
 * names crt.sh AND the status it returned, which a permanently retired endpoint
 * cannot produce (that shape is a bare 502). Soft-skip LOUDLY after the retry.
 */
function isCertTransparencyUpstreamFlake(slug, status, body, threw) {
  return slug === "cert-transparency" && status === 502 && /crt\.sh returned HTTP \d{3}/i.test(errText(body, threw));
}

/** Client AbortSignal / connect flake (status 0). Server 502/504 stay hard fails. */
function isClientTimeoutFlake(status, body, threw) {
  return status === 0 && /timeout|aborted|AbortError|ETIMEDOUT|UND_ERR_CONNECT|ECONNRESET|fetch failed/i.test(errText(body, threw));
}

// A 5xx RELAYED FROM A THIRD PARTY, as opposed to one of ours. Deliberately
// does not try to read intent from the message: a rate limit has its own lane
// above, and everything else in this class is "their host did not answer".
function isUpstreamFiveXx(status, body, threw) {
  if (status === 502 || status === 503 || status === 504) return true;
  return /timeout|aborted|AbortError|UND_ERR_CONNECT|ECONNRESET|ETIMEDOUT|fetch failed/i.test(errText(body, threw));
}

function shouldRetry(status, body, threw, slug) {
  // One retry on transient flakes. 503 is included because several free-public
  // handlers surface upstream rate limits as 503 (CoinGecko), not 429.
  // Permanent dead upstreams still fail on the second attempt (gov-data class).
  if (status === 502 || status === 503 || status === 504 || status === 429) return true;
  if (isUpstreamMediaSourceFlake(slug, status, body, threw)) return true;
  return /timeout|aborted|AbortError|UND_ERR_CONNECT|ECONNRESET|ETIMEDOUT|fetch failed|rate.?limit/i.test(errText(body, threw));
}

async function callExample(path, method, op, slug) {
  const isSkill = path.startsWith("/api/skill/");
  const timeout = isSkill ? SKILL_TIMEOUT_MS : TIMEOUT_MS;
  let url, init;
  if (method === "get") {
    const qs = new URLSearchParams();
    for (const p of op.parameters ?? []) {
      if (p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
    }
    url = `${TARGET}${path}${[...qs].length ? `?${qs}` : ""}`;
    init = {};
  } else {
    const example = op.requestBody?.content?.["application/json"]?.example ?? {};
    url = `${TARGET}${path}`;
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example) };
  }

  const attempt = async () => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      const ct = res.headers.get("content-type") || "";
      let body = null;
      if (ct.includes("application/json")) {
        try { body = await res.json(); } catch { body = { error: "non-json body" }; }
      } else {
        const buf = await res.arrayBuffer();
        body = { __bytes: buf.byteLength };
      }
      return { status: res.status, body, threw: null };
    } catch (e) {
      return { status: 0, body: null, threw: e.message || String(e) };
    }
  };

  // ESCALATING RETRY FOR THE UPSTREAM-5xx CLASS.
  //
  // Within one run, a permanently dead upstream and a momentary one are
  // indistinguishable: both are a 502 or a 504. The ONLY honest discriminator
  // is time, and the whole budget used to be a single retry 1,500ms later.
  // That is shorter than a provider wobble. Measured on 2026-08-24: DefiLlama
  // timed out once mid-run and blocked a merge, and answered in 1.9s when
  // asked again twenty minutes on; DexScreener, genuinely out for 2.5 hours,
  // failed every attempt as it should.
  //
  // So this spends MORE TIME rather than adding another soft-skip, and that is
  // the point. Nothing new becomes invisible: a dead upstream still fails every
  // attempt and still fails the build, which is exactly the gov-data guarantee
  // this file exists to hold. A blip gets long enough to clear.
  //
  // Only failing tools cost anything, and the escalation is capped: past
  // ESCALATE_MAX distinct tools this is not a blip, it is an outage, and
  // spending another ten minutes to confirm that helps nobody.
  let r = await attempt();
  let attempts = 1;
  if (!isStrictPass(r.status, r.body) && shouldRetry(r.status, r.body, r.threw, slug)) {
    await sleep(RETRY_BACKOFF_MS[0]);
    r = await attempt();
    attempts = 2;
    const escalate = !isStrictPass(r.status, r.body)
      && isUpstreamFiveXx(r.status, r.body, r.threw)
      && escalatedTools.size < ESCALATE_MAX;
    if (escalate) {
      escalatedTools.add(slug);
      for (let i = 1; i < RETRY_BACKOFF_MS.length && !isStrictPass(r.status, r.body); i++) {
        await sleep(RETRY_BACKOFF_MS[i]);
        r = await attempt();
        attempts++;
      }
    }
  }
  if (attempts > 1) retryStats.push({ slug, attempts, recovered: isStrictPass(r.status, r.body) });
  return r;
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

let srv = null;
let srvLog = "";
async function boot() {
  if (EXTERNAL) {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${TARGET}/health`)).ok) return; } catch { /* */ }
      await sleep(500);
    }
    throw new Error(`external server at ${TARGET} never became healthy`);
  }
  // Strip metered keys so a mis-filter cannot burn budget even if a slug slips
  // through. Keep DATA_GOV unset → DEMO_KEY (honest free-public path).
  const strip = [
    "BRAVE_API_KEY", "BRAVE_ANSWERS_API_KEY", "BRAVE_SUGGEST_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "E2B_API_KEY",
    "FRED_API_KEY", "FRED_API_KEY_V2", "NEYNAR_API_KEY", "WARPCAST_API_KEY",
    "ALCHEMY_API_KEY", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET",
    "X402_UPSTREAM_BUYER_KEY", "ALGORAND_UPSTREAM_BUYER_MNEMONIC",
    "DATA_GOV_API_KEY",
  ];
  const env = {
    ...process.env,
    FREE_MODE: "true",
    PORT: String(PORT),
    X402_INDEX_CRAWL: "off",
    AGENT402_MCP_MAX_PER_MIN: "999999",
    AGENT402_MCP_MAX_PER_HOUR: "9999999",
  };
  for (const k of strip) delete env[k];

  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => { srvLog += d; if (srvLog.length > 200_000) srvLog = srvLog.slice(-100_000); });
  srv.stderr.on("data", (d) => { srvLog += d; if (srvLog.length > 200_000) srvLog = srvLog.slice(-100_000); });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${TARGET}/health`)).ok) return; } catch { /* */ }
    if (srv.exitCode != null) throw new Error(`server exited ${srv.exitCode}:\n${srvLog.slice(-800)}`);
    await sleep(500);
  }
  throw new Error(`server never came up:\n${srvLog.slice(-800)}`);
}

function stop() {
  if (srv && srv.exitCode == null) {
    try { srv.kill("SIGTERM"); } catch { /* */ }
  }
}

// Control assertions: the graders must fail what they claim to fail before
// any live result is believed. Run from main(), never at import time, so the
// lenient sweep can import this file's scope without running a sweep.
function runControls() {
  // ── Offline controls (run before any live call) ─────────────────────────────
  // Pin the NETWORK hole: a handler 502 MUST fail this suite.
  ok(isStrictFailure(502, { error: "data.gov is not returning results" }, null) === true,
    "control: HTTP 502 is a hard fail (the NETWORK-lenient hole that hid gov-data)");
  ok(isRateLimited(502, { error: "data.gov is not returning results right now (upstream outage)" }, null) === false,
    "control: bare dead-upstream 502 is NOT a rate-limit soft-skip");
  ok(isRateLimited(502, { error: "Source URL returned HTTP 429" }, null) === true,
    "control: fetch-guard 429 wording is recognized as rate-limit");
  ok(isUpstreamMediaSourceFlake("media-info", 422, { error: "media could not be processed (is the input a valid audio/video file?)" }, null) === true,
    "control: Wikimedia media-source 422 is a soft-skip for media example slugs");
  ok(isUpstreamMediaSourceFlake("gov-data", 422, { error: "media could not be processed (is the input a valid audio/video file?)" }, null) === false,
    "control: media-source soft-skip does NOT apply outside media example slugs");
  ok(isTransientMalformedPriceFeed(502, { error: "Price feed upstream returned malformed JSON" }, null) === true,
    "control: price-feed malformed-JSON 502 is a soft-skip");
  ok(isTransientMalformedPriceFeed(502, { error: "data.gov is not returning results" }, null) === false,
    "control: bare dead-upstream 502 is NOT a price-feed soft-skip (gov-data class)");
  // The escalated-retry lane. It adds TIME, never a skip, so the controls that
  // matter are that the dead-upstream class is still in it (it will be retried
  // and still fail, which is the point) and that a rate limit is not dragged in
  // - that has its own lane and its own doctrine.
  ok(isUpstreamFiveXx(502, { error: "data.gov is not returning results" }, null) === true,
    "control: a bare dead-upstream 502 IS retried longer - and still fails, because a dead upstream fails every attempt");
  ok(isUpstreamFiveXx(504, { error: "DefiLlama request timed out or was unreachable" }, null) === true,
    "control: a relayed upstream timeout is the class this lane exists for");
  ok(isUpstreamFiveXx(0, null, "The operation was aborted due to timeout") === true,
    "control: a connection-level failure counts too");
  ok(isUpstreamFiveXx(200, { ok: true }, null) === false,
    "control: a healthy response is never escalated");
  ok(isUpstreamFiveXx(422, { error: "bad input" }, null) === false,
    "control: a 4xx is the caller's problem and is not retried for longer");
  ok(RETRY_BACKOFF_MS.length >= 3 && RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] >= 15000,
    `control: the escalation actually spends time (${RETRY_BACKOFF_MS.join("/")}ms) - 1.5s was shorter than a provider wobble`);
  ok(ESCALATE_MAX > 0 && ESCALATE_MAX <= 40,
    `control: escalation is capped at ${ESCALATE_MAX} tools, so an outage does not become a ten-minute wait`);

  // CoinGecko sampling. It reduces live coverage per run on purpose, so the
  // controls are about the sample being real, deterministic and honest rather
  // than about it being large.
  {
    const s1 = coingeckoSample("abc123");
    const s2 = coingeckoSample("abc123");
    ok(s1.size === 2, `control: the CoinGecko sample is ${s1.size} tools per run, not the whole family`);
    ok([...s1].join() === [...s2].join(),
      "control: the sample is DETERMINISTIC for a commit, so a re-run tests the same pair and a failure reproduces");
    const others = ["deadbeef", "cafe", "0f0f0f", "12345"].map((x) => [...coingeckoSample(x)].join());
    ok(new Set(others).size > 1,
      "control: it ROTATES across commits, so the family is covered over time rather than the same two forever");
    ok([...s1].every((x) => COINGECKO_SLUGS.has(x)),
      "control: only CoinGecko-backed slugs are ever sampled");
    ok(!COINGECKO_SLUGS.has("price-pyth") && !COINGECKO_SLUGS.has("defi-tvl"),
      "control: Pyth and DefiLlama tools are NOT in the CoinGecko family - they have their own upstreams and stay swept");
    ok(COINGECKO_SLUGS.has("crypto-price") && COINGECKO_SLUGS.has("coins-list") && COINGECKO_SLUGS.size === 24,
      `control: the family is the full 24 CoinGecko-backed slugs (got ${COINGECKO_SLUGS.size})`);
    ok(coingeckoSample("x", 99).size === COINGECKO_SLUGS.size,
      "control: raising the sample past the family size sweeps all of them, so the cap is a budget and not a lock");
  }

  ok(isClientTimeoutFlake(0, null, "The operation was aborted due to timeout") === true,
    "control: client AbortSignal timeout is a soft-skip");
  ok(isClientTimeoutFlake(504, { error: "timeout" }, null) === false,
    "control: server HTTP 504 timeout is NOT a client-timeout soft-skip");
  ok(isStrictFailure(503, { error: "capacity" }, null) === true,
    "control: HTTP 503 is a hard fail");
  ok(isStrictFailure(504, { error: "timeout" }, null) === true,
    "control: HTTP 504 is a hard fail");
  ok(isStrictPass(200, { query: "ok" }) === true, "control: HTTP 200 without body.error is a pass");
  ok(isStrictPass(200, { error: "nope" }) === false, "control: HTTP 200 with body.error is a fail");
  ok(excludeReason("gov-data", "/api/gov-data") === null,
    "control: gov-data is NOT metered (DEMO_KEY / DATA_GOV — must stay in-scope)");
  ok(excludeReason("search", "/api/search") === "metered_upstream_key_or_buyer",
    "control: Brave search is excluded from this suite");
  ok(excludeReason("llm", "/api/llm") === "metered_upstream_key_or_buyer",
    "control: OpenAI llm is excluded");
  ok(excludeReason("code-run", "/api/code-run") === "metered_upstream_key_or_buyer",
    "control: E2B code-run is excluded");
  ok(WALLET_ONLY_SLUGS.has("gov-data"),
    "control: gov-data is WALLET_ONLY (wallet-gated live) yet still in THIS suite's scope");
}


/** The strict sweep's work list from a served spec + pricing: every priced
 *  endpoint whose example spends no metered key. Exported so test-all.js can
 *  hand these routes over instead of driving them a second time. */
export function strictScope(spec, pricing) {
  const endpoints = pricing.endpoints || [];
  const byPath = new Map();
  for (const e of endpoints) byPath.set(e.path, e);

  const work = [];
  const excluded = [];

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const cat = (op.tags && op.tags[0]) || "other";
      if (cat === "workflows") continue;
      const ep = byPath.get(path);
      const slug = ep?.slug || path.replace(/^\/api\//, "").replace(/^\/v1\//, "v1-").replace(/\//g, "-");
      const priceUsd = parsePrice(ep?.price ?? op["x-price"] ?? 0);
      if (!(priceUsd > 0)) continue;
      const reason = excludeReason(slug, path);
      if (reason) {
        excluded.push({ slug, path, method, reason });
        continue;
      }
      work.push({ slug, path, method, op, priceUsd });
    }
  }
  return { work, excluded };
}

/** "METHOD /path" keys this sweep will actually assert on THIS commit - the
 *  CoinGecko tools sampled out of the run are deliberately NOT in the set, so
 *  the lenient sweep keeps exercising them rather than nobody doing so. */
export function strictScopeKeys(spec, pricing) {
  const { work } = strictScope(spec, pricing);
  return new Set(work.filter((t) => !(COINGECKO_SLUGS.has(t.slug) && !CG_LIVE.has(t.slug))).map((t) => `${t.method} ${t.path}`));
}

async function main() {
  runControls();
  console.log(`[non-metered] target=${TARGET} external=${EXTERNAL} concurrency=${CONCURRENCY}`);
  console.log(`[non-metered] metered slugs=${METERED_SLUGS.size} metered packs=${METERED_PACK_SLUGS.size}`);

  await boot();
  ok(true, `server healthy at ${TARGET}`);

  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
  const { work, excluded } = strictScope(spec, pricing);

  ok(work.length >= MIN_IN_SCOPE,
    `in-scope count is substantial (${work.length} ≥ ${MIN_IN_SCOPE}) — filter is not vacuous`);
  ok(work.some((t) => t.slug === "gov-data"),
    "gov-data is in the strict sweep (the #730 class must be covered)");
  ok(!work.some((t) => t.slug === "search" || t.slug === "llm" || t.slug === "code-run"),
    "metered Brave/OpenAI/E2B slugs are absent from the work list");
  ok(excluded.some((e) => e.slug === "search"),
    "Brave search was excluded by the filter (not merely absent from catalog)");

  console.log(`[non-metered] sweeping ${work.length} tools (excluded metered=${excluded.length})…`);

  let done = 0;
  let skippedBrowser = 0;
  let skippedRateLimit = 0;
  let skippedMediaSource = 0;
  let skippedPriceFeed = 0;
  let skippedCertTransparency = 0;
  let skippedClientTimeout = 0;
  const liveFails = [];
  // Documented-output-keys check on every strict pass. This used to live only
  // in test-all.js; now that the lenient sweep hands these routes over, the
  // check rides here so a route is never left with a status check but no
  // shape check.
  const shapeMismatches = [];

  await mapPool(work, CONCURRENCY, async (t) => {
    // Sampled out of this run's CoinGecko allowance. Skipped BEFORE the call,
    // because the whole point is not to spend the request.
    if (COINGECKO_SLUGS.has(t.slug) && !CG_LIVE.has(t.slug)) {
      skippedCoingecko++;
      done++;
      return;
    }
    const r = await callExample(t.path, t.method, t.op, t.slug);
    done++;
    if (done % 40 === 0 || done === work.length) {
      process.stdout.write(`\r[non-metered] ${done}/${work.length}`);
    }

    if (BROWSER_SLUGS.has(t.slug) && isBrowserUnavailable(r.status, r.body, r.threw)) {
      // Locally a missing Chromium is a fact of the machine; in CI the lane
      // that runs this sweep installs it, so "unavailable" there is a broken
      // install (or a cache hit on a browser that cannot launch) and must fail
      // rather than quietly leave render/screenshot asserted by nobody.
      if (process.env.CI) {
        liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}) → Chromium unavailable in CI: ${errText(r.body, r.threw).slice(0, 160)}`);
        return;
      }
      skippedBrowser++;
      console.log(`\nskip - ${t.slug}: Playwright Chromium unavailable locally (${errText(r.body, r.threw).slice(0, 120)})`);
      return;
    }

    if (isStrictPass(r.status, r.body)) {
      // A binary response is recorded here as { __bytes } - not a body to hold
      // against a JSON example (test-all.js records it as a byte count).
      const binary = r.body && r.body.__bytes !== undefined;
      const missing = binary ? [] : missingDocumentedKeys(t.path, t.op, r.body);
      if (missing.length) shapeMismatches.push(`${t.method} ${t.path} → missing documented keys: ${missing.join(",")}`);
      // Present-but-empty is its own failure: a published example that returns
      // nothing teaches an agent the tool is broken (2026-08-29, sweep-shape.js).
      const hollow = binary ? [] : emptyPromisedArrays(t.path, t.op, r.body);
      if (hollow.length) shapeMismatches.push(`${t.method} ${t.path} → documented example returns an EMPTY array for: ${hollow.join(",")} (its own published input produces nothing)`);
      return;
    }

    // A pure-CPU tool has no upstream to flake. Every soft-skip below exists
    // for a free-public provider wobbling; a hang or a 429 on a tool that
    // talks to nobody is OUR defect and must fail. Before the hand-over from
    // test-all.js (2026-08-25) that file graded these routes strictly; this
    // keeps that grade now that it no longer drives them. WALLET_ONLY_SLUGS is
    // the egress set, CI-proven by test-free-tier-egress.js.
    if (!WALLET_ONLY_SLUGS.has(t.slug)) {
      liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}, pure-CPU) → ${r.status || "threw"} ${errText(r.body, r.threw).slice(0, 160)}`);
      return;
    }

    // Rate-limit after retry = soft skip (test-gov-data DEMO_KEY doctrine). A
    // bare 502 with no rate-limit wording still fails — that is the dead-tool class.
    if (isRateLimited(r.status, r.body, r.threw)) {
      skippedRateLimit++;
      console.log(`\nskip - ${t.slug}: upstream rate-limited after retry (${r.status} ${errText(r.body, r.threw).slice(0, 100)})`);
      return;
    }

    if (isUpstreamMediaSourceFlake(t.slug, r.status, r.body, r.threw)) {
      skippedMediaSource++;
      console.log(`\nskip - ${t.slug}: upstream media source flaked after retry (${r.status} ${errText(r.body, r.threw).slice(0, 100)})`);
      return;
    }

    if (isTransientMalformedPriceFeed(r.status, r.body, r.threw)) {
      skippedPriceFeed++;
      console.log(`\nskip - ${t.slug}: price-feed upstream returned malformed JSON after retry (${r.status})`);
      return;
    }

    if (isCertTransparencyUpstreamFlake(t.slug, r.status, r.body, r.threw)) {
      skippedCertTransparency++;
      console.log(`\nskip - ${t.slug}: crt.sh (free public CT mirror) is returning 5xx after retry (${errText(r.body, r.threw).slice(0, 80)})`);
      return;
    }

    if (isClientTimeoutFlake(r.status, r.body, r.threw)) {
      skippedClientTimeout++;
      console.log(`\nskip - ${t.slug}: client timeout after retry (${errText(r.body, r.threw).slice(0, 100)})`);
      return;
    }

    const err = r.threw || (r.body && r.body.error) || `HTTP ${r.status}`;
    const msg = `${t.method.toUpperCase()} ${t.path} (${t.slug}) → ${r.status || "threw"} ${String(typeof err === "object" ? JSON.stringify(err) : err).slice(0, 160)}`;
    liveFails.push(msg);
  });
  process.stdout.write("\n");

  if (skippedBrowser) {
    console.log(`skip - ${skippedBrowser} browser tool(s) skipped (Chromium missing); CI installs Playwright and must not skip`);
  }
  if (skippedRateLimit) {
    console.log(`skip - ${skippedRateLimit} tool(s) soft-skipped after upstream rate-limit (retry exhausted)`);
  }
  if (skippedMediaSource) {
    console.log(`skip - ${skippedMediaSource} media tool(s) soft-skipped after upstream media-source flake (handlers covered by test-media.js)`);
  }
  if (skippedCertTransparency) {
    console.log(`skip - ${skippedCertTransparency} cert-transparency call(s) soft-skipped: crt.sh outage`);
  }
  if (skippedPriceFeed) {
    console.log(`skip - ${skippedPriceFeed} price-feed tool(s) soft-skipped after malformed-JSON upstream flake`);
  }
  if (skippedClientTimeout) {
    console.log(`skip - ${skippedClientTimeout} tool(s) soft-skipped after client timeout (retry exhausted)`);
  }

  const softSkipped = skippedBrowser + skippedRateLimit + skippedMediaSource + skippedPriceFeed + skippedClientTimeout + skippedCertTransparency;
  const asserted = work.length - softSkipped;
  ok(liveFails.length === 0,
    liveFails.length
      ? `every in-scope example returns 200 without body.error — ${liveFails.length} FAILED:\n     ${liveFails.slice(0, 30).join("\n     ")}${liveFails.length > 30 ? `\n     …and ${liveFails.length - 30} more` : ""}`
      : `every in-scope example returns 200 without body.error (${asserted} asserted, ${skippedBrowser} browser-skipped, ${skippedRateLimit} rate-limit-skipped, ${skippedMediaSource} media-source-skipped, ${skippedPriceFeed} price-feed-skipped, ${skippedClientTimeout} client-timeout-skipped)`);
  if (skippedCoingecko) {
    console.log(`\nskip - ${skippedCoingecko} CoinGecko tool(s) sampled out of this run (keyless is 30/min shared per IP)`);
    console.log(`  exercised live this commit: ${[...CG_LIVE].join(", ")}`);
    console.log(`  the sample rotates by commit, so the family is covered across runs rather than in one`);
  }

  // RETRIES ARE REPORTED, not just spent. A provider that needs three attempts
  // on every run is degrading, and the run before it goes down is the one where
  // that is worth seeing. A silent retry buys a green build and tells nobody.
  if (retryStats.length) {
    const recovered = retryStats.filter((r) => r.recovered);
    const escalated = retryStats.filter((r) => r.attempts > 2);
    console.log(`\nretries - ${retryStats.length} tool(s) needed more than one attempt, ${recovered.length} recovered` +
      (escalated.length ? `; ${escalated.length} needed the escalated upstream-5xx backoff` : ""));
    for (const r of escalated.slice(0, 10)) {
      console.log(`  ${r.recovered ? "recovered" : "still failing"} after ${r.attempts} attempts: ${r.slug}`);
    }
    if (escalatedTools.size >= ESCALATE_MAX) {
      console.log(`  escalation cap hit (${ESCALATE_MAX} tools) - that is an outage, not a blip; the rest were not re-attempted`);
    }
  }

  // Refuse a vacuous green where almost everything soft-skipped.
  //
  // CoinGecko sample-outs are ADDED BACK for this floor, and only those. They
  // are not coverage we lost to a flaky upstream, they are coverage we chose to
  // spend on a later run - we know exactly which tools and why, the sample
  // rotates so they are each exercised soon, and the count is printed above.
  // Every other skip still counts against the floor, because "we do not know
  // why this did not run" is what the floor exists to catch.
  ok(shapeMismatches.length === 0,
    `every strict pass carries its documented output keys (${shapeMismatches.length} mismatch(es))`);
  for (const m of shapeMismatches.slice(0, 40)) console.error(`  shape - ${m}`);

  const accounted = asserted + skippedCoingecko;
  ok(accounted >= Math.floor(MIN_IN_SCOPE * 0.8),
    `enough tools were actually asserted (${asserted} run + ${skippedCoingecko} deliberately sampled out = ${accounted}), not soft-skipped away`);

  console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed — in-scope=${work.length} excluded=${excluded.length}`);
  stop();
  process.exit(failed ? 1 : 0);
}

// Run only when executed directly. test-all.js imports strictScopeKeys() from
// this file to hand over the routes covered here; an import must never boot a
// server or start a sweep.
// realpath on both sides: Node resolves symlinks for import.meta.url but not
// for argv[1], so a run from a symlinked checkout (macOS /tmp -> /private/tmp)
// would otherwise exit 0 having run nothing.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  main().catch((e) => {
    console.error(e);
    stop();
    process.exit(1);
  });
}
