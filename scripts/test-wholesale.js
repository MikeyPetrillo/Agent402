#!/usr/bin/env node
// The wholesale surface (src/wholesale.js, GET /api/wholesale/v1[/<family>],
// /wholesale) and the stable error codes (src/stable-error-code.js):
//   - the v1 field set and the error code table are pinned (a v1 field or
//     code may be added, never removed or renamed);
//   - reliability agrees with /api/reliability/tools (seven days, 20 calls,
//     the same status words and rounding) and publishes no call volume in
//     any form (no count, no band): a rate needs the minimum sample,
//     reads only outside lanes inside 24 hours, rounds down, lies in [0, 1];
//     latency rounds up; volume is a band, never a count;
//   - whether a failed call was charged depends on the rail (a Tempo push
//     transfer is final before the call): no error code's meaning says it,
//     the contract says it once, rail by rail, with the refund terms, and so
//     does the page;
//   - the compute family is our own computation only: a proof-of-work tool
//     that serves a committed outside dataset (country-info, ODbL) or a
//     source's data (an attribution) is not in it;
//   - on a FREE_MODE boot: every listed price is /api/pricing's own, no
//     listed tool is model-backed or market data, a family's rates move with
//     real calls, a tool error carries its errorCode, the page renders.
//   node scripts/test-wholesale.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { ERROR_CODES, stableErrorCode, errorCodeField } from "../src/stable-error-code.js";
import { COMMITTED_DATASET_SLUGS } from "../src/wholesale.js";
import { reliabilityOf, toolRow, wholesaleIndex, wholesaleFamily, WHOLESALE_FAMILIES, WHOLESALE_MIN_SAMPLE, WHOLESALE_WINDOW_HOURS, STATUS_MEASURED, STATUS_THIN } from "../src/wholesale.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { toolReliabilityEnabled, TOOL_RELIABILITY_PATH } from "../src/tool-reliability.js";
import { reliabilityDefinition, RELIABILITY_DEFINITION } from "../src/wholesale.js";
import { wholesalePage } from "../src/wholesale-page.js";
import { reliabilityReport } from "../src/discovery.js";
import { preValidateInput } from "../src/handler-input.js";
import { stripScripts } from "./lib/html-text.js";
import { failedCallFootnote, TEMPO_PUSH_EXCEPTION } from "../src/settlement-footnote.js";
import { REFUND_TERMS_PATH } from "../src/refund-terms-path.js";
import { ATTRIBUTION_TAILS } from "../src/data-attribution.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// ---- error codes: the v1 table only grows
const V1_CODES = { 400: "invalid_input", 402: "payment_required", 404: "not_found", 409: "conflict", 410: "retired", 413: "input_too_large", 415: "unsupported_media_type", 422: "input_not_resolvable", 429: "rate_limited", 499: "client_closed", 500: "internal_error", 502: "upstream_error", 503: "unavailable", 504: "timeout" };
for (const [s, c] of Object.entries(V1_CODES)) ok(stableErrorCode(Number(s)) === c && ERROR_CODES.some((e) => e.status === Number(s) && e.code === c), `status ${s} reads ${c}`);
ok(new Set(ERROR_CODES.map((e) => e.code)).size === ERROR_CODES.length && ERROR_CODES.every((e) => /^[a-z_]+$/.test(e.code) && e.meaning && /^[a-z-]+$/.test(e.retry)), "codes are unique snake_case words, each with a meaning and a retry verb");
ok(ERROR_CODES.every((e) => !/\bcharg(?:e|ed|es|ing)\b/i.test(e.meaning)), `no code's meaning says whether the call was charged, which depends on the rail (${ERROR_CODES.filter((e) => /\bcharg/i.test(e.meaning)).map((e) => e.status).join(", ") || "none"})`);
ok(stableErrorCode(418) === "invalid_input" && stableErrorCode(507) === "internal_error" && stableErrorCode(200) === null && stableErrorCode("x") === null, "an unlisted status reads its class; under 400 reads none");
ok(JSON.stringify(errorCodeField(200)) === "{}" && errorCodeField(504).errorCode === "timeout", "the field spreads to nothing under 400");
{
  // The pre-payment input check (direct routes and /ref) answers in the dispatcher's shape, code included.
  const def = { slug: "zz", route: "POST /api/zz", discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "a" } } };
  const bad = preValidateInput(def, { method: "POST", path: "/api/zz", body: {}, query: {}, headers: { "content-type": "application/json" } });
  ok(bad?.status === 400 && bad.body.errorCode === "invalid_input" && Object.keys(bad.body).slice(0, 3).join(",") === "error,tool,errorCode", `the pre-payment refusal carries errorCode right after tool (${bad && Object.keys(bad.body).join(",")})`);
}

