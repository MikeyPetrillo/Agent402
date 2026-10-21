// Offline tests for the Agentic Finance (AIFI) glossary and the internal
// links that hang the category off the explainer pages. Pure functions, no
// server boot, no network.
//
// Why these assertions exist: the glossary's value is that it is ONE
// canonical DefinedTermSet the graph and the pages point at. The failure
// modes are all quiet - a term rendered on the page but missing from the
// JSON-LD (or vice versa), a duplicate anchor that makes `#facilitator`
// ambiguous, the AIFI page's DefinedTerm drifting off to a different set,
// an explainer page losing its body link (nav/footer links are shared
// chrome, so "the page links /agentic-finance" would stay true while the
// body copy silently stopped), a definition that picks up markup and is then
// emitted raw into structured data. None of those break a render, so a
// render smoke never sees them.
import { GLOSSARY, glossaryPage } from "../src/glossary.js";
import { resolveRailCountTokens } from "../src/rails.js";
import { agenticFinancePage } from "../src/agentic-finance.js";
import { whatIsX402Page } from "../src/what-is-x402.js";
import { whatIsMppPage } from "../src/what-is-mpp.js";
import { BLOG_POSTS, blogPost } from "../src/blog.js";
import { llmsTxt, sitemapPages } from "../src/seo.js";

const BASE = "https://example.test";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const findType = (blocks, type) => {
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === "object") { if (n["@type"] === type) out.push(n); Object.values(n).forEach(walk); } };
  blocks.forEach(walk);
  return out;
};
// Body-only view of a page: strip the shared chrome so a link found here is
// a link the page's own copy makes, not the nav or footer.
const bodyOnly = (html) => {
  const start = html.indexOf("<header");
  const end = html.lastIndexOf("<footer");
  return start >= 0 && end > start ? html.slice(start, end) : html;
};

// --- the glossary itself -----------------------------------------------------
const ids = GLOSSARY.map((t) => t.id);
ok(GLOSSARY.length >= 20, `glossary has a real vocabulary (${GLOSSARY.length} terms)`);
ok(new Set(ids).size === ids.length, "term anchors are unique");
ok(ids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)), "term anchors are url-safe kebab-case");
ok(GLOSSARY.every((t) => t.name && t.def && t.def.length > 80), "every term has a name and a substantive definition");
ok(GLOSSARY.every((t) => !/[<>]/.test(t.def) && !/[<>]/.test(t.name)), "definitions are plain text (they are emitted verbatim into JSON-LD)");
ok(GLOSSARY.every((t) => Array.isArray(t.see) && t.see.length > 0 && t.see.every(([href]) => href.startsWith("/"))), "every term links to at least one deep page, all internal");
const allText = GLOSSARY.map((t) => [t.name, t.def, ...(t.see || []).map((s) => s[1])].join(" ")).join("\n");
ok(!/\b\d{3,4} tools\b/.test(allText) && /500\+/.test(allText), "counts stay evergreen (500+), no exact tool counts");
for (const must of ["agentic-finance", "x402", "mpp", "http-402", "facilitator", "eip-3009", "payment-receipt", "settlement", "dual-stack", "proof-of-work-tier", "smart-order-router", "tollbooth"]) {
  ok(ids.includes(must), `core term present: #${must}`);
}

// --- the rendered page + structured data ------------------------------------
const html = glossaryPage(BASE);
ok(html.includes("<title>") && /glossary/i.test(html.slice(0, 2000)), "page renders with a glossary title");
for (const t of GLOSSARY) {
  if (!html.includes(`<article id="${t.id}"`)) { ok(false, `term #${t.id} rendered as an anchored article`); break; }
}
ok(GLOSSARY.every((t) => html.includes(`<article id="${t.id}"`)), "every term is rendered as an anchored <article id>");
const blocks = ldBlocks(html);
const sets = findType(blocks, "DefinedTermSet");
ok(sets.length === 1 && sets[0]["@id"] === `${BASE}/glossary#set`, "exactly one DefinedTermSet, @id /glossary#set");
const terms = sets.length ? sets[0].hasDefinedTerm || [] : [];
ok(terms.length === GLOSSARY.length, `DefinedTermSet carries one DefinedTerm per rendered term (${terms.length}/${GLOSSARY.length})`);
ok(terms.every((d) => d["@type"] === "DefinedTerm" && d.name && d.description && d.url && d.inDefinedTermSet?.["@id"] === `${BASE}/glossary#set`), "every DefinedTerm has name/description/url and points back at the set");
const byId = Object.fromEntries(GLOSSARY.map((t) => [t.id, t]));
ok(terms.every((d) => { const id = d.url.split("#")[1]; return byId[id] && resolveRailCountTokens(byId[id].def) === d.description && byId[id].name === d.name; }), "JSON-LD descriptions are byte-identical to the rendered definitions");
const aifiTerm = terms.find((d) => d.url.endsWith("#agentic-finance"));
ok(aifiTerm && aifiTerm["@id"] === `${BASE}/agentic-finance#term`, "the Agentic Finance entry aliases the category page's DefinedTerm @id (one node in the graph, not two)");
ok(findType(blocks, "BreadcrumbList").length === 1, "breadcrumb present");

