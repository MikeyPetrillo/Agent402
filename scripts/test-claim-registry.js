#!/usr/bin/env node
// CLASS GUARD: public copy that claims more than the code does. Batch 6: the
// consent page said the app "cannot read the balance" while the 402 told it
// the balance; /terms said "the key is the only credential" with the
// connector on; redact-chat promised to anonymize. Batch 7: /terms gave every
// /v1 call the chat tiers' fallback; a changelog said "inputs unchanged". Each
// was fixed by a sentence-level assert; a mutation that removed the /privacy
// split-leg line, or made settleFirstClause return "", passed every suite.
//
//   node scripts/test-claim-registry.js           check
//   node scripts/test-claim-registry.js --list    print every absolute the scan finds
//
//   1. CLAIMS: each public sentence about charging, refunds, caps, receipts
//      and limits that a review tied to a code fact is registered here with
//      the file that carries it, the words, and a check of the fact against
//      the code that decides it (a constant, a switch, a function's answer,
//      or the code branch that keeps the promise). The words missing from
//      the file fail (the copy changed: re-tie it), and a fact that no longer
//      holds fails (the code changed: change the copy).
//   2. A scan of every public surface (README, wiki, docs, the package
//      READMEs, the page modules) for an absolute ("never", "always",
//      "guaranteed", "unlimited") in a sentence about charging, refunds,
//      settling, caps, limits, receipts, a balance or fees, and for a line
//      that calls a wallet-only route free. BASELINE holds what each file has
//      today: a new one fails until it is scoped (say which rail, which
//      route, which case) or registered in CLAIMS with its check; the count
//      only shrinks. scripts/test-copy-absolutes.js keeps its own list of
//      phrasings that are false outright; this suite holds the rest.
import "./lib/offline-stores.js";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASS = "[public claim broader than the code]";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${CLASS} ${m}`); } };
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const flat = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const LIST = process.argv.includes("--list");

// ---- 1. the registry ----------------------------------------------------------
const settle = await import("../src/settle-first-copy.js");
const positioning = await import("../src/positioning.js");
const rateLimit = await import("../src/rate-limit.js");
/** Runs `code` in a child with `env` and returns its stdout (a switch read once at import). */
const childOut = (code, env) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" }).stdout.trim();

const CLAIMS = [
  {
    id: "settle-first clause on a route paid before it runs",
    files: { "src/settle-first-copy.js": /Some calls are paid before they run/ },
    fact: "settleFirstClause adds the short sentence to a settles-first route only, and nothing when GATEWAY_SETTLE_FIRST=off",
    check: () => {
      const on = settle.settleFirstCopyOn();
      const first = settle.settleFirstClause({ settlesFirst: true });
      const other = settle.settleFirstClause({ settlesFirst: false }) + settle.settleFirstClause({}) + settle.settleFirstClause(null);
      const off = childOut(`const m = await import("./src/settle-first-copy.js"); process.stdout.write(JSON.stringify([m.settleFirstClause({ settlesFirst: true }), m.FAILED_CALL_SENTENCE]));`, { GATEWAY_SETTLE_FIRST: "off" });
      return (!on || first === ` ${settle.SETTLE_FIRST_TEXT}`) && other === "" && off === JSON.stringify(["", ""]) && settle.SETTLE_FIRST_TEXT.includes(settle.SETTLE_FIRST_MARK) && settle.FAILED_CALL_TEXT.includes(settle.SETTLE_FIRST_MARK);
    },
  },
  {
    id: "the free tier's limits, as the connector docs quote them",
    files: { "wiki/MCP-Connector.md": /capped at \d+ calls\/min, \d+\/hour per client/ },
    fact: "the numbers quoted are the limiter's defaults (src/rate-limit.js MAX_CALLS_PER_BURST, MAX_CALLS_PER_WINDOW)",
    check: () => {
      const d = JSON.parse(childOut(`const m = await import("./src/rate-limit.js"); process.stdout.write(JSON.stringify([m.MAX_CALLS_PER_BURST, m.MAX_CALLS_PER_WINDOW]));`, { AGENT402_MCP_MAX_PER_MIN: "", AGENT402_MCP_MAX_PER_HOUR: "" }) || "[]");
      const m = /capped at (\d+) calls\/min, (\d+)\/hour per client/.exec(read("wiki/MCP-Connector.md"));
      return Boolean(m) && Number(m[1]) === d[0] && Number(m[2]) === d[1] && typeof rateLimit.LIMITS_LABEL === "string";
    },
  },
  {
    id: "the lead sentence's signed-receipt clause",
    files: { "src/positioning.js": /receipts/ },
    fact: "the clause is said only while receipts are served (leadSentence reads receiptsServed())",
    check: () => /receipt/i.test(positioning.leadSentence({ receipts: true })) && !/receipt/i.test(positioning.leadSentence({ receipts: false })) && /receiptsServed\(\)/.test(read("src/positioning.js")),
  },
  {
    id: "the consent page's promise that a connected app cannot read the balance",
    files: { "src/mcp-oauth-page.js": /cannot read or move the balance/ },
    fact: "a credits refusal under a connector grant names no balance figure and no key (src/credits.js, the grant branch)",
    check: () => {
      const src = read("src/credits.js");
      const at = src.indexOf("if (grantOf?.(req)) {");
      const block = at >= 0 ? src.slice(at, src.indexOf("\n        }", at) + 10) : "";
      return block.length > 100 && !/balanceUsd|a\.balance|keyId/.test(block) && /The balance is too low for this call/.test(block);
    },
  },
  {
    id: "/privacy: what a referral payment's records keep",
    files: { "src/privacy.js": /how the network's contract split it, and the wallet\s+address each share was paid to/ },
    fact: "the receipt proof records the split (gross, legs, merchant amount and each recipient) beside a proven sale (src/referral-proof.js)",
    check: async () => {
      const src = read("src/referral-proof.js");
      const pv = read("src/privacy.js");
      const inBlock = /\$\{referralOn \? `[\s\S]*how the network's contract split it[\s\S]*` : ""\}/.test(pv);
      return inBlock && /const split = \{ gross: [^}]*legs: [^}]*merchant: [^}]*recipients \}/.test(src);
    },
  },
  {
    id: "/terms: which /v1 calls fall back to another model",
    files: { "src/terms.js": /a call on a chat tier falls back to the next model on that tier when one fails/ },
    fact: "only the chat tiers carry fallbacks (TIERS[*].fallbacks); the embeddings model is the one the request names",
    check: async () => {
      const { TIERS } = await import("../src/tools/llm-gateway-kit.js");
      const withFallback = Object.entries(TIERS).filter(([, t]) => Array.isArray(t?.fallbacks) && t.fallbacks.length);
      return withFallback.length > 0 && withFallback.every(([slug]) => !/embed/i.test(slug)) && /on embeddings, the model the request names/.test(read("src/terms.js"));
    },
  },
  {
    id: "a typical price quoted in prose",
    files: { "src/typical-price-range.js": /TYPICAL_PRICE_RANGE/ },
    fact: "the band is derived from the catalog (scripts/test-price-prose.js holds every quote of it to its text)",
    check: () => existsSync(join(ROOT, "scripts/test-price-prose.js")) && /TYPICAL_PRICE_RANGE/.test(read("scripts/test-price-prose.js")),
  },
];
for (const c of CLAIMS) {
  const missing = Object.entries(c.files).filter(([f, re]) => !existsSync(join(ROOT, f)) || !re.test(flat(read(f))) && !re.test(read(f)));
  ok(missing.length === 0, `${c.id}: the claim is where the registry says (${missing.map(([f]) => f).join(", ") || "found"}${missing.length ? "; the copy changed: tie the new words to their fact here" : ""})`);
  let held = false;
  try { held = await c.check(); } catch (e) { held = false; console.error(`  ${c.id}: ${e?.message}`); }
  ok(held === true, `${c.id}: ${c.fact}${held ? "" : " DOES NOT HOLD; change the copy to what the code does, or the code"}`);
}