// ---- reliability, pure
const now = Date.parse("2026-11-18T12:00:00Z");
ok(WHOLESALE_WINDOW_HOURS === 168 && WHOLESALE_MIN_SAMPLE === 20, "seven days and a 20-call minimum, as /api/reliability/tools");
{
  // When the per-tool reliability table is in this build, its constants are ours.
  const shared = await import("../src/tool-reliability.js").catch(() => null);
  if (shared) ok(shared.TOOL_RELIABILITY_WINDOW_HOURS === WHOLESALE_WINDOW_HOURS && shared.TOOL_RELIABILITY_MIN_SAMPLE === WHOLESALE_MIN_SAMPLE && shared.STATUS_MEASURED === STATUS_MEASURED && shared.STATUS_THIN === STATUS_THIN, "the same window, minimum and status words as src/tool-reliability.js");
  if (shared) {
    const o = { slug: "x", n: 40, ok: 37, serverErrored: 3, p50: 120, p95: 900 };
    const theirs = shared.reliabilityRow({ slug: "x", route: "GET /api/x" }, o, true);
    const ours = reliabilityOf(o, true);
    ok(["status", "measured", "successRate", "p50Ms", "p95Ms"].every((k) => theirs[k] === ours[k]), "the same row figures as /api/reliability/tools for the same outcome");
  }
}
const r = reliabilityOf({ n: 38, ok: 35, p50: 101, p95: 999 }, true);
ok(r.status === STATUS_MEASURED && r.measured === true && r.successRate === Math.floor((35 / 38) * 1000) / 1000 && r.p50Ms === 101 && r.p95Ms === 999, `measured: rate floored to three places, latency as read (${JSON.stringify(r)})`);
const thin = reliabilityOf({ n: WHOLESALE_MIN_SAMPLE - 1, ok: WHOLESALE_MIN_SAMPLE - 1, p50: 5, p95: 9 }, true);
ok(thin.status === STATUS_THIN && thin.measured === false && thin.successRate === null && thin.p50Ms === null && thin.p95Ms === null, "under the minimum: not enough data, every figure null");
ok(reliabilityOf({ n: 500, ok: 500 }, false).status === STATUS_THIN && reliabilityOf(undefined, true).status === STATUS_THIN, "unreadable outcomes or no row: not enough data, never a figure");
ok(reliabilityOf({ n: 25, ok: 0, p50: 1, p95: 2 }, true).successRate === 0, "every call failing reads 0, not null");
ok(reliabilityOf({ n: 1000, ok: 999 }, true).successRate === 0.999 && reliabilityOf({ n: 10000, ok: 9999 }, true).successRate < 1, "any failure keeps the rate under 1");
// No call volume in any form.
const VOLUME_KEY = /^(n|calls?|count|counts|volume|sample|samples|sampleSize|band|callsBand|serverErrors|requests|total)$/i;
const BAND_VALUE = /^(<\d+|\d+-\d+|\d+\+)$/;
const noVolume = (o, path = "") => {
  const bad = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (VOLUME_KEY.test(k)) bad.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
    else if (typeof v === "string" && BAND_VALUE.test(v)) bad.push(`${p}=${v}`);
  };
  walk(o, path);
  return bad;
};
ok(noVolume(reliabilityOf({ n: 12345, ok: 12000, p50: 1, p95: 2 }, true)).length === 0 && !JSON.stringify(reliabilityOf({ n: 12345, ok: 12000, p50: 1, p95: 2 }, true)).includes("12345"), "a reliability block carries no count and no band, and never the count it read");

