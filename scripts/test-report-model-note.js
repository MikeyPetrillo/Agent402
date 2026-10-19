#!/usr/bin/env node
// Offline test: every place a person reads a model-written report says so.
//
// The sentence is REPORT_MODEL_NOTE (src/report-disclosure.js), defined once.
// This checks that it reaches each surface:
//   * the /reports storefront
//   * the report viewer (assets/js/report-view.js, run for real in jsdom) on a
//     delivered, monitor, public and sample report, above the body, plus the
//     kit's own disclaimer when the record carries one
//   * the sample and public report JSON
//   * the report-ready and monitor emails (the real builders; nothing is sent)
// and that it stays off what a model does not write (the IPO digest, a
// "problem" mail about a run that produced nothing).
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { REPORT_MODEL_NOTE, CODE_WRITTEN_REPORT_KINDS, reportIsModelWritten, kitDisclaimer } from "../src/report-disclosure.js";
import { humanReportsPage, reportDeliveryPage } from "../src/human-reports-page.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { SAMPLES, sampleJson } from "../src/sample-reports.js";
import { buildReportReadyEmail, buildMonitorEmail } from "../src/email.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ------------------------------------------------------------ 1. the sentence
ok(typeof REPORT_MODEL_NOTE === "string" && /language model/.test(REPORT_MODEL_NOTE), "the note says a language model wrote the text");
ok(/not investment, medical or legal advice/.test(REPORT_MODEL_NOTE), "the note says the report is information, not investment, medical or legal advice");
ok(!/[—–]/.test(REPORT_MODEL_NOTE), "the note carries no em or en dash");
ok(CODE_WRITTEN_REPORT_KINDS.includes("ipo") && !reportIsModelWritten("ipo"), "the IPO digest (code-written) is the one kind without the note");
const sellingKinds = new Set([...Object.values(HUMAN_PRODUCTS), ...Object.values(MONITOR_PRODUCTS)].map((p) => p.kind));
ok([...sellingKinds].filter((k) => k !== "ipo").every(reportIsModelWritten), "every other report kind sold by card or monitor is labeled model-written");
ok(reportIsModelWritten(undefined) && reportIsModelWritten("a-new-kind"), "a missing or new kind is labeled by default");
ok(kitDisclaimer({ meta: { disclaimer: " Not medical advice. " } }) === "Not medical advice." && kitDisclaimer({ meta: {} }) === null, "kitDisclaimer reads meta.disclaimer");

// ------------------------------------------------------------ 2. /reports
const storefront = humanReportsPage("https://agent402.tools");
const sfDoc = new JSDOM(storefront).window.document;
const sfNote = sfDoc.getElementById("model-note");
ok(!!sfNote && sfNote.textContent.trim() === REPORT_MODEL_NOTE, "/reports shows the note");
ok(!!sfNote && !!sfDoc.querySelector(".hero") && sfDoc.querySelector(".hero").contains(sfNote), "/reports shows it in the hero, beside the trust row");

// ------------------------------------------------------------ 3. the viewer
const REPORT_VIEW_JS = readFileSync(new URL("../assets/js/report-view.js", import.meta.url), "utf8");
function inlineViewer(html) {
  const tag = '<script src="/js/report-view.js"></script>';
  if (!html.includes(tag)) throw new Error("reportDeliveryPage() no longer references /js/report-view.js");
  return html.replace(tag, `<script>${REPORT_VIEW_JS}</script>`);
}
async function render(record, opts = {}, url = "https://agent402.tools/r/cs_test") {
  const html = reportDeliveryPage("cs_test", { baseUrl: "https://agent402.tools", ...opts });
  const dom = new JSDOM(inlineViewer(html), {
    runScripts: "dangerously", url, virtualConsole: new VirtualConsole(),
    beforeParse(win) { win.fetch = async () => ({ json: async () => record }); },
  });
  const doc = dom.window.document;
  for (let i = 0; i < 100 && !doc.getElementById("report-body"); i++) await new Promise((r) => setTimeout(r, 10));
  return doc;
}
const noteIn = (doc) => {
  const n = doc.getElementById("model-note");
  const head = doc.querySelector("#report-body .rpt-head");
  return !!n && n.textContent.trim() === REPORT_MODEL_NOTE && !!head && head.contains(n);
};
const base = { status: "done", input: "x", title: "A report", report: "# A report\n\nBody text. [1]", sources: [], tables: [], at: "2026-10-01T00:00:00Z" };

let doc = await render({ ...base, kind: "research", slug: "research" });
ok(noteIn(doc), "a delivered report shows the note in its letterhead, above the body (and in the PDF)");
ok(!doc.getElementById("report-disclaimer"), "a record with no kit disclaimer shows no second line");

doc = await render({ ...base, kind: "recall", slug: "recall-report", disclaimer: "A summary of public FDA enforcement records. Not medical advice." });
const disc = doc.getElementById("report-disclaimer");
ok(noteIn(doc) && !!disc && disc.textContent === "A summary of public FDA enforcement records. Not medical advice.", "a recall report shows the note and the kit's own disclaimer");
ok(!!disc && doc.querySelector("#report-body .rpt-head").contains(disc), "the kit disclaimer sits in the letterhead too");

