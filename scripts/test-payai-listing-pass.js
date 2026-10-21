#!/usr/bin/env node
// The PayAI listing pass (scripts/payai-listing-pass.js), offline: route
// selection and the price cap, the run ceiling, --only and --limit, quoted routes
// priced by their own 402 (stubbed fetch), the signing ceiling policy, the
// preflight that refuses to spend when the preference is not honored, the
// receipt reader, and the flag parser.
//
//   node scripts/test-payai-listing-pass.js
import assert from "node:assert/strict";
import { CHAINS, coverageFor } from "./listing-coverage.js";
import { selectPass, candidatesOf, quoteOf, quoteRoutes, ceilingPolicy, routeKeyOf, preferenceHonored, receiptOf, parseArgs, main, DEFAULT_MAX_PRICE_USD, SETTLE_VIA, isMultipartExample } from "./payai-listing-pass.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const SOL = CHAINS.solana, BASE = CHAINS.base;
const ORIGIN = "https://agent402.tools";

const pricing = {
  payment: { networks: ["base", "solana"] },
  endpoints: [
    { method: "POST", path: "/api/hash", slug: "hash", price: "$0.001", computePayable: true },
    { method: "GET", path: "/api/answer", slug: "answer", price: "$0.08", computePayable: true },
    { method: "POST", path: "/api/premium", slug: "premium", price: "$0.50", computePayable: true },
    { method: "POST", path: "/api/listed", slug: "listed", price: "$0.001", computePayable: true },
    { method: "POST", path: "/api/memory", slug: "memory-write", price: "$0.001", computePayable: true, identityBound: true },
    { method: "POST", path: "/api/evm-only", slug: "evm-only", price: "$0.001", computePayable: true, networks: [BASE] },
    { method: "POST", path: "/v1/metered", slug: "metered", price: "$0.001", computePayable: true, quoted: true },
    { method: "POST", path: "/api/free-shape", slug: "free-shape", price: "$0", computePayable: true },
    { method: "POST", path: "/api/mid", slug: "mid", price: "$0.25", computePayable: true },
    { method: "POST", path: "/api/model-call", slug: "model-call", price: "$0.01", modelBacked: true },
  ],
};
const cov = coverageFor({ pricing, payaiItems: [{ resource: "https://agent402.tools/api/listed", accepts: [{ network: SOL }] }], origin: ORIGIN, chains: ["base", "solana"] });

