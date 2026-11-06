#!/usr/bin/env node
// One-time (or occasional) seed of the seller index from another public
// registry's paid resource list. Reads pages of indexed resources, pays the
// per-page price from the key in X402SCAN_BUYER_KEY (or BURNER_KEY) over x402,
// keeps the distinct origins, drops the ones this index already lists, and
// writes the rest to a file. Nothing is submitted unless --submit is given,
// and then every origin goes through POST /__operator/index/seed, which runs
// the same probe and caps a seller's own /sell submission faces.
//
// Spend is bounded three ways: --max-pages (default 50), --max-usd (default
// 0.50, the sum of signed page prices), and a per-page cap (0.02 USD) above
// which the page is refused rather than paid. Every accept goes through the
// shared capped-signing guard (scripts/lib/buyer-guard.js): Base only, an
// asset the known-assets table prices, the amount field the challenge's
// version signs, an accept whose two amount fields differ refused, and the
// signed value checked before it is sent. Each page's cap is the smaller of
// the per-page cap and what is left of --max-usd. Prices are read from the
// 402, never typed here. The key is never printed.
//
//   X402SCAN_BUYER_KEY=0x… node scripts/x402scan-seed.js --out seed.json
//   AGENT402_OPERATOR_TOKEN=… node scripts/x402scan-seed.js --in seed.json --submit
//     [--base https://agent402.tools] [--max-pages 50] [--max-usd 0.50] [--start-page 0]
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { guardCappedSigning, signedEvmValueOf } from "./lib/buyer-guard.js";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const BASE = String(flag("--base", process.env.AGENT402_BASE || "https://agent402.tools")).replace(/\/+$/, "");
const REGISTRY = "https://www.x402scan.com/api/x402/resources";
const MAX_PAGES = Math.max(1, Number(flag("--max-pages", 50)) | 0);
const MAX_USD_RAW = flag("--max-usd", "0.5");
const START = Math.max(0, Number(flag("--start-page", 0)) | 0);
const OUT = flag("--out", "x402scan-seed.json");
const IN = flag("--in", null);
const PAGE_QUOTE_CAP_USD = 0.02; // a page priced above this is refused, not paid
const SEED_NETWORKS = ["eip155:8453"];
const UA = "Agent402-index-seed/0.1 (+https://agent402.tools)";
const log = (...a) => console.error("[x402scan-seed]", ...a);

/**
 * The paying client: the vendor spend control off and the shared capped
 * guard on, with each page's cap the smaller of `pageCapUsd` and what is left
 * of `maxUsd`. `spentUsd()` sums the values actually signed (base units of a
 * 6-decimal USDC, which the guard has already matched to the accept).
 */
