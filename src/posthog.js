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
  if (!enabled || !client) return;
  try {
    client.capture({
      distinctId: DISTINCT_ID,
      event: "tool_error",
      properties: {
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
      },
    });
  } catch { /* never throw from telemetry */ }
}

// Capture every tool call (success AND failure) as a PostHog event. Fires
// from the `finally` block of the tool handler, so it covers the full picture:
// total volume, latency, cache hits, and success rates per slug. Errors are
// also captured separately via capturePostHogToolError with richer detail;
// this event is the volume/latency layer.
export function capturePostHogToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe }) {
  if (!enabled || !client) return;
  try {
    client.capture({
      distinctId: DISTINCT_ID,
      event: "tool_call",
      properties: {
        slug,
        latencyMs: Number(latencyMs) || 0,
        cached: !!cached,
        errored: !!errored,
        status: Number(status) || 200,
        synthetic: !!synthetic,
        probe: !!probe,
      },
    });
  } catch { /* never throw from telemetry */ }
}

// Graceful shutdown helper — call from a SIGTERM handler if you want
// in-flight events flushed before Railway kills the process. Optional;
// PostHog's own batching usually catches them anyway.
export async function shutdownPostHog() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch { /* swallow */ }
}
