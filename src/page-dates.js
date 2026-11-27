// Per-URL sitemap lastmod, read from a generated table of source dates.
//
// Every sitemap entry used to carry the process boot date, so each deploy
// told a crawler that every page had changed that day. A lastmod that is
// always recent is a signal crawlers learn to discount, and it is the main
// lever they use to pick which listed URLs to read again. The date now moves
// only when the page's source moved:
//
//   static pages      the newest commit touching the module that renders them
//   tool pages        the newest commit touching the file that defines the
//                     tool (its kit, the kit whose template builds its slug,
//                     or src/server.js for an entry written there)
//   skill pack pages  the newest commit touching the module that defines the
//                     pack (a pack and a tool may share a name: /skills/<slug>
//                     and /tools/<slug> are two pages with two sources)
//   legal pages       the "last updated" date the page itself prints
//   sample reports    the fixture's own generation date
//   public reports    the report's publication date
//   seeded entity     the newest filing the page showed when last built
//   pages             (src/programmatic-pages.js entityLastmod; none before)
//   anything else     no lastmod at all (a category page or a live data
//                     surface has no single modification date)
//
// The production image carries no git history (.dockerignore drops .git), so
// the dates are computed where history exists and committed as
// src/generated/page-dates.json by `node scripts/gen-page-dates.js --write`;
// scripts/test-page-dates.js fails CI when that table is stale. A path the
// table does not know gets no lastmod rather than a guessed one.
import { readFileSync, readdirSync } from "node:fs";
import { CHAIN_PAGES } from "./market-page.js";
import { termsPage } from "./terms.js";
import { privacyPage } from "./privacy.js";
import { dpaPage } from "./dpa.js";

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
  "/integrations/agentcore": ["src/agentcore-page.js"],
  "/integrations/claude-managed-agents": ["src/managed-agents-page.js"],
  "/pricing": ["src/ledger-pricing.js"],
  "/changelog": ["src/changelog.js"],
  "/changelog/archive": ["src/changelog.js"],
  "/quickstart": ["src/quickstart.js"],
  "/what-is-x402": ["src/what-is-x402.js"],
  "/what-is-mpp": ["src/what-is-mpp.js"],
  "/how-to-pay": ["src/how-to-pay.js"],
  "/start": ["src/start-page.js", "src/base-no-gas.js"],
  "/speech": ["src/speech-page.js"],
  "/agentic-finance": ["src/agentic-finance.js"],
  "/x402-test": ["src/x402-test-page.js"],
  "/markets": ["src/markets.js"],
  "/decide": ["src/decide-page.js"],
  "/security": ["src/security-page.js"],
  "/accessibility": ["src/accessibility-page.js"],
  "/wholesale": ["src/wholesale-page.js", "src/wholesale.js", "src/stable-error-code.js"],
  "/trust": ["src/trust-page.js"],
  "/crawler": ["src/crawler-page.js"],
  "/company": ["src/company.js"],
  "/press": ["src/press-page.js"],
  "/proof": ["src/proof.js"],
  "/scorecard": ["src/scorecard.js"],
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
  "/reports/insider": ["src/programmatic-pages.js", "src/programmatic-seeds.js"],
  "/reports/fund": ["src/programmatic-pages.js", "src/programmatic-seeds.js"],
  "/reports/dossier": ["src/programmatic-pages.js", "src/programmatic-seeds.js"],
  "/pay-per-call-api": ["src/search-landings.js"],
  "/paid-mcp-tools": ["src/search-landings.js"],
  "/compare": ["src/search-landings.js"],
  ...Object.fromEntries(Object.keys(CHAIN_PAGES).map((key) => [`/${key}`, ["src/market-page.js"]])),
};

/** Prefix families: one module renders every page under the prefix. */
export const FAMILY_SOURCES = [
  ["/blog/", ["src/blog.js"]],
  ["/learn/", ["src/learn.js"]],
  ["/integrations/", ["src/integration-pages.js"]],
  ["/guides/", ["src/guides.js"]],
  ["/skills/", ["src/skills.js"]],
];

/** Pages that carry Article JSON-LD and are rendered by one module: their
 *  published date is that module's first commit, their modified date the
 *  page's lastmod. Family entries (blog, guides, learn, integrations, skill
 *  packs) are dated one by one in the table's `entries`. */
export const ARTICLE_PAGES = ["/what-is-x402", "/what-is-mpp", "/agentic-finance", "/x402-test", "/docs", "/integrations/agentcore", "/integrations/claude-managed-agents", "/pay-per-call-api", "/paid-mcp-tools", "/compare"];
/** The module whose first commit dates each article page. */
export function articleSourceFiles() {
  return [...new Set(ARTICLE_PAGES.map((p) => (PAGE_SOURCES[p] || [])[0]).filter(Boolean))].sort();
}

/** Every module the generator must date: the page sources above (the tool
 *  kits are globbed by the generator itself). */
export function pageSourceFiles() {
  const out = new Set(wikiSourceFiles());
  for (const files of Object.values(PAGE_SOURCES)) for (const f of files) out.add(f);
  for (const [, files] of FAMILY_SOURCES) for (const f of files) out.add(f);
  return [...out].sort();
}

/** The wiki pages /docs renders (wiki/<Page>.md; underscore files are
 *  chrome), each dating its own /docs/<Page>. */
