#!/usr/bin/env node
// Catalog buy: buy EVERY tool from production at its list price and grade the
// answer, so a broken tool is found by us before a buyer finds it.
//
// The paid canary proves that BUYING settles; the catalog sweeps prove that every
// tool answers its own example on a keyless FREE_MODE boot. Neither proves that
// the tool a buyer pays for on production, with production's keys and upstreams,
// answers what its documentation promises. This does: it pays the real 402 on
// Base from the CI burner to our own payTo (the USDC recycles; the real cost is
// the upstream work each tool does) and grades the paid answer the way the strict
// sweep grades a free one: HTTP 200, no `error` field, every documented output
// key present, and no empty array where the published example shows rows.
//
// TIERS
//   daily   every tool priced at or under DAILY_MAX_USD, bought once with its
//           published example, PLUS today's slice of the weekly rotation.
//   weekly  the products above DAILY_MAX_USD (reports, dossiers, the ticker
//           pack, the router tiers) on a ROTATION_DAYS-day rotation balanced by
//           price, so each one is bought once a week; `dayOfYear % 7` picks the
//           slice. This tier alone is today's slice.
//   cheap   the daily set without the weekly slice.   all   everything.
//
// SPEND CONTROL
//   - Pays ONLY on Base, ONLY the accept the live 402 quotes, and NEVER above
//     the tool's documented ceiling. A fixed-price tool's ceiling is the list
//     price /api/pricing publishes (a quote over list is graded
//     quote-over-list). A QUOTED tool (the metered /v1 tiers, decide) prices
//     each request from its body between a floor, which is what the list shows,
//     and a documented ceiling: its row says `quoted: true` with a
//     `quoteRange` on /api/pricing and `x-payment-info.price` reads mode
//     "dynamic" with min/max on /openapi.json (both derived from the same
//     catalog field, def.quoteRange). A quote at or under that ceiling is
//     signed; one above it is graded quote-over-ceiling. The list floor is
//     never the maximum for a quoted tool.
//   - One paid call in flight and about a second between calls by default
//     (CATALOG_BUY_CONCURRENCY, CATALOG_BUY_PACE_MS): production serves buyers
//     first, and a run that walks 500 tools has all day.
//   - Hard cap per run (CATALOG_BUY_MAX_USD): the plan is cut against list
//     prices before anything is bought (the dearest products go first, each one
//     named), and the settled total is checked again before every signature.
//   - Funding preflight: the burner's Base USDC balance must cover the planned
//     spend plus a floor (CATALOG_BUY_FLOOR_USD), or the run refuses to start
//     and exits 3 (funding, never a tool failure). An unreadable balance does
//     not block a monitor; the cap still bounds the run.
//   - Every request carries the heartbeat token (HMAC of POW_SECRET and the UTC
//     minute), so these buys book as internal traffic, not as outside demand.
//
// GRADING AND EXIT CODES
//   A 5xx from our side is retried once after a backoff (nothing is charged on
//   a 5xx: settlement runs after the handler) and the second answer is graded.
//   A 402 after paying is `unsettled`. A tool with no usable published example
//   is `no-example` and fails the run (a tool nobody can check is not a tool
//   that passed). A tool cut by the spend cap is `cap`: NOT a failure, it is
//   counted apart as cap-deferred in the headline, the issue and the exit code,
//   because a tool the budget skipped says nothing about the tool.
//
// TOOLS THAT NEED THE BUYER'S OWN SALE
//   An identity-bound tool whose input names a settlement `tx` (attest,
//   feedback) answers only for a sale the CALLER paid for, and attest only for
//   one with a recorded response digest. Its published example names an old
//   sale, so a cold buy of that example can never pass. These tools run after
//   every other tool, with the example's `tx` replaced by the settlement tx of
//   a non-streamed JSON 200 this run paid for (preferring SALE_SOURCE_SLUG, the
//   paid canary's choice). When the plan holds no such sale (an `--only attest`
//   run), the cheap source tool is added to the plan first, under the cap. When
//   no sale can be had (the cap cannot fit one, or none settled), the tool is
//   `no-own-sale`: deferred with that reason, never a failure.
//     0  every graded tool passed      5  some tool failed its grade
//     4  nothing failed, some tools    3  unfunded (nothing bought)
//        were cap-deferred (unchecked) 2  misconfigured (no key, no catalog)
//
// Usage:
//   node scripts/catalog-buy.js [--tier daily|weekly|cheap|all] [--only <slug substring | slug,slug,...>]
//                               [--dry] [--out report.json] [--outputs outputs.json]
//   --outputs writes every graded paid answer, redacted and bounded
//   (scripts/catalog-buy-capture.js), for scripts/catalog-buy-examples.js.
// Env: TARGET_URL, BURNER_KEY, POW_SECRET, CATALOG_BUY_MAX_USD, CATALOG_BUY_FLOOR_USD,
//      CATALOG_BUY_SKIP (comma slugs), CATALOG_BUY_CONCURRENCY (default 1),
//      CATALOG_BUY_PACE_MS (default 1000), CATALOG_BUY_TIMEOUT_MS, CATALOG_BUY_SLOW_TIMEOUT_MS.
//
// The pure parts (catalog, plan, rotation, grading, exit code, summary) are
// exported and unit-tested offline by scripts/test-catalog-buy.js against a stub
// server and a fake payer; importing this module never spends anything.
import { createHmac } from "node:crypto";
import { appendFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingDocumentedKeys, emptyPromisedArrays } from "./sweep-shape.js";
import { requestExampleOf, multipartBodyFrom, MULTIPART_TYPE } from "../src/openapi-request.js";
import { captureRecord, CAPTURE_MAX_BYTES } from "./catalog-buy-capture.js";