// ---- field contract (v1 only grows)
const ROW_KEYS = ["slug", "name", "method", "path", "url", "price", "modelBacked", "docs", "reliability"];
const fakeCatalog = {
  "GET /api/a": { slug: "edgar-filings", name: "A", price: "$0.005" },
  "POST /api/b": { slug: "filings-brief", name: "B", price: "$0.027", quoteRange: { minUsd: 0.027, maxUsd: 1.08 } },
  "POST /api/m": { slug: "edgar-search", name: "M", price: "$0.005", modelBacked: true },
  "GET /api/c": { slug: "hash", name: "C", price: "$0.001" },
};
const ctx = { catalog: fakeCatalog, powSlugs: new Set(["hash"]), baseUrl: "https://x.test", outcomes: { ok: true, rows: [{ slug: "edgar-filings", n: 777, ok: 770, serverErrored: 7, p50: 80, p95: 400 }] }, now };
const row = toolRow("POST /api/b", fakeCatalog["POST /api/b"], { baseUrl: "https://x.test", outcome: undefined, available: true });
ok(ROW_KEYS.every((k) => k in row), `a tool row carries every v1 field (${ROW_KEYS.join(", ")})`);
ok(row.price.text === "$0.027" && row.price.usd === 0.027 && row.price.perRequest.maxUsd === 1.08, "the price is the catalog's own, with the per-request range when quoted");
const idx = wholesaleIndex(ctx);
for (const k of ["version", "stability", "pricing", "errorCodes", "reliabilityDefinition", "docs", "asOf", "families", "notOffered"]) ok(k in idx, `the index carries ${k}`);
ok(idx.version === "v1" && /no wholesale discount/.test(idx.pricing), "v1, and the pricing sentence says no discount");
ok(!/license|vendor/i.test(idx.notOffered) && /^Market data, search results and model output are not offered/.test(idx.notOffered), "notOffered lists what is left out, with no reason given");
const fam = wholesaleFamily("sec-filings", ctx);
ok(fam.tools.map((t) => t.slug).join(",") === "edgar-filings,filings-brief", "a family lists its tools, never a model-backed one");
ok(fam.tools[0].reliability.status === STATUS_MEASURED && fam.tools[0].reliability.successRate === 0.990 && fam.tools[1].reliability.status === STATUS_THIN, "a family row reads its own outcome; a tool with none reads not enough data");
ok(noVolume(fam).length === 0 && noVolume(idx).length === 0 && !JSON.stringify(fam).includes("777"), `no family or index answer carries a count or a band (${noVolume(fam).concat(noVolume(idx)).join(", ") || "none"})`);
const off = wholesaleFamily("sec-filings", { ...ctx, outcomes: { ok: false, reason: "not-configured" } });
ok(off.reliabilityAvailable === false && off.reliabilityReason === "not-configured" && off.tools.every((t) => t.reliability.status === STATUS_THIN), "outcomes that cannot be read: every row not enough data, with the reason");
ok(wholesaleFamily("compute", ctx).tools.map((t) => t.slug).join(",") === "hash", "compute is the proof-of-work set");
{
  // A proof-of-work tool that serves a committed outside dataset, or carries
  // a source's attribution, is not our own computation.
  const cat = { ...fakeCatalog, "GET /api/country-info": { slug: "country-info", name: "Country info", price: "$0.001" }, "GET /api/fx": { slug: "fx-like", name: "F", price: "$0.001", attribution: "ecb" } };
  const c2 = { ...ctx, catalog: cat, powSlugs: new Set(["hash", "country-info", "fx-like"]) };
  ok(wholesaleFamily("compute", c2).tools.map((t) => t.slug).join(",") === "hash" && wholesaleIndex(c2).families.find((f) => f.id === "compute").tools === 1, `the compute family leaves out a dataset tool and an attributed one (${wholesaleFamily("compute", c2).tools.map((t) => t.slug).join(",")})`);
  ok(wholesalePage("https://x.test", cat, c2.powSlugs).includes(">1</td>"), "the page counts the same compute tools as the JSON");
}
{
  // Charged or not on a failure depends on the rail: said once, rail by rail.
  const charging = idx.errorCodes.charging || "";
  ok(idx.errorCodes.refundTerms === `https://x.test${REFUND_TERMS_PATH}`, `the error codes link the refund terms (${idx.errorCodes.refundTerms})`);
  ok(charging === failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"], tempoPush: true }) && charging.includes(TEMPO_PUSH_EXCEPTION), "the contract says which rails a failed call is not charged on, with the Tempo push exception");
  ok(wholesaleIndex({ ...ctx, tempoPush: false }).errorCodes.charging === failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"] }), "with no Tempo push offered the exception is left out");
  ok(JSON.stringify(wholesaleFamily("sec-filings", ctx).errorCodes) === JSON.stringify(idx.errorCodes), "a family answer carries the same error-code contract");
  const page = stripScripts(wholesalePage("https://x.test"), "");
  ok(page.includes(failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"], tempoPush: true })) && !/never charged/i.test(page) && page.includes(REFUND_TERMS_PATH), "the page says it the same way, names the refund terms, and never says an error answer is never charged");
  ok(!stripScripts(wholesalePage("https://x.test", {}, new Set(), { tempoPush: false }), "").includes(TEMPO_PUSH_EXCEPTION), "the page leaves out the exception where Tempo push is not offered");
}
ok(wholesaleFamily("nope", ctx) === null, "an unknown family reads null");
ok(WHOLESALE_FAMILIES.every((f) => ["public-domain", "cc-by-4.0", "own-computation"].includes(f.redistribution)), "every family's basis is public domain, CC BY 4.0 or our own computation");

// ---- the per-tool table withdrawn: nothing here points to it
{
  const sw = (v) => ({ TOOL_RELIABILITY_PUBLIC: v });
  ok([undefined, "", "on", "1", "true", "yes", "offf"].every((v) => toolReliabilityEnabled(sw(v))), "TOOL_RELIABILITY_PUBLIC unset or any other word: the table is published");
  ok(["off", "0", "false", "no", " OFF ", "False", "NO\n"].every((v) => !toolReliabilityEnabled(sw(v))), "off, 0, false and no (trimmed, any case) withdraw it");
  ok(reliabilityDefinition({}).sameAs === TOOL_RELIABILITY_PATH && !("sameAs" in reliabilityDefinition(sw("off"))) && Object.keys(reliabilityDefinition(sw("off"))).join() === Object.keys(RELIABILITY_DEFINITION).filter((k) => k !== "sameAs").join(), "the definition names the table only while it is published; its other fields stay");
  const surfaces = () => ({
    index: JSON.stringify(wholesaleIndex(ctx)),
    family: JSON.stringify(wholesaleFamily(WHOLESALE_FAMILIES[0].id, ctx)),
    page: wholesalePage("https://agent402.tools"),
    report: JSON.stringify(reliabilityReport({ baseUrl: "https://agent402.tools", network: "base", wallet: null, stats: {} })),
  });
  const before = process.env.TOOL_RELIABILITY_PUBLIC;
  try {
    delete process.env.TOOL_RELIABILITY_PUBLIC;
    const onNow = surfaces();
    ok(Object.entries(onNow).every(([, text]) => text.includes(TOOL_RELIABILITY_PATH)), "published: the wholesale index, a family, the page and /api/reliability each point to it");
    for (const word of ["off", "0", "false", "No"]) {
      process.env.TOOL_RELIABILITY_PUBLIC = word;
      const offNow = surfaces();
      const still = Object.entries(offNow).filter(([, text]) => text.includes(TOOL_RELIABILITY_PATH)).map(([k]) => k);
      ok(still.length === 0, `TOOL_RELIABILITY_PUBLIC=${word}: none of them names the table${still.length ? ` (still: ${still.join(", ")})` : ""}`);
      ok(JSON.parse(offNow.report).endpoints.status && offNow.page.includes("/api/reliability\"") && JSON.parse(offNow.index).reliabilityDefinition.successRate, "the service-wide pointers and the definition's own words stay");
    }
  } finally {
    if (before === undefined) delete process.env.TOOL_RELIABILITY_PUBLIC; else process.env.TOOL_RELIABILITY_PUBLIC = before;
  }
}

// ---- a FREE_MODE boot
let srv = null;
try {
  srv = await bootServer({ env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", POSTHOG_API_KEY: "", STATS_ALLOW_EPHEMERAL: "true", SOLANA_LEADERBOARD: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000" }, stores: "wholesale" });
  const U = srv.url;
  const pricing = await (await fetch(`${U}/api/pricing`)).json();
  const bySlug = new Map((pricing.endpoints || pricing.tools).map((e) => [e.slug, e]));
  // Twenty-five real calls to one compute tool BEFORE its family is first
  // read (a family answer is kept 60 s), then the read must show them.
  const openapi = await (await fetch(`${U}/openapi.json`)).json();
  const probe = [...FREE_TIER_SLUGS].filter((s) => !COMMITTED_DATASET_SLUGS.includes(s)).map((s) => bySlug.get(s)).find((e) => e && e.method === "GET" && (openapi.paths[e.path]?.get?.parameters || []).some((p) => p.example !== undefined));
  const params = (openapi.paths[probe.path].get.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => `${p.name}=${encodeURIComponent(p.example)}`).join("&");
  let good = 0;
  for (let i = 0; i < 25; i++) { const res = await fetch(`${U}${probe.path}?${params}`); if (res.status < 400) good++; await res.arrayBuffer(); }
  ok(good === 25, `${probe.slug}: its own example answered 25 times`);
  const computeIdx = await (await fetch(`${U}/api/wholesale/v1`)).json();
  ok(computeIdx.families.length === WHOLESALE_FAMILIES.length && computeIdx.families.every((f) => f.tools > 0), `the index lists every family with tools (${computeIdx.families.map((f) => `${f.id} ${f.tools}`).join(", ")})`);
  const all = [];
  for (const f of computeIdx.families) {
    const j = await (await fetch(`${U}/api/wholesale/v1/${f.id}`)).json();
    ok(j.version === "v1" && j.family.id === f.id && j.toolCount === j.tools.length && j.toolCount === f.tools, `${f.id}: v1 answer, toolCount matches rows and the index (${j.toolCount})`);
    all.push(...j.tools.map((t) => ({ ...t, family: f.id })));
  }
  const measured = all.find((t) => t.slug === probe.slug);
  // FREE_MODE counts no outcomes (the failure monitor's lane is the paid
  // dispatcher's), so the rate stays null with its reason; timing is counted.
  // A boot with no analytics store reads every row not enough data, with the reason.
  ok(measured && measured.reliability.status === STATUS_THIN && measured.reliability.successRate === null && measured.reliability.p50Ms === null, `${probe.slug}: with no outcome store, not enough data (${JSON.stringify(measured?.reliability)})`);
  ok(all.every((t) => noVolume(t).length === 0), "no served row carries a count or a band");
  ok(all.every((t) => bySlug.get(t.slug)?.price === t.price.text), "every listed price is /api/pricing's own price (no discount, no drift)");
  ok(all.every((t) => t.modelBacked === false && bySlug.get(t.slug)?.modelBacked !== true), "no listed tool is model-backed");
  ok(!all.some((t) => t.family !== "compute" && /coingecko|databento|brave/i.test(bySlug.get(t.slug)?.description || "")), "no vendor-licensed market data or search results outside the compute family");
  ok(!all.some((t) => t.slug === "token-diligence" || t.slug.startsWith("crypto-") || t.slug.startsWith("coin-") || t.slug.startsWith("stock-")), "the CoinGecko-backed and stock tools are not offered");
  ok(all.some((t) => t.slug === "weather-risk-brief" && t.price.perRequest) && all.some((t) => t.slug === "filings-brief" && t.price.perRequest), "the bundle products are listed with their per-request range");
  ok(all.every((t) => t.reliability.successRate === null || (t.reliability.successRate >= 0 && t.reliability.successRate <= 1)), "every rate is null or in [0, 1]");
  {
    // The compute family is ours: no tool whose description names an outside
    // dataset or its license, or ends with a source's attribution sentence.
    const DATASET = /\bODbL\b|Open Database License|\bCC[ -]BY\b|world-countries/i;
    const borrowed = all.filter((t) => t.family === "compute" && (DATASET.test(bySlug.get(t.slug)?.description || "") || ATTRIBUTION_TAILS.some((x) => (bySlug.get(t.slug)?.description || "").includes(x))));
    ok(borrowed.length === 0 && !all.some((t) => t.family === "compute" && t.slug === "country-info") && bySlug.has("country-info"), `no compute-family tool serves an outside dataset; country-info (ODbL) is served but not listed here (${borrowed.map((t) => t.slug).join(", ") || "none"})`);
  }
  const err = await fetch(`${U}/api/edgar-filings`);
  const ej = await err.json();
  ok(err.status === 400 && ej.errorCode === "invalid_input" && typeof ej.error === "string", "a tool error answer carries its errorCode beside the message");
  const nf = await fetch(`${U}/api/wholesale/v1/nope`);
  const nj = await nf.json();
  ok(nf.status === 404 && nj.errorCode === "not_found" && nj.families.length === WHOLESALE_FAMILIES.length, "an unknown family is a 404 with the code and the family list");
  const page = await fetch(`${U}/wholesale`);
  const html = await page.text();
  ok(page.status === 200 && WHOLESALE_FAMILIES.every((f) => html.includes(`/api/wholesale/v1/${f.id}`)) && ERROR_CODES.every((e) => html.includes(e.code)), "the page renders every family and every error code");
  {
    const fam = await (await fetch(`${U}/api/wholesale/v1/sec-filings`)).json();
    const charging = computeIdx.errorCodes?.charging || "";
    ok(charging.startsWith("A paid call that ends in any status of 400 or above is not charged over x402") && fam.errorCodes?.charging === charging && stripScripts(html, "").includes(`${charging} The refund terms`) && String(computeIdx.errorCodes.refundTerms).endsWith(REFUND_TERMS_PATH), `the served index, a served family and the page state the same rail-scoped sentence and link the refund terms (Tempo push exception ${charging.includes(TEMPO_PUSH_EXCEPTION) ? "included" : "left out"})`);
  }
  ok(!/\$\d/.test(stripScripts(html, "")), "the page types no price");
  const sitemap = await (await fetch(`${U}/sitemap.xml`)).text();
  ok(/\/wholesale</.test(sitemap) || /sitemap-pages/.test(sitemap), "the page is in the sitemap");
} catch (e) {
  ok(false, `boot: ${e?.message || e}`);
} finally {
  await srv?.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
