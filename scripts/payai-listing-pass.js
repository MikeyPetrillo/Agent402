#!/usr/bin/env node
// Listing pass: settle one payment on every route a registry lacks on a chain,
// through the facilitator that registry harvests, once each, cheapest first,
// under a per-run spend ceiling. Four legs, one per registry and chain:
//
//   --registry bazaar --chain base     CDP settles it (first on Base by boot
//                                      order); the Bazaar is CDP's discovery
//                                      index, harvested from CDP settlements.
//   --registry bazaar --chain solana   CDP settles it too: CDP is first on
//                                      every chain its /supported lists, Solana
//                                      included (src/payments.js). The buy is
//                                      untagged, and before it spends the pass
//                                      proves the untagged Solana signer is not
//                                      PayAI's (tagged and untagged 402s differ).
//   --registry payai --chain solana    PayAI settles it, on request: the PayAI
//   --registry payai --chain base      registry is harvested from the
//                                      settlements PayAI facilitates, and CDP
//                                      is first on both chains, so each buy
//                                      carries X-Agent402-Settle-Via: payai and
//                                      the operator token.
//
// The settle-via preference (src/settle-preference.js) is network-generic: an
// honored request runs inside one scope whose vendor lookups (the 402 offer,
// verify, settle) read PayAI's /supported first, for every network PayAI
// lists there. PayAI lists exact v2 on Base and on Solana, so a tagged Base
// buy is verified and settled by PayAI exactly as a tagged Solana one is
// (scripts/test-settle-preference.js pins both). The paid retry carries the
// same headers (the client replays its init).
//
// Before the first PayAI buy the pass reads one route's 402 with and without
// the headers and requires the Solana feePayer to differ: the scope covers the
// whole request, so that proves the gate is open on any chain. On Base, where
// the 402 names no facilitator signer, it also reads PayAI's own /supported and
// requires an exact v2 kind on the chain. Either check failing spends nothing.
//
// A route quoted per request (`quoted: true` in /api/pricing: its price is
// computed from the input) has no list price to trust. Before selection the
// pass sends that route's published example unpaid and reads the amount the
// 402 names on this chain's exact accept: the amount the buyer would sign.
// That amount is the route's price for --max-price, --max-spend, the
// cheapest-first order and the spend total. A route whose example does not
// answer 402 (or names no accept on this chain) is skipped with the reason.
// A list-priced route is priced at its list price plus the chain's premium,
// read once from the cheapest list-priced candidate's own 402. Every buy
// carries a client policy that refuses any accept above the amount the pass
// priced it at, so nothing is signed above what was selected.
//
// There is no per-route price cap by default: every paid route is in scope,
// the report products and both route-execute tiers included (those two also
// spend the router's spending wallet at an outside seller while they serve).
// The bound is the per-run ceiling, --max-spend (default $40 per leg), cut as
// a prefix of the cheapest-first order.
//
// DEFAULT IS A DRY RUN. `--live` sends real money.
//
//   node scripts/payai-listing-pass.js                                  # payai / solana: measure, select, price
//   node scripts/payai-listing-pass.js --registry payai --chain base    # payai / base
//   node scripts/payai-listing-pass.js --registry bazaar --chain solana
//   node scripts/payai-listing-pass.js --live --only hash,page-speed
//   node scripts/payai-listing-pass.js --include-upstream --only dub    # quote one route
//   node scripts/payai-listing-pass.js --live --include-upstream --max-spend 2 --out /tmp/pass.json
//
// Flags: --registry payai|bazaar (default payai), --chain base|solana (default
// solana), --max-spend USD (the ceiling on one run: the selection is cheapest
// first and the routes past it are skipped with "past --max-spend"; every
// signed attempt, a retry included, counts at its signing ceiling, so no
// attempt is signed once the next would pass it; default 40), --max-price USD
// (optional per-route cap, positive; none by default), --only slug,slug,
// --limit N (a whole number), --pause-ms (default 1500 between buys), --out
// FILE (route/status/tx/charged records as JSON, rewritten after every
// attempt), --bought DIR (the purchase memory: pass records of earlier runs,
// read recursively; required with --live), --rebuy-after-days N (default and
// minimum 14: a route charged, or attempted with an unknown outcome, within
// that many days on this registry and chain is skipped as "bought <date>,
// awaiting registry", whatever coverage says),
// --include-upstream (a route that serves through a vendor call: the list
// price lands in our own treasury, the vendor call is the real cost, so
// skipped unless given), --settle-wait-ms (before the closing re-measure,
// default 60000).
//
// Env: SOLANA_BURNER_KEY (Solana legs: base58 64-byte secret or JSON byte
// array; never printed), BURNER_KEY (Base legs: 0x hex EVM key; never
// printed), AGENT402_OPERATOR_TOKEN (the settle-via gate, needed by the PayAI
// legs and the Bazaar Solana check; never printed), POW_SECRET (optional: the
// signed X-Heartbeat-Token books the buys as ours), TARGET_URL,
// LISTING_ORIGIN, PAYAI_REGISTRY_URL, BAZAAR_REGISTRY_URL,
// PAYAI_FACILITATOR_URL (where PayAI's /supported is read).
//
// Scheduled: .github/workflows/listing-pass.yml runs the four legs live every
// Wednesday 03:53 UTC (and on dispatch) in the spending environment, and keeps
// one issue ("Listing pass FAILED") open while a run fails.
//
// Purposeful inputs: --inputs FILE is a JSON map, "METHOD /path" -> request
// body (a query object for a GET). A route with an entry is quoted and bought
// with that body instead of its published example (scripts/listing-inputs.json:
// the routes at $0.25 or more, plus the X user lookup, on inputs whose answers
// serve Agent402 and can be graded); every other route keeps its example. Each record keeps what came
// back: status, latency, the identifying response headers (request id,
// model and generation headers, the decoded payment receipt) and the body up
// to 20 KB. Request headers are never stored.
//
// Retries: one, only on a 503 or 504, and never on a route with a lasting
// effect (hasLastingEffect, the route-execute tiers), a report product, or a
// route priced at $0.25 or more: those get one attempt. A request that threw
// may have settled, so it is never retried and its record says chargeUnknown.
//
// Exit: 0 nothing missing, nothing selected, or every selected buy settled
// (registry ingestion lag is theirs); 1 a selected buy failed; 2 misconfigured
// or the preflight refused (nothing spent).
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { hasLastingEffect } from "../src/hangup-forgiveness.js";
import { REPORT_TIERS } from "../src/report-tiers.js";
import { measureCoverage, missingIn, renderTable, examplesFromOpenapi, multipartKeysFromOpenapi, chainOf, CHAINS } from "./listing-coverage.js";
import { multipartBodyFrom } from "../src/openapi-request.js";

