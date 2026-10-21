#!/usr/bin/env node
// The listing pass (scripts/payai-listing-pass.js), offline: route selection
// with no per-route cap by default (and the optional one), the run ceiling,
// --only and --limit, quoted routes priced by their own 402 (stubbed fetch),
// the chain premium, the signing ceiling policy, the preflight that refuses to
// spend when the preference is not honored, the receipt reader, the flag
// parser, and whole legs through main() against stubs: Base chain selection
// and its signer, the settle-via header on PayAI buys only, PayAI's
// /supported check on Base, the Bazaar Solana check, the spend ceiling, and
// nothing bought when coverage says listed. Nothing here pays.
//
//   node scripts/test-payai-listing-pass.js
import assert from "node:assert/strict";
import { CHAINS, coverageFor } from "./listing-coverage.js";
import { selectPass, candidatesOf, quoteOf, quoteRoutes, ceilingPolicy, routeKeyOf, preferenceHonored, receiptOf, parseArgs, main, DEFAULT_MAX_PRICE_USD, DEFAULT_MAX_SPEND_USD, SETTLE_VIA, isMultipartExample, premiumOf, supportsExact, legHeaders, keyEnvFor } from "./payai-listing-pass.js";

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
  ok(DEFAULT_MAX_PRICE_USD === Infinity, "there is no per-route cap by default");
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer,mid,premium", `selected cheapest first, the dearest route included (${plan.selected.map((r) => r.slug).join()})`);
  ok(plan.skipped.find((r) => r.slug === "metered")?.why === "quoted per request, no 402 quote read" && plan.skipped.find((r) => r.slug === "free-shape")?.why === "no fixed price", "the quoted-without-a-quote and unpriced routes are skipped with a reason");
  ok(Math.abs(plan.estimateUsd - 0.831) < 1e-9, `the estimate is the list-price sum ($${plan.estimateUsd})`);
  ok(plan.selected.every((r) => r.ceilingAtomic === BigInt(Math.round(r.listPriceUsd * 1e6))), "each list-priced route's signing ceiling is its list price when the chain has no premium");
}
{
  const plan = selectPass(cov, { maxPriceUsd: 0.25 });
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer,mid" && plan.skipped.find((r) => r.slug === "premium")?.why.includes("cap"), "an optional cap still holds out the premium route, with the reason");
}
{
  const plan = selectPass(cov, { premiumAtomic: 1000n });
  ok(plan.selected.find((r) => r.slug === "hash")?.ceilingAtomic === 2000n && Math.abs(plan.selected.find((r) => r.slug === "hash").priceUsd - 0.002) < 1e-12, "a chain premium is added to the price and the signing ceiling");
  ok(Math.abs(plan.estimateUsd - (0.831 + 0.004)) < 1e-9, "...and to the estimate the spend ceiling counts");
  ok(premiumOf({ atomic: 2000n, usd: 0.002 }, 0.001) === 1000n && premiumOf({ atomic: 1000n }, 0.001) === 0n && premiumOf({ atomic: 500n }, 0.001) === 0n && premiumOf({ why: "x" }, 0.001) === 0n, "the premium is the 402 amount over list, never negative, 0 when unread");
}
{
  const bz = coverageFor({ pricing, bazaarItems: [{ resource: `${ORIGIN}/api/hash`, accepts: [{ network: BASE }] }], origin: ORIGIN, chains: ["base", "solana"] });
  const base = selectPass(bz, { registry: "bazaar", chain: "base", includeUpstream: true, quotes: new Map() });
  ok(!base.selected.some((r) => r.slug === "hash") && base.selected.some((r) => r.slug === "memory-write") && base.selected.some((r) => r.slug === "evm-only"), "a Bazaar Base leg skips what the Bazaar lists on Base and includes the EVM-only routes");
  const solLeg = selectPass(bz, { registry: "bazaar", chain: "solana", includeUpstream: true, quotes: new Map() });
  ok(solLeg.selected.some((r) => r.slug === "hash") && !solLeg.selected.some((r) => r.slug === "memory-write"), "a row carrying only Base leaves the route missing on Solana; identity-bound routes never count there");
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
  const plan = selectPass(qcov, { includeUpstream: true, quotes, maxPriceUsd: 0.25 });
  ok(selectPass(qcov, { includeUpstream: true, quotes }).selected.some((r) => r.slug === "html-frames"), "without a cap, a quoted route is bought at whatever its 402 quotes");
  const dub = plan.selected.find((r) => r.slug === "dub");
  ok(!!dub && Math.abs(dub.priceUsd - 0.21) < 1e-12 && dub.quotedAtomic === 210000n && Math.abs(dub.listPriceUsd - 0.14) < 1e-12, "a quoted route under the cap is selected at its 402 amount, not its list price");
  ok(plan.selected.map((r) => r.slug).join() === "hash,cheap-quote,dub", `cheapest first by the quoted amount (${plan.selected.map((r) => r.slug).join()})`);
  ok(/402 quotes \$0\.4, above the \$0\.25 cap/.test(plan.skipped.find((r) => r.slug === "html-frames")?.why || ""), "a quoted route whose 402 is over the cap is skipped with the reason");
  ok(/did not quote: HTTP 400, not 402/.test(plan.skipped.find((r) => r.slug === "decide")?.why || ""), "a quoted route whose example does not answer 402 is skipped with the reason");
  ok(Math.abs(plan.estimateUsd - (0.001 + 0.003 + 0.21)) < 1e-9, `the spend estimate sums the quoted amounts ($${plan.estimateUsd})`);
  const capped = selectPass(qcov, { includeUpstream: true, quotes, maxSpendUsd: 0.1, maxPriceUsd: 0.25 });
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
  ok(selectPass(cov, { maxSpendUsd: 0 }).selected.length === 0 && selectPass(cov, { maxSpendUsd: 0 }).skipped.filter((r) => r.why === "past --max-spend").length === 4, "a zero ceiling selects nothing and says why for every priced route");
  const both = selectPass(cov, { maxSpendUsd: 0.1, limit: 1 });
  ok(both.selected.map((r) => r.slug).join() === "hash" && both.skipped.find((r) => r.slug === "answer")?.why === "past --limit", "--limit and --max-spend are both prefix cuts; the tighter one wins and the count cut names itself");
  const wide = selectPass(cov, { maxSpendUsd: 5 });
  ok(wide.selected.length === 4 && !wide.skipped.some((r) => r.why === "past --max-spend"), "a ceiling above the estimate changes nothing");
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
  ok(a.live && a.maxPriceUsd === 0.6 && a.only.join() === "a,b" && a.limit === 3 && a.pauseMs === 10 && a.out === "/tmp/x.json" && a.settleWaitMs === 0 && a.chain === "solana" && a.registry === "payai", "every flag parses");
  const d = parseArgs([]);
  ok(!d.live && d.maxPriceUsd === Infinity && d.only === null && d.limit === Infinity && d.pauseMs === 1500 && d.out === null && d.settleWaitMs === 60_000, "defaults: dry run, no per-route cap, no filter, a pause between buys");
  ok(parseArgs(["--registry", "Bazaar", "--chain", "base"]).registry === "bazaar" && parseArgs(["--chain", "base"]).chain === "base", "--registry and --chain parse");
  ok(Number.isNaN(parseArgs(["--max-price", "-1"]).maxPriceUsd) && Number.isNaN(parseArgs(["--max-price", "x"]).maxPriceUsd) && Number.isNaN(parseArgs(["--max-price", "0"]).maxPriceUsd), "a cap that was given but does not read is NaN, never silently dropped");
  ok(await main(["--max-price", "x"], {}) === 2, "main refuses an unreadable cap");
  ok(parseArgs(["--max-spend", "2"]).maxSpendUsd === 2 && parseArgs(["--max-spend", "0"]).maxSpendUsd === 0 && d.maxSpendUsd === DEFAULT_MAX_SPEND_USD && DEFAULT_MAX_SPEND_USD === 40, "--max-spend parses, zero included; absent means the default $40 ceiling");
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

// --- whole legs through main(), against stubs ----------------------------------
{
  ok(keyEnvFor("base") === "BURNER_KEY" && keyEnvFor("solana") === "SOLANA_BURNER_KEY", "a Base leg pays from BURNER_KEY, a Solana leg from SOLANA_BURNER_KEY");
  ok(JSON.stringify(legHeaders("payai", "t")) === JSON.stringify({ "X-Agent402-Settle-Via": "payai", "X-Operator-Token": "t" }) && JSON.stringify(legHeaders("bazaar", "t")) === "{}", "only a PayAI leg's buys name a facilitator");
  ok(supportsExact({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE }] }, BASE) && !supportsExact({ kinds: [{ x402Version: 1, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "batch-settlement", network: BASE }] }, BASE) && !supportsExact(null, BASE), "PayAI's /supported counts only an exact v2 kind on the chain");

  const legPricing = {
    payment: { networks: ["base", "solana"] },
    endpoints: [
      { method: "POST", path: "/api/hash", slug: "hash", price: "$0.001", computePayable: true },
      { method: "POST", path: "/api/report", slug: "report", price: "$4.00" },
      { method: "POST", path: "/api/execute-max", slug: "route-execute-max", price: "$3.30" },
      { method: "POST", path: "/api/memory", slug: "memory-write", price: "$0.002", computePayable: true, identityBound: true },
    ],
  };
  const T = "https://target.test";
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const SOL_FEE_DEFAULT = "FeeDefault1111111111111111111111111111111111", SOL_FEE_PAYAI = "FeePayAI11111111111111111111111111111111111";
  // A stub host: every priced route answers 402 at its list price on both
  // chains; the Solana feePayer is PayAI's only on a request carrying the
  // header and the right token (or always, when `sameSigner`).
  const hostFetch = ({ sameSigner = false, payaiSupported = { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOL }] } } = {}) => {
    const reads = [];
    const f = async (url, init = {}) => {
      const u = new URL(url);
      reads.push({ url: String(url), headers: init.headers || {} });
      if (u.pathname === "/openapi.json") return new Response(JSON.stringify({ paths: {} }), { status: 200 });
      if (u.pathname === "/supported") return new Response(JSON.stringify(payaiSupported), { status: 200 });
      const ep = legPricing.endpoints.find((e) => e.path === u.pathname);
      if (!ep) return new Response("", { status: 404 });
      const atomic = String(Math.round(Number(ep.price.slice(1)) * 1e6));
      const h = init.headers || {};
      const tagged = h["X-Agent402-Settle-Via"] === "payai" && h["X-Operator-Token"] === "op-token";
      const accepts = [{ scheme: "exact", network: BASE, amount: atomic }];
      if (!ep.identityBound) accepts.push({ scheme: "exact", network: SOL, amount: atomic, extra: { feePayer: tagged || sameSigner ? SOL_FEE_PAYAI : SOL_FEE_DEFAULT } });
      return new Response("", { status: 402, headers: { "payment-required": enc({ x402Version: 2, accepts }) } });
    };
    return { f, reads };
  };
  const covWith = (bazaarItems = [], payaiItems = []) => coverageFor({ pricing: legPricing, bazaarItems, payaiItems, origin: T, chains: ["base", "solana"] });
  const runLeg = async (argv, { env = {}, cov = covWith(), host = hostFetch() } = {}) => {
    const built = [];
    const buys = [];
    const out = [];
    const deps = {
      fetchImpl: host.f,
      measureCoverage: async () => cov,
      sleep: async () => {},
      log: (m) => out.push(m),
      error: (m) => out.push(m),
      buildPayFetch: async (chainName, rawKey, getCeiling) => {
        built.push({ chainName, rawKey });
        return {
          address: "0xburner",
          payFetch: async (url, init) => {
            buys.push({ path: new URL(url).pathname, headers: init.headers, ceiling: getCeiling() });
            return new Response("{}", { status: 200, headers: { "payment-response": enc({ success: true, transaction: `tx-${buys.length}` }) } });
          },
        };
      },
    };
    const code = await main([...argv, "--settle-wait-ms", "0", "--pause-ms", "0"], { TARGET_URL: T, ...env }, deps);
    return { code, built, buys, out: out.join("\n"), reads: host.reads };
  };
  const ENV = { BURNER_KEY: "0xevmkey", SOLANA_BURNER_KEY: "solkey", AGENT402_OPERATOR_TOKEN: "op-token" };

  // PayAI on Base: the EVM signer, the tag on every buy, PayAI's /supported read.
  {
    const r = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream"], { env: ENV });
    ok(r.code === 0, `payai / base live leg exits 0 (${r.code})${r.code ? `: ${r.out.slice(-200)}` : ""}`);
    ok(r.built.length === 1 && r.built[0].chainName === "base" && r.built[0].rawKey === "0xevmkey", "payai / base builds the Base (EVM) signer from BURNER_KEY, never the Solana key");
    ok(r.buys.map((b) => b.path).join() === "/api/hash,/api/memory,/api/execute-max,/api/report", `every missing route is bought once, cheapest first, the $4 report and the route-execute tier included (${r.buys.map((b) => b.path).join()})`);
    ok(r.buys.every((b) => b.headers["X-Agent402-Settle-Via"] === "payai" && b.headers["X-Operator-Token"] === "op-token"), "every payai / base buy carries the settle-via header and the operator token");
    ok(r.buys.every((b) => b.ceiling.caip2 === BASE) && r.buys.find((b) => b.path === "/api/report").ceiling.atomic === 4_000_000n, "each buy signs on Base under its own price as the ceiling");
    ok(r.reads.some((x) => /\/supported$/.test(x.url)), "the Base leg read PayAI's /supported before spending");
  }
  {
    const r = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream"], { env: ENV, host: hostFetch({ payaiSupported: { kinds: [{ x402Version: 2, scheme: "exact", network: SOL }] } }) });
    ok(r.code === 2 && r.built.length === 0 && r.buys.length === 0 && /does not list exact v2 on eip155:8453/.test(r.out), "PayAI's /supported without Base: exit 2, no signer built, nothing bought");
  }
  {
    const r = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream"], { env: { ...ENV, AGENT402_OPERATOR_TOKEN: "wrong" } });
    ok(r.code === 2 && r.buys.length === 0 && /NOT honored/.test(r.out), "a token the server does not honor: exit 2, nothing bought");
  }
  // The spend ceiling, through main.
  {
    const r = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream", "--max-spend", "3.4"], { env: ENV });
    const total = r.buys.reduce((s, b) => s + Number(b.ceiling.atomic), 0) / 1e6;
    ok(r.code === 0 && r.buys.map((b) => b.path).join() === "/api/hash,/api/memory,/api/execute-max" && total <= 3.4, `--max-spend 3.4 buys the cheapest prefix that fits ($${total}) and leaves the $4 report`);
    const z = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream", "--max-spend", "0"], { env: ENV });
    ok(z.code === 0 && z.buys.length === 0 && z.built.length === 0, "a zero ceiling buys nothing and builds no signer");
  }
  // Bazaar on Base: untagged, no token needed.
  {
    const r = await runLeg(["--registry", "bazaar", "--chain", "base", "--live", "--include-upstream"], { env: { BURNER_KEY: "0xevmkey" } });
    ok(r.code === 0 && r.built[0]?.chainName === "base" && r.buys.length === 4, `bazaar / base buys every missing route on Base without the operator token (${r.code})`);
    ok(r.buys.every((b) => !("X-Agent402-Settle-Via" in b.headers) && !("X-Operator-Token" in b.headers)), "a Bazaar buy carries no settle-via header and no token: it settles at the boot order's first facilitator");
  }
  // Bazaar on Solana: untagged buys, after proving the untagged signer is not PayAI's.
  {
    const r = await runLeg(["--registry", "bazaar", "--chain", "solana", "--live", "--include-upstream"], { env: ENV });
    ok(r.code === 0 && r.built[0]?.chainName === "solana" && r.built[0]?.rawKey === "solkey" && r.buys.length === 3 && r.buys.every((b) => !("X-Agent402-Settle-Via" in b.headers)), `bazaar / solana pays from the Solana burner, untagged, the identity-bound route left out (${r.buys.map((b) => b.path).join()})`);
    const same = await runLeg(["--registry", "bazaar", "--chain", "solana", "--live", "--include-upstream"], { env: ENV, host: hostFetch({ sameSigner: true }) });
    ok(same.code === 2 && same.buys.length === 0 && /not PayAI's/.test(same.out), "when the untagged Solana signer is PayAI's, a Bazaar Solana leg spends nothing");
    const noTok = await runLeg(["--registry", "bazaar", "--chain", "solana", "--live", "--include-upstream"], { env: { SOLANA_BURNER_KEY: "solkey" } });
    ok(noTok.code === 2 && noTok.buys.length === 0, "without the operator token the Bazaar Solana check cannot run, so nothing is bought");
  }
  // Nothing bought when coverage says listed.
  {
    const all = legPricing.endpoints.map((e) => ({ resource: `${T}${e.path}`, accepts: [{ network: BASE }, { network: SOL }] }));
    for (const [reg, ch] of [["bazaar", "base"], ["bazaar", "solana"], ["payai", "solana"], ["payai", "base"]]) {
      const r = await runLeg(["--registry", reg, "--chain", ch, "--live", "--include-upstream"], { env: ENV, cov: covWith(all, all) });
      ok(r.code === 0 && r.buys.length === 0 && r.built.length === 0 && /nothing missing/.test(r.out), `${reg} / ${ch}: fully listed, nothing bought and no signer built`);
    }
    const partial = await runLeg(["--registry", "payai", "--chain", "base", "--live", "--include-upstream"], { env: ENV, cov: covWith([], all.filter((x) => !x.resource.endsWith("/api/report"))) });
    ok(partial.code === 0 && partial.buys.map((b) => b.path).join() === "/api/report", "only the route coverage says is missing is bought");
  }
  // Dry run spends nothing; a chain the pass cannot pay on is refused.
  {
    const r = await runLeg(["--registry", "payai", "--chain", "base", "--include-upstream"], { env: ENV });
    ok(r.code === 0 && r.buys.length === 0 && r.built.length === 0 && /DRY RUN/.test(r.out), "without --live nothing is bought");
    const poly = await runLeg(["--registry", "payai", "--chain", "polygon", "--live"], { env: ENV });
    ok(poly.code === 2 && poly.buys.length === 0, "a chain the pass has no signer for is refused");
    const reg = await runLeg(["--registry", "elsewhere", "--live"], { env: ENV });
    ok(reg.code === 2 && reg.buys.length === 0, "an unknown registry is refused");
  }
}

console.log(`test-payai-listing-pass: ${n} passed`);
