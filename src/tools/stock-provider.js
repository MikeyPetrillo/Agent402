// Stock data provider seam: the one interface the stock tools call.
//
// STOCK_DATA_PROVIDER names the adapter ("off" by default, or "databento").
// A provider is ACTIVE only when its name is selected AND its own key is
// present. An active provider serves STOCK_SERVED_SLUGS only (stock-history);
// every other stock tool (stock-quote), every pack whose stock step is not
// served (src/skills.js) and every surface that names them is absent, and the
// routes answer 503 not-offered with no payment challenge. With no active
// provider that holds for every stock tool.
//
// Adding a provider later is one adapter file (the shape below; databento.js
// is the reference), one registry line here, its key on the server, and
// STOCK_DATA_PROVIDER set to its name. Nothing else changes.
//
// Adapter shape (what an adapter module exports as its adapter object):
//   name                      the STOCK_DATA_PROVIDER value
//   describe                  { coverageCopy, exampleProvenance, credit? }:
//                             the text tool descriptions and published
//                             examples carry for this provider
//   quote(symbol, opts)       -> { bars, provenance, cached, fetchedAt,
//                                  rangeCheckedAt, rangeStale?, stale? }
//                             (never called through this seam today:
//                             stockQuoteEnabled() is false)
//                             bars: ascending { day, open, high, low, close,
//                             volume, venueVolume }, the last one the newest
//                             session; opts: { demand, lastGoodOk }
//   dailyBars(symbol, opts)   -> same shape as quote plus latestAvailable
//                             (the newest session it may serve); opts:
//                             { sessions, start, end, maxUsd, demand }; no
//                             bar newer than the provider's delay
//   start()                   boot-time background work (optional)
//   status()                  operator counts (optional)
//
// This module imports no adapter until one is active, so the switch is cheap
// to read from product tables, the sweeps and the tests.

/** Every catalog tool that reads stock data. */
export const STOCK_SLUGS = Object.freeze(new Set(["stock-quote", "stock-history"]));
/** The stock tools an active provider serves: daily bars whose day ended at
 *  least 24 hours before the request (stock-history). stock-quote answers the
 *  newest session, which is under 24 hours old, so no provider serves it: it
 *  stays unlisted and its route answers 503 not-offered whatever the switch
 *  says. */
export const STOCK_SERVED_SLUGS = Object.freeze(new Set(["stock-history"]));

const REGISTRY = new Map([
  ["databento", { name: "databento", keyEnv: "DATABENTO_API_KEY", load: () => import("./databento.js").then((m) => m.databentoAdapter) }],
]);

/** The selected provider name ("off" when unset or "off"). */
export function selectedStockProvider(env = process.env) {
  const v = String(env.STOCK_DATA_PROVIDER || "").trim().toLowerCase();
  return v || "off";
}

/** True when the selected provider is registered and its key is present. */
export function stockDataEnabled(env = process.env) {
  const name = selectedStockProvider(env);
  if (name === "off") return false;
  const entry = REGISTRY.get(name);
  if (!entry) return false;
  return !entry.keyEnv || String(env[entry.keyEnv] || "").trim() !== "";
}

/** True when `slug` is a stock tool this boot lists: an active provider
 *  serves it. False for every stock-quote read. */
export function stockToolServed(slug, env = process.env) {
  return STOCK_SERVED_SLUGS.has(slug) && stockDataEnabled(env);
}

/** The newest-session quote (stock-quote, market.quote): never served. */
export const stockQuoteEnabled = (env = process.env) => stockToolServed("stock-quote", env);

/** The one boot warning for a selection that leaves no provider active: an
 *  unknown name, or a known one whose key is missing. Null when the switch is
 *  off or the provider is active. Names the variable, never its value. */
export function stockProviderWarning(env = process.env) {
  const name = selectedStockProvider(env);
  if (name === "off") return null;
  const entry = REGISTRY.get(name);
  // The name is echoed bounded and reduced to plain characters: it is config, not a key.
  const shown = JSON.stringify(name.replace(/[^a-z0-9_.-]/g, "?").slice(0, 40));
  if (!entry) return `[stock-provider] STOCK_DATA_PROVIDER=${shown} names no registered provider (${[...REGISTRY.keys()].join(", ")} or off): stock tools stay unlisted`;
  if (entry.keyEnv && String(env[entry.keyEnv] || "").trim() === "") return `[stock-provider] STOCK_DATA_PROVIDER=${shown} is selected but ${entry.keyEnv} is not set: stock tools stay unlisted`;
  return null;
}

/** Registered provider names (for docs and the boot log). */
export const stockProviderNames = () => [...REGISTRY.keys()];

const loaded = new Map();
/** The active adapter, or null with none active. */
export async function activeStockAdapter(env = process.env) {
  if (!stockDataEnabled(env)) return null;
  const name = selectedStockProvider(env);
  if (!loaded.has(name)) loaded.set(name, REGISTRY.get(name).load());
  return loaded.get(name);
}

/** The selected provider's adapter whether or not its key is present (its
 *  copy and example fields), or null with "off" or an unknown name. Reads go
 *  through activeStockAdapter, never this. */
export async function selectedStockAdapter(env = process.env) {
  const name = selectedStockProvider(env);
  const entry = REGISTRY.get(name);
  if (!entry) return null;
  if (!loaded.has(name)) loaded.set(name, entry.load());
  return loaded.get(name);
}

/** The refusal every stock read gives with no active provider. Never charged
 *  (a status >= 400 cancels settlement). */
export function stockNotOffered() {
  return Object.assign(new Error("This tool is not currently offered on this server."), { statusCode: 503, notOffered: true });
}

async function requireAdapter() {
  const a = await activeStockAdapter();
  if (!a) throw stockNotOffered();
  return a;
}

/** The newest-session quote: refused here whatever the provider (no provider
 *  serves a session under 24 hours old), so nothing reaches an adapter's quote. */
export async function quote(symbol, opts = {}) {
  if (!stockQuoteEnabled()) throw stockNotOffered();
  return (await requireAdapter()).quote(symbol, opts);
}
export async function dailyBars(symbol, opts = {}) { return (await requireAdapter()).dailyBars(symbol, opts); }

/** Test hook: register (or replace) an adapter entry; returns an undo. */
export function __registerStockProvider(name, { keyEnv = null, adapter }) {
  const prev = REGISTRY.get(name);
  REGISTRY.set(name, { name, keyEnv, load: async () => adapter });
  loaded.delete(name);
  return () => { if (prev) REGISTRY.set(name, prev); else REGISTRY.delete(name); loaded.delete(name); };
}
