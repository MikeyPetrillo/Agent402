// Dense terminal surface for the marketplace chain pages.
//
// The market pages were built as prose: 15-21px body copy, generous vertical
// rhythm, three big metric cards, a roster of soft-edged rows. That reads well
// for a paragraph and badly for a market, where the job is to put many rows of
// comparable numbers in front of someone at once and let them move between
// them without reaching for a mouse.
//
// This module is the dense alternative: a fixed-height multi-panel grid, a
// monospaced tabular scale, a virtualizable roster, real sparklines, a ticker
// strip and a status bar. It renders server-side and complete - every row, the
// selection, the numbers - so the page works with JavaScript off and with the
// behaviour script (assets/js/market-terminal.js) it gains windowing, keyboard
// navigation and incremental search.
//
// TOKENS. Every colour here comes from the --t-* scale defined in
// ledger-chrome.js, in BOTH themes, so this surface follows the site theme
// rather than pinning itself dark. See that block for the palette rationale
// and scripts/test-terminal-tokens.js for the contrast proof. Nothing in this
// file may carry a literal hex: a dense grid is exactly where a hardcoded
// colour survives review and then renders invisible in the other theme, and
// the guard fails the build for one.
//
// NUMBERS. Tabular figures and a fixed decimal scale, because the entire point
// of a column of numbers is that the digits line up. Anything derived rather
// than measured says so in the markup it sits in - a sparkline over a capped
// scan is drawn from a floor, and the panel labels it.
// No import from market-page.js on purpose: that module will import this one,
// and a cycle between two render modules is the kind that resolves fine until
// someone reorders an import and a const reads undefined at module scope. The
// two fields needed from the chain descriptor are passed in instead.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US");
/** Compact money for a column: $1.2k / $12.3k / $1.23M, two significant
 *  decimals under a thousand so sub-cent rails stay readable. */
export function compactUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
const pct = (n) => `${n > 0 ? "+" : ""}${(Number(n) || 0).toFixed(1)}%`;

/** Direction of the most recent half of a series against the half before it.
 *  Returns null when there is not enough data to say, which the caller must
 *  render as "flat/unknown" rather than as zero - an absent trend is not a
 *  trend of nothing. */
export function trendOf(values = []) {
  const v = values.map((x) => Number(x) || 0);
  if (v.length < 4) return null;
  const mid = Math.floor(v.length / 2);
  const prior = v.slice(0, mid).reduce((a, b) => a + b, 0);
  const recent = v.slice(mid).reduce((a, b) => a + b, 0);
  if (prior === 0 && recent === 0) return null;
  if (prior === 0) return { dir: "up", pct: 100 };
  const change = ((recent - prior) / prior) * 100;
  return { dir: change > 1 ? "up" : change < -1 ? "down" : "flat", pct: change };
}

/** Inline sparkline. No script, no library, no network: an SVG path scaled to
 *  the series' own maximum with a filled area under it. Stroke and fill are
 *  currentColor so a caller sets direction by colouring the wrapper, which
 *  keeps the theme switch free. aria-hidden because the figure beside it is
 *  the accessible value - a screen reader gains nothing from the shape. */
export function sparkline(values = [], { w = 120, h = 28 } = {}) {
  const v = values.map((x) => Number(x) || 0);
  if (v.length < 2) return `<svg class="t-spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const max = Math.max(...v, 0);
  const step = w / (v.length - 1);
  const y = (n) => (max > 0 ? h - 1 - (n / max) * (h - 2) : h - 1);
  const pts = v.map((n, i) => `${(i * step).toFixed(2)},${y(n).toFixed(2)}`);
  return `<svg class="t-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<path class="t-spark-a" d="M0,${h} L${pts.join(" L")} L${w},${h} Z"/>`
    + `<path class="t-spark-l" d="M${pts.join(" L")}"/></svg>`;
}