export function seedPaymentClient(signer, { maxUsd, pageCapUsd = PAGE_QUOTE_CAP_USD, log: say = log } = {}) {
  if (!(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error(`--max-usd must be a positive number, got ${JSON.stringify(maxUsd)}; not paying`);
  let spentAtomic = 0n;
  const spentUsd = () => Number(spentAtomic) / 1e6;
  const client = disableVendorSpendControls(new x402Client());
  guardCappedSigning(client, { maxUsd: () => Math.min(pageCapUsd, maxUsd - spentUsd()), networks: SEED_NETWORKS, log: say });
  registerExactEvmScheme(client, { signer });
  // Registered after the guard's own check, so only a value it passed is counted.
  client.onAfterPaymentCreation(async ({ paymentPayload }) => { spentAtomic += BigInt(signedEvmValueOf(paymentPayload) ?? "0"); });
  return { client, spentUsd };
}

async function readRegistry() {
  const pk = (process.env.X402SCAN_BUYER_KEY || process.env.BURNER_KEY || "").trim();
  if (!pk) { log("no X402SCAN_BUYER_KEY / BURNER_KEY - cannot pay for registry pages"); process.exit(2); }
  const MAX_USD = Number(MAX_USD_RAW);
  if (!(Number.isFinite(MAX_USD) && MAX_USD > 0)) { log(`--max-usd must be a positive number, got ${JSON.stringify(MAX_USD_RAW)}; not paying`); process.exit(2); }
  const [{ privateKeyToAccount }, { wrapFetchWithPayment }] = await Promise.all([import("viem/accounts"), import("@x402/fetch")]);
  const { client, spentUsd } = seedPaymentClient(privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`), { maxUsd: MAX_USD });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const origins = new Map(); // origin -> resource count
  let page = START, pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) { log(`stopping: --max-pages ${MAX_PAGES} reached`); break; }
    if (spentUsd() >= MAX_USD) { log(`stopping: --max-usd ${MAX_USD} reached`); break; }
    const res = await payFetch(`${REGISTRY}?page=${page}&page_size=100`, { headers: { accept: "application/json", "user-agent": UA } });
    if (res.status !== 200) { log(`page ${page}: HTTP ${res.status} - stopping`); break; }
    const j = await res.json();
    pages++;
    for (const it of j?.data || []) {
      const o = typeof it?.origin === "object" ? it.origin?.origin : it?.origin;
      const origin = typeof o === "string" ? o.trim().replace(/\/+$/, "") : null;
      if (origin && /^https:\/\//i.test(origin)) origins.set(origin, (origins.get(origin) || 0) + 1);
    }
    log(`page ${page}: ${(j?.data || []).length} resources, ${origins.size} distinct origins so far, spent ~$${spentUsd().toFixed(2)}`);
    if (!j?.pagination?.has_next_page) { log("last page reached"); break; }
    page++;
  }
  return { origins, pages, spentUsd: spentUsd(), nextPage: page };
}

async function alreadyIndexed(origin) {
  const host = new URL(origin).host;
  const r = await fetch(`${BASE}/api/index?seller=${encodeURIComponent(host)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r) return null; // unknown: keep the candidate
  if (r.status === 200) { const j = await r.json().catch(() => null); return j && !j.error ? true : false; }
  return false;
}

async function main() {
  let candidates, meta = {};
  if (IN) {
    const j = JSON.parse(readFileSync(IN, "utf8"));
    candidates = new Map((j.newOrigins || j.origins || []).map((o) => [typeof o === "string" ? o : o.origin, 1]));
    log(`${candidates.size} origins read from ${IN}`);
  } else {
    const r = await readRegistry();
    candidates = r.origins; meta = { pages: r.pages, spentUsd: r.spentUsd, nextPage: r.nextPage };
    log(`${candidates.size} distinct origins from ${r.pages} page(s), spent ~$${r.spentUsd.toFixed(2)}`);
  }
  const self = BASE.toLowerCase();
  const fresh = [];
  let known = 0;
  const list = [...candidates.keys()].filter((o) => o.toLowerCase() !== self);
  let i = 0;
  const worker = async () => { for (let o = list[i++]; o; o = list[i++]) { const k = await alreadyIndexed(o); if (k === true) known++; else fresh.push(o); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  fresh.sort();
  log(`${known} already indexed, ${fresh.length} new`);
  if (!IN) {
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, ...meta, origins: [...candidates.keys()].sort(), newOrigins: fresh }, null, 2));
    log(`wrote ${OUT}`);
  }
  if (!has("--submit")) { log("dry run: pass --submit (with AGENT402_OPERATOR_TOKEN) to register the new origins"); return; }
  const token = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
  if (!token) { log("--submit needs AGENT402_OPERATOR_TOKEN"); process.exit(2); }
  let listed = 0;
  for (let s = 0; s < fresh.length; s += 25) {
    const chunk = fresh.slice(s, s + 25);
    const r = await fetch(`${BASE}/__operator/index/seed`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": UA },
      body: JSON.stringify({ origins: chunk, commit: true }), signal: AbortSignal.timeout(300_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) { log(`chunk at ${s}: HTTP ${r.status} ${j?.error || ""} - stopping`); break; }
    listed += j.listed || 0;
    for (const row of j.rows || []) if (!row.listed) log(`  not listed: ${row.origin} - ${row.error || "no x402 surface"}`);
    log(`chunk at ${s}: ${j.listed}/${chunk.length} listed`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`done: ${listed} of ${fresh.length} new origins listed`);
}
// Run only as a script; the suites import seedPaymentClient.
const isMain = (() => { try { return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main().catch((e) => { log(String(e?.message || e)); process.exit(1); });
