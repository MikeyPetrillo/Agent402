// PostHog product analytics + error tracking — opt-in, no-op without an API key.
//
// Mirrors src/sentry.js (and the cache.js / analytics-db.js pattern): if
// POSTHOG_API_KEY is unset, every export here is a safe no-op so the server
// boots and serves identically. Set the key and the next deploy starts
// streaming error events to PostHog.
//
// Why this exists alongside Sentry: PostHog's free tier is ~200x larger
// (1M events/mo vs ~5k) and combines error tracking with product analytics in
// a single tool. The Sentry adapter stays as scaffolding — both can be turned
// on together, or only one. Both are env-gated and independent.
//
// Privacy posture matches the rest of the project:
//   - No caller IP, wallet, payment, body, headers, or query values are sent.
//   - distinctId is a fixed server-side identifier (we have no end-user — the
//     "user" of a tool error is the catalog operator, not the calling agent).
//   - shape tag is keys-only ("b:url", "q:format") — same scrubbing as Sentry.
//   - Human page traffic ($pageview / $pageleave / $web_vitals) is captured
//     client-side by the cookieless posthog-js snippet in src/ledger-chrome.js,
//     ingested first-party through the /e reverse proxy in src/server.js. This
//     module stays server-only: no pageview code, no per-visitor keys here.
//
// Fire-and-forget: capture() enqueues; the SDK ships in the background, so a
// hung PostHog can never slow a tool response. Wrapped in try/catch top-to-bottom.
//
// Configure via Railway env:
//   POSTHOG_API_KEY   — your project API key (REQUIRED to enable; absence = no-op)
//   POSTHOG_HOST      — optional, defaults to "https://us.i.posthog.com"
//                       (use "https://eu.i.posthog.com" for the EU region)
import { PostHog } from "posthog-node";
// stats.js is imported LAZILY: a static import would run its /data guard in
// every context that loads posthog.js (the funnel test boots this module in a
// bare subprocess with NODE_ENV=production and no volume, and stats exits).
// The server always has stats loaded, so after the first call this is sync.
let __statsMod = null;
function meterSpend(source, usd) {
  try {
    if (__statsMod) { __statsMod.recordUpstreamSpend(source, usd); return; }
    import("./stats.js").then((m) => { __statsMod = m; m.recordUpstreamSpend(source, usd); }).catch(() => {});
  } catch { /* metering must never break telemetry */ }
}
import { isPaidRail } from "./paid-rails.js";

const API_KEY = process.env.POSTHOG_API_KEY || "";
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
// Fixed identifier — we don't have an end-user for a server-side error; the
// "user" of this stream is the operator. A constant distinctId keeps PostHog's
// person-count at 1 and avoids leaking any signal about the calling agent.
const DISTINCT_ID = "agent402-server";
// Every server event is ANONYMOUS: `$process_person_profile: false` tells
// PostHog not to create or update a person profile for it. Measured
// 2026-08-28: 307,424 of 311,256 events in seven days were server events on
// this one constant id, and PostHog bills an event WITH person processing at
// roughly five times the anonymous rate once the free allowance is spent. The
// profile itself was worth nothing (one row, no person properties, every
// query here reads event properties), so this is cost with no signal lost.
// Browser events from the site keep person processing - that is web analytics
// and its volume is a rounding error beside this stream.
const ANON = { $process_person_profile: false };

let client = null;
let initialized = false;
let enabled = false;

// Test sink: POSTHOG_TEST_CAPTURE=1 makes every capture append to an
// in-memory array AND print a single `[posthog-test] {json}` line instead of
// touching the network. This is how the funnel CI test asserts the exact
// events + properties the server would have sent, fully offline — same
// pattern as the wallet E2E's leak audit reading the server log.
const TEST_MODE = process.env.POSTHOG_TEST_CAPTURE === "1";
const testEvents = [];
export function _testEventsForTest() {
  return testEvents;
}