export const BASE_CAIP2 = "eip155:8453";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DAILY_MAX_USD = 0.10;
export const ROTATION_DAYS = 7;
export const DEFAULT_CAP_USD = 12;
export const DEFAULT_FLOOR_USD = 2;
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_PACE_MS = 1000;
export const TIERS = ["daily", "weekly", "cheap", "all"];
/** The sale an own-sale tool is pointed at when the plan holds no other: the paid canary's choice. */
export const SALE_SOURCE_SLUG = "hash";
export const NO_OWN_SALE = "no-own-sale";
const BASE_RPCS = ["https://mainnet.base.org", "https://base.blockscout.com/api/eth-rpc"];

export const parsePriceUsd = (p) => (typeof p === "number" ? p : Number(String(p ?? "").replace(/[^0-9.]/g, "")) || 0);
/** Prices compared as integer micro-dollars, never as floats. */
export const micro = (usd) => Math.round(Number(usd) * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arrays a documented example shows populated that production may honestly
// answer empty for the example's own subject. Deliberately NOT the sweep's
// list: that one also excuses the board-backed tools because a keyless CI boot
// indexes nothing, and on production those must be populated. The memory
// family is keyed on the payer, and this run is the only writer in the
// burner's namespace, so a read can land before the day's write. Receipts are
// keyed on the payer too and list EXTERNAL settlements only (sales-ledger's
// payer view filters internal = 0): every buy this run makes carries the
// heartbeat token and books as internal, so the burner's own receipts are
// empty by construction, while a real payer's carry the rows the example shows.
export const PROD_EMPTY_ARRAY_OK = new Map([
  ["/api/receipts", "rows"],
  ["/api/weather-alerts", "alerts"],
  ["/api/nft-metadata", "attributes"],
  ["/api/coin-profile", "platforms"],
  ["/api/memory/grants", "grants"],
  ["/api/memory", "keys"],
  ["/api/memory/log", "entries"],
  ["/api/memory/recall", "results"],
]);

/** The published example input of one operation, or null when none is usable. */
export function exampleOf(method, op) {
  if (method === "get") {
    const query = {};
    for (const p of op.parameters || []) {
      if (p.in && p.in !== "query") continue;
      if (p.example !== undefined) query[p.name] = typeof p.example === "string" ? p.example : JSON.stringify(p.example);
      else if (p.required) return null;
    }
    return { kind: "query", query };
  }
  const published = requestExampleOf(op);
  const body = published?.example;
  if (body === undefined) return null;
  if (published.contentType === MULTIPART_TYPE || (body && typeof body.file === "string" && /multipart/i.test(body.file))) return { kind: "multipart", fields: body };
  return { kind: "json", body };
}

const exampleInput = (ex) => (ex?.kind === "json" ? ex.body : ex?.kind === "query" ? ex.query : null);

/** An identity-bound tool whose input names a settlement tx: it needs a sale the buyer made. */
export function needsOwnSale(row) {
  const input = exampleInput(row?.example);
  return row?.identityBound === true && !!input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "tx");
}

/** A tool whose paid 200 leaves a sale an own-sale tool can name: not identity-bound
 *  (attest refuses those), a JSON answer (a binary or streamed one has no digest). */
export function isSaleSource(row) {
  if (!row?.example || row.identityBound || row.binary || needsOwnSale(row)) return false;
  if (row.example.kind !== "json" && row.example.kind !== "query") return false;
  const input = exampleInput(row.example);
  return !(input && (input.stream === true || input.stream === "true"));
}

/** The example with its `tx` replaced by a sale this run settled. */
export function withOwnSale(example, tx) {
  if (example?.kind === "json") return { ...example, body: { ...example.body, tx } };
  if (example?.kind === "query") return { ...example, query: { ...example.query, tx } };
  return example;
}

/**
 * The most a quoted tool's live 402 may ask for, in USD, or null for a
 * fixed-price tool. Read from the price list's row first (`quoted: true` with
 * `quoteRange.maxUsd`), else from the operation's `x-payment-info.price` when
 * it reads mode "dynamic"; both are derived from the catalog's own quoteRange.
 * A priced-by-model flat tier also publishes a dynamic range (its body may name
 * a model another flat tier serves), but its published example is served by
 * its own tier, so it is held to its list price like any fixed-price tool.
 */
