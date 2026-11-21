// Section Open Graph cards (src/og-cards.js): every section page derives its
// own og:image from its path, tool pages keep their per-tool card, pages with
// no section keep the homepage card, and every section SVG the server renders
// is well-formed with no template leak. Why: until 2026-09-14 every section
// page served the same /card.png, so every link preview looked identical.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { leastOurs } from "./lib/ours-clock.js";
import { JSDOM } from "jsdom";
import { ogSectionFor, ogSectionIds, sectionCardSvg, toolCardSvg } from "../src/og-cards.js";
import { LOGO_SVG, brandMarkTile, CARD_ART_VERSION } from "../src/brand-mark.js";
import { answerShareCardSvg } from "../src/answer-share.js";
import { aifiCardSvg } from "../src/aifi-card.js";
import { bootServer } from "./lib/boot-server.js";
import { createHash } from "node:crypto";

let pass = 0; let srv;
const fail = (m) => { console.error("FAIL:", m); try { srv?.child.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// ---- pure: the path -> section rule -------------------------------------
const cases = [["/why", null], ["/docs", "docs"], ["/tools", "tools"], ["/tools/attest", null], ["/guides/agent-hosts", "guides"],
  ["/reports/sample/dossier", "reports"], ["/reports/insider/NVDA", "reports"], ["/base", "chain-base"], ["/robinhood", "chain-robinhood"],
  ["/skills/crypto-dossier", "skills"], ["/company", null], ["/", null], ["https://agent402.tools/markets?x=1", "markets"], ["/monitors/thanks", "monitors"]];
for (const [p, want] of cases) ok(ogSectionFor(p) === want, `ogSectionFor(${p}) = ${want}`);
{ // CodeQL #192: a trailing-slash regex on caller-shaped input backtracks polynomially; the strip is linear and bounded now.
  // Synchronous, so read as the time the thread had a core, least of three.
  const { value: r, ms } = leastOurs(() => ogSectionFor("/docs" + "/".repeat(200000)));
  ok(r === "docs" && ms < 200, `200k trailing slashes resolve in ${ms.toFixed(1)} ms (linear, bounded)`);
}
const ids = ogSectionIds();
ok(ids.length >= 30 && new Set(ids).size === ids.length, `${ids.length} distinct section ids`);

// ---- pure: every section renders well-formed SVG with live figures ----------
const BRAND = { paper: "#0B0C0E", ink: "#E9EAEC", muted: "#B3B9C0", faint: "#868D95", hairline: "#2C3136", accent: "#9EF0B0", amber: "#F0B35E", mono: "'Geist Mono',monospace", display: "'Geist',sans-serif" };
const ctx = { BRAND, BRAND_DEFS: "<defs/>", BRAND_FONT_STYLE: "", toolCount: 600, railCount: 12, price: (s) => (s === "hash" ? "$0.001" : s === "research" ? "$0.60" : null), monitorPrice: "$5" };
let xmlErrors = 0;
const parser = new (new JSDOM("").window.DOMParser)();
for (const id of ids) {
  const svg = sectionCardSvg(id, ctx);
  if (!svg) fail(`no svg for ${id}`);
  if (svg.includes("${")) fail(`template leak in ${id}`);
  if (/[—–]/.test(svg)) fail(`em/en dash in ${id}`);
  if (!svg.includes("x402") || !svg.includes("MPP")) fail(`${id} does not name both x402 and MPP`);
  const doc = parser.parseFromString(svg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) { xmlErrors++; console.error(`XML error in ${id}`); }
}
ok(xmlErrors === 0, "every section SVG parses as XML (no bare & or unescaped <)");
ok(sectionCardSvg("nope", ctx) === null, "an unknown id renders nothing");
ok(sectionCardSvg("chain-base", ctx).includes("0.001") && sectionCardSvg("reports", ctx).includes("0.60"), "prices in the copy come from ctx.price, not typed");
ok(sectionCardSvg("tools", ctx).includes("600 tools"), "the tool count comes from ctx, not typed");

// ---- pure: every card carries the brand mark (black tile, white 402, red dot) ----
// The tile is the logo file's own art (assets/brand/logo.svg): its ground, its
// glyph color and its dot are read from the file, never typed on a card.
const logoFills = [...LOGO_SVG.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
const [GROUND, GLYPH, DOT] = logoFills;
const carriesMark = (svg) => svg.includes('data-brand-mark="402"') && svg.includes(`fill="${GROUND}"`) && svg.includes(`fill="${GLYPH}"`) && svg.includes(`fill="${DOT}"`) && /<circle[^>]*fill="#[0-9A-Fa-f]{6}"/.test(svg);
// The mark that the tile replaced: a blank light square, or one with "402" typed in a font.
const oldMark = (svg) => /<rect[^>]*(?:rx="12"|rx="14"|rx="16")[^>]*fill="(?:url\(#milled\)|#E3E6E9)"/.test(svg) || /text-anchor="middle"[^>]*>402<\/text>/.test(svg);
ok(logoFills.length === 3 && /^<g data-brand-mark="402">/.test(brandMarkTile(72, 64, 44)) && carriesMark(brandMarkTile(72, 64, 44)), `the tile is drawn from the logo file (${logoFills.join(", ")})`);
{
  const tile = brandMarkTile(72, 64, 44, { stroke: BRAND.hairline });
  const doc = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${tile}</svg>`, "image/svg+xml");
  ok(!doc.getElementsByTagName("parsererror").length && tile.includes('x="72"') && tile.includes('width="44"') && tile.includes(`stroke="${BRAND.hairline}"`) && /clip-path="url\(#[^)]+\)"/.test(tile), "the tile sits where the card puts it, corners clipped, a hairline around it");
  ok(brandMarkTile(72, 64, 44).match(/id="([^"]+)"/)[1] !== brandMarkTile(88, 66, 62).match(/id="([^"]+)"/)[1], "two tiles in one document get clip ids of their own");
}
const unmarked = ids.filter((id) => !carriesMark(sectionCardSvg(id, ctx)) || oldMark(sectionCardSvg(id, ctx)));
ok(unmarked.length === 0, `every section card carries the brand mark and not the square it replaced${unmarked.length ? ` (${unmarked.slice(0, 5).join(", ")})` : ""}`);
{
  const share = answerShareCardSvg({ id: "x", question: "What settles on Base?", citations: [{ url: "https://example.com" }], createdAt: Date.UTC(2026, 10, 1) }, { BRAND, BRAND_DEFS: "<defs/>", BRAND_FONT_STYLE: "" });
  ok(carriesMark(share) && !oldMark(share), "the answer-share card carries the brand mark");
  const aifi = aifiCardSvg();
  ok(carriesMark(aifi) && !oldMark(aifi), "the Agentic Finance card carries the brand mark");
  const tool = toolCardSvg({ name: "Hash", description: "Cryptographic hash of a text string", price: "$0.001", method: "POST", path: "/api/hash", categoryLabel: "Encoding & crypto", free: true }, { BRAND, BRAND_DEFS: "<defs/>", BRAND_FONT_STYLE: "" });
  ok(carriesMark(tool) && !oldMark(tool) && tool.includes("Hash") && tool.includes("$0.001 per call") && tool.includes("FREE w/ PoW") && tool.includes("Encoding &amp; crypto"), "the per-tool card carries the brand mark and the tool's own name, price and category");
  const paid = toolCardSvg({ name: "A <b> & c", description: "d".repeat(100), price: "$0.01", method: "GET", path: "/api/x", categoryLabel: "Web", free: false }, { BRAND, BRAND_DEFS: "<defs/>", BRAND_FONT_STYLE: "" });
  ok(!paid.includes("FREE w/ PoW") && paid.includes("A &lt;b&gt; &amp; c") && !parser.parseFromString(paid, "image/svg+xml").getElementsByTagName("parsererror").length && paid.includes("\u2026"), "a wallet-only tool's card offers no free tier, escapes its text and cuts a long description");
  ok(/^[1-9]\d*$/.test(CARD_ART_VERSION) && Number(CARD_ART_VERSION) >= 2, `the card art version was raised with the new mark (${CARD_ART_VERSION})`);
}

// ---- booted: the shell serves the derived card, the route renders it -------
srv = await bootServer({ stores: "og-cards", env: { FREE_MODE: "true", STRIPE_SECRET_KEY: "", CREDITS_SALES: "", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" } }).catch((e) => fail(`server did not boot: ${e.message}`));
const BASE = srv.url;
const og = async (p) => (/property="og:image" content="([^"]+)"/.exec(await (await fetch(BASE + p)).text()) || [])[1] || "";
ok(/\/og\/docs\.png\?v=/.test(await og("/docs")), "/docs serves /og/docs.png as its og:image");
ok(!ids.includes("why"), "no section card for /why (it redirects to /#why)");
ok(/\/og\/chain-base\.png/.test(await og("/base")), "/base serves the chain card");
ok(/\/og\/reports\.png/.test(await og("/reports/sample/dossier")), "a sample report page serves the reports card");
ok(/\/tools\/attest\/card\.png/.test(await og("/tools/attest")), "a tool page keeps its own card (explicit ogImage wins)");
ok((await og("/tools/attest")).endsWith(`/tools/attest/card.png?v=${CARD_ART_VERSION}`), "and links it under the card art version, so a preview cache refetches the new mark");
{
  const home = await (await fetch(`${BASE}/card.svg`)).text(), header = await (await fetch(`${BASE}/x-header.svg`)).text();
  ok(carriesMark(home) && !oldMark(home) && carriesMark(header) && !oldMark(header), "the home card and the profile header carry the brand mark");
  const toolPng = await fetch(`${BASE}/tools/attest/card.png?v=${CARD_ART_VERSION}`, { redirect: "manual" });
  ok(toolPng.status === 200 || toolPng.status === 302, `the versioned per-tool card renders (${toolPng.status})`);
}
ok(/\/card\.png\?v=/.test(await og("/company")), "a page with no section keeps the homepage card");
{ // The home card follows the card switch, and its URL version carries a hash of the card itself.
  const cardSvgBody = await (await fetch(`${BASE}/card.svg`)).text();
  ok(!/by card/.test(cardSvgBody) && !/MPP · card/.test(cardSvgBody) && /verify paid calls over x402 and MPP\./.test(cardSvgBody) && /x402 · MPP</.test(cardSvgBody), "no card sale on this boot: the social card offers no card");
  const v = (/\/card\.png\?v=([^"&]+)/.exec(await og("/company")) || [])[1] || "";
  const sha = createHash("sha256").update(cardSvgBody).digest("hex").slice(0, 8);
  ok(new RegExp(`^\\d+\\.${sha}$`).test(v), `the card URL version is the tool count and a hash of the card (${v}, card ${sha})`);
}
ok(/\/og\/agentic-finance\.png/.test(await og("/agentic-finance")), "the pre-existing explicit card is untouched");
const svgRes = await fetch(`${BASE}/og/markets.svg`);
ok(svgRes.status === 200 && /svg\+xml/.test(svgRes.headers.get("content-type")), "/og/markets.svg answers 200 image/svg+xml");
{ // The square mark's gradient left with the square: no served card defines or paints it.
  for (const p of ["/card.svg", "/og/markets.svg", "/x-header.svg"]) {
    const svg = await (await fetch(BASE + p)).text();
    ok(!/id="milled"/.test(svg) && !svg.includes("url(#milled)"), `${p} carries no gradient for the mark the tile replaced`);
  }
}
const missing = await fetch(`${BASE}/og/nope.png`);
ok(missing.status === 404, "an unknown section id is a 404, not a card");
const png = await fetch(`${BASE}/og/docs.png`, { redirect: "manual" });
ok(png.status === 200 || png.status === 302, `/og/docs.png renders (${png.status}: png when Chromium is present, svg redirect otherwise)`);
await srv.stop();
console.log(`\n${pass} passed`);