// Single choke point for every event this module emits. All properties are
// operator-authored aggregates (slugs, counts, rails) — the privacy posture
// in the header comment is enforced by what the callers pass, and this
// function adds nothing (no IP, no UA, no timestamps beyond PostHog's own).
function capture(event, properties, distinctId = DISTINCT_ID) {
  // One shape for both sinks, so the test sees exactly what PostHog would.
  properties = { ...properties, ...ANON };
  if (TEST_MODE) {
    const e = { event, properties, distinctId };
    testEvents.push(e);
    console.log(`[posthog-test] ${JSON.stringify(e)}`);
    return;
  }
  if (!enabled || !client) return;
  try {
    client.capture({ distinctId, event, properties });
  } catch { /* never throw from telemetry */ }
}

// True when captures should be built at all — real client or the test sink.
const active = () => TEST_MODE || (enabled && client);

export function initPostHog() {
  if (initialized) return { ok: enabled, reason: enabled ? undefined : "no-key" };
  initialized = true;
  if (!API_KEY) return { ok: false, reason: "no-key" };
  // A dev/test boot with a copied .env must not stream into the production
  // project (2026-07-13: a local sweep against an unconfigured instance put a
  // burst of 503 "not configured" tool_errors in prod telemetry). Docker sets
  // NODE_ENV=production (Dockerfile line 4), so every real deployment passes;
  // POSTHOG_FORCE=true is the escape hatch for bare-metal prod runs.
  if (process.env.NODE_ENV !== "production" && process.env.POSTHOG_FORCE !== "true") {
    return { ok: false, reason: "non-production (NODE_ENV != production; set POSTHOG_FORCE=true to override)" };
  }
  try {
    client = new PostHog(API_KEY, {
      host: HOST,
      // Modest batching — small bursts ship quickly without DDoSing PostHog
      // and without holding events in memory across deploys.
      flushAt: 20,
      flushInterval: 10_000,
    });
    enabled = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function posthogEnabled() {
  return enabled;
}

// Capture a tool-handler error as a PostHog event. Properties mirror the
// Sentry tags (slug, status, errorClass, shape) so a single privacy-preserving
// payload feeds both backends. Never blocks, never throws.
export function capturePostHogToolError({ slug, status, message, shape, synthetic, probe }) {
  if (!active()) return;
  // Probe calls (a 4xx where the caller sent zero meaningful input keys) are
  // scanners/agents poking endpoints without arguments — discovery behavior,
  // not real errors. We deliberately keep them OFF the tool_error stream so
  // they never pollute error-tracking views/insights. The volume signal isn't
  // lost: capturePostHogToolCall still records every probe as a tool_call with
  // errored=true + probe=true, so "how much scanning is happening" stays
  // queryable without inflating the error rate.
  if (probe) return;
  capture("tool_error", {
    slug,
    status: Number(status) || 0,
    errorClass: Number(status) >= 500 ? "5xx" : "4xx",
    shape: Array.isArray(shape) && shape.length ? shape.join(",") : "",
    // Bounded — message text is never PII (we author all error messages
    // in the kits) but truncating is cheap defense in depth.
    message: String(message || "").slice(0, 200),
    // `synthetic` is true iff the caller proved knowledge of POW_SECRET
    // via an HMAC-signed X-Heartbeat-Token (see src/pow.js). Trusted
    // internal traffic only — CI canaries, the heartbeat probe, operator
    // smoke tests. PostHog dashboards can filter on this property to
    // exclude rehearsal traffic from real-user error rates.
    synthetic: !!synthetic,
    // `probe` is true when the caller sent a completely empty input and
    // the handler rejected it with 4xx. These are discovery/scanning
    // calls — not real schema mismatches — and inflate the error rate
    // if counted alongside genuine caller mistakes.
    probe: !!probe,
  });
}

// Capture every tool call (success AND failure) as a PostHog event. Fires
// from the `finally` block of the tool handler, so it covers the full picture:
// total volume, latency, cache hits, and success rates per slug. Errors are
// also captured separately via capturePostHogToolError with richer detail;
// this event is the volume/latency layer.
// Discovery pseudo-slugs ("_find", "_route": the free /api/find + /api/route
// resolvers) are ROLLED UP, not per-event. Measured 2026-08-25: one scanner
// hit /api/find twice a second for twelve hours (57,277 calls, 61% cache
// hits) and every hit was an ingested event - a single free caller became
// 52% of the day's PostHog volume, and nothing about a discovery call is
// per-event interesting. Real tool calls stay per-event.
const ROLLED_UP_SLUG_RE = /^_/;
let discoveryCallCounts = new Map(); // "slug|synthetic|cached|errored|status" -> { ..., count, latencySum }

export function capturePostHogToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe, payer }) {
  if (!active()) return;
  if (ROLLED_UP_SLUG_RE.test(String(slug || ""))) {
    try {
      const st = Number(status) || 200;
      const key = `${slug}|${synthetic ? 1 : 0}|${cached ? 1 : 0}|${errored ? 1 : 0}|${st}`;
      const cur = discoveryCallCounts.get(key) || { slug: String(slug), synthetic: !!synthetic, cached: !!cached, errored: !!errored, status: st, count: 0, latencySum: 0 };
      cur.count++;
      cur.latencySum += Number(latencyMs) || 0;
      discoveryCallCounts.set(key, cur);
      ensureFunnelTimer();
    } catch { /* never throw from telemetry */ }
    return;
  }
  capture("tool_call", {
    slug,
    latencyMs: Number(latencyMs) || 0,
    cached: !!cached,
    errored: !!errored,
    status: Number(status) || 200,
    synthetic: !!synthetic,
    probe: !!probe,
    ...(payer ? { payer } : {}),
  });
}