export const SETTLE_VIA = "payai";
export const REGISTRIES = ["bazaar", "payai"];
/** The chains a leg can pay on: one signer per family. */
export const PAY_CHAINS = ["base", "solana"];
/** No per-route cap by default: every paid route is in scope. */
export const DEFAULT_MAX_PRICE_USD = Infinity;
/** The per-run (per-leg) ceiling on the summed price of the selection. */
export const DEFAULT_MAX_SPEND_USD = 40;
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";
/** A route bought this recently is never bought again, whatever coverage says. */
export const DEFAULT_REBUY_AFTER_DAYS = 14;
/** At or above this price a route gets one attempt, never a retry. */
export const ONE_ATTEMPT_MIN_USD = 0.25;
/** The only statuses a buy is retried on. */
export const RETRY_STATUSES = Object.freeze([503, 504]);
/** The most of a response body a record keeps. */
export const BODY_KEEP_BYTES = 20 * 1024;

/**
 * Pure: read an --inputs map. Every key is "METHOD /path" and every value a
 * plain object; anything else throws, so a malformed file stops the run.
 */
export function parseInputs(doc, source = "inputs") {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${source}: not a JSON object`);
  const out = new Map();
  for (const [k, v] of Object.entries(doc)) {
    if (!/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(k)) throw new Error(`${source}: key ${JSON.stringify(k)} is not "METHOD /path"`);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${source}: ${k} is not an object`);
    out.set(k, v);
  }
  return out;
}

/** Pure: the purposeful input for a route, or null (the route keeps its example). */
export function purposefulInputFor(r, inputs) {
  return (inputs && r && inputs.get(routeKeyOf(r))) || null;
}

/**
 * Pure: the response headers that identify a request and what served it:
 * request ids, model and generation headers, and the decoded payment
 * receipt (transaction, network, success, error reason). Nothing else.
 */
export function identifyingHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const name = k.toLowerCase();
    if (/request-id|generation|model|^x-agent402-/.test(name) && !/token|secret|key|auth|cookie/.test(name)) out[name] = String(v).slice(0, 500);
  }
  const h = headers.get("payment-response") || headers.get("x-payment-response");
  if (h) {
    try {
      const p = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      out["payment-response"] = { success: p?.success ?? null, transaction: p?.transaction ?? null, network: p?.network ?? null, ...(p?.errorReason ? { errorReason: String(p.errorReason).slice(0, 200) } : {}) };
    } catch { out["payment-response"] = { unreadable: true }; }
  }
  return out;
}

/** Pure: a response body as a record keeps it: text up to BODY_KEEP_BYTES, binary as a note. */
export function keptBody(bytes, contentType = "") {
  const buf = Buffer.from(bytes || new Uint8Array());
  const textual = !contentType || /json|text|xml|markdown|event-stream|javascript/i.test(contentType);
  if (!textual) return { body: `<${contentType}, ${buf.length} bytes, not kept>`, bodyBytes: buf.length, bodyTruncated: buf.length > 0 };
  let body = buf.subarray(0, BODY_KEEP_BYTES).toString("utf8");
  if (buf.length > BODY_KEEP_BYTES) body = body.replace(/\uFFFD$/, "");
  return { body, bodyBytes: buf.length, bodyTruncated: buf.length > BODY_KEEP_BYTES };
}

export const routeKeyOf = (r) => `${r.method} ${r.path}`;
const usdToAtomic = (usd) => BigInt(Math.round(Number(usd) * 1e6));

/**
 * Pure: the routes a pass would consider before pricing: missing in the
 * registry on the chain, named by --only (when given), and not a
 * vendor-calling route unless included. These are the quoted routes worth an
 * unpaid 402 read.
 */
export function candidatesOf(coverage, { registry = "payai", chain = "solana", only = null, includeUpstream = false, bought = null } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  return missingIn(coverage, registry, chain).filter((r) => (!onlySet || onlySet.has(r.slug)) && (r.computePayable || includeUpstream) && !bought?.has(boughtKeyOf({ registry, chain, method: r.method, path: r.path })));
}

// --- purchase memory ----------------------------------------------------------
// A registry lists a paid route on its own schedule (the Bazaar on its next
// discovery refresh), so coverage alone would have every run buy the same
// unlisted route again. Each run's records are kept as workflow artifacts and
// downloaded into one directory before the next run (scripts/
// listing-pass-memory.js); a route charged within the window on the same
// registry and chain is skipped.

/** The memory key: registry, chain, method and path (query dropped). */
export const boughtKeyOf = ({ registry, chain, method, path }) =>
  `${String(registry || "").toLowerCase()} ${String(chain || "").toLowerCase()} ${String(method || "POST").toUpperCase()} ${String(path || "").split("?")[0]}`;