{
  const plan = selectPass(cov);
  ok(!plan.selected.some((r) => r.slug === "model-call") && plan.skipped.some((r) => r.slug === "model-call" && /upstream vendor/.test(r.why)), "a route that serves through a vendor call is skipped by default, with the reason");
  ok(selectPass(cov, { includeUpstream: true }).selected.some((r) => r.slug === "model-call"), "--include-upstream buys it");
  ok(parseArgs(["--include-upstream"]).includeUpstream === true && parseArgs([]).includeUpstream === false, "the flag parses");
  ok(plan.missing === 7, `seven routes sold on Solana lack a PayAI row (${plan.missing}): the identity-bound and EVM-only ones never count`);
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer,mid", `selected cheapest first, within the $${DEFAULT_MAX_PRICE_USD} cap inclusive (${plan.selected.map((r) => r.slug).join()})`);
  ok(plan.skipped.find((r) => r.slug === "premium")?.why.includes("cap") && plan.skipped.find((r) => r.slug === "metered")?.why === "quoted per request, no 402 quote read" && plan.skipped.find((r) => r.slug === "free-shape")?.why === "no fixed price", "the premium, quoted and unpriced routes are skipped with a reason");
  ok(Math.abs(plan.estimateUsd - 0.331) < 1e-9, `the estimate is the list-price sum ($${plan.estimateUsd})`);
}
{
  const plan = selectPass(cov, { maxPriceUsd: 0.6 });
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer,mid,premium", "a raised cap admits the premium route");
}
// --- quoted routes, priced by their own 402 ---------------------------------
{
  const qPricing = {
    payment: { networks: ["base", "solana"] },
    endpoints: [
      { method: "POST", path: "/api/hash", slug: "hash", price: "$0.001", computePayable: true },
      { method: "POST", path: "/api/dub", slug: "dub", price: "$0.140", quoted: true },
      { method: "POST", path: "/api/html-frames", slug: "html-frames", price: "$0.02", quoted: true },
      { method: "POST", path: "/api/decide", slug: "decide", price: "$0.005", quoted: true },
      { method: "POST", path: "/api/cheap-quote", slug: "cheap-quote", price: "$0.50", quoted: true, computePayable: true },
    ],
  };
  const qcov = coverageFor({ pricing: qPricing, payaiItems: [], origin: ORIGIN, chains: ["base", "solana"] });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const challenge = (solAtomic) => enc({ x402Version: 2, accepts: [
    { scheme: "exact", network: BASE, amount: "999999999" },
    { scheme: "upto", network: SOL, amount: "1" },
    { scheme: "exact", network: SOL, amount: String(solAtomic) },
  ] });
  // dub quotes $0.21 (under the cap, above its list price), html-frames $0.40
  // (over the cap), decide answers 400 to its example, cheap-quote $0.003.
  const answers = {
    "/api/dub": { status: 402, pr: challenge(210000) },
    "/api/html-frames": { status: 402, pr: challenge(400000) },
    "/api/decide": { status: 400, pr: null },
    "/api/cheap-quote": { status: 402, pr: challenge(3000) },
  };
  const seen = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    seen.push({ path, method: init.method, body: init.body, paid: Object.keys(init.headers || {}).some((h) => /payment|x-payment/i.test(h)) });
    const a = answers[path];
    return { status: a.status, headers: { get: (k) => (k.toLowerCase() === "payment-required" ? a.pr : null) }, text: async () => "" };
  };
  const examples = { "/api/dub": { text: "hola", targetLanguage: "es" } };
  const requestFor = (r) => ({ url: `${ORIGIN}${r.path}`, body: JSON.stringify(examples[r.path] || {}) });
  const cands = candidatesOf(qcov, { chain: "solana", includeUpstream: true }).filter((r) => r.quoted);
  const quotes = await quoteRoutes(cands, { caip2: SOL, requestFor, fetchImpl });
  ok(seen.length === 4 && seen.every((x) => !x.paid && x.method === "POST") && seen.find((x) => x.path === "/api/dub")?.body === JSON.stringify(examples["/api/dub"]), "each quoted route's published example is sent once, unpaid");
  ok(quotes.get("POST /api/dub")?.atomic === 210000n && Math.abs(quotes.get("POST /api/dub").usd - 0.21) < 1e-12, "the quote is the amount on the Solana exact accept, not another chain's or scheme's");
  const plan = selectPass(qcov, { includeUpstream: true, quotes });
  const dub = plan.selected.find((r) => r.slug === "dub");
  ok(!!dub && Math.abs(dub.priceUsd - 0.21) < 1e-12 && dub.quotedAtomic === 210000n && Math.abs(dub.listPriceUsd - 0.14) < 1e-12, "a quoted route under the cap is selected at its 402 amount, not its list price");
  ok(plan.selected.map((r) => r.slug).join() === "hash,cheap-quote,dub", `cheapest first by the quoted amount (${plan.selected.map((r) => r.slug).join()})`);
  ok(/402 quotes \$0\.4, above the \$0\.25 cap/.test(plan.skipped.find((r) => r.slug === "html-frames")?.why || ""), "a quoted route whose 402 is over the cap is skipped with the reason");
  ok(/did not quote: HTTP 400, not 402/.test(plan.skipped.find((r) => r.slug === "decide")?.why || ""), "a quoted route whose example does not answer 402 is skipped with the reason");
  ok(Math.abs(plan.estimateUsd - (0.001 + 0.003 + 0.21)) < 1e-9, `the spend estimate sums the quoted amounts ($${plan.estimateUsd})`);
  const capped = selectPass(qcov, { includeUpstream: true, quotes, maxSpendUsd: 0.1 });
  ok(capped.selected.map((r) => r.slug).join() === "hash,cheap-quote" && capped.skipped.find((r) => r.slug === "dub")?.why === "past --max-spend", "--max-spend counts the quoted amount");
  const onlyDub = selectPass(qcov, { includeUpstream: true, quotes, only: ["dub"] });
  ok(onlyDub.selected.map((r) => r.slug).join() === "dub" && onlyDub.skipped.length === 0, "--only selects only the named quoted route");
  ok(candidatesOf(qcov, { only: ["dub"], includeUpstream: true }).map((r) => r.slug).join() === "dub" && candidatesOf(qcov, { only: ["dub"] }).length === 0, "--only narrows what is quoted, and a vendor-calling route is not even quoted without --include-upstream");
  ok(selectPass(qcov, { quotes }).skipped.find((r) => r.slug === "dub")?.why.includes("upstream vendor"), "a quoted vendor-calling route still needs --include-upstream");
  const thrown = await quoteRoutes([{ method: "POST", path: "/api/dub", quoted: true }], { caip2: SOL, requestFor, fetchImpl: async () => { throw new Error("socket hang up"); } });
  ok(/did not quote: socket hang up/.test(thrown.get("POST /api/dub")?.why || ""), "a quote read that throws is a skip reason, never a price");
  ok(quoteOf({ accepts: [{ scheme: "exact", network: BASE, amount: "5" }] }, SOL) === null && quoteOf({ accepts: [{ scheme: "exact", network: SOL, amount: "abc" }] }, SOL) === null && quoteOf(null, SOL) === null, "no Solana exact accept, or an unreadable amount, is no quote");
  ok(routeKeyOf({ method: "POST", path: "/api/dub" }) === "POST /api/dub", "quotes are keyed by method and path");
}
// --- the signing ceiling ---------------------------------------------------------
{
  let c = { caip2: SOL, atomic: 210000n };
  const policy = ceilingPolicy(() => c);
  const reqs = [{ network: SOL, amount: "210000" }, { network: SOL, amount: "210001" }, { network: BASE, amount: "1" }];
  ok(JSON.stringify(policy(2, reqs)) === JSON.stringify([reqs[0]]), "the client keeps only this chain's accepts at or under the quoted amount");
  c = { caip2: SOL, atomic: 100000n };
  ok(policy(2, reqs).length === 0, "a 402 that asks more than the quote leaves nothing to sign (the client refuses)");
}
{
  const plan = selectPass(cov, { only: ["answer", " mid "], limit: 1 });
  ok(plan.selected.map((r) => r.slug).join() === "answer" && plan.skipped.find((r) => r.slug === "mid")?.why === "past --limit", "--only narrows and --limit cuts the cheapest-first order, the rest reported as skipped");
}
// --- the run ceiling ----------------------------------------------------------
{
  const plan = selectPass(cov, { maxSpendUsd: 0.1 });
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer" && plan.skipped.find((r) => r.slug === "mid")?.why === "past --max-spend", `--max-spend keeps the cheapest prefix whose list prices fit (${plan.selected.map((r) => r.slug).join()})`);
  ok(Math.abs(plan.estimateUsd - 0.081) < 1e-9 && plan.estimateUsd <= 0.1, `the estimate is the sum of what fits ($${plan.estimateUsd})`);
  ok(selectPass(cov, { maxSpendUsd: 0.081 }).selected.length === 2, "a ceiling equal to the prefix sum admits it (inclusive)");
  ok(selectPass(cov, { maxSpendUsd: 0 }).selected.length === 0 && selectPass(cov, { maxSpendUsd: 0 }).skipped.filter((r) => r.why === "past --max-spend").length === 3, "a zero ceiling selects nothing and says why for every priced route");
  const both = selectPass(cov, { maxSpendUsd: 0.1, limit: 1 });
  ok(both.selected.map((r) => r.slug).join() === "hash" && both.skipped.find((r) => r.slug === "answer")?.why === "past --limit", "--limit and --max-spend are both prefix cuts; the tighter one wins and the count cut names itself");
  const wide = selectPass(cov, { maxSpendUsd: 5 });
  ok(wide.selected.length === 3 && !wide.skipped.some((r) => r.why === "past --max-spend"), "a ceiling above the estimate changes nothing");
}
{
  const plan = selectPass(coverageFor({ pricing, payaiItems: pricing.endpoints.map((e) => ({ resource: `${ORIGIN}${e.path}`, accepts: [{ network: SOL }] })), origin: ORIGIN }));
  ok(plan.missing === 0 && plan.selected.length === 0 && plan.estimateUsd === 0, "a fully listed registry selects nothing");
}

