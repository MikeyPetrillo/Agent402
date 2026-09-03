// The Agentic Finance (AIFI) card - one 1200x630 image that says what the
// category is and where Agent402 sits, in the site's own card language
// (obsidian + milled, Geist + Geist Mono; same tokens as the
// homepage /card.png in server.js). It is BOTH the og:image / twitter:image of
// /agentic-finance and /glossary (served at /og/agentic-finance.png, rasterized
// once per process like /card.png) AND the announcement image
// (scripts/aifi-card.js writes the same SVG to a PNG). One SVG, two uses, so
// the social preview and the post never drift. Definitional card: evergreen
// "500+" only, no live numbers (the real-numbers doctrine applies to cards that
// state numbers - this one states none). Fonts embedded, no network.
import { readFileSync } from "node:fs";

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
let fontStyle = null;
const FONT_STYLE = () => (fontStyle ??= `<style>
@font-face{font-family:'Geist Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("geist-mono-400-latin.woff2")}) format('woff2')}
@font-face{font-family:'Geist Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("geist-mono-700-latin.woff2")}) format('woff2')}
@font-face{font-family:'Geist';font-weight:600;src:url(data:font/woff2;base64,${fontB64("geist-600-latin.woff2")}) format('woff2')}
</style>`);
const B = { paper: "#0B0C0E", card: "#141619", ink: "#E9EAEC", muted: "#B3B9C0", faint: "#868D95", hairline: "#2C3136", accent: "#9EF0B0", mono: "'Geist Mono',Menlo,Consolas,monospace", display: "'Geist',system-ui,sans-serif" };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const AIFI_STACK = [
  ["01", "agents", "assistants · crawlers · research + trading agents", "buyers and sellers"],
  ["02", "applied layer", "discovery · routing · pricing · reliability · receipts", "Agent402"],
  ["03", "payment wires", "x402 · MPP - both answered on one 402", "open, HTTP-native"],
  ["04", "rails", "USDC on 12 chains · USDG · native Tempo · free via PoW", "wallet as identity"],
];

/** 1200x630 by default; other sizes letterbox the same art (GitHub wants 1280x640). */
export function aifiCardSvg(width = 1200, height = 630) {
  const s = Math.min(width / 1200, height / 630);
  const tx = (width - 1200 * s) / 2, ty = (height - 630 * s) / 2;
  const mono = JSON.stringify(B.mono), display = JSON.stringify(B.display);
  const rows = AIFI_STACK.map(([n, layer, detail, tag], i) => {
    const y = 356 + i * 46;
    const isUs = layer === "applied layer";
    return `<text x="84" y="${y}" font-size="15" font-weight="700" font-family=${mono} fill="${B.accent}">${n}</text>
  <text x="122" y="${y}" font-size="19" font-weight="700" font-family=${mono} fill="${B.ink}">${esc(layer)}</text>
  <text x="330" y="${y}" font-size="16" font-family=${mono} fill="${B.muted}">${esc(detail)}</text>
  <text x="1116" y="${y}" font-size="15" font-weight="${isUs ? 700 : 400}" font-family=${mono} text-anchor="end" fill="${isUs ? B.accent : B.faint}">${esc(tag)}</text>`;
  }).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${FONT_STYLE()}
  <rect width="${width}" height="${height}" fill="${B.paper}"/>
  <g transform="translate(${tx},${ty}) scale(${s})">
  <rect x="36" y="36" width="1128" height="558" rx="20" fill="${B.card}" stroke="${B.hairline}" stroke-width="2"/>
  <rect x="84" y="88" width="56" height="56" rx="14" fill="#E3E6E9"/>
  <text x="112" y="128" font-size="24" font-weight="700" font-family=${mono} text-anchor="middle" letter-spacing="-1" fill="${B.paper}">402</text>
  <text x="162" y="127" font-size="32" font-weight="600" font-family=${display} letter-spacing="-0.5" fill="${B.ink}">Agent402</text>
  <text x="1116" y="127" font-size="22" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.accent}">agent402.tools/agentic-finance</text>
  <line x1="84" y1="172" x2="1116" y2="172" stroke="${B.hairline}" stroke-width="2"/>
  <text x="84" y="252" font-size="72" font-weight="600" font-family=${display} letter-spacing="-2.5" fill="${B.ink}">Agentic Finance <tspan fill="${B.faint}">(AIFI)</tspan></text>
  <text x="84" y="298" font-size="21" font-family=${mono} fill="${B.muted}">agents that pay and get paid on their own - per request, over open protocols</text>
  <line x1="84" y1="322" x2="1116" y2="322" stroke="${B.hairline}" stroke-width="2"/>
  ${rows}
  <line x1="84" y1="540" x2="1116" y2="540" stroke="${B.hairline}" stroke-width="2"/>
  <text x="84" y="574" font-size="17" font-family=${mono} fill="${B.muted}">the definition, the stack, every term: <tspan font-weight="700" fill="${B.ink}">agent402.tools/glossary</tspan></text>
  <text x="1116" y="574" font-size="17" font-family=${mono} text-anchor="end" fill="${B.muted}">500+ tools</text>
  </g>
</svg>`;
}
