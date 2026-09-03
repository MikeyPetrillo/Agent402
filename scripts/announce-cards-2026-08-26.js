// Four announcement cards (2026-08-26) in the site's card language (obsidian,
// Geist + Geist Mono, same tokens as src/aifi-card.js and /card.png):
//   cards    - agents pay by card over MPP (Stripe / Link), first live settle
//   rails    - one 402, every rail: 12 USDC chains, USDG, Tempo MPP, cards
//   reports  - the human report/monitor products, prices DERIVED from the
//              product tables (real-numbers doctrine: never typed by hand)
//   mcp      - hosted connector: MCP tasks extension + native MPP on /mcp
//
//   node scripts/announce-cards-2026-08-26.js --out docs/announcements/media [--only cards]
//
// Exits explicitly: the shared headless Chromium keeps the process alive
// otherwise (scripts/aifi-card.js hangs after writing for that reason).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rasterizeSvg } from "../src/tools/render.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT_DIR = arg("--out") || "docs/announcements/media";
const ONLY = arg("--only");
const DATE = "2026-08-26";

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
let fontStyle = null;
const FONT_STYLE = () => (fontStyle ??= `<style>
@font-face{font-family:'Geist Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("geist-mono-400-latin.woff2")}) format('woff2')}
@font-face{font-family:'Geist Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("geist-mono-700-latin.woff2")}) format('woff2')}
@font-face{font-family:'Geist';font-weight:600;src:url(data:font/woff2;base64,${fontB64("geist-600-latin.woff2")}) format('woff2')}
</style>`);
const B = { paper: "#0B0C0E", card: "#141619", panel: "#1C2024", ink: "#E9EAEC", muted: "#B3B9C0", faint: "#868D95", hairline: "#2C3136", accent: "#9EF0B0", amber: "#F0B35E", mono: "'Geist Mono',Menlo,Consolas,monospace", display: "'Geist',system-ui,sans-serif" };
const MONO = JSON.stringify(B.mono), DISPLAY = JSON.stringify(B.display);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shared frame: mark, name, accent URL, headline, mono sub, footer. */
function frame({ url, headline, headlineDim = "", sub, body, footerLeft, footerRight }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${FONT_STYLE()}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="36" width="1128" height="558" rx="20" fill="${B.card}" stroke="${B.hairline}" stroke-width="2"/>
  <rect x="84" y="88" width="56" height="56" rx="14" fill="#E3E6E9"/>
  <text x="112" y="128" font-size="24" font-weight="700" font-family=${MONO} text-anchor="middle" letter-spacing="-1" fill="${B.paper}">402</text>
  <text x="162" y="127" font-size="32" font-weight="600" font-family=${DISPLAY} letter-spacing="-0.5" fill="${B.ink}">Agent402</text>
  <text x="1116" y="127" font-size="22" font-weight="700" font-family=${MONO} text-anchor="end" fill="${B.accent}">${esc(url)}</text>
  <line x1="84" y1="172" x2="1116" y2="172" stroke="${B.hairline}" stroke-width="2"/>
  <text x="84" y="246" font-size="64" font-weight="600" font-family=${DISPLAY} letter-spacing="-2.5" fill="${B.ink}">${esc(headline)}${headlineDim ? ` <tspan fill="${B.faint}">${esc(headlineDim)}</tspan>` : ""}</text>
  <text x="84" y="290" font-size="20" font-family=${MONO} fill="${B.muted}">${esc(sub)}</text>
  <line x1="84" y1="314" x2="1116" y2="314" stroke="${B.hairline}" stroke-width="2"/>
  ${body}
  <line x1="84" y1="540" x2="1116" y2="540" stroke="${B.hairline}" stroke-width="2"/>
  <text x="84" y="574" font-size="17" font-family=${MONO} fill="${B.muted}">${footerLeft}</text>
  <text x="1116" y="574" font-size="17" font-family=${MONO} text-anchor="end" fill="${B.muted}">${esc(footerRight)}</text>
</svg>`;
}

// ---- 1. cards ---------------------------------------------------------------
function cardsSvg() {
  // The live 402's WWW-Authenticate shape, verbatim in spirit: one Payment
  // challenge per rail; the stripe one is the addition.
  const rows = [
    ["evm", "USDC on Base and Celo (x402 accepts cover 12 chains)", false],
    ["tempo", "USDC.e on Tempo, MPP native", false],
    ["stripe", "card from a Link wallet, settled by Stripe", true],
  ];
  const lines = rows.map(([m, d, isNew], i) => {
    const y = 380 + i * 40;
    return `<text x="112" y="${y}" font-size="18" font-family=${MONO} fill="${B.faint}">Payment</text>
  <text x="200" y="${y}" font-size="18" font-weight="700" font-family=${MONO} fill="${isNew ? B.accent : B.ink}">method="${m}"</text>
  <text x="418" y="${y}" font-size="18" font-family=${MONO} fill="${B.faint}">intent="charge"</text>
  <text x="620" y="${y}" font-size="17" font-family=${MONO} fill="${isNew ? B.ink : B.muted}">${esc(d)}</text>
  ${isNew ? `<text x="1088" y="${y}" font-size="15" font-weight="700" font-family=${MONO} text-anchor="end" fill="${B.accent}">new</text>` : ""}`;
  }).join("\n  ");
  const body = `
  <rect x="84" y="330" width="1032" height="196" rx="14" fill="${B.panel}" stroke="${B.hairline}" stroke-width="1.5"/>
  <text x="112" y="356" font-size="17" font-family=${MONO} fill="${B.muted}">HTTP/2 402 <tspan fill="${B.faint}">WWW-Authenticate:</tspan></text>
  ${lines}
  <text x="112" y="506" font-size="17" font-family=${MONO} fill="${B.muted}"><tspan fill="${B.faint}">retry with</tspan> Authorization: Payment &lt;spt&gt; <tspan fill="${B.faint}">→</tspan> <tspan font-weight="700" fill="${B.accent}">200</tspan> <tspan fill="${B.faint}">+</tspan> Payment-Receipt: stripe · pi_…</text>`;
  return frame({
    url: "agent402.tools",
    headline: "Agents can pay by card now.",
    sub: "same HTTP 402, one more offer: a card in a Link wallet, paid over MPP, no crypto wallet",
    body,
    footerLeft: `first live card settlement <tspan font-weight="700" fill="${B.ink}">${DATE}</tspan> (pi_3U8VOX…) · stablecoin rails unchanged`,
    footerRight: "500+ tools",
  });
}

// ---- 2. rails ---------------------------------------------------------------
function railsSvg() {
  const chains = ["Base", "Solana", "Polygon", "Arbitrum", "Algorand", "Stellar", "Monad", "Celo", "Avalanche", "Sei", "Optimism", "Robinhood"];
  const chips = [];
  const cols = 6, cw = 168, ch = 44, gx = 4.8, gy = 12, x0 = 84, y0 = 336;
  chains.forEach((c, i) => {
    const x = x0 + (i % cols) * (cw + gx), y = y0 + Math.floor(i / cols) * (ch + gy);
    const asset = c === "Robinhood" ? "USDG" : "USDC";
    chips.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${B.panel}" stroke="${B.hairline}" stroke-width="1.5"/>
  <text x="${x + 14}" y="${y + 28}" font-size="17" font-weight="700" font-family=${MONO} fill="${B.ink}">${esc(c)}</text>
  <text x="${x + cw - 12}" y="${y + 28}" font-size="13" font-family=${MONO} text-anchor="end" fill="${B.faint}">${asset}</text>`);
  });
  const y2 = y0 + 2 * (ch + gy) + 6;
  const wide = [["Tempo", "MPP native · USDC.e", false], ["Card", "Stripe · Link wallet · MPP", true], ["Free tier", "proof-of-work · no wallet", false]];
  wide.forEach(([t, d, hi], i) => {
    const w = 340, x = x0 + i * (w + 6);
    chips.push(`<rect x="${x}" y="${y2}" width="${w}" height="${ch}" rx="10" fill="${B.panel}" stroke="${hi ? B.accent : B.hairline}" stroke-width="1.5"/>
  <text x="${x + 14}" y="${y2 + 28}" font-size="17" font-weight="700" font-family=${MONO} fill="${hi ? B.accent : B.ink}">${esc(t)}</text>
  <text x="${x + w - 12}" y="${y2 + 28}" font-size="13" font-family=${MONO} text-anchor="end" fill="${B.faint}">${esc(d)}</text>`);
  });
  const body = chips.join("\n  ") + `
  <text x="84" y="${y2 + 72}" font-size="15" font-family=${MONO} fill="${B.muted}"><tspan fill="${B.faint}">settled by</tspan>  Coinbase CDP · PayAI · GoPlausible · Celo · Naven · molandak · Solvador · Stellar (ours)</text>`;
  return frame({
    url: "agent402.tools",
    headline: "One 402, every rail.",
    sub: "the buyer picks the chain, the wire, or the card; the tool and the price are the same",
    body,
    footerLeft: `x402 v2 + MPP on the same response · <tspan font-weight="700" fill="${B.ink}">agent402.tools/marketplace</tspan>`,
    footerRight: "500+ tools",
  });
}

