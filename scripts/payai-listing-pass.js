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
// solana), --max-spend USD (the ceiling on the summed price of one run,
// default 40: the selection is cheapest first and the routes past it are
// skipped with "past --max-spend"), --max-price USD (optional per-route cap;
// none by default), --only slug,slug, --limit N, --pause-ms (default 1500
// between buys), --out FILE (route/status/tx/charged records as JSON),
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
// Exit: 0 nothing missing, nothing selected, or every selected buy settled
// (registry ingestion lag is theirs); 1 a selected buy failed; 2 misconfigured
// or the preflight refused (nothing spent).
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { measureCoverage, missingIn, renderTable, examplesFromOpenapi, chainOf, CHAINS } from "./listing-coverage.js";

export const SETTLE_VIA = "payai";
export const REGISTRIES = ["bazaar", "payai"];
/** The chains a leg can pay on: one signer per family. */
export const PAY_CHAINS = ["base", "solana"];
/** No per-route cap by default: every paid route is in scope. */
export const DEFAULT_MAX_PRICE_USD = Infinity;
/** The per-run (per-leg) ceiling on the summed price of the selection. */
export const DEFAULT_MAX_SPEND_USD = 40;
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

export const routeKeyOf = (r) => `${r.method} ${r.path}`;
const usdToAtomic = (usd) => BigInt(Math.round(Number(usd) * 1e6));

/**
 * Pure: the routes a pass would consider before pricing: missing in the
 * registry on the chain, named by --only (when given), and not a
 * vendor-calling route unless included. These are the quoted routes worth an
 * unpaid 402 read.
 */
export function candidatesOf(coverage, { registry = "payai", chain = "solana", only = null, includeUpstream = false } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  return missingIn(coverage, registry, chain).filter((r) => (!onlySet || onlySet.has(r.slug)) && (r.computePayable || includeUpstream));
}

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
export function selectPass(coverage, { registry = "payai", chain = "solana", maxPriceUsd = DEFAULT_MAX_PRICE_USD, maxSpendUsd = DEFAULT_MAX_SPEND_USD, only = null, limit = Infinity, includeUpstream = false, quotes = null, premiumAtomic = 0n } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  const missing = missingIn(coverage, registry, chain);
  const skipped = [];
  const selected = [];
  const capNote = `above the $${maxPriceUsd} cap`;
  for (const listed of missing) {
    if (onlySet && !onlySet.has(listed.slug)) continue;
    let r = listed;
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
    limit: limit != null && limit !== true ? Number(limit) : Infinity,
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
  const token = String(env.AGENT402_OPERATOR_TOKEN || "").trim();
  const rawKey = String(env[keyEnvFor(chain.name)] || "").trim();
  const sol = chainOf("solana");

  log(`target ${target} · ${leg} (${chain.caip2}) · ${Number.isFinite(opts.maxPriceUsd) ? `cap $${opts.maxPriceUsd} per route` : "no per-route cap"} · ceiling $${opts.maxSpendUsd} per run${opts.live ? " · LIVE" : " · dry run"}`);
  const chains = [...new Set(["base", "solana", chain.name])];
  const measureOpts = { target, origin: env.LISTING_ORIGIN, chains, bazaarUrl: env.BAZAAR_REGISTRY_URL || undefined, payaiUrl: env.PAYAI_REGISTRY_URL || undefined };
  const before = await measure({ ...measureOpts, log });
  log("");
  log(renderTable(before));
  const spec = await (await fetchImpl(`${target}/openapi.json`, { signal: AbortSignal.timeout(60_000) })).json();
  const examples = examplesFromOpenapi(spec);
  // A route on the OpenAI transcription wire takes a multipart `file` part;
  // its published example marks that part with a "multipart" string, so the
  // pass uploads the server's own speech fixture there (as catalog-buy does).
  let fixture = null;
  const fixtureBytes = async () => {
    if (!fixture) {
      const res = await fetchImpl(`${target}/fixtures/sample-speech.wav`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`speech fixture HTTP ${res.status}`);
      fixture = new Uint8Array(await res.arrayBuffer());
    }
    return fixture;
  };
  const urlFor = async (r) => {
    const ex = examples.get(routeKeyOf(r)) || {};
    if (r.method === "GET") return { url: `${target}${r.path}${Object.keys(ex).length ? "?" + new URLSearchParams(ex).toString() : ""}`, body: undefined };
    if (isMultipartExample(ex)) {
      const form = new FormData();
      form.append("file", new Blob([await fixtureBytes()], { type: "audio/wav" }), "sample-speech.wav");
      for (const [k, v] of Object.entries(ex)) if (k !== "file" && v != null && typeof v !== "object") form.append(k, String(v));
      return { url: `${target}${r.path}`, body: form };
    }
    return { url: `${target}${r.path}`, body: JSON.stringify(ex) };
  };
  // Quoted routes are priced by their own 402 before anything is selected,
  // and the chain's premium over list is read from the cheapest list-priced
  // candidate's 402.
  const cands = candidatesOf(before, { ...opts, registry, chain: chain.name });
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
  const plan = selectPass(before, { ...opts, registry, chain: chain.name, quotes, premiumAtomic });
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
  let settled = 0, failed = 0, spent = 0;
  for (let i = 0; i < plan.selected.length; i++) {
    const r = plan.selected[i];
    const { url, body } = await urlFor(r);
    ceiling = { caip2: chain.caip2, atomic: r.ceilingAtomic };
    const rec = { registry, chain: chain.name, slug: r.slug, method: r.method, path: r.path, priceUsd: r.priceUsd, quoted: r.quotedAtomic != null, status: null, tx: null, charged: false, error: null };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await payFetch(url, {
          method: r.method,
          headers: { Accept: "application/json", ...tagHeaders, ...hb, ...jsonHeader(body) },
          body,
          signal: AbortSignal.timeout(180_000),
        });
        rec.status = res.status;
        const receipt = receiptOf(res);
        await res.text().catch(() => "");
        if (res.status === 200 && receipt?.success === true && receipt.transaction) { rec.tx = receipt.transaction; rec.charged = true; break; }
        if (res.status === 200) { rec.error = "200 without a settlement receipt: served unpaid, no row"; break; }
        rec.error = `HTTP ${res.status}${receipt?.errorReason ? ` ${receipt.errorReason}` : ""}`;
        if (res.status >= 502 && attempt < 2) { await sleep(5000); continue; }
        break;
      } catch (e) {
        // A request that threw (a timeout included) may still have settled
        // on the server, so it is never paid a second time: the record says
        // what happened and the coverage read at the end shows the row.
        rec.error = String(e?.message || e).slice(0, 160);
        break;
      }
    }
    if (rec.charged) { settled++; spent += r.priceUsd; log(`  OK    ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}  tx ${String(rec.tx).slice(0, 16)}`); }
    else { failed++; log(`  FAIL  ${r.method.padEnd(4)} ${r.path.padEnd(40)} ${rec.error}`); }
    records.push(rec);
    if (i < plan.selected.length - 1 && opts.pauseMs) await sleep(opts.pauseMs);
  }
  log(`\n${settled} settled, ${failed} failed, $${spent.toFixed(3)} charged (list prices plus premium, 402 quotes for quoted routes)`);
  if (opts.out) { writeFileSync(opts.out, JSON.stringify({ target, registry, chain: chain.name, measuredAt: new Date().toISOString(), records }, null, 2)); log(`records: ${opts.out}`); }

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