// Capture one internal skill-pack step — a tool handler invoked in-process by
// the skill runner. These calls NEVER appear in the tool_call stream (the
// runner bypasses the HTTP route), which made pack-driven upstream spend
// (Brave answer at ~$0.061/call, measured 2026-07-22) invisible to the
// PostHog-vs-provider cost reconciliations. Volume/ok/latency only, no inputs.
export function capturePostHogPackStep({ pack, slug, ok, ms }) {
  if (!active()) return;
  capture("pack_internal_call", {
    pack: String(pack || "unknown"),
    slug: String(slug || "unknown"),
    ok: !!ok,
    latencyMs: Number(ms) || 0,
  });
}

// ---------------------------------------------------------------------------
// Conversion funnel: discovery → paywall_402 → payment_settled.
//
// The buyer journey we sell against is measurable in three stages:
//   1. "discovery"       — an agent fetched a machine-readable surface
//                          (/llms.txt, /.well-known/x402, /api/find, MCP
//                          search_tools…). Property: surface.
//   2. "paywall_402"     — a catalog route answered HTTP 402 (a real quote
//                          was issued). Rolled up (see below); property
//                          `count` carries the true total. `attempt` splits
//                          the bounce: none / usdc_failed / pow_failed.
//   2b. "pow_challenge"  — a free-tier PoW challenge was issued. Paired with
//                          payment_settled{rail=pow} it measures free-tier
//                          take rate (issued → solved). Rolled up like (2).
//   3. "payment_settled" — the gate accepted payment and the tool returned
//                          200. Properties: slug, rail (usdc / pow /
//                          heartbeat / marketplace), network for USDC.
//
// All three keep the file's privacy posture: no caller IP or input — only
// slugs, surfaces, rails, and counts, plus (on settlements only) the paying
// wallet and the caller's UA product token (attribution, not identity — see
// capturePostHogSettlement). distinctId stays constant, so
// these are aggregate stage counters, not per-user tracking; conversion is
// computed as a ratio of stage totals (a PostHog formula insight), which is
// the honest framing for an anonymous-by-design payment protocol.

// Discovery is ROLLED UP per (surface, synthetic) per flush window - one
// event carrying `count`, `sum(count)` is the exact total. It used to be
// per-event under a 1,000/hour cap, which still let registry crawlers and
// monitors make discovery ~26% of a month's ingestion (260k of ~990k, measured
// 2026-08-27) while the cap silently discarded the excess on busy hours. A
// windowed count keeps the total exact AND bounds the event volume by the
// number of surfaces (~12), not by traffic.
let discoveryCounts = new Map(); // "surface|synthetic" -> { surface, synthetic, count }

