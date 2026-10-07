// A buyer who leaves before the answer is ready is not charged, within a
// budget (src/hangup-settlement.js is the rule; this module is its bound).
//
// Why a budget: not settling an abandoned run means the work was done and
// nobody paid. For an honest client whose timeout is shorter than a long
// route that is the right answer, and the only alternative - settle, then book
// the charge as owed and refund it - is the refund this rule exists to avoid.
// But a hang-up costs the caller nothing, so on its own it is a free run on
// repeat. The bound is money, not a refusal:
//
//   - A paid request reserves a forgiveness TICKET when its handler starts,
//     priced at what it would be charged. The ticket is granted only while
//     every key the request carries (the verified payer AND the client IP) and
//     the whole service stay inside their budgets for the window, counting
//     both runs still in flight and runs already abandoned. In-flight runs
//     count, so a burst of concurrent hang-ups cannot all be granted. A route
//     whose effect outlives the answer (a memory write, an attestation, a
//     stored verdict, a purchase from an outside seller) never gets one.
//   - A run whose buyer left before the first byte is recorded as ABANDONED
//     under every key it carried and globally. Nothing clears that record
//     except time: a paid success does not, because a success is exactly what
//     an attacker would interleave to reset a counter.
//   - With a granted ticket, a hang-up is not settled (no charge, no refund).
//     WITHOUT one - the budget is spent, for this wallet, this IP or everyone
//     - the request is served exactly as before this rule existed: the rail
//     settles the <400 response, and the charge the buyer never received is
//     booked as owed in the refund ledger. Nobody is ever refused service by
//     this module; running out of budget only puts the cost back on the
//     buyer, where the refund pipeline's own caps and human review apply.
//
// Keys are verified identities only: the signed EIP-3009 payer, the Tempo
// sender the gate VERIFIED (req.mppTempoSender), or the credits key, plus
// always the client IP. A client-supplied field (a Tempo credential's
// `source`) is never a key, because choosing a fresh key per request is how a
// per-key bound is walked around. A key is held only as a keyed digest of that
// identity (its kind prefix kept, so a denial can still say "ip budget"): the
// module never needs the address itself, and the persisted file below must not
// hold a list of client IPs.
//
// The ABANDONED records persist: a deploy is a restart, we deploy often, and a
// budget that every restart refills is not a bound. They are written to
// HANGUP_FORGIVE_FILE (default /data/hangup-forgiveness.json when /data exists,
// nothing otherwise; "off" disables) shortly after each abandoned run, flushed
// on shutdown, and read back at boot, pruned to the window. In-flight
// reservations are not persisted: a restart ends every run in flight. Per-key
// records carry across a restart only when the digest secret is stable
// (HANGUP_FORGIVE_SALT, else POW_SECRET, else MPP_SECRET_KEY); the
// service-wide record always does. Money is counted in integer micro-dollars.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const MICRO = 1_000_000;
const MAX_KEYS = 20_000;
const PERSIST_DEBOUNCE_MS = 2_000;
const FILE_VERSION = 1;

// Default budgets, per 24 h window, sized for micro-transactions: most
// catalog calls cost a fraction of a cent, so a quarter per key still covers
// dozens of abandoned runs from an honest short-timeout client, and the
// service-wide figure bounds what everyone together can walk away from. A
// single call priced above the per-key budget (a report, a card charge, the
// dearer router tiers) is never forgiven: its hang-up is settled and booked as
// owed, like any run past the budget. HANGUP_FORGIVE_KEY_USD and
// HANGUP_FORGIVE_GLOBAL_USD override them.
export const DEFAULT_KEY_BUDGET_USD = 0.25;
export const DEFAULT_GLOBAL_BUDGET_USD = 2;

// Routes whose effect persists whether or not the answer is delivered. Not
// settling an abandoned run is only right when the run left nothing behind
// but spent compute; on these the handler has already changed something that
// a hang-up does not undo, so they never take a ticket: a hang-up is settled
// and the undelivered answer booked as owed, as before the rule existed.
//   - the memory family's writers: the wallet's namespace (keys, counters,
//     grants, remembered documents) has changed;
//   - attest: an attestation on Base is permanent and paid for in gas;
//   - feedback: the verdict is stored against the sale;
//   - the route-execute tiers and seller-payability: they pay outside sellers
//     from our own wallet, and that payment is not returned.
// Readers in the same families (memory-read, memory-grants, memory-log,
// memory-recall, feedback-summary) leave nothing behind and follow the budget.
// scripts/test-hangup-settlement.js checks this list against the booted
// catalog: every slug must exist, every route-execute tier must be listed, and
// every memory route must be classified as a writer here or as a known reader.
const LASTING_EFFECT_SLUGS = new Set([
  "memory-write", "memory-incr", "memory-cas", "memory-grant", "memory-revoke", "memory-remember", "memory-forget",
  "attest",
  "feedback",
  "route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro",
  "seller-payability",
  "flight-search", "flight-status",
]);
export const LASTING_EFFECT_SLUG_LIST = Object.freeze([...LASTING_EFFECT_SLUGS]);

