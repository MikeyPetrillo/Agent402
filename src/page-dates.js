// Per-URL sitemap lastmod, read from a generated table of source dates.
//
// Every sitemap entry used to carry the process boot date, so each deploy
// told a crawler that every page had changed that day. A lastmod that is
// always recent is a signal crawlers learn to discount, and it is the main
// lever they use to pick which listed URLs to read again. The date now moves
// only when the page's source moved:
//
//   static pages      the newest commit touching the module that renders them
//   tool pages        the newest commit touching the kit that defines the tool
//   legal pages       the "last updated" date the page itself prints
//   sample reports    the fixture's own generation date
//   public reports    the report's publication date
//   anything else     no lastmod at all (a category page, a live data surface
//                     or a seeded entity page has no single modification date)
//
// The production image carries no git history (.dockerignore drops .git), so
// the dates are computed where history exists and committed as
// src/generated/page-dates.json by `node scripts/gen-page-dates.js --write`;
// scripts/test-page-dates.js fails CI when that table is stale. A path the
// table does not know gets no lastmod rather than a guessed one.
import { readFileSync } from "node:fs";
import { CHAIN_PAGES } from "./market-page.js";
import { termsPage } from "./terms.js";
import { privacyPage } from "./privacy.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Path -> the module(s) whose newest commit dates the page. Paths listed in
 *  src/seo.js and absent here deliberately carry no lastmod. */
export const PAGE_SOURCES = {
  "/": ["src/ledger-home.js"],
  "/tools": ["src/ledger-catalog.js"],
  "/reports": ["src/human-reports-page.js"],
  "/monitors": ["src/monitors-page.js"],
  "/credits": ["src/credits-page.js"],
  "/faq": ["src/pages.js"],
  "/docs": ["src/ledger-docs.js"],
  "/transparency": ["src/transparency.js"],
  "/llms.txt": ["src/seo.js"],
  "/SKILL.md": ["src/skill-md.js"],
  "/marketplace": ["src/market-page.js"],
  "/mpp-marketplace": ["src/mpp-market-page.js"],
  "/marketplace/tools": ["src/index-tools-page.js"],
  "/sell": ["src/sell.js"],
  "/leaderboard": ["src/ledger-leaderboard.js"],
  "/tollbooth": ["src/tollbooth-landing.js"],
  "/integrations": ["src/ledger-integrations.js"],
  "/pricing": ["src/ledger-pricing.js"],
  "/changelog": ["src/changelog.js"],
  "/quickstart": ["src/quickstart.js"],
  "/what-is-x402": ["src/what-is-x402.js"],
  "/what-is-mpp": ["src/what-is-mpp.js"],
  "/how-to-pay": ["src/how-to-pay.js"],
  "/speech": ["src/speech-page.js"],
  "/agentic-finance": ["src/agentic-finance.js"],
  "/x402-test": ["src/x402-test-page.js"],
  "/markets": ["src/markets.js"],
  "/decide": ["src/decide-page.js"],
  "/security": ["src/security-page.js"],
  "/crawler": ["src/crawler-page.js"],
  "/company": ["src/company.js"],
  "/proof": ["src/proof.js"],
  "/glossary": ["src/glossary.js"],
  "/101": ["src/x402-101.js"],
  "/revenue": ["src/revenue-live.js"],
  "/blog": ["src/blog.js"],
  "/contribute": ["src/contribute.js"],
  "/workflows": ["src/workflows.js"],
  "/status": ["src/status.js"],
  "/sdk-playground": ["src/sdk-playground.js"],
  "/docs/api/explorer": ["src/api-explorer.js"],
  "/docs/adapters": ["src/adapter-docs.js"],
  "/docs/webhooks": ["src/webhooks.js"],
  "/playground": ["src/playground.js"],
  "/guides": ["src/guides.js"],
  "/skills": ["src/skills.js"],
  "/learn": ["src/learn.js"],
  ...Object.fromEntries(Object.keys(CHAIN_PAGES).map((key) => [`/${key}`, ["src/market-page.js"]])),
};

/** Prefix families: one module renders every page under the prefix. */
export const FAMILY_SOURCES = [
  ["/blog/", ["src/blog.js"]],
  ["/docs/adapters/", ["src/adapter-docs.js"]],
  ["/learn/", ["src/learn.js"]],
  ["/integrations/", ["src/integration-pages.js"]],
  ["/guides/", ["src/guides.js"]],
  ["/skills/", ["src/skills.js"]],
];

/** The files whose tool definitions (`slug: "..."`) date the /tools pages. */
export const TOOL_SOURCE_GLOBS = ["src/tools/*.js", "src/skills.js"];

/** Every module the generator must date: the page sources above (the tool
 *  kits are globbed by the generator itself). */
export function pageSourceFiles() {
  const out = new Set();
  for (const files of Object.values(PAGE_SOURCES)) for (const f of files) out.add(f);
  for (const [, files] of FAMILY_SOURCES) for (const f of files) out.add(f);
  return [...out].sort();
}

let table = null;
function loadTable() {
  if (table) return table;
  try {
    const j = JSON.parse(readFileSync(new URL("./generated/page-dates.json", import.meta.url), "utf8"));
    table = { files: j.files && typeof j.files === "object" ? j.files : {}, toolSources: j.toolSources && typeof j.toolSources === "object" ? j.toolSources : {} };
  } catch {
    table = { files: {}, toolSources: {} };
  }
  return table;
}
/** Test seam: replace the table (a test proves the lookup, not the file). */
export function _setPageDatesTable(t) { table = t ? { files: t.files || {}, toolSources: t.toolSources || {} } : null; }

const validDay = (d) => (typeof d === "string" && ISO_DAY.test(d) ? d : null);

/** The newest date among the files, or null when any file is undated: a
 *  page whose source is only partly dated is not dated at all. */
export function filesLastmod(files) {
  const { files: dates } = loadTable();
  let out = null;
  for (const f of files || []) {
    const d = validDay(dates[f]);
    if (!d) return null;
    if (!out || d > out) out = d;
  }
  return out;
}

/** The "last updated" date a legal page prints, read from the rendered page
 *  so the sitemap and the page cannot disagree. */
const LEGAL_RE = /last updated (\d{4}-\d{2}-\d{2})\./;
let legalDates = null;
export function legalLastmod(path) {
  if (!legalDates) {
    const read = (fn) => { try { return validDay((String(fn("https://agent402.tools")).match(LEGAL_RE) || [])[1]); } catch { return null; } };
    legalDates = { "/terms": read(termsPage), "/privacy": read(privacyPage) };
  }
  return legalDates[path] || null;
}

/** lastmod for a /tools/<slug> page: the kit that defines the slug. */
export function toolLastmod(slug) {
  const { toolSources } = loadTable();
  const file = toolSources[String(slug || "")];
  return file ? filesLastmod([file]) : null;
}

/** lastmod for a sitemap path, or null when nothing truthful is known. */
export function pageLastmod(path) {
  const p = String(path || "").split("?")[0];
  if (p === "/terms" || p === "/privacy") return legalLastmod(p);
  if (PAGE_SOURCES[p]) return filesLastmod(PAGE_SOURCES[p]);
  if (p.startsWith("/tools/category/")) return null;
  if (p.startsWith("/tools/")) return toolLastmod(p.slice("/tools/".length));
  for (const [prefix, files] of FAMILY_SOURCES) if (p.startsWith(prefix)) return filesLastmod(files);
  return null;
}

/** An ISO timestamp or date -> YYYY-MM-DD, or null when it does not parse. */
export function dayOf(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