/**
 * Pure: the purchases one parsed record file holds, in any schema written so
 * far. The four-leg pass writes `registry` and `chain` on the file and each
 * record, and `boughtAt` per record. The PayAI-only pass before it wrote
 * neither `registry` nor `boughtAt`: it only bought for PayAI, so a file
 * without a registry is PayAI's, dated by its `measuredAt`. The Bazaar mint
 * writes the four-leg shape. A record counts when it was charged or when its
 * request ended without an answer (`chargeUnknown`: it may have settled).
 * Throws on a file that is not a record file, so a run never spends on a
 * memory it could not read.
 */
export function purchasesOf(doc, source = "record file") {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.records)) throw new Error(`${source}: no records array`);
  const fileAt = Date.parse(doc.measuredAt || doc.startedAt || "");
  const out = [];
  for (const rec of doc.records) {
    if (!rec || typeof rec !== "object") throw new Error(`${source}: a record is not an object`);
    if (rec.charged !== true && rec.chargeUnknown !== true) continue;
    const registry = String(rec.registry || doc.registry || "payai").toLowerCase();
    const chain = String(rec.chain || doc.chain || "").toLowerCase();
    if (!chain || typeof rec.path !== "string" || !rec.path.startsWith("/")) throw new Error(`${source}: a charged record names no chain or path`);
    const at = Date.parse(rec.boughtAt || "");
    const when = Number.isFinite(at) ? at : Number.isFinite(fileAt) ? fileAt : null;
    out.push({ key: boughtKeyOf({ registry, chain, method: rec.method, path: rec.path }), registry, chain, method: String(rec.method || "POST").toUpperCase(), path: rec.path.split("?")[0], slug: rec.slug || null, at: when, unknown: rec.charged !== true });
  }
  return out;
}

function jsonFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsonFilesUnder(p));
    else if (st.isFile() && name.endsWith(".json")) out.push(p);
  }
  return out;
}

/**
 * Every purchase in the record files under `dir` (recursively) within the
 * last `days`: Map(key -> { at, slug, unknown }), the latest per key. A
 * record with no readable date counts (its artifact was itself downloaded
 * only because it is recent). Throws on an unreadable file.
 */
export function loadPurchaseMemory(dir, { now = Date.now(), days = DEFAULT_REBUY_AFTER_DAYS } = {}) {
  const files = jsonFilesUnder(dir);
  const bought = new Map();
  const since = now - days * 86_400_000;
  let records = 0;
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(f, "utf8")); } catch (e) { throw new Error(`${f}: not JSON (${String(e?.message || e).slice(0, 80)})`); }
    for (const p of purchasesOf(doc, f)) {
      if (p.at != null && p.at < since) continue;
      records++;
      const prev = bought.get(p.key);
      if (!prev || (prev.at != null && (p.at == null || p.at > prev.at))) bought.set(p.key, p);
    }
  }
  return { bought, files: files.length, records };
}

/** Pure: the SKIP reason a remembered purchase carries. */
export const boughtWhy = (b) => `bought ${b.at != null ? new Date(b.at).toISOString().slice(0, 10) : "(date unknown)"}${b.unknown ? " (outcome unknown)" : ""}, awaiting registry`;

/**
 * Pure: a route that gets one attempt, never a retry: a lasting effect (the
 * memory writers, attest, the route-execute tiers, which also pay an outside
 * seller), a report product, or a price at or above ONE_ATTEMPT_MIN_USD.
 */
export function oneAttemptOnly(r) {
  const slug = String(r?.slug ?? "");
  return hasLastingEffect(slug) || slug.startsWith("route-execute") || Object.hasOwn(REPORT_TIERS, slug)
    || Number(r?.priceUsd) >= ONE_ATTEMPT_MIN_USD || Number(r?.listPriceUsd) >= ONE_ATTEMPT_MIN_USD;
}

/** Pure: may a buy that answered `status` be tried once more? */
export const mayRetry = (r, status) => RETRY_STATUSES.includes(status) && !oneAttemptOnly(r);

/**
 * Pure: the amount a decoded 402 envelope asks on one chain's exact accept,
 * as { atomic (BigInt), usd }, or null when it names no such accept or an
 * unreadable amount. USDC carries 6 decimals unless the accept says otherwise.
 */
export function quoteOf(pr, caip2) {
  const a = (pr?.accepts || []).find((x) => x?.network === caip2 && x?.scheme === "exact");
  const raw = a?.amount ?? a?.maxAmountRequired;
  if (raw == null || !/^\d+$/.test(String(raw))) return null;
  const decimals = Number.isInteger(a?.extra?.decimals) ? a.extra.decimals : 6;
  const atomic = BigInt(String(raw));
  if (atomic <= 0n) return null;
  return { atomic, usd: Number(atomic) / 10 ** decimals };
}

/** A published example whose `file` part is a "multipart" placeholder. */
export const isMultipartExample = (ex) => typeof ex?.file === "string" && /multipart/i.test(ex.file);
/** JSON bodies are strings; a FormData body lets fetch set its own boundary. */
const jsonHeader = (body) => (typeof body === "string" ? { "Content-Type": "application/json" } : {});