export function wikiSourceFiles() {
  try { return readdirSync(new URL("../wiki/", import.meta.url)).filter((n) => n.endsWith(".md") && !n.startsWith("_")).map((n) => `wiki/${n}`).sort(); } catch { return []; }
}

let table = null;
function loadTable() {
  if (table) return table;
  try {
    const j = JSON.parse(readFileSync(new URL("./generated/page-dates.json", import.meta.url), "utf8"));
    const map = (m) => (m && typeof m === "object" ? m : {});
    table = { files: map(j.files), filesFirst: map(j.filesFirst), entries: map(j.entries), toolSources: map(j.toolSources), toolPatterns: map(j.toolPatterns), packSources: map(j.packSources) };
  } catch {
    table = { files: {}, filesFirst: {}, entries: {}, toolSources: {}, toolPatterns: {}, packSources: {} };
  }
  return table;
}
/** Test seam: replace the table (a test proves the lookup, not the file). */
export function _setPageDatesTable(t) { table = t ? { files: t.files || {}, filesFirst: t.filesFirst || {}, entries: t.entries || {}, toolSources: t.toolSources || {}, toolPatterns: t.toolPatterns || {}, packSources: t.packSources || {} } : null; }

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
    legalDates = { "/terms": read(termsPage), "/privacy": read(privacyPage), "/dpa": read(dpaPage) };
  }
  return legalDates[path] || null;
}

/** The file that builds a slug from a template ("*-gemini"): the one
 *  pattern the slug matches with a non-empty middle, or null when none or
 *  several do. */
function patternSource(key) {
  const { toolPatterns } = loadTable();
  const hits = [];
  for (const [pattern, file] of Object.entries(toolPatterns)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
    if (key.length > pre.length + post.length && key.startsWith(pre) && key.endsWith(post)) hits.push(file);
  }
  return new Set(hits).size === 1 ? hits[0] : null;
}

/** lastmod for a /tools/<slug> page: the file that defines the slug (a kit,
 *  the server module for an inline entry, or the kit whose template builds it). */
export function toolLastmod(slug) {
  const { toolSources } = loadTable();
  const key = String(slug || "");
  const file = Object.hasOwn(toolSources, key) ? toolSources[key] : patternSource(key);
  return file ? filesLastmod([file]) : null;
}

/** lastmod for a /skills/<slug> page: the module that defines the pack, or
 *  null when the table does not list the slug as a pack. Read apart from the
 *  tools, so a pack and a tool of one name each keep their own source. */
export function packLastmod(slug) {
  const { packSources } = loadTable();
  const key = String(slug || "");
  const file = Object.hasOwn(packSources, key) ? packSources[key] : null;
  return file ? filesLastmod([file]) : null;
}

/** lastmod for a sitemap path, or null when nothing truthful is known. */
export function pageLastmod(path) {
  const p = String(path || "").split("?")[0];
  if (p === "/terms" || p === "/privacy" || p === "/dpa") return legalLastmod(p);
  if (PAGE_SOURCES[p]) return filesLastmod(PAGE_SOURCES[p]);
  if (p.startsWith("/tools/category/")) return null;
  // A wiki page under /docs is dated by its own markdown file.
  if (/^\/docs\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(p)) return filesLastmod([`wiki/${p.slice("/docs/".length)}.md`]);
  if (p.startsWith("/tools/")) return toolLastmod(p.slice("/tools/".length));
  // A family entry (a guide, a pack, a post) is dated by its own text, so one
  // edit to one guide moves that guide's date and no other.
  const entry = entryDates(p);
  if (entry) return entry.modified;
  // A listed pack is dated by the module that defines it; any other page
  // under /skills/ falls to the family below (the module that renders them).
  if (p.startsWith("/skills/") && packLastmod(p.slice("/skills/".length))) return packLastmod(p.slice("/skills/".length));
  for (const [prefix, files] of FAMILY_SOURCES) if (p.startsWith(prefix)) return filesLastmod(files);
  return null;
}

/** { published, modified } for a family entry's path, or null. */
export function entryDates(path) {
  const { entries } = loadTable();
  const e = Object.hasOwn(entries, path) ? entries[path] : null;
  const modified = validDay(e?.modified), published = validDay(e?.published);
  return modified ? { modified, published: published && published <= modified ? published : modified } : null;
}

/** The dates an article page states (JSON-LD datePublished/dateModified and
 *  article:published_time/modified_time): a family entry's own dates, else
 *  the page module's first commit and the page's lastmod. `published`, when
 *  the page prints its own date (a blog post), wins. {} when nothing is known. */
export function articleDates(path, { published: printed = null } = {}) {
  const p = String(path || "").split("?")[0];
  const entry = entryDates(p);
  let modified = entry ? entry.modified : pageLastmod(p);
  // A printed date later than the source's last change (a post committed
  // before its publication day) is the newest truthful date for both.
  if (validDay(printed) && (!modified || validDay(printed) > modified)) modified = validDay(printed);
  let published = validDay(printed) || (entry ? entry.published : null);
  if (!published && PAGE_SOURCES[p]) published = validDay(loadTable().filesFirst[PAGE_SOURCES[p][0]]);
  if (published && modified && published > modified) published = modified;
  const out = {};
  if (published || modified) out.datePublished = published || modified;
  if (modified) out.dateModified = modified;
  return out;
}

/** An ISO timestamp or date -> YYYY-MM-DD, or null when it does not parse. */
export function dayOf(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
