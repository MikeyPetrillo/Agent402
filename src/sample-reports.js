// Real sample reports, served free and indexable at /reports/sample/<product>.
//
// Every product on /reports used to link to "sample output" that was a
// JSON stub with "..." in it - nobody could see what a finished report looks
// like before paying. These are REAL runs of the same handlers (generated
// with the production upstreams, committed as fixtures under assets/samples),
// rendered through the same viewer a buyer gets, with a buy box for the
// reader's own ticker/domain/question. A fixture is the exact bundle the
// checkout would store: { kind, slug, input, title, report, sources, tables }.
//
// Why fixtures and not live generation: a free public page that spends
// upstream on every render is a spend hole; a fixture costs nothing to
// serve, is byte-stable for the index, and says when it was generated.
import { readdirSync, readFileSync } from "node:fs";
import { trimWords, SERP_TITLE_MAX } from "./seo-meta.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_PRODUCTS, reportHeadline } from "./human-checkout.js";
import { houseStyleBundle } from "./house-style.js";
import { REPORT_MODEL_NOTE, reportIsModelWritten, kitDisclaimer } from "./report-disclosure.js";
import { shownGroundingNote } from "./report-grounding.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "samples");

/** product key -> fixture (validated). Loaded once at import. */
export const SAMPLES = (() => {
  const out = {};
  let files = [];
  try { files = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch { return out; }
  for (const f of files) {
    const product = f.replace(/\.json$/, "");
    const p = HUMAN_PRODUCTS[product];
    if (!p) continue; // a fixture for a product that no longer sells is not served
    try {
      const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      if (!j || typeof j.report !== "string" || j.report.trim().length < 400) continue;
      out[product] = {
        status: "done",
        sample: true,
        product,
        kind: p.kind,
        slug: p.slug,
        label: p.label,
        input: String(j.input || ""),
        title: reportHeadline({ report: j.report, title: j.title, input: j.input }, p.label),
        report: houseStyleBundle(j.report, 0, "report"),
        sources: Array.isArray(j.sources) ? j.sources : [],
        tables: Array.isArray(j.tables) ? j.tables : [],
        at: j.at || j.generatedAt || null,
        priceUsd: p.price / 100,
        // The kit's own disclaimer as the run returned it, and the model-written
        // note the page shows under the title (the JSON reader gets both too).
        ...(kitDisclaimer(j) ? { disclaimer: kitDisclaimer(j) } : {}),
        ...(reportIsModelWritten(p.kind) ? { notice: REPORT_MODEL_NOTE } : {}),
        // A fixture generated after the grounding check shipped carries its
        // result; the sample shows the same field and note a buyer gets.
        ...(j.grounding && typeof j.grounding === "object" ? { grounding: j.grounding } : {}),
        ...(shownGroundingNote(j.grounding) ? { groundingNote: shownGroundingNote(j.grounding) } : {}),
        // A fixture whose text stops mid-sentence says so on its page rather
        // than passing as a finished report (the fixture itself is left as run).
        ...(endsMidSentence(j.report) ? { cutShort: true } : {}),
      };
    } catch { /* an unreadable fixture is simply not served */ }
  }
  return out;
})();

export const SAMPLE_PRODUCTS = Object.keys(SAMPLES);
export const samplePath = (product) => `/reports/sample/${product}`;
export const samplePaths = () => SAMPLE_PRODUCTS.map(samplePath);

/** The sample page for a product SLUG (what the /reports cards know), else null. */
export function sampleLinkFor(slug) {
  const product = SAMPLE_PRODUCTS.find((k) => SAMPLES[k].slug === slug);
  return product ? samplePath(product) : null;
}

/** What the viewer fetches: the fixture minus nothing (it is public by design). */
export function sampleJson(product) {
  return SAMPLES[product] || null;
}

/** Page-level metadata for the shell: title, description, canonical, JSON-LD. */
export function sampleMeta(product, baseUrl) {
  const s = SAMPLES[product];
  if (!s) return null;
  const canonical = `${baseUrl}${samplePath(product)}`;
  // Trim the headline to search-result length HERE so the
  // "(free sample)" suffix a reader (and test-sample-reports) looks for survives.
  const SUFFIX = " (free sample)";
  const title = `${trimWords(s.title, SERP_TITLE_MAX - SUFFIX.length)}${SUFFIX}`;
  // Each part names only what this sample has: a domain audit cites no
  // sources and a research report carries no tables, and "0 data tables,
  // PDF and CSV downloads" promised a download that did not exist.
  const parts = [];
  if (s.sources.length) parts.push(`${s.sources.length} cited sources`);
  if (s.tables.length) parts.push(`${s.tables.length} data table${s.tables.length === 1 ? "" : "s"} with CSV downloads`);
  parts.push("a PDF download");
  const description = `A real ${midSentence(s.label)} generated by Agent402 for "${s.input}": ${parts.join(", ")}. Read it free, then get one for your own ${inputNoun(s.kind)} for $${s.priceUsd.toFixed(0)}.`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Reports", item: `${baseUrl}/reports` },
      { "@type": "ListItem", position: 3, name: s.label, item: canonical },
    ] },
    { "@type": "Report", "@id": `${canonical}#report`, headline: s.title, name: s.title, about: s.input, isAccessibleForFree: true,
      ...(s.at ? { datePublished: s.at } : {}), author: { "@type": "Organization", name: "Agent402", url: baseUrl },
      publisher: { "@type": "Organization", name: "Agent402", url: baseUrl }, mainEntityOfPage: canonical,
      description: description.slice(0, 300) },
    { "@type": "Product", name: s.label, image: `${baseUrl}/tools/${s.slug}/card.png`, url: `${baseUrl}/reports`, offers: { "@type": "Offer", price: s.priceUsd.toFixed(2), priceCurrency: "USD", url: `${baseUrl}/reports`, availability: "https://schema.org/InStock" } },
  ];
  return { title, description, canonical, jsonLd };
}

/** True when a report's body (the text before its Sources section) does not
 *  end a sentence: the synthesis stopped at its length limit. */
export function endsMidSentence(report) {
  const body = String(report || "").split(/\n#{1,6}\s*Sources\b/i)[0].replace(/[\s*_"'\u201d\u2019)\]]+$/u, "");
  return body.length > 0 && !/[.!?:;]$/.test(body);
}

/** A product label lowercased for use mid-sentence, acronyms kept:
 *  "Deep research report" -> "deep research report", "SEC filing report" kept. */
export function midSentence(label) {
  const t = String(label || "");
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

function inputNoun(kind) {
  return { dossier: "company", insider: "ticker", fund: "fund", domain: "domain", research: "question", recall: "product", filing: "company", token: "token", ticker: "ticker", linkedin: "topic" }[kind] || "subject";
}
