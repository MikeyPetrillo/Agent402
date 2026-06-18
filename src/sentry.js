// Sentry error tracking — opt-in, no-op without SENTRY_DSN.
//
// Captures tool-handler errors with slug + status + shape (keys-only) tags so
// rejected request shapes are searchable + trendable in the Sentry UI without
// us crawling Railway logs or maintaining a custom ring buffer.
//
// Same privacy posture as analytics-db: no values, no IPs, no headers, no
// payment info. `sendDefaultPii: false` + a defensive `beforeSend` scrubber
// drop anything Sentry's instrumentation might attach automatically.
//
// Fire-and-forget: `Sentry.captureMessage`/`captureException` enqueue and the
// SDK ships in the background, so a hung Sentry can never slow an agent.
//
// Configure via Railway env:
//   SENTRY_DSN          — your project DSN (REQUIRED to enable; absence = no-op)
//   SENTRY_ENVIRONMENT  — optional, defaults to "production"
//   SENTRY_SAMPLE_RATE  — optional traces sample rate (0..1), defaults to 0.1
import * as Sentry from "@sentry/node";

const DSN = process.env.SENTRY_DSN || "";
let initialized = false;
let enabled = false;

export function initSentry() {
  if (initialized) return { ok: enabled, reason: enabled ? undefined : "no-dsn" };
  initialized = true;
  if (!DSN) return { ok: false, reason: "no-dsn" };
  try {
    Sentry.init({
      dsn: DSN,
      environment: process.env.SENTRY_ENVIRONMENT || "production",
      tracesSampleRate: Number(process.env.SENTRY_SAMPLE_RATE) || 0.1,
      sendDefaultPii: false,
      beforeSend(event) {
        // Belt-and-suspenders: drop request body, headers, cookies even if
        // an integration attached them. We never want caller values in
        // Sentry — only the keys-only shape sent via tags below.
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.query_string;
        }
        return event;
      },
    });
    enabled = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function sentryEnabled() {
  return enabled;
}

// Capture a tool-handler error. Adds slug + status + errorClass + shape
// (keys-only) as tags so they're searchable in Sentry. Never blocks, never
// throws — telemetry must NEVER affect an agent's response.
export function captureToolError({ slug, status, message, shape, synthetic }) {
  if (!enabled) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("tool", slug);
      scope.setTag("status", String(status));
      scope.setTag("errorClass", status >= 500 ? "5xx" : "4xx");
      if (Array.isArray(shape) && shape.length) {
        scope.setTag("shape", shape.join(","));
      }
      // Mirror posthog.js: a request is synthetic iff it carried a valid
      // HMAC-signed X-Heartbeat-Token (see src/pow.js). Tagged so Sentry
      // filters/alerts can exclude rehearsal traffic.
      scope.setTag("synthetic", synthetic ? "true" : "false");
      Sentry.captureMessage(
        `${slug}: ${String(message || "").slice(0, 200)}`,
        status >= 500 ? "error" : "warning",
      );
    });
  } catch { /* never throw from telemetry */ }
}
