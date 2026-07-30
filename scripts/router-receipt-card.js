// Announcement demo card for a routed external buy — renders a REAL
// /api/route/execute response (receipt + result) as a 1200×630
// TERMINAL-WINDOW card, the accepted announcement style (reference:
// scripts/bestsellers-card.js / robinhood-card.js): warm cream paper, dark
// charcoal terminal, all Space Mono, green for OK/status, red reserved for
// the agent402.tools wordmark.
//
// The standing announcement flow wants REAL numbers: render from the actual
// routed-buy response captured at buy time, never from mocked data. A layout
// preview from fixture data must carry the on-card "preview data" tag
// (--preview), which also REPLACES the "real output" claim.
//
// Usage:
//   node scripts/router-receipt-card.js --from response.json --out card.png [--preview]
//
// --from is a file holding the route-execute response JSON ({receipt, result}).
// The card prints the receipt fields a counterparty verifies: seller, settle
// network (CAIP-2), settleTx, callRef, and a sha256 over the relayed result
// (computed here, canonical JSON.stringify of `result`). Exit 1 usage, 2 render.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "router-receipt-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/router-receipt-card.js --from <response.json> --out <png> [--preview]");
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
const mid = (s, head = 14, tail = 10) => {
  const v = String(s ?? "");
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
};

function cardSvg(data) {
  const mono = JSON.stringify(B.mono);
  const r = data.receipt;
  if (!r) throw new Error("no receipt in the response JSON");
  const resultHash = "sha256:" + createHash("sha256").update(JSON.stringify(data.result ?? null)).digest("hex");
  const sellerHost = (() => { try { return new URL(String(r.route || "").split(" ").pop()).host; } catch { return String(r.seller || "internal"); } })();
  const liveDate = String(r.ts || "").slice(0, 10);
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  const kvRow = (y, k, v) =>
    `<text x="126" y="${y}" font-size="18" font-family=${mono}><tspan fill="${B.muted}">${esc(k)} </tspan><tspan font-weight="700" fill="${B.text}">${esc(v)}</tspan></text>`;
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from live output</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · routed buy settled on-chain</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">one payment, one wallet · the router receipt</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 POST /api/route/execute</tspan><tspan fill="${B.muted}"> · routed buy from the open x402 index${liveDate ? ` · ${esc(liveDate)} UTC` : ""}</tspan></text>
  ${okRow(180, "resolve", "best proven seller in the index", esc(sellerHost))}
  ${okRow(214, "settle", `chain-matched · ${esc(r.settleNetwork || "internal")}`, r.external ? "paid on your behalf" : "internal dispatch")}
  ${okRow(248, "price", `$${r.paidUsd} flat · $${r.underlyingPriceUsd} to seller`, `routing fee $${r.routingFeeUsd}`)}
  ${okRow(282, "verify", "every field recomputable offline", "receipt below")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="344" font-size="18" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl -X POST agent402.tools/api/route/execute  </tspan><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">200</tspan></text>
  ${kvRow(374, "slug     ", r.slug)}
  ${kvRow(402, "settleTx ", mid(r.settleTx, 20, 14))}
  ${kvRow(430, "callRef  ", mid(r.callRef, 20, 14))}
  ${kvRow(458, "result   ", mid(resultHash, 20, 14))}
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">the open x402 index · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const data = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(data), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  const resultHash = "sha256:" + createHash("sha256").update(JSON.stringify(data.result ?? null)).digest("hex");
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
  console.log(`resultHash ${resultHash}`);
} catch (e) {
  console.error(`render failed: ${e?.message || e}`);
  process.exit(2);
}
