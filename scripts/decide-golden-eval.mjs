// Golden-set evaluation for /api/decide. NOT in CI: it makes real model calls.
//
// For each task it buys a decision (FREE_MODE boot: no payment) and checks the
// plan is EXECUTABLE: every step's tool is in the catalog (or a live row in the
// index), runnable in a plan, its params validate against its schema and carry
// no unfilled placeholder, and the plan fits its budget. Reports pass rate,
// average decision price and average latency.
//
//   TARGET_URL=http://127.0.0.1:PORT node scripts/decide-golden-eval.mjs [--depth plan] [--out file.json]

import { writeFileSync } from "node:fs";
import { validateParams } from "../src/decide/params.js";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DEPTH = arg("--depth", "plan");
const OUT = arg("--out", null);

// Each task says whether it carries its own data. A task WITH its data must
// plan with every value filled (from the task, or as {{step N}} from an earlier
// step): a placeholder there is a failure. A task WITHOUT its data (no URL, no
// address given) passes when the plan names what the caller must supply, so a
// placeholder there is the correct answer. A chained task must link at least
// one step to an earlier step's output.
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
export const GOLDEN = [
  { task: "Research the current state of EU AI Act obligations for general-purpose AI models and cite sources", budget: 1, data: true },
  { task: "Build a company dossier on Nvidia (NVDA) from SEC filings", budget: 2, data: true },
  { task: "Audit wallet 0x28C6c06298d514Db089934071355E5743bf21d60 on Base: token balances and recent transfers", budget: 0.1, data: true },
  { task: "Convert this CSV to JSON: name,age\\nada,36", budget: 0.05, data: true },
  { task: "Get the current price of bitcoin and ethereum in USD", budget: 0.05, data: true },
  { task: "Check whether example.com has valid SPF and DMARC records", budget: 0.05, data: true },
  { task: "Find the TLS certificate expiry date for github.com", budget: 0.05, data: true },
  { task: "Summarize the latest news about stablecoin regulation", budget: 0.5, data: true },
  { task: "Get the 7-day weather forecast for Denver", budget: 0.05, data: true },
  { task: "Look up insider trading activity for Apple (AAPL) in the last 90 days", budget: 2, data: true },
  { task: "What are Berkshire Hathaway's largest 13F holdings this quarter", budget: 2, data: true },
  { task: "Render https://example.com in a browser and return the page title", budget: 0.1, data: true },
  { task: "Check if the Ethereum address 0x8589427373D6D84E98730D7795D8f6f8731FDA16 is on the OFAC sanctions list", budget: 0.05, data: true },
  { task: "Generate a QR code for https://agent402.tools", budget: 0.05, data: true },
  { task: "Hash the string hello world with sha256", budget: 0.01, data: true },
  { task: "Get perpetual futures funding rates for BTC", budget: 0.05, data: true },
  { task: "Find the US unemployment rate trend from FRED", budget: 0.05, data: true },
  { task: `Decode this JWT and show its claims: ${JWT}`, budget: 0.01, data: true },
  { task: "Look up the ASN and country for IP 8.8.8.8", budget: 0.05, data: true },
  { task: "Get DeFi TVL for Uniswap and Aave", budget: 0.05, data: true },
  { task: "Translate to Spanish: The meeting starts at noon tomorrow.", budget: 0.1, data: true },
  { task: "Check FDA recalls for losartan", budget: 2, data: true },
  { task: "Get the gas price on Base and Ethereum mainnet", budget: 0.05, data: true },
  { task: "Compute the Black-Scholes price of a call option: spot 100, strike 105, 30 days to expiry, volatility 25%, rate 4%", budget: 0.05, data: true },
  { task: "Find the domain registration (WHOIS) details for agent402.tools", budget: 0.05, data: true },
  { task: "Scrape https://example.com and return clean markdown", budget: 0.1, data: true },
  // chained: a later step needs a value an earlier step produces
  { task: "Resolve the ENS name vitalik.eth to an address and list its token balances on Base", budget: 0.1, data: true, chain: true },
  { task: "Find the address behind nick.eth and list its recent token transfers on Ethereum", budget: 0.1, data: true, chain: true },
  { task: "Resolve brantly.eth to an address, then check whether that address is on the OFAC sanctions list", budget: 0.1, data: true, chain: true },
  { task: "Resolve the ENS name brantly.eth, then get that address's transaction count on Ethereum", budget: 0.1, data: true, chain: true },
  { task: "Find the IP address github.com resolves to, then look up that IP's ASN and country", budget: 0.1, data: true },
  { task: "Extract the text from the PDF at https://bitcoin.org/bitcoin.pdf and count the words", budget: 0.1, data: true },
  // held out: added after the 2026-10-01 fixes and never used while making them,
  // so a pass here says the fixes generalize rather than fit the set above
  { task: "What is the current price of Solana in USD and its change over the last 24 hours", budget: 0.05, data: true, heldOut: true },
  { task: "List the MX records for gmail.com", budget: 0.05, data: true, heldOut: true },
  { task: "What is the weather in Tokyo right now", budget: 0.05, data: true, heldOut: true },
  { task: "Convert 100 US dollars to euros at today's exchange rate", budget: 0.05, data: true, heldOut: true },
  { task: "Get the current gas price on Polygon", budget: 0.05, data: true, heldOut: true },
  { task: "Show the top holders of the USDC token on Base", budget: 0.1, data: true, heldOut: true },
  { task: "Get the HTTP security headers for github.com and grade them", budget: 0.05, data: true, heldOut: true },
  { task: "Resolve the ENS name nick.eth to an address, then get that address's ETH balance on Ethereum", budget: 0.1, data: true, chain: true, heldOut: true },
  // without their data: the plan must name what the caller supplies
  { task: "Transcribe an audio file from a URL to text", budget: 0.2, data: false },
  { task: "Check if an Ethereum address is on the OFAC sanctions list", budget: 0.05, data: false },
  { task: "Decode a JWT and show its claims", budget: 0.01, data: false },
  { task: "Translate a paragraph of English text to Spanish", budget: 0.1, data: false },
];