export function quoteCeilingUsd(ep, op) {
  const fromRow = ep?.quoted === true ? Number(ep.quoteRange?.maxUsd) : NaN;
  if (Number.isFinite(fromRow) && fromRow > 0) return fromRow;
  if (ep?.pricedByModel === true) return null;
  const price = op?.["x-payment-info"]?.price;
  if (price && price.mode === "dynamic") {
    const max = Number(price.max);
    if (Number.isFinite(max) && max > 0) return max;
  }
  return null;
}

/** Every priced operation on /openapi.json, priced from /api/pricing. */
export function catalogFromSurfaces(pricing, spec) {
  const byPath = new Map((pricing.endpoints || pricing.tools || []).map((e) => [e.path, e]));
  const rows = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const cat = (op.tags && op.tags[0]) || "other";
      if (cat === "workflows" || cat === "jobs") continue;
      // The spec's verb is the one the route is called with; the price list's
      // row prices the path and may name another verb for the same tool.
      const ep = byPath.get(path);
      const usd = parsePriceUsd(ep?.price ?? op["x-price"] ?? 0);
      if (!(usd > 0)) continue;
      // The slug is a label (the price list's, else spelled from the path).
      // The PATH is the spec's own key and is what gets requested: a slug is
      // never turned back into a path (decide-execute lives at /api/decide/execute).
      const slug = ep?.slug || path.replace(/^\/api\//, "").replace(/^\/v1\//, "v1-").replace(/\//g, "-");
      const types = Object.keys(op.responses?.["200"]?.content || {});
      const ceiling = quoteCeilingUsd(ep, op);
      rows.push({
        slug, path, method, usd, op, example: exampleOf(method, op), modelBacked: ep?.modelBacked === true,
        identityBound: ep?.identityBound === true,
        binary: types.length > 0 && !types.includes("application/json"),
        // quoted: the list price is a floor and maxUsd the documented ceiling;
        // fixed: both are the list price.
        quoted: ceiling != null && micro(ceiling) > micro(usd),
        maxUsd: ceiling != null && micro(ceiling) > micro(usd) ? ceiling : usd,
      });
    }
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug) || a.path.localeCompare(b.path));
  return rows;
}

export const tierOf = (row) => (micro(row.usd) <= micro(DAILY_MAX_USD) ? "daily" : "weekly");

export function dayOfYear(d = new Date()) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86_400_000) + 1;
}
export const sliceIndexFor = (d = new Date(), days = ROTATION_DAYS) => dayOfYear(d) % days;

/** The weekly products in `days` slices balanced by list price. Deterministic:
 *  dearest first, each into the lightest slice so far, ties to the lowest index. */
export function weeklySlices(products, days = ROTATION_DAYS) {
  const buckets = Array.from({ length: days }, () => ({ micro: 0, rows: [] }));
  const sorted = [...products].sort((a, b) => micro(b.usd) - micro(a.usd) || a.slug.localeCompare(b.slug));
  for (const p of sorted) {
    let i = 0;
    for (let k = 1; k < days; k++) if (buckets[k].micro < buckets[i].micro) i = k;
    buckets[i].rows.push(p);
    buckets[i].micro += micro(p.usd);
  }
  return buckets.map((b) => b.rows.sort((a, c) => a.slug.localeCompare(c.slug)));
}