/** The slice of a series that was actually OBSERVED.
 *
 *  A truncated scan walks newest-first and stops, so the days at the far end
 *  of the window were never reached. They arrive here as zeros, which are
 *  indistinguishable from a genuinely quiet day - and a zero that means "not
 *  scanned" is not a measurement. Measured on production 2026-09-20: the
 *  busiest seller on Base scanned 17 of ~30 days inside the budget, the
 *  remaining 21 buckets read zero, and the trend that produced rendered
 *  +4369.9% for traffic that is roughly flat, with a sparkline drawing a
 *  cliff out of the gap.
 *
 *  So on a truncated scan the leading run of all-zero buckets is dropped
 *  rather than drawn, and the caller must not claim a direction over what is
 *  left: the recent days are known, the window is not. */
export function observedSlice(buckets = [], truncated = false) {
  if (!truncated || !buckets.length) return buckets;
  const empty = (b) => !(Number(b?.tx) || 0) && !(Number(b?.usd) || 0) && !(Number(b?.buyers) || 0);
  let i = 0;
  while (i < buckets.length && empty(buckets[i])) i++;
  return i >= buckets.length ? buckets : buckets.slice(i);
}

/** One headline metric: label, value, trend, sparkline.
 *  `known` false means the series is a partial window, so no direction is
 *  claimed however clean the remaining numbers look. */
function metric(label, value, series, { hint = "", known = true } = {}) {
  const t = known ? trendOf(series) : null;
  const dir = t ? t.dir : "flat";
  return `<div class="t-metric t-${dir}">
      <div class="t-metric-h"><span class="t-label">${esc(label)}</span>${t ? `<span class="t-delta">${esc(pct(t.pct))}</span>` : `<span class="t-delta t-na">--</span>`}</div>
      <div class="t-metric-v">${esc(value)}</div>
      ${sparkline(series, { w: 168, h: 30 })}
      ${hint ? `<div class="t-metric-n">${esc(hint)}</div>` : ""}
    </div>`;
}

/** Ticker strip. Real rows only - each entry is a seller the page already
 *  lists with numbers it already has. The marquee is CSS, duplicated once for
 *  a seamless loop, and stops dead under prefers-reduced-motion (see the CSS),
 *  because a permanently moving strip is a genuine accessibility problem and
 *  this one carries no information the panels below do not. */
export function terminalTicker(rows = []) {
  if (!rows.length) return "";
  const cell = (r) => {
    const d = r.dir === "up" ? "t-up" : r.dir === "down" ? "t-down" : "t-flat";
    const arrow = r.dir === "up" ? "▲" : r.dir === "down" ? "▼" : "▬";
    return `<span class="t-tick ${d}"><b>${esc(r.host)}</b><span class="t-tick-v">${esc(r.value)}</span><span class="t-tick-d">${arrow}${r.pct != null ? esc(pct(r.pct)) : ""}</span></span>`;
  };
  const run = rows.map(cell).join("");
  return `<div class="t-ticker" role="marquee" aria-label="Recent seller activity">
      <div class="t-ticker-rail">${run}<span aria-hidden="true">${run}</span></div>
    </div>`;
}

/** Dense roster. Every row is rendered: the windowing in the behaviour script
 *  hides rows it is not showing, so search, sort and deep links keep working
 *  with the script absent or broken. Rows carry their own numbers as data-*
 *  so the script never re-derives a figure the server already computed. */
