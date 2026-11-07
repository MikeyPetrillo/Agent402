#!/usr/bin/env node
// Ink's graduation, rehearsed. Every surface Ink needs once it moves from
// GATED_RAILS to RAILS (src/rails.js) is built now and waits behind the gate:
//   - gated (today): no surface names Ink. /ink answers 404; the nav, the
//     trust strip, /pricing#chains, llms.txt, openapi, /.well-known/x402,
//     /api/pricing and the sitemap leave it out; its revenue read-config is
//     inert (not in the scan set the live read, ledger, leaderboard and
//     in-flight cover read), so a boot spends nothing on it.
//   - graduated (the test seam: NODE_ENV=test RAILS_TEST_GRADUATE=ink moves
//     the entry into RAILS after Arc, as the graduation edit does): /ink is a
//     200 chain page with chain id 57073, USDC and explorer links; the nav,
//     the strip, the chain list, llms.txt, openapi, the manifest, /api/pricing
//     and the sitemap list it; rail counts include it; its revenue entry is in
//     the scan set and the leaderboard ranks it.
// Paid-mode boots against stub facilitators on 127.0.0.1 (free ports), offline;
// nothing is read from a chain (the revenue read is checked offline only).
//   node scripts/test-ink-graduation.js
import { fileURLToPath } from "node:url";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { childJson } from "./lib/child-json.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const INK = "eip155:57073", BASE_NET = "eip155:8453";
// The production /supported shape: each network as a v2 CAIP-2 kind AND a
// v1 named kind, plus a testnet this server never offers.
const V1_NAMES = { "eip155:8453": "base", "eip155:57073": "ink" };
const productionKinds = (nets) => [...nets, "eip155:84532"].flatMap((network) => [{ x402Version: 2, scheme: "exact", network }, { x402Version: 1, scheme: "exact", network: V1_NAMES[network] || (network === "eip155:84532" ? "base-sepolia" : network) }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`ok - ${msg}`); else { failed++; console.log(`FAIL - ${msg}`); } };
const GRAD = { NODE_ENV: "test", RAILS_TEST_GRADUATE: "ink" };
const GATED = { NODE_ENV: "test", RAILS_TEST_GRADUATE: "" };
const cleanEnv = () => { const e = { ...process.env }; for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY", "INK_FACILITATOR_URL", "NETWORK_PRICE_FLOORS", "FACILITATOR_PUBLIC_INDEX_CHAINS", "ALCHEMY_API_KEY", "RAILS_TEST_GRADUATE"]) delete e[k]; return e; };

// --- offline: the module tables in each mode (a child per mode: the seam is read at import) ---
const PROBE = `
const rails = await import("./src/rails.js");
const { CHAIN_ORDER, chainLogoStrip, chainMark } = await import("./src/chain-logos.js");
const { CHAIN_PAGES } = await import("./src/market-page.js");
const live = await import("./src/revenue-live.js");
const { rankableChains } = await import("./src/leaderboard.js");
const { nav } = await import("./src/ledger-chrome.js").catch(() => ({}));
const ink = rails.RAILS.find((r) => r.caip2 === "${INK}");
console.log(JSON.stringify({
  inRails: !!ink, at: rails.RAILS.findIndex((r) => r.caip2 === "${INK}"), arcAt: rails.RAILS.findIndex((r) => r.name === "Arc"),
  gated: rails.GATED_RAILS.map((r) => r.caip2), count: rails.RAILS.length, countText: rails.RAILS_COUNT, countWord: rails.countWord(rails.RAILS.length),
  copy: [rails.RAILS_AMP, rails.RAILS_OR, rails.RAILS_PAREN, rails.RAILS_SHORT, rails.RAILS_OS, rails.RAILS_TICKER, rails.RAILS_NOTE, rails.RAIL_CHAIN_NAMES.join(",")],
  order: CHAIN_ORDER.map(([k]) => k), strip: chainLogoStrip({}), mark: chainMark("ink"),
  pages: Object.keys(CHAIN_PAGES), page: CHAIN_PAGES.ink ? { caip2: CHAIN_PAGES.ink.caip2, asset: CHAIN_PAGES.ink.asset, explorer: CHAIN_PAGES.ink.explorerWalletUrl("0xabc") } : null,
  evm: Object.keys(live.EVM), evmInk: live.EVM.ink ? { token: live.EVM.ink.token, label: live.EVM.ink.label, tx: live.EVM.ink.tx("0x1") } : null,
  covered: live.railsCoveredByLiveView(), rankable: rankableChains().map((c) => c.key),
  tokens: rails.resolveRailCountTokens("{{railCount}}|{{usdcRailsAnd}}"),
}));`;
const probe = (env) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], { cwd: root, env: { ...cleanEnv(), ...env }, encoding: "utf8", timeout: 120_000 });
  try { return childJson(r.stdout); } catch (e) { console.log(r.stderr.slice(-1500)); throw e; }
};
const g = probe(GATED), d = probe(GRAD);
const namesInk = (t) => /\bInk\b|INK|57073/.test(t);
// Once Ink has graduated for real (its entry is in RAILS), the gated half has
// nothing left to pin and says so; the graduated half keeps running.
const REAL = g.inRails;
if (REAL) console.log("ok - Ink is in RAILS: graduated, the gated checks do not apply");
const gcheck = (c, m) => (REAL ? undefined : check(c, m));
gcheck(!g.inRails && g.gated.includes(INK) && g.count === d.count - 1, `gated: Ink is outside RAILS (${g.count} rails)`);
gcheck(g.copy.every((t) => !namesInk(t)) && !namesInk(g.tokens) && !g.order.includes("ink") && !g.strip.includes('href="/ink"'), "gated: no rail string, served token, chain order or trust strip names Ink");
gcheck(!g.pages.includes("ink") && !g.page, "gated: no Ink chain page");
gcheck(!g.evm.includes("ink") && !g.rankable.includes("ink") && g.covered, "gated: the Ink revenue read-config is inert (not scanned, not ranked) and the coverage check still holds");
check(d.inRails && (REAL || d.at === d.arcAt + 1) && !d.gated.includes(INK), `graduated: Ink is in RAILS right after Arc (at ${d.at})`);
check(d.countText === `USDC or USDG on ${d.countWord} chains` && (REAL || d.count === g.count + 1) && d.copy.slice(0, 3).every((t) => t.includes("Ink")) && d.copy[3].includes(`+ ${d.copy[1].split(" - ")[0].split(", ").length - 1} more chains`) && d.copy[4].includes("Ink (EVM, chain ID 57073)") && d.copy[5].includes("INK") && d.copy[7].includes("Ink"), `graduated: counts and every rail string include Ink (${d.countText})`);
check(d.tokens.startsWith(`${d.countWord}|`) && d.tokens.includes("Arc, Ink"), `graduated: served rail tokens count and list Ink (${d.tokens.slice(0, 40)})`);
check(d.order.includes("ink") && d.strip.includes('href="/ink"') && d.strip.includes(">Ink</span>") && d.mark.startsWith("<svg"), "graduated: the trust strip links /ink with its mark");
check(d.pages.indexOf("ink") === d.pages.indexOf("arc") + 1 && d.page?.caip2 === INK && d.page.asset === "USDC" && d.page.explorer === "https://explorer.inkonchain.com/address/0xabc?tab=token_transfers", `graduated: the Ink chain page joins in RAILS order (${d.pages.join(",")})`);
check(d.evm.includes("ink") && d.evmInk?.token === "0x2D270e6886d130D724215A266106e6832161EAEd" && d.evmInk.tx === "https://explorer.inkonchain.com/tx/0x1", "graduated: the revenue entry is in the scan set with Ink's USDC and explorer");
check(d.rankable.includes("ink") && d.covered, "graduated: the leaderboard ranks Ink and every rail has a live-view read-config");