/** True for a slug whose effect outlives an undelivered answer: never forgiven. */
export function hasLastingEffect(slug) {
  return typeof slug === "string" && LASTING_EFFECT_SLUGS.has(slug);
}

const KEY_KINDS = new Set(["ip", "tempo", "credits"]);
let processSecret = null;
function digestSecret() {
  const s = String(process.env.HANGUP_FORGIVE_SALT || process.env.POW_SECRET || process.env.MPP_SECRET_KEY || "").trim();
  if (s) return s;
  // No stable secret: digests still work within this process, and per-key
  // records simply do not match after a restart (the service-wide one does).
  if (!processSecret) processSecret = randomBytes(32).toString("hex");
  return processSecret;
}

/** `kind:digest` for a raw identity key. The kind ("ip", "tempo", "credits",
 *  else "payer") survives so a denial can name which budget bound it. */
export function hangupKeyDigest(raw) {
  const k = String(raw);
  const i = k.indexOf(":");
  const kind = i > 0 && KEY_KINDS.has(k.slice(0, i)) ? k.slice(0, i) : "payer";
  return `${kind}:${createHmac("sha256", digestSecret()).update(k).digest("hex").slice(0, 24)}`;
}

function envNumber(name, dflt) {
  const raw = String(process.env[name] ?? "").trim();
  if (raw === "") return dflt;
  const n = Number(raw);
  // A malformed value reads as unset, never as a wider budget.
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Call-time config (a test boot sets the env before it starts the server). */
export function hangupForgivenessConfig() {
  const off = String(process.env.HANGUP_FORGIVE || "").trim().toLowerCase() === "off";
  return {
    enabled: !off,
    keyMicro: Math.round(envNumber("HANGUP_FORGIVE_KEY_USD", DEFAULT_KEY_BUDGET_USD) * MICRO),
    globalMicro: Math.round(envNumber("HANGUP_FORGIVE_GLOBAL_USD", DEFAULT_GLOBAL_BUDGET_USD) * MICRO),
    windowMs: Math.max(1_000, envNumber("HANGUP_FORGIVE_WINDOW_MS", 24 * 60 * 60 * 1000)),
  };
}

const inflightByKey = new Map(); // key -> micro-dollars held by granted, unfinished runs
let globalInflight = 0;
const abandonedByKey = new Map(); // key -> [[t, micro], ...] oldest first
let globalAbandoned = []; // [[t, micro], ...] oldest first
let lastExhaustedLog = 0;

function prune(list, now, windowMs) {
  let i = 0;
  while (i < list.length && now - list[i][0] >= windowMs) i++;
  return i ? list.slice(i) : list;
}
function sumOf(list) { let s = 0; for (const [, m] of list) s += m; return s; }
function abandonedMicro(key, now, windowMs) {
  const list = abandonedByKey.get(key);
  if (!list) return 0;
  const kept = prune(list, now, windowMs);
  if (!kept.length) { abandonedByKey.delete(key); return 0; }
  if (kept !== list) abandonedByKey.set(key, kept);
  return sumOf(kept);
}
function evictIfFull() {
  if (abandonedByKey.size < MAX_KEYS) return;
  // Oldest insertion first. Forgetting a key only ever makes that key's next
  // run LESS likely to be refused forgiveness, and the global budget still
  // holds, so the bound the service relies on does not move.
  const drop = abandonedByKey.size - MAX_KEYS + 1;
  let n = 0;
  for (const k of abandonedByKey.keys()) { abandonedByKey.delete(k); if (++n >= drop) break; }
}

/** The ticket on a request, or null. Own property only: a polluted prototype
 *  must never make a request look forgiven (and therefore unsettled). */
function ticketOf(req) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, "__a402HangupTicket")) return null;
  const t = req.__a402HangupTicket;
  return t && typeof t === "object" ? t : null;
}

/** True when this request holds a GRANTED ticket: a close before the first
 *  byte cancels its charge. Every settlement point reads this through
 *  chargeCancelledForClientGone() in src/hangup-settlement.js. */
export function hangupForgiven(req) {
  return ticketOf(req)?.granted === true;
}

/** Why this request's ticket was denied ("lasting effect", "payer budget",
 *  ...), or null when it holds a granted ticket or none at all. For the log
 *  line that books an undelivered charge as owed. */
export function hangupTicketDenial(req) {
  const t = ticketOf(req);
  return t && t.granted !== true && typeof t.reason === "string" ? t.reason : null;
}

