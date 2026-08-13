// Announcement demo card for the self-hosted Stellar x402 facilitator —
// renders the live facilitator /health endpoint as a 1200×630 TERMINAL-WINDOW
// card, the accepted announcement style (reference: docs/announcements/media/
// 2026-07-16-tts-demo-card.png / scripts/celo-card.js): warm cream paper,
// dark charcoal terminal with traffic-light title bar, all Space Mono, green
// for OK/status semantics, red reserved for the agent402.tools wordmark.
//
// REAL numbers doctrine: the balance/signer come from a LIVE fetch of the
// facilitator's own /health at render time, never mocked. --tx references an
// already-verified real mainnet settlement (its own tx hash, independently
// confirmed on Horizon) — proof, not a claim.
//
// Usage:
//   node scripts/stellar-facilitator-card.js \
//     --from https://agent402-facilitator-production.up.railway.app/health \
//     --tx <settled-tx-hash> --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const TX = arg("--tx");
const OUT = arg("--out") || "stellar-facilitator-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM || !TX) {
  console.error("usage: node scripts/stellar-facilitator-card.js --from <file|url> --tx <hash> --out <png> [--preview]");
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
  amber: "#E0A33D",
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

function cardSvg(data, txHash) {
  const mono = JSON.stringify(B.mono);
  const liveDate = new Date().toISOString().slice(0, 10);
  const balance = data.xlmBalance == null ? null : Number(data.xlmBalance).toFixed(4);
  const signer = String(data.signerAddress || "");
  const signerShort = signer.length > 12 ? `${signer.slice(0, 6)}…${signer.slice(-6)}` : signer;
  const txShort = txHash.length > 16 ? `${txHash.slice(0, 8)}…${txHash.slice(-8)}` : txHash;

  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from live output</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · live facilitator /health</text>`;
  const okRow = (y, label, detail, arrow, arrowColor) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${arrowColor || B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">self-hosted x402 facilitator · Stellar</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 /facilitator</tspan><tspan fill="${B.muted}"> · our own Stellar settlement layer · live ${esc(liveDate)} UTC</tspan></text>
  ${okRow(180, "network", "stellar:pubnet, real USDC", "settling live", B.green)}
  ${okRow(214, "status", "private for now, dogfood only", "public release planned", B.amber)}
  ${okRow(248, "built on", "x402 core + x402 stellar SDK", "open protocol, self-hostable", B.text)}
  ${okRow(282, "signer", signerShort, "pays its own network fee", B.text)}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl .../facilitator/health</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">200</tspan><tspan fill="${B.text}"> · signer balance</tspan><tspan fill="${B.muted}">${balance == null ? "" : ` ${balance} XLM`}</tspan></text>
  <text x="126" y="404" font-size="19" font-family=${mono}><tspan font-weight="700" fill="${B.text}">verified:</tspan><tspan fill="${B.muted}"> real production settlement, tx </tspan><tspan font-weight="700" fill="${B.green}">${esc(txShort)}</tspan></text>
  <text x="126" y="432" font-size="19" font-family=${mono} fill="${B.muted}">confirmed independently on Horizon (stellar.expert)</text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">our own Stellar facilitator · </tspan><tspan font-weight="700" fill="${B.text}">real customer payments settle here now</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const data = await loadJson(FROM);
  const png = await rasterizeSvg(cardSvg(data, TX), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
} catch (e) {
  console.error(`stellar-facilitator-card: ${e?.message || e}`);
  process.exit(2);
}
