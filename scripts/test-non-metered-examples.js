#!/usr/bin/env node
// Strict FREE_MODE sweep of paid catalog tools that do NOT burn the operator's metered
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
//         OpenAI / OpenRouter / FRED / Neynar /
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
//   • media-info / audio-convert / audio-normalize: handlers are covered by
//     scripts/test-media.js on a local ffmpeg tone. Their examples fetch our
//     own /fixtures/sample-audio.wav since 2026-10-07 (third-party Wikimedia
//     before); the soft-skip stays for a fixture fetch that flakes. A 422 "media could not be processed" / content-type
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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
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
  "price-coingecko",
  "rwa-list", "rwa-markets", "rwa-asset", "rwa-issuers", "rwa-issuer",
  // crypto-screens-kit.js: the computed answers whose endpoints answer keyless
  // (its two pool tools need a key and are in METERED_SLUGS).
  "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board",
  // bundle-kit.js: token-diligence runs coin-profile and coin-ohlc per coin.
  "token-diligence",
]);
// KEYED OR KEYLESS. CI holds a CoinGecko key of its own (COINGECKO_CI_API_KEY,
// never the production key) and hands it ONLY to the server this sweep drives
// in the sweep lane, as COINGECKO_API_KEY on the pro tier, with this file's
// per-run read cap as the server's COINGECKO_DAILY_MAX (a fresh server's day is
// the run) and its minute pacing as COINGECKO_MAX_PER_MIN. The boot step tells
// the later steps which it got in one word (NON_METERED_CG_MODE=keyed|keyless,
// and NON_METERED_OM_MODE for Open-Meteo's OPEN_METEO_API_KEY); a fork PR gets
// no secrets and runs keyless. A self-booted sweep reads its own environment.
//
//   keyed:   CG_KEYED_SAMPLE_SIZE of the family per commit, still rotating.
//            A CoinGecko rate limit on a keyed read FAILS (the pacing sits
//            under the plan, so a keyed 429 is ours to explain), and so does
//            the server's own cap refusal: a spent cap fails the run, never a skip.
//   keyless: two per commit, and a CoinGecko rate limit is excused only when a
//            keyless read to a CoinGecko API host was refused 429 during the
//            call AND the runner's own direct read of that request is refused
//            429 too (the outage rule); otherwise it fails.
//
// THE PER-RUN READ CAP is sized from the reads each example makes (counted from
// the kits' read sites, CG_EXAMPLE_READS; one read unless listed) over
// everything the keyed server serves in one run: the sampled family members
// (the worst rotation), every non-metered skill pack that runs a family tool,
// and the metered screens the lenient sweep still drives (CG_KEYED_METERED_SLUGS).
// cgRunReadBound() adds them up and a control holds the cap above that bound
// with room for one retry in two. After the lenient sweep,
// `--coingecko-run-check` reads the server's own count of CoinGecko reads (the
// operator view of /api/gateway-status) and fails the run when the cap is
// spent or any keyed read was refused 429; it prints the count, which is the
// measurement the cap is tuned from.
export const CG_KEYLESS_SAMPLE_SIZE = 2;
export const CG_KEYED_SAMPLE_SIZE = 6;
export const CG_RUN_READ_CAP = 40;
// The minute pacing holds a whole keyed run (with room for one retry in four)
// and stays well under the per-minute limit of the key's plan: the lowest one
// src/tools/coingecko-rate.js records is 100 calls a minute (the Demo plan; the
// CI key's paid pro-tier plan allows more), and under the service's own
// default bucket of 80, so a keyed 429 is still ours to explain.
export const CG_RUN_MAX_PER_MIN = 40;
export const CG_PLAN_MIN_PER_MIN = 100;
// The BLS key (BLS_API_KEY, the BLS-backed macro tools) is capped per run the
// same way: the sweep server's BLS_DAILY_MAX is this (a fresh server's day is
// the run). The examples read a handful of series decades, each read once and
// cached, so 12 covers a run with one retry in two and spends at most that
// of the key's daily allowance.
export const BLS_RUN_READ_CAP = 12;
// The nightly corpus drives every CoinGecko case once with its own server.
export const CG_NIGHTLY_READ_CAP = 200;
export const CG_EXAMPLE_READS = Object.freeze({
  "crypto-price": 2, "stablecoin-peg": 2, "exchanges": 2, "rwa-asset": 2,
  "chain-board": 3, "token-diligence": 4, "dex-volume-board": 3, "dex-pool-health": 3,
});
// Metered (excluded here), but the lenient sweep drives them on the keyed server.
export const CG_KEYED_METERED_SLUGS = Object.freeze(["dex-volume-board", "dex-pool-health"]);
const cgReads = (slug) => CG_EXAMPLE_READS[slug] ?? 1;

/** "keyed" | "keyless" for the CoinGecko reads of the server this sweep
 *  drives, or null when an external server's mode was not handed over. */
export function cgMode(env = process.env, external = EXTERNAL) {
  if (!external) return String(env.COINGECKO_API_KEY || "").trim() ? "keyed" : "keyless";
  const m = String(env.NON_METERED_CG_MODE || "").trim();
  return m === "keyed" || m === "keyless" ? m : null;
}
/** The same for Open-Meteo (OPEN_METEO_API_KEY). */
export function omMode(env = process.env, external = EXTERNAL) {
  if (!external) return String(env.OPEN_METEO_API_KEY || "").trim() ? "keyed" : "keyless";
  const m = String(env.NON_METERED_OM_MODE || "").trim();
  return m === "keyed" || m === "keyless" ? m : null;
}
/** How many of the family run live per commit in this mode (NON_METERED_CG_SAMPLE overrides). */
export function cgSampleSize(mode, env = process.env) {
  const n = Number(env.NON_METERED_CG_SAMPLE);
  if (Number.isInteger(n) && n > 0) return n;
  return mode === "keyed" ? CG_KEYED_SAMPLE_SIZE : CG_KEYLESS_SAMPLE_SIZE;
}
/** The most CoinGecko reads one keyed run can make: the worst rotation of
 *  `size` family members, every non-metered pack that runs a family tool, and
 *  the metered screens the lenient sweep drives. */
export function cgRunReadBound(size = CG_KEYED_SAMPLE_SIZE, packs = SKILL_PACKS) {
  const all = [...COINGECKO_SLUGS].sort();
  let window = 0;
  for (let s = 0; s < all.length; s++) {
    let w = 0;
    for (let i = 0; i < Math.min(size, all.length); i++) w += cgReads(all[(s + i) % all.length]);
    window = Math.max(window, w);
  }
  const metered = meteredPackSlugs(packs);
  let packReads = 0;
  for (const p of packs) {
    if (metered.has(p.slug)) continue;
    for (const s of p.toolSlugs || []) if (COINGECKO_SLUGS.has(s)) packReads += cgReads(s);
  }
  const meteredReads = CG_KEYED_METERED_SLUGS.reduce((a, s) => a + cgReads(s), 0);
  return { window, packs: packReads, metered: meteredReads, total: window + packReads + meteredReads };
}
/** The server's own refusal when its CoinGecko read cap or pacing is spent
 *  (src/tools/coingecko-rate.js cgRefusalMessage). */
export function isCgOwnRefusal(status, body) {
  return status === 503 && /^This server's daily .+ allowance is used up|^This server paces its .+ requests and has no room/.test(String(body?.error || ""));
}
/** A family tool's answer that its CoinGecko read was rate-limited. */
export function isCgRateLimitAnswer(slug, status, body, threw = null) {
  return COINGECKO_SLUGS.has(slug) && status === 503 && isRateLimited(status, body, threw);
}
/** The verdict on a family tool's rate-limit answer: { verdict: "fail", reason }
 *  or { verdict: "upstream", evidence }. Keyed always fails. Keyless is
 *  excused only by a keyless GET to a CoinGecko API host refused 429 during
 *  the call that the runner's own direct read is refused 429 for too. */