/**
 * Reserve a forgiveness ticket for a paid request whose handler is starting.
 * `keys` are the verified identities it carries (falsy entries dropped);
 * `priceUsd` is what it would be charged; `slug` is the catalog route, and a
 * slug with a lasting effect (hasLastingEffect), or any route whose def says
 * it spends our own wallet before settlement (`spendsOwnWallet`, passed by the
 * caller from the catalog def), is always denied. Always
 * stores a ticket on the request (granted or not, with the reason) and
 * returns it.
 */
export function reserveHangupForgiveness(req, { keys = [], priceUsd = 0, slug = null, spendsOwnWallet = false, now = Date.now() } = {}) {
  const cfg = hangupForgivenessConfig();
  const uniq = [...new Set(keys.filter((k) => typeof k === "string" && k).map(hangupKeyDigest))];
  const micro = Math.max(0, Math.round(Number(priceUsd) * MICRO) || 0);
  const ticket = { granted: false, keys: uniq, micro, state: "denied", reason: null };
  const store = (t) => { if (req && typeof req === "object") Object.defineProperty(req, "__a402HangupTicket", { value: t, writable: true, configurable: true, enumerable: false }); return t; };
  if (!cfg.enabled) { ticket.reason = "disabled"; return store(ticket); }
  // Before any budget is read: a route that leaves something behind is never
  // forgiven, however much budget is left, and spends none of it.
  if (hasLastingEffect(slug) || spendsOwnWallet === true) { ticket.reason = "lasting effect"; return store(ticket); }
  if (!(micro > 0)) { ticket.reason = "no price"; return store(ticket); }
  // Every request carries at least the IP key; one that carries none is not
  // bounded per key, so it is never forgiven.
  if (!uniq.length) { ticket.reason = "no key"; return store(ticket); }
  // A single call priced above the per-key budget could never be forgiven,
  // whatever else is spent: say so, and keep it from reading as (and warning
  // about) a spent service-wide budget.
  if (micro > cfg.keyMicro) { ticket.reason = "over per-key budget"; return store(ticket); }
  globalAbandoned = prune(globalAbandoned, now, cfg.windowMs);
  if (globalInflight + sumOf(globalAbandoned) + micro > cfg.globalMicro) {
    ticket.reason = "global budget";
    if (now - lastExhaustedLog > 60_000) {
      lastExhaustedLog = now;
      console.warn("[hangup] forgiveness budget for the whole service is spent for this window: a buyer who leaves before the answer is charged and the charge booked as owed until it clears");
    }
    return store(ticket);
  }
  for (const k of uniq) {
    if ((inflightByKey.get(k) || 0) + abandonedMicro(k, now, cfg.windowMs) + micro > cfg.keyMicro) {
      ticket.reason = k.startsWith("ip:") ? "ip budget" : "payer budget";
      return store(ticket);
    }
  }
  for (const k of uniq) inflightByKey.set(k, (inflightByKey.get(k) || 0) + micro);
  globalInflight += micro;
  ticket.granted = true;
  ticket.state = "inflight";
  return store(ticket);
}

/**
 * Finish a request's ticket: `abandoned` when the buyer left before the first
 * byte (recorded under every key and globally, for the window), otherwise the
 * reservation is simply returned. Idempotent; a denied ticket holds nothing.
 */
export function settleHangupTicket(req, { abandoned = false, now = Date.now() } = {}) {
  const t = ticketOf(req);
  if (!t || !t.granted || t.state !== "inflight") return false;
  for (const k of t.keys) {
    const left = (inflightByKey.get(k) || 0) - t.micro;
    if (left > 0) inflightByKey.set(k, left); else inflightByKey.delete(k);
  }
  globalInflight = Math.max(0, globalInflight - t.micro);
  if (abandoned) {
    evictIfFull();
    for (const k of t.keys) { const list = abandonedByKey.get(k) || []; list.push([now, t.micro]); abandonedByKey.set(k, list); }
    globalAbandoned.push([now, t.micro]);
    t.state = "abandoned";
    schedulePersist();
  } else {
    t.state = "released";
  }
  return true;
}

/** Counts for the operator surface: how much of the budget is in use. */
export function hangupForgivenessStatus(now = Date.now()) {
  const cfg = hangupForgivenessConfig();
  globalAbandoned = prune(globalAbandoned, now, cfg.windowMs);
  return {
    enabled: cfg.enabled,
    windowHours: Math.round((cfg.windowMs / 3_600_000) * 100) / 100,
    perKeyBudgetUsd: cfg.keyMicro / MICRO,
    globalBudgetUsd: cfg.globalMicro / MICRO,
    abandonedInWindow: globalAbandoned.length,
    abandonedUsdInWindow: sumOf(globalAbandoned) / MICRO,
    inflightUsd: globalInflight / MICRO,
    keysTracked: abandonedByKey.size,
    persisted: persistPath() !== null,
    lastPersistError: lastPersistError,
    // Routes a hang-up is never forgiven on (their effect outlives the answer).
    neverForgiven: LASTING_EFFECT_SLUG_LIST,
  };
}

