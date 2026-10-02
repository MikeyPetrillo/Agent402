// The market terminal's contract: palette, contrast, escaping, and the
// honesty of what it renders. Offline, no browser, no network.
//
// A dense data surface is where two things normally get given away. The first
// is contrast: 10-12px text on a busy grid is exactly where a designer reaches
// for a dim grey that fails WCAG, and nothing catches it because the page
// "looks fine" at the size it was designed at. The second is theming: one
// hardcoded hex in a grid rule survives review and then renders invisible in
// the other theme, because the author only ever looked at one. So this file
// computes real WCAG relative-luminance contrast for every palette colour on
// every surface it is composited on, in BOTH themes, and fails on any literal
// hex in the stylesheet or the rendered markup.
//
//   node scripts/test-terminal-tokens.js
import { readFileSync } from "node:fs";
import {
  TERMINAL_CSS, marketTerminalHtml, terminalRoster, terminalStatusBar,
  terminalTicker, terminalMetrics, sparkline, trendOf, compactUsd, observedSlice,
} from "../src/market-terminal.js";
import { LEDGER_CSS } from "../src/ledger-chrome.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- palette: defined in both themes ---------------------------------------
const block = (marker) => {
  const i = LEDGER_CSS.indexOf(marker);
  return i < 0 ? "" : LEDGER_CSS.slice(i, LEDGER_CSS.indexOf("\n}", i));
};
const light = block(":root {");
const dark = block(':root[data-theme="dark"] {');
ok(light.length > 0 && dark.length > 0, "both theme blocks found in LEDGER_CSS");

