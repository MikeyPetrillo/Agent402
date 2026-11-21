#!/usr/bin/env node
// openFDA reference tools: drug-label, drug-ndc, device-510k,
// device-adverse-events, drug-shortages, drug-orange-book (src/tools/gov-kit.js).
//
//   node scripts/test-openfda-reference.js            (offline, stubbed fetch)
//   OPENFDA_LIVE=1 node scripts/test-openfda-reference.js   (also runs each
//                                                     tool's example live)
//
// Pins: the upstream query each tool sends, the shaped rows, the partial-answer
// fields (a capped list never reads as complete), bounded label sections and
// MDR excerpts, openFDA's 404 no-match read as an empty answer, a 5xx kept a
// failure, input validation before any egress, and that GMDN nomenclature
// (licensed content, excluded by openFDA's terms) and personal fields
// (510(k) contacts, MDR reporters) never reach an answer even when the
// upstream row carries them.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
import { GOV_TOOLS, labelSection, MDR_EXCERPT_CHARS } from "../src/tools/gov-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (s) => GOV_TOOLS.find((t) => t.slug === s);
const h = (s) => tool(s).handler;
async function throws(p, status, label) {
  try { await p; fail++; console.error(`FAIL - ${label} (did not throw)`); }
  catch (e) { ok(e.statusCode === status, `${label} -> ${e.statusCode} (${e.message.slice(0, 90)})`); }
}

const LONG = "W".repeat(5000);
const LABEL = {
  set_id: "a60cc18b-0631-4cf0-b021-9f52224ece65", effective_time: "20240415", version: "8",
  boxed_warning: ["WARNING: EXAMPLE BOXED TEXT"],
  indications_and_usage: ["1 INDICATIONS AND USAGE  LIPITOR is indicated ..."],
  dosage_and_administration: ["2 DOSAGE", " AND ADMINISTRATION"],
  warnings_and_cautions: [LONG],
  openfda: { brand_name: ["Lipitor"], generic_name: ["ATORVASTATIN CALCIUM"], manufacturer_name: ["Viatris Specialty LLC"], product_type: ["HUMAN PRESCRIPTION DRUG"], route: ["ORAL"], application_number: ["NDA020702"], product_ndc: Array.from({ length: 12 }, (_, k) => `58151-${100 + k}`) },
};
const NDC = { product_ndc: "58151-155", generic_name: "atorvastatin calcium", labeler_name: "Viatris Specialty LLC", brand_name: "Lipitor", active_ingredients: [{ name: "ATORVASTATIN CALCIUM TRIHYDRATE", strength: "10 mg/1" }], finished: true, packaging: [{ package_ndc: "58151-155-77", description: "90 TABLET, FILM COATED in 1 BOTTLE (58151-155-77)", marketing_start_date: "20240501", sample: false }], listing_expiration_date: "20271231", marketing_category: "NDA", dosage_form: "TABLET, FILM COATED", product_type: "HUMAN PRESCRIPTION DRUG", route: ["ORAL"], marketing_start_date: "20240501", application_number: "NDA020702", pharm_class: ["HMG-CoA Reductase Inhibitor [EPC]"] };
const K510 = { k_number: "K233210", applicant: "ZetrOZ Systems, LLC", device_name: "sam CS Long Duration Ultrasound Device", product_code: "PFW", decision_date: "2023-10-25", decision_description: "Substantially Equivalent", decision_code: "SESE", date_received: "2023-09-28", clearance_type: "Special", statement_or_summary: "Summary", third_party_flag: "N", city: "Trumbull", state: "CT", country_code: "US",
  contact: "Jane Example", address_1: "56 Quarry Rd.", zip_code: "06611",
  openfda: { device_name: "Stationary Ultrasonic Diathermy Device", device_class: "2", regulation_number: "890.5300", medical_specialty_description: "Physical Medicine", gmdn_terms: [{ name: "GMDN-SHOULD-NOT-APPEAR", definition: "x" }] } };