/** One unpaid read of a route's 402 on this chain: { atomic, usd } or { why }. */
export async function readQuote(r, { caip2, requestFor, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const { url, body } = await requestFor(r);
  try {
    const res = await fetchImpl(url, {
      method: r.method,
      headers: { Accept: "application/json", ...jsonHeader(body) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text().catch(() => "");
    if (res.status !== 402) return { why: `example did not quote: HTTP ${res.status}, not 402` };
    let pr = null;
    try { pr = JSON.parse(Buffer.from(res.headers.get("payment-required") || "", "base64").toString("utf8")); } catch { pr = null; }
    return quoteOf(pr, caip2) || { why: "example did not quote: the 402 names no readable exact accept on this chain" };
  } catch (e) {
    return { why: `example did not quote: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * Read each quoted route's price from its own 402: the published example is
 * sent unpaid, and the amount named on this chain's exact accept is the
 * price. Returns Map(routeKey -> { atomic, usd } | { why }). Nothing is paid.
 */
export async function quoteRoutes(routes, opts = {}) {
  const out = new Map();
  for (const r of routes) {
    if (!r.quoted) continue;
    out.set(routeKeyOf(r), await readQuote(r, opts));
  }
  return out;
}

/**
 * Pure: the chain's premium over list, in atomic units, from one list-priced
 * route's 402 quote. Never negative; 0 when the quote is unreadable.
 */
export function premiumOf(quote, listUsd) {
  if (!quote || quote.why || typeof quote.atomic !== "bigint") return 0n;
  const d = quote.atomic - usdToAtomic(listUsd);
  return d > 0n ? d : 0n;
}

/**
 * Pure: the routes to buy, cheapest first. A route is selected when it sells
 * on the chain, the registry lacks it there, and its price is within the cap
 * (none by default). A quoted route is priced by its 402 quote (`quotes`,
 * from quoteRoutes) and skipped with the reason when it has none; a
 * list-priced route at its list price plus `premiumAtomic`. Each selected
 * route carries `ceilingAtomic`, the most its buy may sign. `limit` cuts the
 * cheapest-first order by count, `maxSpendUsd` by summed price.
 */
export function selectPass(coverage, { registry = "payai", chain = "solana", maxPriceUsd = DEFAULT_MAX_PRICE_USD, maxSpendUsd = DEFAULT_MAX_SPEND_USD, only = null, limit = Infinity, includeUpstream = false, quotes = null, premiumAtomic = 0n, bought = null } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  const missing = missingIn(coverage, registry, chain);
  const skipped = [];
  const selected = [];
  const capNote = `above the $${maxPriceUsd} cap`;
  for (const listed of missing) {
    if (onlySet && !onlySet.has(listed.slug)) continue;
    let r = listed;
    // Bought recently: the registry has not listed it yet. Never again
    // inside the window, whatever coverage says.
    const b = bought?.get(boughtKeyOf({ registry, chain, method: r.method, path: r.path }));
    if (b) { skipped.push({ ...r, why: boughtWhy(b) }); continue; }
    // The list price only moves between our own wallets; a route that calls
    // a vendor while it serves is real spend, so it is bought only on request.
    if (!r.computePayable && !includeUpstream) { skipped.push({ ...r, why: "serves through an upstream vendor call (pass --include-upstream)" }); continue; }
    if (r.quoted) {
      const q = quotes?.get(routeKeyOf(r));
      if (!q) { skipped.push({ ...r, why: "quoted per request, no 402 quote read" }); continue; }
      if (q.why) { skipped.push({ ...r, why: q.why }); continue; }
      r = { ...r, listPriceUsd: r.priceUsd, priceUsd: q.usd, quotedAtomic: q.atomic, ceilingAtomic: q.atomic };
      if (r.priceUsd > maxPriceUsd) { skipped.push({ ...r, why: `the 402 quotes $${r.priceUsd}, ${capNote}` }); continue; }
    } else if (r.priceUsd > 0) {
      const ceilingAtomic = usdToAtomic(r.priceUsd) + (premiumAtomic > 0n ? premiumAtomic : 0n);
      r = { ...r, listPriceUsd: r.priceUsd, priceUsd: Number(ceilingAtomic) / 1e6, ceilingAtomic };
    }
    if (!(r.priceUsd > 0)) { skipped.push({ ...r, why: "no fixed price" }); continue; }
    if (r.priceUsd > maxPriceUsd) { skipped.push({ ...r, why: capNote }); continue; }
    selected.push(r);
  }
  selected.sort((a, b) => a.priceUsd - b.priceUsd || a.path.localeCompare(b.path));
  const byCount = selected.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : selected.length);
  for (const r of selected.slice(byCount.length)) skipped.push({ ...r, why: "past --limit" });
  // The spend ceiling is a prefix of the same cheapest-first order: once the
  // running sum would pass it, nothing dearer can fit either.
  const chosen = [];
  let estimateUsd = 0;
  for (const r of byCount) {
    if (estimateUsd + r.priceUsd > maxSpendUsd + 1e-9) { skipped.push({ ...r, why: "past --max-spend" }); continue; }
    chosen.push(r);
    estimateUsd += r.priceUsd;
  }
  return { missing: missing.length, selected: chosen, skipped, estimateUsd };
}

/** Pure: do two decoded 402 envelopes name different Solana signers? */
export function preferenceHonored(control, tagged, caip2 = CHAINS.solana) {
  const fee = (pr) => (pr?.accepts || []).find((a) => a?.network === caip2 && a?.scheme === "exact")?.extra?.feePayer || null;
  const c = fee(control), t = fee(tagged);
  return { honored: !!c && !!t && c !== t, controlFeePayer: c, taggedFeePayer: t };
}

/** Pure: does a facilitator /supported answer list exact v2 on this chain? */
export function supportsExact(supported, caip2) {
  return (Array.isArray(supported?.kinds) ? supported.kinds : []).some((k) => k && k.x402Version === 2 && k.scheme === "exact" && k.network === caip2);
}

/** Pure: the headers a leg's buys carry. Only a PayAI leg names a facilitator. */
export function legHeaders(registry, token) {
  return registry === "payai" ? { "X-Agent402-Settle-Via": SETTLE_VIA, "X-Operator-Token": token } : {};
}

/** The settlement receipt a 200 carries, decoded, or null. */
export function receiptOf(res) {
  const h = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

function flag(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : true;
}

const usdFlag = (v) => (v !== true && String(v).trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);

export function parseArgs(argv) {
  const maxPrice = flag(argv, "--max-price", null);
  const maxSpend = flag(argv, "--max-spend", null);
  const limit = flag(argv, "--limit", null);
  const only = flag(argv, "--only", null);
  const bought = flag(argv, "--bought", null);
  const rebuy = flag(argv, "--rebuy-after-days", null);
  const inputs = flag(argv, "--inputs", null);
  return {
    live: argv.includes("--live"),
    includeUpstream: argv.includes("--include-upstream"),
    registry: String(flag(argv, "--registry", "payai")).toLowerCase(),
    // Absent: no per-route cap. Given but unreadable (or zero): NaN, and main
    // refuses to run rather than guess what the caller meant.
    maxPriceUsd: maxPrice == null ? DEFAULT_MAX_PRICE_USD : (usdFlag(maxPrice) > 0 ? usdFlag(maxPrice) : NaN),
    // Absent: the default ceiling. Given but unreadable: NaN, and main
    // refuses to run rather than buy without the ceiling the caller meant.
    maxSpendUsd: maxSpend == null ? DEFAULT_MAX_SPEND_USD : usdFlag(maxSpend),
    only: typeof only === "string" ? only.split(",") : null,
    // Absent: no count limit. Given: a whole number, or NaN and main refuses
    // (an unreadable --limit never means "no limit").
    limit: limit == null ? Infinity : (limit !== true && /^\d+$/.test(String(limit).trim()) ? Number(limit) : NaN),
    // The purchase memory directory; `true` (the flag without a value) and
    // main refuses.
    bought: bought == null ? null : bought,
    // The purposeful inputs file; `true` (no value) and main refuses.
    inputs: inputs == null ? null : inputs,
    // Days a purchase is remembered: the default, or a larger number. Below
    // the default (or unreadable) is NaN and main refuses: no run may rebuy
    // sooner than the owner's window.
    rebuyAfterDays: rebuy == null ? DEFAULT_REBUY_AFTER_DAYS : (rebuy !== true && Number.isFinite(Number(rebuy)) && Number(rebuy) >= DEFAULT_REBUY_AFTER_DAYS ? Number(rebuy) : NaN),
    pauseMs: Math.max(0, Number(flag(argv, "--pause-ms", 1500)) || 0),
    out: typeof flag(argv, "--out") === "string" ? flag(argv, "--out") : null,
    settleWaitMs: Math.max(0, Number(flag(argv, "--settle-wait-ms", 60_000)) || 0),
    chain: String(flag(argv, "--chain", "solana")),
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function heartbeatHeader(secret) {
  if (!secret) return {};
  const minute = Math.floor(Date.now() / 60_000);
  return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
}

/**
 * Pure: an x402Client policy that keeps only accepts on the ceiling's chain
 * whose amount is at or under the ceiling. An empty result makes the client
 * refuse before anything is signed.
 */
export function ceilingPolicy(getCeiling) {
  return (_version, reqs) => {
    const c = getCeiling();
    return (reqs || []).filter((r) => {
      const raw = r?.amount ?? r?.maxAmountRequired;
      return r?.network === c.caip2 && raw != null && /^\d+$/.test(String(raw)) && BigInt(String(raw)) <= c.atomic;
    });
  };
}

/** The env var that holds a chain's paying key. */
export const keyEnvFor = (chainName) => (chainName === "solana" ? "SOLANA_BURNER_KEY" : "BURNER_KEY");

/**
 * A pay-capable fetch on the leg's chain: the SVM signer for Solana, the EVM
 * signer (viem account, the same @x402/evm exact client mint-bazaar-rows.js
 * uses) for Base. Every accept above the ceiling is refused by the policy.
 */
export async function buildPayFetchFor(chainName, rawKey, getCeiling) {
  const [{ x402Client }, { wrapFetchWithPayment }] = await Promise.all([import("@x402/core/client"), import("@x402/fetch")]);
  const client = disableVendorSpendControls(new x402Client());
  let address;
  if (chainName === "solana") {
    const [kit, { registerExactSvmScheme }] = await Promise.all([import("@solana/kit"), import("@x402/svm/exact/client")]);
    const bytes = rawKey.startsWith("[") ? Uint8Array.from(JSON.parse(rawKey)) : new Uint8Array(kit.getBase58Encoder().encode(rawKey));
    const signer = await kit.createKeyPairSignerFromBytes(bytes);
    registerExactSvmScheme(client, { signer });
    address = signer.address;
  } else {
    const [{ privateKeyToAccount }, { registerExactEvmScheme }] = await Promise.all([import("viem/accounts"), import("@x402/evm/exact/client")]);
    const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);
    registerExactEvmScheme(client, { signer: account });
    address = account.address;
  }
  client.registerPolicy(ceilingPolicy(getCeiling));
  return { payFetch: wrapFetchWithPayment(fetch, client), address };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const measure = deps.measureCoverage || measureCoverage;
  const buildPayFetch = deps.buildPayFetch || buildPayFetchFor;
  const sleep = deps.sleep || sleepMs;
  const log = deps.log || ((m) => console.log(m));
  const err = deps.error || ((m) => console.error(m));
  const opts = parseArgs(argv);
  const target = String(env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
  const chain = chainOf(opts.chain);
  const registry = opts.registry;
  const leg = `${registry} / ${chain?.name || opts.chain}`;
  if (!REGISTRIES.includes(registry)) { err(`payai-listing-pass: unknown registry ${opts.registry} (bazaar or payai)`); return 2; }
  if (!chain) { err(`payai-listing-pass: unknown chain ${opts.chain}`); return 2; }
  if (!PAY_CHAINS.includes(chain.name)) { err(`payai-listing-pass: the pass pays on ${PAY_CHAINS.join(" or ")}, not ${chain.name}`); return 2; }
  if (Number.isNaN(opts.maxSpendUsd)) { err("payai-listing-pass: --max-spend needs a non-negative USD amount"); return 2; }
  if (Number.isNaN(opts.maxPriceUsd)) { err("payai-listing-pass: --max-price needs a positive USD amount"); return 2; }
  if (Number.isNaN(opts.limit)) { err("payai-listing-pass: --limit needs a whole number of routes"); return 2; }
  if (Number.isNaN(opts.rebuyAfterDays)) { err(`payai-listing-pass: --rebuy-after-days needs a number of days, at least ${DEFAULT_REBUY_AFTER_DAYS}`); return 2; }
  if (opts.bought === true) { err("payai-listing-pass: --bought needs a directory"); return 2; }
  if (opts.inputs === true) { err("payai-listing-pass: --inputs needs a file"); return 2; }
  let inputs = null;
  if (opts.inputs) {
    try { inputs = parseInputs(JSON.parse(readFileSync(opts.inputs, "utf8")), opts.inputs); }
    catch (e) { err(`payai-listing-pass: unreadable --inputs: ${String(e?.message || e).slice(0, 200)}. Nothing spent.`); return 2; }
  }
  if (opts.live && !opts.bought) { err("payai-listing-pass: --live needs --bought DIR, the records of earlier runs (scripts/listing-pass-memory.js fetches them; an empty directory means none). Nothing spent."); return 2; }
  // The purchase memory is read before anything else: a run that cannot read
  // it spends nothing.
  let memory = { bought: new Map(), files: 0, records: 0 };
  if (opts.bought) {
    if (!existsSync(opts.bought) || !statSync(opts.bought).isDirectory()) { err(`payai-listing-pass: --bought ${opts.bought} is not a directory. Nothing spent.`); return 2; }
    try { memory = loadPurchaseMemory(opts.bought, { now: deps.now ? deps.now() : Date.now(), days: opts.rebuyAfterDays }); }
    catch (e) { err(`payai-listing-pass: unreadable purchase record: ${String(e?.message || e).slice(0, 200)}. Nothing spent.`); return 2; }
  }
  const token = String(env.AGENT402_OPERATOR_TOKEN || "").trim();
  const rawKey = String(env[keyEnvFor(chain.name)] || "").trim();
  const sol = chainOf("solana");

  log(`target ${target} · ${leg} (${chain.caip2}) · ${Number.isFinite(opts.maxPriceUsd) ? `cap $${opts.maxPriceUsd} per route` : "no per-route cap"} · ceiling $${opts.maxSpendUsd} per run${opts.live ? " · LIVE" : " · dry run"}`);
  if (inputs) log(`purposeful inputs: ${inputs.size} route(s) from ${opts.inputs} (each sent in place of its example)`);
  if (opts.bought) log(`purchase memory: ${memory.records} purchase(s) within ${opts.rebuyAfterDays} days in ${memory.files} record file(s) under ${opts.bought}`);
  const chains = [...new Set(["base", "solana", chain.name])];
  const measureOpts = { target, origin: env.LISTING_ORIGIN, chains, bazaarUrl: env.BAZAAR_REGISTRY_URL || undefined, payaiUrl: env.PAYAI_REGISTRY_URL || undefined };
  const before = await measure({ ...measureOpts, log });
  log("");
  log(renderTable(before));
  const spec = await (await fetchImpl(`${target}/openapi.json`, { signal: AbortSignal.timeout(60_000) })).json();
  const examples = examplesFromOpenapi(spec);
  // A route on the OpenAI transcription wire takes a multipart `file` part:
  // its body is published as multipart/form-data, and its example marks that
  // part with a "multipart" string, so the pass uploads the server's own
  // speech fixture there (as catalog-buy does).
  const multipartKeys = multipartKeysFromOpenapi(spec);
  let fixture = null;
  const fixtureBytes = async () => {
    if (!fixture) {
      const res = await fetchImpl(`${target}/fixtures/sample-speech.wav`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`speech fixture HTTP ${res.status}`);
      fixture = new Uint8Array(await res.arrayBuffer());
    }
    return fixture;
  };
  // A route with a purposeful input is quoted and bought with it; the same body for the quote and the buy, so the price read is
  // the price signed.
  const urlFor = async (r) => {
    const ex = purposefulInputFor(r, inputs) || examples.get(routeKeyOf(r)) || {};
    if (r.method === "GET") return { url: `${target}${r.path}${Object.keys(ex).length ? "?" + new URLSearchParams(ex).toString() : ""}`, body: undefined };
    if (multipartKeys.has(routeKeyOf(r)) || isMultipartExample(ex)) {
      return { url: `${target}${r.path}`, body: multipartBodyFrom(ex, { bytes: await fixtureBytes(), type: "audio/wav", filename: "sample-speech.wav" }) };
    }
    return { url: `${target}${r.path}`, body: JSON.stringify(ex) };
  };
  // Quoted routes are priced by their own 402 before anything is selected,
  // and the chain's premium over list is read from the cheapest list-priced
  // candidate's 402.
  const cands = candidatesOf(before, { ...opts, registry, chain: chain.name, bought: memory.bought });
  const quoteOpts = { caip2: chain.caip2, requestFor: urlFor, fetchImpl };
  const toQuote = cands.filter((r) => r.quoted);
  const quotes = await quoteRoutes(toQuote, quoteOpts);
  if (toQuote.length) log(`\nquoted ${toQuote.length} route(s) from their 402 on ${chain.name}`);
  let premiumAtomic = 0n;
  const listProbe = cands.filter((r) => !r.quoted && r.priceUsd > 0).sort((a, b) => a.priceUsd - b.priceUsd)[0];
  if (listProbe) {
    const q = await readQuote(listProbe, quoteOpts);
    premiumAtomic = premiumOf(q, listProbe.priceUsd);
    log(q.why ? `premium probe ${listProbe.path}: ${q.why}; list prices taken as quoted` : `premium on ${chain.name}: ${premiumAtomic} atomic over list (read from ${listProbe.path})`);
  }
  const plan = selectPass(before, { ...opts, registry, chain: chain.name, quotes, premiumAtomic, bought: memory.bought });
  const quoteNote = (r) => (r.quotedAtomic != null ? `  402 quote (${r.quotedAtomic} atomic; list $${Number(r.listPriceUsd || 0).toFixed(3)})` : "");
  log(`\n${leg}: ${plan.missing} missing · ${plan.selected.length} selected · ${plan.skipped.length} skipped`);
  for (const r of plan.selected) log(`  BUY   ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}${quoteNote(r)}`);
  for (const r of plan.skipped) log(`  SKIP  ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${Number(r.priceUsd || 0).toFixed(3)}  ${r.why}`);
  log(`\nestimated spend (list prices plus premium, 402 quotes for quoted routes): $${plan.estimateUsd.toFixed(3)} over ${plan.selected.length} buys`);
  if (!plan.missing) { log(`nothing missing: every route sold on ${chain.name} has a ${registry} row`); return 0; }
  if (!plan.selected.length) { log(`nothing to buy: ${plan.missing} missing, every one skipped (see SKIP above)`); return 0; }
  if (!opts.live) { log("DRY RUN. Re-run with --live to buy."); return 0; }

  // The untagged Solana check (Bazaar) and every PayAI buy need the gate.
  const needsGate = registry === "payai" || chain.name === "solana";
  if (needsGate && !token) { err(`payai-listing-pass: AGENT402_OPERATOR_TOKEN is required for ${leg} (the settle-via gate)`); return 2; }
  if (!rawKey) { err(`payai-listing-pass: ${keyEnvFor(chain.name)} is required to pay on ${chain.name}`); return 2; }
  const tagHeaders = legHeaders(registry, token);
  const decode = (h) => { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };

  // Preflight: nothing is spent until the leg's facilitator is the one that
  // will settle.
  if (needsGate) {
    // A route whose 402 carries a Solana accept: the selection's first such
    // route, else the cheapest list-priced route sold on Solana.
    const solRoutes = (rs) => rs.filter((r) => r.sells?.solana && !r.quoted && r.priceUsd > 0);
    const probe = solRoutes(plan.selected)[0] || solRoutes(before.routes).sort((a, b) => a.priceUsd - b.priceUsd)[0];
    if (!probe) { err(`payai-listing-pass: no route sold on Solana to read the gate on; nothing spent`); return 2; }
    // The example body goes along: a route prices its 402 from it.
    const { url, body } = await urlFor(probe);
    const read = async (headers) => { const r = await fetchImpl(url, { method: probe.method, headers: { Accept: "application/json", ...headers, ...jsonHeader(body) }, body, signal: AbortSignal.timeout(30_000) }); await r.text().catch(() => ""); return { status: r.status, pr: decode(r.headers.get("payment-required") || "") }; };
    const control = await read({});
    const tagged = await read(legHeaders("payai", token));
    if (control.status !== 402 || tagged.status !== 402) { err(`payai-listing-pass: preflight expected two 402s on ${probe.path}, got ${control.status} and ${tagged.status}`); return 2; }
    const v = preferenceHonored(control.pr, tagged.pr, sol.caip2);
    if (!v.honored) {
      err(registry === "payai"
        ? `payai-listing-pass: the settle-via preference is NOT honored on ${probe.path} (control feePayer ${v.controlFeePayer}, tagged ${v.taggedFeePayer}). Check AGENT402_OPERATOR_TOKEN and that the build carries the gate. Nothing spent.`
        : `payai-listing-pass: cannot prove the untagged Solana signer is not PayAI's on ${probe.path} (control feePayer ${v.controlFeePayer}, tagged ${v.taggedFeePayer}); a Bazaar buy must settle at the first facilitator. Nothing spent.`);
      return 2;
    }
    log(registry === "payai"
      ? `preflight: tagged 402 names feePayer ${v.taggedFeePayer} (control ${v.controlFeePayer}); preference honored`
      : `preflight: untagged Solana signer ${v.controlFeePayer} is not PayAI's (${v.taggedFeePayer}); the buys settle at the first facilitator`);
    if (registry === "payai" && chain.name !== "solana") {
      // The 402 names no facilitator signer on an EVM chain, so the chain's
      // half of the proof is PayAI's own /supported: the scope routes a pair
      // to PayAI exactly when PayAI lists it.
      const supUrl = `${String(env.PAYAI_FACILITATOR_URL || PAYAI_FACILITATOR_URL).replace(/\/+$/, "")}/supported`;
      let supported = null;
      try { const r = await fetchImpl(supUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) }); supported = r.ok ? await r.json() : null; } catch { supported = null; }
      if (!supportsExact(supported, chain.caip2)) { err(`payai-listing-pass: PayAI's /supported does not list exact v2 on ${chain.caip2}; a tagged buy would settle at the boot order. Nothing spent.`); return 2; }
      log(`preflight: PayAI lists exact v2 on ${chain.caip2}; tagged buys there settle at PayAI`);
    }
  } else {
    log(`preflight: ${chain.name} buys are untagged and settle at the first facilitator (CDP by boot order)`);
  }

  // The most one buy may sign: the 402 quote for a quoted route, list plus
  // premium for a list-priced one. The client refuses any accept above it.
  let ceiling = { caip2: chain.caip2, atomic: 0n };
  const { payFetch, address } = await buildPayFetch(chain.name, rawKey, () => ceiling);
  log(`paying via ${chain.name} from ${address}`);
  const hb = heartbeatHeader(String(env.POW_SECRET || "").trim());
  if (!hb["X-Heartbeat-Token"]) log("note: POW_SECRET unset, these buys read as outside demand in the ledger");
  const records = [];
  const startedAt = new Date().toISOString();
  // Rewritten after every attempt (to a temp file, then renamed), so a run
  // cut short by a timeout or a kill still leaves what it signed.
  const writeRecords = () => {
    if (!opts.out) return;
    writeFileSync(`${opts.out}.tmp`, JSON.stringify({ target, registry, chain: chain.name, startedAt, measuredAt: new Date().toISOString(), records }, null, 2));
    renameSync(`${opts.out}.tmp`, opts.out);
  };
  // Every signed attempt counts against the ceiling at the most it may sign
  // (its signing ceiling), a retry included; nothing is signed once the next
  // attempt would pass it. The selection fits every first attempt.
  const maxSpendAtomic = usdToAtomic(opts.maxSpendUsd);
  let signedAtomic = 0n;
  let settled = 0, failed = 0, held = 0, spent = 0;
  for (let i = 0; i < plan.selected.length; i++) {
    const r = plan.selected[i];
    const { url, body } = await urlFor(r);
    ceiling = { caip2: chain.caip2, atomic: r.ceilingAtomic };
    const rec = { registry, chain: chain.name, slug: r.slug, method: r.method, path: r.path, priceUsd: r.priceUsd, quoted: r.quotedAtomic != null, input: purposefulInputFor(r, inputs) ? "purposeful" : "example", status: null, tx: null, charged: false, chargeUnknown: false, attempts: 0, boughtAt: null, error: null, latencyMs: null, responseHeaders: null, body: null, bodyBytes: null, bodyTruncated: null };
    records.push(rec);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signedAtomic + r.ceilingAtomic > maxSpendAtomic) {
        rec.error = attempt === 1 ? "not attempted: the attempt would pass --max-spend" : `${rec.error}; not retried: the retry would pass --max-spend`;
        break;
      }
      signedAtomic += r.ceilingAtomic;
      rec.attempts = attempt;
      rec.boughtAt = new Date().toISOString();
      // Until an answer arrives the attempt may have settled.
      rec.chargeUnknown = true;
      writeRecords();
      const t0 = Date.now();
      try {
        const res = await payFetch(url, {
          method: r.method,
          headers: { Accept: "application/json", ...tagHeaders, ...hb, ...jsonHeader(body) },
          body,
          signal: AbortSignal.timeout(180_000),
        });
        rec.status = res.status;
        const receipt = receiptOf(res);
        // What came back, kept for grading: never a request header.
        rec.responseHeaders = identifyingHeaders(res.headers);
        const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        rec.latencyMs = Date.now() - t0;
        Object.assign(rec, keptBody(bytes, res.headers.get("content-type") || ""));
        rec.chargeUnknown = false;
        if (res.status === 200 && receipt?.success === true && receipt.transaction) { rec.tx = receipt.transaction; rec.charged = true; break; }
        if (res.status === 200) { rec.error = "200 without a settlement receipt: served unpaid, no row"; break; }
        rec.error = `HTTP ${res.status}${receipt?.errorReason ? ` ${receipt.errorReason}` : ""}`;
        if (attempt < 2 && mayRetry(r, res.status)) { writeRecords(); await sleep(5000); continue; }
        break;
      } catch (e) {
        // A request that threw (a timeout included) may still have settled
        // on the server, so it is never paid a second time: the record keeps
        // chargeUnknown, the next run's memory skips the route, and the
        // coverage read at the end shows the row.
        rec.error = String(e?.message || e).slice(0, 160);
        rec.latencyMs = Date.now() - t0;
        break;
      }
    }
    writeRecords();
    if (rec.charged) { settled++; spent += r.priceUsd; log(`  OK    ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}  tx ${String(rec.tx).slice(0, 16)}`); }
    else if (!rec.attempts) { held++; log(`  SKIP  ${r.method.padEnd(4)} ${r.path.padEnd(40)} ${rec.error}`); }
    else { failed++; log(`  FAIL  ${r.method.padEnd(4)} ${r.path.padEnd(40)} ${rec.error}`); }
    if (i < plan.selected.length - 1 && opts.pauseMs) await sleep(opts.pauseMs);
  }
  log(`\n${settled} settled, ${failed} failed, ${held} held back by the ceiling, $${spent.toFixed(3)} charged (list prices plus premium, 402 quotes for quoted routes), at most $${(Number(signedAtomic) / 1e6).toFixed(3)} signed`);
  if (opts.out) { writeRecords(); log(`records: ${opts.out}`); }

  if (opts.settleWaitMs) { log(`\nwaiting ${Math.round(opts.settleWaitMs / 1000)} s before re-measuring`); await sleep(opts.settleWaitMs); }
  const after = await measure({ ...measureOpts, log: () => {} });
  log("");
  log(renderTable(after));
  const still = missingIn(after, registry, chain.name).filter((r) => records.some((x) => x.charged && x.path === r.path));
  if (still.length) log(`${still.length} settled route(s) not yet listed: the registry ingests on its own schedule; re-run the coverage later.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`payai-listing-pass: ${e?.message || e}`); process.exit(2); });
}
