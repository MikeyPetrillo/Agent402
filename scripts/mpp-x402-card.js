// Announcement card: one live 402, two payment wires (MPP + x402) — renders
// a REAL challenge captured from production at render time as a 1200×630
// TERMINAL-WINDOW card, the accepted announcement style (reference:
// scripts/router-receipt-card.js / robinhood-card.js): warm cream paper, dark
// charcoal terminal, all Space Mono, green for OK/status, red reserved for
// the agent402.tools wordmark.
//
// The standing announcement flow wants REAL numbers: the card fetches the 402
// (both wire headers) and /api/stats live, never from mocked data. A layout
// preview must carry the on-card "preview data" tag (--preview), which also
// REPLACES the "live capture" claim.
//
// Usage:
//   node scripts/mpp-x402-card.js --out card.png [--route /api/dns] [--base https://agent402.tools] [--preview]
//
// Exit 1 usage, 2 render/fetch.
import { writeFileSync, readFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const OUT = arg("--out") || "mpp-x402-card.png";
const ROUTE = arg("--route") || "/api/dns";
const BASE = (arg("--base") || "https://agent402.tools").replace(/\/+$/, "");
const PREVIEW = args.includes("--preview");

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

/** Capture the live 402: both wire headers off one unpaid GET. */
async function capture() {
  const res = await fetch(BASE + ROUTE, { redirect: "manual" });
  if (res.status !== 402) throw new Error(`expected 402 from ${ROUTE}, got ${res.status}`);
  const wa = res.headers.get("www-authenticate") || "";
  const pr = res.headers.get("payment-required") || "";
  if (!/^Payment /i.test(wa)) throw new Error("402 carried no MPP WWW-Authenticate: Payment challenge");
  if (!pr) throw new Error("402 carried no x402 payment-required header");
  const j = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
  const networks = [...new Set((j.accepts || []).map((a) => a.network))];
  if (!networks.length) throw new Error("x402 challenge decoded to zero networks");
  const mppId = (wa.match(/id="([^"]+)"/) || [])[1] || "";
  const stats = await (await fetch(BASE + "/api/stats")).json();
  const served = stats?.toolCallsServed || {};
  return { networks, mppId, paidCalls: served.viaUSDC, mppWire: served.viaMPPWire };
}

function cardSvg(d) {
  const mono = JSON.stringify(B.mono);
  const chains = d.networks.length;
  const chainSample = "Base · Solana · Algorand · Stellar · Polygon";
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="330" fill="${B.muted}">${esc(detail)}</tspan><tspan x="810" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  const hRow = (y, k, v, hi) =>
    `<text x="126" y="${y}" font-size="18" font-family=${mono}><tspan fill="${hi ? B.green : B.muted}">${esc(k)}</tspan><tspan fill="${B.text}"> ${esc(v)}</tspan></text>`;
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from a live 402</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real headers · captured live at render time</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">one 402, two payment wires · MPP + x402</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">GET ${esc(ROUTE)}</tspan><tspan fill="${B.muted}"> unpaid → HTTP </tspan><tspan font-weight="700" fill="${B.green}">402</tspan><tspan fill="${B.muted}"> · both challenges on the same response</tspan></text>
  ${okRow(180, "MPP wire", "WWW-Authenticate: Payment challenge", "IETF-track scheme")}
  ${okRow(214, "x402 wire", "payment-required: x402 v2 accepts", `${chains} chains, USDC`)}
  ${okRow(248, "settle", "either wire, one settle authority", "never double-charged")}
  ${okRow(282, "receipt", "mirrored to both dialects", "Payment-Receipt")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="344" font-size="18" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl -i ${esc(BASE.replace(/^https?:\/\//, ""))}${esc(ROUTE)}</tspan></text>
  ${hRow(374, "www-authenticate:", `Payment id="${mid(d.mppId, 10, 6)}" realm="agent402.tools" method="evm"`, true)}
  ${hRow(402, "payment-required:", `x402 v2 · ${chains} networks · ${chainSample} +${chains - 5}`, true)}
  ${hRow(430, "pay on either →", "HTTP 200 + settle receipt on the matching wire", false)}
  ${hRow(458, "served so far  →", `${Number(d.paidCalls).toLocaleString()} paid calls · ${Number(d.mppWire).toLocaleString()} over the MPP wire`, false)}
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">500+ tools · </tspan><tspan font-weight="700" fill="${B.text}">every one speaks both wires</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const data = PREVIEW
    ? { networks: Array.from({ length: 12 }, (_, i) => `net${i}`), mppId: "PreviewFixture0000000000", paidCalls: 12345, mppWire: 12 }
    : await capture();
  const png = await rasterizeSvg(cardSvg(data), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
  console.log(`networks=${data.networks.length} paidCalls=${data.paidCalls} mppWire=${data.mppWire}`);
} catch (e) {
  console.error(`render failed: ${e?.message || e}`);
  process.exit(2);
}
