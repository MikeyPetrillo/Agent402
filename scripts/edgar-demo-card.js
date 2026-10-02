// Announcement demo card for a PAID tool call — renders a scripts/paid-demo.js
// capture (quote + result + settle receipt) as the standard 1200×630
// terminal-window card (reference: scripts/celo-card.js / bestsellers-card.js).
// Built for the company-financials (SEC EDGAR XBRL) example; the inset rows
// read the capture's real metrics, and the settle line carries the real tx.
//
// Real numbers only: the capture comes from an actual on-chain buy (the
// paid-demo workflow). --preview tags a fixture layout and replaces the
// "real output" claim.
//
// Usage:
//   node scripts/edgar-demo-card.js --from paid-demo-result.json --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "edgar-demo-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/edgar-demo-card.js --from <paid-demo-result.json> --out <png> [--preview]");
  process.exit(1);
}

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
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
const usdB = (v) => (v == null ? "n/a" : `$${(v / 1e9).toFixed(1)}B`);

function cardSvg(cap) {
  const mono = JSON.stringify(B.mono);
  const r = cap.result || {};
  const metric = (label) => (r.metrics || []).find((m) => m.label === label) || {};
  const rev = metric("Revenue"), ni = metric("Net Income"), oi = metric("Operating Income");
  const annualPeriod = rev.latestAnnual?.period || "";
  const chainLabel = cap.chain === "eip155:42220" ? "Celo" : cap.chain;
  const tx = cap.receipt?.transaction || "";
  const txShort = tx ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : "";
  const liveDate = new Date().toISOString().slice(0, 10);
  const toolPath = String(cap.tool || "").split("?")[0];
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from a real buy</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · $${cap.quote?.usd} USDC settled on ${esc(chainLabel)} · tx ${esc(txShort)}</text>`;
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 ${esc(toolPath)}</tspan><tspan fill="${B.muted}"> · SEC EDGAR XBRL, paid per call · ${esc(liveDate)}</tspan></text>
  ${okRow(180, "tool", "company-financials, deterministic", `$${cap.quote?.usd} per call`)}
  ${okRow(214, "pay", `USDC on ${chainLabel} (${cap.chain})`, "x402, gasless")}
  ${okRow(248, "settle", "on-chain receipt in the response", "no signup, no invoice")}
  ${okRow(282, "source", "SEC EDGAR company facts", "primary source, no scraping")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools${esc(cap.tool)}</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">402</tspan><tspan fill="${B.muted}"> · $${cap.quote?.usd} USDC on ${esc(chainLabel)} · pay + retry → </tspan><tspan font-weight="700" fill="${B.green}">200</tspan></text>
  <text x="126" y="410" font-size="19" font-family=${mono}><tspan font-weight="700" fill="${B.text}">${esc(r.entityName)}</tspan><tspan fill="${B.muted}"> · CIK ${esc(r.cik)} · 10-K ${esc(annualPeriod)}</tspan></text>
  <text x="126" y="440" font-size="19" font-family=${mono}><tspan fill="${B.muted}">Revenue </tspan><tspan font-weight="700" fill="${B.text}">${usdB(rev.latestAnnual?.value)}</tspan><tspan fill="${B.muted}"> · Net income </tspan><tspan font-weight="700" fill="${B.text}">${usdB(ni.latestAnnual?.value)}</tspan><tspan fill="${B.muted}"> · Op income </tspan><tspan font-weight="700" fill="${B.text}">${usdB(oi.latestAnnual?.value)}</tspan></text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">500+ tools, priced per call · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const cap = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(cap), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
  // The shared headless browser rasterizeSvg opens keeps the process alive.
  process.exit(0);
} catch (e) {
  console.error(`edgar-demo-card: ${e?.message || e}`);
  process.exit(2);
}