/** What this run buys, cut against list prices before anything is signed. */
export function planRun(catalog, { tier = "daily", only = "", skip = [], now = new Date(), capUsd = DEFAULT_CAP_USD } = {}) {
  if (!TIERS.includes(tier)) throw Object.assign(new Error(`unknown tier "${tier}" (one of ${TIERS.join(", ")})`), { exitCode: 2 });
  const daily = catalog.filter((r) => tierOf(r) === "daily");
  const weekly = catalog.filter((r) => tierOf(r) === "weekly");
  const sliceIndex = sliceIndexFor(now);
  const slice = weeklySlices(weekly)[sliceIndex];
  let picked = tier === "daily" ? [...daily, ...slice] : tier === "weekly" ? slice : tier === "cheap" ? daily : [...daily, ...weekly];
  const skipSet = new Set(skip.map((s) => String(s).trim()).filter(Boolean));
  const skipped = picked.filter((r) => skipSet.has(r.slug));
  picked = picked.filter((r) => !skipSet.has(r.slug));
  // One term is a slug or path substring; a comma-separated list names exact slugs.
  const needle = String(only || "").trim().toLowerCase();
  if (needle.includes(",")) {
    const exact = new Set(needle.split(",").map((s) => s.trim()).filter(Boolean));
    picked = picked.filter((r) => exact.has(r.slug.toLowerCase()));
  } else if (needle) picked = picked.filter((r) => r.slug.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle));
  // Cheapest first, so the cap cuts the dearest products and names each one.
  const ordered = [...picked].sort((a, b) => micro(a.usd) - micro(b.usd) || a.slug.localeCompare(b.slug));
  const buy = [], deferred = [], noExample = [];
  let planned = 0;
  const cap = micro(capUsd);
  for (const r of ordered) {
    if (!r.example) { noExample.push(r); continue; }
    if (planned + micro(r.usd) > cap) { deferred.push(r); continue; }
    buy.push(r);
    planned += micro(r.usd);
  }
  // An own-sale tool needs a sale this run settles first. With none in the plan,
  // add the cheap source (never a skipped one) under the cap; when it cannot be
  // had, the tool waits as no-own-sale, a deferral and never a failure.
  let saleSource = null, addedSaleSource = false;
  const noOwnSale = [];
  if (buy.some(needsOwnSale)) {
    const inPlan = buy.filter(isSaleSource);
    if (inPlan.length) saleSource = (inPlan.find((r) => r.slug === SALE_SOURCE_SLUG) || inPlan[0]).slug;
    else {
      const eligible = catalog.filter((r) => isSaleSource(r) && !skipSet.has(r.slug)).sort((a, b) => micro(a.usd) - micro(b.usd) || a.slug.localeCompare(b.slug));
      const pick = eligible.find((r) => r.slug === SALE_SOURCE_SLUG) || eligible[0];
      if (pick && planned + micro(pick.usd) <= cap) { buy.unshift(pick); planned += micro(pick.usd); saleSource = pick.slug; addedSaleSource = true; }
      else for (const r of buy.filter(needsOwnSale)) { noOwnSale.push(r); buy.splice(buy.indexOf(r), 1); planned -= micro(r.usd); }
    }
  }
  return { tier, sliceIndex, buy, deferred, noExample, skipped, noOwnSale, saleSource, addedSaleSource, plannedUsd: planned / 1e6, dailyCount: daily.length, weeklyCount: weekly.length, sliceUsd: slice.reduce((s, r) => s + micro(r.usd), 0) / 1e6 };
}

/** The strict sweep's grade over one paid answer. Pure. */
export function gradeAnswer(row, r) {
  if (r.grade) return { pass: false, grade: r.grade };
  if (r.threw) return { pass: false, grade: /timeout|abort/i.test(r.threw) ? "timeout" : "unreachable" };
  if (r.status === 402) return { pass: false, grade: "unsettled" };
  if (r.status !== 200) return { pass: false, grade: `http-${r.status}` };
  if (r.bytes !== undefined) {
    if (row.binary) return r.bytes > 0 ? { pass: true, grade: "ok" } : { pass: false, grade: "empty-body" };
    return { pass: false, grade: "non-json" };
  }
  if (!r.body || typeof r.body !== "object") return { pass: false, grade: "non-json" };
  if (r.body.error) return { pass: false, grade: "error-field" };
  const missing = missingDocumentedKeys(row.path, row.op, r.body);
  if (missing.length) return { pass: false, grade: `missing-keys:${missing.join("+")}` };
  const hollow = emptyPromisedArrays(row.path, row.op, r.body, PROD_EMPTY_ARRAY_OK);
  if (hollow.length) return { pass: false, grade: `empty:${hollow.join("+")}` };
  return { pass: true, grade: "ok" };
}

/** A tool the spend cap left unbought, or an own-sale tool with no sale to name: unchecked, never failed. */
export const isDeferred = (r) => r.grade === "cap" || r.grade === NO_OWN_SALE;
const capDeferredOf = (results) => results.filter((r) => r.grade === "cap");
const noOwnSaleOf = (results) => results.filter((r) => r.grade === NO_OWN_SALE);
export const failedOf = (results) => results.filter((r) => !r.pass && !isDeferred(r));
export const deferredOf = (results) => results.filter(isDeferred);

export function exitCodeFor(summary) {
  if (summary.unfunded) return 3;
  if (failedOf(summary.results).length) return 5;
  return deferredOf(summary.results).length ? 4 : 0;
}

/** One word for the run: ok, fail, deferred (nothing failed, some unchecked) or unfunded. */
export function resultWordFor(summary) {
  if (summary.unfunded) return "unfunded";
  if (failedOf(summary.results).length) return "fail";
  return deferredOf(summary.results).length ? "deferred" : "ok";
}

const usd = (n) => `$${Number(n || 0).toFixed(3)}`;
// Failures first, then the cap-deferred, then the passes.
const rank = (r) => (r.pass ? 2 : isDeferred(r) ? 1 : 0);
const sortRows = (rows) => [...rows].sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));

export function summaryTable(results) {
  const rows = sortRows(results).map((r) => [r.slug, usd(r.usd), r.status == null ? "-" : String(r.status), r.grade, r.ms == null ? "-" : String(r.ms)]);
  const head = ["slug", "price", "status", "grade", "ms"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 1 || i === 4 ? c.padStart(w[i]) : c.padEnd(w[i]))).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

