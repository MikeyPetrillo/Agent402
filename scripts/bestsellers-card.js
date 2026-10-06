// Announcement demo card for the bestsellers tool — renders the tool's actual
// JSON response as a 1200×630 TERMINAL-WINDOW card, the accepted announcement
// style (reference: the TTS demo card on
// the dev branch / x.com status 2077707505405448409): warm cream paper, dark
// charcoal terminal with traffic-light title bar, all Space Mono, green for
// OK/status semantics, red reserved for the agent402.tools wordmark.
//
// The standing announcement flow wants REAL numbers: render the FINAL card
// from live prod output at post time, never from mocked data. A layout
// preview from fixture data must carry the on-card "preview data" tag
// (--preview), which also REPLACES the "real output" claim — a fixture render
// can never label itself real.
//
// Usage:
//   node scripts/bestsellers-card.js --from response.json --out card.png
//   node scripts/bestsellers-card.js --from https://… --out card.png
//   node scripts/bestsellers-card.js --from fixture.json --out card.png --preview
//
// --from accepts a file path or URL returning the /api/bestsellers JSON
// (the endpoint is paid — capture the JSON once via scripts/capture-bestsellers.js
// or the buyer SDK, then render from the file). Exit 1 on usage, 2 on render.
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "bestsellers-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/bestsellers-card.js --from <file|url> --out <png> [--preview]");
  process.exit(1);
}

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
// Terminal-card palette, sampled from the accepted TTS demo card: warm cream
// paper, warm charcoal window, cream type, green ONLY for OK/status, red ONLY
// for the agent402.tools wordmark.
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
    if (res.status === 402) throw new Error("endpoint is paid (402) — capture the JSON once via scripts/capture-bestsellers.js, then render with --from <file>");
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(from, "utf8"));
}

function cardSvg(data) {
  const mono = JSON.stringify(B.mono);
  const rows = (data.bestsellers || []).slice(0, 3);
  const days = data.days ?? 30;
  const liveDate = String(data.generatedAt || "").slice(0, 10);
  const trendColor = (t) => (t === "rising" || t === "new" ? B.green : B.muted);
  // OK feature rows: green OK · bold label · muted detail · → bold takeaway.
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  const resultRows = rows
    .map((r, i) => {
      const y = 404 + i * 30;
      return `<text x="126" y="${y}" font-size="19" font-family=${mono}><tspan font-weight="700" fill="${B.text}">#${r.rank} ${esc(r.slug)}</tspan><tspan fill="${B.muted}"> · ${r.sales} sale${r.sales === 1 ? "" : "s"} · ${r.buyers} buyer${r.buyers === 1 ? "" : "s"} · </tspan><tspan font-weight="700" fill="${trendColor(r.trend)}">${esc(r.trend)}</tspan></text>`;
    })
    .join("");
  const emptyRow = rows.length
    ? ""
    : `<text x="126" y="404" font-size="19" font-family=${mono} fill="${B.muted}">ledger warming — every external paid call lands here by name</text>`;
  // Preview renders may not claim "real output" — the tag replaces the claim.
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from live output</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · $0.005 settled on Base</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 GET /api/bestsellers</tspan><tspan fill="${B.muted}"> · catalog demand, ranked${liveDate ? ` · live ${esc(liveDate)} UTC` : ""}</tspan></text>
  ${okRow(180, "buyers", "distinct paying wallets", "whale-resistant ranking")}
  ${okRow(214, "trend", `vs the previous ${days}-day window`, "rising / flat / cooling / new")}
  ${okRow(248, "receipts", "every sale settled on-chain", "canary traffic excluded")}
  ${okRow(282, "price", "$0.005 per call · USDC over x402", "no signup, no key")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools/api/bestsellers?sort=buyers</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">200</tspan><tspan fill="${B.text}"> · application/json · </tspan><tspan font-weight="700" fill="${B.text}">top ${rows.length || "-"} by distinct buyers · ${days}d</tspan></text>
  ${resultRows}${emptyRow}
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">the chain never says which tool · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const data = await loadJson(FROM);
  const png = await rasterizeSvg(cardSvg(data), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
  process.exit(0); // render.js keeps its shared browser alive — exit explicitly
} catch (e) {
  console.error(`card render failed: ${e.message}`);
  process.exit(2);
}