// --- booted: the served surfaces in each mode ------------------------------------
function stubFacilitator(kinds) {
  return createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(req.url === "/supported" || req.url === "/rpc" ? 200 : 404, { "Content-Type": "application/json" });
      if (req.url === "/supported") return res.end(JSON.stringify({ kinds: productionKinds(kinds), extensions: [], signers: {} }));
      if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
      res.end("{}");
    });
  });
}
async function boot(extra) {
  const [PORT, FAC, INKF] = await getFreePorts(3);
  const fac = stubFacilitator([BASE_NET, INK]), inkFac = stubFacilitator([INK]);
  await Promise.all([[fac, FAC], [inkFac, INKF]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const proc = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanEnv(), ...ownStoreEnv("ink-grad"), PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${FAC}`, PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "", PAYMENT_NETWORKS: "base,ink", FACILITATOR_GAS_CHECK: "off",
    STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
    ...extra(INKF) } });
  const log = []; proc.stdout.on("data", (c) => log.push(String(c))); proc.stderr.on("data", (c) => log.push(String(c)));
  const B = `http://127.0.0.1:${PORT}`;
  let up = false; for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
  const get = async (p) => { const r = await fetch(`${B}${p}`); return { status: r.status, text: await r.text() }; };
  return { up, get, log, stop: () => { proc.kill("SIGKILL"); fac.close(); inkFac.close(); } };
}
const SURFACES = ["/", "/pricing", "/llms.txt", "/llms-full.txt", "/openapi.json", "/.well-known/x402", "/api/pricing", "/sitemap.xml", "/how-to-pay"];

// Gated: Ink listed but no facilitator list, the production shape today.
if (!REAL) {
  const b = await boot(() => ({ ...GATED }));
  const before = failed;
  try {
    check(b.up, "gated boot: the paid-mode server booted");
    check((await b.get("/ink")).status === 404, "gated: /ink answers 404");
    for (const p of SURFACES) {
      const r = await b.get(p);
      const m = /\bInk\b|eip155:57073|"ink"|href="\/ink"|\/ink</.exec(r.text);
      check(r.status < 500 && !m, `gated: ${p} does not name Ink (status ${r.status}${m ? `; ${r.text.slice(Math.max(0, m.index - 60), m.index + 30)}` : ""})`);
    }
  } finally { if (failed > before) console.log(b.log.join("").slice(-2000)); b.stop(); }
}

// Graduated and enabled: the seam plus the facilitator list.
{
  const b = await boot((INKF) => ({ ...GRAD, INK_FACILITATOR_URL: `http://127.0.0.1:${INKF}` }));
  const before = failed;
  try {
    check(b.up, "graduated boot: the paid-mode server booted");
    const page = await b.get("/ink");
    check(page.status === 200 && page.text.includes("eip155:57073") && page.text.includes("USDC") && /<title>[^<]*Ink/.test(page.text), `graduated: /ink is a chain page with its title, chain id and asset (status ${page.status})`);
    // The explorer link names the treasury's token transfers on Ink, never the
    // bare explorer root, whether or not the revenue read has the rail yet.
    check(page.text.includes('href="https://explorer.inkonchain.com/address/0x000000000000000000000000000000000000dEaD?tab=token_transfers"') && !page.text.includes('href="https://explorer.inkonchain.com"'), "graduated: /ink links the payTo's token transfers on the Ink explorer");
    const home = (await b.get("/")).text;
    check(home.includes('href="/ink"'), "graduated: the home page links /ink (nav and trust strip)");
    const pricing = (await b.get("/pricing")).text;
    const chains = (pricing.match(/<p id="chains"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "";
    check(/Arc, Ink, Stellar/.test(chains), `graduated: /pricing#chains lists Ink (${chains.slice(0, 120)})`);
    const llms = (await b.get("/llms.txt")).text;
    check(llms.includes("/ink): USDC (`eip155:57073`)") && llms.indexOf("/ink): USDC") > llms.indexOf("/arc): USDC"), "graduated: llms.txt carries the Ink chain line, after Arc's");
    check(/Arc, Ink, Stellar/.test((await b.get("/openapi.json")).text), "graduated: openapi lists Ink in the rails");
    const man = JSON.parse((await b.get("/.well-known/x402")).text);
    check(JSON.stringify(man).includes('"Ink"') && JSON.stringify(man).includes("eip155:57073"), "graduated: /.well-known/x402 names the Ink chain");
    const ap = JSON.parse((await b.get("/api/pricing")).text);
    check(ap?.payment?.networks?.includes("ink"), `graduated: /api/pricing offers ink (${JSON.stringify(ap?.payment?.networks)})`);
    check((await b.get("/sitemap.xml")).text.includes("/ink</loc>"), "graduated: the sitemap lists /ink");
  } finally { if (failed > before) console.log(b.log.join("").slice(-2500)); b.stop(); }
}

console.log(`test-ink-graduation: ${failed ? `FAILED (${failed})` : "all passed"}`);
process.exit(failed ? 1 : 0);
