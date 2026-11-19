#!/usr/bin/env node
// The wholesale surface (src/wholesale.js, GET /api/wholesale/v1[/<family>],
// /wholesale) and the stable error codes (src/stable-error-code.js):
//   - the v1 field set and the error code table are pinned (a v1 field or
//     code may be added, never removed or renamed);
//   - reliability is bounded and honest: a rate needs the minimum sample,
//     reads only outside lanes inside 24 hours, rounds down, lies in [0, 1];
//     latency rounds up; volume is a band, never a count;
//   - on a FREE_MODE boot: every listed price is /api/pricing's own, no
//     listed tool is model-backed or market data, a family's rates move with
//     real calls, a tool error carries its errorCode, the page renders.
//   node scripts/test-wholesale.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { ERROR_CODES, stableErrorCode, errorCodeField } from "../src/stable-error-code.js";
import { reliabilityOf, outsideCounts, callsBand, toolRow, wholesaleIndex, wholesaleFamily, WHOLESALE_FAMILIES, WHOLESALE_MIN_SAMPLE } from "../src/wholesale.js";
import { TOOL_CLASSES, createToolFailureMonitor } from "../src/tool-failure-monitor.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// ---- error codes: the v1 table only grows
const V1_CODES = { 400: "invalid_input", 402: "payment_required", 404: "not_found", 409: "conflict", 410: "retired", 413: "input_too_large", 415: "unsupported_media_type", 422: "input_not_resolvable", 429: "rate_limited", 499: "client_closed", 500: "internal_error", 502: "upstream_error", 503: "unavailable", 504: "timeout" };
for (const [s, c] of Object.entries(V1_CODES)) ok(stableErrorCode(Number(s)) === c && ERROR_CODES.some((e) => e.status === Number(s) && e.code === c), `status ${s} reads ${c}`);
ok(new Set(ERROR_CODES.map((e) => e.code)).size === ERROR_CODES.length && ERROR_CODES.every((e) => /^[a-z_]+$/.test(e.code) && e.meaning && /^[a-z-]+$/.test(e.retry)), "codes are unique snake_case words, each with a meaning and a retry verb");
ok(stableErrorCode(418) === "invalid_input" && stableErrorCode(507) === "internal_error" && stableErrorCode(200) === null && stableErrorCode("x") === null, "an unlisted status reads its class; under 400 reads none");
ok(JSON.stringify(errorCodeField(200)) === "{}" && errorCodeField(504).errorCode === "timeout", "the field spreads to nothing under 400");

// ---- reliability, pure
const now = Date.parse("2026-11-18T12:00:00Z");
const B = (msAgo) => Math.floor((now - msAgo) / (5 * 60_000));
const lane = (o) => TOOL_CLASSES.map((k) => o[k] || 0);
const rows = {
  [B(60_000)]: { o: lane({ ok: 30, fail: 2, timeout: 1, buyer: 50, payment: 9, gone: 4, shed: 7 }), s: lane({ ok: 0, fail: 500 }), f: lane({ ok: 5 }) },
  [B(25 * 3600_000)]: { o: lane({ fail: 1000 }), s: lane({}), f: lane({}) }, // outside the window
};
const c = outsideCounts(rows, now);
ok(c.ok === 35 && c.fail === 2 && c.timeout === 1 && c.buyer === 50, "counts read the outside and free lanes inside 24 hours only (synthetic and old buckets left out)");
const r = reliabilityOf(rows, { window: 40, totalMs: { p50: 101.2, p95: 999.1 } }, now);
ok(r.successRate === Math.floor((35 / 38) * 1000) / 1000 && r.successRate <= 35 / 38, `success rate is ok over ok+fail+timeout, rounded down (${r.successRate})`);
ok(r.calls === "20-99" && !Object.values(r).some((v) => v === 38), "volume is a band, never the count");
ok(r.latencyMs.p50 === 110 && r.latencyMs.p95 === 1000, "latency rounds up to 10 ms");
const thin = reliabilityOf({ [B(1000)]: { o: lane({ ok: WHOLESALE_MIN_SAMPLE - 1 }), s: lane({}), f: lane({}) } }, { window: 5, totalMs: { p50: 1, p95: 2 } }, now);
ok(thin.successRate === null && /fewer than/.test(thin.successRateNote) && thin.latencyMs === null && /fewer than/.test(thin.latencyNote) && thin.calls === `<${WHOLESALE_MIN_SAMPLE}`, "under the minimum sample: null with the reason, never a rate");
const allFail = reliabilityOf({ [B(1000)]: { o: lane({ fail: 25 }), s: lane({}), f: lane({}) } }, null, now);
ok(allFail.successRate === 0 && allFail.latencyMs === null, "every call failing reads 0, not null");
const allBuyer = reliabilityOf({ [B(1000)]: { o: lane({ buyer: 500 }), s: lane({}), f: lane({}) } }, null, now);
ok(allBuyer.successRate === null && allBuyer.calls === "<20", "caller mistakes count neither way");
ok(callsBand(19) === "<20" && callsBand(20) === "20-99" && callsBand(100) === "100-999" && callsBand(5000) === "1000+", "volume bands");
for (let i = 0; i < 200; i++) {
  const o = { ok: Math.floor(Math.random() * 50), fail: Math.floor(Math.random() * 50), timeout: Math.floor(Math.random() * 5) };
  const x = reliabilityOf({ [B(1000)]: { o: lane(o), s: lane({}), f: lane({}) } }, null, now);
  if (x.successRate !== null && !(x.successRate >= 0 && x.successRate <= 1 && x.successRate <= o.ok / (o.ok + o.fail + o.timeout))) { ok(false, `rate out of bounds for ${JSON.stringify(o)}: ${x.successRate}`); break; }
  if (i === 199) ok(true, "200 random samples: every rate in [0, 1] and never above the true share");
}

