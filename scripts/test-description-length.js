// The text a tool page shows, and the catalog description behind it.
//
// A tool's catalog `description` is what every listing carries (/api/pricing,
// /openapi.json, /llms.txt, the connector's tool listings, the 402 and the
// marketplace listings built from it) and is never shortened for a page. A
// tool whose description is long sets `pageSummary`, a shorter text that only
// its /tools/<slug> page shows. Held here:
//
//   1. Each tool in PAGE_SUMMARY shows, on its page, a text of at most
//      PAGE_MAX_WORDS words whose first sentence (the page's lead) is at most
//      FIRST_SENTENCE_MAX_WORDS words, and that text is not the description.
//   2. Every credit, disclaimer and marking the description carries is in the
//      page text too (requiredLines: "Powered by ...", "Source: ...", "not
//      affiliated with ...", "not investment advice", "no advice",
//      "model-backed", "deterministic code"), and so is every source credit
//      sentence of src/data-attribution.js the description holds.
//   3. PAGE_SUMMARY is the list of tools that set the field: the kits hold as
//      many `pageSummary` keys as the list has slugs.
//   4. No listing carries the field or its text: /api/pricing, /openapi.json,
//      /llms.txt and the connector's catalog.search and catalog.find; each
//      gives html-frames its full description (the connector, its opening).
//   5. A description with no pageSummary is at most MAX_WORDS words. The
//      ceiling is the longest such description rounded up to the next ten (the
//      run prints the three longest): a tool that would pass it sets a
//      pageSummary or says less, and the ceiling is never raised.
//
// Words are runs of non-space characters; a description is counted as
// /api/pricing serves it, so a note the server appends (the run-time note) is
// counted. Boots a free-mode server with the switched tool families listed.
//
//   node scripts/test-description-length.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";
import { stripTags, decodeEntities } from "./lib/html-text.js";
import { ATTRIBUTION_TAILS } from "../src/data-attribution.js";

export const MAX_WORDS = 230;
export const PAGE_MAX_WORDS = 120;
export const FIRST_SENTENCE_MAX_WORDS = 40;
export const PAGE_SUMMARY = [
  "html-frames", "token-risk", "price-webhook", "token-brief", "page-speed", "dex-pool-health", "redact-chat",
  "sol-token-report", "demand-radar", "token-risk-pro", "linkedin-article", "seller-dossier", "attest", "ticker-pack",
  "token-safety", "onchain-sql", "email-guard", "filing-report", "loop-gate", "insider-report",
];

