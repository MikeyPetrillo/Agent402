import { RAILS, RAILS_AMP, RAILS_OS } from "./rails.js";
import { mppChallengeRails } from "./mpp-shim.js";
import { tempoEnabled } from "./mpp-tempo.js";
// Machine Ledger design system — shared chrome for the Agent402 marketing site.
// Exports the status line, nav, footers (full + compact), design-token CSS,
// and a ledgerShell() wrapper that composes a full HTML page.
//
// Pages import ledgerShell() and one of the footer functions, then pass their
// body HTML to get a complete document with SEO metadata and shared chrome.

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Safely embeds a JSON-serializable value into a page for a same-origin
// external script to read (the CSP-hardening replacement for baking
// per-request server data directly into inline JS text - see the 2026-08-16
// migration). MUST escape every "<" in the JSON output: JSON.stringify never
// escapes it, so a string field containing the literal text "</script>"
// (however that got in there - a crawled seller's tool description is
// exactly this kind of untrusted field) would prematurely close the tag and
// let whatever follows execute as HTML/script, a well-known JSON-in-HTML
// pitfall. < is valid inside a JSON string and round-trips through
// JSON.parse to the same "<" character, so this is lossless, not just safe.
// id must be a simple token (enforced) - it becomes a literal attribute
// value, never interpolated from anything that could carry a quote.
const SAFE_ISLAND_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export function jsonScriptTag(id, value) {
  if (!SAFE_ISLAND_ID.test(id)) throw new Error(`jsonScriptTag: unsafe id "${id}"`);
  const json = JSON.stringify(value).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${id}">${json}</script>`;
}

// Official GitHub mark (the "Octocat" silhouette) - fill:currentColor so it
// tracks the surrounding text color (var(--muted), hover states) exactly
// like the plain-text "github" link it replaces used to, with no separate
// color rule needed.
const GITHUB_ICON_SVG = `<svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

// ---------------------------------------------------------------------------
// Head links: Google Fonts + favicons
// Browsers cache favicons in a separate, long-lived store keyed by URL - bump
// the ?v= literal whenever the logo art changes or old marks linger for weeks.
// ---------------------------------------------------------------------------

export const LEDGER_HEAD = `<link rel="preload" href="/fonts/geist-500-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/geist-mono-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:'Geist';font-style:normal;font-weight:300;font-display:swap;src:url(/fonts/geist-300-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist';font-style:normal;font-weight:300;font-display:swap;src:url(/fonts/geist-300-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/geist-400-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/geist-400-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist';font-style:normal;font-weight:500;font-display:swap;src:url(/fonts/geist-500-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist';font-style:normal;font-weight:500;font-display:swap;src:url(/fonts/geist-500-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/geist-600-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/geist-600-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/geist-700-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/geist-700-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/geist-mono-400-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/geist-mono-400-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:500;font-display:swap;src:url(/fonts/geist-mono-500-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:500;font-display:swap;src:url(/fonts/geist-mono-500-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/geist-mono-700-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/geist-mono-700-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
/* Metric-matched fallback faces (fontaine/capsize method, computed from the
   Geist / Geist Mono TTF metrics - upm 1000, ascent 1005, descent 295,
   xAvgCharWidth 567 / 600 - vs Arial / Courier New): the fallback occupies
   the SAME box as the web font, so the swap never reflows (CLS ~0) and the
   brand font shows the moment it loads. Overrides apply to whichever local()
   resolves, so vertical metrics stay matched even on Arial-less systems. */
@font-face{font-family:'Geist Fallback';src:local('Arial'),local('Roboto'),local('Helvetica Neue');size-adjust:128.4531%;ascent-override:78.2387%;descent-override:22.9656%;line-gap-override:0%}
@font-face{font-family:'Geist Mono Fallback';src:local('Courier New'),local('Courier'),local('Roboto Mono');size-adjust:99.9837%;ascent-override:100.5164%;descent-override:29.5048%;line-gap-override:0%}
</style>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3">
<link rel="icon" type="image/png" sizes="512x512" href="/favicon.ico?v=3">
<link rel="shortcut icon" href="/favicon.ico?v=3">
<link rel="apple-touch-icon" href="/logo.png?v=2">`;

// ---------------------------------------------------------------------------
// Design-token CSS + base reset + keyframes + shared chrome styles
// ---------------------------------------------------------------------------

export const LEDGER_CSS = `
/* Hard stop on page-level horizontal scroll: no content should ever push the
   document sideways on a phone. Uses overflow-x: clip (not hidden) so it never
   turns the root into a scroll container - position: sticky (docs TOC) keeps
   working. Wide data tables get their own internal scroll below; everything
   else is made to wrap/fit at mobile widths in the media queries. */
html { overflow-x: clip; }
/* TWO themes, light is the DEFAULT (2026-08-22, second pass): the light "milled"
   palette sits directly on bare :root so the first paint is already light - no
   flash, no pre-paint inline script (CSP forbids inline scripts anyway). The
   obsidian dark palette is an override under :root[data-theme="dark"], set by /js/site-chrome.js
   (synchronous in <head>) from the stored preference BEFORE body paints, and
   toggled by the .ml-theme-toggle button. No OS media query decides the theme.
   Every page-level class that needs a theme-specific surface (milled card,
   obsidian panel, primary button, nav glass, brand mark) goes through the
   tokens below - never a hardcoded hex - so both themes render every page. */
