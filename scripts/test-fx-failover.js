#!/usr/bin/env node
// The FX tools read one source, the European Central Bank reference rates,
// name it in every answer, and answer a failed read with a 503 and a retry
// hint rather than rates from another publisher.
//
//   node scripts/test-fx-failover.js          (offline, stubbed fetch)
//
// WHAT IT PINS: no FX handler reads any host but the ECB adapter's, every
// answer carries `source`, and every failed read (a 5xx, a 403 or a 429 from
// the host) is a 503 with Retry-After, never a 502, a 422 or other rates.
//
// It also keeps the timing invariant from 2026-08-03: the ECB host answered in
// ~0.06s warm but 7.8s and 11.6s cold, and prod's self-check (12s budget)
// recorded fx-dashboard as a 504 outage on the inherited 15s timeout. The
// dashboard's read is bounded so its worst case fits inside that budget.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";
import { DATA_TOOLS } from "../src/tools/data-kit.js";
import { ECB_FX_SOURCE, FRANKFURTER_V2 } from "../src/tools/frankfurter.js";
import { ATTRIBUTIONS, attributionTailOf } from "../src/data-attribution.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/tools/macro-kit.js", import.meta.url), "utf8");
const FX = [...MACRO_TOOLS, ...DATA_TOOLS].filter((t) => ["fx-rate", "fx-dashboard", "fx-historical", "fx-timeseries"].includes(t.slug));
const tool = (slug) => FX.find((t) => t.slug === slug);
ok(FX.length === 4, `the four FX tools are found (${FX.map((t) => t.slug).join(", ")})`);

// 1. The dashboard's read carries an explicit, bounded budget.
const callIdx = src.indexOf("ratesUrl({ base: \"USD\", quotes: G10 })");
ok(callIdx >= 0 && /FX_PRIMARY/.test(src.slice(callIdx, callIdx + 200)), "the fx-dashboard read passes an explicit fetch budget rather than inheriting 15s");
const m = src.match(/const FX_PRIMARY = \{([^}]*)\}/);
const budget = m ? m[1] : "";
const ms = Number((budget.match(/timeoutMs:\s*([0-9_]+)/) || [])[1]?.replace(/_/g, "") || 0);
const retries = Number((budget.match(/retries:\s*(\d+)/) || [])[1] ?? NaN);
const SELFCHECK_BUDGET_MS = 12_000;
ok(ms > 0 && retries >= 0 && retries <= 1 && ms * (retries + 1) + 300 * retries < SELFCHECK_BUDGET_MS,
  `every attempt of the dashboard read fits inside the ${SELFCHECK_BUDGET_MS}ms self-check (${retries + 1} x ${ms}ms)`);
// fx-rate and fx-history keep the default budget: a short leash there would
// only turn slow successes into failures.
const others = [...src.matchAll(/await getJson\(ratesUrl\(\{ base: from[^}]*\}\)([^;]*);/g)].map((x) => x[1]);
ok(others.length >= 2 && others.every((a) => !/FX_PRIMARY/.test(a)), `fx-historical and fx-timeseries keep the default budget (${others.length} reads)`);

