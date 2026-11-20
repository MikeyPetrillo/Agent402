// Where a paid-route caller came from, and why its 402 did not become a
// payment, in fixed vocabularies the funnel (src/funnel.js) counts per day and
// arrival path. Counts only: no address, header value, URL or wallet is kept
// beyond the in-memory trail below, which holds a keyed hash and one word.
//
//   uaFamilyOf(ua)          the client family a User-Agent names (UA_FAMILIES)
//   referrerClassOf(ref)    the kind of page a Referer names (REFERRER_CLASSES);
//                           the host itself is never stored
//   createDiscoveryTrail()  the discovery document a caller read last (llms,
//                           openapi, wellKnown, agentsMd, pricing, find, mcpCard)
//                           within FOUND_WINDOW_MS, keyed on a per-process HMAC
//                           of its address, held in memory only and capped
//   noPaymentReasonsOf(row) one funnel day row's refusals folded into the
//                           reasons a probe or attempt did not pay (NO_PAYMENT_REASONS)
import { createHmac, randomBytes } from "node:crypto";
import { NEXT_STEP_STATES } from "./next-step.js";

export const UA_FAMILIES = Object.freeze(["none", "curl", "python", "node", "go", "rust", "java", "dotnet", "ruby", "php", "browser", "agent", "bot", "other"]);
export const REFERRER_CLASSES = Object.freeze(["none", "self", "search", "code", "social", "assistant", "other"]);
export const DISCOVERY_DOCS = Object.freeze(["llms", "openapi", "wellKnown", "agentsMd", "pricing", "find", "mcpCard"]);
export const FOUND_VALUES = Object.freeze([...DISCOVERY_DOCS, "none"]);
/** The next-step states a refused attempt is counted under (src/next-step.js). */
export const NEXT_STEP_COUNTED = NEXT_STEP_STATES;
export const NO_PAYMENT_REASONS = Object.freeze(["noWalletHeader", "wrongNetwork", "belowBalance", "malformed", "timeout", "refused", "ourSide"]);

