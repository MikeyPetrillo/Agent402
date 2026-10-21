#!/usr/bin/env node
// PayAI listing pass: settle one Solana payment through the PayAI facilitator
// on every route its registry lacks, on purpose, while the boot order stays
// CDP first for every other buyer.
//
// The registry is harvested from the settlements PayAI facilitates, and a
// chain whose boot order puts another facilitator first never refreshes a row
// there. Each buy here carries X-Agent402-Settle-Via: payai and the operator
// token, which src/settle-preference.js honors for that one request: its 402
// names PayAI's Solana feePayer and its verify and settle go to PayAI. The
// paid retry carries the same headers (the client replays its init), and a
// retry that lost them is refused before any facilitator is asked.
//
// Before the first buy the pass reads one route's 402 with and without the
// headers and requires the Solana feePayer to differ: when it does not, the
// preference is not honored (wrong token, or a build without the gate) and
// nothing is spent.
//
// A route quoted per request (`quoted: true` in /api/pricing: its price is
// computed from the input) has no list price to trust. Before selection the
// pass sends that route's published example unpaid and reads the amount the
// 402 names on this chain's exact accept: the amount the buyer would sign.
// That amount is the route's price for --max-price, --max-spend, the
// cheapest-first order and the spend total. A route whose example does not
// answer 402 (or names no accept on this chain) is skipped with the reason.
// Every buy carries a client policy that refuses any accept above the amount
// the pass priced it at (the 402 quote, or the cap for a list-priced route),
// so nothing is signed above what was selected.
//
// DEFAULT IS A DRY RUN. `--live` sends real money.
//
//   node scripts/payai-listing-pass.js                       # measure, select, price
//   node scripts/payai-listing-pass.js --live                # buy the selection
//   node scripts/payai-listing-pass.js --live --max-price 0.60
//   node scripts/payai-listing-pass.js --live --only hash,page-speed
//   node scripts/payai-listing-pass.js --include-upstream --only dub   # quote one route
//   node scripts/payai-listing-pass.js --live --limit 5 --out /tmp/pass.json
//   node scripts/payai-listing-pass.js --live --include-upstream --max-spend 2
//
// Flags: --max-price USD (default 0.25; a route above it is skipped), --max-spend
// USD (a ceiling on the summed list price of one run: the selection is
// cheapest first and the routes past the ceiling are skipped with
// "past --max-spend"; no ceiling unless set), --only slug,slug, --limit N,
// --pause-ms (default 1500 between buys), --out FILE (route/status/tx/charged
// records as JSON), --include-upstream (a route that serves through
// a vendor call: the list price lands in our own treasury, the vendor call is
// the real cost, so skipped by default), --settle-wait-ms (before the closing
// re-measure, default 60000), --chain (default solana).
//
// Env: SOLANA_BURNER_KEY (base58 64-byte secret or JSON byte array; never
// printed), AGENT402_OPERATOR_TOKEN (the gate; never printed), POW_SECRET
// (optional: the signed X-Heartbeat-Token books the buys as ours), TARGET_URL,
// LISTING_ORIGIN, PAYAI_REGISTRY_URL, BAZAAR_REGISTRY_URL.
//
// Scheduled: .github/workflows/payai-listing.yml runs this live every
// Wednesday 03:53 UTC (and on dispatch) with --include-upstream, --max-price
// 0.25 and --max-spend 2 (plus --only from its `only` dispatch input, when
// given), in the spending environment, and keeps one issue
// ("PayAI listing pass FAILED") open while a run fails.
//
// Exit: 0 nothing missing, nothing selected, or every selected buy settled
// (registry ingestion lag is theirs); 1 a selected buy failed; 2 misconfigured
// or the preference is not honored (nothing spent).
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { measureCoverage, missingIn, renderTable, examplesFromOpenapi, chainOf } from "./listing-coverage.js";

export const SETTLE_VIA = "payai";
export const DEFAULT_MAX_PRICE_USD = 0.25;

export const routeKeyOf = (r) => `${r.method} ${r.path}`;

/**
 * Pure: the routes a pass would consider before pricing: missing on the
 * chain, named by --only (when given), and not a vendor-calling route unless
 * included. These are the quoted routes worth an unpaid 402 read.
 */
