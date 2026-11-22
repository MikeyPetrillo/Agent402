// Railway feature flags as the runtime-switch provider (src/feature-flags.js).
//
// Key present = on: with FEATURE_FLAGS_RAILWAY_TOKEN set (a Railway project
// token, which names its own project and environment), startRailwayFlags()
// loads the Railway SDK (`railway` on npm), syncs the project's flags once and
// registers a provider; the SDK keeps an in-memory copy fresh in the
// background, so every read stays synchronous and local. Unset, nothing is
// loaded and every switch reads exactly as before: the environment variable
// of the same name, then the declared default.
//
// A dedicated variable, not RAILWAY_TOKEN, so a deploy or CI shell that holds
// a Railway token for other work never turns this on by accident.
//
// Names: a declared switch is looked up on Railway in lower case with hyphens
// (PRICE_WEBHOOK_DELIVERIES reads the flag "price-webhook-deliveries").
//
// Railway answers a switch only when the flag exists, is a boolean and its
// rules resolved (a matching rule, a rollout bucket, or the flag's own
// default). Not found, wrong type, a registry that has not synced or has gone
// stale, conflicting rules, or a rollout that needs a caller key all answer
// null, so the read falls through to the variable, then the default. Booleans
// only, as the module it serves: a number, text or JSON flag is never read.

import { setFlagProvider } from "./feature-flags.js";

export const RAILWAY_FLAGS_TOKEN_ENV = "FEATURE_FLAGS_RAILWAY_TOKEN";
const INIT_TIMEOUT_MS = 5000;
// Reasons for which the value is Railway's own answer for the flag.
const ANSWERED = new Set(["TARGETING_MATCH", "SPLIT", "NO_MATCH"]);

/** The Railway flag name a declared switch is read under. */
export function railwayFlagName(name) {
  return String(name).toLowerCase().replace(/_/g, "-");
}

/** A provider over an initialized SDK `flags` object (evaluateBoolean). */
export function railwayFlagProvider(sdkFlags) {
  return {
    name: "railway",
    getBoolean(name) {
      const ev = sdkFlags.evaluateBoolean(railwayFlagName(name), undefined, false);
      return ev && ANSWERED.has(ev.reason) && typeof ev.value === "boolean" ? ev.value : null;
    },
  };
}

/**
 * Register the Railway provider when the token is set. Never throws and never
 * delays boot beyond the caller's choice: a failed load or init logs one line
 * (no token, no message text from the SDK) and leaves no provider.
 */
export async function startRailwayFlags({
  env = process.env,
  loadSdk = async () => (await import("railway")).flags,
  log = (m) => console.log(m),
  timeoutMs = INIT_TIMEOUT_MS,
  fetchImpl, // tests only: the SDK otherwise uses the global fetch
} = {}) {
  const token = String(env?.[RAILWAY_FLAGS_TOKEN_ENV] ?? "").trim();
  if (!token) return { started: false, reason: "unset" };
  let sdk;
  try {
    sdk = await loadSdk();
    if (!sdk || typeof sdk.init !== "function" || typeof sdk.evaluateBoolean !== "function") throw new TypeError("flags SDK has no init/evaluateBoolean");
    await sdk.init({ token, authType: "project-token", timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  } catch (e) {
    log(`[flags] Railway flag provider not started (${e?.name || "Error"}); switches read the environment and their defaults`);
    return { started: false, reason: "init_failed" };
  }
  setFlagProvider(railwayFlagProvider(sdk));
  log(`[flags] Railway flag provider registered (synced: ${sdk.synced === true})`);
  return { started: true, synced: sdk.synced === true };
}
