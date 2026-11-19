#!/usr/bin/env node
// openFDA answers HTTP 404 {error:{code:"NOT_FOUND"}} for a search with zero
// matches. fetch-guard re-labels any upstream 4xx as our 422 and carries the
// upstream code in `upstreamStatus`, so gov-kit's "swallow 404 to an empty
// result" check (`statusCode === 404`) never matched: every no-match query
// threw, and recall-report - which requires 2 of its 3 feeds to read - 502'd
// for any drug name absent from the food and device feeds (most of them).
// Found 2026-08-27 generating the losartan sample. Offline: fetch is stubbed.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
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

  // Only openFDA's own no-match body is "no matches". Any other 404 (an edge
  // page, a truncated body, another error code) is the upstream failing: it
  // is retried once, then answered 502 naming the host, never as count:0.
  const res = (status, text, type = "application/json") => new Response(text, { status, headers: { "content-type": type } });
  const other404 = {
    "a bare 404 with no body": () => res(404, "", "text/plain"),
    "an edge HTML 404": () => res(404, "<html><body>404 Not Found</body></html>", "text/html"),
    "a truncated no-match body": () => res(404, '{"error":{"code":"NOT_FO'),
    "a 404 with another error code": () => res(404, JSON.stringify({ error: { code: "SERVER_ERROR", message: "x" } })),
  };
  for (const slug of ["drug-recalls", "food-recalls", "device-recalls", "drug-adverse-events", "drug-label", "drug-ndc", "device-510k", "device-adverse-events"]) {
    const input = slug === "drug-ndc" ? { ndc: "58151-155" } : slug === "drug-adverse-events" ? { drug: "ibuprofen" } : slug === "drug-label" ? { name: "lipitor" } : slug === "device-510k" ? { applicant: "medtronic" } : slug === "device-adverse-events" ? { brand: "minimed" } : { q: "insulin pump", limit: 5 };
    let reads = 0, err = null, out = null;
    globalThis.fetch = async () => { reads++; return other404["a bare 404 with no body"](); };
    try { out = await bySlug(slug).handler(input); } catch (e) { err = e; }
    ok(out === null && err?.statusCode === 502 && err.upstreamStatus === 404 && err.attribution === "upstream" && /api\.fda\.gov/.test(err.message) && reads >= 2,
      `${slug}: a bare 404 is an upstream failure (502 naming the host, read again once), never count:0 (${err?.statusCode} ${reads} reads ${String(err?.message).slice(0, 60)})`);
  }
  for (const [label, make] of Object.entries(other404)) {
    let reads = 0, err = null, out = null;
    globalThis.fetch = async () => { reads++; return make(); };
    try { out = await bySlug("device-recalls").handler({ q: "insulin pump", limit: 5 }); } catch (e) { err = e; }
    ok(out === null && err?.statusCode === 502 && reads === 2, `device-recalls: ${label} is a 502 after one more read (${err?.statusCode}, ${reads} reads)`);
  }
  // Control: the no-match body is still count:0, in one read.
  {
    let reads = 0;
    globalThis.fetch = async () => { reads++; return res(404, JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } })); };
    const dev = await bySlug("device-recalls").handler({ q: "zzzz-no-such-device", limit: 5 });
    ok(dev.count === 0 && dev.recalls.length === 0 && reads === 1, `control: openFDA's NOT_FOUND body is count:0 and is not read again (${reads} read)`);
  }
  // A 404 that clears on the second read is served.
  {
    let reads = 0;
    globalThis.fetch = async () => (++reads === 1 ? res(404, "", "text/plain") : res(200, JSON.stringify(drugHit)));
    const dev = await bySlug("device-recalls").handler({ q: "insulin pump", limit: 5 });
    ok(dev.count === 1 && reads === 2, `a bare 404 followed by a real answer is served from the second read (${dev.count} row, ${reads} reads)`);
  }
  // A 200 that carries no results list is not "no matches" either.
  {
    let err = null;
    globalThis.fetch = async () => res(200, JSON.stringify({ meta: {} }));
    try { await bySlug("device-recalls").handler({ q: "insulin pump", limit: 5 }); } catch (e) { err = e; }
    ok(err?.statusCode === 502 && /api\.fda\.gov/.test(err.message), `a 200 with no results list is a 502 naming the host (${err?.statusCode})`);
  }
} finally { globalThis.fetch = realFetch; }

// Reason groups: the model's WHY counts are built from exact per-wording
// tallies, so its groups add up to the records shown, and it names an
// impurity by the FDA's own term.
{
  const rows = [
    ...Array.from({ length: 18 }, (_, i) => ({ reason: ["CGMP Deviations- AZIDO Impurity levels observed to be above acceptable limits.", "CGMP Deviations-  azido impurity levels observed to be above acceptable limits", "CGMP Deviations- AZIDO Impurity levels observed to be above acceptable limits ."][i % 3], eventId: String(90000 + (i % 9)) })),
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
    ok(/never name the blocks of this prompt/.test(p), "the prompt keeps its own block names out of the report");
    ok(/an azido impurity is not a nitrosamine/.test(p), "the prompt forbids relabeling an impurity as a class the FDA wording does not name");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
}

console.log(`\nPASS - ${pass} checks (openFDA no-match is an empty result; recall reasons are tallied for the synthesis)`);