export function candidatesOf(coverage, { chain = "solana", only = null, includeUpstream = false } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  return missingIn(coverage, "payai", chain).filter((r) => (!onlySet || onlySet.has(r.slug)) && (r.computePayable || includeUpstream));
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

/**
 * Read each quoted route's price from its own 402: the published example is
 * sent unpaid, and the amount named on this chain's exact accept is the
 * price. Returns Map(routeKey -> { atomic, usd } | { why }). Nothing is paid.
 */
export async function quoteRoutes(routes, { caip2, requestFor, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const out = new Map();
  for (const r of routes) {
    if (!r.quoted) continue;
    const { url, body } = requestFor(r);
    try {
      const res = await fetchImpl(url, {
        method: r.method,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.text().catch(() => "");
      if (res.status !== 402) { out.set(routeKeyOf(r), { why: `example did not quote: HTTP ${res.status}, not 402` }); continue; }
      let pr = null;
      try { pr = JSON.parse(Buffer.from(res.headers.get("payment-required") || "", "base64").toString("utf8")); } catch { pr = null; }
      out.set(routeKeyOf(r), quoteOf(pr, caip2) || { why: "example did not quote: the 402 names no readable exact accept on this chain" });
    } catch (e) {
      out.set(routeKeyOf(r), { why: `example did not quote: ${String(e?.message || e).slice(0, 120)}` });
    }
  }
  return out;
}

/**
 * Pure: the routes to buy, cheapest first. A route is selected when it sells
 * on the chain, the PayAI registry lacks it there, and its price is within
 * the cap. A quoted route is priced by its 402 quote (`quotes`, from
 * quoteRoutes) and skipped with the reason when it has none. `limit` cuts
 * the cheapest-first order by count, `maxSpendUsd` by summed price.
 */
export function selectPass(coverage, { chain = "solana", maxPriceUsd = DEFAULT_MAX_PRICE_USD, maxSpendUsd = Infinity, only = null, limit = Infinity, includeUpstream = false, quotes = null } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  const missing = missingIn(coverage, "payai", chain);
  const skipped = [];
  const selected = [];
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
      r = { ...r, listPriceUsd: r.priceUsd, priceUsd: q.usd, quotedAtomic: q.atomic };
      if (r.priceUsd > maxPriceUsd) { skipped.push({ ...r, why: `the 402 quotes $${r.priceUsd}, above the $${maxPriceUsd} cap` }); continue; }
    }
    if (!(r.priceUsd > 0)) { skipped.push({ ...r, why: "no fixed price" }); continue; }
    if (r.priceUsd > maxPriceUsd) { skipped.push({ ...r, why: `above the $${maxPriceUsd} cap` }); continue; }
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
export function preferenceHonored(control, tagged, caip2) {
  const fee = (pr) => (pr?.accepts || []).find((a) => a?.network === caip2 && a?.scheme === "exact")?.extra?.feePayer || null;
  const c = fee(control), t = fee(tagged);
  return { honored: !!c && !!t && c !== t, controlFeePayer: c, taggedFeePayer: t };
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

export function parseArgs(argv) {
  const maxPrice = Number(flag(argv, "--max-price", DEFAULT_MAX_PRICE_USD));
  const maxSpend = flag(argv, "--max-spend", null);
  const limit = flag(argv, "--limit", null);
  const only = flag(argv, "--only", null);
  return {
    live: argv.includes("--live"),
    includeUpstream: argv.includes("--include-upstream"),
    maxPriceUsd: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : DEFAULT_MAX_PRICE_USD,
    // Absent: no ceiling. Given but unreadable: NaN, and main refuses to run
    // rather than buy without the ceiling the caller meant to set.
    maxSpendUsd: maxSpend == null ? Infinity : (maxSpend !== true && String(maxSpend).trim() !== "" && Number.isFinite(Number(maxSpend)) && Number(maxSpend) >= 0 ? Number(maxSpend) : NaN),
    only: typeof only === "string" ? only.split(",") : null,
    limit: limit != null && limit !== true ? Number(limit) : Infinity,
    pauseMs: Math.max(0, Number(flag(argv, "--pause-ms", 1500)) || 0),
    out: typeof flag(argv, "--out") === "string" ? flag(argv, "--out") : null,
    settleWaitMs: Math.max(0, Number(flag(argv, "--settle-wait-ms", 60_000)) || 0),
    chain: String(flag(argv, "--chain", "solana")),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function buildSvmPayFetch(rawKey, getCeiling) {
  const [{ x402Client }, { wrapFetchWithPayment }, kit, { registerExactSvmScheme }] = await Promise.all([
    import("@x402/core/client"), import("@x402/fetch"), import("@solana/kit"), import("@x402/svm/exact/client"),
  ]);
  const bytes = rawKey.startsWith("[") ? Uint8Array.from(JSON.parse(rawKey)) : new Uint8Array(kit.getBase58Encoder().encode(rawKey));
  const signer = await kit.createKeyPairSignerFromBytes(bytes);
  const client = disableVendorSpendControls(new x402Client());
  registerExactSvmScheme(client, { signer });
  client.registerPolicy(ceilingPolicy(getCeiling));
  return { payFetch: wrapFetchWithPayment(fetch, client), address: signer.address };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const target = String(env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
  const chain = chainOf(opts.chain);
  if (!chain) { console.error(`payai-listing-pass: unknown chain ${opts.chain}`); return 2; }
  if (Number.isNaN(opts.maxSpendUsd)) { console.error("payai-listing-pass: --max-spend needs a non-negative USD amount"); return 2; }
  const token = String(env.AGENT402_OPERATOR_TOKEN || "").trim();
  const rawKey = String(env.SOLANA_BURNER_KEY || "").trim();
  const log = (m) => console.log(m);

  log(`target ${target} · chain ${chain.name} (${chain.caip2}) · cap $${opts.maxPriceUsd} per route${Number.isFinite(opts.maxSpendUsd) ? ` · ceiling $${opts.maxSpendUsd} per run` : " · no run ceiling"}${opts.live ? " · LIVE" : " · dry run"}`);
  const before = await measureCoverage({ target, origin: env.LISTING_ORIGIN, chains: ["base", chain.name], bazaarUrl: env.BAZAAR_REGISTRY_URL || undefined, payaiUrl: env.PAYAI_REGISTRY_URL || undefined, log });
  log("");
  log(renderTable(before));
  const spec = await (await fetch(`${target}/openapi.json`, { signal: AbortSignal.timeout(60_000) })).json();
  const examples = examplesFromOpenapi(spec);
  const urlFor = (r) => {
    const ex = examples.get(routeKeyOf(r)) || {};
    if (r.method === "GET") return { url: `${target}${r.path}${Object.keys(ex).length ? "?" + new URLSearchParams(ex).toString() : ""}`, body: undefined };
    return { url: `${target}${r.path}`, body: JSON.stringify(ex) };
  };
  // Quoted routes are priced by their own 402 before anything is selected.
  const toQuote = candidatesOf(before, { ...opts, chain: chain.name }).filter((r) => r.quoted);
  const quotes = await quoteRoutes(toQuote, { caip2: chain.caip2, requestFor: urlFor });
  if (toQuote.length) log(`\nquoted ${toQuote.length} route(s) from their 402 on ${chain.name}`);
  const plan = selectPass(before, { ...opts, chain: chain.name, quotes });
  const quoteNote = (r) => (r.quotedAtomic != null ? `  402 quote (${r.quotedAtomic} atomic; list $${Number(r.listPriceUsd || 0).toFixed(3)})` : "");
  log(`\npayai / ${chain.name}: ${plan.missing} missing · ${plan.selected.length} selected · ${plan.skipped.length} skipped`);
  for (const r of plan.selected) log(`  BUY   ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}${quoteNote(r)}`);
  for (const r of plan.skipped) log(`  SKIP  ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}  ${r.why}`);
  log(`\nestimated spend (list prices, 402 quotes for quoted routes): $${plan.estimateUsd.toFixed(3)} over ${plan.selected.length} buys`);
  if (!plan.missing) { log(`nothing missing: every route sold on ${chain.name} has a PayAI row`); return 0; }
  if (!plan.selected.length) { log(`nothing to buy: ${plan.missing} missing, every one skipped (see SKIP above)`); return 0; }
  if (!opts.live) { log("DRY RUN. Re-run with --live to buy."); return 0; }

  if (!token) { console.error("payai-listing-pass: AGENT402_OPERATOR_TOKEN is required (the settle-via gate)"); return 2; }
  if (!rawKey) { console.error("payai-listing-pass: SOLANA_BURNER_KEY is required to pay"); return 2; }
  const tagHeaders = { "X-Agent402-Settle-Via": SETTLE_VIA, "X-Operator-Token": token };
  const decode = (h) => { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };

  // Preflight: the preference has to be honored before anything is spent.
  {
    const probe = plan.selected[0];
    // The example body goes along: a quoted route prices its 402 from it.
    const { url, body } = urlFor(probe);
    const read = async (headers) => { const r = await fetch(url, { method: probe.method, headers: { Accept: "application/json", ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body, signal: AbortSignal.timeout(30_000) }); await r.text().catch(() => ""); return { status: r.status, pr: decode(r.headers.get("payment-required") || "") }; };
    const control = await read({});
    const tagged = await read(tagHeaders);
    if (control.status !== 402 || tagged.status !== 402) { console.error(`payai-listing-pass: preflight expected two 402s on ${probe.path}, got ${control.status} and ${tagged.status}`); return 2; }
    const v = preferenceHonored(control.pr, tagged.pr, chain.caip2);
    if (!v.honored) {
      console.error(`payai-listing-pass: the settle-via preference is NOT honored on ${probe.path} (control feePayer ${v.controlFeePayer}, tagged ${v.taggedFeePayer}). Check AGENT402_OPERATOR_TOKEN and that the build carries the gate. Nothing spent.`);
      return 2;
    }
    log(`preflight: tagged 402 names feePayer ${v.taggedFeePayer} (control ${v.controlFeePayer}); preference honored`);
  }

  // The most one buy may sign: the 402 quote for a quoted route, the cap for
  // a list-priced one. The client refuses any accept above it.
  let ceiling = { caip2: chain.caip2, atomic: 0n };
  const { payFetch, address } = await buildSvmPayFetch(rawKey, () => ceiling);
  log(`paying via ${chain.name} from ${address}`);
  const hb = heartbeatHeader(String(env.POW_SECRET || "").trim());
  if (!hb["X-Heartbeat-Token"]) log("note: POW_SECRET unset, these buys read as outside demand in the ledger");
  const records = [];
  let settled = 0, failed = 0, spent = 0;
  for (let i = 0; i < plan.selected.length; i++) {
    const r = plan.selected[i];
    const { url, body } = urlFor(r);
    ceiling = { caip2: chain.caip2, atomic: r.quotedAtomic != null ? r.quotedAtomic : BigInt(Math.round(opts.maxPriceUsd * 1e6)) };
    const rec = { slug: r.slug, method: r.method, path: r.path, priceUsd: r.priceUsd, quoted: r.quotedAtomic != null, status: null, tx: null, charged: false, error: null };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await payFetch(url, {
          method: r.method,
          headers: { Accept: "application/json", ...tagHeaders, ...hb, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
  log(`\n${settled} settled, ${failed} failed, $${spent.toFixed(3)} charged (list prices, 402 quotes for quoted routes)`);
  if (opts.out) { writeFileSync(opts.out, JSON.stringify({ target, chain: chain.name, measuredAt: new Date().toISOString(), records }, null, 2)); log(`records: ${opts.out}`); }

  if (opts.settleWaitMs) { log(`\nwaiting ${Math.round(opts.settleWaitMs / 1000)} s before re-measuring`); await sleep(opts.settleWaitMs); }
  const after = await measureCoverage({ target, origin: env.LISTING_ORIGIN, chains: ["base", chain.name], bazaarUrl: env.BAZAAR_REGISTRY_URL || undefined, payaiUrl: env.PAYAI_REGISTRY_URL || undefined, log: () => {} });
  log("");
  log(renderTable(after));
  const still = missingIn(after, "payai", chain.name).filter((r) => records.some((x) => x.charged && x.path === r.path));
  if (still.length) log(`${still.length} settled route(s) not yet listed: the registry ingests on its own schedule; re-run the coverage later.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`payai-listing-pass: ${e?.message || e}`); process.exit(2); });
}
