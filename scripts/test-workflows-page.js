#!/usr/bin/env node
// /workflows shows chains an agent can run end to end. A chain is only real if
// each step can take what the step before it returns:
//   - render, extract and pdf-to-markdown return markdown, so no later step may
//     be one that takes an HTML or CSV string (html-*, csv-*);
//   - a card's description promises only what its steps return.
// With TARGET_URL set (a FREE_MODE server), it also runs the steps that need no
// wallet, key or paid upstream: pdf-info -> pdf-to-markdown -> text-stats on a
// public PDF, and text-diff over two snapshots.
import { WORKFLOWS, workflowsPage } from "../src/workflows.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const MARKDOWN_OUT = new Set(["render", "extract", "pdf-to-markdown"]);
const TAKES_MARKUP = (slug) => /^(html-|csv-)/.test(slug);
for (const wf of WORKFLOWS) {
  const slugs = wf.steps.map((s) => s.slug);
  const firstMd = slugs.findIndex((s) => MARKDOWN_OUT.has(s));
  const bad = firstMd < 0 ? [] : slugs.slice(firstMd + 1).filter(TAKES_MARKUP);
  ok(bad.length === 0, `${wf.title}: no step after a markdown producer takes HTML or CSV${bad.length ? ` (${bad.join(", ")})` : ""}`);
  ok(!/structured data|line items|company profile|extract a target element|monitored element/i.test(wf.description + wf.steps.map((s) => s.label).join(" ")),
    `${wf.title}: the copy promises only what its steps return`);
}
const html = workflowsPage("https://agent402.tools", {});
ok(!/Process PDF invoices|clean CSV/.test(html), "the retired invoice chain (no step produced CSV) is gone");

const base = process.env.TARGET_URL;
if (base) {
  const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const PDF = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
  const info = await post("/api/pdf-info", { url: PDF });
  ok(info.status === 200 && info.json.pages >= 1, `pdf-info reads the page count (${info.json.pages})`);
  const md = await post("/api/pdf-to-markdown", { url: PDF });
  ok(md.status === 200 && typeof md.json.markdown === "string" && md.json.markdown.length > 0, "pdf-to-markdown returns markdown");
  const stats = await post("/api/text-stats", { text: md.json.markdown });
  ok(stats.status === 200 && stats.json.words > 0 && "readingTimeMinutes" in stats.json && "estimatedTokens" in stats.json, "text-stats takes that markdown and returns words, reading time and a token estimate");
  const diff = await post("/api/text-diff", { a: "price: 10\nstock: yes", b: "price: 12\nstock: yes" });
  ok(diff.status === 200 && diff.json.added >= 1 && diff.json.removed >= 1, "text-diff compares two snapshots line by line");
} else {
  console.log("# offline checks only (set TARGET_URL to a FREE_MODE server to run the chains)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
