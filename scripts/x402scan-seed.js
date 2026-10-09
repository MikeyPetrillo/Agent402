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
// 0.50, the sum of quoted page prices), and a per-page quote cap (0.02 USDC)
// above which the page is refused rather than paid. Prices are read from the
// 402, never typed here. The key is never printed.
//
//   X402SCAN_BUYER_KEY=0x… node scripts/x402scan-seed.js --out seed.json
//   AGENT402_OPERATOR_TOKEN=… node scripts/x402scan-seed.js --in seed.json --submit
//     [--base https://agent402.tools] [--max-pages 50] [--max-usd 0.50] [--start-page 0]
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const BASE = String(flag("--base", process.env.AGENT402_BASE || "https://agent402.tools")).replace(/\/+$/, "");
const REGISTRY = "https://www.x402scan.com/api/x402/resources";
const MAX_PAGES = Math.max(1, Number(flag("--max-pages", 50)) | 0);
const MAX_USD = Number(flag("--max-usd", 0.5));
const START = Math.max(0, Number(flag("--start-page", 0)) | 0);
const OUT = flag("--out", "x402scan-seed.json");
const IN = flag("--in", null);
const PAGE_QUOTE_CAP_ATOMIC = 20_000n; // 0.02 USDC: a page priced above this is refused, not paid
const UA = "Agent402-index-seed/0.1 (+https://agent402.tools)";
const log = (...a) => console.error("[x402scan-seed]", ...a);

async function readRegistry() {
  const pk = (process.env.X402SCAN_BUYER_KEY || process.env.BURNER_KEY || "").trim();
  if (!pk) { log("no X402SCAN_BUYER_KEY / BURNER_KEY - cannot pay for registry pages"); process.exit(2); }
  const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  let spentAtomic = 0n;
  // The selector is the spend guard: only a Base USDC exact accept at or under
  // the per-page cap is ever signed; everything else throws before signing.
  const client = new x402Client((_version, accepts) => {
    const ok = (accepts || []).find((a) => a?.scheme === "exact" && a?.network === "eip155:8453" && BigInt(a?.amount ?? a?.maxAmountRequired ?? "0") <= PAGE_QUOTE_CAP_ATOMIC);
    if (!ok) throw new Error("page quote above the per-page cap or not payable on Base USDC - refused, nothing signed");
    spentAtomic += BigInt(ok.amount ?? ok.maxAmountRequired ?? "0");
    return ok;
  });
  registerExactEvmScheme(client, { signer: privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`) });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const origins = new Map(); // origin -> resource count
  let page = START, pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) { log(`stopping: --max-pages ${MAX_PAGES} reached`); break; }
    if (Number(spentAtomic) / 1e6 >= MAX_USD) { log(`stopping: --max-usd ${MAX_USD} reached`); break; }
    const res = await payFetch(`${REGISTRY}?page=${page}&page_size=100`, { headers: { accept: "application/json", "user-agent": UA } });
    if (res.status !== 200) { log(`page ${page}: HTTP ${res.status} - stopping`); break; }
    const j = await res.json();
    pages++;
    for (const it of j?.data || []) {
      const o = typeof it?.origin === "object" ? it.origin?.origin : it?.origin;
      const origin = typeof o === "string" ? o.trim().replace(/\/+$/, "") : null;
      if (origin && /^https:\/\//i.test(origin)) origins.set(origin, (origins.get(origin) || 0) + 1);
    }
    log(`page ${page}: ${(j?.data || []).length} resources, ${origins.size} distinct origins so far, spent ~$${(Number(spentAtomic) / 1e6).toFixed(2)}`);
    if (!j?.pagination?.has_next_page) { log("last page reached"); break; }
    page++;
  }
  return { origins, pages, spentUsd: Number(spentAtomic) / 1e6, nextPage: page };
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
main().catch((e) => { log(String(e?.message || e)); process.exit(1); });