// --- the category page joins the set ------------------------------------------
const aifi = agenticFinancePage(BASE);
const aifiTerms = findType(ldBlocks(aifi), "DefinedTerm");
ok(aifiTerms.length === 1 && aifiTerms[0]["@id"] === `${BASE}/agentic-finance#term`, "/agentic-finance defines exactly one DefinedTerm, @id #term");
ok(aifiTerms[0]?.inDefinedTermSet?.["@id"] === `${BASE}/glossary#set`, "/agentic-finance's DefinedTerm sits in the /glossary#set DefinedTermSet");

// --- explainer pages link the category from their BODY copy ------------------
const x402 = bodyOnly(whatIsX402Page(BASE, {}));
const mpp = bodyOnly(whatIsMppPage(BASE));
ok(x402.includes('href="/agentic-finance"'), "/what-is-x402 body links /agentic-finance");
ok(x402.includes('href="/glossary"'), "/what-is-x402 body links /glossary");
ok(mpp.includes('href="/agentic-finance"'), "/what-is-mpp body links /agentic-finance");
ok(/href="\/glossary(#[a-z0-9-]+)?"/.test(mpp), "/what-is-mpp body links /glossary");
const mppAnchors = [...mpp.matchAll(/href="\/glossary#([a-z0-9-]+)"/g)].map((m) => m[1]);
ok(mppAnchors.length > 0 && mppAnchors.every((a) => ids.includes(a)), `every /glossary#anchor referenced by /what-is-mpp exists (${mppAnchors.join(", ")})`);

// --- the long-form post --------------------------------------------------------
const post = BLOG_POSTS.find((p) => p.slug === "what-is-agentic-finance-aifi");
ok(!!post, "AIFI blog post exists");
const postHtml = post ? blogPost(BASE, post.slug) : "";
ok(postHtml.includes('href="/agentic-finance"') && postHtml.includes('href="/glossary"'), "AIFI post links the category page and the glossary");
const postAnchors = [...(post?.body || "").matchAll(/href="\/glossary#([a-z0-9-]+)"/g)].map((m) => m[1]);
ok(postAnchors.length > 0 && postAnchors.every((a) => ids.includes(a)), `every /glossary#anchor in the post exists (${postAnchors.join(", ")})`);
ok(!/\b1,?000 tools\b/.test(post?.body || "") && /500\+/.test(post?.body || ""), "post keeps counts evergreen");

// --- social card: both pages point og:image/twitter:image at the AIFI card -------
{
  const { aifiCardSvg } = await import("../src/aifi-card.js");
  const svg = aifiCardSvg();
  ok(/Agentic Finance/.test(svg) && /x402 · MPP/.test(svg) && /agent402\.tools\/glossary/.test(svg) && !/\b\d{3,4} tools\b/.test(svg), "AIFI card names the category, both wires and the glossary; counts evergreen");
  for (const [name, page] of [["/agentic-finance", aifi], ["/glossary", html]]) {
    ok(page.includes(`<meta property="og:image" content="${BASE}/og/agentic-finance.png">`) && page.includes(`<meta name="twitter:image" content="${BASE}/og/agentic-finance.png">`), `${name} og:image + twitter:image point at /og/agentic-finance.png`);
  }
}

// --- discovery surfaces --------------------------------------------------------
const sm = sitemapPages(BASE, {});
ok(sm.includes(`${BASE}/glossary`), "sitemap-pages lists /glossary");
ok(sm.includes(`${BASE}/blog/what-is-agentic-finance-aifi`), "sitemap-pages lists the AIFI post");
const llms = llmsTxt(BASE, {});
ok(llms.includes(`${BASE}/glossary`) && llms.includes(`${BASE}/agentic-finance`), "llms.txt points agents at /glossary and /agentic-finance");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