doc = await render({ ...base, kind: "dossier", disclaimer: '<img src=x onerror="alert(1)">' });
ok(!doc.querySelector("#report-disclaimer img") && (doc.getElementById("report-disclaimer")?.textContent || "").includes("<img"), "a disclaimer is rendered as text, never markup");

doc = await render({ ...base, kind: "ipo" }, { api: "/api/m/" }, "https://agent402.tools/m/rep1");
ok(!!doc.getElementById("report-body") && !doc.getElementById("model-note"), "the code-written IPO digest carries no model note");

doc = await render({ ...base, kind: "domain", monitor: { label: "Domain security monitor", target: "example.com", reason: "change", changes: [] } }, { api: "/api/m/" }, "https://agent402.tools/m/rep2");
ok(noteIn(doc), "a monitor report shows the note");

doc = await render({ ...base, kind: "fund", publicView: true, publicId: "rp_abcdefghijkl" }, { api: "/api/reports/public/", robots: "index, follow", note: "" }, "https://agent402.tools/reports/public/rp_abcdefghijkl");
ok(noteIn(doc), "a public (shared) report page shows the note");

// ------------------------------------------------------------ 4. samples
const sampleKeys = Object.keys(SAMPLES);
ok(sampleKeys.length > 0, "sample fixtures load");
ok(sampleKeys.every((k) => SAMPLES[k].notice === REPORT_MODEL_NOTE), "every sample report's JSON carries the note");
const recall = sampleJson("recall-report");
if (recall) {
  ok(typeof recall.disclaimer === "string" && /medical/.test(recall.disclaimer), "the recall sample carries its kit's disclaimer");
  doc = await render(recall, { api: "/api/reports/sample/", robots: "index, follow" }, "https://agent402.tools/reports/sample/recall-report");
  ok(noteIn(doc) && !!doc.getElementById("report-disclaimer"), "the recall sample page shows the note and the disclaimer");
}
const dossier = sampleJson("dossier");
if (dossier) {
  doc = await render(dossier, { api: "/api/reports/sample/", robots: "index, follow" }, "https://agent402.tools/reports/sample/dossier");
  ok(noteIn(doc), "the dossier sample page shows the note");
}

// ------------------------------------------------------------ 5. public JSON
const hc = readFileSync(new URL("../src/human-checkout.js", import.meta.url), "utf8");
ok(/function publicView[\s\S]{0,1200}notice: REPORT_MODEL_NOTE/.test(hc), "the public report JSON carries the note");
ok(/status: "done", kind: p\.kind[\s\S]{0,700}disclaimer: bundle\.disclaimer/.test(hc), "a delivered card report stores the kit's disclaimer");
const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/const _humanGenerate[\s\S]{0,4000}disclaimer: kitDisclaimer\(out\)/.test(srv), "the report bundle carries the kit's disclaimer");
const ms = readFileSync(new URL("../src/monitor-scheduler.js", import.meta.url), "utf8");
ok((ms.match(/notify\(\{ to: rec\.email, reason, kind: p\.kind,/g) || []).length === 2, "both monitor report mails name the report kind");

// ------------------------------------------------------------ 6. email
const missing = Object.entries(HUMAN_PRODUCTS).filter(([, p]) => {
  const em = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_1", productLabel: p.label, subjectOf: "AAPL", kind: p.kind, baseUrl: "https://agent402.tools" });
  return !(em.html.includes(escHtml(REPORT_MODEL_NOTE)) && em.text.includes(REPORT_MODEL_NOTE));
}).map(([k]) => k);
ok(missing.length === 0, `every card product's report-ready email carries the note${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
const mon = (o) => buildMonitorEmail({ label: "Domain security monitor", target: "example.com", reportUrl: "https://agent402.tools/m/a", manageUrl: "https://agent402.tools/monitors/manage?k=1", ...o });
let m = mon({ reason: "change", kind: "domain", changes: ["DMARC changed"] });
ok(m.html.includes(escHtml(REPORT_MODEL_NOTE)) && m.text.includes(REPORT_MODEL_NOTE), "a monitor report email carries the note");
m = mon({ reason: "welcome" });
ok(m.html.includes(escHtml(REPORT_MODEL_NOTE)), "a monitor email with no kind carries the note");
m = mon({ reason: "digest", label: "IPO pipeline watch", target: "all" });
ok(!m.html.includes(REPORT_MODEL_NOTE) && !m.text.includes(REPORT_MODEL_NOTE), "the IPO digest email carries no model note");
m = mon({ reason: "change", kind: "ipo" });
ok(!m.text.includes(REPORT_MODEL_NOTE), "an IPO kind carries no model note on any reason");
m = mon({ reason: "problem", kind: "domain" });
ok(!m.text.includes(REPORT_MODEL_NOTE), "a 'could not complete' email carries no model note");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
