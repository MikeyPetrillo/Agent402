// Reveal-on-scroll must be a SHARED mechanism, not a per-page opt-in copied
// into every page's own script - the exact shape that let the effect exist
// on the homepage but nowhere else on the site for weeks. Locks two things:
//
//  1. The observer init in ledger-chrome.js's shared <head> script selects
//     "header,section,[data-reveal]" - broadening it back down to only
//     "[data-reveal]" would silently un-fix every page that relies on it
//     applying automatically (no page other than legacy [data-reveal] users
//     would opt in on its own).
//  2. A sample of real, booted pages that are SUPPOSED to be section-based
//     (homepage, /marketplace, chain pages, and the other site-revamp
//     pages) actually renders real <section>/<header> markup for the
//     shared selector to reach - catching a regression where a page's
//     template quietly reverts to <div>-only, which would silently drop it
//     from reveal-on-scroll with no test failure anywhere else. This is a
//     static-markup check (no browser, matching this suite's own idiom),
//     not a runtime assertion that the class actually gets applied - the
//     shared script's own try/catch means a JS failure fails open (visible
//     content), which this test cannot observe from raw HTML alone.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-reveal-coverage.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- the shared script's selector must stay broad, not opt-in-only --------
// Lives in assets/js/site-chrome.js (external file, CSP hardening,
// 2026-08-16) - was inline in src/ledger-chrome.js's shared <head> script
// before that.
const chromeSrc = readFileSync(join(ROOT, "assets", "js", "site-chrome.js"), "utf8");
ok(/querySelectorAll\('header,section,\[data-reveal\]'\)/.test(chromeSrc),
  "shared reveal-on-scroll observer selects header/section site-wide, not just [data-reveal] opt-ins");

// --- every page that HAS section/header elements must keep at least the
// count it had when this was locked in - an exact floor, not just ">0", so
// a partial regression (one section quietly reverting to a <div>, not the
// whole page) still fails instead of hiding behind the sections that
// weren't touched. Bumping a number here is expected and fine when a page
// legitimately gains/loses a section; a silent drop is what this catches.
//
// Script tags are stripped before counting: this reveal-on-scroll script's
// OWN explanatory comments used to mention the literal substrings
// "<section>" and "<header " while it was inline on every page (via
// ledger-chrome.js's shared <head> script), which the naive regex below
// counted as real elements - inflating every single page's count by
// exactly 2 and hiding behind it since the floors were calibrated against
// that inflated number. Externalizing the script (CSP hardening,
// 2026-08-16) correctly dropped those two per-page phantom matches, and the
// floors below are recalibrated against the TRUE element count so this
// test measures the same "real elements" it always claimed to. */
const MIN_SECTIONS = {
  "/": 9, "/base": 4, "/marketplace": 7, "/pricing": 6, "/leaderboard": 5, "/skills": 6, "/tools": 4, "/what-is-x402": 10, "/sell": 9,
  "/docs": 6, "/status": 4, "/faq": 2, "/revenue": 4, "/playground": 2, "/badges": 3, "/compare": 6, "/community": 6,
  "/changelog": 2, "/blog": 2, "/transparency": 2, "/privacy": 2, "/terms": 2,
  "/workflows": 3, "/quickstart": 3, "/guides": 2,
};
for (const [path, min] of Object.entries(MIN_SECTIONS)) {
  const html = await (await fetch(`${BASE}${path}`)).text();
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const realSectionCount = (stripped.match(/<section[ >]/g) || []).length + (stripped.match(/<header[ >]/g) || []).length;
  ok(realSectionCount >= min, `${path}: has at least ${min} real <section>/<header> elements to reveal (got ${realSectionCount})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
