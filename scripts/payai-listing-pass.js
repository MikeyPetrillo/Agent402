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
// DEFAULT IS A DRY RUN. `--live` sends real money.
//
//   node scripts/payai-listing-pass.js                       # measure, select, price
//   node scripts/payai-listing-pass.js --live                # buy the selection
//   node scripts/payai-listing-pass.js --live --max-price 0.60
//   node scripts/payai-listing-pass.js --live --only hash,page-speed
//   node scripts/payai-listing-pass.js --live --limit 5 --out /tmp/pass.json
//
// Flags: --max-price USD (default 0.25; a route above it is skipped), --only
// slug,slug, --limit N, --pause-ms (default 1500 between buys), --out FILE
// (route/status/tx/charged records as JSON), --include-quoted (a quoted route's
// 402 prices the request itself; skipped by default), --include-upstream (a
// route that serves through a vendor call: the list price lands in our own
// treasury, the vendor call is the real cost, so skipped by default), --settle-wait-ms (before
// the closing re-measure, default 60000), --chain (default solana).
//
// Env: SOLANA_BURNER_KEY (base58 64-byte secret or JSON byte array; never
// printed), AGENT402_OPERATOR_TOKEN (the gate; never printed), POW_SECRET
// (optional: the signed X-Heartbeat-Token books the buys as ours), TARGET_URL,
// LISTING_ORIGIN, PAYAI_REGISTRY_URL, BAZAAR_REGISTRY_URL.
//
// Exit: 0 every selected buy settled (registry ingestion lag is theirs);
// 1 a buy failed; 2 misconfigured or the preference is not honored.
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { measureCoverage, missingIn, renderTable, examplesFromOpenapi, chainOf } from "./listing-coverage.js";

export const SETTLE_VIA = "payai";
export const DEFAULT_MAX_PRICE_USD = 0.25;

/**
 * Pure: the routes to buy, cheapest first. A route is selected when it sells
 * on the chain, the PayAI registry lacks it there, its price is within the
 * cap, and (unless included) it is not quoted per request.
 */