export function headlineFor(summary) {
  if (summary.unfunded) return "UNFUNDED";
  const failed = failedOf(summary.results).length, capped = capDeferredOf(summary.results).length, unsold = noOwnSaleOf(summary.results).length;
  if (!failed && !capped && !unsold) return "all passed";
  return [failed ? `${failed} FAILED` : "nothing failed", capped ? `${capped} cap-deferred` : "", unsold ? `${unsold} deferred (no own sale)` : ""].filter(Boolean).join(", ");
}

export function markdownSummary(summary) {
  const { results, plan, spentUsd, balanceUsd } = summary;
  const failed = failedOf(results), deferred = deferredOf(results);
  const lines = [
    `## Catalog buy: ${headlineFor(summary)}`,
    "",
    `tier \`${plan.tier}\` (slice ${plan.sliceIndex} of ${ROTATION_DAYS}) | graded ${results.length} | passed ${results.length - failed.length - deferred.length} | failed ${failed.length} | cap-deferred ${capDeferredOf(results).length}${noOwnSaleOf(results).length ? ` | deferred without an own sale ${noOwnSaleOf(results).length}` : ""} | planned ${usd(plan.plannedUsd)} | charged ${usd(spentUsd)}, never above a tool's documented ceiling${balanceUsd == null ? "" : ` | burner ${summary.unfunded ? "below" : "above"} its floor before the run`}`,
    "",
    "| slug | price | status | grade | ms |",
    "|---|---:|---|---|---:|",
    ...sortRows(results).map((r) => `| ${r.slug} | ${usd(r.usd)} | ${r.status ?? "-"} | ${r.grade} | ${r.ms ?? "-"} |`),
  ];
  return lines.join("\n");
}

/** Burner USDC balance on Base, or null when every RPC fails. */
export async function baseUsdcBalanceUsd(address, fetchImpl = fetch, rpcs = BASE_RPCS) {
  const data = "0x70a08231" + String(address).toLowerCase().replace("0x", "").padStart(64, "0");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] });
  for (const rpc of rpcs) {
    try {
      const r = await fetchImpl(rpc, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "agent402-catalog-buy" }, body, signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (typeof j?.result === "string" && /^0x[0-9a-fA-F]*$/.test(j.result)) return parseInt(j.result, 16) / 1e6;
    } catch { /* next RPC */ }
  }
  return null;
}

/** The settlement tx out of a base64 receipt header, or null. */
export function txFromReceiptHeader(h) {
  if (!h) return null;
  try { const r = JSON.parse(Buffer.from(h, "base64").toString("utf8")); return r?.success === true && typeof r.transaction === "string" ? r.transaction : null; } catch { return null; }
}

export const heartbeatToken = (secret, nowMs = Date.now()) =>
  createHmac("sha256", secret).update(`heartbeat:${Math.floor(nowMs / 60_000)}`).digest("base64url").slice(0, 32);

async function mapPool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function readBody(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return { body: await res.json() }; } catch { return { body: null }; }
  }
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return { bytes: buf.byteLength };
}

/**
 * Buy and grade the planned catalog. `payer` is { address, parseChallenge(getHeader, body),
 * pay(paymentRequired) -> headers }; the real one is built in main() from the x402
 * client, the test's one signs nothing. Nothing here reads a secret.
 */