// --- preflight ------------------------------------------------------------
{
  const pr = (fee) => ({ accepts: [{ scheme: "exact", network: BASE, extra: { name: "USD Coin" } }, { scheme: "exact", network: SOL, extra: { feePayer: fee } }] });
  ok(preferenceHonored(pr("A"), pr("B"), SOL).honored === true, "two 402s naming different Solana signers: honored");
  ok(preferenceHonored(pr("A"), pr("A"), SOL).honored === false, "the same signer on both: not honored, nothing may be spent");
  ok(preferenceHonored(pr("A"), { accepts: [] }, SOL).honored === false && preferenceHonored(null, pr("B"), SOL).honored === false, "a missing accept or envelope: not honored");
}

// --- receipt -----------------------------------------------------------------
{
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const res = (h) => ({ headers: { get: (k) => h[k.toLowerCase()] ?? null } });
  ok(receiptOf(res({ "payment-response": enc({ success: true, transaction: "sig" }) }))?.transaction === "sig", "the receipt is read from PAYMENT-RESPONSE");
  ok(receiptOf(res({})) === null && receiptOf(res({ "payment-response": "%%%" })) === null, "no header or an unreadable one reads null");
}

// --- flags -------------------------------------------------------------------
{
  const a = parseArgs(["--live", "--max-price", "0.6", "--only", "a,b", "--limit", "3", "--pause-ms", "10", "--out", "/tmp/x.json", "--settle-wait-ms", "0"]);
  ok(a.live && a.maxPriceUsd === 0.6 && a.only.join() === "a,b" && a.limit === 3 && a.pauseMs === 10 && a.out === "/tmp/x.json" && a.settleWaitMs === 0 && a.chain === "solana", "every flag parses");
  const d = parseArgs([]);
  ok(!d.live && d.maxPriceUsd === DEFAULT_MAX_PRICE_USD && d.only === null && d.limit === Infinity && d.pauseMs === 1500 && d.out === null && d.settleWaitMs === 60_000, "defaults: dry run, the default cap, no filter, a pause between buys");
  ok(parseArgs(["--max-price", "-1"]).maxPriceUsd === DEFAULT_MAX_PRICE_USD && parseArgs(["--max-price", "x"]).maxPriceUsd === DEFAULT_MAX_PRICE_USD, "a bad cap falls back to the default");
  ok(parseArgs(["--max-spend", "2"]).maxSpendUsd === 2 && parseArgs(["--max-spend", "0"]).maxSpendUsd === 0 && d.maxSpendUsd === Infinity, "--max-spend parses, zero included; absent means no ceiling");
  ok(Number.isNaN(parseArgs(["--max-spend", "two"]).maxSpendUsd) && Number.isNaN(parseArgs(["--max-spend", "-1"]).maxSpendUsd) && Number.isNaN(parseArgs(["--max-spend"]).maxSpendUsd), "a ceiling that was given but does not read is NaN, never silently unbounded");
  const refused = await main(["--max-spend", "two"], {});
  ok(refused === 2, `main refuses an unreadable ceiling before any read or buy (exit ${refused})`);
  ok(SETTLE_VIA === "payai", "the pass names the facilitator the server registers");
}

{
  // The OpenAI transcription wire publishes its upload part as a "multipart"
  // placeholder; the pass sends those routes a FormData body, never JSON.
  ok(isMultipartExample({ file: "<audio bytes, multipart part named file>" }) === true, "a multipart file placeholder is a multipart example");
  ok(isMultipartExample({ file: "https://example.com/a.wav" }) === false, "a file URL in JSON is not a multipart example");
  ok(isMultipartExample({ url: "https://example.com" }) === false && isMultipartExample(undefined) === false, "an ordinary or missing example is not multipart");
}

console.log(`test-payai-listing-pass: ${n} passed`);