export function terminalRoster(rows = [], selectedHost = null, { measured = true } = {}) {
  if (!rows.length) return `<div class="t-empty">no sellers indexed on this rail yet</div>`;
  const maxCalls = Math.max(...rows.map((r) => Number(r.calls) || 0), 1);
  const body = rows.map((r, i) => {
    const sel = selectedHost && r.host === selectedHost;
    const share = Math.round(((Number(r.calls) || 0) / maxCalls) * 100);
    return `<a class="t-row${sel ? " is-sel" : ""}" role="row" tabindex="${sel || (!selectedHost && i === 0) ? 0 : -1}"
       href="${esc(r.href || `?seller=${encodeURIComponent(r.host)}#detail`)}"
       data-t-row data-host="${esc(r.host)}" data-calls="${Number(r.calls) || 0}" data-usd="${Number(r.usd) || 0}"
       data-buyers="${Number(r.buyers) || 0}" data-tools="${Number(r.tools) || 0}" data-idx="${i}"
       ${sel ? 'aria-current="true"' : ""}>
      <span class="t-c t-c-n" role="cell">${String(i + 1).padStart(3, "0")}</span>
      <span class="t-c t-c-host" role="cell"><span class="t-dot${r.routable ? " is-on" : ""}" aria-hidden="true"></span>${esc(r.host)}</span>
      <span class="t-c t-c-num" role="cell">${measured ? num(r.calls) : "-"}</span>
      <span class="t-c t-c-num" role="cell">${measured ? esc(compactUsd(r.usd)) : "-"}</span>
      <span class="t-c t-c-num" role="cell">${measured ? num(r.buyers) : "-"}</span>
      <span class="t-c t-c-num" role="cell">${num(r.tools)}</span>
      <span class="t-c t-c-bar" role="cell" aria-hidden="true"><i style="width:${share}%"></i></span>
    </a>`;
  }).join("");
  return `<div class="t-table" role="table" aria-label="Sellers on this rail" data-t-roster>
      <div class="t-head" role="row">
        <span class="t-c t-c-n" role="columnheader">#</span>
        <span class="t-c t-c-host" role="columnheader">SELLER</span>
        <span class="t-c t-c-num" role="columnheader" data-t-sort="calls">CALLS</span>
        <span class="t-c t-c-num" role="columnheader" data-t-sort="usd">VOLUME</span>
        <span class="t-c t-c-num" role="columnheader" data-t-sort="buyers">BUYERS</span>
        <span class="t-c t-c-num" role="columnheader" data-t-sort="tools">TOOLS</span>
        <span class="t-c t-c-bar" role="columnheader"><span class="t-sr">Share of the busiest seller listed</span></span>
      </div>
      <div class="t-body" role="rowgroup" data-t-body>${body}</div>
    </div>`;
}

/** Status bar. Reports what the page actually knows, including what it does
 *  NOT know: a capped scan says "floor", an unavailable one says so, and
 *  neither is dressed up as a measurement. */
/** "400 of 1,234" when the rendered roster is a capped page of a longer one,
 *  the bare count when it is the whole roster. */
export function shownOfTotal(shown, total) {
  const t = Number(total);
  return Number.isFinite(t) && t > Number(shown) ? `${num(shown)} of ${num(t)}` : num(shown);
}

export function terminalStatusBar({ chainName, asset, sellerCount, totalSellers = null, hostTag = "", activity, scanned, scopeLabel }) {
  const state = !activity || activity.error ? { k: "warn", t: "SCAN UNAVAILABLE" }
    : activity.truncated ? { k: "warn", t: "SCAN CAPPED / FLOOR" }
    : { k: "ok", t: "SCAN COMPLETE" };
  const cells = [
    `<span class="t-st-cell"><span class="t-label">RAIL</span>${esc(chainName || "")}</span>`,
    `<span class="t-st-cell"><span class="t-label">ASSET</span>${esc(asset || "USDC")}</span>`,
    `<span class="t-st-cell"><span class="t-label">SELLERS</span>${shownOfTotal(sellerCount, totalSellers)}${esc(hostTag)}</span>`,
    `<span class="t-st-cell"><span class="t-label">SCOPE</span>${esc(scopeLabel || "")}</span>`,
    `<span class="t-st-cell t-${state.k}"><span class="t-st-led" aria-hidden="true"></span>${esc(state.t)}</span>`,
    scanned ? `<span class="t-st-cell"><span class="t-label">WINDOW</span>${esc(scanned)}</span>` : "",
    `<span class="t-st-cell t-st-hint"><kbd>?</kbd> keys</span>`,
  ].filter(Boolean).join("");
  return `<div class="t-status" role="status" aria-live="polite" data-t-status>${cells}</div>`;
}

/** Keyboard help. Server-rendered and hidden, so the shortcuts are in the DOM
 *  (and findable, and translatable) rather than built by the script. */
export function terminalHelp() {
  const keys = [
    ["j / ↓", "next seller"], ["k / ↑", "previous seller"],
    ["g / G", "first / last"], ["/", "search the roster"],
    ["Enter", "open the selected seller"], ["1-6", "sort by that column"],
    ["t", "switch theme"], ["Esc", "clear search or close this"], ["?", "show or hide this"],
  ];
  return `<div class="t-help" data-t-help hidden role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="t-help-box">
        <div class="t-help-h"><span class="t-label">KEYBOARD</span><button type="button" class="t-help-x" data-t-help-close aria-label="Close">×</button></div>
        <dl>${keys.map(([k, d]) => `<div><dt><kbd>${esc(k)}</kbd></dt><dd>${esc(d)}</dd></div>`).join("")}</dl>
      </div>
    </div>`;
}

/** The metric block for whichever seller is in scope. */
export function terminalMetrics(activity, scopeLabel, noteText) {
  if (!activity || activity.error || !Array.isArray(activity.buckets) || !activity.buckets.length) {
    return `<div class="t-panel"><div class="t-panel-h"><span class="t-label">ACTIVITY</span><span class="t-label t-dim">${esc(scopeLabel)}</span></div>
      <div class="t-empty">${esc(noteText || "activity scan unavailable for this seller")}</div></div>`;
  }
  const truncated = !!activity.truncated;
  const b = observedSlice(activity.buckets, truncated);
  const t = activity.totals || {};
  const floor = truncated ? "+" : "";
  const known = !truncated;
  const span = truncated
    ? `${esc(scopeLabel)} · ${b.length}D OF ${esc(activity.days)}D SCANNED`
    : `${esc(scopeLabel)} · ${esc(activity.days)}D`;
  return `<div class="t-panel">
      <div class="t-panel-h"><span class="t-label">ACTIVITY</span><span class="t-label t-dim">${span}</span></div>
      <div class="t-metrics">
        ${metric("TRANSACTIONS", num(t.tx) + floor, b.map((x) => x.tx), { known })}
        ${metric("VOLUME", compactUsd(t.usd) + floor, b.map((x) => x.usd), { known })}
        ${metric("BUYERS", num(t.buyers) + floor, b.map((x) => x.buyers), { known })}
      </div>
      ${noteText ? `<div class="t-note">${esc(noteText)}</div>` : ""}
    </div>`;
}

// The stylesheet. Served inline with the page (style-src allows inline style,
// script-src does not allow inline script, which is why the behaviour lives in
// a real file under assets/js).
export const TERMINAL_CSS = `
.t-wrap{--t-row-h:26px;background:var(--t-bg);color:var(--t-ink);border:1px solid var(--t-rule);font-family:var(--font-mono);font-size:12px;line-height:1.35;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"zero" 1;}
.t-label{font-size:10px;letter-spacing:.10em;color:var(--t-ink-faint);text-transform:uppercase;}
.t-dim{color:var(--t-ink-dim);}
.t-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.t-up{color:var(--t-up);} .t-down{color:var(--t-down);} .t-flat,.t-na{color:var(--t-ink-dim);}
.t-ok{color:var(--t-up);} .t-warn{color:var(--t-warn);}

/* Ticker */
.t-ticker{overflow:hidden;border-bottom:1px solid var(--t-rule);background:var(--t-panel);padding:5px 0;}
.t-ticker-rail{display:inline-flex;white-space:nowrap;will-change:transform;animation:t-scroll 90s linear infinite;}
.t-ticker:hover .t-ticker-rail,.t-ticker:focus-within .t-ticker-rail{animation-play-state:paused;}
.t-tick{display:inline-flex;align-items:baseline;gap:6px;padding:0 14px;border-right:1px solid var(--t-rule);}
.t-tick b{font-weight:600;color:var(--t-ink);}
.t-tick-v{color:var(--t-ink-dim);} .t-tick-d{font-size:11px;}
@keyframes t-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion: reduce){.t-ticker-rail{animation:none;}.t-ticker{overflow-x:auto;}}

/* Grid */
.t-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:1px;background:var(--t-rule);}
.t-col{background:var(--t-bg);min-width:0;display:flex;flex-direction:column;}
.t-panel{border-bottom:1px solid var(--t-rule);background:var(--t-panel);}
.t-panel-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;border-bottom:1px solid var(--t-rule);background:var(--t-panel-2);}

