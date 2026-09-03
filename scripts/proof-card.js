// Announcement card for /proof - the metered tier's receipt: the amount an
// agent was QUOTED before paying next to what it actually SETTLED, with the
// on-chain transaction. Same 1200x630 terminal-window style as
// bestsellers-card.js / robinhood-card.js, same REAL-numbers doctrine: the
// final card renders from the live /api/proof payload at post time; a fixture
// render must carry --preview, which replaces the "real output" claim.
//
// Row choice: the latest EXTERNAL settlement when one exists (a stranger's
// receipt is the point of the weekly post); otherwise the latest internal row,
// labelled on the card as our own daily canary - never dressed up as a buyer.
//
// Usage:
//   node scripts/proof-card.js --from https://agent402.tools/api/proof --out card.png
//   node scripts/proof-card.js --from fixture.json --out card.png --preview
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = () => `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
const B = {
  paper: "#EFE8DA", window: "#2B2722", titlebar: "#201D19", inset: "#34302A", insetLine: "#4A453D",
  text: "#EFE7D2", muted: "#9A917F", green: "#8FC46F", red: "#E8542F",
  dotRed: "#E0533D", dotAmber: "#E0A33D", dotGray: "#8A857D", mono: "'Space Mono',Consolas,monospace",
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n) => (n == null ? "n/a" : `$${Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);

/** Pick the row the card shows: external first, else internal (labelled). */
export function pickRow(proof) {
  if (proof?.external?.latest) return { row: proof.external.latest, side: "external" };
  if (proof?.internal?.latest) return { row: proof.internal.latest, side: "internal" };
  return null;
}

export function cardSvg(proof, { preview = false, fonts = true } = {}) {
  const mono = JSON.stringify(B.mono);
  const picked = pickRow(proof);
  if (!picked) throw new Error("no settlement row in the /api/proof payload");
  const { row, side } = picked;
  const pct = row.quoteUsd ? Math.round((row.settledUsd / row.quoteUsd) * 100) : null;
  const when = String(row.at || "").slice(0, 16).replace("T", " ");
  const tx = String(row.tx || "");
  const txShort = tx.length > 22 ? `${tx.slice(0, 12)}…${tx.slice(-8)}` : tx;
  const sideLabel = side === "external" ? "an outside buyer" : "our own daily canary (internal, labelled)";
  const sideColor = side === "external" ? B.green : B.muted;
  const ext = proof.external || {};
  const aggregate = ext.count
    ? `${ext.count} external settlement${ext.count === 1 ? "" : "s"} · ${usd(ext.settledUsd)} settled${ext.quotedUsd != null ? ` against ${usd(ext.quotedUsd)} quoted` : ""}`
    : "no outside buyer on this route yet - this receipt is ours, and it says so";
  const insetNote = preview
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data - final card renders from live /api/proof</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · settled on ${esc(row.network || "chain")} · agent402.tools/proof</text>`;
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.text}">${esc(detail)}</tspan><tspan fill="${B.muted}">  → ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${fonts ? FONT_STYLE() : ""}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">the price you saw first is the most you pay</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 /proof</tspan><tspan fill="${B.muted}"> · metered model route · one receipt, on-chain</tspan></text>
  ${okRow(180, "route", "POST /v1/metered/chat/completions", "quoted from the body")}
  ${okRow(214, "pay", "x402 upto, or a credits key", "the quote is a ceiling")}
  ${okRow(248, "settle", "actual usage x 1.15, under the quote", "receipt on the response")}
  ${okRow(282, "fail", "an error cancels settlement", "no receipt = not charged")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools/api/proof</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ latest receipt · </tspan><tspan font-weight="700" fill="${sideColor}">${esc(sideLabel)}</tspan></text>
  <text x="126" y="410" font-size="19" font-family=${mono}><tspan fill="${B.muted}">quoted ceiling </tspan><tspan font-weight="700" fill="${B.text}">${esc(usd(row.quoteUsd))}</tspan><tspan fill="${B.muted}">   settled </tspan><tspan font-weight="700" fill="${B.green}">${esc(usd(row.settledUsd))}</tspan>${pct != null ? `<tspan fill="${B.muted}"> (${pct}% of the ceiling)</tspan>` : ""}</text>
  <text x="126" y="440" font-size="19" font-family=${mono}><tspan fill="${B.muted}">tx </tspan><tspan fill="${B.text}">${esc(txShort)}</tspan><tspan fill="${B.muted}"> · ${esc(row.network || "")} / ${esc(row.wire || row.rail || "")} · ${esc(when)} UTC</tspan></text>
  <text x="126" y="470" font-size="16" font-family=${mono} fill="${B.muted}">${esc(aggregate)}</text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">usage priced under a quoted ceiling · </tspan><tspan font-weight="700" fill="${B.text}">receipts, not promises</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

async function loadJson(from) {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(from, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const FROM = arg("--from"), OUT = arg("--out") || "proof-card.png", PREVIEW = args.includes("--preview");
  if (!FROM) { console.error("usage: node scripts/proof-card.js --from <file|url> --out <png> [--preview]"); process.exit(1); }
  try {
    const { rasterizeSvg } = await import("../src/tools/render.js");
    const png = await rasterizeSvg(cardSvg(await loadJson(FROM), { preview: PREVIEW }), { width: 1200, height: 630 });
    writeFileSync(OUT, png);
    console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
    process.exit(0); // the rasterizer keeps a browser handle alive; the file is written
  } catch (e) { console.error(`render failed: ${e?.message || e}`); process.exit(2); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
