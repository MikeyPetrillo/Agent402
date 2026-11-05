// Locks the WCAG AA contrast fix for --faint (2026-08-16 audit): the token
// was #6C6C68, 3.15-3.66:1 against the dark surfaces it's actually
// composited on in shared nav/footer chrome (used at 10-13px - normal text
// needs 4.5:1, not the relaxed 3:1 large-text threshold) - a sitewide
// failure since ledger-chrome.js's :root is the ONE definition every page
// inherits. Offline - reads the token + background hexes straight out of
// the CSS source and computes real WCAG relative-luminance contrast, so a
// future value change is caught by the math, not just a hardcoded string
// compare.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8");

function tokenValue(name) {
  const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1] : null;
}

function relLum(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255, g = parseInt(c.slice(2, 4), 16) / 255, b = parseInt(c.slice(4, 6), 16) / 255;
  const lin = (x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(hex1, hex2) {
  const L1 = relLum(hex1), L2 = relLum(hex2);
  const lighter = Math.max(L1, L2), darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

const faint = tokenValue("faint");
ok(!!faint, `found --faint in ledger-chrome.js's :root (got ${faint})`);

// Every dark surface --faint text is actually composited on across the
// site's shared chrome + page bodies (paper/card/card-zebra/footer-bg).
const SURFACES = { paper: "paper", card: "card", "card-zebra": "card-zebra", "footer-bg": "footer-bg" };
for (const [label, tokenName] of Object.entries(SURFACES)) {
  const bg = tokenValue(tokenName);
  ok(!!bg, `found --${tokenName} token (got ${bg})`);
  if (!bg || !faint) continue;
  const ratio = contrast(faint, bg);
  // WCAG AA for normal-size text (< 18pt/24px, or < 14pt/18.66px bold) is
  // 4.5:1 - --faint is used at 10-13px throughout, well under that.
  ok(ratio >= 4.5, `--faint (${faint}) on --${tokenName} (${bg}) clears WCAG AA 4.5:1 (got ${ratio.toFixed(2)}:1)`);
}

// Sanity: --faint must stay visually distinct from --muted (the "one level
// up" token) - the fix should not just collapse the two into the same shade.
const muted = tokenValue("muted");
if (faint && muted) {
  const distinctness = contrast(faint, muted);
  ok(distinctness > 1.05, `--faint (${faint}) stays visually distinct from --muted (${muted}) (contrast ${distinctness.toFixed(2)}:1)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