export const wordCount = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;
// The sentence a tool page leads with (firstSentence in src/pages.js): up to
// the first period, question mark or exclamation mark that ends the text or
// is followed by a capital, a bracket or a quote.
export function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(?=\s+[A-Z(`"]|$)/);
  return m ? m[1] : s;
}
// The credits, disclaimers and markings a description carries, each as the
// words a shorter text must repeat (compared without case).
const REQUIRED = [/\bpowered by [^.;]+/gi, /\bsource: [^.;]+/gi, /\bnot affiliated with [^).,;]+/gi, /\bnot investment advice\b/gi, /\bno advice\b/gi, /\bmodel-backed\b/gi, /\bdeterministic code\b/gi];
export function requiredLines(description) {
  const out = new Set();
  for (const re of REQUIRED) for (const m of String(description || "").matchAll(re)) out.add(m[0].replace(/\s+/g, " ").trim().toLowerCase());
  return [...out];
}
const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();
const blockText = (html, cls) => {
  const m = new RegExp(`<p class="${cls}"[^>]*>([\\s\\S]*?)</p\\s*>`, "i").exec(html);
  return m ? flat(decodeEntities(stripTags(m[1], ""))) : "";
};
/** The description text a tool page shows: its lead and the paragraph under
 *  Details. A lead the template cut is given whole under Details, so the
 *  paragraph that opens with the lead's own words is the whole text. */
export function pageDescriptionText(html) {
  const lead = blockText(html, "tp-lead");
  const about = blockText(html, "tp-sub tp-about");
  if (!about) return lead;
  const opening = lead.split(" ").slice(0, 3).join(" ");
  return about.startsWith(opening) ? about : `${lead} ${about}`;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; if (process.env.VERBOSE) console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

ok(wordCount("  one two\n three  ") === 3 && wordCount("") === 0, "words are runs of non-space characters");
ok(firstSentence("Reads window.renderAt(t). The tool renders it.") === "Reads window.renderAt(t)." && firstSentence("Costs 0.5 units a call. Next.") === "Costs 0.5 units a call." && firstSentence("no end") === "no end", "the first sentence ends at a period before a capital, not inside a name or a number");
ok(new Set(PAGE_SUMMARY).size === PAGE_SUMMARY.length, `the page-summary list names each tool once (${PAGE_SUMMARY.length})`);
{
  const lines = requiredLines("A report (not affiliated with Example Co). Model-backed. Powered by Example Data. Source: Example Index. Facts only, no advice; not investment advice. Deterministic code, no model.");
  ok(["not affiliated with example co", "model-backed", "powered by example data", "source: example index", "no advice", "not investment advice", "deterministic code"].every((l) => lines.includes(l)) && lines.length === 7, `control: the required lines of a description are found (${lines.join(" | ")})`);
  ok(requiredLines("Hashes a string.").length === 0, "control: a description with no credit or marking requires none");
  ok(pageDescriptionText('<p class="tp-lead">One two three four...</p><h2>Details</h2><p class="tp-sub tp-about">One two three four five. Six &amp; seven.</p>') === "One two three four five. Six & seven."
    && pageDescriptionText('<p class="tp-lead">One two three.</p><p class="tp-sub tp-about">Four <code>five</code>.</p>') === "One two three. Four five."
    && pageDescriptionText('<p class="tp-lead">Only this.</p>') === "Only this.", "control: the page text is the lead and the Details paragraph, a cut lead read whole from Details");
}
// 3. The list is the set of tools that set the field.
{
  const dir = fileURLToPath(new URL("../src/tools/", import.meta.url));
  let keys = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) keys += (readFileSync(dir + f, "utf8").match(/^\s*pageSummary:/gm) || []).length;
  ok(keys === PAGE_SUMMARY.length, `every pageSummary in src/tools is on the list (${keys} keys, ${PAGE_SUMMARY.length} listed)`);
}

const srv = await bootServer({ stores: "description-length", env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", KALSHI_TOOLS: "on", RUGCHECK_TOOLS: "on" } });
try {
  const pricingText = await (await fetch(`${srv.url}/api/pricing`)).text();
  const tools = JSON.parse(pricingText).endpoints || [];
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  ok(tools.length >= 400, `the catalog is read (${tools.length} tools)`);
  ok(tools.every((t) => wordCount(t.description) >= 3), "every tool has a description");

  // 5. The ceiling for a description no page summary stands in for.
  const listed = new Set(PAGE_SUMMARY);
  const sized = tools.filter((t) => !listed.has(t.slug)).map((t) => ({ slug: t.slug, words: wordCount(t.description) })).sort((a, b) => b.words - a.words);
  const over = sized.filter((t) => t.words > MAX_WORDS);
  ok(over.length === 0, `no description without a page summary is over ${MAX_WORDS} words${over.length ? ` (${over.map((t) => `${t.slug} ${t.words}`).join(", ")})` : ""}`);
  ok(sized[0].words > MAX_WORDS - 10, `the ceiling is the longest such description rounded up to the next ten (${sized[0].slug} ${sized[0].words}, ceiling ${MAX_WORDS})`);

  // 1 and 2. The page text of each listed tool.
  const pageTexts = new Map();
  for (const slug of PAGE_SUMMARY) {
    const t = bySlug.get(slug);
    ok(!!t, `${slug} is in the catalog`);
    if (!t) continue;
    const r = await fetch(`${srv.url}/tools/${slug}`);
    const text = r.status === 200 ? pageDescriptionText(await r.text()) : "";
    ok(!!text, `/tools/${slug} answers with a description text (${r.status})`);
    if (!text) continue;
    pageTexts.set(slug, text);
    const words = wordCount(text);
    const lead = wordCount(firstSentence(text));
    ok(words <= PAGE_MAX_WORDS, `${slug}: the page text is ${words} words (at most ${PAGE_MAX_WORDS})`);
    ok(lead <= FIRST_SENTENCE_MAX_WORDS, `${slug}: its first sentence is ${lead} words (at most ${FIRST_SENTENCE_MAX_WORDS})`);
    ok(words < wordCount(t.description) && !flat(t.description).startsWith(text), `${slug}: the page text is shorter than the description and is not its opening (${words} against ${wordCount(t.description)})`);
    const missing = requiredLines(t.description).filter((l) => !text.toLowerCase().includes(l));
    for (const c of ATTRIBUTION_TAILS) if (flat(t.description).includes(c) && !text.includes(c)) missing.push(c);
    ok(missing.length === 0, `${slug}: the page text keeps every credit, disclaimer and marking of the description${missing.length ? ` (missing: ${missing.join(" | ")})` : ""}`);
  }
  ok(PAGE_SUMMARY.filter((s) => requiredLines(bySlug.get(s)?.description).length > 0).length >= 10, "control: the listed descriptions carry required lines to keep");

  // 4. No listing carries the field or its text; html-frames keeps its full description on each.
  const slug = "html-frames";
  const full = flat(bySlug.get(slug)?.description);
  const summary = pageTexts.get(slug) || "";
  const summaryMark = summary.split(" ").slice(-12).join(" ");
  ok(full.includes("with all network access refused") && summaryMark.length > 20 && !full.includes(summaryMark), `${slug}: /api/pricing gives the full description, not the page text`);
  const openapiText = await (await fetch(`${srv.url}/openapi.json`)).text();
  const op = Object.values(JSON.parse(openapiText).paths || {}).flatMap((p) => Object.values(p)).find((o) => typeof o?.description === "string" && flat(o.description).startsWith(full));
  ok(!!op && !openapiText.includes(JSON.stringify(summaryMark).slice(1, -1)), `${slug}: /openapi.json gives the full description, not the page text`);
  const llmsText = await (await fetch(`${srv.url}/llms.txt`)).text();
  const mcpCall = async (name, args) => (await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).text();
  const mcpRow = (raw) => {
    try {
      const body = JSON.parse(raw.startsWith("{") ? raw : (raw.match(/^data: (.+)$/m) || [])[1]);
      return (JSON.parse(body.result.content[0].text).results || []).find((x) => x.slug === slug) || null;
    } catch { return null; }
  };
  // catalog.search and catalog.find list the opening of the description
  // (their own cut, with an ellipsis).
  const mcp = await mcpCall("catalog.search", { query: slug });
  const mcpFind = await mcpCall("catalog.find", { task: "freeze frames of an animation as PNG stills with html-frames" });
  for (const [name, raw] of [["catalog.search", mcp], ["catalog.find", mcpFind]]) {
    const listed = flat(mcpRow(raw)?.description).replace(/\u2026$/, "");
    ok(listed.length >= 100 && full.startsWith(listed) && !flat(summary).startsWith(listed), `${slug}: the connector's ${name} lists the opening of the full description (${listed.length} characters)`);
  }
  for (const [name, text] of [["/api/pricing", pricingText], ["/openapi.json", openapiText], ["/llms.txt", llmsText], ["catalog.search", mcp], ["catalog.find", mcpFind]]) {
    ok(!text.includes("pageSummary") && !flat(text).includes(summaryMark), `${name} carries no pageSummary field and no page text`);
  }
  console.log(`longest without a page summary: ${sized.slice(0, 3).map((t) => `${t.slug} ${t.words}`).join(", ")}`);
  console.log(`page text: ${PAGE_SUMMARY.map((s) => `${s} ${wordCount(pageTexts.get(s))}`).join(", ")}`);
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