// 2. One source: no FX handler names a host of its own; every read is built by
//    the ECB adapter, which pins providers=ecb.
for (const t of FX) ok(!/https?:\/\//.test(String(t.handler)), `${t.slug}: the handler names no host of its own (every read goes through ratesUrl)`);
const adapter = readFileSync(new URL("../src/tools/frankfurter.js", import.meta.url), "utf8");
ok(/providers:\s*"ecb"/.test(adapter), "every adapter read is pinned to the ECB provider, not the blended default");

// 3. The ECB is cited: each FX tool carries the "ecb" attribution and its
//    description ends with that sentence.
for (const t of FX) ok(t.attribution === "ecb" && attributionTailOf(t.description) === ATTRIBUTIONS.ecb, `${t.slug}: attribution "ecb", description ends with "${ATTRIBUTIONS.ecb}"`);
ok(/European Central Bank/.test(ECB_FX_SOURCE), `the source field names the European Central Bank (${ECB_FX_SOURCE})`);

// 4. Behavior with a stubbed upstream: answers carry `source`; a failed read
//    is a 503 with a retry hint, and only the ECB adapter's host is read.
const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const hosts = new Set();
let mode = "fail", failStatus = 502;
const rows = (base, quotes) => quotes.map((q, i) => ({ date: "2026-11-13", base, quote: q, rate: 0.5 + i / 10 }));
globalThis.fetch = async (url) => {
  const u = new URL(String(url?.url || url));
  hosts.add(u.host);
  if (mode === "fail") return new Response("upstream down", { status: failStatus, headers: { "content-type": "text/plain" } });
  const base = u.searchParams.get("base"), quotes = (u.searchParams.get("quotes") || "").split(",").filter(Boolean);
  return new Response(JSON.stringify(rows(base, quotes)), { status: 200, headers: { "content-type": "application/json" } });
};
const run = async (slug, input) => { try { return { r: await tool(slug).handler(input) }; } catch (e) { return { e }; } };
try {
  const is503 = (x) => x.e?.statusCode === 503 && x.e?.retryAfter > 0 && /European Central Bank reference rates could not be read/.test(x.e.message) && /Retry/.test(x.e.message);
  let x = await run("fx-rate", { from: "USD", to: "EUR", amount: 100 });
  ok(is503(x), `fx-rate: a failed ECB read answers 503 with a retry hint (got ${x.e?.statusCode} ${x.e?.message || JSON.stringify(x.r)})`);
  for (failStatus of [403, 429]) {
    x = await run("fx-rate", { from: "USD", to: "EUR", amount: 100 });
    ok(is503(x), `fx-rate: an upstream ${failStatus} answers 503 with Retry-After (got ${x.e?.statusCode} retryAfter=${x.e?.retryAfter} ${x.e?.message || JSON.stringify(x.r)})`);
  }
  failStatus = 502;
  x = await run("fx-dashboard", {});
  ok(is503(x), `fx-dashboard: a failed ECB read with no snapshot answers 503 with a retry hint (got ${x.e?.statusCode} ${x.e?.message || JSON.stringify(x.r)})`);
  mode = "ok";
  x = await run("fx-rate", { from: "USD", to: "EUR", amount: 100 });
  ok(x.r?.source === ECB_FX_SOURCE && x.r?.rate === 0.5 && x.r?.result === 50, `fx-rate: the answer names its source (${JSON.stringify(x.r || x.e?.message)})`);
  x = await run("fx-rate", { from: "EUR", to: "EUR", amount: 3 });
  ok(x.r?.source === ECB_FX_SOURCE && x.r?.rate === 1, "fx-rate: the identity answer names its source too");
  x = await run("fx-dashboard", {});
  ok(x.r?.source === ECB_FX_SOURCE && typeof x.r?.rates?.EUR === "number", `fx-dashboard: the answer names its source (${JSON.stringify(x.r || x.e?.message).slice(0, 160)})`);
  // The ECB's reuse terms: the free-availability notice on every answer and
  // before payment (the description), and a computed rate stated as such.
  const { ECB_ATTRIBUTION } = await import("../src/data-attribution.js");
  const { ecbRateBasis } = await import("../src/tools/frankfurter.js");
  ok(/available free of charge at ecb\.europa\.eu/.test(ECB_ATTRIBUTION), "the ECB sentence says the rates are free at ecb.europa.eu");
  x = await run("fx-rate", { from: "USD", to: "JPY", amount: 1 });
  ok(x.r?.credit === ECB_ATTRIBUTION && x.r?.rateBasis === "cross rate computed from ECB euro reference rates", `fx-rate: a pair without the euro is labeled a computed cross rate, with the ECB notice (${JSON.stringify(x.r || x.e?.message).slice(0, 200)})`);
  x = await run("fx-rate", { from: "EUR", to: "USD", amount: 1 });
  ok(x.r?.rateBasis === "ECB euro reference rate as published" && x.r?.credit === ECB_ATTRIBUTION, "fx-rate: a EUR-based pair is the published rate");
  x = await run("fx-dashboard", {});
  ok(x.r?.credit === ECB_ATTRIBUTION && /computed/.test(x.r?.rateBasis || ""), "fx-dashboard: computed rates are labeled, with the ECB notice");
  ok(ecbRateBasis("usd", "eur") === "inverse of the ECB euro reference rate, computed", "an inverted EUR rate is labeled computed");
  for (const t of [...MACRO_TOOLS, ...DATA_TOOLS].filter((d) => d.attribution === "ecb")) ok(t.description.endsWith(ECB_ATTRIBUTION) && t.discovery.output.example.credit === ECB_ATTRIBUTION, `${t.slug}: the notice ends the description (before payment) and the published example`);
  const host = new URL(FRANKFURTER_V2).host;
  ok(hosts.size === 1 && hosts.has(host), `only the ECB adapter's host was read (${[...hosts].join(", ")})`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
