// Reveal-on-scroll ([data-reveal] sections) — offline unit tests. No network,
// no browser: string assertions on the reveal-on-scroll script, matching
// this repo's established pattern for validating script correctness
// structurally (see test-theme.js's site-chrome.js checks). CSP hardening
// (2026-08-16) moved this script out of ledgerShell's inline <script> into
// assets/js/site-chrome.js - the CSS-hidden-state assertions still check the
// page HTML (that part didn't move), but the script-behavior assertions now
// read the external file directly.
//
// Real bug this locks in (found 2026-08-14 from a live mobile report - "some
// screens go off screen while scrolling"): the observer used to TOGGLE
// ml-reveal-in on every intersection change, adding it when a section entered
// view and REMOVING it the moment the section's visible fraction dropped
// under the 8% threshold - including while the section was still partially
// on screen, scrolling past the top edge. A user scrolling down watched
// content fade out and shift 18px *while still looking at it*, which reads
// exactly like "it went off screen" on an ordinary scroll, not a rendering
// bug. Fixed to one-shot: reveal once, unobserve, never re-hide - the
// standard behaviour for every scroll-reveal effect on the web, and the only
// half of the old behaviour the "reload deep in the page still animates"
// goal ever actually needed (a section already in view on the observer's
// first callback reveals immediately regardless of whether removal exists).
//
//   node scripts/test-reveal-on-scroll.js
import { readFileSync } from "node:fs";
import { ledgerShell } from "../src/ledger-chrome.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const html = ledgerShell({
  title: "t", description: "d", canonical: "https://agent402.tools/x",
  baseUrl: "https://agent402.tools", body: "<main>hi</main>",
});

ok(/<script src="\/js\/site-chrome\.js\?v=[a-z0-9]+" defer>/.test(html),
  "every ledgerShell page references the external site-chrome script carrying reveal-on-scroll");
const src = readFileSync(new URL("../assets/js/site-chrome.js", import.meta.url), "utf8");
const scriptMatch = /document\.addEventListener\('DOMContentLoaded',function\(\)\{try\{if\(window\.matchMedia[\s\S]*?data-reveal[\s\S]*?\}catch\(e\)\{\}\}\);/.test(src);
ok(scriptMatch, "the reveal-on-scroll bootstrap script is present in site-chrome.js");

// The exact regression: toggling ml-reveal-in with isIntersecting as the
// second argument removes the class again once a section stops intersecting.
ok(!/classList\.toggle\(['"]ml-reveal-in['"]/.test(src), "the observer never toggles ml-reveal-in (that removes it again on scroll-past)");
ok(/classList\.add\(['"]ml-reveal-in['"]\)/.test(src), "the observer only ever ADDS ml-reveal-in, never conditionally");
ok(/if\(e\.isIntersecting\)/.test(src), "the add is still gated on isIntersecting - only reveal what's actually in view");
ok(/io\.unobserve\(e\.target\)/.test(src), "a revealed section is unobserved - one-shot, matching every other scroll-reveal effect on the web");

// prefers-reduced-motion must still bypass the whole mechanism (unchanged by
// this fix - a real accessibility requirement, not incidental to it).
ok(/prefers-reduced-motion/.test(src), "prefers-reduced-motion still short-circuits the observer entirely");

// The CSS hidden state (opacity 0, translateY) must still exist and only
// apply via the JS-added .ml-reveal class, never baked into a bare selector -
// a throw/no-run must leave every section visible, not stuck invisible.
ok(html.includes(".ml-reveal { opacity: 0"), "the hidden state is scoped to the JS-added .ml-reveal class");
ok(!/^\s*\[data-reveal\]\s*\{[^}]*opacity:\s*0/m.test(html), "no bare [data-reveal] selector defaults content to invisible in CSS");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