// Order matters: an agent framework UA often embeds its HTTP library's name,
// and a bot often claims a browser engine.
const UA_RULES = [
  ["bot", /bot\b|crawler|spider|slurp|bingpreview|facebookexternalhit|headlesschrome/i],
  ["agent", /claude|anthropic|openai|chatgpt|gptbot|perplexity|langchain|llamaindex|crewai|autogen|agentkit|x402|mppx|agent402|\bmcp\b|cursor|windsurf|cline|goose/i],
  ["curl", /^curl\/|\bwget\//i],
  ["python", /python|aiohttp|httpx|requests\/|urllib/i],
  ["node", /node(-fetch|\.js)?\b|undici|axios|got\b|\bdeno\b|\bbun\//i],
  ["go", /\bgo-http-client|\bgo\/\d|resty/i],
  ["rust", /reqwest|hyper\/|\brust\b/i],
  ["java", /\bjava\/|okhttp|apache-httpclient|jersey/i],
  ["dotnet", /\.net|dotnet|system\.net/i],
  ["ruby", /\bruby\b|faraday/i],
  ["php", /\bphp\b|guzzle/i],
  ["browser", /mozilla\/5\.0/i],
];
/** The client family a User-Agent header names, from UA_FAMILIES. */
export function uaFamilyOf(ua) {
  const s = typeof ua === "string" ? ua.slice(0, 512) : "";
  if (!s.trim()) return "none";
  for (const [fam, re] of UA_RULES) if (re.test(s)) return fam;
  return "other";
}

const REF_RULES = [
  ["search", /(^|\.)(google|bing|duckduckgo|yandex|baidu|ecosia|startpage|kagi|search\.brave|yahoo)\./i],
  ["code", /(^|\.)(github|gitlab|npmjs|pypi|stackoverflow|huggingface|codeberg)\./i],
  ["social", /(^|\.)(x|twitter|t|reddit|linkedin|farcaster|warpcast|discord|youtube|news\.ycombinator|telegram|t\.me)\./i],
  ["assistant", /(^|\.)(chatgpt|openai|claude|anthropic|perplexity|gemini|copilot|poe|you|phind)\./i],
];
/** The kind of page a Referer header names, from REFERRER_CLASSES. `ownHost` is ours. */
export function referrerClassOf(referer, ownHost = "") {
  if (typeof referer !== "string" || !referer) return "none";
  let host;
  try { host = new URL(referer.slice(0, 2048)).hostname.toLowerCase(); } catch { return "other"; }
  const own = String(ownHost || "").toLowerCase().replace(/^www\./, "");
  if (own && (host === own || host === `www.${own}`)) return "self";
  for (const [cls, re] of REF_RULES) if (re.test(`${host}.`)) return cls;
  return "other";
}

/** The discovery document a request path is, or null. */
export function discoveryDocOf(path) {
  const p = String(path || "").split("?")[0];
  if (p === "/llms.txt" || p === "/llms-full.txt" || p === "/llms-install.md") return "llms";
  if (p === "/openapi.json" || p === "/openapi.yaml") return "openapi";
  if (p === "/.well-known/x402" || p === "/.well-known/x402.json") return "wellKnown";
  if (p === "/agents.md" || p === "/AGENTS.md") return "agentsMd";
  if (p === "/api/pricing") return "pricing";
  if (p === "/api/find" || p === "/api/route") return "find";
  if (p.startsWith("/.well-known/mcp") || p === "/server.json" || p === "/.well-known/glama.json") return "mcpCard";
  return null;
}

export const FOUND_WINDOW_MS = Math.max(60_000, Number(process.env.FUNNEL_FOUND_WINDOW_MS) || 6 * 3600_000);
export const FOUND_CAP = Math.max(100, Number(process.env.FUNNEL_FOUND_CAP) || 50_000);

/** The last discovery document each caller read, by keyed hash, bounded in count and age. */
export function createDiscoveryTrail({ windowMs = FOUND_WINDOW_MS, cap = FOUND_CAP } = {}) {
  const key = randomBytes(32);
  const seen = new Map(); // keyed caller -> { doc, at }; insertion order is age order
  const callerOf = (ip) => createHmac("sha256", key).update(String(ip)).digest("base64url").slice(0, 16);
  function note(ip, doc, now = Date.now()) {
    if (ip == null || !DISCOVERY_DOCS.includes(doc)) return;
    const k = callerOf(ip);
    seen.delete(k);
    seen.set(k, { doc, at: now });
    while (seen.size > cap) seen.delete(seen.keys().next().value);
  }
  function foundVia(ip, now = Date.now()) {
    if (ip == null) return "none";
    // Expired entries at the old end go first; the trail never outlives its window.
    for (const [k, e] of seen) { if (now - e.at < windowMs) break; seen.delete(k); }
    const e = seen.get(callerOf(ip));
    return e && now - e.at < windowMs ? e.doc : "none";
  }
  return { note, foundVia, size: () => seen.size };
}

// The refusal words (src/payment-reject.js and the verify hint) a stored
// `reasons` key folds into. Anything not named here reads "refused".
const REASON_FOLD = Object.freeze({
  "unsupported-network": "wrongNetwork",
  "unsupported-scheme": "wrongNetwork",
  "insufficient-funds": "belowBalance",
  "no-token-account": "belowBalance",
  "malformed-header": "malformed",
  "version-mismatch": "malformed",
  "malformed-payload": "malformed",
  "missing-accepted": "malformed",
  "requirements-mismatch": "malformed",
  "wrong-recipient": "malformed",
  "amount-below-price": "malformed",
  "not-checked": "timeout",
  "settlement-unconfirmed": "timeout",
  "facilitator-quota": "ourSide",
});

/**
 * Why requests to a paid route did not pay, for one funnel row (one arrival,
 * one day, or a sum of them): probes whose caller never sent a credential
 * (noWalletHeader), and refused attempts by the folded reason; attempts
 * answered 408 or 504 count as timeout beside the refusals.
 */
export function noPaymentReasonsOf(row) {
  const out = Object.fromEntries(NO_PAYMENT_REASONS.map((r) => [r, 0]));
  if (!row || typeof row !== "object") return out;
  out.noWalletHeader = Number(row.neverRetried) || 0;
  for (const [reason, n] of Object.entries(row.reasons || {})) {
    const k = Object.hasOwn(REASON_FOLD, reason) ? REASON_FOLD[reason] : "refused";
    out[k] += Number(n) || 0;
  }
  out.timeout += Number(row.timeouts) || 0;
  return out;
}

/**
 * Probe-to-payment by source for one funnel row: for each of ua, referrer and
 * found, every word seen with its probes, settlements and settled per probe.
 * A settlement is counted under the word its own request carried, so a buyer
 * who probed with one client and paid with another moves between rows.
 */
export function conversionBySource(row) {
  const out = {};
  for (const dim of ["ua", "referrer", "found"]) {
    const probes = row?.[dim] || {}, paid = row?.[`${dim}Paid`] || {};
    const words = [...new Set([...Object.keys(probes), ...Object.keys(paid)])].sort();
    out[dim] = Object.fromEntries(words.map((w) => {
      const p = Number(probes[w]) || 0, s = Number(paid[w]) || 0;
      return [w, { probes: p, settled: s, settledPerProbe: p ? +(s / p).toFixed(4) : null }];
    }));
  }
  return out;
}