export async function cgRateLimitVerdict({ mode, t0, t1, logPath = upstreamFailureLogPath(), readStatus = directReadStatus }) {
  if (mode !== "keyless") return { verdict: "fail", reason: `a ${mode || "unknown-mode"} CoinGecko read was rate-limited (a keyed 429 fails: the pacing sits under the plan)` };
  const rows = failuresBetween(t0, t1, logPath).filter((r) => CG_API_HOSTS.includes(String(r.host).toLowerCase()) && r.status === 429);
  if (!rows.length) return { verdict: "fail", reason: "no CoinGecko read refused 429 recorded during the call" };
  const row = rows[rows.length - 1];
  if (row.keyed || !row.url || row.method !== "GET") return { verdict: "fail", reason: `the refused read to ${row.host} is keyed or not a GET` };
  const got = await readStatus(row.url, row.accept ? { accept: row.accept } : undefined);
  if (got !== 429) return { verdict: "fail", reason: `${row.host} refused the server 429 but answers the runner's direct read of the same request ${got || "nothing"}` };
  return { verdict: "upstream", evidence: `${row.host} refused the server 429 and refuses the runner's direct read of the same request 429 too (keyless)` };
}
/** The run check after both sweeps: { ok, lines }. `used` is the server's
 *  CoinGecko read count (null when unreadable), `keyed429` the keyed reads
 *  refused 429 during the run. */
export function cgRunCheckVerdict({ mode, used, cap = CG_RUN_READ_CAP, keyed429 = 0 }) {
  if (mode === "keyless") return { ok: true, lines: ["ok - CoinGecko: keyless (no per-run read cap applies; each rate limit was read against the runner)"] };
  if (mode !== "keyed") return { ok: false, lines: ["FAIL - CoinGecko: the sweep server's mode was not handed over (NON_METERED_CG_MODE unset)"] };
  const lines = [];
  if (!Number.isFinite(used)) lines.push("FAIL - CoinGecko: keyed, but the server's read count could not be read (fails closed)");
  else if (used >= cap) lines.push(`FAIL - CoinGecko: keyed, the per-run read cap is spent (${used} of ${cap} reads): a spent cap fails the run`);
  else lines.push(`ok - CoinGecko: keyed, ${used} of ${cap} reads this run`);
  if (keyed429 > 0) lines.push(`FAIL - CoinGecko: ${keyed429} keyed read(s) refused 429 this run (a keyed 429 fails the run)`);
  return { ok: !lines.some((l) => l.startsWith("FAIL")), lines };
}

const CG_MODE = cgMode();
const OM_MODE = omMode();
const CG_SAMPLE_SIZE = cgSampleSize(CG_MODE);

/** `size` slugs of `family` to exercise live on commit `sha`: deterministic
 *  for a commit, rotating across commits. */