// ---- 2. the scan -----------------------------------------------------------------
const SURFACES = /^(README\.md|llms-install\.md|wiki\/.*\.md|docs\/.*\.md|(?:mcp|client|tollbooth|openclaw)\/README\.md|adapters\/[^/]+\/README\.md|src\/[\w-]*(?:page|pages|guides?|learn|seo|blog|skill-md|how-to-pay|what-is-x402|terms|privacy|company|glossary|faq|why|docs|integration|front-door|security)[\w-]*\.js)$/;
export const ABSOLUTE = /\b(never|always|guaranteed?|unlimited)\b/i;
export const MONEY = /\b(charg\w*|refund\w*|settle\w*|free|caps?|limit\w*|receipts?|balance|fees?)\b/i;
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
// A catalog tool route (scripts/published-slugs.json) that the free tier does not serve.
const TOOL_SLUGS = new Set(JSON.parse(read("scripts/published-slugs.json")).tools);
// The free discovery surfaces (CLAUDE.md, "Key machine-readable surfaces") share a segment with no tool's price.
const FREE_SURFACES = new Set(["route", "find", "index", "reputation", "pricing", "stats", "status", "gateway-status", "reliability"]);
const walletOnly = (slug) => TOOL_SLUGS.has(slug) && !FREE_SURFACES.has(slug) && (WALLET_ONLY_SLUGS.has(slug) || !FREE_TIER_SLUGS.has(slug));
const sentences = (text) => flat(text.replace(/^\s*(\/\/|\*).*$/gm, "")).split(/(?<=[.!?])\s+|\s\|\s/);
export function absolutesIn(text) { return sentences(text).filter((s) => s.length < 600 && ABSOLUTE.test(s) && MONEY.test(s)).map((s) => s.trim().slice(0, 160)); }
export function freePaidRoutesIn(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (!/\bfree\b/i.test(s) || /\bfree (?:tier|path|proof|of)\b|\bfee-free\b|\bfree to (?:list|self-host|run)\b|\bquote \(free\)/i.test(s)) continue;
    for (const m of s.matchAll(/\/api\/([a-z0-9][a-z0-9-]+)(?![\w/-])/g)) if (walletOnly(m[1])) out.push(`/api/${m[1]}: ${s.trim().slice(0, 120)}`);
  }
  return out;
}
// Controls: the shapes the scan reads, and the scoped ones it leaves.
ok(absolutesIn("A failed call is never charged.").length === 1 && absolutesIn("Refunds are always sent.").length === 1 && absolutesIn("The page always loads fast.").length === 0, "control: an absolute about charging or refunds is read, one about anything else is not");
ok(freePaidRoutesIn("Call /api/web-search free, no wallet needed.").length === (walletOnly("web-search") ? 1 : 0) && freePaidRoutesIn("The free tier covers /api/uuid.").length === 0, "control: a wallet-only route called free is read; the free tier's own sentence is not");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter((f) => SURFACES.test(f));
ok(tracked.length > 50, `the public surfaces are read (${tracked.length} files)`);
const found = {};
for (const f of tracked) {
  const t = read(f);
  const list = [...absolutesIn(t).map((s) => `absolute: ${s}`), ...freePaidRoutesIn(t).map((s) => `free paid route: ${s}`)];
  if (list.length) found[f] = list;
}
if (LIST) for (const [f, l] of Object.entries(found)) for (const s of l) console.log(`  ${f}: ${s}`);
// What each file says today. Lower a count when a sentence is scoped; never raise one.
const BASELINE = {
  "README.md": 4,
  "adapters/eliza/README.md": 1,
  "client/README.md": 9,
  "docs/base-mcp-plugin.md": 1,
  "docs/configuration.md": 5,
  "docs/proposal-receipts-and-refund-terms.md": 1,
  "docs/runbook.md": 5,
  "mcp/README.md": 4,
  "openclaw/README.md": 2,
  "src/crawler-page.js": 1,
  "src/docs.js": 1,
  "src/glossary.js": 2,
  "src/guides.js": 10,
  "src/how-to-pay.js": 3,
  "src/pages.js": 4,
  "src/privacy.js": 8,
  "src/refund-terms-doc.js": 1,
  "src/security-page.js": 1,
  "src/seo.js": 3,
  "src/skill-md.js": 2,
  "src/terms.js": 4,
  "src/what-is-x402.js": 1,
  "src/why.js": 1,
  "src/x402-test-page.js": 1,
  "tollbooth/README.md": 4,
  "wiki/API-Reference.md": 3,
  "wiki/Agentic-Finance.md": 1,
  "wiki/Architecture.md": 6,
  "wiki/Audit-Report.md": 1,
  "wiki/Buying-at-Volume.md": 3,
  "wiki/Card-Payments.md": 2,
  "wiki/Circle-Gateway.md": 3,
  "wiki/Content-Pipeline.md": 1,
  "wiki/Credits.md": 1,
  "wiki/Decide.md": 1,
  "wiki/FAQ.md": 2,
  "wiki/Home.md": 1,
  "wiki/LLM-Gateway.md": 2,
  "wiki/MCP-Connector.md": 1,
  "wiki/Pay-per-crawl.md": 2,
  "wiki/Paying-with-x402.md": 2,
  "wiki/Reports-and-Monitors.md": 2,
  "wiki/Robinhood-Chain.md": 2,
  "wiki/Security-Model.md": 1,
  "wiki/Self-Hosting.md": 5,
  "wiki/Seller-Reputation.md": 1,
  "wiki/Sessions-and-Channels.md": 4,
  "wiki/Tempo.md": 1,
  "wiki/Tollbooth-for-Agencies.md": 3,
  "wiki/Why-Pay-Here.md": 1,
  "wiki/agent402-client.md": 1,
  "wiki/x402-Index-and-Router.md": 3,
};
const over = Object.entries(found).filter(([f, l]) => l.length > (BASELINE[f] || 0));
ok(over.length === 0, `no surface adds an unscoped absolute about money or limits, or calls a paid route free (${over.map(([f, l]) => `${f}: ${l.length} found, baseline ${BASELINE[f] || 0}: ${l.join(" / ")}`).join(" | ") || "none"}${over.length ? "; scope it (which rail, which route, which case), or register it in CLAIMS with a check of its fact" : ""})`);
const under = Object.entries(BASELINE).filter(([f, c]) => (found[f]?.length || 0) < c);
ok(under.length === 0, `the baseline only shrinks: lower each count a fix brought down (${under.map(([f, c]) => `${f}: ${found[f]?.length || 0} left, baseline ${c}`).join(" | ") || "none"})`);
console.log(`absolutes left: ${Object.values(found).reduce((n, l) => n + l.length, 0)} (baseline ${Object.values(BASELINE).reduce((n, c) => n + c, 0)})`);

console.log(`\ntest-claim-registry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
