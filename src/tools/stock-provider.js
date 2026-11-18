// Stock data provider seam: the one interface the stock tools call.
//
// STOCK_DATA_PROVIDER names the adapter ("off" by default, or "databento").
// A provider is ACTIVE only when its name is selected AND its own key is
// present; with no active provider every stock tool (STOCK_SLUGS), every pack
// that runs one (src/skills.js) and every surface that names them is absent,
// and the routes answer 503 not-offered with no payment challenge.
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
//                             bars: ascending { day, open, high, low, close,
//                             volume, venueVolume }, the last one the newest
//                             session; opts: { demand, lastGoodOk }
//   dailyBars(symbol, opts)   -> same shape as quote; opts: { sessions,
//                             start, end, maxUsd, demand }
//   start()                   boot-time background work (optional)
//   status()                  operator counts (optional)
//
// This module imports no adapter until one is active, so the switch is cheap
// to read from product tables, the sweeps and the tests.

/** Every catalog tool that reads stock data. */
export const STOCK_SLUGS = Object.freeze(new Set(["stock-quote", "stock-history"]));

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

export async function quote(symbol, opts = {}) { return (await requireAdapter()).quote(symbol, opts); }
export async function dailyBars(symbol, opts = {}) { return (await requireAdapter()).dailyBars(symbol, opts); }

/** Test hook: register (or replace) an adapter entry; returns an undo. */
export function __registerStockProvider(name, { keyEnv = null, adapter }) {
  const prev = REGISTRY.get(name);
  REGISTRY.set(name, { name, keyEnv, load: async () => adapter });
  loaded.delete(name);
  return () => { if (prev) REGISTRY.set(name, prev); else REGISTRY.delete(name); loaded.delete(name); };
}
