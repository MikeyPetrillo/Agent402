// The credits purchase checks, the card review signals a purchase is refused
// on, the automatic fraud-warning refund total, the failed-key bound and the
// connector sign-in's limits are private. They are read from CREDITS_GUARDS_JSON (raw JSON or
// base64; a host variable in production) or from the file named by
// CREDITS_GUARDS_FILE, and are never committed, printed or logged.
//
// Shape (docs/example-credits-guards.json shows it with placeholder values):
//   { purchase: { buyerPerHour, buyerPerDay, sourcePerHour, sourcePerDay,
//                 failedMax, failedWindowMs, failedHoldMs },
//     flagged:  { outcomeTypes: [string], riskLevels: [string] },
//     efw:      { warningRefundDayMaxUsd },
//     badKey:   { failedMax, windowMs },
//     mcpOAuth: { emailCodeTries, sendsPerEmail, sendsPerIp, failsPerEmail,
//                 lockoutMs, tokenPerIp, authorizePerIp, registerPerIp, windowMs,
//                 badTokenMax, pendingMax, documentMaxBytes, pendingPerAddress,
//                 pendingPerClient, sendsGlobalPerHour, sendsPerEmailDay,
//                 unusedClientIdleMs } }
//
// There are no defaults in code. Without a complete table credit sales and
// the connector sign-in stay off (creditsSalesEnabled in src/credits-sales.js
// reads creditsGuardsReady), and the status word reads attention while either
// switch asks for them (creditsGuardsWord).
import { readFileSync } from "node:fs";

const COUNTS = {
  purchase: ["buyerPerHour", "buyerPerDay", "sourcePerHour", "sourcePerDay", "failedMax", "failedWindowMs", "failedHoldMs"],
  efw: ["warningRefundDayMaxUsd"],
  badKey: ["failedMax", "windowMs"],
  mcpOAuth: ["emailCodeTries", "sendsPerEmail", "sendsPerIp", "failsPerEmail", "lockoutMs", "tokenPerIp", "authorizePerIp", "registerPerIp", "windowMs", "badTokenMax", "pendingMax", "documentMaxBytes", "pendingPerAddress", "pendingPerClient", "sendsGlobalPerHour", "sendsPerEmailDay", "unusedClientIdleMs"],
};
const LISTS = { flagged: ["outcomeTypes", "riskLevels"] };
/** Every key the table must hold, as "section.key" (for docs and tests). */
export const CREDITS_GUARD_KEYS = Object.freeze([
  ...Object.entries(COUNTS).flatMap(([s, ks]) => ks.map((k) => `${s}.${k}`)),
  ...Object.entries(LISTS).flatMap(([s, ks]) => ks.map((k) => `${s}.${k}`)),
]);

let cache = { src: null, state: "missing", table: null };

function rawSource() {
  const json = String(process.env.CREDITS_GUARDS_JSON || "").trim();
  if (json) return json.startsWith("{") ? json : Buffer.from(json, "base64").toString("utf8");
  const file = String(process.env.CREDITS_GUARDS_FILE || "").trim();
  if (file) { try { return readFileSync(file, "utf8"); } catch { return ""; } }
  return null;
}

function parse(text) {
  let o;
  try { o = JSON.parse(text); } catch { return { state: "partial", table: null }; }
  if (!o || typeof o !== "object") return { state: "partial", table: null };
  const out = {};
  for (const [s, ks] of Object.entries(COUNTS)) {
    out[s] = {};
    for (const k of ks) {
      const n = Number(o[s]?.[k]);
      if (!Number.isFinite(n) || n < 0 || (k !== "warningRefundDayMaxUsd" && n <= 0)) return { state: "partial", table: null };
      out[s][k] = n;
    }
    Object.freeze(out[s]);
  }
  for (const [s, ks] of Object.entries(LISTS)) {
    out[s] = {};
    for (const k of ks) {
      const v = o[s]?.[k];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { state: "partial", table: null };
      out[s][k] = Object.freeze([...v]);
    }
    Object.freeze(out[s]);
  }
  return { state: "ok", table: Object.freeze(out) };
}

function load() {
  const key = `${process.env.CREDITS_GUARDS_JSON ?? ""}\u0000${process.env.CREDITS_GUARDS_FILE ?? ""}`;
  if (cache.src === key) return cache;
  const text = rawSource();
  cache = { src: key, ...(text == null ? { state: "missing", table: null } : text === "" ? { state: "partial", table: null } : parse(text)) };
  return cache;
}

/** The complete table, or null (missing or incomplete). */
export const creditsGuards = () => load().table;
/** True when a complete table is loaded. */
export const creditsGuardsReady = () => load().table !== null;
/** "ok", "missing" or "partial" (present but not complete). */
export const creditsGuardsState = () => load().state;
/**
 * The status word: "ok" while neither switch that needs the table is set (a
 * deployment that sells no credits has nothing to page on) or the table is
 * complete; "attention" only while CREDITS_SALES or MCP_OAUTH is set and the
 * table is missing or incomplete (sales and the connector sign-in stay off).
 * @param {boolean} wanted  whether CREDITS_SALES or MCP_OAUTH asks for it
 */
export const creditsGuardsWord = (wanted) => (!wanted || creditsGuardsReady() ? "ok" : "attention");