/* Roster */
.t-toolbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--t-rule);background:var(--t-panel-2);}
.t-search{flex:1;min-width:0;background:var(--t-bg);border:1px solid var(--t-rule-2);color:var(--t-ink);font:inherit;padding:4px 7px;border-radius:0;}
.t-search:focus{outline:2px solid var(--t-sel-edge);outline-offset:-1px;}
.t-search::placeholder{color:var(--t-ink-faint);}
.t-count{color:var(--t-ink-faint);font-size:11px;white-space:nowrap;}
.t-table{display:flex;flex-direction:column;min-height:0;flex:1;}
.t-head,.t-row{display:grid;grid-template-columns:34px minmax(0,1fr) 68px 72px 58px 46px 52px;align-items:center;gap:8px;padding:0 10px;}
.t-head{height:24px;border-bottom:1px solid var(--t-rule-2);background:var(--t-panel-2);position:sticky;top:0;z-index:1;}
.t-head .t-c{font-size:10px;letter-spacing:.09em;color:var(--t-ink-faint);text-transform:uppercase;}
.t-head [data-t-sort]{cursor:pointer;user-select:none;}
.t-head [data-t-sort]:hover,.t-head [data-t-sort].is-sorted{color:var(--t-cyan);}
.t-body{overflow-y:auto;max-height:min(58vh,620px);scrollbar-width:thin;}
.t-row{height:var(--t-row-h);text-decoration:none;color:var(--t-ink);border-bottom:1px solid var(--t-grid);}
/* Zebra: with the behaviour script off, rows sit in DOM order and nth-child
   is correct. Once the script sorts or filters, DOM position no longer equals
   visible position, so it stamps .is-odd and the table gets data-t-js - the
   two rules are mutually exclusive rather than one overriding the other. */