const NARRATIVE = "IT WAS REPORTED THAT ".repeat(40);
const MDR = { report_number: "2032227-2026-1", mdr_report_key: "50955055", date_received: "20260930", date_of_event: "20260914", event_type: "Malfunction", product_problems: ["Wireless Communication Problem"], manufacturer_name: "MEDTRONIC MINIMED",
  manufacturer_contact_f_name: "PRIVATE", manufacturer_contact_l_name: "PERSON", manufacturer_contact_phone_number: "5551234",
  device: [{ brand_name: "Example Pump", generic_name: "INSULIN PUMP", manufacturer_d_name: "MEDTRONIC MINIMED", device_report_product_code: "LZG", openfda: { device_class: "2", device_name: "Pump, Infusion, Insulin" }, gmdn_term: "GMDN-SHOULD-NOT-APPEAR" }],
  mdr_text: [{ text_type_code: "Additional Manufacturer Narrative", text: "manufacturer note" }, { text_type_code: "Description of Event or Problem", text: NARRATIVE }] };

// A drug shortage row as openFDA serves it: the company phone line rides in
// contact_info and is never copied (a shortage row names the product, not a person).
const SHORTAGE = { update_type: "Reverified", initial_posting_date: "04/10/2020", package_ndc: "0409-4276-01", generic_name: "Lidocaine Hydrochloride Injection", contact_info: "844-646-4398", availability: "Limited Availability", update_date: "11/19/2026", therapeutic_category: ["Anesthesia"], dosage_form: "Injection", presentation: "Lidocaine, Injection, 1% (NDC 0409-4276-01)", company_name: "Pfizer Inc.", status: "Current", shortage_reason: "Demand increase for the drug", related_info: "Next delivery expected in December",
  openfda: { brand_name: ["XYLOCAINE"], generic_name: ["LIDOCAINE HYDROCHLORIDE"], application_number: ["NDA006488"], manufacturer_name: ["Hospira, Inc."], route: ["INFILTRATION"] } };
// An Orange Book product as openFDA serves it: patents and exclusivity codes beside one product.
const ORANGE = { approval_date: "20241209", product_number: "004",
  patents: [{ patent_number: "8536122", expiration_date: "20260320", drug_substance_flag: true, drug_product_flag: true, patent_use_code: "U-2628", patent_submission_date: "20250506" }, ...Array.from({ length: 30 }, (_, k) => ({ patent_number: String(11000000 + k), expiration_date: "20340502", drug_product_flag: true }))],
  exclusivity: [{ exclusivity_code: "I-976", exclusivity_expiration_date: "20281017" }],
  products: [{ active_ingredients: [{ name: "SEMAGLUTIDE", strength: "1.5MG" }], brand_name: "OZEMPIC", application_name: "NOVO", application_type: "N", application_number: "213051", therapeutic_equivalence_codes: ["AB"], reference_listed_drug: true, reference_standard: true, marketing_status: "HUMAN PRESCRIPTION DRUG", application_full_name: "NOVO NORDISK INC", dosage_form: "TABLET", route: "ORAL" }] };

const sent = [];
let mode = "ok";
const realFetch = globalThis.fetch;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  sent.push(u);
  if (mode === "nomatch") return json(404, { error: { code: "NOT_FOUND", message: "No matches found!" } });
  if (mode === "down") return json(500, { error: "boom" });
  const meta = (total) => ({ disclaimer: "x", results: { skip: 0, limit: 1, total } });
  if (u.pathname === "/drug/label.json") return json(200, { meta: meta(259), results: [LABEL] });
  if (u.pathname === "/drug/ndc.json") return json(200, { meta: meta(1), results: [NDC] });
  if (u.pathname === "/device/510k.json") return json(200, { meta: meta(1587), results: [K510] });
  if (u.pathname === "/drug/shortages.json") return json(200, { meta: meta(87), results: [SHORTAGE] });
  if (u.pathname === "/drug/orangebook.json") return json(200, { meta: meta(10), results: [ORANGE] });
  if (u.pathname === "/device/event.json") {
    const count = u.searchParams.get("count");
    if (count === "event_type.exact") return json(200, { meta: {}, results: [{ term: "Malfunction", count: 900 }, { term: "Injury", count: 90 }, { term: "", count: 2 }] });
    if (count === "product_problems.exact") return json(200, { meta: {}, results: [{ term: "Pumping Stopped", count: 400 }] });
    return json(200, { meta: meta(992), results: [MDR, MDR, MDR] });
  }
  throw new Error(`unexpected egress ${u}`);
};
const last = () => sent[sent.length - 1];
const search = (u) => u.searchParams.get("search");