export function selectPass(coverage, { chain = "solana", maxPriceUsd = DEFAULT_MAX_PRICE_USD, only = null, limit = Infinity, includeQuoted = false, includeUpstream = false } = {}) {
  const onlySet = only ? new Set([...only].map((s) => String(s).trim()).filter(Boolean)) : null;
  const missing = missingIn(coverage, "payai", chain);
  const skipped = [];
  const selected = [];
  for (const r of missing) {
    if (onlySet && !onlySet.has(r.slug)) continue;
    if (r.quoted && !includeQuoted) { skipped.push({ ...r, why: "quoted per request" }); continue; }
    // The list price only moves between our own wallets; a route that calls
    // a vendor while it serves is real spend, so it is bought only on request.
    if (!r.computePayable && !includeUpstream) { skipped.push({ ...r, why: "serves through an upstream vendor call (pass --include-upstream)" }); continue; }
    if (!(r.priceUsd > 0)) { skipped.push({ ...r, why: "no fixed price" }); continue; }
    if (r.priceUsd > maxPriceUsd) { skipped.push({ ...r, why: `above the $${maxPriceUsd} cap` }); continue; }
    selected.push(r);
  }
  selected.sort((a, b) => a.priceUsd - b.priceUsd || a.path.localeCompare(b.path));
  const chosen = selected.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : selected.length);
  for (const r of selected.slice(chosen.length)) skipped.push({ ...r, why: "past --limit" });
  const estimateUsd = chosen.reduce((s, r) => s + r.priceUsd, 0);
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
  const limit = flag(argv, "--limit", null);
  const only = flag(argv, "--only", null);
  return {
    live: argv.includes("--live"),
    includeUpstream: argv.includes("--include-upstream"),
    maxPriceUsd: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : DEFAULT_MAX_PRICE_USD,
    only: typeof only === "string" ? only.split(",") : null,
    limit: limit != null && limit !== true ? Number(limit) : Infinity,
    pauseMs: Math.max(0, Number(flag(argv, "--pause-ms", 1500)) || 0),
    out: typeof flag(argv, "--out") === "string" ? flag(argv, "--out") : null,
    includeQuoted: argv.includes("--include-quoted"),
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

async function buildSvmPayFetch(rawKey) {
  const [{ x402Client }, { wrapFetchWithPayment }, kit, { registerExactSvmScheme }] = await Promise.all([
    import("@x402/core/client"), import("@x402/fetch"), import("@solana/kit"), import("@x402/svm/exact/client"),
  ]);
  const bytes = rawKey.startsWith("[") ? Uint8Array.from(JSON.parse(rawKey)) : new Uint8Array(kit.getBase58Encoder().encode(rawKey));
  const signer = await kit.createKeyPairSignerFromBytes(bytes);
  const client = disableVendorSpendControls(new x402Client());
  registerExactSvmScheme(client, { signer });
  return { payFetch: wrapFetchWithPayment(fetch, client), address: signer.address };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const target = String(env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
  const chain = chainOf(opts.chain);
  if (!chain) { console.error(`payai-listing-pass: unknown chain ${opts.chain}`); return 2; }
  const token = String(env.AGENT402_OPERATOR_TOKEN || "").trim();
  const rawKey = String(env.SOLANA_BURNER_KEY || "").trim();
  const log = (m) => console.log(m);

  log(`target ${target} · chain ${chain.name} (${chain.caip2}) · cap $${opts.maxPriceUsd}${opts.live ? " · LIVE" : " · dry run"}`);
  const before = await measureCoverage({ target, origin: env.LISTING_ORIGIN, chains: ["base", chain.name], bazaarUrl: env.BAZAAR_REGISTRY_URL || undefined, payaiUrl: env.PAYAI_REGISTRY_URL || undefined, log });
  log("");
  log(renderTable(before));
  const plan = selectPass(before, opts);
  log(`\npayai / ${chain.name}: ${plan.missing} missing · ${plan.selected.length} selected · ${plan.skipped.length} skipped`);
  for (const r of plan.selected) log(`  BUY   ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}`);
  for (const r of plan.skipped) log(`  SKIP  ${r.method.padEnd(4)} ${r.path.padEnd(40)} $${r.priceUsd.toFixed(3)}  ${r.why}`);
  log(`\nestimated spend from the price list: $${plan.estimateUsd.toFixed(3)} over ${plan.selected.length} buys`);
  if (!plan.selected.length) { log("Nothing to buy."); return 0; }
  if (!opts.live) { log("DRY RUN. Re-run with --live to buy."); return 0; }

  if (!token) { console.error("payai-listing-pass: AGENT402_OPERATOR_TOKEN is required (the settle-via gate)"); return 2; }
  if (!rawKey) { console.error("payai-listing-pass: SOLANA_BURNER_KEY is required to pay"); return 2; }
  const tagHeaders = { "X-Agent402-Settle-Via": SETTLE_VIA, "X-Operator-Token": token };
  const decode = (h) => { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };

  // Preflight: the preference has to be honored before anything is spent.
  const spec = await (await fetch(`${target}/openapi.json`, { signal: AbortSignal.timeout(60_000) })).json();
  const examples = examplesFromOpenapi(spec);
  const urlFor = (r) => {
    const ex = examples.get(`${r.method} ${r.path}`) || {};
    if (r.method === "GET") return { url: `${target}${r.path}${Object.keys(ex).length ? "?" + new URLSearchParams(ex).toString() : ""}`, body: undefined };
    return { url: `${target}${r.path}`, body: JSON.stringify(ex) };
  };
  {
    const probe = plan.selected[0];
    const { url } = urlFor(probe);
    const read = async (headers) => { const r = await fetch(url, { method: probe.method, headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) }); return { status: r.status, pr: decode(r.headers.get("payment-required") || "") }; };
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

  const { payFetch, address } = await buildSvmPayFetch(rawKey);
  log(`paying via ${chain.name} from ${address}`);
  const hb = heartbeatHeader(String(env.POW_SECRET || "").trim());
  if (!hb["X-Heartbeat-Token"]) log("note: POW_SECRET unset, these buys read as outside demand in the ledger");
  const records = [];
  let settled = 0, failed = 0, spent = 0;
  for (let i = 0; i < plan.selected.length; i++) {
    const r = plan.selected[i];
    const { url, body } = urlFor(r);
    const rec = { slug: r.slug, method: r.method, path: r.path, priceUsd: r.priceUsd, status: null, tx: null, charged: false, error: null };
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
  log(`\n${settled} settled, ${failed} failed, $${spent.toFixed(3)} charged at list price`);
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
