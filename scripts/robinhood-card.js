// Announcement demo card for the Robinhood Chain marketplace — renders the
// live /api/revenue Robinhood rail as a 1200×630 TERMINAL-WINDOW card, the
// accepted announcement style (reference: docs/announcements/media/
// 2026-07-16-tts-demo-card.png / scripts/bestsellers-card.js): warm cream
// paper, dark charcoal terminal with traffic-light title bar, all Space Mono,
// green for OK/status semantics, red reserved for the agent402.tools wordmark.
//
// The standing announcement flow wants REAL numbers: render the FINAL card
// from live prod output at post time, never from mocked data. A layout
// preview from fixture data must carry the on-card "preview data" tag
// (--preview), which also REPLACES the "real output" claim — a fixture render
// can never label itself real.
//
// Usage:
//   node scripts/robinhood-card.js --from https://agent402.tools/api/revenue --out card.png
//   node scripts/robinhood-card.js --from revenue.json --out card.png
//   node scripts/robinhood-card.js --from fixture.json --out card.png --preview
//
// --from accepts a file path or URL returning the /api/revenue JSON (free,
// unpaywalled — no capture step needed, unlike bestsellers). The card reads
// the rails entry labeled "Robinhood Chain". Exit 1 on usage, 2 on render.
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "robinhood-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/robinhood-card.js --from <file|url> --out <png> [--preview]");
  process.exit(1);
}

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
// Terminal-card palette, sampled from the accepted TTS demo card (same as
// bestsellers-card.js): warm cream paper, warm charcoal window, cream type,
// green ONLY for OK/status, red ONLY for the agent402.tools wordmark.
const B = {
  paper: "#EFE8DA",
  window: "#2B2722",
  titlebar: "#201D19",
  inset: "#34302A",
  insetLine: "#4A453D",
  text: "#EFE7D2",
  muted: "#9A917F",
  green: "#8FC46F",
  red: "#E8542F",
  dotRed: "#E0533D",
  dotAmber: "#E0A33D",
  dotGray: "#8A857D",
  mono: "'Space Mono',Consolas,monospace",
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadJson(from) {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(from, "utf8"));
}

function cardSvg(data) {
  const mono = JSON.stringify(B.mono);
  const rail = (data.rails || []).find((r) => r.rail === "Robinhood Chain");
  if (!rail) throw new Error('no "Robinhood Chain" rail in the /api/revenue payload');
  const liveDate = new Date().toISOString().slice(0, 10);
  const settles = (rail.recent || []).filter((t) => t.usd > 0);
  const balance = rail.balance == null ? null : Number(rail.balance).toFixed(rail.balance >= 100 ? 2 : 3);
  // Up to 3 recent inbound settles, newest first — mirrors the bestsellers
  // result rows. An empty rail renders the honest "warming" line instead.
  const settleRows = settles.slice(0, 3)
    .map((t, i) => {
      const y = 404 + i * 30;
      const when = String(t.when || "").slice(0, 16).replace("T", " ");
      const tag = t.external ? "external" : "internal";
      const tagColor = t.external ? B.green : B.muted;
      return `<text x="126" y="${y}" font-size="19" font-family=${mono}><tspan font-weight="700" fill="${B.text}">+${Number(t.usd).toFixed(3)} USDG</tspan><tspan fill="${B.muted}"> · ${esc(when)} UTC · </tspan><tspan font-weight="700" fill="${tagColor}">${tag}</tspan></text>`;
    })
    .join("");
  const emptyRow = settles.length
    ? ""
    : `<text x="126" y="404" font-size="19" font-family=${mono} fill="${B.muted}">rail is live — settlements land here the moment an agent buys</text>`;
  // Preview renders may not claim "real output" — the tag replaces the claim.
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from live output</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · USDG settled on Robinhood Chain</text>`;
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 /robinhood</tspan><tspan fill="${B.muted}"> · the Robinhood Chain x402 marketplace · live ${esc(liveDate)} UTC</tspan></text>
  ${okRow(180, "rail", "Robinhood Chain (eip155:4663)", "USDG, settling live")}
  ${okRow(214, "tools", "500+ deterministic, pay per call", "from $0.001")}
  ${okRow(248, "checkout", "HTTP 402 → sign → result", "no signup, no invoice")}
  ${okRow(282, "sell", "serve /.well-known/x402", "listed free, ranked by health")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools/api/revenue</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">200</tspan><tspan fill="${B.text}"> · rail Robinhood Chain</tspan><tspan fill="${B.muted}">${balance == null ? "" : ` · merchant balance ${balance} USDG`}</tspan></text>
  ${settleRows}${emptyRow}
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">an x402 marketplace on Robinhood Chain · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const data = await loadJson(FROM);
  const png = await rasterizeSvg(cardSvg(data), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
} catch (e) {
  console.error(`render failed: ${e?.message || e}`);
  process.exit(2);
}
