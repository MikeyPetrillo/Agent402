#!/usr/bin/env node
// The plain-language guide (ask402.ai, a site this project's maintainer also
// operates) and this site's own explainer pages.
//
//   node scripts/test-guide-site-links.js
//
// Link back: the menu every page carries, /learn, /how-to-pay and /llms.txt
// name the guide, as plain links (no tracking parameters, no nofollow), and a
// page links it from a few places, not from every paragraph.
// One owner per general question: this site's explainer pages (/what-is-x402,
// /what-is-mpp, /learn/x402, /learn/mpp) stay served, indexable and canonical
// to themselves, link the guide's explainer in their opening, and are titled
// for how the protocol runs here, not for the general question.
// Offline: the pages are rendered by their modules, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { JSDOM } from "jsdom";
const { GUIDE_SITE, GUIDE_SITE_NAME, GUIDE_EXPLAINERS } = await import("../src/ask402-links.js");
const { learnIndex, learnPage } = await import("../src/learn.js");
const { howToPayPage } = await import("../src/how-to-pay.js");
const { whatIsX402Page } = await import("../src/what-is-x402.js");
const { whatIsMppPage } = await import("../src/what-is-mpp.js");
const { llmsTxt, llmsFullTxt } = await import("../src/seo.js");
const { privacyPage } = await import("../src/privacy.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const B = "https://agent402.tools";
const doc = (html) => new JSDOM(html).window.document;
const guideLinks = (d, scope = d) => [...scope.querySelectorAll("a[href]")].filter((a) => { try { return new URL(a.getAttribute("href"), B).hostname === new URL(GUIDE_SITE).hostname; } catch { return false; } });
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

// ---- the addresses -------------------------------------------------------------------
ok(GUIDE_SITE === "https://www.ask402.ai" && GUIDE_SITE_NAME === "ask402.ai", "the guide's address and name");
ok(GUIDE_EXPLAINERS.x402 === "https://www.ask402.ai/x402/what-is-x402" && GUIDE_EXPLAINERS.mpp === "https://www.ask402.ai/mpp/what-is-mpp", "its x402 and MPP explainers");

// ---- link back: the menu on every page ---------------------------------------------------
const PAGES = {
  "/learn": learnIndex(B),
  "/how-to-pay": howToPayPage(B, null),
  "/privacy": privacyPage(B),
  "/learn/agent-payments": learnPage(B, "agent-payments"),
};
for (const [path, html] of Object.entries(PAGES)) {
  const d = doc(html);
  const desktop = guideLinks(d).filter((a) => a.classList.contains("mlnav-row"));
  const mobile = guideLinks(d).filter((a) => a.classList.contains("ml-mm-link"));
  ok(desktop.length === 1 && desktop[0].getAttribute("href") === GUIDE_SITE && text(desktop[0]) === "ask402.aiplain-language guide", `${path}: the menu names the guide once (${desktop.map(text).join(" | ")})`);
  ok(mobile.length === 1 && mobile[0].getAttribute("href") === GUIDE_SITE && text(mobile[0]) === "ask402.ai · plain-language guide", `${path}: the phone menu names it once (${mobile.map(text).join(" | ")})`);
}
{
  // Beside the other "what this is" entries, where a reader looks for an explainer.
  const d = doc(PAGES["/learn"]);
  const row = guideLinks(d).find((a) => a.classList.contains("mlnav-row"));
  const group = row?.parentElement;
  ok(group && [...group.querySelectorAll("a.mlnav-row")].some((a) => a.getAttribute("href") === "/glossary") && [...group.querySelectorAll("a.mlnav-row")].some((a) => a.getAttribute("href") === "/101"), "the menu entry sits with the walkthrough and the glossary");
}

// ---- link back: the two pages a person reads to learn -------------------------------------
{
  const inBody = (html) => guideLinks(doc(html)).filter((a) => !a.classList.contains("mlnav-row") && !a.classList.contains("ml-mm-link"));
  const learn = inBody(PAGES["/learn"]);
  ok(learn.length === 1 && learn[0].getAttribute("href") === GUIDE_SITE && /For x402 and MPP in plain language, read ask402\.ai\./.test(text(learn[0].closest("p"))), `/learn names the guide in its opening (${learn.map((a) => text(a.closest("p"))).join(" | ").slice(-90)})`);
  const pay = inBody(PAGES["/how-to-pay"]);
  ok(pay.length === 1 && pay[0].getAttribute("href") === GUIDE_SITE && /New to x402 or MPP\? ask402\.ai explains both in plain language\./.test(text(pay[0].closest("p"))), `/how-to-pay names the guide in its opening (${pay.map((a) => text(a.closest("p"))).join(" | ").slice(-90)})`);
  ok(inBody(PAGES["/privacy"]).length === 0 && inBody(PAGES["/learn/agent-payments"]).length === 0, "a page that is not about learning the protocols carries the menu entry only");
}

// ---- link back: the agent-facing index ------------------------------------------------------
{
  // The short index names it in its opening pointers; the full text lists it with the reading list.
  // A line names the guide when one of its words is the guide's name, or an
  // address on the guide's host (the host is parsed and compared whole).
  const guideHosts = new Set([GUIDE_SITE_NAME, new URL(GUIDE_SITE).hostname]);
  const hostOf = (w) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : `https://${w}`).hostname; } catch { return null; } };
  const wordsOf = (l) => l.split(/[\s()[\]<>"']+/).map((w) => w.replace(/[.,:;!?]+$/, "")).filter(Boolean);
  const named = (txt) => txt.split("\n").filter((l) => wordsOf(l).some((w) => guideHosts.has(hostOf(w))));
  const TAIL = " x402 and MPP in plain language, for people: https://www.ask402.ai.";
  const short = named(llmsTxt(B, {})), full = named(llmsFullTxt(B, {}));
  ok(short.length === 1 && short[0].slice(-TAIL.length) === TAIL, `/llms.txt names the guide once, with its other pointers (${short.map((l) => l.slice(-80)).join(" | ")})`);
  ok(full.length === 1 && full[0] === "- [ask402.ai](https://www.ask402.ai): x402 and MPP explained in plain language, for people", `/llms-full.txt lists the guide on one line (${full.join(" | ")})`);
}

// ---- plain links ---------------------------------------------------------------------------
for (const [path, html] of Object.entries({ ...PAGES, "/what-is-x402": whatIsX402Page(B), "/what-is-mpp": whatIsMppPage(B, null), "/learn/x402": learnPage(B, "x402"), "/learn/mpp": learnPage(B, "mpp") })) {
  const links = guideLinks(doc(html));
  ok(links.length >= 2 && links.length <= 4, `${path}: the guide is linked from a few places (${links.length})`);
  ok(links.every((a) => { const u = new URL(a.getAttribute("href")); return u.protocol === "https:" && u.search === "" && u.hash === "" && !/nofollow|sponsored|ugc/.test(a.getAttribute("rel") || "") && (a.getAttribute("rel") || "").split(" ").includes("noopener") && !a.hasAttribute("target"); }), `${path}: each is a plain https link (no query, no nofollow, same tab)`);
}

// ---- one owner per general question ------------------------------------------------------
{
  const { META_TITLE_MAX, META_DESCRIPTION_MAX } = await import("../src/seo-meta.js");
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const { sitemapXml, learnIntegrationUrls } = await import("../src/seo.js");
  const { guidePage } = await import("../src/guides.js");
  const X = GUIDE_EXPLAINERS.x402, M = GUIDE_EXPLAINERS.mpp;
  const EXPLAINERS = [
    { path: "/what-is-x402", html: whatIsX402Page(B), route: 'app.get("/what-is-x402"', title: "x402 on Agent402: how an x402 paid request settles", links: [[X, "What is x402?"], [M, "What is MPP?"]], sentence: "For each protocol in plain language, read What is x402? and What is MPP? on ask402.ai." },
    { path: "/what-is-mpp", html: whatIsMppPage(B, null), route: 'app.get("/what-is-mpp"', title: "MPP on Agent402: how a Machine Payments Protocol payment works", links: [[M, "What is MPP?"]], sentence: "For MPP in plain language, read What is MPP? on ask402.ai." },
    { path: "/learn/x402", html: learnPage(B, "x402"), route: 'app.get("/learn/:slug"', title: "x402 on Agent402: the headers, the offer and the receipt", links: [[X, "What is x402?"]], sentence: "For x402 in plain language, read What is x402? on ask402.ai." },
    { path: "/learn/mpp", html: learnPage(B, "mpp"), route: 'app.get("/learn/:slug"', title: "MPP challenges and credentials: the Payment auth scheme by header", links: [[M, "What is MPP?"]], sentence: "For MPP in plain language, read What is MPP? on ask402.ai." },
  ];
  for (const e of EXPLAINERS) {
    const d = doc(e.html);
    const title = d.querySelector("title")?.textContent || "";
    const desc = d.querySelector('meta[name="description"]')?.getAttribute("content") || "";
    ok(title === e.title && title.length <= META_TITLE_MAX, `${e.path}: titled for the protocol on this server (${title})`);
    ok(!/^what (is|are)\b/i.test(title) && !/plain-language guide|explained$/i.test(title), `${e.path}: the title does not claim the general question`);
    ok(/Agent402|this server/.test(desc) && desc.length > 50 && desc.length <= META_DESCRIPTION_MAX + 10, `${e.path}: the description is about this server (${desc.length} chars: ${desc.slice(0, 70)}...)`);
    // The opening (before the first h2) links the guide's explainer by its question.
    const body = guideLinks(d).filter((a) => !a.classList.contains("mlnav-row") && !a.classList.contains("ml-mm-link"));
    const firstH2 = d.querySelector("h2");
    const inOpening = body.filter((a) => !firstH2 || (a.compareDocumentPosition(firstH2) & 4));
    ok(JSON.stringify(inOpening.map((a) => [a.getAttribute("href"), text(a)])) === JSON.stringify(e.links) && body.length === e.links.length, `${e.path}: its opening links the guide's explainer (${body.map((a) => a.getAttribute("href")).join(", ")})`);
    ok(inOpening.length > 0 && text(inOpening[0].closest("p")).endsWith(e.sentence), `${e.path}: in the sentence "${e.sentence}"`);
    // Still this site's own page: served, canonical to itself, indexable.
    const canon = d.querySelectorAll('link[rel="canonical"]');
    ok(canon.length === 1 && canon[0].getAttribute("href") === `${B}${e.path}`, `${e.path}: canonical is its own address (${canon[0]?.getAttribute("href")})`);
    const robots = d.querySelector('meta[name="robots"]')?.getAttribute("content") || "";
    ok(!/noindex|nofollow/i.test(robots), `${e.path}: indexable (robots: ${robots || "none"})`);
    ok(server.includes(e.route), `${e.path}: still a served route`);
    ok(d.querySelectorAll("h1").length === 1 && d.querySelectorAll("h2").length >= 3, `${e.path}: keeps its own content (${d.querySelectorAll("h2").length} sections)`);
    const article = [...d.querySelectorAll('script[type="application/ld+json"]')].flatMap((x) => { try { const j = JSON.parse(x.textContent); return Array.isArray(j) ? j : (j["@graph"] || [j]); } catch { return []; } }).find((j) => /Article$/.test(j["@type"] || ""));
    ok(article && article.headline === e.title, `${e.path}: the article headline matches the title`);
  }
  // The pages are still listed for crawlers and agents.
  const learnUrls = learnIntegrationUrls(B).map((u) => u.loc), site = sitemapXml(B, {});
  ok(learnUrls.includes(`${B}/learn/x402`) && learnUrls.includes(`${B}/learn/mpp`) && site.includes(`<loc>${B}/what-is-x402</loc>`) && site.includes(`<loc>${B}/what-is-mpp</loc>`), "all four pages stay in the sitemap");
  const full = llmsFullTxt(B, {});
  ok(full.includes(`- [x402 and MPP on Agent402](${B}/what-is-x402) / [MPP on Agent402](${B}/what-is-mpp): how each payment wire runs on this server`), "/llms-full.txt lists both pages by what they cover");
  // A guide that explains the protocol in a paragraph points to the plain-language explainer too.
  const five = guideLinks(doc(guidePage(B, "x402-in-5-minutes"))).filter((a) => !a.classList.contains("mlnav-row") && !a.classList.contains("ml-mm-link"));
  ok(five.length === 1 && five[0].getAttribute("href") === X && /In plain language: What is x402\? on ask402\.ai\.$/.test(text(five[0].closest("p"))), `the five-minute guide links the guide's x402 explainer where it sums up the protocol (${five.map((a) => text(a.closest("p")).slice(-60)).join(" | ")})`);
}

// --- a link to one of this site's explainers is anchored for what the page is ---
// The pages are titled for how the protocol runs here; the general question
// ("What is x402?", "What is MPP?") is the guide's. A link from this site's own
// pages, the README or the wiki that still asks the general question as its
// anchor promises the guide's page and lands on this one.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const root = new URL("..", import.meta.url);
  const STALE = [
    /href="(?:https:\/\/agent402\.tools)?\/what-is-(?:x402|mpp)(?:#[^"]*)?"[^>]*>(?:\s*<[^>]+>)*\s*what is (?:x402|mpp)\b[^<]*/gi, // <a href="/what-is-x402">What is x402?</a>, a nav row's first span
    /\[\s*"\/what-is-(?:x402|mpp)"\s*,\s*"what is [^"]*"\s*\]/gi, // ["/what-is-x402", "What is x402?"]
    /mmLink\(\s*"\/what-is-(?:x402|mpp)"\s*,\s*"what is [^"]*"/gi, // the mobile menu
    /\[what is (?:x402|mpp)\??\]\(https:\/\/agent402\.tools\/what-is-(?:x402|mpp)\)/gi, // markdown
  ];
  const scan = (text) => STALE.flatMap((re) => [...text.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ").slice(0, 110)));
  const controls = ['<a href="/what-is-x402" style="color:var(--ink);">What is x402?</a>', '<a href="/what-is-x402" class="mlnav-row"><span style="font-weight:700;">what is x402</span>', '["/what-is-mpp", "What is MPP? (the full explainer)"]', 'mmLink("/what-is-x402", "what is x402 / MPP", false)', "[What is MPP](https://agent402.tools/what-is-mpp)"];
  ok(controls.every((c) => scan(c).length === 1), "control: each stale anchor form is reported");
  ok(scan('<a href="/what-is-x402">x402 and MPP on Agent402</a> ["/what-is-mpp", "MPP on Agent402"] <a href="/what-is-x402#compare">the comparison table</a> { q: "What is x402?", a: "..." }').length === 0, "control: an anchor for what the page is, and the FAQ's own question, pass");
  const files = [...readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`), "README.md", ...readdirSync(new URL("wiki/", root)).filter((f) => f.endsWith(".md")).map((f) => `wiki/${f}`)];
  const stale = files.flatMap((f) => scan(readFileSync(new URL(f, root), "utf8")).map((hit) => `${f}: ${hit}`));
  ok(files.length > 100 && stale.length === 0, `no link to /what-is-x402 or /what-is-mpp asks the general question as its anchor${stale.length ? ` - ${stale.join(" | ")}` : ""}`);
  // The anchors in use name the page.
  const nav = readFileSync(new URL("src/ledger-chrome.js", root), "utf8");
  ok(nav.includes('mmLink("/what-is-x402", "x402 and MPP on Agent402"') && /href="\/what-is-x402" class="mlnav-row"><span[^>]*>x402 and MPP<\/span><span class="mlnav-faint">on Agent402<\/span>/.test(nav), "the menus name the page for what it is");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
