#!/usr/bin/env node
// openFDA answers HTTP 404 {error:{code:"NOT_FOUND"}} for a search with zero
// matches. fetch-guard re-labels any upstream 4xx as our 422 and carries the
// upstream code in `upstreamStatus`, so gov-kit's "swallow 404 to an empty
// result" check (`statusCode === 404`) never matched: every no-match query
// threw, and recall-report - which requires 2 of its 3 feeds to read - 502'd
// for any drug name absent from the food and device feeds (most of them).
// Found 2026-08-27 generating the losartan sample. Offline: fetch is stubbed.
import { GOV_TOOLS } from "../src/tools/gov-kit.js";
import { probeRecalls, reasonGroups, makeRecallHandler } from "../src/tools/recall-report-kit.js";

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

// Reason groups: the model's WHY counts are built from exact per-wording
// tallies, so its groups add up to the records shown, and it names an
// impurity by the FDA's own term.
{
  const rows = [
    ...Array.from({ length: 18 }, (_, i) => ({ reason: i % 2 ? "CGMP Deviations- AZIDO Impurity levels observed to be above acceptable limits." : "CGMP Deviations-  azido impurity levels observed to be above acceptable limits.", eventId: String(90000 + (i % 9)) })),
    { reason: "Presence of foreign substance: plastic-like substance.", eventId: "94592" },
    { reason: "Presence of Foreign Substance: Presence of a small piece of blue plastic embedded in the tablet.", eventId: "92584" },
  ];
  const g = reasonGroups(rows);
  ok(g.length === 3, `identical wording (case and spacing folded) is one group (${g.length} groups)`);
  ok(g[0].records === 18 && g[0].events === 9, "the largest group comes first with its record and event counts");
  ok(g.reduce((a, x) => a + x.records, 0) === rows.length, "the groups add up to the records shown");
}
{
  const firms = ["Firm A", "Firm B"];
  const results = Array.from({ length: 20 }, (_, i) => ({
    recalling_firm: firms[i % 2], classification: "Class II", status: i ? "Terminated" : "Ongoing",
    reason_for_recall: i < 18 ? "CGMP Deviations- AZIDO Impurity levels observed to be above acceptable limits." : `Presence of foreign substance ${i}.`,
    product_description: "Losartan Potassium Tablets", distribution_pattern: "Nationwide",
    recall_initiation_date: `2022${String(1 + (i % 12)).padStart(2, "0")}10`, recall_number: `D-${1000 + i}-2022`, event_id: String(90000 + (i % 11)),
  }));
  const prompts = [];
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-placeholder";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (u.includes("openrouter")) {
      prompts.push(JSON.parse(init.body).messages[0].content);
      return body(200, { choices: [{ message: { content: "## SNAPSHOT\n\nTwenty records." }, finish_reason: "stop" }], usage: { cost: 0 } });
    }
    if (u.includes("/drug/enforcement.json")) return body(200, { meta: { results: { total: 117 } }, results });
    return body(404, { error: { code: "NOT_FOUND", message: "No matches found!" } });
  };
  try {
    const out = await makeRecallHandler("recall-report")({ query: "losartan" });
    ok(/^# FDA Recall Report: losartan/.test(out.report), "the handler ships a report on the stubbed feeds");
    const p = prompts[0] || "";
    ok(/=== REASONS \(shown records, grouped by identical FDA wording; 20 records in all\) ===/.test(p), "the prompt carries the REASONS tally for the records shown");
    ok(p.includes('- "CGMP Deviations- AZIDO Impurity levels observed to be above acceptable limits.": 18 records, 11 events'), "each wording carries its exact record and event counts");
    ok(/the groups must add up to the records shown/.test(p), "the prompt requires the WHY groups to add up");
    ok(/an azido impurity is not a nitrosamine/.test(p), "the prompt forbids relabeling an impurity as a class the FDA wording does not name");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
}

console.log(`\nPASS - ${pass} checks (openFDA no-match is an empty result; recall reasons are tallied for the synthesis)`);