// ---- the real monitor's rows read the same way
const mon = createToolFailureMonitor({ now: () => now, replicaId: "test" });
for (let i = 0; i < 24; i++) mon.noteTool("probe-tool", 200, { at: now - 1000 });
mon.noteTool("probe-tool", 502, { at: now - 1000 });
for (let i = 0; i < 40; i++) mon.noteTool("probe-tool", 500, { synthetic: true, at: now - 1000 });
mon.noteTool("probe-tool", 400, { at: now - 1000 });
const real = reliabilityOf(mon.merged(now).tools["probe-tool"], null, now);
ok(real.successRate === 0.96 && real.calls === "20-99", `the failure monitor's own rows give 24 of 25 (${real.successRate}), our probes and caller mistakes left out`);

// ---- field contract (v1 only grows)
const ROW_KEYS = ["slug", "name", "method", "path", "url", "price", "modelBacked", "docs", "reliability"];
const fakeCatalog = {
  "GET /api/a": { slug: "edgar-filings", name: "A", price: "$0.005" },
  "POST /api/b": { slug: "filings-brief", name: "B", price: "$0.027", quoteRange: { minUsd: 0.027, maxUsd: 1.08 } },
  "POST /api/m": { slug: "edgar-search", name: "M", price: "$0.005", modelBacked: true },
  "GET /api/c": { slug: "hash", name: "C", price: "$0.001" },
};
const ctx = { catalog: fakeCatalog, powSlugs: new Set(["hash"]), baseUrl: "https://x.test", toolRows: {}, timingByRoute: new Map(), now };
const row = toolRow("POST /api/b", fakeCatalog["POST /api/b"], { baseUrl: "https://x.test", rows: {}, timing: null, now });
ok(ROW_KEYS.every((k) => k in row), `a tool row carries every v1 field (${ROW_KEYS.join(", ")})`);
ok(row.price.text === "$0.027" && row.price.usd === 0.027 && row.price.perRequest.maxUsd === 1.08, "the price is the catalog's own, with the per-request range when quoted");
const idx = wholesaleIndex(ctx);
for (const k of ["version", "stability", "pricing", "errorCodes", "reliabilityDefinition", "docs", "asOf", "families", "notOffered"]) ok(k in idx, `the index carries ${k}`);
ok(idx.version === "v1" && /no wholesale discount/.test(idx.pricing), "v1, and the pricing sentence says no discount");
const fam = wholesaleFamily("sec-filings", ctx);
ok(fam.tools.map((t) => t.slug).join(",") === "edgar-filings,filings-brief", "a family lists its tools, never a model-backed one");
ok(wholesaleFamily("compute", ctx).tools.map((t) => t.slug).join(",") === "hash", "compute is the proof-of-work set");
ok(wholesaleFamily("nope", ctx) === null, "an unknown family reads null");
ok(WHOLESALE_FAMILIES.every((f) => ["public-domain", "cc-by-4.0", "own-computation"].includes(f.redistribution)), "every family's basis is public domain, CC BY 4.0 or our own computation");

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
  const probe = [...FREE_TIER_SLUGS].map((s) => bySlug.get(s)).find((e) => e && e.method === "GET" && (openapi.paths[e.path]?.get?.parameters || []).some((p) => p.example !== undefined));
  const params = (openapi.paths[probe.path].get.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => `${p.name}=${encodeURIComponent(p.example)}`).join("&");
  let good = 0;
  for (let i = 0; i < 25; i++) { const res = await fetch(`${U}${probe.path}?${params}`); if (res.status < 400) good++; await res.arrayBuffer(); }
  ok(good === 25, `${probe.slug}: its own example answered 25 times`);
  const computeIdx = await (await fetch(`${U}/api/wholesale/v1`)).json();
  ok(computeIdx.families.length === WHOLESALE_FAMILIES.length && computeIdx.families.every((f) => f.tools > 0), `the index lists every family with tools (${computeIdx.families.map((f) => `${f.id} ${f.tools}`).join(", ")})`);
  const all = [];
  for (const f of computeIdx.families) {
    const j = await (await fetch(`${U}/api/wholesale/v1/${f.id}`)).json();
    ok(j.version === "v1" && j.family.id === f.id && j.count === j.tools.length && j.count === f.tools, `${f.id}: v1 answer, count matches rows and the index (${j.count})`);
    all.push(...j.tools.map((t) => ({ ...t, family: f.id })));
  }
  const measured = all.find((t) => t.slug === probe.slug);
  // FREE_MODE counts no outcomes (the failure monitor's lane is the paid
  // dispatcher's), so the rate stays null with its reason; timing is counted.
  ok(measured && measured.reliability.latencyMs && measured.reliability.latencyMs.p50 > 0 && measured.reliability.latencyMs.p95 >= measured.reliability.latencyMs.p50, `${probe.slug}: the timed calls show as latency (${JSON.stringify(measured?.reliability?.latencyMs)})`);
  ok(measured && measured.reliability.successRate === null && /fewer than/.test(measured.reliability.successRateNote), "with no counted outcomes the rate is null with its reason, never a guess");
  ok(all.every((t) => bySlug.get(t.slug)?.price === t.price.text), "every listed price is /api/pricing's own price (no discount, no drift)");
  ok(all.every((t) => t.modelBacked === false && bySlug.get(t.slug)?.modelBacked !== true), "no listed tool is model-backed");
  ok(!all.some((t) => t.family !== "compute" && /coingecko|databento|brave/i.test(bySlug.get(t.slug)?.description || "")), "no vendor-licensed market data or search results outside the compute family");
  ok(!all.some((t) => t.slug === "token-diligence" || t.slug.startsWith("crypto-") || t.slug.startsWith("coin-") || t.slug.startsWith("stock-")), "the CoinGecko-backed and stock tools are not offered");
  ok(all.some((t) => t.slug === "weather-risk-brief" && t.price.perRequest) && all.some((t) => t.slug === "filings-brief" && t.price.perRequest), "the bundle products are listed with their per-request range");
  ok(all.every((t) => t.reliability.successRate === null || (t.reliability.successRate >= 0 && t.reliability.successRate <= 1)), "every rate is null or in [0, 1]");
  const err = await fetch(`${U}/api/edgar-filings`);
  const ej = await err.json();
  ok(err.status === 400 && ej.errorCode === "invalid_input" && typeof ej.error === "string", "a tool error answer carries its errorCode beside the message");
  const nf = await fetch(`${U}/api/wholesale/v1/nope`);
  const nj = await nf.json();
  ok(nf.status === 404 && nj.errorCode === "not_found" && nj.families.length === WHOLESALE_FAMILIES.length, "an unknown family is a 404 with the code and the family list");
  const page = await fetch(`${U}/wholesale`);
  const html = await page.text();
  ok(page.status === 200 && WHOLESALE_FAMILIES.every((f) => html.includes(`/api/wholesale/v1/${f.id}`)) && ERROR_CODES.every((e) => html.includes(e.code)), "the page renders every family and every error code");
  ok(!/\$\d/.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "the page types no price");
  const sitemap = await (await fetch(`${U}/sitemap.xml`)).text();
  ok(/\/wholesale</.test(sitemap) || /sitemap-pages/.test(sitemap), "the page is in the sitemap");
} catch (e) {
  ok(false, `boot: ${e?.message || e}`);
} finally {
  await srv?.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
