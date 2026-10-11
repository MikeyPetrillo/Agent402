// Section Open Graph cards (src/og-cards.js): every section page derives its
// own og:image from its path, tool pages keep their per-tool card, pages with
// no section keep the homepage card, and every section SVG the server renders
// is well-formed with no template leak. Why: until 2026-09-14 every section
// page served the same /card.png, so every link preview looked identical.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { ogSectionFor, ogSectionIds, sectionCardSvg } from "../src/og-cards.js";
import { getFreePort } from "./lib/free-port.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; let proc;
const fail = (m) => { console.error("FAIL:", m); try { proc?.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// ---- pure: the path -> section rule -------------------------------------
const cases = [["/why", null], ["/docs", "docs"], ["/tools", "tools"], ["/tools/attest", null], ["/guides/agent-hosts", "guides"],
  ["/reports/sample/dossier", "reports"], ["/reports/insider/NVDA", "reports"], ["/base", "chain-base"], ["/robinhood", "chain-robinhood"],
  ["/skills/crypto-dossier", "skills"], ["/company", null], ["/", null], ["https://agent402.tools/markets?x=1", "markets"], ["/monitors/thanks", "monitors"]];
for (const [p, want] of cases) ok(ogSectionFor(p) === want, `ogSectionFor(${p}) = ${want}`);
{ // CodeQL #192: a trailing-slash regex on caller-shaped input backtracks polynomially; the strip is linear and bounded now.
  const t0 = Date.now(); const r = ogSectionFor("/docs" + "/".repeat(200000)); const ms = Date.now() - t0;
  ok(r === "docs" && ms < 200, `200k trailing slashes resolve in ${ms} ms (linear, bounded)`);
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

// ---- booted: the shell serves the derived card, the route renders it -------
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" }, stdio: ["ignore", "ignore", "inherit"] });
let up = false;
for (let i = 0; i < 120 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); try { up = (await fetch(`${BASE}/health`)).ok; } catch {} }
if (!up) fail("server did not boot");
const og = async (p) => (/property="og:image" content="([^"]+)"/.exec(await (await fetch(BASE + p)).text()) || [])[1] || "";
ok(/\/og\/docs\.png\?v=/.test(await og("/docs")), "/docs serves /og/docs.png as its og:image");
ok(!ids.includes("why"), "no section card for /why (it redirects to /#why)");
ok(/\/og\/chain-base\.png/.test(await og("/base")), "/base serves the chain card");
ok(/\/og\/reports\.png/.test(await og("/reports/sample/dossier")), "a sample report page serves the reports card");
ok(/\/tools\/attest\/card\.png/.test(await og("/tools/attest")), "a tool page keeps its own card (explicit ogImage wins)");
ok(/\/card\.png\?v=/.test(await og("/company")), "a page with no section keeps the homepage card");
ok(/\/og\/agentic-finance\.png/.test(await og("/agentic-finance")), "the pre-existing explicit card is untouched");
const svgRes = await fetch(`${BASE}/og/markets.svg`);
ok(svgRes.status === 200 && /svg\+xml/.test(svgRes.headers.get("content-type")), "/og/markets.svg answers 200 image/svg+xml");
const missing = await fetch(`${BASE}/og/nope.png`);
ok(missing.status === 404, "an unknown section id is a 404, not a card");
const png = await fetch(`${BASE}/og/docs.png`, { redirect: "manual" });
ok(png.status === 200 || png.status === 302, `/og/docs.png renders (${png.status}: png when Chromium is present, svg redirect otherwise)`);
proc.kill("SIGKILL");
console.log(`\n${pass} passed`);
