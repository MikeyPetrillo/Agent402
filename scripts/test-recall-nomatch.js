#!/usr/bin/env node
// openFDA answers HTTP 404 {error:{code:"NOT_FOUND"}} for a search with zero
// matches. fetch-guard re-labels any upstream 4xx as our 422 and carries the
// upstream code in `upstreamStatus`, so gov-kit's "swallow 404 to an empty
// result" check (`statusCode === 404`) never matched: every no-match query
// threw, and recall-report - which requires 2 of its 3 feeds to read - 502'd
// for any drug name absent from the food and device feeds (most of them).
// Found 2026-08-27 generating the losartan sample. Offline: fetch is stubbed.
import { GOV_TOOLS } from "../src/tools/gov-kit.js";
import { probeRecalls } from "../src/tools/recall-report-kit.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };
const bySlug = (s) => GOV_TOOLS.find((t) => t.slug === s);

const drugHit = { meta: { results: { total: 1 } }, results: [{ recalling_firm: "Example Pharma", classification: "Class II", status: "Ongoing", reason_for_recall: "Presence of an impurity", product_description: "Losartan Potassium Tablets", distribution_pattern: "Nationwide", recall_initiation_date: "20240507", recall_number: "D-0001-2024", event_id: "1", product_quantity: "100 bottles", voluntary_mandated: "Voluntary: Firm initiated" }] };
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url); calls.push(u);
  const body = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  if (u.includes("/drug/enforcement.json")) return body(200, drugHit);
  // food + device: openFDA's exact no-match answer
  return body(404, { error: { code: "NOT_FOUND", message: "No matches found!" } });
};

try {
  const food = await bySlug("food-recalls").handler({ q: "losartan", limit: 5 });
  ok(food.count === 0 && Array.isArray(food.recalls) && food.recalls.length === 0 && food.total === 0, "a feed tool answers count:0 on openFDA's 404 no-match (not a throw)");
  const drug = await bySlug("drug-recalls").handler({ q: "losartan", limit: 5 });
  ok(drug.count === 1 && drug.recalls[0].recallNumber === "D-0001-2024", "a feed with matches still returns them");

  const probe = await probeRecalls("losartan", { perFeed: 5 });
  ok(probe.status.drug === "ok" && probe.status.food === "ok" && probe.status.device === "ok", `all three feeds read ok (${JSON.stringify(probe.status)})`);
  ok(probe.items.length === 1 && probe.items[0].kind === "drug", "the composite carries the drug row and no phantom failures");

  // A real upstream outage (5xx) is still a failure of that feed.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/drug/enforcement.json")) return new Response(JSON.stringify(drugHit), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("upstream down", { status: 503, headers: { "content-type": "text/plain" } });
  };
  let threw = null;
  try { await probeRecalls("losartan", { perFeed: 5 }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502 && /Could not read enough/.test(threw.message), "two feeds down (5xx) still refuses the report, uncharged (502)");
} finally { globalThis.fetch = realFetch; }

console.log(`\nPASS - ${pass} checks (openFDA no-match is an empty result, not an outage)`);