export async function runCatalogBuy({
  target, payer, fetchImpl = fetch, readBalanceUsd = null, powSecret = "", tier = "daily", only = "", skip = [],
  capUsd = DEFAULT_CAP_USD, floorUsd = DEFAULT_FLOOR_USD, concurrency = DEFAULT_CONCURRENCY, paceMs = DEFAULT_PACE_MS, timeoutMs = 90_000,
  slowTimeoutMs = 330_000, retryBackoffMs = 5_000, now = new Date(), dry = false, log = console,
  capture = true, captureMaxBytes = CAPTURE_MAX_BYTES,
} = {}) {
  const base = String(target).replace(/\/+$/, "");
  const getJson = async (p) => { const r = await fetchImpl(`${base}${p}`, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw Object.assign(new Error(`GET ${p} HTTP ${r.status}`), { exitCode: 2 }); return r.json(); };
  const [pricing, spec] = await Promise.all([getJson("/api/pricing"), getJson("/openapi.json")]);
  const catalog = catalogFromSurfaces(pricing, spec);
  if (!catalog.length) throw Object.assign(new Error("the catalog read empty: nothing to buy"), { exitCode: 2 });
  const plan = planRun(catalog, { tier, only, skip, now, capUsd });
  log.log(`[catalog-buy] ${base} tier=${plan.tier} slice=${plan.sliceIndex}/${ROTATION_DAYS} catalog=${catalog.length} (daily ${plan.dailyCount}, weekly ${plan.weeklyCount}, today's slice ${usd(plan.sliceUsd)})`);
  if (plan.addedSaleSource) log.log(`[catalog-buy] ${plan.saleSource} is bought first: ${plan.buy.filter(needsOwnSale).map((r) => r.slug).join(", ")} names a sale this run makes`);
  if (plan.noOwnSale.length) log.warn(`WARN  ${plan.noOwnSale.map((r) => r.slug).join(", ")}: deferred, no sale this run can make fits the cap`);
  log.log(`[catalog-buy] buying ${plan.buy.length} (${plan.buy.filter((r) => r.quoted).length} quoted under a documented ceiling, the rest at list price), planned ${usd(plan.plannedUsd)} under the ${usd(capUsd)} cap; cap-deferred ${plan.deferred.length}, no example ${plan.noExample.length}, skipped ${plan.skipped.length}; ${concurrency} in flight, ${paceMs} ms pace${dry ? " [dry run: nothing is bought]" : ""}`);

  const results = [];
  const unbought = (r, grade) => ({ slug: r.slug, path: r.path, usd: r.usd, status: null, grade, pass: false, ms: null, attempts: 0 });
  for (const r of plan.deferred) results.push(unbought(r, "cap"));
  for (const r of plan.noExample) results.push(unbought(r, "no-example"));
  for (const r of plan.noOwnSale) results.push(unbought(r, NO_OWN_SALE));
  const summary = { plan, results, captures: [], spentUsd: 0, balanceUsd: null, unfunded: false, dry, payer: payer?.address || null };
  if (dry) { summary.exitCode = exitCodeFor(summary); return summary; }

  if (readBalanceUsd) {
    summary.balanceUsd = await readBalanceUsd(payer.address);
    if (summary.balanceUsd == null) log.warn("WARN  burner balance unreadable on every RPC: starting anyway, the cap bounds the run");
    else if (summary.balanceUsd < plan.plannedUsd + floorUsd) {
      summary.unfunded = true;
      log.error(`CATALOG BUY UNFUNDED: the Base burner holds less USDC than the planned ${usd(plan.plannedUsd)} plus the ${usd(floorUsd)} floor. Nothing bought; top up ${payer.address}.`);
      summary.exitCode = 3;
      return summary;
    }
  }

  const secret = String(powSecret || "").trim();
  if (!secret) log.warn("WARN  POW_SECRET not set: these buys will record as EXTERNAL demand in the sales ledger");
  const stamp = (headers = {}) => (secret ? { ...headers, "X-Heartbeat-Token": heartbeatToken(secret) } : { ...headers });
  const cap = micro(capUsd);
  let reserved = 0; // charged on a 200, reserved before the signature so two workers cannot both fit the last dollar
  let fixture = null;
  const fixtureBytes = async () => {
    if (!fixture) {
      const r = await fetchImpl(`${base}/fixtures/sample-speech.wav`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`fixture HTTP ${r.status}`);
      fixture = new Uint8Array(await r.arrayBuffer());
    }
    return fixture;
  };

  async function requestFor(row, ex = row.example) {
    let url = `${base}${row.path}`;
    const init = { method: row.method.toUpperCase(), headers: { Accept: "application/json" } };
    if (ex.kind === "query") {
      const qs = new URLSearchParams(ex.query).toString();
      if (qs) url += `?${qs}`;
    } else if (ex.kind === "json") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(ex.body ?? {});
    } else {
      init.body = multipartBodyFrom(ex.fields, { bytes: await fixtureBytes(), type: "audio/wav", filename: "sample-speech.wav" });
    }
    return { url, init };
  }

  async function attempt(row, url, init, timeout) {
    const bare = await fetchImpl(url, { ...init, headers: stamp(init.headers), signal: AbortSignal.timeout(Math.min(timeout, 45_000)) });
    if (bare.status !== 402) {
      const b = await readBody(bare);
      return { status: bare.status, ...b, grade: bare.status === 200 ? "unpaid-200" : undefined };
    }
    const bareBody = await bare.json().catch(() => undefined);
    let pr = null;
    try { pr = payer.parseChallenge((n) => bare.headers.get(n), bareBody); } catch { pr = null; }
    const accepts = (pr?.accepts || []).filter((a) => String(a.network || "") === BASE_CAIP2 && String(a.scheme || "exact") === "exact");
    if (!accepts.length) return { status: 402, grade: "no-base-accept" };
    const quoted = Number(accepts[0].amount ?? accepts[0].maxAmountRequired);
    if (!Number.isFinite(quoted) || quoted <= 0) return { status: 402, grade: "unreadable-quote" };
    // A fixed-price tool may ask exactly its list price; a quoted tool may ask
    // anything up to its documented ceiling (its list price is the floor).
    if (quoted > micro(row.maxUsd)) return { status: 402, grade: row.quoted ? "quote-over-ceiling" : "quote-over-list", quotedUsd: quoted / 1e6 };
    if (reserved + quoted > cap) return { status: 402, grade: "cap", quotedUsd: quoted / 1e6 };
    reserved += quoted;
    try {
      const payHeaders = await payer.pay({ ...pr, accepts });
      const paid = await fetchImpl(url, { ...init, headers: { ...stamp(init.headers), ...payHeaders }, signal: AbortSignal.timeout(timeout) });
      const b = await readBody(paid);
      if (paid.status !== 200) reserved -= quoted; // a non-200 cancels settlement: nothing was charged
      return { status: paid.status, ...b, paid: true, quotedUsd: quoted / 1e6, tx: txFromReceiptHeader(paid.headers.get("payment-response") || paid.headers.get("x-payment-response")) };
    } catch (e) {
      reserved -= quoted;
      throw e;
    }
  }

  // The sale an own-sale tool names: the preferred source's when it settled, else the latest.
  let ownSale = null;
  const noteSale = (row, r, out) => {
    if (!isSaleSource(row) || r.paid !== true || out.status !== 200 || !out.tx || !r.body || typeof r.body !== "object") return;
    if (!ownSale || !ownSale.preferred || row.slug === plan.saleSource) ownSale = { tx: out.tx, slug: row.slug, preferred: row.slug === plan.saleSource };
  };

  async function buyOne(row, sale = null) {
    const t0 = Date.now();
    const timeout = tierOf(row) === "weekly" ? slowTimeoutMs : timeoutMs;
    let r, attempts = 0;
    try {
      const { url, init } = await requestFor(row, sale ? withOwnSale(row.example, sale.tx) : row.example);
      r = await attempt(row, url, init, timeout); attempts = 1;
      if (!r.grade && r.status >= 500 && r.status <= 599) {
        log.warn(`  retry ${row.slug} after HTTP ${r.status}`);
        await sleep(retryBackoffMs);
        r = await attempt(row, url, init, timeout); attempts = 2;
      }
    } catch (e) {
      r = { threw: String(e?.name === "TimeoutError" ? "timeout" : e?.message || e) }; attempts = attempts || 1;
    }
    const { pass, grade } = gradeAnswer(row, r);
    const out = { slug: row.slug, path: row.path, usd: row.usd, quotedUsd: r.quotedUsd ?? null, status: r.status ?? null, grade, pass, ms: Date.now() - t0, attempts, tx: r.tx || null, ...(sale ? { ownSaleOf: sale.slug } : {}) };
    noteSale(row, r, out);
    // The paid answer itself goes to the separate outputs file (redacted,
    // bounded, guarded: scripts/catalog-buy-capture.js), never into the
    // graded report, which keeps its receipt fields for the run's own audit.
    // The capture sees the published example, and the substituted tx is named
    // as ours, so it is blanked wherever the answer echoes it.
    if (capture) summary.captures.push(captureRecord(row, out, { status: r.status, body: r.body, paid: r.paid === true }, { payer: payer?.address || null, maxBytes: captureMaxBytes, ownTxs: sale ? [sale.tx] : [] }));
    log.log(`${pass ? "OK  " : "FAIL"} ${row.slug.padEnd(34)} ${usd(row.usd)}  ${String(out.status ?? "-").padStart(3)}  ${grade}  ${out.ms}ms`);
    return out;
  }

  // Dearest (slowest) first so the long report builds overlap the cheap stream.
  // Own-sale tools go last, once every other tool has had its chance to settle.
  const order = [...plan.buy].sort((a, b) => micro(b.usd) - micro(a.usd) || a.slug.localeCompare(b.slug));
  await mapPool(order.filter((r) => !needsOwnSale(r)), concurrency, async (row) => { results.push(await buyOne(row)); if (paceMs) await sleep(paceMs); });
  await mapPool(order.filter(needsOwnSale), concurrency, async (row) => {
    if (!ownSale) {
      log.warn(`DEFER ${row.slug.padEnd(34)} ${usd(row.usd)}  no sale settled this run for it to name`);
      results.push(unbought(row, NO_OWN_SALE));
      return;
    }
    results.push(await buyOne(row, ownSale));
    if (paceMs) await sleep(paceMs);
  });
  summary.spentUsd = reserved / 1e6;
  summary.exitCode = exitCodeFor(summary);
  return summary;
}

