#!/usr/bin/env node
// The plain-English guide (ask402.ai, a site this project's maintainer also
// operates) and this site's own explainer pages.
//
//   node scripts/test-guide-site-links.js
//
// Link back: the menu every page carries, /learn, /how-to-pay and /llms.txt
// name the guide, as plain links (no tracking parameters, no nofollow), and a
// page links it from a few places, not from every paragraph.
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
  ok(desktop.length === 1 && desktop[0].getAttribute("href") === GUIDE_SITE && text(desktop[0]) === "ask402.aiplain-English guide", `${path}: the menu names the guide once (${desktop.map(text).join(" | ")})`);
  ok(mobile.length === 1 && mobile[0].getAttribute("href") === GUIDE_SITE && text(mobile[0]) === "ask402.ai · plain-English guide", `${path}: the phone menu names it once (${mobile.map(text).join(" | ")})`);
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
  const main = (html) => doc(html).querySelector("main") || doc(html).body;
  const inBody = (html) => guideLinks(doc(html)).filter((a) => !a.classList.contains("mlnav-row") && !a.classList.contains("ml-mm-link"));
  const learn = inBody(PAGES["/learn"]);
  ok(learn.length === 1 && learn[0].getAttribute("href") === GUIDE_SITE && /For x402 and MPP in plain English, read ask402\.ai\./.test(text(learn[0].closest("p"))), `/learn names the guide in its opening (${learn.map((a) => text(a.closest("p"))).join(" | ").slice(-90)})`);
  const pay = inBody(PAGES["/how-to-pay"]);
  ok(pay.length === 1 && pay[0].getAttribute("href") === GUIDE_SITE && /New to x402 or MPP\? ask402\.ai explains both in plain English\./.test(text(pay[0].closest("p"))), `/how-to-pay names the guide in its opening (${pay.map((a) => text(a.closest("p"))).join(" | ").slice(-90)})`);
  ok(inBody(PAGES["/privacy"]).length === 0 && inBody(PAGES["/learn/agent-payments"]).length === 0, "a page that is not about learning the protocols carries the menu entry only");
  void main;
}

// ---- link back: the agent-facing index ------------------------------------------------------
{
  // The short index names it in its opening pointers; the full text lists it with the reading list.
  const named = (txt) => txt.split("\n").filter((l) => l.includes("ask402.ai"));
  const short = named(llmsTxt(B, {})), full = named(llmsFullTxt(B, {}));
  ok(short.length === 1 && short[0].endsWith(" x402 and MPP in plain English, for people: https://www.ask402.ai."), `/llms.txt names the guide once, with its other pointers (${short.map((l) => l.slice(-80)).join(" | ")})`);
  ok(full.length === 1 && full[0] === "- [ask402.ai](https://www.ask402.ai): x402 and MPP explained in plain English, for people", `/llms-full.txt lists the guide on one line (${full.join(" | ")})`);
}

// ---- plain links ---------------------------------------------------------------------------
for (const [path, html] of Object.entries({ ...PAGES, "/what-is-x402": whatIsX402Page(B), "/what-is-mpp": whatIsMppPage(B, null), "/learn/x402": learnPage(B, "x402"), "/learn/mpp": learnPage(B, "mpp") })) {
  const links = guideLinks(doc(html));
  ok(links.length >= 2 && links.length <= 4, `${path}: the guide is linked from a few places (${links.length})`);
  ok(links.every((a) => { const u = new URL(a.getAttribute("href")); return u.protocol === "https:" && u.search === "" && u.hash === "" && !/nofollow|sponsored|ugc/.test(a.getAttribute("rel") || "") && (a.getAttribute("rel") || "").split(" ").includes("noopener") && !a.hasAttribute("target"); }), `${path}: each is a plain https link (no query, no nofollow, same tab)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
