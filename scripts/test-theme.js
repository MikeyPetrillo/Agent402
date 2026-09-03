// Theme contract — offline unit tests. No network.
//
// 2026-08-22: TWO themes, dark is the DEFAULT. The dark palette sits directly
// on bare :root (first paint is already dark, no script needed, no flash); the
// obsidian dark palette is an override block under :root[data-theme="dark"],
// applied by /js/site-chrome.js (synchronous in <head>, reads the stored
// preference BEFORE body paints) and flipped by the .ml-theme-toggle button.
// No OS media query decides the theme, no inline script, no inline onclick.
//
// These assertions exist because a HALF-done theme is worse than either state:
// a light token that lives only in the override, a toggle without the pre-paint
// read (flash), or a page class with a hardcoded hex that only works in one
// theme should fail here rather than ship a page that is dark in some places
// and white in others.
//
//   node scripts/test-theme.js
import { ledgerShell, LEDGER_CSS } from "../src/ledger-chrome.js";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const html = ledgerShell({
  title: "t", description: "d", canonical: "https://agent402.tools/x",
  baseUrl: "https://agent402.tools", body: "<main>hi</main>",
});

// --- the bare :root palette IS the light (default) palette --------------------
const rootStart = LEDGER_CSS.indexOf(":root {");
const rootBlock = LEDGER_CSS.slice(rootStart, LEDGER_CSS.indexOf("\n}", rootStart));
const darkStart = LEDGER_CSS.indexOf(':root[data-theme="dark"] {');
const darkBlock = darkStart >= 0 ? LEDGER_CSS.slice(darkStart, LEDGER_CSS.indexOf("\n}", darkStart)) : "";
const tokIn = (block, name) => (block.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim() || "";
const tok = (name) => tokIn(rootBlock, name);
const dtok = (name) => tokIn(darkBlock, name);
const isDark = (h) => /^#[0-3]/.test(h);      // #0B0C0E, #141619, #24282C…
const isLight = (h) => /^#[C-Fc-f]/.test(h);  // #F3F4F5, #FFFFFF, #E9EAEC…

ok(isLight(tok("--paper")), `default page background is light (--paper ${tok("--paper")})`);
ok(isDark(tok("--ink")), `default foreground is dark (--ink ${tok("--ink")})`);
ok(isLight(tok("--card")), `default cards are light (--card ${tok("--card")})`);
ok(isLight(tok("--on-dark")), `text on obsidian surfaces stays light in both themes (--on-dark ${tok("--on-dark")})`);
ok(/:root \{ color-scheme: light; \}/.test(LEDGER_CSS), "bare :root declares color-scheme: light (form controls + scrollbars match the default)");

// --- the dark theme is a complete override, not a partial one ------------------
ok(darkBlock.length > 0, "a :root[data-theme=\"dark\"] override block exists");
ok(isDark(dtok("--paper")) && isLight(dtok("--ink")) && isDark(dtok("--card")), `dark override flips paper/ink/card (${dtok("--paper")} / ${dtok("--ink")} / ${dtok("--card")})`);
ok(/:root\[data-theme="dark"\] \{ color-scheme: dark; \}/.test(LEDGER_CSS), "dark override sets color-scheme: dark");
const rootNames = [...rootBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => !n.startsWith("font-"));
const darkNames = new Set([...darkBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
const missing = rootNames.filter((n) => !darkNames.has(n));
ok(missing.length === 0, `every default token has a dark counterpart${missing.length ? ` - MISSING: ${missing.map((n) => "--" + n).join(", ")}` : ""}`);
ok(!/prefers-color-scheme/.test(LEDGER_CSS) && !html.includes("prefers-color-scheme"), "no OS preference media query decides the palette (light is the default, the user flips it)");

// --- theme-specific surfaces go through tokens, never hardcoded hex -------------
for (const name of ["--btn-bg", "--btn-fg", "--nav-bg", "--brand-mark", "--milled-bg", "--obsidian-bg", "--chip-bg", "--card-inset", "--on-accent"]) {
  ok(tok(name) && dtok(name), `${name} is defined in BOTH themes (surfaces that differ per theme ride tokens)`);
}

// --- the toggle: present, CSP-clean, no flash --------------------------------
ok(html.includes('class="ml-theme-toggle"'), "the theme toggle button is in the nav");
ok(html.includes("ml-moon") && html.includes("ml-sun"), "moon + sun glyphs ship (CSS shows one per theme)");
ok(!/\bonclick\s*=/.test(html), "no inline onclick attribute anywhere - CSP-blocked, must be wired via addEventListener");
ok(!/<script>[^<]*localStorage/.test(html) && !/<script>[\s\S]{0,400}data-theme/.test(html), "no inline pre-paint theme script in the page (CSP); the external site-chrome.js does it");
ok(!/<html[^>]*data-theme/.test(html) && !/<body[^>]*data-theme/.test(html), "the server never stamps data-theme on the document (the default is the bare :root; only the client's stored preference sets light)");
const siteChromeJs = readFileSync(new URL("../assets/js/site-chrome.js", import.meta.url), "utf8");
const headOnly = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
ok(headOnly.includes('<script src="/js/site-chrome.js">'), "site-chrome.js is referenced in <head> (synchronous) so the stored theme applies before first paint");
ok(/localStorage\.getItem\('a402-theme'\)/.test(siteChromeJs.slice(0, 1200)) && /setAttribute\('data-theme','dark'\)/.test(siteChromeJs.slice(0, 1200)), "site-chrome.js applies a stored dark preference at the very top (pre-paint)");
ok(/\.ml-theme-toggle/.test(siteChromeJs) && /localStorage\.setItem\('a402-theme'/.test(siteChromeJs) && siteChromeJs.includes("addEventListener('click'"), "site-chrome.js wires the toggle via addEventListener and stores the choice");
ok(!html.includes("a402ToggleTheme"), "no global toggle function is referenced from markup");

// --- CSS hygiene (historical incidents) ----------------------------------------
ok((LEDGER_CSS.match(/\{/g) || []).length === (LEDGER_CSS.match(/\}/g) || []).length, "LEDGER_CSS braces balance");
const stranded = [...LEDGER_CSS.matchAll(/\}\s*([^\n{}]*)\/\*/g)].map((m) => m[1].trim()).filter(Boolean);
ok(stranded.length === 0, `no selector text stranded before a comment${stranded.length ? ` (found "${stranded[0].slice(0, 60)}")` : ""}`);
ok(!/\n\s*\/\/[^\n]*\n[^}]*\}/.test(rootBlock), "no // comment inside the :root block (it would kill every token after it)");
ok((html.match(/<script[\s>]/gi) || []).length === (html.match(/<\/script>/gi) || []).length, "script tags balance (an orphaned </script> means a stripped opening tag)");
ok(!/\n\s*function\s+\w+\s*\(/.test(headOnly), "no bare function declaration sitting outside a <script> in <head>");
ok(/function\s+toggleMenu\s*\(/.test(siteChromeJs) && siteChromeJs.includes(".ml-burger"), "site-chrome.js still defines the burger menu toggle");

// --- the revenue chart palette follows the theme ---------------------------------
const revenueSrc = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
ok(/\.rvz\{--s1:#3987e5/.test(revenueSrc), "the chart's dark series palette is the one that ships by default");


// ---- No dark-theme text on a light-theme surface, on the same element ---------
// Found 2026-09-02 on prod's /tools: two <pre> blocks styled
// background:var(--paper) + color:var(--on-dark) - a leftover from the
// dark-first day - rendered near-white text on the light page, i.e. an
// invisible code sample (seven such blocks across /tools, /sell and
// /what-is-x402). The light palette is the default, so a light ground token
// paired with a dark-ground ink token on one element is always unreadable in
// the default theme. Every page module is swept; the only legal pairing for
// on-dark / dk-muted text is an obsidian ground (--surface, --ink-panel,
// --obsidian-bg, --dark-border panels).
{
  const { readdirSync } = await import("node:fs");
  const LIGHT_GROUND = /background(?:-color)?:\s*var\(--(?:paper|card|card-zebra|milled-bg)\)/;
  const DARK_INK = /color:\s*var\(--(?:on-dark2?|dk-muted[23]?)\)/;
  const offenders = [];
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/style="([^"]*)"/g)) {
      if (LIGHT_GROUND.test(m[1]) && DARK_INK.test(m[1])) offenders.push(`${f}: ${m[1].slice(0, 90)}`);
    }
  }
  ok(offenders.length === 0, `no inline style pairs a light ground with dark-theme ink on one element (${offenders.length ? offenders.join(" | ") : "clean"})`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