async function realPayer(pk) {
  const [{ privateKeyToAccount }, { x402Client, x402HTTPClient }, { registerExactEvmScheme }, { disableVendorSpendControls }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("../src/x402-spend-controls.js"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = disableVendorSpendControls(new x402Client());
  registerExactEvmScheme(client, { signer: account });
  const http = new x402HTTPClient(client);
  return {
    address: account.address,
    parseChallenge: (get, body) => http.getPaymentRequiredResponse(get, body),
    pay: async (pr) => http.encodePaymentSignatureHeader(await client.createPaymentPayload(pr)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const dry = args.includes("--dry") || process.env.CATALOG_BUY_DRY === "1";
  const tier = arg("--tier", process.env.CATALOG_BUY_TIER || "daily");
  const only = arg("--only", process.env.CATALOG_BUY_ONLY || "");
  const out = arg("--out");
  const outputsOut = arg("--outputs");
  const target = process.env.TARGET_URL || "https://agent402.tools";
  const pk = (process.env.BURNER_KEY || "").trim();
  if (!pk && !dry) { console.error("catalog-buy: BURNER_KEY is not set (use --dry to plan without buying)"); process.exit(2); }
  const payer = dry ? { address: null } : await realPayer(pk);
  const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== undefined && process.env[k] !== "" ? n : d; };

  let summary;
  try {
    summary = await runCatalogBuy({
      target, payer, tier, only, dry,
      powSecret: process.env.POW_SECRET,
      readBalanceUsd: dry ? null : (addr) => baseUsdcBalanceUsd(addr),
      skip: String(process.env.CATALOG_BUY_SKIP || "").split(","),
      capUsd: num("CATALOG_BUY_MAX_USD", DEFAULT_CAP_USD),
      floorUsd: num("CATALOG_BUY_FLOOR_USD", DEFAULT_FLOOR_USD),
      concurrency: num("CATALOG_BUY_CONCURRENCY", DEFAULT_CONCURRENCY),
      paceMs: num("CATALOG_BUY_PACE_MS", DEFAULT_PACE_MS),
      timeoutMs: num("CATALOG_BUY_TIMEOUT_MS", 90_000),
      slowTimeoutMs: num("CATALOG_BUY_SLOW_TIMEOUT_MS", 330_000),
    });
  } catch (e) {
    console.error(`catalog-buy: ${e?.message || e}`);
    process.exit(e?.exitCode || 1);
  }

  const failed = failedOf(summary.results), deferred = deferredOf(summary.results);
  console.log(`\n${summaryTable(summary.results)}`);
  console.log(`\ngraded ${summary.results.length}: ${summary.results.length - failed.length - deferred.length} passed, ${failed.length} failed, ${deferred.length} cap-deferred | planned ${usd(summary.plan.plannedUsd)} | charged ${usd(summary.spentUsd)}, never above a tool's documented ceiling${summary.payer ? ` | payer ${summary.payer}` : ""}`);
  if (summary.plan.deferred.length) console.log(`not bought (cap): ${summary.plan.deferred.map((r) => r.slug).join(", ")}`);
  if (summary.plan.noOwnSale.length) console.log(`not bought (no own sale to name): ${summary.plan.noOwnSale.map((r) => r.slug).join(", ")}`);
  if (summary.plan.noExample.length) console.log(`no usable published example: ${summary.plan.noExample.map((r) => r.slug).join(", ")}`);
  if (summary.plan.skipped.length) console.log(`skipped by CATALOG_BUY_SKIP: ${summary.plan.skipped.map((r) => r.slug).join(", ")}`);

  if (out) {
    writeFileSync(out, JSON.stringify({ target, tier: summary.plan.tier, sliceIndex: summary.plan.sliceIndex, dry, startedAt: new Date().toISOString(), plannedUsd: summary.plan.plannedUsd, chargedUsd: summary.spentUsd, funded: summary.balanceUsd == null ? null : !summary.unfunded, unfunded: summary.unfunded, results: summary.results }, null, 2));
    console.log(`wrote ${out}`);
  }
  if (outputsOut) {
    // The paid answers, for scripts/catalog-buy-examples.js. No payer, no
    // receipts, no tx: each record is the grade, the latency, the documented
    // example's shape and the redacted, bounded body (or why it was dropped).
    const kept = summary.captures.filter((c) => c.captured).length;
    writeFileSync(outputsOut, JSON.stringify({ version: 1, target, tier: summary.plan.tier, capturedAt: new Date().toISOString(), maxBytesPerTool: CAPTURE_MAX_BYTES, captures: summary.captures }, null, 2));
    console.log(`wrote ${outputsOut} (${summary.captures.length} graded, ${kept} answers kept)`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownSummary(summary)}\n`); } catch { /* local run */ } }
  if (process.env.GITHUB_OUTPUT) {
    const result = resultWordFor(summary);
    const named = failed.slice(0, 60).map((r) => `${r.slug} (${r.grade})`).join(", ") + (failed.length > 60 ? `, and ${failed.length - 60} more` : "");
    const deferredNamed = deferred.slice(0, 60).map((r) => (r.grade === "cap" ? r.slug : `${r.slug} (${r.grade})`)).join(", ") + (deferred.length > 60 ? `, and ${deferred.length - 60} more` : "");
    try { appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\nfailing=${named}\ndeferring=${deferredNamed}\ngraded=${summary.results.length}\nfailed=${failed.length}\ndeferred=${deferred.length}\ncharged=${usd(summary.spentUsd)}\n`); } catch { /* local run */ }
  }
  process.exit(summary.exitCode);
}

const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