async function main() {
  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  const bySlug = new Map((pricing.tools || pricing.endpoints || []).map((t) => [t.slug, t]));
  const rows = [];
  for (const g of GOLDEN) {
    const t0 = Date.now();
    let d = null, error = null;
    try {
      const r = await fetch(`${TARGET}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: g.task, depth: DEPTH, constraints: { maxBudgetUsd: g.budget } }) });
      d = await r.json();
      if (!r.ok) error = `HTTP ${r.status} ${d?.error || ""}`;
    } catch (e) { error = String(e?.message || e); }
    const ms = Date.now() - t0;
    const problems = [];
    if (!error) {
      if (!d.plan?.length) problems.push("empty plan");
      for (const p of d.plan || []) {
        if (p.tool.firstParty && !bySlug.has(p.tool.slug)) problems.push(`step ${p.step}: ${p.tool.slug} not in catalog`);
        const v = validateParams(p.tool.inputSchema, p.tool.exampleParams);
        if (!v.ok) problems.push(`step ${p.step}: params invalid (${v.errors.join("; ")})`);
        const open = Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^<[^>]+>$/.test(x));
        if (open && g.data) problems.push(`step ${p.step}: unfilled placeholder`);
        for (const x of Object.values(p.tool.exampleParams || {})) {
          const m = typeof x === "string" ? /^\{\{step (\d+)\}\}$/.exec(x) : null;
          if (m && !(p.dependsOn || []).includes(Number(m[1]))) problems.push(`step ${p.step}: references step ${m[1]} without depending on it`);
        }
        if (p.tool.priceUsd > g.budget) problems.push(`step ${p.step}: over budget`);
      }
      if (d.estimatedCostUsd > g.budget) problems.push("plan over budget");
      const linked = (d.plan || []).some((p) => Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^\{\{step \d+\}\}$/.test(x)));
      if (g.chain && !linked) problems.push("no step uses an earlier step's output");
      if (g.data === false && !(d.plan || []).some((p) => (p.tool.exampleParamsNeedInput || []).length || Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^<[^>]+>$/.test(x)))) problems.push("names no input the caller must supply");
    }
    const pass = !error && problems.length === 0;
    rows.push({ task: g.task, kind: g.chain ? "chain" : g.data ? "data" : "no-data", pass, ms, priceUsd: d?.priceUsd ?? null, confidence: d?.confidence ?? null, partial: d?.partial ?? null, steps: (d?.plan || []).map((p) => `${p.tool.slug || p.tool.name}${p.tool.firstParty ? "" : `@${p.tool.seller}`}${JSON.stringify(p.tool.exampleParams)}`), gaps: d?.gaps || [], error, problems });
    console.log(`${pass ? "PASS" : "FAIL"} ${ms}ms conf=${d?.confidence ?? "-"} ${g.task.slice(0, 60)} -> ${rows.at(-1).steps.join(" > ") || "-"}${problems.length ? `  [${problems.join(" | ")}]` : ""}${error ? `  [${error}]` : ""}`);
  }
  const n = rows.length, passed = rows.filter((r) => r.pass).length;
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = { depth: DEPTH, tasks: n, passed, passRate: Math.round((passed / n) * 1000) / 10, avgDecisionPriceUsd: Math.round(avg(rows.map((r) => r.priceUsd || 0)) * 1e6) / 1e6, avgLatencyMs: Math.round(avg(lat)), p95LatencyMs: lat[Math.floor(lat.length * 0.95)] || 0, avgConfidence: Math.round(avg(rows.map((r) => r.confidence || 0)) * 1000) / 1000, partial: rows.filter((r) => r.partial).length, withGaps: rows.filter((r) => r.gaps.length).length };
  summary.byKind = Object.fromEntries(["data", "chain", "no-data"].map((k) => { const r = rows.filter((x) => x.kind === k); return [k, `${r.filter((x) => x.pass).length}/${r.length}`]; }));
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
