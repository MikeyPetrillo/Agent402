// The public SVG badges are embedded in other projects' READMEs, so their text
// has to read on its own ground. Every text fill in each badge is checked
// against the background it sits on: WCAG contrast at least 4.5:1.
import { badgeSvg } from "../src/badges.js";

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FAIL"} - ${m}`); if (!c) failed++; };
const lum = (hex) => {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [style, ground, the text fills drawn on that ground]
const cases = [
  ["powered-by", "#0B0C0E", ["#C9CED3", "#9EF0B0"]],
  ["default", "#3A3F45", ["#FFFFFF"]],
  ["default", "#0F5E43", ["#FFFFFF"]],
  ["flat", "#3A3F45", ["#FFFFFF"]],
  ["flat", "#0F5E43", ["#FFFFFF"]],
];
for (const [style, ground, fills] of cases) {
  const svg = badgeSvg(style);
  ok(svg.includes(`fill="${ground}"`), `${style}: draws the ${ground} ground`);
  for (const f of fills) {
    ok(svg.includes(f), `${style}: uses text fill ${f}`);
    const r = ratio(f, ground);
    ok(r >= 4.5, `${style}: ${f} on ${ground} is ${r.toFixed(2)}:1 (>= 4.5)`);
  }
}
// The old powered-by text (page accent on near-black) must not come back.
ok(!/<text[^>]*fill="#0F5E43"/.test(badgeSvg("powered-by")), "powered-by: no page-accent text on the dark ground");
// Size is part of the embed contract: other sites lay out around it.
ok(/width="160" height="28"/.test(badgeSvg("powered-by")), "powered-by keeps its 160x28 size");
console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