// ---- 3. reports -------------------------------------------------------------
function reportsSvg() {
  const usd = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
  const H = HUMAN_PRODUCTS, M = MONITOR_PRODUCTS;
  const mon = (k) => (M[k] ? `${usd(M[k].price)}/mo` : "");
  // Rows: label, one-shot card price (derived), monitor price (derived).
  const rows = [
    ["Insider flow (Form 4)", usd(H["insider-report"].price), mon("insider-monitor")],
    ["Fund 13F holdings + changes", usd(H["fund-report"].price), mon("fund-monitor")],
    ["FDA recall report", usd(H["recall-report"].price), mon("recall-monitor")],
    ["SEC filing report", usd(H["filing-report"].price), mon("filing-monitor")],
    ["Domain security audit", usd(H["domain-audit"].price), mon("domain-monitor")],
    ["Deep research report", `${usd(H["research"].price)} to ${usd(H["research-max"].price)}`, ""],
    ["IPO pipeline digest", "", mon("ipo-monitor")],
  ];
  const lines = rows.map(([label, once, monthly], i) => {
    const y = 358 + i * 27;
    return `<text x="84" y="${y}" font-size="17" font-weight="700" font-family=${MONO} fill="${B.ink}">${esc(label)}</text>
  <text x="700" y="${y}" font-size="16" font-family=${MONO} fill="${once ? B.muted : B.faint}">${once ? esc(once) + " by card" : "·"}</text>
  <text x="1116" y="${y}" font-size="16" font-family=${MONO} text-anchor="end" fill="${monthly ? B.accent : B.faint}">${monthly ? esc(monthly) + " watch" : "·"}</text>`;
  }).join("\n  ");
  return frame({
    url: "agent402.tools/reports",
    headline: "Reports for people.",
    sub: "cited, from primary sources (EDGAR, openFDA, DNS/TLS), minutes after checkout",
    body: lines,
    footerLeft: `watch = emailed the moment something changes · <tspan font-weight="700" fill="${B.ink}">agent402.tools/monitors</tspan>`,
    footerRight: "agents pay per call",
  });
}