.t-table:not([data-t-js]) .t-row:nth-child(2n){background:var(--t-panel-2);}
.t-table[data-t-js] .t-row.is-odd{background:var(--t-panel-2);}
.t-row.is-cursor{box-shadow:inset 2px 0 0 var(--t-violet);}
.t-row.is-sel.is-cursor{box-shadow:inset 2px 0 0 var(--t-sel-edge),inset 0 0 0 1px var(--t-sel-edge);}
.t-row:hover{background:var(--t-sel);}
.t-row:focus-visible{outline:2px solid var(--t-sel-edge);outline-offset:-2px;}
.t-row.is-sel{background:var(--t-sel);box-shadow:inset 2px 0 0 var(--t-sel-edge);}
.t-c{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.t-c-n{color:var(--t-ink-faint);font-size:11px;}
.t-c-host{display:flex;align-items:center;gap:6px;min-width:0;}
.t-c-num{text-align:right;}
.t-dot{width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:var(--t-rule-2);}
.t-dot.is-on{background:var(--t-up);}
.t-c-bar{background:var(--t-grid);height:6px;}
.t-c-bar i{display:block;height:6px;background:var(--t-cyan);opacity:.65;}

/* Metrics */
.t-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--t-rule);}
.t-metric{background:var(--t-panel);padding:9px 10px 8px;min-width:0;}
.t-metric-h{display:flex;align-items:baseline;justify-content:space-between;gap:6px;}
.t-delta{font-size:11px;}
.t-metric-v{font-size:22px;font-weight:600;letter-spacing:-.01em;color:var(--t-ink);margin:1px 0 3px;}
.t-metric-n{font-size:10px;color:var(--t-ink-faint);margin-top:3px;}
.t-spark{display:block;width:100%;height:30px;color:inherit;}
.t-spark-l{fill:none;stroke:currentColor;stroke-width:1.25;vector-effect:non-scaling-stroke;}
.t-spark-a{fill:currentColor;opacity:.13;stroke:none;}
.t-note{padding:7px 10px;font-size:10.5px;color:var(--t-ink-faint);border-top:1px solid var(--t-rule);}
.t-empty{padding:16px 10px;color:var(--t-ink-dim);}