export function capturePostHogDiscovery({ surface, synthetic }) {
  if (!active()) return;
  try {
    const key = `${surface || "unknown"}|${synthetic ? 1 : 0}`;
    const cur = discoveryCounts.get(key) || { surface: String(surface || "unknown"), synthetic: !!synthetic, count: 0 };
    cur.count++;
    discoveryCounts.set(key, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}

function flushDiscoveryRollup() {
  if (!discoveryCounts.size) return;
  const entries = [...discoveryCounts.values()];
  discoveryCounts = new Map();
  for (const e of entries) capture("discovery", { surface: e.surface, synthetic: e.synthetic, count: e.count });
}

function flushDiscoveryCallRollup() {
  if (!discoveryCallCounts.size) return;
  const entries = [...discoveryCallCounts.values()];
  discoveryCallCounts = new Map();
  for (const e of entries) {
    capture("tool_call", {
      slug: e.slug,
      count: e.count,
      latencyMs: Math.round(e.latencySum / e.count),
      cached: e.cached,
      errored: e.errored,
      status: e.status,
      synthetic: e.synthetic,
      probe: false,
    });
  }
}

// 402s are the highest-volume stage by far — registry crawlers (Bazaar,
// x402scan…) re-verify every one of the ~1,300 endpoints, so per-request
// events could alone exceed PostHog's free tier. Instead: accumulate counts
// in memory and flush one event per (slug, synthetic) pair per window, top
// slugs individually + a single "_other" remainder. `sum(count)` in PostHog
// is the exact total — nothing is sampled away.
const PAYWALL_FLUSH_MS = Math.max(1_000, Number(process.env.POSTHOG_PAYWALL_FLUSH_MS) || 900_000);
const PAYWALL_TOP_SLUGS = 50;
let paywallCounts = new Map(); // "slug|synthetic|attempt" -> { slug, priceUsd, powEligible, synthetic, attempt, count }
let paywallTimer = null;

// One timer drives the whole rolled-up funnel (paywall_402 + pow_challenge).
// Created lazily on the first captured count, unref'd so it never holds the
// process open.
function ensureFunnelTimer() {
  if (!paywallTimer) {
    paywallTimer = setInterval(flushPaywallRollup, PAYWALL_FLUSH_MS);
    if (paywallTimer.unref) paywallTimer.unref();
  }
}

// `attempt` classifies a 402 by what the caller actually tried — the
// couldn't-pay vs wouldn't-pay split that turns a flat "93% bounce" into a
// diagnosis:
//   "none"        — no payment/PoW header on the request: a first-contact quote.
//                   An agent with no funded wallet, a discovery crawl, or a
//                   buyer that saw the price and left. Expected-to-bounce.
//   "usdc_failed" — an X-PAYMENT authorization WAS present but the route still
//                   answered 402 (facilitator/verification rejected it). A
//                   buyer that tried to pay and couldn't — the fixable leak.
//   "pow_failed"  — an X-Pow-Solution was present but rejected (bad/expired
//                   work). Tried the free tier and missed.
export function capturePostHogPaywall({ slug, priceUsd, powEligible, synthetic, attempt, reason, shape }) {
  if (!active()) return;
  try {
    const att = attempt === "usdc_failed" || attempt === "pow_failed" ? attempt : "none";
    // WHY a present payment still bounced. Only ever one of the classifier's
    // fixed reasons (src/payment-reject.js), so this cannot inflate the rollup
    // key space with caller-controlled text. Absent when the payment reached
    // the facilitator - verify_failed carries that side.
    const rsn = att === "usdc_failed" && typeof reason === "string" && reason ? reason.slice(0, 40) : null;
    // Key names only, bounded, and only on the unclassified bucket - never a
    // value from a payment payload. Bounds the rollup key space too.
    // Attached to the two buckets where it is the actual diagnosis: the shape
    // of a refusal we could not classify, and WHICH field a mismatched payment
    // got wrong. Key names only in both cases, never a value.
    const shp = (rsn === "unclassified" || rsn === "requirements-mismatch") && typeof shape === "string" && shape ? shape.slice(0, 110) : null;
    const key = `${slug}|${synthetic ? 1 : 0}|${att}|${rsn || "-"}|${shp || "-"}`;
    const cur = paywallCounts.get(key) || {
      slug: String(slug || "unknown"),
      priceUsd: Number(priceUsd) || 0,
      powEligible: !!powEligible,
      synthetic: !!synthetic,
      attempt: att,
      ...(rsn ? { reason: rsn } : {}),
      ...(shp ? { shape: shp } : {}),
      count: 0,
    };
    cur.count++;
    paywallCounts.set(key, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}

function flushPaywallRollup() {
  try {
    if (paywallCounts.size) {
      const entries = [...paywallCounts.values()].sort((a, b) => b.count - a.count);
      paywallCounts = new Map();
      for (const e of entries.slice(0, PAYWALL_TOP_SLUGS)) {
        capture("paywall_402", { slug: e.slug, count: e.count, priceUsd: e.priceUsd, powEligible: e.powEligible, synthetic: e.synthetic, attempt: e.attempt, ...(e.reason ? { reason: e.reason } : {}), ...(e.shape ? { shape: e.shape } : {}) });
      }
      const rest = entries.slice(PAYWALL_TOP_SLUGS);
      if (rest.length) {
        // Fold the long tail per `attempt` (not into one bucket) so the
        // couldn't-pay vs wouldn't-pay split survives for tail slugs too —
        // at most three "_other" rows, and sum(count) stays the exact total.
        const byAttempt = new Map();
        for (const e of rest) byAttempt.set(e.attempt, (byAttempt.get(e.attempt) || 0) + e.count);
        for (const [attempt, count] of byAttempt) {
          capture("paywall_402", { slug: "_other", count, priceUsd: 0, powEligible: false, synthetic: false, attempt });
        }
      }
    }
    flushPowChallengeRollup();
    flushDiscoveryRollup();
    flushDiscoveryCallRollup();
    flushToolGoneRollup();
  } catch { /* never throw from telemetry */ }
}
export function _flushPaywallRollupForTest() {
  flushPaywallRollup();
}

// Free-tier funnel: a proof-of-work challenge was ISSUED (an agent asked how to
// pay for free via GET /api/pow/challenge). Compared against
// payment_settled{rail=pow}, this yields the free-tier take rate — of the
// agents that fetched a challenge, how many solved it vs abandoned the work.
// A near-zero take rate means the free path is discovered but too much friction;
// zero issuance means it isn't discovered at all. Rolled up like paywall_402
// (registry crawlers fetch challenges too), sharing the same flush timer.
let powChallengeCounts = new Map(); // "slug|synthetic" -> { slug, synthetic, count }
export function capturePostHogPowChallenge({ slug, synthetic }) {
  if (!active()) return;
  try {
    const key = `${slug}|${synthetic ? 1 : 0}`;
    const cur = powChallengeCounts.get(key) || { slug: String(slug || "unknown"), synthetic: !!synthetic, count: 0 };
    cur.count++;
    powChallengeCounts.set(key, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}
function flushPowChallengeRollup() {
  if (!powChallengeCounts.size) return;
  const entries = [...powChallengeCounts.values()].sort((a, b) => b.count - a.count);
  powChallengeCounts = new Map();
  for (const e of entries.slice(0, PAYWALL_TOP_SLUGS)) {
    capture("pow_challenge", { slug: e.slug, count: e.count, synthetic: e.synthetic });
  }
  const rest = entries.slice(PAYWALL_TOP_SLUGS);
  if (rest.length) capture("pow_challenge", { slug: "_other", count: rest.reduce((s, e) => s + e.count, 0), synthetic: false });
}

// Settlements are rare and precious — always per-event. `rail` is what the
// gate actually accepted (mirrors the /api/stats three-rail attribution);
// `network` is the settlement chain decoded from the x402 receipt for USDC.
// `clientUa` is the caller's User-Agent PRODUCT TOKEN only (first token,
// hard-capped at 40 chars — e.g. "agent402-client/0.6.1", "node", "python-httpx/0.27"),
// never the full UA string: it answers "which SDK/client do paying wallets
// use?" (do agent402-client installs convert?) without carrying device or
// platform detail. No IP, ever — consistent with the file's privacy posture.
// `wire` (usdc only): "mpp" when the credential arrived as MPP
// Authorization: Payment (translated by src/mpp-shim.js), "x402" otherwise —
// the adoption split for the MPP dual-stack.
// `paid` says whether money actually moved. It exists because `synthetic` was
// being used as if it meant "free", and it does not — it means OUR OWN traffic.
// A proof-of-work call is genuine external demand served for nothing, so it is
// synthetic=false while earning $0, and every chart filtered on `synthetic`
// alone counted it as a sale (measured 2026-08-06: 388 free vs 385 paid over a
// week, so the error was slightly over 2x, not a rounding difference).
//
// `priceUsd` deliberately KEEPS the list price on free rails — it is what the
// call would have cost, which is the free-tier subsidy metric — so the honest
// revenue expression is `sum(priceUsd) where paid`, and `paid` makes that
// legible instead of requiring every reader to remember the rail set.
// Zeroing it instead was considered and rejected: it would silently restate
// history mid-series and delete the subsidy number, while fixing none of the
// broken dashboards, which count events rather than summing price.
export function capturePostHogSettlement({ slug, rail, network, priceUsd, synthetic, payer, clientUa, wire }) {
  if (!active()) return;
  capture("payment_settled", {
    slug: String(slug || "unknown"),
    rail: String(rail || "unknown"),
    network: network ? String(network) : null,
    priceUsd: Number(priceUsd) || 0,
    paid: isPaidRail(rail),
    synthetic: !!synthetic,
    ...(payer ? { payer } : {}),
    ...(clientUa ? { clientUa: String(clientUa).slice(0, 40) } : {}),
    ...(wire ? { wire: String(wire) } : {}),
  });
}

// The worst event in the system: USDC settled on-chain but the handler
// returned non-200 — the buyer paid for nothing. Mirrors the local
// charged_failures SQLite tally (src/stats.js) so PostHog can alert on a
// spike in near-real-time and attribute it to a payer wallet, which the
// local table can't (it keeps only slug/status/ts). Volume is intrinsically
// low (this firing at all is an incident), so no rate cap.
export function capturePostHogChargedFailure({ slug, status, network, priceUsd, synthetic, payer }) {
  if (!active()) return;
  capture("charged_but_failed", {
    slug: String(slug || "unknown"),
    status: Number(status) || 0,
    network: network ? String(network) : null,
    priceUsd: Number(priceUsd) || 0,
    synthetic: !!synthetic,
    ...(payer ? { payer } : {}),
  });
}

// Settlement REJECTED — the facilitator answered { success:false }, the buyer
// KEPT their money, and we lost the sale. Deliberately distinct from
// charged_but_failed (buyer harm): this is a rail-health/lost-revenue signal.
// It exists because a graceful rejection fires no onSettleFailure hook in
// @x402/core (only thrown errors do), so before this event + the afterSettle
// log in payments.js, a rejection's only trace was a spurious
// charged_but_failed (the 2026-07-16 Robinhood canary false alarm).
// errorReason comes from the decoded failure receipt. Low-volume; no rate cap.
// A payment header that fails VERIFY never reaches settle_failed, and until
// 2026-08-28 the only trace was the paywall_402 "usdc_failed" rollup: ~10,000
// failed paid attempts in 14 days with no reason anywhere once the container
// log rolled. Reason + network + resource path, never the payer; bounded per
// hour because one client's retry loop produced 1,500 an hour.
const VERIFY_FAILED_HOURLY_CAP = 300;
let _vfWindow = 0, _vfCount = 0;
export function capturePostHogVerifyFailed({ network, scheme, resource, errorReason, synthetic, payerBalanceBucket, payerKey }) {
  if (!active()) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== _vfWindow) { _vfWindow = hour; _vfCount = 0; }
  if (++_vfCount > VERIFY_FAILED_HOURLY_CAP) return;
  let path = null;
  try { path = resource ? new URL(String(resource)).pathname.slice(0, 120) : null; } catch { path = String(resource || "").slice(0, 120) || null; }
  capture("verify_failed", {
    network: network ? String(network) : null,
    scheme: scheme ? String(scheme) : null,
    ...(path ? { path } : {}),
    synthetic: !!synthetic,
    ...(errorReason ? { errorReason: String(errorReason).slice(0, 200) } : {}),
    ...(payerBalanceBucket ? { payerBalanceBucket: String(payerBalanceBucket) } : {}),
    // A DERIVED, non-reversible id for the failing payer, never the address.
    // Added 2026-08-30: seven CDP connect timeouts on Solana in a day could not
    // be told apart as "one flaky client retrying" or "several clients hitting a
    // real fault", and that distinction decides whether anyone should act. Three
    // of them fell inside thirty seconds, which HINTS at one retrying caller,
    // but the event carried nothing to confirm it. Same construction as the
    // gateway's upstream user id (sha256, 32 hex) so the two can be compared
    // without either carrying an address.
    ...(payerKey ? { payerKey: String(payerKey).slice(0, 40) } : {}),
  });
}

// A request to a real catalog path with the wrong HTTP method: the exact
// dead end that stopped a paying buyer's catalog walk (2026-08-28) and that no
// event had ever counted. Path + method + UA family only; capped per hour.
const WRONG_METHOD_HOURLY_CAP = 300;
let _wmWindow = 0, _wmCount = 0;
export function capturePostHogWrongMethod({ path, method, allow, ua }) {
  if (!active()) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== _wmWindow) { _wmWindow = hour; _wmCount = 0; }
  if (++_wmCount > WRONG_METHOD_HOURLY_CAP) return;
  capture("wrong_method", {
    path: String(path || "").slice(0, 120),
    method: String(method || ""),
    allow: Array.isArray(allow) ? allow.join(",") : String(allow || ""),
    uaFamily: String(ua || "").split("/")[0].slice(0, 40) || "(none)",
  });
}

export function capturePostHogSettleFailed({ slug, status, network, priceUsd, synthetic, payer, errorReason }) {
  if (!active()) return;
  capture("settle_failed", {
    slug: String(slug || "unknown"),
    status: Number(status) || 0,
    network: network ? String(network) : null,
    priceUsd: Number(priceUsd) || 0,
    synthetic: !!synthetic,
    ...(payer ? { payer } : {}),
    ...(errorReason ? { errorReason: String(errorReason).slice(0, 200) } : {}),
  });
}

// Retired routes — the teaching 410s (the pruned convert-* pairs). Residual
// demand for a dead route is a product signal (someone's playbook or agent
// prompt still cites it), and without an event that demand is invisible.
// Properties are the route path (matched against a [a-z0-9-] regex before the
// handler runs — unit ids only, never caller input) and the taught
// replacement. ROLLED UP per route per flush window (top routes + "_other",
// `sum(count)` exact). It used to be per-event under a 500/hour cap, and the
// cap was the volume: four scanners re-walk all ~970 retired routes every day,
// so tool_gone sat at exactly 500 x 24 = 10-12k events/day, 38% of a month's
// ingestion (374k of ~990k, measured 2026-08-27) - and the question it exists
// to answer ("does anyone still cite these?") is answered: scanners, not
// buyers. The 410 response itself is never affected.
const TOOL_GONE_TOP_ROUTES = 50;
const TOOL_GONE_MAX_KEYS = 5_000;   // attacker-chosen paths cannot grow the map past this (review 2026-08-28)
const TOOL_GONE_MAX_ROUTE_CHARS = 120;
let toolGoneCounts = new Map(); // route -> { route, replacement, count }

export function capturePostHogToolGone({ route, replacement }) {
  if (!active()) return;
  try {
    let r = String(route || "unknown").slice(0, TOOL_GONE_MAX_ROUTE_CHARS);
    if (!toolGoneCounts.has(r) && toolGoneCounts.size >= TOOL_GONE_MAX_KEYS) r = "_overflow";
    const cur = toolGoneCounts.get(r) || { route: r, replacement: String(replacement || ""), count: 0 };
    cur.count++;
    toolGoneCounts.set(r, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}

function flushToolGoneRollup() {
  if (!toolGoneCounts.size) return;
  const entries = [...toolGoneCounts.values()].sort((a, b) => b.count - a.count);
  toolGoneCounts = new Map();
  for (const e of entries.slice(0, TOOL_GONE_TOP_ROUTES)) capture("tool_gone", { route: e.route, replacement: e.replacement, count: e.count });
  const rest = entries.slice(TOOL_GONE_TOP_ROUTES);
  if (rest.length) {
    capture("tool_gone", { route: "_other", replacement: rest[0].replacement, count: rest.reduce((s, e) => s + e.count, 0), routes: rest.length });
  }
}

// Per-call gateway margin accounting. OpenRouter reports the exact upstream
// bill when usage accounting is requested; this event pairs it with the flat
// tier price so real margin per tier/model is a PostHog insight instead of a
// list-price estimate — and it back-checks the MODEL_COST table the margin
// clamp prices against. upstreamUsd null (provider didn't report) still
// captures tokens so volume stays queryable.
/** One event per composite report run (research/dossier/fund/domain/token-risk): the
 *  upstream we spent vs the price - these are the largest single upstream calls we
 *  make and were invisible to margin telemetry before 2026-08-22. */
/** The human (card) funnel, one event per step so a conversion funnel is an
 *  insight, not a ledger grep: checkout_started -> paid (report delivered) |
 *  failed (refunded) | report_opened; monitor_checkout_started -> monitor_paid.
 *  Product + price only - never the buyer's input, email or session id. */
export function capturePostHogHumanFunnel({ step, product, kind, priceUsd, reason }) {
  if (!active()) return;
  try {
    capture("human_funnel", {
      step: String(step || ""),
      product: product ? String(product) : null,
      kind: kind ? String(kind) : null,
      priceUsd: priceUsd != null && Number.isFinite(Number(priceUsd)) ? Number(priceUsd) : null,
      reason: reason ? String(reason).slice(0, 120) : null,
    });
  } catch { /* never throw from telemetry */ }
}

export function capturePostHogCompositeUsage({ slug, upstreamUsd, ok, priceUsd, rail, capUsd, overCap }) {
  // Same rule as the gateway meter above. NB a composite's upstreamUsd can
  // OVERLAP the gateway source when a report invokes a /v1 handler
  // in-process (linkedin-article's image legs) - the margin view says so.
  meterSpend("composite", upstreamUsd);
  if (!active()) return;
  try {
    const price = priceUsd != null && Number.isFinite(Number(priceUsd)) ? Number(priceUsd) : null;
    capture("composite_usage", {
      slug,
      upstreamUsd,
      ok: !!ok,
      priceUsd: price,
      marginUsd: price != null ? Math.round((price - upstreamUsd) * 1e4) / 1e4 : null,
      // Which door sold it (agent = x402/MPP route, card = Stripe checkout,
      // monitor = subscription run) and the cap verdict, so margin per door and
      // cap breaches are PostHog insights instead of a log grep.
      rail: String(rail || "agent"),
      capUsd: capUsd != null ? Number(capUsd) : null,
      overCap: !!overCap,
    });
  } catch { /* never throw */ }
}

export function capturePostHogGatewayUsage({ tier, model, priceUsd, upstreamUsd, promptTokens, completionTokens, serviceTier, serverToolCalls, serverToolSearches, defaulted }) {
  // Server-side spend meter runs BEFORE the PostHog gate: cost must be
  // recorded even when telemetry is off (see recordUpstreamSpend's header).
  if (upstreamUsd != null) meterSpend("gateway", upstreamUsd);
  if (!active()) return;
  const price = Number(priceUsd) || 0;
  const upstream = Number(upstreamUsd) || 0;
  capture("gateway_usage", {
    tier: String(tier || "unknown"),
    model: String(model || ""),
    // The caller named no model and the tier's default served (2026-08-28) -
    // the measure of whether defaulting recovers real calls or only probes.
    defaulted: !!defaulted,
    // Which OpenRouter service tier actually served ("flex" = the 50% tier,
    // "default" otherwise) - the measurement behind the flex-first policy.
    serviceTier: String(serviceTier || "default"),
    priceUsd: price,
    upstreamUsd: upstream,
    marginUsd: +(price - upstream).toFixed(6),
    upstreamReported: upstreamUsd != null,
    promptTokens: Number(promptTokens) || 0,
    completionTokens: Number(completionTokens) || 0,
    // Server-tool execution counts (OpenRouter's usage.server_tool_use_details).
    // The dollars are already inside upstreamUsd; these say why a margin moved.
    serverToolCalls: Number(serverToolCalls) || 0,
    serverToolSearches: Number(serverToolSearches) || 0,
  });
}

// Graceful shutdown helper — call from a SIGTERM handler if you want
// in-flight events flushed before Railway kills the process. Optional;
// PostHog's own batching usually catches them anyway. Also drains the
// paywall_402 rollup so a redeploy doesn't drop up to a window of counts.
export async function shutdownPostHog() {
  flushPaywallRollup();
  if (!client) return;
  try {
    await client.shutdown();
  } catch { /* swallow */ }
}