// ---- 4. mcp -----------------------------------------------------------------
function mcpSvg() {
  const L = [
    ["→", "tools/call", `research-deep`, `_meta: io.modelcontextprotocol/tasks`, false],
    ["←", "task", `{ taskId, status: "working", pollIntervalMs }`, "", false],
    ["→", "tasks/get", `taskId`, "", false],
    ["←", "result", `{ status: "completed", report, sources }`, "minutes later, no held socket", true],
    ["→", "tools/call", `catalog.call research-deep`, "wallet-only tool, $0.60+", false],
    ["←", "-32042", `Payment Required · data.challenges: [evm, tempo, stripe]`, "stripe from $0.50", false],
    ["→", "tools/call", `catalog.call research-deep`, `_meta["org.paymentauth/credential"]`, false],
    ["←", "result", `+ _meta["org.paymentauth/receipt"]`, "settled by the same paid route", true],
  ];
  const lines = L.map(([dir, verb, rest, note, hi], i) => {
    const y = 352 + i * 23;
    return `<text x="100" y="${y}" font-size="16" font-family=${MONO} fill="${B.faint}">${dir}</text>
  <text x="126" y="${y}" font-size="16" font-weight="700" font-family=${MONO} fill="${hi ? B.accent : B.ink}">${esc(verb)}</text>
  <text x="262" y="${y}" font-size="16" font-family=${MONO} fill="${B.muted}">${esc(rest)}</text>
  ${note ? `<text x="1100" y="${y}" font-size="14" font-family=${MONO} text-anchor="end" fill="${B.faint}">${esc(note)}</text>` : ""}`;
  }).join("\n  ");
  const body = `<rect x="84" y="330" width="1032" height="196" rx="14" fill="${B.panel}" stroke="${B.hairline}" stroke-width="1.5"/>
  ${lines}`;
  return frame({
    url: "agent402.tools/mcp",
    headline: "The MCP connector grew up.",
    sub: "long jobs return a task you poll (MCP tasks extension); paid tools settle right on the connector",
    body,
    footerLeft: `one connector, 500+ tools, x402 + MPP + cards · <tspan font-weight="700" fill="${B.ink}">agent402.tools/mcp</tspan>`,
    footerRight: "stdio: npx agent402-mcp",
  });
}

const CARDS = { cards: cardsSvg, rails: railsSvg, reports: reportsSvg, mcp: mcpSvg };
mkdirSync(OUT_DIR, { recursive: true });
let code = 0;
for (const [name, build] of Object.entries(CARDS)) {
  if (ONLY && ONLY !== name) continue;
  const out = join(OUT_DIR, `${DATE}-${name}-card.png`);
  try {
    const png = await rasterizeSvg(build(), { width: 1200, height: 630 });
    writeFileSync(out, png);
    console.log(`wrote ${out} (${png.length} bytes)`);
  } catch (e) { console.error(`${name}: render failed: ${e?.message || e}`); code = 2; }
}
process.exit(code);