export function familySample(family, sha, size) {
  const all = [...family].sort();
  if (size >= all.length) return new Set(all);
  let h = 0;
  for (const ch of String(sha)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % all.length;
  const out = new Set();
  for (let i = 0; i < size; i++) out.add(all[(start + i) % all.length]);
  return out;
}
/** The CoinGecko slugs to exercise live on THIS commit. */
export function coingeckoSample(sha = process.env.GITHUB_SHA || "local", size = CG_SAMPLE_SIZE) {
  return familySample(COINGECKO_SLUGS, sha, size);
}
const CG_LIVE = coingeckoSample();
let skippedCoingecko = 0;

// OPEN-METEO'S 5xx IS READ AGAINST THE RUNNER.
//
// Production reads Open-Meteo with a paid key (OPEN_METEO_API_KEY). In CI the
// sweep lane's server gets that key too (NON_METERED_OM_MODE=keyed), and a
// keyed weather tool's rate limit or relayed 5xx then FAILS: the keyless probe
// below says nothing about the keyed host. Without it (a fork PR, a local
// run) the tools read the keyless public hosts, whose per-IP budget GitHub
// runners share, and the rule below applies. Keyless Open-Meteo answered a runner 503 on every one
// of four attempts for weather-daily (2026-11-17) and failed main's deploy
// while production served the same call. Every weather tool is swept here on
// every commit (none sampled out, so none is handed to test-all.js, whose
// list tolerates a 502/503/504), and a weather tool's relayed upstream 5xx
// ("Source URL's host returned HTTP 5xx") is excused only when this runner's
// own direct request for the same example also fails (RUNNER_PROBES,
// failureVerdict). If Open-Meteo answers the runner, the tool failing is ours
// and it fails, as does any other 5xx of ours.
export const OPEN_METEO_SLUGS = new Set(["weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality"]);

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
// The list lives in src/metered-slugs.js so the server can publish its count
// (/api/reliability); re-exported here for the scripts that import it.
import { METERED_SLUGS, meteredPackSlugs } from "../src/metered-slugs.js";
import { isFredMaintenancePage, fredMaintenanceError } from "../src/tools/macro-kit.js";
import { upstreamOutageVerdict, bundleOutageVerdict, upstreamFailureLogPath, failuresBetween, directReadStatus } from "./lib/upstream-outage.js";
import { CG_API_HOSTS } from "../src/tools/coingecko-endpoint.js";
import { BUNDLE_LEGS } from "../src/tools/bundle-kit.js";

// WHICH TOOLS HAVE AN UPSTREAM. WALLET_ONLY_SLUGS (src/pow.js) is the egress
// set: a tool outside it is graded below as pure computation, where a 429 or
// a 5xx is ours and fails. test-free-tier-egress.js holds the set to that
// meaning: it drives every tool outside it and fails one that reaches the
// network on its own example.
export function isPureCpuSlug(slug) { return !WALLET_ONLY_SLUGS.has(slug); }

// A BUNDLE PRODUCT (src/tools/bundle-kit.js) runs other network tools in
// process and answers a leg's source-side failure in its own words, naming
// the leg. That answer is graded as the leg's, ahead of every softer rule
// below: when the leg's message is the shared fetch helper's rate limit (429)
// or upstream failure, it is excused only when a failed request to a host the
// bundle declares was recorded during the call AND the runner's own direct
// read of that request fails the same way; otherwise it fails. Resolves null
// for any other answer, { skip } when excused, { fail } when not.
export async function bundleFailureGrade(t, r, opts = {}) {
  const legs = BUNDLE_LEGS[t.slug];
  if (!legs) return null;
  const v = await bundleOutageVerdict({ slug: t.slug, legs, status: r.status, body: r.body, t0: r.t0, t1: r.t1, ...opts });
  if (!v) return null;
  if (v.verdict === "upstream") return { skip: `${t.slug}: its leg ${v.leg} failed on the source's side and ${v.evidence} (upstream, not our defect)` };
  return { fail: `${String(t.method).toUpperCase()} ${t.path} (${t.slug}, leg ${v.leg}) → ${r.status} ${errText(r.body, r.threw).slice(0, 200)} [not excused: ${v.reason}]` };
}
export { METERED_SLUGS };

const BROWSER_SLUGS = new Set(["render", "screenshot", "page-speed", "html-frames"]);
// Handlers proven offline by scripts/test-media.js; live examples depend on
// Wikimedia (same URL for all three). Soft-skip source-host flakes only.
const MEDIA_EXAMPLE_SLUGS = new Set(["media-info", "audio-convert", "audio-normalize"]);

const METERED_PACK_SLUGS = meteredPackSlugs(SKILL_PACKS);

// Upstreams whose edge BLOCKS GitHub runners: Kalshi's Cloudflare answered the
// sweep an HTML 403 page on 2026-08-28 (both examples, same run) while the same
// request answered 200 from a laptop and from production. A strict sweep
// cannot tell that block from a dead tool, and the lenient test-all NETWORK
// set still calls them every run; production is watched by the tool alert.
const RUNNER_BLOCKED_SLUGS = new Set(["kalshi-markets", "kalshi-event", "kalshi-live-data", "kalshi-weather-index"]);

// A source that is down for everyone (not only for runners) is left out until a
// date, then is in scope again with no edit: an entry cannot outlive its outage
// unnoticed. An entry is [slug, "YYYY-MM-DD"]; remove it when the source
// answers again. None is open.
const SOURCE_OUTAGE_UNTIL = new Map([]);
export function sourceOutageExcluded(slug, now = new Date(), table = SOURCE_OUTAGE_UNTIL) {
  const until = table.get(slug);
  return Boolean(until) && now.toISOString().slice(0, 10) < until;
}

function excludeReason(slug, path) {
  if (METERED_SLUGS.has(slug)) return "metered_upstream_key_or_buyer";
  if (RUNNER_BLOCKED_SLUGS.has(slug)) return "upstream_blocks_github_runners";
  if (sourceOutageExcluded(slug)) return "source_outage_until_date";
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
  if ((status === 502 || status === 503 || status === 504) && /Source URL returned HTTP|Source URL did not serve a media file|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) {
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

// An upstream that stops answering THIS RUNNER (2026-09-25: RugCheck timed out
// on every GitHub-hosted run for hours while answering production and a local
// machine in under a second). A tool's own deadline 503, "<Label> did not
// answer the <step> read within our N s limit" or "<Label> is
// unreachable from here", counts as that only when the harness, from the same
// runner, cannot reach the upstream directly either; if the direct probe
// answers, the tool failing is ours and it fails. One probe per label per run.
const RUNNER_PROBES = {
  // The exact request sol-token-safety's published example makes (JUP summary).
  RugCheck: "https://api.rugcheck.xyz/v1/tokens/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/report/summary",
  // The exact request weather-history's published example makes.
  // The 12-hour forecast weather-forecast's published example reads (its
  // /points answer names this grid). A forecast office's grid can lapse ("Forecast
  // Grid Expired", a 503 to every request that names a JSON type) until the
  // office reissues it. A grid the point no longer maps to answers 404 here,
  // which never excuses anything.
  "NWS forecast": "https://api.weather.gov/gridpoints/OKX/33,42/forecast",
  "Open-Meteo archive": "https://archive-api.open-meteo.com/v1/archive?latitude=51.5074&longitude=-0.1278&start_date=2025-06-01&end_date=2025-06-07&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum%2Cwind_speed_10m_max&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto",
  // The keyless requests the other weather tools' published examples make
  // (src/tools/weather-kit.js; a control below holds each field list to it).
  "Open-Meteo current": `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ latitude: 48.8566, longitude: 2.3522, current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m", temperature_unit: "celsius", wind_speed_unit: "kmh", timezone: "auto" })}`,
  "Open-Meteo daily": `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ latitude: 35.6762, longitude: 139.6503, daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset", temperature_unit: "celsius", wind_speed_unit: "kmh", timezone: "auto", forecast_days: 7 })}`,
  "Open-Meteo hourly": `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ latitude: -33.8688, longitude: 151.2093, hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m", temperature_unit: "celsius", wind_speed_unit: "kmh", timezone: "auto", forecast_hours: 48 })}`,
  "Open-Meteo air quality": `https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({ latitude: 28.6139, longitude: 77.209, current: "us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone" })}`,
};
// A tool that relays its upstream's 5xx in the shared fetch helper's words
// ("Source URL's host returned HTTP 5xx"), which names no upstream: the slug
// says which one, and the same direct probe decides.
export const RELAYED_HOST_PROBES = {
  "weather-history": "Open-Meteo archive", "weather-forecast": "NWS forecast",
  "weather-current": "Open-Meteo current", "weather-daily": "Open-Meteo daily", "weather-hourly": "Open-Meteo hourly", "weather-air-quality": "Open-Meteo air quality",
};
export function runnerProbeLabel(status, body, slug = null) {
  if (status === 502 && RELAYED_HOST_PROBES[slug] && /^Source URL's host returned HTTP 5\d\d\b/.test(String(body?.error || ""))) return RELAYED_HOST_PROBES[slug];
  if (status !== 503) return null;
  // A report the upstream itself declined to build ("<Label> could not produce a
  // report right now (upstream)") is the same class: probed directly below, as
  // are both DNS answers (src/upstream-deadline.js upstreamUnreachable): a
  // lookup the resolver could not finish and a host name that did not resolve.
  const m = /^([\w ]+?) (?:did not answer the [\w -]+ read within our \d+ s limit|is unreachable from here|could not be reached: (?:this server's DNS lookup for its host failed|its host name did not resolve)|could not produce a report right now \(upstream\))/.exec(String(body?.error || ""));
  return m && RUNNER_PROBES[m[1]] ? m[1] : null;
}
const RUNNER_PROBE_UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";

// FRED'S SCHEDULED MAINTENANCE. FRED answers a maintenance window with an HTML
// page (HTTP 200) where its data should be, and the FRED tools then answer 503
// in exactly fredMaintenanceError()'s words. That answer is excused only when
// this runner, reading the same keyless CSV the tools read, gets the
// maintenance page too. If FRED serves data (or anything else) to the runner,
// the tool's claim is wrong and it fails. One probe per run.
const FRED_MAINTENANCE_MESSAGE = fredMaintenanceError().message;
export function isFredMaintenanceAnswer(status, body) {
  return status === 503 && String(body?.error || "") === FRED_MAINTENANCE_MESSAGE;
}
const FRED_PROBE_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10";
let fredProbeMemo = null;
function fredInMaintenanceForRunner() {
  if (!fredProbeMemo) {
    const t0 = Date.now();
    fredProbeMemo = fetch(FRED_PROBE_URL, { headers: { "User-Agent": RUNNER_PROBE_UA }, signal: AbortSignal.timeout(10_000) })
      .then(async (res) => {
        const inMaintenance = isFredMaintenancePage(await res.text());
        console.log(`\n# runner probe FRED: HTTP ${res.status} in ${Date.now() - t0} ms, ${inMaintenance ? "maintenance page" : "not the maintenance page"}`);
        return inMaintenance;
      })
      .catch((e) => { console.log(`\n# runner probe FRED: ${e?.name || "error"} after ${Date.now() - t0} ms (not counted as maintenance)`); return false; });
  }
  return fredProbeMemo;
}
/** A failed answer's verdict once the runner probe has been read: "runner"
 *  (excused: the upstream refuses this runner's own direct request for the
 *  same example too) or "fail". `answersRunner(label)` resolves true when
 *  the upstream answers the runner; only an answer runnerProbeLabel names
 *  ever reaches it, so any other 5xx of ours fails without a probe. */
export async function failureVerdict(status, body, slug, answersRunner = upstreamAnswersRunner) {
  const label = runnerProbeLabel(status, body, slug);
  if (!label) return { verdict: "fail", label: null };
  return (await answersRunner(label)) ? { verdict: "fail", label } : { verdict: "runner", label };
}
const runnerProbeMemo = new Map();
function upstreamAnswersRunner(label) {
  if (!runnerProbeMemo.has(label)) {
    // The same User-Agent the tool sends: an upstream that refuses our
    // identity from this runner must read as refusing, not as answering.
    // Answering means a 2xx to the exact example request: a 4xx to it is the
    // upstream refusing that request (the runner, or the report it names),
    // and the tool's timeout on the same request is then the upstream's, not
    // ours. Only the tool's own deadline or unreachable 503 in its exact words
    // reaches this probe, so a tool defect that answers anything else still fails.
    const t0 = Date.now();
    runnerProbeMemo.set(label, fetch(RUNNER_PROBES[label], { headers: { "User-Agent": RUNNER_PROBE_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) })
      .then((res) => { console.log(`\n# runner probe ${label}: HTTP ${res.status} in ${Date.now() - t0} ms${res.ok ? "" : " (not answering the example request)"}`); return res.ok; })
      .catch((e) => { console.log(`\n# runner probe ${label}: ${e?.name || "error"} after ${Date.now() - t0} ms`); return false; }));
  }
  return runnerProbeMemo.get(label);
}

// A KEYLESS UPSTREAM THAT REFUSES SHARED RUNNER ADDRESSES. Jupiter's keyless
// endpoint answers GitHub-hosted runners with an intermittent 503 while it
// serves production, and the sweep failed deploys on it. The tool says so in
// its own words: "<Label> upstream error (HTTP 5xx)" as a 502, a shape only
// the tool's upstream helper writes, naming the upstream and the status it
// returned. For an upstream listed here, that answer is retried once after a
// short delay and, if it comes back the same, reported with its evidence as
// an upstream refusal instead of failing the lane. Anything else stays a
// failure: our own 5xx (a 500, a 502 in any other words), a 4xx, and the
// same shape from an upstream not on this list.
export const SHARED_IP_LIMITED_UPSTREAMS = new Set(["Jupiter"]);
export function upstreamRefusalOf(status, body) {
  if (status !== 502) return null;
  const m = /^(.+?) upstream error \(HTTP (5\d\d)\)$/.exec(String(body?.error || ""));
  if (!m || !SHARED_IP_LIMITED_UPSTREAMS.has(m[1])) return null;
  return { label: m[1], upstreamStatus: Number(m[2]) };
}
const UPSTREAM_REFUSAL_RETRY_MS = 3000;

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

  let lastStart = 0;
  const attempt = async () => {
    lastStart = Date.now();
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
      return { status: res.status, body, threw: null, contentType: ct };
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
  // A listed keyless upstream refusing this runner: one retry, then reported.
  if (upstreamRefusalOf(r.status, r.body)) {
    await sleep(UPSTREAM_REFUSAL_RETRY_MS);
    r = await attempt();
    attempts = 2;
    retryStats.push({ slug, attempts, recovered: isStrictPass(r.status, r.body) });
    return { ...r, attempts, t0: lastStart, t1: Date.now() };
  }
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
  // The last attempt's window: the upstream failure log is read inside it.
  return { ...r, attempts, t0: lastStart, t1: Date.now() };
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
    "OPENAI_API_KEY", "OPENROUTER_API_KEY",
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

  // Examples that fetch this server's own /samples/ and /fixtures/ files are
  // answered by this server, never production (the CI boot loads the same).
  srv = spawn(process.execPath, ["--import", "./scripts/lib/own-examples-preload.js", "--import", "./scripts/lib/upstream-failure-log-preload.js", "src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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
  {
    // A fixed past entry, never a live one: excused the day before its date,
    // not on it, not today, and never for another slug.
    const past = new Map([["control-outage-slug", "2026-01-15"]]);
    ok(sourceOutageExcluded("control-outage-slug", new Date("2026-01-14T23:59:59Z"), past) === true
      && sourceOutageExcluded("control-outage-slug", new Date("2026-01-15T00:00:00Z"), past) === false
      && sourceOutageExcluded("control-outage-slug", new Date(), past) === false
      && sourceOutageExcluded("hash", new Date("2026-01-01T00:00:00Z"), past) === false,
      "control: a source-outage exclusion ends on its date, an expired one stops excusing a failure, and it covers only the named slugs");
  }
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
    const s1 = coingeckoSample("abc123", CG_KEYLESS_SAMPLE_SIZE);
    const s2 = coingeckoSample("abc123", CG_KEYLESS_SAMPLE_SIZE);
    ok(s1.size === 2, `control: the keyless CoinGecko sample is ${s1.size} tools per run, not the whole family`);
    ok([...s1].join() === [...s2].join(),
      "control: the sample is DETERMINISTIC for a commit, so a re-run tests the same pair and a failure reproduces");
    const others = ["deadbeef", "cafe", "0f0f0f", "12345"].map((x) => [...coingeckoSample(x)].join());
    ok(new Set(others).size > 1,
      "control: it ROTATES across commits, so the family is covered over time rather than the same two forever");
    ok([...s1].every((x) => COINGECKO_SLUGS.has(x)),
      "control: only CoinGecko-backed slugs are ever sampled");
    ok(!COINGECKO_SLUGS.has("lending-rates") && !COINGECKO_SLUGS.has("perp-funding"),
      "control: tools on other upstreams (contract reads, a perp venue) are NOT in the CoinGecko family - they stay swept");
    ok(COINGECKO_SLUGS.has("crypto-price") && COINGECKO_SLUGS.has("coin-search") && !COINGECKO_SLUGS.has("coins-list") && COINGECKO_SLUGS.size === 29,
      `control: the family is the full 29 keyless CoinGecko-backed slugs (got ${COINGECKO_SLUGS.size})`);
    ok(coingeckoSample("x", 99).size === COINGECKO_SLUGS.size,
      "control: raising the sample past the family size sweeps all of them, so the cap is a budget and not a lock");
  }

  // Keyed or keyless: the mode, the sample it buys and the per-run read cap.
  {
    ok(cgMode({ COINGECKO_API_KEY: "k" }, false) === "keyed" && cgMode({ COINGECKO_API_KEY: " " }, false) === "keyless" && cgMode({}, false) === "keyless",
      "control: a self-booted sweep is keyed exactly when its environment holds a CoinGecko key");
    ok(cgMode({ NON_METERED_CG_MODE: "keyed", COINGECKO_API_KEY: "" }, true) === "keyed" && cgMode({ NON_METERED_CG_MODE: "keyless", COINGECKO_API_KEY: "k" }, true) === "keyless" && cgMode({ COINGECKO_API_KEY: "k" }, true) === null && cgMode({ NON_METERED_CG_MODE: "yes" }, true) === null,
      "control: against an external server the mode is the boot step's word alone (this process never holds the key), and anything else is unknown");
    ok(omMode({ OPEN_METEO_API_KEY: "k" }, false) === "keyed" && omMode({ NON_METERED_OM_MODE: "keyless" }, true) === "keyless" && omMode({}, true) === null,
      "control: Open-Meteo's mode is read the same way");
    ok(cgSampleSize("keyed", {}) === CG_KEYED_SAMPLE_SIZE && cgSampleSize("keyless", {}) === CG_KEYLESS_SAMPLE_SIZE && cgSampleSize(null, {}) === CG_KEYLESS_SAMPLE_SIZE && cgSampleSize("keyed", { NON_METERED_CG_SAMPLE: "3" }) === 3,
      `control: keyed runs ${CG_KEYED_SAMPLE_SIZE} of the family per commit, keyless (or unknown) ${CG_KEYLESS_SAMPLE_SIZE}`);
    ok(CG_KEYED_SAMPLE_SIZE > CG_KEYLESS_SAMPLE_SIZE && CG_KEYED_SAMPLE_SIZE < COINGECKO_SLUGS.size,
      "control: the key buys a larger rotating sample, never the whole family on every push");
    const bound = cgRunReadBound();
    ok(bound.packs > 0 && bound.window >= CG_KEYED_SAMPLE_SIZE && bound.metered > 0,
      `control: the read bound counts the sample's worst rotation (${bound.window}), the skill packs that run a family tool (${bound.packs}) and the metered screens the lenient sweep drives (${bound.metered})`);
    ok(CG_RUN_READ_CAP >= Math.ceil(bound.total * 1.5) && CG_RUN_READ_CAP <= bound.total * 3,
      `control: the per-run read cap (${CG_RUN_READ_CAP}) covers the worst keyed run (${bound.total} reads) with one retry in two, and is no looser than three times it`);
    ok(cgRunReadBound(COINGECKO_SLUGS.size).total > CG_RUN_READ_CAP || CG_KEYED_SAMPLE_SIZE === COINGECKO_SLUGS.size,
      "control: the cap is what keeps the keyed sample below the whole family (sweeping all of it would not fit)");
    ok([...CG_KEYED_METERED_SLUGS].every((s) => METERED_SLUGS.has(s)) && Object.keys(CG_EXAMPLE_READS).every((s) => COINGECKO_SLUGS.has(s) || CG_KEYED_METERED_SLUGS.includes(s)),
      "control: every read count names a family tool or a metered screen the lenient sweep drives");
    ok(CG_NIGHTLY_READ_CAP >= cgRunReadBound(COINGECKO_SLUGS.size).total, `control: the nightly corpus cap (${CG_NIGHTLY_READ_CAP}) covers every family example once (${cgRunReadBound(COINGECKO_SLUGS.size).total})`);
    ok(CG_RUN_MAX_PER_MIN >= 30 && CG_RUN_MAX_PER_MIN >= Math.ceil(cgRunReadBound().total * 1.25), `control: the minute pacing (${CG_RUN_MAX_PER_MIN}) holds a whole keyed run inside one minute, so the pacing never refuses the sweep`);
    ok(CG_RUN_MAX_PER_MIN <= Math.floor(CG_PLAN_MIN_PER_MIN * 0.8) && readFileSync(new URL("../src/tools/coingecko-rate.js", import.meta.url), "utf8").includes(`${CG_PLAN_MIN_PER_MIN} calls/min`), `control: the minute pacing (${CG_RUN_MAX_PER_MIN}) stays under the lowest plan limit the rate module records (${CG_PLAN_MIN_PER_MIN}/min) with room for its retry path`);
    // The answers: our own cap refusal, the source's rate limit, anything else.
    const ownDay = { error: "This server's daily CoinGecko allowance is used up; it renews at 00:00 UTC. This is on our side, not your input. You were not charged." };
    const ownPace = { error: "This server paces its Market data requests and has no room this moment; retry in 1 s. This is on our side, not your input. You were not charged." };
    ok(isCgOwnRefusal(503, ownDay) && isCgOwnRefusal(503, ownPace) && !isCgOwnRefusal(502, ownDay) && !isCgOwnRefusal(503, { error: "CoinGecko rate-limited the request - retry shortly" }),
      "control: the server's own cap or pacing refusal is told apart from the source's rate limit");
    ok(isCgRateLimitAnswer("crypto-price", 503, { error: "CoinGecko rate-limited the request - retry shortly" }) && isCgRateLimitAnswer("coin-profile", 503, { error: "Market data upstream rate-limited this request - retry in about 60 seconds" }),
      "control: both CoinGecko kits' rate-limit answers are read as the source's rate limit");
    ok(!isCgRateLimitAnswer("crypto-price", 503, ownDay) && !isCgRateLimitAnswer("gov-data", 503, { error: "rate-limited" }) && !isCgRateLimitAnswer("crypto-price", 502, { error: "CoinGecko upstream HTTP 502 - try again later" }),
      "control: our own refusal, a tool outside the family and a 5xx are never the CoinGecko rate-limit rule's");
    ok(cgRunCheckVerdict({ mode: "keyed", used: 12 }).ok && !cgRunCheckVerdict({ mode: "keyed", used: CG_RUN_READ_CAP }).ok && !cgRunCheckVerdict({ mode: "keyed", used: null }).ok && !cgRunCheckVerdict({ mode: "keyed", used: 3, keyed429: 1 }).ok,
      "control: the run check fails a spent cap, an unreadable count and a keyed 429, and passes a keyed run under the cap");
    ok(cgRunCheckVerdict({ mode: "keyless", used: null }).ok && !cgRunCheckVerdict({ mode: null, used: 1 }).ok,
      "control: a keyless run has no cap to spend, and an unknown mode fails closed");
    ok(cgRunCheckVerdict({ mode: "keyed", used: 7 }).lines.join(" ").match(/\b7 of \d+ reads\b/) && !/[A-Za-z0-9]{24,}/.test(cgRunCheckVerdict({ mode: "keyed", used: 7 }).lines.join(" ")),
      "control: the run check prints the read count and the mode word, never a key");
  }

  // Open-Meteo's runner probes: a weather tool's relayed upstream 5xx is
  // excused only when the runner's own request for the same example fails too.
  {
    const weatherKit = readFileSync(join(ROOT, "src/tools/weather-kit.js"), "utf8");
    const toolSlugs = [...weatherKit.matchAll(/slug: "(weather-[a-z-]+)"/g)].map((m) => m[1]).sort();
    ok(toolSlugs.join() === [...OPEN_METEO_SLUGS].sort().join(), `control: the family is every tool in the Open-Meteo kit (${toolSlugs.join(", ")})`);
    const relayed = { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" };
    for (const slug of OPEN_METEO_SLUGS) {
      const label = runnerProbeLabel(502, relayed, slug);
      ok(Boolean(label) && /open-meteo\.com\//.test(RUNNER_PROBES[label] || ""), `control: ${slug}'s relayed upstream 5xx is probed against Open-Meteo (${label})`);
      ok(runnerProbeLabel(500, relayed, slug) === null && runnerProbeLabel(502, { error: "Upstream returned non-JSON" }, slug) === null && runnerProbeLabel(503, { error: "Weather data is temporarily unavailable because of a service problem on our side, not your input - retry later" }, slug) === null,
        `control: ${slug}'s own 5xx (a 500, a parse failure, a keyed refusal) is never a probe candidate`);
    }
    // Each probe is the request the tool's published example makes: its field list is the kit's.
    for (const label of ["Open-Meteo current", "Open-Meteo daily", "Open-Meteo hourly", "Open-Meteo air quality"]) {
      const q = new URL(RUNNER_PROBES[label]).searchParams;
      const fields = q.get("current") || q.get("daily") || q.get("hourly") || "";
      ok(fields.length > 20 && weatherKit.includes(`"${fields}"`) && !q.has("apikey"), `control: the ${label} probe asks the kit's own field list, keyless`);
    }
  }

  ok(isFredMaintenanceAnswer(503, { error: fredMaintenanceError().message }) === true,
    "control: the FRED tools' own maintenance 503 is a FRED-probe candidate");
  ok(isFredMaintenanceAnswer(502, { error: fredMaintenanceError().message }) === false
    && isFredMaintenanceAnswer(503, { error: "FRED returned no rows" }) === false
    && isFredMaintenanceAnswer(503, { error: `${fredMaintenanceError().message} and more` }) === false,
    "control: any other status or words from a FRED tool still fail");
  ok(isFredMaintenancePage("<!doctype html><html lang=\"en\"><head><title>Site Maintenance | St. Louis Fed</title>") === true
    && isFredMaintenancePage("observation_date,DGS10\n2026-10-20,4.01") === false,
    "control: the runner probe tells the maintenance page from FRED's CSV");
  ok(isClientTimeoutFlake(0, null, "The operation was aborted due to timeout") === true,
    "control: client AbortSignal timeout is a soft-skip");
  ok(isClientTimeoutFlake(504, { error: "timeout" }, null) === false,
    "control: server HTTP 504 timeout is NOT a client-timeout soft-skip");
  ok(runnerProbeLabel(503, { error: "RugCheck did not answer the report summary read within our 8 s limit; nothing was charged - retry shortly" }) === "RugCheck",
    "control: a tool's RugCheck deadline 503 is a runner-probe candidate");
  ok(runnerProbeLabel(503, { error: "RugCheck is unreachable from here (report read failed before any answer); nothing was charged - retry shortly" }) === "RugCheck",
    "control: a tool's RugCheck unreachable 503 is a runner-probe candidate");
  ok(runnerProbeLabel(503, { error: "RugCheck could not produce a report right now (upstream) - retry shortly" }) === "RugCheck",
    "control: a report RugCheck itself declined to build is a runner-probe candidate (excused only if RugCheck refuses the runner's direct request too)");
  ok(runnerProbeLabel(503, { error: "Solana RPC did not answer the getTokenLargestAccounts read within our 5 s limit; nothing was charged - retry shortly" }) === null
    && runnerProbeLabel(504, { error: "RugCheck upstream timed out" }) === null
    && runnerProbeLabel(503, { error: "RugCheck answered something unexpected" }) === null,
    "control: only a listed upstream's deadline, unreachable or report-refusal 503 is a candidate (an unlisted upstream, the old 504 words, or other words still fail)");
  ok(runnerProbeLabel(502, { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" }, "weather-history") === "Open-Meteo archive",
    "control: weather-history's relayed upstream 5xx is a runner-probe candidate (excused only if the archive refuses the runner's direct request too)");
  ok(runnerProbeLabel(502, { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" }, "weather-forecast") === "NWS forecast",
    "control: weather-forecast's relayed upstream 5xx is a runner-probe candidate (excused only if weather.gov refuses the runner's direct request for the example's grid too)");
  ok(runnerProbeLabel(502, { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" }, "public-holidays") === null
    && runnerProbeLabel(502, { error: "Source URL's host returned HTTP 404" }, "weather-history") === null
    && runnerProbeLabel(500, { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" }, "weather-history") === null
    && runnerProbeLabel(502, { error: "Open-Meteo returned no historical data" }, "weather-history") === null,
    "control: a relayed 5xx is a candidate only for a listed slug, only as a 502 naming a 5xx (another slug, a 4xx, our own 500 or other words still fail)");
  // Upstream refusals: only a listed keyless upstream, only the tool's own
  // "<Label> upstream error (HTTP 5xx)" 502, is reported instead of failing.
  ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 503)" })?.label === "Jupiter",
    "control: a tool's own Jupiter 5xx (as its 502) is an upstream-refusal candidate");
  ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 503)" })?.upstreamStatus === 503,
    "control: the refusal carries the status the upstream returned, as evidence");
  ok(upstreamRefusalOf(500, { error: "internal" }) === null && upstreamRefusalOf(502, { error: "internal" }) === null,
    "control: our own 5xx (a 500, or a 502 in our words) is NOT a refusal and still fails");
  ok(upstreamRefusalOf(500, { error: "Jupiter upstream error (HTTP 503)" }) === null,
    "control: the shape only counts on the 502 the upstream helper answers with");
  ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 404)" }) === null,
    "control: an upstream 4xx is not a refusal");
  ok(upstreamRefusalOf(502, { error: "DeFiLlama upstream error (HTTP 503)" }) === null && upstreamRefusalOf(502, { error: "Chain upstream error (HTTP 503)" }) === null,
    "control: the same shape from an upstream not listed as shared-IP-limited still fails");
  ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 503) and more" }) === null && upstreamRefusalOf(502, { error: "not Jupiter upstream error (HTTP 503)" }) === null,
    "control: the whole message must be the tool's own shape, not a fragment of it");
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
  ok(WALLET_ONLY_SLUGS.has("gov-data"),
    "control: gov-data is WALLET_ONLY (wallet-gated live) yet still in THIS suite's scope");
  // A bundle product reads every upstream its legs read: it is never graded
  // as pure computation, and neither is a leg.
  for (const [slug, legs] of Object.entries(BUNDLE_LEGS)) {
    ok(!isPureCpuSlug(slug) && legs.every((leg) => !isPureCpuSlug(leg)),
      `control: ${slug} and its legs (${legs.join(", ")}) are network tools, never graded as pure-CPU`);
  }
  ok(isPureCpuSlug("hash") && isPureCpuSlug("xlsx-create"), "control: a tool with no upstream is still graded as pure-CPU");
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
      // GET /api/jobs/{id}: a bearer job link a sweep cannot have (test-async-jobs covers it).
      if (cat === "jobs") continue;
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
 *  CoinGecko tools sampled out of the run are NOT in the set. */
export function strictScopeKeys(spec, pricing) {
  const { work } = strictScope(spec, pricing);
  return new Set(work.filter((t) => !(COINGECKO_SLUGS.has(t.slug) && !CG_LIVE.has(t.slug))).map((t) => `${t.method} ${t.path}`));
}

/** "METHOD /path" keys of the WHOLE CoinGecko family, sampled or not. The
 *  lenient sweep in the same CI lane hands ALL of them over: it used to keep
 *  the sampled-out tools "so somebody exercises them", but the lane carries
 *  COINGECKO_API_KEY, so every one of those calls was a keyed Demo-plan
 *  credit - measured 400-1,050 credits a day on the 10,000 a month plan
 *  (dashboard, 2026-09-07) against ~10 production calls a day, which would
 *  have exhausted the PRODUCTION key's quota before month end. The sample
 *  covers the family across commits; the nightly corpus drives all of it. */
export function coingeckoFamilyKeys(spec, pricing) {
  const { work } = strictScope(spec, pricing);
  return new Set(work.filter((t) => COINGECKO_SLUGS.has(t.slug)).map((t) => `${t.method} ${t.path}`));
}

/** Stub controls for failureVerdict: a stub upstream that answers, a stub
 *  one that refuses, and a stub "tool" that answers each failure shape. */
export async function runVerdictStubControls() {
  const { createServer } = await import("node:http");
  const listen = (handler) => new Promise((resolve) => { const srv = createServer(handler); srv.listen(0, "127.0.0.1", () => resolve(srv)); });
  const upstreamUp = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const upstreamDown = await listen((req, res) => { res.writeHead(503); res.end("busy"); });
  const shapes = {
    "/ours-500": [500, { error: "Internal error" }],
    "/ours-nonjson": [502, { error: "Upstream returned non-JSON" }],
    "/relayed": [502, { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" }],
  };
  const tool = await listen((req, res) => { const [st, b] = shapes[req.url]; res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); });
  const url = (srv, p = "/") => `http://127.0.0.1:${srv.address().port}${p}`;
  const probeAt = (srv) => async () => { try { return (await fetch(url(srv))).ok; } catch { return false; } };
  try {
    for (const slug of OPEN_METEO_SLUGS) {
      const call = async (p) => { const r = await fetch(url(tool, p)); return [r.status, await r.json()]; };
      const [s500, b500] = await call("/ours-500");
      const [sNj, bNj] = await call("/ours-nonjson");
      const [sRel, bRel] = await call("/relayed");
      ok((await failureVerdict(sRel, bRel, slug, probeAt(upstreamUp))).verdict === "fail",
        `control (stub): ${slug} relays an upstream 5xx while the stub upstream answers the runner: it fails`);
      ok((await failureVerdict(sRel, bRel, slug, probeAt(upstreamDown))).verdict === "runner",
        `control (stub): ${slug} relays an upstream 5xx and the stub upstream refuses the runner too: excused`);
      for (const [st, b, what] of [[s500, b500, "a 500"], [sNj, bNj, "a non-JSON parse 502"]]) {
        ok((await failureVerdict(st, b, slug, probeAt(upstreamDown))).verdict === "fail", `control (stub): ${slug}'s own ${what} fails even when the stub upstream refuses the runner`);
      }
    }
  } finally { for (const s of [upstreamUp, upstreamDown, tool]) s.close(); }
  await runBundleStubControls();
}

/** Stub controls for bundleFailureGrade: the exact answer a rate-limited
 *  forecast host produced (2026-11-19, six of six sites), a recorded 429 to
 *  that host, and a stub runner read that is refused too, or is answered. */
export async function runBundleStubControls() {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "a402-bundle-grade-"));
  const logPath = join(dir, "failures.jsonl");
  const limitedWords = "The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at api.open-meteo.com; retry later";
  const answer = (leg, words) => ({ status: 503, t0: 900, t1: 1100, threw: null, body: { error: `6 of 6 unit(s) could not be completed on the source's side (first: Chicago DC, ${leg}: ${words}). Nothing was charged; retry later` } });
  const t = { slug: "weather-risk-brief", method: "post", path: "/api/weather-risk-brief" };
  const record = (o) => writeFileSync(logPath, `${JSON.stringify({ t: 1000, host: "api.open-meteo.com", method: "GET", keyed: false, status: 429, url: "https://api.open-meteo.com/v1/forecast?latitude=41.88&longitude=-87.63&hourly=temperature_2m&forecast_hours=168", ...o })}\n`);
  const runnerGets = (status) => ({ logPath, readStatus: async () => status, readFails: async () => status === 0 || status >= 500 || status === 429 });
  try {
    record({});
    const refusedToo = await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(429));
    ok(Boolean(refusedToo?.skip) && /weather-thresholds/.test(refusedToo.skip), "control (stub): weather-risk-brief's leg was rate-limited (429) and the runner's direct read is refused 429 too: excused, leg named");
    const answered = await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(200));
    ok(Boolean(answered?.fail) && /leg weather-thresholds/.test(answered.fail), "control (stub): weather-risk-brief's leg was rate-limited while the host answers the runner's direct read: it FAILS");
    ok(Boolean((await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(503)))?.fail), "control (stub): a 429 the runner is answered 503 for is not the same refusal: it FAILS");
    record({ host: "elsewhere.example" });
    ok(Boolean((await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(429)))?.fail), "control (stub): a 429 from a host the bundle does not declare excuses nothing");
    record({ keyed: true, url: undefined });
    ok(Boolean((await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(429)))?.fail), "control (stub): a keyed request is never re-read and excuses nothing");
    rmSync(logPath, { force: true });
    ok(Boolean((await bundleFailureGrade(t, answer("weather-thresholds", limitedWords), runnerGets(429)))?.fail), "control (stub): no refused request recorded during the call excuses nothing");
    record({});
    ok(await bundleFailureGrade(t, answer("weather-thresholds", "Open-Meteo returned no hourly data"), runnerGets(429)) === null
      && await bundleFailureGrade(t, { status: 500, body: { error: "Internal error" }, t0: 900, t1: 1100 }, runnerGets(429)) === null,
      "control (stub): a leg's own failure and the bundle's own 500 are not read as an outage (they fail by the rules below)");
    ok(await bundleFailureGrade({ slug: "weather-daily", method: "get", path: "/api/weather-daily" }, answer("weather-thresholds", limitedWords), runnerGets(429)) === null,
      "control (stub): a tool that is not a bundle product is never graded by the bundle rule");
    record({ status: 503, url: "https://archive-api.open-meteo.com/v1/archive?latitude=41.88&longitude=-87.63", host: "archive-api.open-meteo.com" });
    const relayed = { ...answer("weather-history", "Source URL's host returned HTTP 503 - upstream issue, try again later"), status: 502 };
    ok(Boolean((await bundleFailureGrade(t, relayed, runnerGets(503)))?.skip) && Boolean((await bundleFailureGrade(t, relayed, runnerGets(200)))?.fail),
      "control (stub): a leg's relayed upstream 5xx is excused only when the runner's direct read fails too");
    // token-diligence: the market kit's own rate-limit words, a recorded 429
    // from the keyless market host, and the runner's read of the same request.
    const tk = { slug: "token-diligence", method: "post", path: "/api/token-diligence" };
    const tkAnswer = { status: 503, t0: 900, t1: 1100, threw: null, body: { error: "4 of 4 unit(s) could not be completed on the source's side (first: bitcoin, coin-profile: Market data upstream rate-limited this request - retry in about 60 seconds). Nothing was charged; retry later" } };
    record({ host: "api.coingecko.com", url: "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false" });
    const tkRefused = await bundleFailureGrade(tk, tkAnswer, runnerGets(429));
    ok(Boolean(tkRefused?.skip) && /coin-profile/.test(tkRefused.skip), "control (stub): token-diligence's leg was rate-limited (429) and the runner's direct read is refused 429 too: excused, leg named");
    ok(Boolean((await bundleFailureGrade(tk, tkAnswer, runnerGets(200)))?.fail), "control (stub): token-diligence's leg was rate-limited while the market host answers the runner's direct read: it FAILS");
    ok(await bundleFailureGrade(tk, { ...tkAnswer, body: { error: tkAnswer.body.error.replace("Market data upstream rate-limited this request - retry in about 60 seconds", "This server paces its Market data requests and has no room this moment; retry in 1 s. This is on our side, not your input. You were not charged.") } }, runnerGets(429)) === null,
      "control (stub): token-diligence's leg refused by this server's own pacing is not read as the source's limit (it fails by the rules below)");
    // A standalone family tool's rate limit: keyed fails; keyless is excused
    // only by a recorded keyless 429 the runner's direct read gets too.
    const cgUrl = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
    const cg = (mode, got) => cgRateLimitVerdict({ mode, t0: 900, t1: 1100, logPath, readStatus: async () => got });
    record({ host: "api.coingecko.com", url: cgUrl });
    ok((await cg("keyless", 429)).verdict === "upstream", "control (stub): keyless, a recorded keyless 429 the runner's direct read is refused 429 for too: excused");
    ok((await cg("keyless", 200)).verdict === "fail" && (await cg("keyless", 503)).verdict === "fail", "control (stub): keyless, a 429 the runner is answered 200 (or another status) for: it FAILS");
    ok((await cg("keyed", 429)).verdict === "fail" && (await cg(null, 429)).verdict === "fail", "control (stub): keyed (or an unknown mode), a CoinGecko rate limit FAILS whatever the runner reads");
    record({ host: "api.coingecko.com", keyed: true, url: undefined });
    ok((await cg("keyless", 429)).verdict === "fail", "control (stub): a keyed 429 row is never re-read and excuses nothing");
    record({ host: "api.coingecko.com", url: cgUrl, status: 503 });
    ok((await cg("keyless", 429)).verdict === "fail", "control (stub): a recorded 503 is not the 429 the tool reported");
    rmSync(logPath, { force: true });
    ok((await cg("keyless", 429)).verdict === "fail", "control (stub): no refused CoinGecko read recorded during the call excuses nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  runControls();
  console.log(`[non-metered] target=${TARGET} external=${EXTERNAL} concurrency=${CONCURRENCY}`);
  // The words only, never a key: keyed or keyless for each source.
  console.log(`[non-metered] CoinGecko: ${CG_MODE || "unknown"} (${CG_LIVE.size} of ${COINGECKO_SLUGS.size} live this commit); Open-Meteo: ${OM_MODE || "unknown"}`);
  if (process.env.CI && EXTERNAL) {
    ok(CG_MODE !== null && OM_MODE !== null, `the sweep server's boot step handed over its modes (NON_METERED_CG_MODE=${CG_MODE || "unset"}, NON_METERED_OM_MODE=${OM_MODE || "unset"})`);
  }
  console.log(`[non-metered] metered slugs=${METERED_SLUGS.size} metered packs=${METERED_PACK_SLUGS.size}`);

  await boot();
  ok(true, `server healthy at ${TARGET}`);

  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
  const scope = strictScope(spec, pricing);
  const { excluded } = scope;
  let { work } = scope;
  // Every weather tool is swept here on every commit, so test-all.js (which
  // skips what strictScopeKeys names and tolerates a 502/503/504) never
  // grades one of them.
  {
    const handed = strictScopeKeys(spec, pricing);
    const weather = work.filter((t) => OPEN_METEO_SLUGS.has(t.slug));
    ok(weather.length === OPEN_METEO_SLUGS.size && weather.every((t) => handed.has(`${t.method} ${t.path}`)),
      `every Open-Meteo tool is in this sweep's scope and its hand-over to test-all.js (${weather.map((t) => t.slug).join(", ")})`);
  }
  await runVerdictStubControls();

  ok(work.length >= MIN_IN_SCOPE,
    `in-scope count is substantial (${work.length} ≥ ${MIN_IN_SCOPE}) — filter is not vacuous`);
  ok(work.some((t) => t.slug === "gov-data"),
    "gov-data is in the strict sweep (the #730 class must be covered)");
  ok(!work.some((t) => t.slug === "search" || t.slug === "llm"),
    "metered Brave/OpenAI slugs are absent from the work list");
  ok(excluded.some((e) => e.slug === "search"),
    "Brave search was excluded by the filter (not merely absent from catalog)");

  // NON_METERED_ONLY=slug,slug narrows the run to the named in-scope tools
  // (a trace of one tool, driven and graded exactly as in the full sweep, a
  // sampled family member included). It is refused under CI, where a narrowed
  // run would pass with almost nothing asserted.
  const only = new Set(String(process.env.NON_METERED_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (only.size) {
    if (process.env.CI) throw new Error("NON_METERED_ONLY narrows the sweep and is refused under CI");
    work = work.filter((t) => only.has(t.slug));
    ok(work.length === only.size, `NON_METERED_ONLY: every named tool is in scope (${work.map((t) => t.slug).join(", ") || "none"})`);
  }

  console.log(`[non-metered] sweeping ${work.length} tools (excluded metered=${excluded.length})…`);

  let done = 0;
  let skippedBrowser = 0;
  let skippedRateLimit = 0;
  let skippedMediaSource = 0;
  let skippedPriceFeed = 0;
  let skippedCertTransparency = 0;
  let skippedClientTimeout = 0;
  let skippedRunnerUnreachable = 0;
  let skippedFredMaintenance = 0;
  const upstreamRefusals = [];
  const liveFails = [];
  // Documented-output-keys check on every strict pass. This used to live only
  // in test-all.js; now that the lenient sweep hands these routes over, the
  // check rides here so a route is never left with a status check but no
  // shape check.
  const shapeMismatches = [];

  await mapPool(work, CONCURRENCY, async (t) => {
    // Sampled out of this run's CoinGecko allowance. Skipped BEFORE the call,
    // because the whole point is not to spend the request.
    if (COINGECKO_SLUGS.has(t.slug) && !CG_LIVE.has(t.slug) && !only.has(t.slug)) {
      skippedCoingecko++;
      done++;
      return;
    }
    const r = await callExample(t.path, t.method, t.op, t.slug);
    done++;
    if (only.size) console.log(`\nattempts - ${t.slug}: ${r.attempts} (answered ${r.status || "nothing"})`);
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
      // The content type the published example answered with is the one its
      // listing names: /openapi.json lists the listing's type first (the
      // def's mimeType, which the x402 listing and /api/pricing also carry).
      // Held wherever either side is not JSON, so a tool that answers raw
      // bytes while it is listed as JSON fails here, and so does the reverse.
      {
        const declared = Object.keys(t.op?.responses?.["200"]?.content || {});
        const answered = String(r.contentType || "").split(";")[0].trim().toLowerCase();
        if (declared.length && (answered !== "application/json" || declared[0] !== "application/json") && answered !== declared[0]) {
          shapeMismatches.push(`${t.method} ${t.path} → published example answered ${answered || "no content type"}, its listing names ${declared[0]}`);
        }
      }
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
    if (isPureCpuSlug(t.slug)) {
      liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}, pure-CPU) → ${r.status || "threw"} ${errText(r.body, r.threw).slice(0, 160)}`);
      return;
    }

    // A bundle's leg failing on the source's side: read against the runner
    // before the rate-limit skip below, which asks the runner nothing.
    const bundle = await bundleFailureGrade(t, r);
    if (bundle?.skip) {
      skippedRunnerUnreachable++;
      console.log(`\nskip - ${bundle.skip}`);
      return;
    }
    if (bundle?.fail) {
      liveFails.push(bundle.fail);
      return;
    }

    // The server's own CoinGecko cap or pacing refused the read: in CI that is
    // the per-run read cap (or its minute pacing) spent, which fails the run.
    if (isCgOwnRefusal(r.status, r.body)) {
      liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}) → ${r.status} ${errText(r.body, r.threw).slice(0, 120)} [this server's CoinGecko read cap (${CG_RUN_READ_CAP} a run in CI) or its pacing is spent: a spent cap fails the run]`);
      return;
    }
    // A family tool's CoinGecko rate limit: keyed fails, keyless is read
    // against the runner (cgRateLimitVerdict). Never the soft-skip below.
    if (isCgRateLimitAnswer(t.slug, r.status, r.body, r.threw)) {
      const v = await cgRateLimitVerdict({ mode: CG_MODE, t0: r.t0, t1: r.t1 });
      if (v.verdict === "upstream") {
        skippedRunnerUnreachable++;
        console.log(`\nskip - ${t.slug}: ${v.evidence} (upstream, not our defect)`);
        return;
      }
      liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}) → ${r.status} ${errText(r.body, r.threw).slice(0, 120)} [not excused: ${v.reason}]`);
      return;
    }
    // A weather tool that read Open-Meteo keyed: a rate limit or an upstream
    // 5xx is not excused by the runner's keyless probe, which says nothing
    // about the keyed host. It fails.
    if (OPEN_METEO_SLUGS.has(t.slug) && OM_MODE === "keyed" && (isRateLimited(r.status, r.body, r.threw) || runnerProbeLabel(r.status, r.body, t.slug))) {
      liveFails.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}) → ${r.status} ${errText(r.body, r.threw).slice(0, 120)} [not excused: Open-Meteo was read keyed, and a keyed refusal is ours to explain]`);
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

    const refusal = upstreamRefusalOf(r.status, r.body);
    if (refusal) {
      upstreamRefusals.push(`${t.method.toUpperCase()} ${t.path} (${t.slug}): ${refusal.label} answered HTTP ${refusal.upstreamStatus} on ${r.attempts} attempt(s), ${UPSTREAM_REFUSAL_RETRY_MS} ms apart; tool said ${r.status} "${errText(r.body, r.threw).slice(0, 100)}"`);
      return;
    }

    if (isFredMaintenanceAnswer(r.status, r.body) && await fredInMaintenanceForRunner()) {
      skippedFredMaintenance++;
      console.log(`\nskip - ${t.slug}: FRED serves its maintenance page to this runner too (upstream window, not our defect)`);
      return;
    }

    const { verdict, label: probeLabel } = await failureVerdict(r.status, r.body, t.slug);
    if (verdict === "runner") {
      skippedRunnerUnreachable++;
      console.log(`\nskip - ${t.slug}: ${probeLabel} does not answer this runner directly either (upstream refusing or unreachable from here; not our defect)`);
      return;
    }
    // Any keyless public upstream (scripts/lib/upstream-outage.js): the
    // shared fetch helper's upstream-error answer, a failed request to a host
    // the tool's own definition names recorded during this call by the
    // server's preload, and the runner's direct read of that same request
    // failing too. An access refusal (401/403/429) is excused only when the
    // runner's direct read gets that same status. Otherwise this fails below.
    const outage = await upstreamOutageVerdict({ slug: t.slug, status: r.status, body: r.body, t0: r.t0, t1: r.t1 });
    if (outage.verdict === "upstream") {
      skippedRunnerUnreachable++;
      console.log(`\nskip - ${t.slug}: ${outage.evidence} (upstream, not our defect)`);
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
  if (skippedRunnerUnreachable) {
    console.log(`skip - ${skippedRunnerUnreachable} tool(s) soft-skipped: their upstream does not answer this runner directly (checked once per upstream)`);
  }

  if (skippedFredMaintenance) {
    console.log(`skip - ${skippedFredMaintenance} FRED tool(s) soft-skipped: FRED is in scheduled maintenance for this runner too (checked once)`);
  }

  if (upstreamRefusals.length) {
    console.log(`skip - ${upstreamRefusals.length} tool(s) reported as upstream refusals: a keyless upstream listed in SHARED_IP_LIMITED_UPSTREAMS refused this runner twice (evidence below)`);
    for (const line of upstreamRefusals) console.log(`  upstream refusal - ${line}`);
  }

  const softSkipped = skippedBrowser + skippedRateLimit + skippedMediaSource + skippedPriceFeed + skippedClientTimeout + skippedCertTransparency + skippedRunnerUnreachable + skippedFredMaintenance + upstreamRefusals.length;
  // A sampled-out tool was never called: it is not counted as asserted.
  const asserted = work.length - softSkipped - skippedCoingecko;
  ok(liveFails.length === 0,
    liveFails.length
      ? `every in-scope example returns 200 without body.error — ${liveFails.length} FAILED:\n     ${liveFails.slice(0, 30).join("\n     ")}${liveFails.length > 30 ? `\n     …and ${liveFails.length - 30} more` : ""}`
      : `every in-scope example returns 200 without body.error (${asserted} asserted, ${skippedBrowser} browser-skipped, ${skippedRateLimit} rate-limit-skipped, ${skippedMediaSource} media-source-skipped, ${skippedPriceFeed} price-feed-skipped, ${skippedClientTimeout} client-timeout-skipped)`);
  if (skippedCoingecko) {
    console.log(`\nskip - ${skippedCoingecko} CoinGecko tool(s) sampled out of this run (${CG_MODE === "keyed" ? `keyed: ${CG_LIVE.size} a run under the per-run read cap` : "keyless is 30/min shared per IP"})`);
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
  if (only.size) console.log(`# narrowed run (NON_METERED_ONLY): ${asserted} of ${work.length} named tool(s) asserted; the coverage floor is a full sweep's`);
  else ok(accounted >= Math.floor(MIN_IN_SCOPE * 0.8),
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

/** --coingecko-run-check: after both sweeps, against the keyed server. Reads
 *  the server's own CoinGecko read count (the operator view of
 *  /api/gateway-status, with the run's own token) and the keyed 429s in the
 *  upstream failure log, and fails the run on a spent cap or a keyed 429. */
async function coingeckoRunCheck() {
  let used = null;
  if (CG_MODE === "keyed") {
    try {
      const res = await fetch(`${TARGET}/api/gateway-status`, { headers: { "X-Operator-Token": String(process.env.SWEEP_OPERATOR_TOKEN || "") }, signal: AbortSignal.timeout(15_000) });
      const n = (await res.json())?.upstreamBudgets?.upstreams?.coingecko?.callsToday;
      used = Number.isFinite(n) ? n : null;
    } catch { used = null; }
  }
  const keyed429 = failuresBetween(0, Number.MAX_SAFE_INTEGER).filter((r) => CG_API_HOSTS.includes(String(r.host).toLowerCase()) && r.keyed && r.status === 429).length;
  const v = cgRunCheckVerdict({ mode: CG_MODE, used, keyed429 });
  for (const line of v.lines) console.log(line);
  process.exit(v.ok ? 0 : 1);
}

if (isMain && process.argv.includes("--controls")) {
  // The graders' own controls, offline (stub servers only): no sweep, no boot.
  (async () => {
    runControls();
    await runVerdictStubControls();
    console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed (controls only)`);
    process.exit(failed ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
} else if (isMain && process.argv.includes("--coingecko-run-check")) {
  coingeckoRunCheck().catch((e) => { console.error(e); process.exit(1); });
} else if (isMain) {
  main().catch((e) => {
    console.error(e);
    stop();
    process.exit(1);
  });
}