// ---- Persistence of the abandoned records ----

let persistTimer = null;
let persistWriting = false;
let persistAgain = false;
let lastPersistError = null;

/** Where the abandoned records live, or null when nothing is persisted. */
export function persistPath() {
  const raw = String(process.env.HANGUP_FORGIVE_FILE ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  if (raw) return raw;
  return existsSync("/data") ? join("/data", "hangup-forgiveness.json") : null;
}

function snapshot(now = Date.now()) {
  const { windowMs } = hangupForgivenessConfig();
  globalAbandoned = prune(globalAbandoned, now, windowMs);
  const keys = [];
  for (const k of [...abandonedByKey.keys()]) {
    if (abandonedMicro(k, now, windowMs) > 0) keys.push([k, abandonedByKey.get(k)]);
  }
  return JSON.stringify({ v: FILE_VERSION, savedAt: now, global: globalAbandoned, keys });
}

function schedulePersist() {
  if (!persistPath() || persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; void persistNow(); }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** Write the abandoned records now (tmp + rename). Never throws. */
export async function persistNow() {
  const path = persistPath();
  if (!path) return false;
  if (persistWriting) { persistAgain = true; return false; }
  persistWriting = true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, snapshot(), { mode: 0o600 });
    await rename(tmp, path);
    lastPersistError = null;
    return true;
  } catch (err) {
    lastPersistError = String(err?.code || err?.message || err).slice(0, 80);
    return false;
  } finally {
    persistWriting = false;
    if (persistAgain) { persistAgain = false; schedulePersist(); }
  }
}

/** Synchronous flush for shutdown. Never throws. */
export function flushHangupForgiveness() {
  const path = persistPath();
  if (!path) return false;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-sync`;
    writeFileSync(tmp, snapshot(), { mode: 0o600 });
    renameSync(tmp, path);
    lastPersistError = null;
    return true;
  } catch (err) {
    lastPersistError = String(err?.code || err?.message || err).slice(0, 80);
    return false;
  }
}

// One [t, micro] record from the file, or null. Strict: a record from the
// future (past a minute of clock skew) or outside the window is dropped, and
// micro must be a positive whole number no larger than the service budget.
function cleanEntry(e, now, windowMs, maxMicro) {
  if (!Array.isArray(e) || e.length !== 2) return null;
  const [t, m] = e;
  if (!Number.isFinite(t) || !Number.isInteger(m) || m <= 0 || m > maxMicro) return null;
  if (t > now + 60_000 || now - t >= windowMs) return null;
  return [t, m];
}

/**
 * Read the abandoned records back at boot and merge them in, pruned to the
 * window. Anything malformed is skipped, never trusted. Returns what was
 * loaded; a missing file loads nothing.
 */
export function loadHangupForgiveness(now = Date.now()) {
  const path = persistPath();
  const out = { loaded: false, global: 0, keys: 0 };
  if (!path || !existsSync(path)) return out;
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (err) { lastPersistError = `load: ${String(err?.code || err?.message || err).slice(0, 60)}`; return out; }
  if (!doc || typeof doc !== "object" || doc.v !== FILE_VERSION) return out;
  const { windowMs } = hangupForgivenessConfig();
  // A sanity bound only: a record is never larger than the per-key budget
  // that granted it, and a budget lowered since then must not discard records
  // granted under the old one (they keep counting in full).
  const maxMicro = 1_000 * MICRO;
  const g = (Array.isArray(doc.global) ? doc.global : []).map((e) => cleanEntry(e, now, windowMs, maxMicro)).filter(Boolean);
  globalAbandoned = [...globalAbandoned, ...g].sort((a, b) => a[0] - b[0]);
  out.global = g.length;
  const rows = Array.isArray(doc.keys) ? doc.keys : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const [k, list] = row;
    if (typeof k !== "string" || !/^(ip|tempo|credits|payer):[0-9a-f]{24}$/.test(k) || !Array.isArray(list)) continue;
    const kept = list.map((e) => cleanEntry(e, now, windowMs, maxMicro)).filter(Boolean);
    if (!kept.length) continue;
    evictIfFull();
    abandonedByKey.set(k, [...(abandonedByKey.get(k) || []), ...kept].sort((a, b) => a[0] - b[0]));
    out.keys++;
  }
  out.loaded = true;
  return out;
}

/** Test seam only. */
export function _resetHangupForgiveness() {
  inflightByKey.clear(); globalInflight = 0; abandonedByKey.clear(); globalAbandoned = []; lastExhaustedLog = 0;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  lastPersistError = null;
}