/* Status bar */
.t-status{display:flex;flex-wrap:wrap;align-items:center;gap:0;border-top:1px solid var(--t-rule);background:var(--t-panel-2);}
.t-st-cell{display:flex;align-items:center;gap:6px;padding:6px 11px;border-right:1px solid var(--t-rule);font-size:11px;white-space:nowrap;}
.t-st-cell .t-label{margin:0;}
.t-st-hint{margin-left:auto;border-right:0;color:var(--t-ink-faint);}
.t-st-led{width:6px;height:6px;border-radius:50%;background:currentColor;}
.t-status kbd,.t-help kbd{font:inherit;font-size:10.5px;border:1px solid var(--t-rule-2);padding:0 4px;color:var(--t-ink-dim);}

/* Help */
.t-help[hidden]{display:none;}
.t-help{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;}
.t-help-box{background:var(--t-panel);border:1px solid var(--t-rule-2);max-width:380px;width:100%;font-family:var(--font-mono);color:var(--t-ink);}
.t-help-h{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--t-rule);background:var(--t-panel-2);}
.t-help-x{background:none;border:0;color:var(--t-ink-dim);font-size:17px;line-height:1;cursor:pointer;padding:0 3px;}
.t-help dl{margin:0;padding:6px 10px 10px;}
.t-help dl>div{display:flex;gap:10px;padding:3px 0;font-size:11.5px;}
.t-help dt{margin:0;flex:0 0 78px;} .t-help dd{margin:0;color:var(--t-ink-dim);}

@media (max-width: 860px){
  .t-grid{grid-template-columns:minmax(0,1fr);}
  .t-head,.t-row{grid-template-columns:28px minmax(0,1fr) 60px 64px 46px;}
  .t-head .t-c:nth-child(6),.t-row .t-c:nth-child(6),.t-head .t-c:nth-child(7),.t-row .t-c:nth-child(7){display:none;}
  .t-metrics{grid-template-columns:minmax(0,1fr);}
  .t-body{max-height:44vh;}
}`;

/** Assemble the terminal for one chain page. */
// `totalSellers`: the roster's full length when `rows` is a capped page of it.
// `measured`: false when per-seller settlements are not measured on this rail,
// so the CALLS / VOLUME / BUYERS cells read "-" rather than a zero.
export function marketTerminalHtml({ chainName = "", asset = "USDC", rows = [], totalSellers = null, measured = true, selectedHost = null, activity = null, scopeLabel = "THIS HOST", noteText = "", ticker = [] } = {}) {
  // `totalSellers` counts other sellers only (the host is in no seller count),
  // so the shown figure counts other sellers too and the host row is named.
  const others = rows.filter((r) => !r.local).length;
  const hostTag = rows.some((r) => r.local) ? " + this host" : "";
  const countText = `${shownOfTotal(others, totalSellers)}${hostTag}`;
  return `<section class="t-wrap" data-t-terminal aria-label="Market terminal">
    ${terminalTicker(ticker)}
    <div class="t-grid">
      <div class="t-col">
        <div class="t-toolbar">
          <span class="t-label">SELLERS</span>
          <input class="t-search" type="search" data-t-search placeholder="filter by host  (press /)" aria-label="Filter sellers by host" autocomplete="off" spellcheck="false">
          <span class="t-count" data-t-count>${countText}</span>
        </div>
        ${terminalRoster(rows, selectedHost, { measured })}
      </div>
      <div class="t-col" id="detail">
        ${terminalMetrics(activity, scopeLabel, noteText)}
      </div>
    </div>
    ${terminalStatusBar({ chainName, asset, sellerCount: others, totalSellers, hostTag, activity, scopeLabel, scanned: activity && !activity.error ? `${activity.days}D` : "" })}
    ${terminalHelp()}
  </section>`;
}