:root[data-theme="dark"] {
  --accent: #34A877;
  --accent-lit: #9EF0B0;
  --on-accent: #0B0C0E;
  --paper: #0B0C0E;
  --card: #141619;
  --card-zebra: #1A1D21;
  --footer-bg: #0E1012;
  --ink: #E9EAEC;
  --ink-panel: #F3F4F5;
  --muted: #B3B9C0;
  /* --faint at 10-13px in shared chrome must clear WCAG AA 4.5:1 against
     --paper, --card, --card-zebra and --footer-bg (test-faint-contrast
     computes it from the FIRST :root block = this default theme). */
  --faint: #8B929A;
  --hairline: #24282C;
  --dash: #353B41;
  --dark-border: #2C3136;
  --dark-border2: #3A4148;
  --cream: #0B0C0E;
  --cream2: #141619;
  --surface: #16191D;
  --on-dark: #E9EAEC;
  --on-dark2: #C9CED3;
  --dk-muted: #9AA1A9;
  --dk-muted2: #B3B9C0;
  --dk-muted3: #868D95;
  --green: #6FCF97;
  --nav-bg: rgba(11,12,14,.82);
  --btn-bg: linear-gradient(180deg,#F6F7F8,#D9DDE1);
  --btn-fg: #0B0C0E;
  --btn-shadow: inset 0 1px 0 #fff,0 8px 20px rgba(0,0,0,.35);
  --brand-mark: linear-gradient(145deg,#F6F7F8,#C9CED3);
  --milled-bg: linear-gradient(160deg,#1C2024 0%,#121417 70%,#16191D 100%);
  --milled-border: rgba(255,255,255,.10);
  --obsidian-bg: linear-gradient(160deg,#1F2328,#121417);
  --obsidian-border: rgba(255,255,255,.10);
  --card-inset: rgba(255,255,255,.04);
  --chip-bg: rgba(255,255,255,.04);
  --shadow-lg: 0 18px 40px rgba(0,0,0,.35);
}
:root { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
:root {
  /* Typography is theme-independent: declared once on the default root. */
  --font-body: 'Geist', 'Geist Fallback', system-ui, sans-serif;
  --font-mono: 'Geist Mono', 'Geist Mono Fallback', monospace;
  --accent: #0F5E43;
  --accent-lit: #9EF0B0;
  --on-accent: #FFFFFF;
  --paper: #F3F4F5;
  --card: #FFFFFF;
  --card-zebra: #EDEFF1;
  --footer-bg: #E8EAEC;
  --ink: #111315;
  --ink-panel: #0C0D0F;
  --muted: #3A3F45;
  --faint: #626970;
  --hairline: #D9DDE1;
  --dash: #C3C9CF;
  --dark-border: #24282C;
  --dark-border2: #353B41;
  --cream: #F3F4F5;
  --cream2: #FFFFFF;
  --surface: #0C0D0F;
  --on-dark: #E9EAEC;
  --on-dark2: #C9CED3;
  --dk-muted: #9AA1A9;
  --dk-muted2: #B3B9C0;
  --dk-muted3: #868D95;
  --green: #23774F;
  --nav-bg: rgba(243,244,245,.86);
  --btn-bg: linear-gradient(180deg,#2A2D31,#111315);
  --btn-fg: #FFFFFF;
  --btn-shadow: inset 0 1px 0 rgba(255,255,255,.14),0 10px 24px rgba(0,0,0,.18);
  --brand-mark: linear-gradient(145deg,#2A2D31,#0B0C0D);
  --milled-bg: linear-gradient(160deg,#F9FAFB 0%,#E3E6E9 70%,#EEF0F2 100%);
  --milled-border: rgba(17,19,21,.12);
  --obsidian-bg: linear-gradient(160deg,#1A1D20,#0C0D0F);
  --obsidian-border: rgba(255,255,255,.08);
  --card-inset: #FFFFFF;
  --chip-bg: rgba(255,255,255,.55);
  --shadow-lg: 0 18px 40px rgba(17,19,21,.10);
  color-scheme: light;
}

body { transition: background-color .18s ease, color .18s ease; }
/* --- mobile hamburger menu (the hover nav dropdowns don't work on touch, and
   the inline links get squeezed to zero on a phone - so ≤880px collapses the
   whole nav into a tap menu) --- */
.ml-burger { display:none; align-items:center; justify-content:center; width:38px; height:34px; padding:0; border:1px solid var(--hairline); border-radius:8px; background:var(--card); color:var(--ink); cursor:pointer; }
.ml-burger .ml-burger-close { display:none; }
.ml-theme-toggle { display:inline-flex; align-items:center; justify-content:center; width:36px; height:34px; padding:0; border:1px solid var(--hairline); border-radius:999px; background:var(--card); color:var(--ink); cursor:pointer; }
.ml-theme-toggle .ml-moon { display:none; } :root[data-theme="dark"] .ml-theme-toggle .ml-moon { display:inline; } :root[data-theme="dark"] .ml-theme-toggle .ml-sun { display:none; }
.ml-mobile-menu { display:none; border-top:1px solid var(--hairline); background:var(--paper); max-height:calc(100vh - 62px); overflow-y:auto; -webkit-overflow-scrolling:touch; }
.ml-mm-h { padding:12px 20px 4px; font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); }
.ml-mm-group { display:flex; flex-direction:column; }
.ml-mm-link { padding:12px 20px; font-family:var(--font-body); font-size:15px; color:var(--ink); text-decoration:none; border-bottom:1px solid var(--hairline); }
.ml-mm-chains { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; padding:12px 20px; border-bottom:1px solid var(--hairline); }
.ml-mm-chip { display:block; padding:9px 12px; border:1px solid var(--hairline); border-radius:8px; background:var(--card); color:var(--ink); text-decoration:none; font-family:var(--font-mono); font-size:13px; text-align:center; }
.ml-mm-chip.ml-mm-active { border-color:var(--accent); color:var(--accent); }
.ml-mm-link:hover, .ml-mm-link:active { background:var(--card-zebra); }
.ml-mm-active { color:var(--accent); font-weight:700; }
.ml-mm-cta { background:var(--btn-bg); color:var(--btn-fg); font-weight:500; border-bottom:none; margin:12px 20px; border-radius:999px; text-align:center; padding:12px 18px; }
/* Two-stage collapse (Aug 2026 revamp): the link row + github hide first at
   1100px and the burger takes over; the CTA button keeps its own slot next to
   the burger until 900px, then folds into the burger menu too (as its first
   row - see mobileMenuHtml). One shared breakpoint value for both stages
   would either crowd the CTA out too early on a mid-size tablet or leave it
   overlapping the burger too late - kept as two literals, both cited here so
   they can't drift apart if one is edited without the other. */
@media (max-width:1100px){
  .ml-nav-links, .ml-nav-gh { display:none !important; }
  .ml-burger { display:inline-flex; }
  html.ml-menu-open .ml-mobile-menu { display:block; }
  html.ml-menu-open .ml-burger-open { display:none; }
  html.ml-menu-open .ml-burger-close { display:inline; }
}
@media (max-width:900px){
  .ml-nav-cta { display:none !important; }
}
@media (min-width:1101px){ .ml-mobile-menu { display:none !important; } }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--paper); font-family: var(--font-body); color: var(--ink); -webkit-font-smoothing: antialiased; }
::selection { background: #34A87744; }
a { color: inherit; }

/* --- nav dropdowns (CSS-only, zero-JS safe) --- */
.mlnav-g { position: relative; }
.mlnav-g > .mlnav-dd { display: none; position: absolute; top: 100%; left: -18px; padding-top: 13px; z-index: 60; }
.mlnav-g:hover > .mlnav-dd, .mlnav-g:focus-within > .mlnav-dd { display: block; }
.mlnav-row:hover { background: var(--card-zebra); }
.ml-nav-link { color: var(--muted); text-decoration: none; border-bottom: 1.5px solid transparent; padding-bottom: 2px; transition: color .15s ease, border-color .15s ease; }
.ml-nav-link:hover { color: var(--ink); border-bottom-color: var(--dash); }
.ml-nav-link-on { color: var(--ink); font-weight: 500; border-bottom-color: var(--ink); }
.ml-nav-link-on:hover { border-bottom-color: var(--accent); }
.ml-nav-glyph { display: inline-block; vertical-align: -2px; margin-right: 1px; opacity: .8; }
.ml-nav-link-on .ml-nav-glyph, .ml-nav-link:hover .ml-nav-glyph { opacity: 1; }
.mlr-row, tr[data-mfb-row] { transition: background-color .12s ease; }
.mlr-row:hover, tr[data-mfb-row]:hover { background: var(--card-zebra); }
.ml-chip { transition: background-color .12s ease, color .12s ease, border-color .12s ease; }
.ml-faq-mark { transition: transform .15s ease; display: inline-block; }
@media (max-width: 600px) { .mlnav-g > .mlnav-dd { display: none !important; } }

/* --- keyframes --- */
@keyframes ml-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

/* --- responsive --- */
@media (max-width: 900px) {
  .ml-ft-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-hero-grid { grid-template-columns: 1fr !important; }
  .ml-2col { grid-template-columns: minmax(0, 1fr) !important; }
  .ml-2col > * { min-width: 0; }
  .ml-slip { grid-template-columns: 1fr !important; }
  .ml-slip-cell { border-right: none !important; border-bottom: 1px solid var(--hairline); }
  .ml-mkts { grid-template-columns: repeat(2, 1fr) !important; }
  .sl-hero { grid-template-columns: 1fr !important; }
  .sl-steps { grid-template-columns: repeat(2, 1fr) !important; }
}
@media (max-width: 600px) {
  .ml-status-in { padding: 8px 16px !important; }
  .ml-status-ticker { display: none !important; }
  .ml-status-left { flex: 1 1 auto; min-width: 0; }
  .ml-nav-in  { padding: 12px 16px !important; gap: 10px !important; }
  .ml-nav-links {
    gap: 12px !important;
    overflow-x: auto !important;
    flex-wrap: nowrap !important;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
  }
  .ml-nav-links > * { flex: none !important; }
  .ml-nav-gh  { display: none !important; }
  .ml-h1      { font-size: 40px !important; }
  .ml-hero-h1 { font-size: 42px !important; }
  .ml-spec-cell { border-right: none !important; }
  .ml-hero-ctas a { flex: 1 1 100%; text-align: center; }
  .ml-hero-eyebrow { display: none !important; }
  .ml-chain-strip-label { font-size: 11px !important; }
  .ml-proof-row { grid-template-columns: 1fr !important; row-gap: 6px !important; }
  .ml-proof-row code { justify-self: start !important; }
  .ml-roster-compact { grid-template-columns: 1fr !important; row-gap: 4px !important; }
  .sl-h1      { font-size: 40px !important; }
  .sl-steps   { grid-template-columns: 1fr !important; }
  /* Long unbreakable strings - seller hosts, payTo addresses, package names -
     must wrap on phones instead of forcing a fixed grid column (and the page)
     wider than the viewport. This is the main source of the horizontal scroll:
     an unwrappable host in a 1fr column sets a min-content floor above 375px. */
  .lb-name, .lb-addr, .mlr-name, .mlr-host, .lb-addr a, pre, code { overflow-wrap: anywhere !important; word-break: break-word !important; }
  /* pre code blocks: wrap long unbreakable tokens (URLs, hashes, one-line
     commands) so they never widen a column past the phone viewport. */
  pre { white-space: pre-wrap !important; }
  /* 4-up stat / method grids and the 8-chain market strip stack tighter so their
     cells never overflow. */
  .lb-totals, .lb-method { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-mkts { grid-template-columns: repeat(2, 1fr) !important; }
  /* Leaderboard table: its five fixed columns (rank + name + usdc + calls +
     buyers) are wider than a phone on their own. Drop to the primary three
     (rank, seller, USDC settled - the headline metric); hide the secondary
     calls/buyers columns and their headers. Full table stays on desktop. */
  .lb-head, .lb-row { grid-template-columns: 26px 1fr auto !important; column-gap: 10px !important; }
  .lb-num, .lb-buyers, .lb-head > span:nth-child(4), .lb-head > span:nth-child(5) { display: none !important; }
}

/* --- home hero (settled-calls proof, spec strip, staggered load) --- */
@keyframes ml-ring { 0% { box-shadow: 0 0 0 0 #34A87766; } 70% { box-shadow: 0 0 0 7px #34A87700; } 100% { box-shadow: 0 0 0 0 #34A87700; } }
@keyframes ml-rise { to { opacity: 1; transform: none; } }
.ml-stagger > * { opacity: 0; transform: translateY(8px); animation: ml-rise .6s ease forwards; }
.ml-stagger > *:nth-child(1) { animation-delay: .02s; }
.ml-stagger > *:nth-child(2) { animation-delay: .10s; }
.ml-stagger > *:nth-child(3) { animation-delay: .18s; }
.ml-stagger > *:nth-child(4) { animation-delay: .26s; }
.ml-stagger > *:nth-child(5) { animation-delay: .34s; }
.ml-stagger > *:nth-child(6) { animation-delay: .42s; }
.ml-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: ml-ring 2s infinite; flex: none; }
.ml-cta { transition: transform .12s ease; }
.ml-cta:hover { transform: translateY(-2px); }
.ml-spec-cell:last-child { border-right: none; margin-right: 0; }
.ml-slip-cell:hover { background: var(--card); }
/* Reveal-on-scroll (Aug 2026 revamp) - opt-in per section via .ml-reveal,
   applied by JS only (see a402InitReveal in ledgerShell's head script), never
   baked in here as a default-hidden state: a JS failure must leave the page
   fully visible, not blank. Class added by JS, transition lives in CSS. */
.ml-reveal { opacity: 0; transform: translateY(18px); transition: opacity .75s cubic-bezier(.22,.61,.36,1), transform .75s cubic-bezier(.22,.61,.36,1); }
.ml-reveal.ml-reveal-in { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  .ml-stagger > * { opacity: 1; transform: none; animation: none; }
  .ml-dot { animation: none; }
  .ml-nav-link, .ml-cta, .mlr-row, tr[data-mfb-row], .ml-chip, .ml-faq-mark { transition: none !important; }
  .ml-cta:hover { transform: none; }
  .ml-reveal, .ml-reveal.ml-reveal-in { opacity: 1 !important; transform: none !important; transition: none !important; }
}
.mfb-label{font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;}
.mfb-tab{font-family:var(--font-mono);font-size:12px;padding:5px 11px;border:1px solid var(--hairline);border-radius:999px;background:var(--card);color:var(--ink);text-decoration:none;white-space:nowrap;}
/* Active tab: accent-as-background - the one pattern that stays legible in BOTH
   themes (white on #BF360C is 5.8:1; --ink/--on-dark flip light in dark mode and
   made the active tab a white blob with invisible text). */
.mfb-tab.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent);}
.mfb-sel,.mfb-search{font-family:var(--font-mono);font-size:12px;padding:6px 10px;border:1px solid var(--hairline);border-radius:8px;background:var(--card);color:var(--ink);}
.mfb-search{flex:1;min-width:120px;}
`;

// ---------------------------------------------------------------------------
// Status line (top of every page)
// ---------------------------------------------------------------------------

// Status band content, Aug 2026 revamp: the old right-hand rails ticker
// repeated the chain list a third time above the fold (nav dropdown + footer
// already carry it) — replaced with tool/rail/fee headline figures instead.
// "500+ tools" stays evergreen per this repo's own convention (never an exact
// catalog count on served-page copy - the design mockup said "531", which
// would just go stale); "12 rails" is RAILS.length, always live-accurate
// since RAILS is this repo's single source of truth for chain count.
function statusLine() {
  return `<div style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:12px;letter-spacing:.02em;border-bottom:1px solid var(--dark-border);">
  <div class="ml-status-in" style="max-width:1180px;margin:0 auto;padding:8px 30px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
    <span class="ml-status-left" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">HTTP/1.1 <span style="color:var(--accent-lit);font-weight:700;">402</span> PAYMENT REQUIRED · <a href="/agentic-finance" style="color:var(--dk-muted);text-decoration:none;">Agentic Finance (AIFI)</a> · <span style="color:var(--dk-muted);">x402 + MPP dual-stack</span></span>
    <span class="ml-status-ticker" style="color:var(--dk-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">500+ tools · ${RAILS.length} rails · <span style="color:var(--accent-lit);">0%</span> seller fee</span>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Nav (sticky, every page)
// ---------------------------------------------------------------------------

// Three zones, divider after zone1 and after zone2: sell/x402/mpp/leaderboard
// | our tools | docs (Aug 2026 revamp — SEO-focused redesign; split into two
// top-level marketplace words 2026-08-17 so both protocols Agent402 indexes
// are equally visible, not one word doing double duty). "sell", "x402" and
// "mpp" stay hover-dropdown TRIGGERS (see PANEL_HTML below): the flat 6-item
// nav in the design spec has no dropdown markup at all, but that structure -
// by-chain rows, smart order router, playground, tollbooth, contribute - was
// itself a deliberate UI/UX pass this same month (see
// chainRowHtml/marketPanelNav/sellPanelHtml below), and dropping it would
// silently remove those pages' most direct desktop-nav path. Decision: adopt
// the new visual language and item SET, keep the dropdown mechanism. "our
// tools" is a new panel (see ourToolsPanelNav) housing catalog/skills/
// playground/pricing, which have no top-level slot in the new 6-item design.
// Ops proof pages (revenue, status) still live in the footer + mobile "More"
// group. The former combined "x402 + mpp" explainer link is gone from the
// top level now that both protocols have their own marketplace word - each
// panel's own footer carries a "what is x402/mpp" row instead (see
// marketPanelNav/mppPanelNav), keeping the top-level word count unchanged
// (was 6, now 7: sell / x402 / mpp / leaderboard / our tools / 101 / docs).
const NAV_ZONES = [
  [
    { href: "/reports", label: "Reports" },
    { href: "/monitors", label: "Monitors" },
    { href: "/tools", label: "Tools", panel: "tools" },
  ],
  [
    // Both are MARKETPLACES (the x402 index and the MPP index) - the shared
    // storefront glyph + title say so; the word is the wire each one indexes.
    { href: "/marketplace", label: "x402", panel: "marketplace", icon: "market", title: "x402 marketplace" },
    { href: "/mpp-marketplace", label: "MPP", panel: "mpp", icon: "market", title: "MPP marketplace" },
    { href: "/leaderboard", label: "Leaderboard" },
  ],
  [
    { href: "/sell", label: "Sell", panel: "sell" },
    { href: "/why", label: "Why" },
    { href: "/docs", label: "Docs" },
  ],
];

// Fallback by-chain rows used whenever no live index-snapshot data is wired
// (offline unit tests, early boot, a throwing/null provider) - the dropdown
// and footer still get real, crawlable links, just without seller counts.
// All 12 rails have a live market page (/base, /solana, /polygon, /arbitrum, /monad,
// /celo, /avalanche, /sei, /optimism, /stellar, /algorand, /robinhood) - this fallback
// must list every one, not just the two that got dedicated routes first.
const STATIC_CHAINS = [
  { label: "base", href: "/base" },
  { label: "solana", href: "/solana" },
  { label: "polygon", href: "/polygon" },
  { label: "arbitrum", href: "/arbitrum" },
  { label: "monad", href: "/monad" },
  { label: "celo", href: "/celo" },
  { label: "avalanche", href: "/avalanche" },
  { label: "sei", href: "/sei" },
  { label: "optimism", href: "/optimism" },
  { label: "stellar", href: "/stellar" },
  { label: "algorand", href: "/algorand" },
  { label: "robinhood", href: "/robinhood" },
];

// Per-chain seller counts/health for the index dropdown + footer are live
// data (crawler + index snapshot), but nav() renders on every page - including
// offline unit tests with no crawler running. server.js wires a provider once
// real data exists; until then (or if it throws) nav() falls back to
// STATIC_CHAINS so it never crashes and never blocks a page render.
let navDataProvider = null;
export function setNavIndexProvider(fn) { navDataProvider = fn; }

function chainRows() {
  try {
    const data = navDataProvider && navDataProvider();
    if (data && Array.isArray(data.chains) && data.chains.length) {
      // Scale rule: EVERY live rail gets a row while the rail count stays
      // human-sized (≤12 - twelve live rails, see #469); only past that does
      // the list truncate to the top 12 with the "all sellers" row carrying
      // the rest. The previous >9 → slice(0,7) rule silently dropped Stellar,
      // Algorand, and Robinhood from the dropdown AND the mobile menu the
      // moment rail #10 shipped - the exact failure its own comment said it
      // was preventing. A ceiling must sit ABOVE the roster it protects.
      const chains = data.chains.length > 12 ? data.chains.slice(0, 12) : data.chains;
      return { chains, live: true };
    }
  } catch { /* provider threw - fall back to the static list below */ }
  return { chains: STATIC_CHAINS, live: false };
}

function chainRowHtml(c, live) {
  if (!live) {
    // No provider data at all - a plain link, never a fabricated count.
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:block;padding:9px 16px;text-decoration:none;color:var(--ink);font-weight:700;">${esc(c.label)}</a>`;
  }
  const known = typeof c.sellers === "number" && c.healthy !== false;
  if (known) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    // Sellers (green health dot) + tool depth on that chain, when we have it -
    // the two numbers an agent picks a chain on. Tools omitted (not zeroed) if
    // the count is missing, never a fabricated 0.
    const toolsSpan = typeof c.tools === "number" && c.tools > 0
      ? `<span style="color:var(--faint);">${fmt(c.tools)} tool${c.tools === 1 ? "" : "s"}</span>`
      : "";
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:10px;"><span style="display:inline-flex;align-items:center;gap:6px;color:var(--green);"><span style="width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;"></span>${fmt(c.sellers)} seller${c.sellers === 1 ? "" : "s"}</span>${toolsSpan}</span></a>`;
  }
  // Provider returned this chain but its data failed - honesty rule:
  // "unavailable", never zero.
  return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:6px;color:var(--faint);"><span style="width:7px;height:7px;border-radius:50%;background:var(--faint);display:inline-block;"></span>unavailable</span></a>`;
}

// Marketplace dropdown - the single buy-side door (the old separate
// "marketplaces" and "index" panels, merged): one row per rail (live
// chainRows/health), and the ink footer row linking the unified /marketplace
// directory. No leaderboard row here (Aug 2026 revamp) - leaderboard is now
// its own top-level nav item, so a row here would just duplicate it one hover
// away from itself.
function marketPanelNav(chainInfo) {
  const rows = chainInfo.chains.map((c) => chainRowHtml(c, chainInfo.live)).join("\n                ");
  return `<span class="mlnav-dd">
              <span style="display:block;width:340px;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--card);box-shadow:0 18px 40px rgba(17,19,21,.12);">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">FIND A TOOL · OR BROWSE SELLERS</span>
                <a href="/tools" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">search our catalog</span><span style="color:var(--faint);">by task</span></a>
                <a href="/guides/smart-order-router" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">smart order router</span><span style="color:var(--faint);">auto-pick a seller</span></a>
                <a href="/playground" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--hairline);"><span style="font-weight:700;">playground</span><span style="color:var(--faint);">try free · PoW</span></a>
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">BY CHAIN</span>
                ${rows}
                <a href="/marketplace/tools" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">every tool indexed</span><span style="color:var(--faint);">ours + third-party</span></a>
                <a href="/agentic-finance" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--hairline);"><span style="font-weight:700;">agentic finance</span><span style="color:var(--faint);">the big picture</span></a>
                <a href="/what-is-x402" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--hairline);"><span style="font-weight:700;">what is x402?</span><span style="color:var(--faint);">start here</span></a>
                <a href="/marketplace" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">the full directory →</span><span style="color:var(--dk-muted);">/marketplace</span></a>
              </span>
            </span>`;
}

// MPP marketplace dropdown (new, split out of the combined "marketplace"
// trigger 2026-08-17 so both protocols get an equally visible top-level nav
// word). No by-chain breakdown here - MPP sellers aren't chain-scoped the
// way x402's rails are, and no live per-category provider is wired at nav
// level yet (kept simple on purpose; see the MPP marketplace plan). Same
// visual pattern as the other two panels.
function mppPanelNav() {
  const rails = mppChallengeRails();
  const acceptedNote = rails.length
    ? `<span style="display:block;padding:8px 16px;font-size:11px;color:var(--faint);${tempoEnabled() ? "" : "border-bottom:1px solid var(--hairline);"}">we accept MPP on ${rails.map((r) => esc(r.name)).join(" & ")}</span>`
    : "";
  // Tempo is a SEPARATE MPP payment method (its own TIP-1034 relay, never
  // x402-settled) — a distinct row, never merged into acceptedNote above.
  const tempoNote = tempoEnabled()
    ? `<span style="display:block;padding:4px 16px 8px;font-size:11px;color:var(--faint);border-bottom:1px solid var(--hairline);">...and natively via Tempo</span>`
    : "";
  return `<span class="mlnav-dd">
              <span style="display:block;width:300px;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--card);box-shadow:0 18px 40px rgba(17,19,21,.12);">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">THE MPP PROTOCOL MARKETPLACE</span>
                ${acceptedNote}
                ${tempoNote}
                <a href="/mpp-marketplace#sellers" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">browse verified sellers</span><span style="color:var(--faint);">live-probed</span></a>
                <a href="/mpp-marketplace#list-api" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">list your API</span><span style="color:var(--faint);">free · one call</span></a>
                <a href="/what-is-mpp" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--hairline);"><span style="font-weight:700;">what is MPP?</span><span style="color:var(--faint);">start here</span></a>
                <a href="/mpp-marketplace" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">the full directory →</span><span style="color:var(--dk-muted);">/mpp-marketplace</span></a>
              </span>
            </span>`;
}

// "Our tools" dropdown (new, Aug 2026 revamp) - catalog/skills/playground/
// pricing, the four items that had a top-level nav slot before the flat
// 6-item redesign left no room for them. Same visual pattern as the other
// two panels.
function ourToolsPanelNav() {
  return `<span class="mlnav-dd">
              <span style="display:block;width:280px;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--card);box-shadow:0 18px 40px rgba(17,19,21,.12);">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">OUR 500+ TOOL CATALOG</span>
                <a href="/tools" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">catalog</span><span style="color:var(--faint);">browse by category</span></a>
                <a href="/skills" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">skill packs</span><span style="color:var(--faint);">one payment, N tools</span></a>
                <a href="/tools/category/crypto" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">crypto, DeFi &amp; Solana</span><span style="color:var(--faint);">perps · yields · token risk</span></a>
                <a href="/tools/category/llm" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">images &amp; video</span><span style="color:var(--faint);">flat per picture or clip</span></a>
                <a href="/playground" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">playground</span><span style="color:var(--faint);">try free · PoW</span></a>
                <a href="/pricing" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">pricing →</span><span style="color:var(--dk-muted);">/pricing</span></a>
              </span>
            </span>`;
}

function sellPanelHtml() {
  return `<span class="mlnav-dd">
              <span style="display:block;width:330px;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--card);box-shadow:0 18px 40px rgba(17,19,21,.12);">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">FOR API SELLERS - GET PAID PER CALL</span>
                <a href="/sell" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">list your API</span><span style="color:var(--faint);">free · health-ranked</span></a>
                <a href="/tollbooth" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">tollbooth</span><span style="color:var(--faint);">pay-per-crawl</span></a>
                <a href="/contribute" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">contribute a tool</span><span style="color:var(--faint);">AGPL · ~15 lines</span></a>
                <a href="/sell" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">start selling →</span><span style="color:var(--dk-muted);">/sell</span></a>
              </span>
            </span>`;
}

const PANEL_HTML = { marketplace: marketPanelNav, mpp: () => mppPanelNav(), sell: sellPanelHtml, tools: () => ourToolsPanelNav() };

function directLinkHtml(l, activePath) {
  const active = l.href === activePath;
  return `<a class="ml-nav-link${active ? " ml-nav-link-on" : ""}" href="${l.href}">${l.label}</a>`;
}

// Storefront glyph marking a nav word as a MARKETPLACE (x402 / MPP indexes).
const MARKET_GLYPH = `<svg class="ml-nav-glyph" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 6.5 3.2 3h9.6L14 6.5"/><path d="M2 6.5c0 1.1.9 2 2 2s2-.9 2-2c0 1.1.9 2 2 2s2-.9 2-2c0 1.1.9 2 2 2s2-.9 2-2"/><path d="M3.5 8.5V13h9V8.5"/><path d="M6.5 13V10.5h3V13"/></svg>`;

function groupTriggerHtml(item, active, panelHtml) {
  const glyph = item.icon === "market" ? `${MARKET_GLYPH} ` : "";
  const title = item.title ? ` title="${esc(item.title)}" aria-label="${esc(item.title)}"` : "";
  return `<span class="mlnav-g" style="display:inline-flex;">
        <a class="ml-nav-link${active ? " ml-nav-link-on" : ""}${item.icon ? " ml-nav-link-market" : ""}" href="${item.href}"${title}>${glyph}${item.label} <span style="font-size:10px;">▾</span></a>
        ${panelHtml}
      </span>`;
}

// A zone can mix direct links and dropdown triggers now (sell/marketplace/
// leaderboard share zone1) - render per item on whether it carries a panel,
// rather than assuming a whole zone is uniformly one or the other.
function navItemHtml(item, activePath, chainInfo, groupHrefs) {
  if (!item.panel) return directLinkHtml(item, activePath);
  return groupTriggerHtml(item, groupHrefs[item.panel].has(activePath), PANEL_HTML[item.panel](chainInfo));
}

const mmLink = (href, label, active, extra = "") =>
  `<a href="${esc(href)}" class="ml-mm-link${active ? " ml-mm-active" : ""}${extra}">${esc(label)}</a>`;

// Mobile menu - every destination flattened into a tap list (the hover
// dropdowns don't work on touch, so the chains, sell, marketplace, and "our
// tools" sub-items all live here directly). Shown ≤1100px via the hamburger;
// hidden on desktop. Groups match the desktop dropdown panels one-for-one
// (Sell / The index / Buy=our-tools / More) - Aug 2026 revamp.
function mobileMenuHtml(chainInfo, activePath) {
  // Chains as a compact 2-column chip grid (12 full-width rows pushed every
  // other destination below the fold on a phone); each still a real <a href>
  // (test-nav-chains asserts every rail's href is present here).
  const chains = chainInfo.chains.map((c) => `<a href="${esc(c.href)}" class="ml-mm-chip${c.href === activePath ? " ml-mm-active" : ""}">${esc(c.label)}</a>`).join("");
  return `<div id="ml-mobile-menu" class="ml-mobile-menu">
    ${activePath === "/reports" ? "" : `<div class="ml-mm-group">${mmLink("/reports", "Get a report →", false, " ml-mm-cta")}</div>`}
    <div class="ml-mm-h">For people</div>
    <div class="ml-mm-group">
      ${mmLink("/reports", "reports · card or USDC", activePath === "/reports")}
      ${mmLink("/monitors", "monitors · monthly, cancel anytime", activePath === "/monitors")}
      ${mmLink("/credits", "credits · pay by card, use every tool", activePath === "/credits")}
    </div>
    <div class="ml-mm-h">Buy</div>
    <div class="ml-mm-group">
      ${mmLink("/tools", "our tools · 500+", activePath === "/tools")}
      ${mmLink("/skills", "skill packs", activePath === "/skills")}
      ${mmLink("/tools/category/crypto", "crypto, DeFi & Solana", activePath === "/tools/category/crypto")}
      ${mmLink("/tools/category/llm", "images, video & LLM gateway", activePath === "/tools/category/llm")}
      ${mmLink("/playground", "playground · free", activePath === "/playground")}
      ${mmLink("/pricing", "pricing", activePath === "/pricing")}
    </div>
    <div class="ml-mm-h">Marketplaces</div>
    <div class="ml-mm-group">
      ${mmLink("/marketplace", "x402 marketplace · every chain", activePath === "/marketplace")}
      ${mmLink("/mpp-marketplace", "mpp marketplace · verified sellers", activePath === "/mpp-marketplace")}
      ${mmLink("/leaderboard", "leaderboard", activePath === "/leaderboard")}
      ${mmLink("/guides/smart-order-router", "smart order router", activePath === "/guides/smart-order-router")}
      ${mmLink("/marketplace/tools", "every tool indexed", activePath === "/marketplace/tools")}
      <div class="ml-mm-chains">${chains}</div>
    </div>
    <div class="ml-mm-h">Sell</div>
    <div class="ml-mm-group">
      ${mmLink("/sell", "list your API", activePath === "/sell")}
      ${mmLink("/tollbooth", "tollbooth · pay-per-crawl", activePath === "/tollbooth")}
      ${mmLink("/contribute", "contribute a tool", activePath === "/contribute")}
    </div>
    <div class="ml-mm-h">More</div>
    <div class="ml-mm-group">
      ${mmLink("/why", "why pay here", activePath === "/why")}
      ${mmLink("/markets", "markets · crypto data", activePath === "/markets")}
      ${mmLink("/docs", "docs", activePath === "/docs")}
      ${mmLink("/101", "x402 & MPP 101 · walkthrough", activePath === "/101")}
      ${mmLink("/what-is-x402", "what is x402 / MPP", activePath === "/what-is-x402")}
      ${mmLink("/agentic-finance", "agentic finance", activePath === "/agentic-finance")}
      ${mmLink("/glossary", "glossary", activePath === "/glossary")}
      ${mmLink("/revenue", "transactions · on-chain", activePath === "/revenue")}
      ${mmLink("/status", "status · uptime", activePath === "/status")}
      ${mmLink("/integrations", "integrations", activePath === "/integrations")}
      ${mmLink("/llms.txt", "llms.txt · for agents", false)}
      <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" class="ml-mm-link">github</a>
    </div>
  </div>`;
}

// Nav CTA is "List your API →" -> /sell (Aug 2026 revamp): seller signup is
// now priority 1 across the whole site (every page's nav CTA points at
// /sell), replacing the old buyer-facing "ADD TO CLAUDE" -> /docs#add button.
// Suppressed on / and /sell themselves, where each page's own hero already
// carries an equivalent CTA - nav + hero both on screen at first paint with
// the same label/destination reads as showing the same button twice. The
// /sell page is expected to grow its own contextual nav-CTA label (e.g.
// "REGISTER NOW ->") once its body is ported in a later stage; suppressing
// for now is the conservative choice rather than guessing at an anchor that
// doesn't exist yet.
function nav(activePath) {
  const chainInfo = chainRows();
  const groupHrefs = {
    // Marketplace trigger lights for /marketplace + every chain page - a
    // future chain page lights it up with zero nav edits. Leaderboard is now
    // its own top-level item (not folded into this set) since it's no longer
    // inside the marketplace panel either.
    marketplace: new Set(["/marketplace", ...chainInfo.chains.map((c) => c.href)]),
    mpp: new Set(["/mpp-marketplace"]),
    sell: new Set(["/sell", "/tollbooth", "/tollbooth/cloud", "/contribute"]),
    tools: new Set(["/tools", "/skills", "/playground", "/pricing"]),
  };

  const zone1 = NAV_ZONES[0].map((item) => navItemHtml(item, activePath, chainInfo, groupHrefs)).join("\n      ");
  const zone2 = NAV_ZONES[1].map((item) => navItemHtml(item, activePath, chainInfo, groupHrefs)).join("\n      ");
  const zone3 = NAV_ZONES[2].map((item) => navItemHtml(item, activePath, chainInfo, groupHrefs)).join("\n      ");
  const divider = `<span style="width:1px;height:15px;background:var(--hairline);flex:none;"></span>`;

  return `<nav style="border-bottom:1px solid var(--hairline);background:var(--nav-bg);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);position:sticky;top:0;z-index:50;">
  <div class="ml-nav-in" style="max-width:1180px;margin:0 auto;padding:15px 30px;display:flex;align-items:center;gap:26px;">
    <a href="/" style="display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink);">
      <span aria-hidden="true" style="width:22px;height:22px;border-radius:6px;background:var(--brand-mark);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 1px 2px rgba(0,0,0,.25);display:inline-block;"></span>
      <span style="font-weight:600;font-size:16px;letter-spacing:-.01em;">Agent402</span>
    </a>
    <div class="ml-nav-links" style="display:flex;align-items:center;gap:22px;margin-left:10px;font-family:var(--font-body);font-size:14px;">
      ${zone1}
      ${divider}
      ${zone2}
      ${divider}
      ${zone3}
    </div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:12px;">
      <a class="ml-nav-gh" href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" aria-label="GitHub" title="GitHub" style="display:flex;align-items:center;color:var(--muted);text-decoration:none;">${GITHUB_ICON_SVG}</a>
      <a class="ml-nav-gh" href="/llms.txt" style="font-family:var(--font-mono);font-size:12px;color:var(--muted);text-decoration:none;padding:8px 13px;border:1px solid var(--hairline);border-radius:999px;background:var(--card);white-space:nowrap;">llms.txt</a>
      ${activePath === "/reports" ? "" : `<a class="ml-nav-cta" href="/reports" style="background:var(--btn-bg);color:var(--btn-fg);font-family:var(--font-body);font-weight:500;font-size:13.5px;text-decoration:none;padding:9px 16px;border-radius:999px;box-shadow:var(--btn-shadow);white-space:nowrap;">Get a report</a>`}
      <button type="button" class="ml-theme-toggle" aria-label="Switch between dark and light theme" title="Theme">
        <svg class="ml-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="ml-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <button type="button" class="ml-burger" aria-label="Open menu" aria-expanded="false">
        <svg class="ml-burger-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        <svg class="ml-burger-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </div>
  ${mobileMenuHtml(chainInfo, activePath)}
</nav>`;
}

// ---------------------------------------------------------------------------
// Footer - full 5-column (home page)
// ---------------------------------------------------------------------------

export function ledgerFooterFull() {
  return `<footer style="border-top:1px solid var(--hairline);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 32px;">
    <div class="ml-ft-grid" style="display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1fr 1fr 1fr;gap:24px;">
      <div>
        <a href="/" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;text-decoration:none;color:var(--ink);">
          <span aria-hidden="true" style="width:22px;height:22px;border-radius:6px;background:var(--brand-mark);display:inline-block;"></span>
          <span style="font-weight:600;font-size:16px;letter-spacing:-.01em;">Agent402</span>
        </a>
        <p style="font-size:13px;line-height:1.6;color:var(--muted);margin:0;max-width:260px;">500+ pay-per-call tools and finished reports for people and agents. USDC over x402 and MPP, or card. Open source.</p>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for people</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/why" style="color:var(--muted);text-decoration:none;">Why pay here</a><a href="/reports" style="color:var(--muted);text-decoration:none;">Reports</a><a href="/monitors" style="color:var(--muted);text-decoration:none;">Monitors</a><a href="/credits" style="color:var(--muted);text-decoration:none;">Credits</a><a href="/faq" style="color:var(--muted);text-decoration:none;">FAQ</a><a href="/company" style="color:var(--muted);text-decoration:none;">Company</a><a href="/security" style="color:var(--muted);text-decoration:none;">Security</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for agents</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/skills" style="color:var(--muted);text-decoration:none;">Skill packs</a><a href="/tools" style="color:var(--muted);text-decoration:none;">Tool catalog</a><a href="/markets" style="color:var(--muted);text-decoration:none;">Markets</a><a href="/tools/category/llm" style="color:var(--muted);text-decoration:none;">LLM gateway</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">Pricing</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">Integrations</a><a href="/playground" style="color:var(--muted);text-decoration:none;">Playground</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">marketplace</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/marketplace" style="color:var(--muted);text-decoration:none;">Marketplace</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">Leaderboard</a><a href="/guides/smart-order-router" style="color:var(--muted);text-decoration:none;">Router</a><a href="/marketplace/tools" style="color:var(--muted);text-decoration:none;">Every tool indexed</a><a href="/revenue" style="color:var(--muted);text-decoration:none;">Transactions</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for sellers</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/sell" style="color:var(--muted);text-decoration:none;">Start selling</a><a href="/tollbooth" style="color:var(--muted);text-decoration:none;">Tollbooth</a><a href="/contribute" style="color:var(--muted);text-decoration:none;">Contribute a tool</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">learn</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/docs" style="color:var(--muted);text-decoration:none;">Docs</a><a href="/quickstart" style="color:var(--muted);text-decoration:none;">Quickstart</a><a href="/guides" style="color:var(--muted);text-decoration:none;">Guides</a><a href="/faq" style="color:var(--muted);text-decoration:none;">FAQ</a><a href="/blog" style="color:var(--muted);text-decoration:none;">Blog</a><a href="/changelog" style="color:var(--muted);text-decoration:none;">Changelog</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">machine</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/openapi.json" style="color:var(--muted);text-decoration:none;">OpenAPI</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="/docs#add" style="color:var(--muted);text-decoration:none;">MCP connector</a><a href="/api/stats" style="color:var(--muted);text-decoration:none;">Stats</a><a href="/api/status" style="color:var(--muted);text-decoration:none;">Status JSON</a><a href="/.well-known/x402" style="color:var(--muted);text-decoration:none;">.well-known/x402</a></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:36px;padding-top:18px;border-top:1px solid var(--hairline);font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <span>© 2026 Havok Holdings LLC · open-source x402 + MCP server · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:underline;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/status" style="color:var(--muted);text-decoration:none;">status</a><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/transparency" style="color:var(--muted);text-decoration:none;">transparency</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Footer - compact single-row (sub-pages)
// ---------------------------------------------------------------------------

export function ledgerFooterCompact() {
  // Three rows, deliberately. The previous compact footer carried 31 links in
  // one undifferentiated wall, which is the same failure as labelling eight
  // transactions tx1..tx8: with no hierarchy nothing reads as important and
  // nothing gets clicked.
  //
  // What was dropped is still reachable - playground, skills, leaderboard,
  // integrations, transactions, glossary, agentic finance and what-is-x402 are
  // all in the sitemap and in the nav, so this costs discoverability nowhere
  // that matters. `transparency` is the exception and stays: it is NOT in the
  // sitemap, so removing its only link would orphan the page outright.
  //
  // The agent row is untouched on purpose. Those are machine surfaces, and
  // test-mcp-self-consistency reads our published text to check an agent can
  // find what we say exists.
  return `<footer style="border-top:1px solid var(--hairline);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:26px 30px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);"><span aria-hidden="true" style="width:18px;height:18px;border-radius:5px;background:var(--brand-mark);display:inline-block;"></span><span style="font-weight:600;font-size:14px;font-family:var(--font-sans);letter-spacing:-.01em;">Agent402</span></a>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/reports" style="color:var(--muted);text-decoration:none;">reports</a><a href="/monitors" style="color:var(--muted);text-decoration:none;">monitors</a><a href="/credits" style="color:var(--muted);text-decoration:none;">credits</a><a href="/tools" style="color:var(--muted);text-decoration:none;">catalog</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">pricing</a><a href="/marketplace" style="color:var(--muted);text-decoration:none;">marketplace</a><a href="/sell" style="color:var(--muted);text-decoration:none;">sell</a><a href="/docs" style="color:var(--muted);text-decoration:none;">docs</a><a href="/why" style="color:var(--muted);text-decoration:none;">why</a><a href="/security" style="color:var(--muted);text-decoration:none;">security</a><a href="/company" style="color:var(--muted);text-decoration:none;">company</a></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--hairline);">
      <span>© 2026 Havok Holdings LLC · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:underline;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/status" style="color:var(--muted);text-decoration:none;">status</a><a href="/transparency" style="color:var(--muted);text-decoration:none;">transparency</a><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:10px;">
      <span style="letter-spacing:.1em;text-transform:uppercase;">for agents</span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="/openapi.json" style="color:var(--muted);text-decoration:none;">openapi.json</a><a href="/.well-known/x402" style="color:var(--muted);text-decoration:none;">.well-known/x402</a><a href="/api/pricing" style="color:var(--muted);text-decoration:none;">/api/pricing</a><a href="/api/stats" style="color:var(--muted);text-decoration:none;">/api/stats</a><a href="/api/status" style="color:var(--muted);text-decoration:none;">/api/status</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Settlement tape - scrolling marquee of recent paid calls
// ---------------------------------------------------------------------------

function agoStr(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

// The scrolling "●●● TAPE" band of recent calls was REMOVED 2026-07-25. It was
// the homepage's only live-proof element and it argued against the page: on a
// site headlined "where agents pay agents", the tape showed 23 of 25 calls on
// the free proof-of-work rail, one of them our own heartbeat probe, across just
// five trivial tools (base64, hash, unit-convert, timezone-convert). Real
// revenue at the same moment — transcribe, search, the skill packs — never
// appeared, because the feed was ordered by recency and the cheap free calls
// dominate by volume. A proof band that quietly contradicts the headline is
// worse than none. The cumulative "N calls settled to date" counter in the hero
// stays; it is a real number that does not misrepresent the mix.

// ---------------------------------------------------------------------------
// Full HTML document shell
// ---------------------------------------------------------------------------

/**
 * Wraps page content in a complete HTML document with status line, nav,
 * SEO metadata, design-token CSS, and optional page-specific CSS.
 *
 * @param {object} opts
 * @param {string} opts.title       - <title> tag content
 * @param {string} opts.description - meta description
 * @param {string} opts.canonical   - canonical URL
 * @param {string} opts.baseUrl     - base URL for OG image default
 * @param {string} opts.activePath  - nav link to highlight ("" for home)
 * @param {string} [opts.ogImage]   - OG image URL (defaults to baseUrl/card.png)
 * @param {object|object[]} [opts.jsonLd] - JSON-LD structured data
 * @param {string} [opts.extraCss]  - page-specific CSS
 * @param {string} [opts.robots]    - robots meta (default index,follow; pass "noindex, nofollow" for bearer-URL pages)
 * @param {string} opts.body        - main content HTML (including footer)
 */
// Social crawlers (X, Slack, Discord, …) cache the card image by its exact URL,
// so a fixed /card.png keeps showing a stale tool count long after it changes.
// The server stamps the current count here at boot; the query param makes every
// count change a new image URL, which busts those caches on the next crawl.
let ogImageVersion = "";
export function setOgImageVersion(v) { ogImageVersion = String(v || ""); }

// Cookieless client-side analytics: $pageview + $pageleave (bounce/duration) +
// $web_vitals, loaded and ingested FIRST-PARTY through /e (the reverse proxy in
// server.js) so the browser never touches a third-party host and CSP stays at
// 'self'. persistence:'sessionStorage' means NO cookies and no cross-visit
// tracking, but sessions stay coherent within a single visit so bounce/duration
// and web-vitals actually compute. autocapture + session recording are OFF.
// Env-gated on the public project key (POSTHOG_API_KEY); renders nothing without it.
function posthogSnippet(baseUrl) {
  const key = process.env.POSTHOG_API_KEY || "";
  if (!key) return "";
  const cfg = {
    api_host: `${baseUrl}/e`,
    ui_host: "https://us.posthog.com",
    persistence: "sessionStorage",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    capture_performance: { web_vitals: true, network_timing: false },
    disable_session_recording: true,
    disable_surveys: true,
  };
  // The vendor loader itself is 100% static (assets/js/posthog-loader.js);
  // only the API key and per-deployment config vary, so they ride as a JSON
  // island the loader reads at runtime instead of being templated into JS
  // text (CSP hardening, 2026-08-16).
  return jsonScriptTag("posthog-config", { key, cfg }) + '<script src="/js/posthog-loader.js"></script>';
}
export function ledgerShell({ title, description, canonical, baseUrl, activePath = "", ogImage, jsonLd, extraCss = "", body, robots = "index, follow, max-image-preview:large" }) {
  const og = ogImage || (baseUrl + "/card.png" + (ogImageVersion ? `?v=${ogImageVersion}` : ""));
  // Base ecosystem JSON-LD - every page rendered through the ledger shell
  // carries this so crawlers and discovery agents see Base chain support
  // regardless of which page they land on.
  const baseEcosystemLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${baseUrl}/#base-app`,
    name: "Agent402 on Base",
    applicationCategory: "BlockchainApplication",
    operatingSystem: RAILS_OS,
    description: `x402 pay-per-call agent tools settling in ${RAILS_AMP}. Available as a Base MCP plugin (app ID 6a3dd86ca341d86b910769fb). Gas is sponsored on EVM chains - callers need only the stablecoin.`,
    url: baseUrl,
  };
  const allLd = [baseEcosystemLd, ...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [])];
  // Every "<" is escaped as \u003c, exactly as jsonScriptTag does and for the
  // same reason: JSON.stringify never escapes it, so a string field carrying
  // the literal text "</script>" would close this tag early and let whatever
  // follows execute as markup. Any page whose JSON-LD embeds text we did not
  // author (a crawled seller description, a filer name off an SEC filing) is
  // exactly that case. "<" is valid inside a JSON string and round-trips
  // through JSON.parse unchanged, so this is lossless for consumers.
  const jsonLdBlock = allLd
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<script src="/js/site-chrome.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${esc(robots)}">
${process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">\n` : ""}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="Agent402.Tools">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Agent402Tools">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(og)}">
<meta name="base:app_id" content="6a3dd86ca341d86b910769fb" />
${LEDGER_HEAD}
<style>${LEDGER_CSS}${extraCss}</style>
${jsonLdBlock}
${posthogSnippet(baseUrl)}
</head>
<body style="overflow-x:hidden;">
${nav(activePath)}
<main>${body}</main>
</body>
</html>`;
}
