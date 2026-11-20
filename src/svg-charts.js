// Dependency-free charts for the proof pages (/scorecard, /proof,
// /leaderboard): the marks are inline SVG, the words are HTML, so labels keep
// the type scale and wrap rules at every width while the bars stretch to fit.
// Every chart sits beside the table it draws from; the figure carries an
// aria-label naming what it shows, and the marks are hidden from assistive
// technology (the table is the accessible source).
//
// Colors and sizes are DESIGN.md tokens; bars grow in over --dur-slow with a
// --stagger step (sixth and later share the last start) and are drawn whole
// under reduced motion, where the tokens are 0ms.
import { esc } from "./ledger-chrome.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (num(v) / max) * 100)) : 0);
const r2 = (n) => Math.round(n * 100) / 100;
const step = (i) => Math.min(i, 5);

/**
 * Columns: one per period, each a stack of parts (bottom first).
 *   columns: [{ label, parts: [{ value, tone: "a" | "b" }], valueText, note }]
 *   legend:  [{ tone, label }]
 * A column with no parts draws no bar and shows its note ("<3") instead.
 */
export function columnChart({ label, columns = [], legend = [] }) {
  const totals = columns.map((c) => (c.parts || []).reduce((a, p) => a + num(p.value), 0));
  const max = Math.max(0, ...totals);
  if (!columns.length || max <= 0) return "";
  const cols = columns.map((c, i) => {
    let y = 100;
    const rects = (c.parts || []).map((p) => {
      const h = r2(pct(p.value, max));
      y = r2(y - h);
      return h > 0 ? `<rect class="sc-${p.tone === "b" ? "b" : "a"}" x="0" y="${y}" width="10" height="${h}"/>` : "";
    }).join("");
    return `<div class="sc-col" style="--i:${step(i)}"><span class="sc-val">${esc(c.valueText ?? (totals[i] ? String(totals[i]) : c.note || ""))}</span><span class="sc-box"><svg class="sc-bar" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${rects}</svg></span><span class="sc-lab">${esc(c.label)}</span></div>`;
  }).join("");
  const leg = legend.length ? `<div class="sc-legend">${legend.map((l) => `<span><i class="sc-key sc-key-${l.tone === "b" ? "b" : "a"}" aria-hidden="true"></i>${esc(l.label)}</span>`).join("")}</div>` : "";
  return `<figure class="sc-chart" role="img" aria-label="${esc(label)}"><div class="sc-cols" style="--n:${columns.length}">${cols}</div>${leg}</figure>`;
}

/**
 * Bars: one row each, a label, a bar against `max` (or each row's own
 * `of`, drawn as the track), and the value as text.
 *   rows: [{ label, value, of, valueText, href }]
 */
export function barChart({ label, rows = [], max = null }) {
  const top = max ?? Math.max(0, ...rows.map((r) => num(r.value)));
  if (!rows.length || !(top > 0)) return "";
  const items = rows.map((r, i) => {
    const w = r2(pct(r.value, r.of ?? top));
    const name = r.href ? `<a href="${esc(r.href)}" rel="noopener">${esc(r.label)}</a>` : esc(r.label);
    return `<div class="sb-row" style="--i:${step(i)}"><span class="sb-lab">${name}</span><svg class="sb-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="sb-track" x="0" y="0" width="100" height="10"/><rect class="sb-fill" x="0" y="0" width="${w}" height="10"/></svg><span class="sb-val">${esc(r.valueText ?? String(r.value))}</span></div>`;
  }).join("");
  return `<figure class="sc-chart" role="img" aria-label="${esc(label)}"><div class="sb-rows">${items}</div></figure>`;
}

export const CHART_CSS = `
.sc-chart{margin:0 0 22px;padding:18px 20px 14px;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--card)}
.sc-cols{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:10px;align-items:end;height:200px}
.sc-col{display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;min-width:0}
.sc-box{position:relative;flex:1 1 0;min-height:0;width:100%;max-width:56px}
.sc-bar{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sc-val,.sc-lab{font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.sc-lab{color:var(--faint);letter-spacing:.08em;text-transform:uppercase}
.sc-a{fill:var(--accent)}
.sc-b{fill:color-mix(in srgb,var(--accent) 38%,var(--card))}
.sc-bar rect,.sb-fill{transform-box:fill-box;animation:sc-grow var(--dur-slow) var(--ease-out) both;animation-delay:calc(var(--stagger) * var(--i,0))}
.sc-bar rect{transform-origin:50% 100%}
.sb-fill{transform-origin:0 50%;animation-name:sb-grow}
@keyframes sc-grow{from{transform:scaleY(0)}to{transform:none}}
@keyframes sb-grow{from{transform:scaleX(0)}to{transform:none}}
.sc-legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--muted)}
.sc-legend span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.sc-key{display:inline-block;width:10px;height:10px;border-radius:var(--radius)}
.sc-key-a{background:var(--accent)}
.sc-key-b{background:color-mix(in srgb,var(--accent) 38%,var(--card))}
.sb-rows{display:grid;gap:10px}
.sb-row{display:grid;grid-template-columns:minmax(0,14em) minmax(0,1fr) auto;gap:14px;align-items:center}
.sb-lab{font-size:var(--fs-sm);color:var(--ink);min-width:0}
.sb-lab a{color:var(--ink);text-decoration:none}
.sb-bar{width:100%;height:12px}
.sb-track{fill:var(--card-zebra)}
.sb-fill{fill:var(--accent)}
.sb-val{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right;min-width:5ch}
@media (max-width:640px){.sb-row{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}.sb-bar{grid-column:1/-1;grid-row:2}.sc-cols{gap:6px;height:170px}}
`;