const tokenIn = (b, name) => (b.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim() || "";
const hexIn = (b, name) => (tokenIn(b, name).match(/^#[0-9a-fA-F]{6}$/) || [])[0] || null;

// Properties TERMINAL_CSS declares for itself (e.g. --t-row-h on .t-wrap) are
// not theme tokens and must not be demanded of the theme blocks.
const selfDeclared = new Set([...TERMINAL_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = [...new Set([...TERMINAL_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
ok(used.length >= 15, `the stylesheet is actually token-driven (${used.length} distinct tokens referenced)`);

// Typography is theme-independent by design and lives only on the default
// root - the same carve-out scripts/test-theme.js makes.
const needsBothThemes = used.filter((v) => !v.startsWith("--font-") && !selfDeclared.has(v));
const unresolved = needsBothThemes.filter((v) => !light.includes(`${v}:`) || !dark.includes(`${v}:`));
ok(unresolved.length === 0, `every themed token the terminal uses is defined in BOTH themes${unresolved.length ? ` - MISSING: ${unresolved.join(", ")}` : ""}`);

// --- contrast --------------------------------------------------------------
function relLum(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = (x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
// Control: the extractor and the maths must be shown to work before any clean
// result below is believed. Black on white is 21:1; a colour against itself
// is 1:1. If either of these drifts, every assertion under it is noise.
ok(Math.abs(contrast("#000000", "#FFFFFF") - 21) < 0.01, "control: contrast() computes 21:1 for black on white");
ok(Math.abs(contrast("#4FD1D9", "#4FD1D9") - 1) < 0.001, "control: contrast() computes 1:1 for a colour on itself");
ok(hexIn(light, "--t-ink") && hexIn(dark, "--t-ink"), "control: the token extractor reads a known terminal token out of both blocks");

const SURFACES = ["--t-bg", "--t-panel", "--t-panel-2"];
const INKS = ["--t-ink", "--t-ink-dim", "--t-ink-faint", "--t-cyan", "--t-violet", "--t-up", "--t-down", "--t-warn"];
const AA = 4.5; // the terminal sets text at 10-12px, so the relaxed large-text threshold never applies
for (const [themeName, b] of [["light", light], ["dark", dark]]) {
  for (const ink of INKS) {
    const fg = hexIn(b, ink);
    if (!fg) { ok(false, `${themeName}: ${ink} is a plain hex the contrast check can read`); continue; }
    let worst = Infinity, worstOn = "";
    for (const s of SURFACES) {
      const bg = hexIn(b, s);
      if (!bg) continue;
      const c = contrast(fg, bg);
      if (c < worst) { worst = c; worstOn = s; }
    }
    ok(worst >= AA, `${themeName}: ${ink} clears WCAG AA ${AA}:1 on every terminal surface (worst ${worst.toFixed(2)}:1 on ${worstOn})`);
  }
}

// --- no literal colour anywhere --------------------------------------------
const cssHex = TERMINAL_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok(cssHex.length === 0, `TERMINAL_CSS carries no literal hex colour${cssHex.length ? ` - found ${cssHex.join(", ")}` : ""} (a hardcoded colour renders wrong in the other theme)`);

// --- rendering -------------------------------------------------------------
const rows = [
  { host: "alpha.example", calls: 1200, usd: 12.5, buyers: 9, tools: 4, routable: true },
  { host: "beta.example", calls: 300, usd: 1.25, buyers: 3, tools: 2, routable: false },
];
const buckets = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, tx: i, usd: i * 0.5, buyers: i % 5 }));
const activity = { days: 30, totals: { tx: 30253, usd: 332.18, buyers: 46 }, buckets };

const html = marketTerminalHtml({ chainName: "Base", asset: "USDC", rows, selectedHost: "alpha.example", activity, scopeLabel: "ALPHA.EXAMPLE", noteText: "a note", ticker: [{ host: "alpha.example", value: "$12.50", dir: "up", pct: 4.2 }] });
const htmlHex = html.match(/#[0-9a-fA-F]{6}\b/g) || [];
ok(htmlHex.length === 0, `rendered terminal markup carries no literal hex${htmlHex.length ? ` - ${htmlHex.join(", ")}` : ""}`);
ok(!/\$\{/.test(html), "no unrendered ${...} placeholder reached the markup");
for (const hook of ["data-t-terminal", "data-t-roster", "data-t-body", "data-t-search", "data-t-status", "data-t-help"]) {
  ok(html.includes(hook), `the behaviour script's hook ${hook} is present in the server-rendered markup`);
}
ok((html.match(/data-t-row/g) || []).length === rows.length, "every seller row is server-rendered, so the page works with the script absent");
ok(/aria-current="true"/.test(html), "the server marks the selected row for assistive tech, not just visually");
ok(/role="table"/.test(html) && /role="columnheader"/.test(html), "the roster is a real table to assistive tech");

// --- escaping --------------------------------------------------------------
// Seller hostnames come from a crawl of third-party origins, so every one of
// them is attacker-controlled text arriving at an HTML sink.
//
// Two earlier versions of this check were both wrong, and CodeQL named both.
// Scanning for a literal `<script>` is case-sensitive (js/bad-tag-filter), so
// an escaper broken only for upper case passes it. Subtracting the component's
// own markup with a regex before scanning is worse (js/incomplete-multi-
// character-sanitization): a single-pass strip is exactly the pattern that
// leaves `<ifr<span>ame>` behind, and writing a sanitizer inside a test that
// exists to verify sanitizing is circular.
//
// So: no subtraction. Scan for tags these components NEVER emit themselves
// (they emit span/svg/path/div/a/i/b/input/kbd/dl/dt/dd/button/section/h2 and
// nothing else), which makes any hit unambiguously the payload's. Then assert
// the positive - the payload must come back entity-encoded rather than
// silently dropped, which would also pass a negative-only check.
const NEVER_EMITTED = /<\s*\/?\s*(script|iframe|object|embed|form|style|link|meta|base)\b/i;
// The metacharacters that decide whether text can leave its context at all.
// Note what is deliberately NOT asserted: the literal strings " onmouseover="
// and "javascript:" DO survive in the output, as inert text between encoded
// quotes, and an earlier draft of this test failed on them. Checking for them
// measures the payload's vocabulary rather than whether it can execute; the
// invariant that matters is that every < > and " arriving from the payload is
// entity-encoded, which is verified directly below.
const META = /[<>"]/;

const PAYLOADS = [
  ["lower case", `</span><script>alert(1)</script>`],
  ["upper case", `</SPAN><SCRIPT>alert(1)</SCRIPT>`],
  ["spaced tag", `</span>< script >alert(1)< / script >`],
  ["attribute break-out", `x" onmouseover="alert(1)` ],
  ["javascript url", `<a href="javascript:alert(1)">x</a>`],
  ["nested strip bait", `<ifr<span>ame src=x onerror=alert(1)>`],
];

for (const [label, payload] of PAYLOADS) {
  const cases = [
    ["roster", terminalRoster([{ host: payload, calls: 1, usd: 1, buyers: 1, tools: 1, routable: true }], null)],
    ["ticker", terminalTicker([{ host: payload, value: payload, dir: "up", pct: 1 }])],
    ["status bar", terminalStatusBar({ chainName: payload, asset: payload, sellerCount: 1, activity, scopeLabel: payload })],
    ["metrics", terminalMetrics(activity, payload, payload)],
  ];
  for (const [name, out] of cases) {
    ok(!NEVER_EMITTED.test(out), `${name}: no tag these components never emit survives the payload (${label})`);
    // The raw payload must never appear verbatim: every payload here carries a
    // metacharacter, so a verbatim copy means one of them reached the document
    // unencoded. This is the whole escaping contract, stated once.
    ok(META.test(payload) && !out.includes(payload), `${name}: the raw payload never reaches the document unencoded (${label})`);
    ok(out.includes("&lt;") || out.includes("&quot;"), `${name}: the payload is entity-encoded, not dropped (${label})`);
  }
}

// --- honesty ---------------------------------------------------------------
const capped = terminalStatusBar({ chainName: "Base", asset: "USDC", sellerCount: 2, activity: { ...activity, truncated: true }, scopeLabel: "X" });
ok(/SCAN CAPPED|FLOOR/.test(capped), "a truncated scan is reported as a floor in the status bar, not passed off as a total");
const broken = terminalStatusBar({ chainName: "Base", asset: "USDC", sellerCount: 2, activity: { error: "rpc down" }, scopeLabel: "X" });
ok(/UNAVAILABLE/.test(broken), "a failed scan says unavailable rather than showing zero");
ok(/\+/.test(terminalMetrics({ ...activity, truncated: true }, "X", "").match(/t-metric-v">([^<]*)</)[1]), "a truncated total is rendered as a floor (N+) in the metric itself");
ok(!/\+/.test(terminalMetrics(activity, "X", "").match(/t-metric-v">([^<]*)</)[1]), "a complete total carries no floor marker");

// trendOf must refuse to invent a direction it cannot know.
ok(trendOf([]) === null, "trendOf: no data is null, never a trend of zero");
ok(trendOf([1, 2]) === null, "trendOf: too few points is null");
ok(trendOf([0, 0, 0, 0, 0, 0]) === null, "trendOf: an all-zero series has no direction");
ok(trendOf([1, 1, 1, 1, 9, 9, 9, 9]).dir === "up", "trendOf: a rising series reads up");
ok(trendOf([9, 9, 9, 9, 1, 1, 1, 1]).dir === "down", "trendOf: a falling series reads down");
ok(trendOf([5, 5, 5, 5, 5, 5, 5, 5]).dir === "flat", "trendOf: an unchanged series reads flat, not up");
const naMarkup = terminalMetrics({ days: 30, totals: { tx: 1, usd: 1, buyers: 1 }, buckets: [{ tx: 1, usd: 1, buyers: 1 }] }, "X", "");
ok(/t-na/.test(naMarkup), "a series too short to trend renders as unknown, not as 0%");

// compactUsd must never round a real figure away to $0.
ok(compactUsd(0.0004) === "$0.0004", "compactUsd keeps sub-cent precision (a $0.001 rail must not read $0.00)");
ok(compactUsd(1234) === "$1.2k" && compactUsd(1_500_000) === "$1.50M", "compactUsd scales at k and M");

// --- a truncated scan must not be read as a trend --------------------------
// The scan walks newest-first, so a budget-stopped walk leaves the OLDEST days
// of the window unreached. They arrive as zeros that mean "not scanned", not
// "quiet". Measured on production 2026-09-20: 17 of 30 days scanned for the
// busiest seller on Base, 21 zero buckets, and the panel rendered +4369.9% for
// traffic that is roughly flat. A gap is not a measurement.
const partial = Array.from({ length: 30 }, (_, i) => (i < 21
  ? { date: `d${i}`, tx: 0, usd: 0, buyers: 0 }
  : { date: `d${i}`, tx: 900 + i, usd: 9, buyers: 4 }));
const truncAct = { days: 30, truncated: true, totals: { tx: 17000, usd: 258.08, buyers: 38 }, buckets: partial };
const truncOut = terminalMetrics(truncAct, "X", "");
const deltasOf = (html) => [...html.matchAll(/class="t-delta[^"]*">([^<]*)</g)].map((m) => m[1]);

ok(trendOf(partial.map((x) => x.tx)).dir === "up", "control: the raw partial series DOES read as a huge rise - this is the artifact being suppressed");
ok(deltasOf(truncOut).every((d) => d === "--"), `a truncated scan claims no direction on any metric (got ${JSON.stringify(deltasOf(truncOut))})`);
ok(/OF 30D SCANNED/.test(truncOut), "the panel says how much of the window was actually scanned");
ok(!/%/.test(truncOut.match(/t-metric-h[\s\S]*?<\/div>/)?.[0] || ""), "no percentage is printed beside a partial window");

const fullAct = { days: 30, truncated: false, totals: { tx: 30253, usd: 332.18, buyers: 46 }, buckets: buckets };
ok(deltasOf(terminalMetrics(fullAct, "X", "")).some((d) => /%/.test(d)), "a COMPLETE scan still shows its real deltas - the suppression is scoped to truncation");

// observedSlice drops only the unreached leading run, and only when truncated.
ok(observedSlice(partial, true).length === 9, `observedSlice keeps the 9 observed days (got ${observedSlice(partial, true).length})`);
ok(observedSlice(partial, false).length === 30, "observedSlice is a no-op on a complete scan, where a zero day IS a measurement");
ok(observedSlice([{ tx: 0, usd: 0, buyers: 0 }, { tx: 0, usd: 0, buyers: 0 }], true).length === 2,
  "an all-zero truncated series is returned whole rather than emptied");
ok(observedSlice([{ tx: 5, usd: 1, buyers: 1 }, { tx: 0, usd: 0, buyers: 0 }], true).length === 2,
  "a zero INSIDE the observed run is kept - only the leading unreached run is dropped");

// --- sparkline -------------------------------------------------------------
ok(/<svg/.test(sparkline([1, 2, 3])) && /aria-hidden="true"/.test(sparkline([1, 2, 3])), "sparkline is an inline SVG hidden from assistive tech (the figure beside it is the value)");
ok(!/NaN|Infinity/.test(sparkline([0, 0, 0, 0])), "sparkline of an all-zero series produces no NaN in its path");
ok(!/NaN|Infinity/.test(sparkline([5])), "sparkline of a single point produces no NaN");

// --- behaviour script ------------------------------------------------------
const js = readFileSync(new URL("../assets/js/market-terminal.js", import.meta.url), "utf8");
ok(!/innerHTML/.test(js), "the behaviour script never assigns innerHTML");
ok(!/\bfetch\s*\(/.test(js), "the behaviour script makes no network request - it only re-orders rows the server sent");
ok(/VIRTUALIZE_OVER/.test(js), "windowing is thresholded rather than always-on");
ok(/prefers-reduced-motion/.test(TERMINAL_CSS), "the ticker stops under prefers-reduced-motion");

console.log(`\n${fail === 0 ? "OK" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
