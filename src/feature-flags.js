// Runtime switches read through a flag provider, with an environment fallback.
//
// A switch declared here is read in this order:
//   1. the flag provider, when one is registered and answers a boolean for the
//      name (a provider that throws, or answers anything else, is skipped);
//   2. the environment variable of the same name (on/off, true/false, 1/0,
//      yes/no, read without regard to case; any other text is skipped);
//   3. the declared default.
// So with no provider and no variable a switch reads its default, and a
// provider that is down changes nothing: the read falls through to the
// variable, then the default. The read is synchronous and at call time.
//
// ONLY BOOLEANS, ONLY DECLARED NAMES. A name that is not in RUNTIME_FLAGS
// throws at the read site, and there is no number read: a price, a cap or a
// spend limit is never read through here.
//
// No provider is registered by this module. A provider is an object with a
// synchronous `getBoolean(name)`; registering one is a separate change with
// its own account setup.

/** Every runtime switch, with its default and a purpose line. */
export const RUNTIME_FLAGS = Object.freeze({
  // Price webhook deliveries (src/price-webhooks.js): off stops every outbound
  // delivery; registrations, listings and removals keep working.
  PRICE_WEBHOOK_DELIVERIES: Object.freeze({ default: true, purpose: "outbound price webhook deliveries" }),
});

let provider = null;
const counts = { provider: 0, env: 0, default: 0, providerErrors: 0 };

/** Register (or clear, with null) the flag provider. */
export function setFlagProvider(p) {
  provider = p && typeof p.getBoolean === "function" ? p : null;
  return provider !== null;
}

/** "on"/"off" text as a boolean, or null when it is neither. */
export function parseSwitch(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(s)) return true;
  if (["off", "false", "0", "no"].includes(s)) return false;
  return null;
}

/** { value, source } for a declared switch; source is provider, env or default. */
export function evaluateFlag(name, { env = process.env } = {}) {
  const decl = Object.hasOwn(RUNTIME_FLAGS, name) ? RUNTIME_FLAGS[name] : null;
  if (!decl) throw new Error(`feature-flags: "${name}" is not a declared runtime switch`);
  if (provider) {
    try {
      const v = provider.getBoolean(name);
      if (typeof v === "boolean") { counts.provider++; return { value: v, source: "provider" }; }
    } catch { counts.providerErrors++; }
  }
  const fromEnv = parseSwitch(env?.[name]);
  if (fromEnv !== null) { counts.env++; return { value: fromEnv, source: "env" }; }
  counts.default++;
  return { value: decl.default, source: "default" };
}

/** Is the declared switch on? */
export function flagEnabled(name, opts) { return evaluateFlag(name, opts).value; }

/** Where reads were answered from, per process (counts only). */
export function flagReadCounts() { return { ...counts, providerRegistered: provider !== null }; }