try {
  // ---- catalog envelope ------------------------------------------------------
  for (const s of ["drug-label", "drug-ndc", "device-510k", "device-adverse-events", "drug-shortages", "drug-orange-book"]) {
    const t = tool(s);
    ok(t && t.price === "$0.004" && t.category === "data" && t.route === `GET /api/${s}` && t.discovery?.input && t.discovery?.inputSchema && t.discovery?.output?.example, `${s}: tool shape, priced like the kit's other openFDA reads`);
    ok(!/—/.test(t.description), `${s}: no em dash in the description`);
  }

  // ---- validation: no egress -------------------------------------------------
  sent.length = 0;
  await throws(h("drug-label")({}), 400, "drug-label: name or ndc required");
  await throws(h("drug-label")({ ndc: "58151155" }), 400, "drug-label: unhyphenated NDC refused");
  await throws(h("drug-ndc")({ ndc: "abc" }), 400, "drug-ndc: malformed NDC refused");
  await throws(h("device-510k")({}), 400, "device-510k: a filter is required");
  await throws(h("device-510k")({ kNumber: "123" }), 400, "device-510k: K number shape");
  await throws(h("device-510k")({ productCode: "LZ1" }), 400, "device-510k: product code shape");
  await throws(h("device-adverse-events")({}), 400, "device-adverse-events: a filter is required");
  await throws(h("device-adverse-events")({ device: "pump", since: "2026-13-45" }), 400, "device-adverse-events: since must be a date");
  await throws(h("drug-label")({ name: "x".repeat(101) }), 400, "drug-label: over-long term refused");
  await throws(h("drug-shortages")({}), 400, "drug-shortages: a filter is required");
  await throws(h("drug-shortages")({ name: "lidocaine", status: "sometimes" }), 400, "drug-shortages: status must be a listed value");
  await throws(h("drug-orange-book")({}), 400, "drug-orange-book: name or applicationNumber required");
  await throws(h("drug-orange-book")({ applicationNumber: "NDA-12" }), 400, "drug-orange-book: application number shape");
  ok(sent.length === 0, "validation failures made no upstream request");

  // ---- drug-label ------------------------------------------------------------
  let r = await h("drug-label")({ name: 'lip"itor' });
  ok(last().pathname === "/drug/label.json" && search(last()) === 'openfda.brand_name:"lip itor" OR openfda.generic_name:"lip itor"', `drug-label: brand OR generic phrase, quote stripped (${search(last())})`);
  ok(last().searchParams.get("sort") === "effective_time:desc" && last().searchParams.get("limit") === "1", "drug-label: newest label first, default one");
  const L = r.labels[0];
  ok(L.brandName === "Lipitor" && L.genericName === "ATORVASTATIN CALCIUM" && L.applicationNumber === "NDA020702" && L.effectiveDate === "2024-04-15", "drug-label: identity fields");
  ok(L.productNdc.length === 10 && L.productNdcCount === 12, "drug-label: NDC list capped at 10 with the full count beside it");
  ok(L.sections.boxedWarning?.text === "WARNING: EXAMPLE BOXED TEXT" && L.sections.boxedWarning.truncated === false, "drug-label: boxed warning carried");
  ok(L.sections.dosage?.text === "2 DOSAGE AND ADMINISTRATION", "drug-label: SPL array parts joined, whitespace collapsed");
  ok(L.sections.warnings.text.length === 1500 && L.sections.warnings.chars === 5000 && L.sections.warnings.truncated === true, "drug-label: a long section is cut at maxChars and says so");
  ok(L.sections.contraindications === null, "drug-label: an absent section reads null, never an empty string");
  ok(r.returned === 1 && r.matched === 259 && r.complete === false && r.truncated === true, "drug-label: partial fields say 1 of 259 matching labels");
  ok(/not medical advice/.test(r.disclaimer) && /public domain/.test(r.source), "drug-label: disclaimer + source");
  r = await h("drug-label")({ ndc: "58151-155-77", limit: 9, maxChars: 99999 });
  ok(search(last()) === 'openfda.product_ndc:"58151-155-77" OR openfda.package_ndc:"58151-155-77"', "drug-label: an NDC searches product and package NDCs");
  ok(last().searchParams.get("limit") === "5" && r.requestedExceededMax === true && r.maxChars === 6000, "drug-label: limit clamped to 5 and the clamp is stated; maxChars capped at 6000");
  ok(labelSection(["a", null, "b"], 10).text === "a b" && labelSection([], 10) === null, "labelSection: joins parts, empty is null");

  // ---- drug-ndc --------------------------------------------------------------
  r = await h("drug-ndc")({ ndc: "58151-155" });
  ok(last().pathname === "/drug/ndc.json" && search(last()) === 'product_ndc:"58151-155" OR packaging.package_ndc:"58151-155"', "drug-ndc: product or package NDC");
  const P = r.products[0];
  ok(P.productNdc === "58151-155" && P.labeler === "Viatris Specialty LLC" && P.activeIngredients[0].strength === "10 mg/1" && P.packaging[0].packageNdc === "58151-155-77" && P.marketingStartDate === "2024-05-01" && P.listingExpirationDate === "2027-12-31", "drug-ndc: product, ingredients, packaging, dates");
  ok(r.complete === true && r.matched === 1, "drug-ndc: a complete answer says complete");
  await h("drug-ndc")({ name: "lipitor" });
  ok(search(last()) === 'brand_name:"lipitor" OR generic_name:"lipitor"', "drug-ndc: name searches brand or generic");

  // ---- device-510k -----------------------------------------------------------
  r = await h("device-510k")({ applicant: "zetroz", productCode: "pfw", limit: 3 });
  ok(last().pathname === "/device/510k.json" && search(last()) === 'product_code:"PFW" AND applicant:"zetroz"' && last().searchParams.get("sort") === "decision_date:desc", `device-510k: filters AND-joined, newest decision first (${search(last())})`);
  const K = r.clearances[0];
  ok(K.kNumber === "K233210" && K.decision === "Substantially Equivalent" && K.deviceClass === "2" && K.classificationName === "Stationary Ultrasonic Diathermy Device" && K.thirdPartyReview === false && /pmn\.cfm\?ID=K233210$/.test(K.url), "device-510k: decision, class, FDA classification name, record link");
  const kText = JSON.stringify(r);
  ok(!kText.includes("Jane Example") && !kText.includes("Quarry") && !kText.includes("06611"), "device-510k: the contact person and street address never ride through");
  ok(!/gmdn/i.test(kText), "device-510k: GMDN content never rides through");
  ok(r.matched === 1587 && r.returned === 1 && r.truncated === true, "device-510k: partial fields");
  await h("device-510k")({ kNumber: "k233210" });
  ok(search(last()) === 'k_number:"K233210"', "device-510k: K number upper-cased");

  // ---- drug-shortages ---------------------------------------------------------
  r = await h("drug-shortages")({ name: "lidocaine", status: "current", limit: 3 });
  ok(last().pathname === "/drug/shortages.json" && search(last()) === '(generic_name:"lidocaine" OR openfda.brand_name:"lidocaine" OR openfda.generic_name:"lidocaine") AND status:"Current"' && last().searchParams.get("sort") === "update_date:desc" && last().searchParams.get("limit") === "3", `drug-shortages: name across generic and brand, status filter, newest update first (${search(last())})`);
  const S = r.shortages[0];
  ok(S.genericName === "Lidocaine Hydrochloride Injection" && S.status === "Current" && S.availability === "Limited Availability" && S.company === "Pfizer Inc." && S.packageNdc === "0409-4276-01" && S.brandNames[0] === "XYLOCAINE" && S.therapeuticCategories[0] === "Anesthesia" && S.reason === "Demand increase for the drug", "drug-shortages: product, status, availability, company, reason");
  ok(S.updateDate === "2026-11-19" && S.initialPostingDate === "2020-04-10" && S.discontinuedDate === null, "drug-shortages: US dates read as ISO days, an absent date is null");
  ok(!JSON.stringify(r).includes("844-646-4398"), "drug-shortages: the company phone line never rides through");
  ok(r.matched === 87 && r.returned === 1 && r.complete === false && /public domain/.test(r.source) && /not medical advice/.test(r.disclaimer), "drug-shortages: partial fields, disclaimer and source");
  await h("drug-shortages")({ category: "Oncology", status: "to be discontinued" });
  ok(search(last()) === 'therapeutic_category:"Oncology" AND status:"To Be Discontinued"', `drug-shortages: category alone, status spelled as FDA lists it (${search(last())})`);

  // ---- drug-orange-book --------------------------------------------------------
  r = await h("drug-orange-book")({ name: "ozempic", limit: 2 });
  ok(last().pathname === "/drug/orangebook.json" && search(last()) === 'products.brand_name:"ozempic" OR products.active_ingredients.name:"ozempic"' && last().searchParams.get("sort") === "approval_date:desc", `drug-orange-book: brand or ingredient, newest approval first (${search(last())})`);
  const O = r.products[0];
  ok(O.brandName === "OZEMPIC" && O.applicationNumber === "N213051" && O.applicationType === "NDA" && O.productNumber === "004" && O.applicant === "NOVO NORDISK INC" && O.approvalDate === "2024-12-09" && O.referenceListedDrug === true && O.teCodes[0] === "AB" && O.activeIngredients[0].strength === "1.5MG", "drug-orange-book: product identity, application, TE code, RLD");
  ok(O.patents.length === 20 && O.patentCount === 31 && O.patents[0].patentNumber === "8536122" && O.patents[0].expirationDate === "2026-03-20" && O.patents[0].drugSubstance === true && O.patents[0].useCode === "U-2628", "drug-orange-book: patents shaped, capped at 20 with the full count beside them");
  ok(O.exclusivities[0].code === "I-976" && O.exclusivities[0].expirationDate === "2028-10-17", "drug-orange-book: exclusivity codes and dates");
  ok(r.matched === 10 && r.returned === 1 && r.truncated === true, "drug-orange-book: partial fields");
  await h("drug-orange-book")({ applicationNumber: "N213051" });
  ok(search(last()) === 'products.application_number:"213051"', `drug-orange-book: an application number searches its six digits (${search(last())})`);

  // ---- device-adverse-events ---------------------------------------------------
  sent.length = 0;
  r = await h("device-adverse-events")({ device: "insulin pump", productCode: "lzg", since: "2026-01-01", limit: 2 });
  ok(sent.length === 3, "device-adverse-events: three reads (newest reports + two counts)");
  const s0 = search(sent[0]);
  ok(/^device\.generic_name:"insulin pump" AND device\.device_report_product_code:"LZG" AND date_received:\[20260101 TO \d{8}\]$/.test(s0), `device-adverse-events: filters AND-joined with a received-date window (${s0})`);
  ok(sent.some((u) => u.searchParams.get("count") === "event_type.exact") && sent.some((u) => u.searchParams.get("count") === "product_problems.exact" && u.searchParams.get("limit") === "10"), "device-adverse-events: server-side counts by event type and problem");
  ok(r.totalReports === 992 && r.eventTypes[0].eventType === "Malfunction" && r.eventTypes[2].eventType === "Not reported" && r.topProblems[0].problem === "Pumping Stopped", "device-adverse-events: totals and counts shaped (blank event type named)");
  const M = r.recentReports[0];
  ok(r.recentReports.length === 2 && M.dateReceived === "2026-09-30" && M.productCode === "LZG" && M.problems[0] === "Wireless Communication Problem", "device-adverse-events: newest reports shaped, capped at limit");
  ok(M.excerpt.length === MDR_EXCERPT_CHARS && M.excerpt.startsWith("IT WAS REPORTED") && M.excerptChars === NARRATIVE.trim().length && M.excerptTruncated === true, "device-adverse-events: the event description (not the manufacturer note) as one bounded excerpt");
  const mText = JSON.stringify(r);
  ok(!mText.includes("PRIVATE") && !mText.includes("5551234") && !/gmdn/i.test(mText), "device-adverse-events: contact names, phone numbers and GMDN never ride through");
  ok(r.returned === 2 && r.matched === 992 && r.complete === false && r.maxExcerptChars === MDR_EXCERPT_CHARS && /unverified/.test(r.note), "device-adverse-events: partial fields + the note on what counts cover");
  r = await h("device-adverse-events")({ manufacturer: "medtronic", limit: 0 });
  ok(r.recentReports.length === 0 && r.totalReports === 992 && r.complete === false, "device-adverse-events: limit 0 is counts only, never read as a complete list");

  // ---- openFDA's 404 no-match, and a real outage --------------------------------
  mode = "nomatch";
  r = await h("drug-label")({ name: "zzz" });
  ok(r.count === 0 && r.matched === 0 && r.complete === true, "no match: drug-label answers an empty, complete list");
  r = await h("device-adverse-events")({ device: "zzz" });
  ok(r.totalReports === 0 && r.eventTypes.length === 0 && r.recentReports.length === 0, "no match: device-adverse-events answers zeros");
  mode = "down";
  let threw = null;
  try { await h("device-510k")({ applicant: "x" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode >= 500, `a 5xx stays a failure, never an empty answer (got ${threw?.statusCode})`);
  mode = "ok";

  // ---- the key rides only when set -------------------------------------------
  process.env.OPENFDA_API_KEY = "test-key-123";
  await h("drug-ndc")({ ndc: "58151-155" });
  ok(last().searchParams.get("api_key") === "test-key-123", "OPENFDA_API_KEY is appended when set");
  delete process.env.OPENFDA_API_KEY;
  await h("drug-ndc")({ ndc: "58151-155" });
  ok(!last().searchParams.has("api_key"), "and absent when unset");
} finally {
  globalThis.fetch = realFetch;
}

// ---- live: each tool answers its own example with data ------------------------
if (process.env.OPENFDA_LIVE === "1") {
  const checks = {
    "drug-label": (r) => r.count >= 1 && r.labels[0].sections.indications?.text?.length > 0,
    "drug-ndc": (r) => r.count >= 1 && r.products[0].productNdc === "58151-155",
    "device-510k": (r) => r.count >= 1 && /^K\d{6}$/.test(r.clearances[0].kNumber),
    "device-adverse-events": (r) => r.totalReports > 0 && r.eventTypes.length > 0 && r.topProblems.length > 0 && r.recentReports.length >= 1,
    "drug-shortages": (r) => r.count >= 1 && r.shortages[0].genericName && r.shortages[0].status,
    "drug-orange-book": (r) => r.count >= 1 && r.products[0].brandName && r.products.some((p) => p.patents.length > 0),
  };
  for (const [s, check] of Object.entries(checks)) {
    const t0 = Date.now();
    const r = await h(s)(tool(s).discovery.input);
    ok(check(r), `live: ${s} answers its own example with data (${Date.now() - t0} ms)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
