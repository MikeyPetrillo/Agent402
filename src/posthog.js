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
//
// Fire-and-forget: capture() enqueues; the SDK ships in the background, so a
// hung PostHog can never slow a tool response. Wrapped in try/catch top-to-bottom.
//
// Configure via Railway env:
//   POSTHOG_API_KEY   — your project API key (REQUIRED to enable; absence = no-op)
//   POSTHOG_HOST      — optional, defaults to "https://us.i.posthog.com"
//                       (use "https://eu.i.posthog.com" for the EU region)
import { PostHog } from "posthog-node";

const API_KEY = process.env.POSTHOG_API_KEY || "";
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
// Fixed identifier — we don't have an end-user for a server-side error; the
// "user" of this stream is the operator. A constant distinctId keeps PostHog's
// person-count at 1 and avoids leaking any signal about the calling agent.
const DISTINCT_ID = "agent402-server";

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
function capture(event, properties) {
  if (TEST_MODE) {
    const e = { event, properties };
    testEvents.push(e);
    console.log(`[posthog-test] ${JSON.stringify(e)}`);
    return;
  }
  if (!enabled || !client) return;
  try {
    client.capture({ distinctId: DISTINCT_ID, event, properties });
  } catch { /* never throw from telemetry */ }
}

// True when captures should be built at all — real client or the test sink.
const active = () => TEST_MODE || (enabled && client);

export function initPostHog() {
  if (initialized) return { ok: enabled, reason: enabled ? undefined : "no-key" };
  initialized = true;
  if (!API_KEY) return { ok: false, reason: "no-key" };
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
export function capturePostHogToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe, payer }) {
  if (!active()) return;
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

// ---------------------------------------------------------------------------
// Conversion funnel: discovery → paywall_402 → payment_settled.
//
// The buyer journey we sell against is measurable in three stages:
//   1. "discovery"       — an agent fetched a machine-readable surface
//                          (/llms.txt, /.well-known/x402, /api/find, MCP
//                          search_tools…). Property: surface.
//   2. "paywall_402"     — a catalog route answered HTTP 402 (a real quote
//                          was issued). Rolled up (see below); property
//                          `count` carries the true total.
//   3. "payment_settled" — the gate accepted payment and the tool returned
//                          200. Properties: slug, rail (usdc / pow /
//                          heartbeat / marketplace), network for USDC.
//
// All three keep the file's privacy posture: no caller IP/UA/wallet/input —
// only slugs, surfaces, rails, and counts. distinctId stays constant, so
// these are aggregate stage counters, not per-user tracking; conversion is
// computed as a ratio of stage totals (a PostHog formula insight), which is
// the honest framing for an anonymous-by-design payment protocol.

// Discovery is per-event (arrival timing matters) but bot sweeps against
// /llms.txt etc. shouldn't be able to torch the event budget — cap captures
// per rolling hour and drop the excess silently (the tool_call stream is
// unaffected).
const DISCOVERY_MAX_PER_HOUR = 1000;
let discoveryWindowStart = 0;
let discoveryWindowCount = 0;

export function capturePostHogDiscovery({ surface, synthetic }) {
  if (!active()) return;
  try {
    const now = Date.now();
    if (now - discoveryWindowStart > 3_600_000) {
      discoveryWindowStart = now;
      discoveryWindowCount = 0;
    }
    if (++discoveryWindowCount > DISCOVERY_MAX_PER_HOUR) return;
    capture("discovery", { surface: String(surface || "unknown"), synthetic: !!synthetic });
  } catch { /* never throw from telemetry */ }
}

// 402s are the highest-volume stage by far — registry crawlers (Bazaar,
// x402scan…) re-verify every one of the ~1,300 endpoints, so per-request
// events could alone exceed PostHog's free tier. Instead: accumulate counts
// in memory and flush one event per (slug, synthetic) pair per window, top
// slugs individually + a single "_other" remainder. `sum(count)` in PostHog
// is the exact total — nothing is sampled away.
const PAYWALL_FLUSH_MS = Math.max(1_000, Number(process.env.POSTHOG_PAYWALL_FLUSH_MS) || 900_000);
const PAYWALL_TOP_SLUGS = 50;
let paywallCounts = new Map(); // "slug|synthetic" -> { slug, priceUsd, powEligible, synthetic, count }
let paywallTimer = null;

export function capturePostHogPaywall({ slug, priceUsd, powEligible, synthetic }) {
  if (!active()) return;
  try {
    const key = `${slug}|${synthetic ? 1 : 0}`;
    const cur = paywallCounts.get(key) || {
      slug: String(slug || "unknown"),
      priceUsd: Number(priceUsd) || 0,
      powEligible: !!powEligible,
      synthetic: !!synthetic,
      count: 0,
    };
    cur.count++;
    paywallCounts.set(key, cur);
    if (!paywallTimer) {
      paywallTimer = setInterval(flushPaywallRollup, PAYWALL_FLUSH_MS);
      if (paywallTimer.unref) paywallTimer.unref();
    }
  } catch { /* never throw from telemetry */ }
}

function flushPaywallRollup() {
  try {
    if (!paywallCounts.size) return;
    const entries = [...paywallCounts.values()].sort((a, b) => b.count - a.count);
    paywallCounts = new Map();
    for (const e of entries.slice(0, PAYWALL_TOP_SLUGS)) {
      capture("paywall_402", { slug: e.slug, count: e.count, priceUsd: e.priceUsd, powEligible: e.powEligible, synthetic: e.synthetic });
    }
    const rest = entries.slice(PAYWALL_TOP_SLUGS);
    if (rest.length) {
      capture("paywall_402", {
        slug: "_other",
        count: rest.reduce((s, e) => s + e.count, 0),
        priceUsd: 0,
        powEligible: false,
        synthetic: false,
      });
    }
  } catch { /* never throw from telemetry */ }
}
export function _flushPaywallRollupForTest() {
  flushPaywallRollup();
}

// Settlements are rare and precious — always per-event. `rail` is what the
// gate actually accepted (mirrors the /api/stats three-rail attribution);
// `network` is the settlement chain decoded from the x402 receipt for USDC.
export function capturePostHogSettlement({ slug, rail, network, priceUsd, synthetic, payer }) {
  if (!active()) return;
  capture("payment_settled", {
    slug: String(slug || "unknown"),
    rail: String(rail || "unknown"),
    network: network ? String(network) : null,
    priceUsd: Number(priceUsd) || 0,
    synthetic: !!synthetic,
    ...(payer ? { payer } : {}),
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
