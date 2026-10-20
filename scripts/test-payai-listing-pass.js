#!/usr/bin/env node
// The PayAI listing pass (scripts/payai-listing-pass.js), offline: route
// selection and the price cap, --only and --limit, quoted routes, the
// preflight that refuses to spend when the preference is not honored, the
// receipt reader, and the flag parser.
//
//   node scripts/test-payai-listing-pass.js
import assert from "node:assert/strict";
import { CHAINS, coverageFor } from "./listing-coverage.js";
import { selectPass, preferenceHonored, receiptOf, parseArgs, DEFAULT_MAX_PRICE_USD, SETTLE_VIA } from "./payai-listing-pass.js";

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
  ok(plan.skipped.find((r) => r.slug === "premium")?.why.includes("cap") && plan.skipped.find((r) => r.slug === "metered")?.why === "quoted per request" && plan.skipped.find((r) => r.slug === "free-shape")?.why === "no fixed price", "the premium, quoted and unpriced routes are skipped with a reason");
  ok(Math.abs(plan.estimateUsd - 0.331) < 1e-9, `the estimate is the list-price sum ($${plan.estimateUsd})`);
}
{
  const plan = selectPass(cov, { maxPriceUsd: 0.6 });
  ok(plan.selected.map((r) => r.slug).join() === "hash,answer,mid,premium", "a raised cap admits the premium route");
}
{
  const plan = selectPass(cov, { includeQuoted: true });
  ok(plan.selected.some((r) => r.slug === "metered"), "--include-quoted admits a quoted route");
}
{
  const plan = selectPass(cov, { only: ["answer", " mid "], limit: 1 });
  ok(plan.selected.map((r) => r.slug).join() === "answer" && plan.skipped.find((r) => r.slug === "mid")?.why === "past --limit", "--only narrows and --limit cuts the cheapest-first order, the rest reported as skipped");
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
  const a = parseArgs(["--live", "--max-price", "0.6", "--only", "a,b", "--limit", "3", "--pause-ms", "10", "--out", "/tmp/x.json", "--include-quoted", "--settle-wait-ms", "0"]);
  ok(a.live && a.maxPriceUsd === 0.6 && a.only.join() === "a,b" && a.limit === 3 && a.pauseMs === 10 && a.out === "/tmp/x.json" && a.includeQuoted && a.settleWaitMs === 0 && a.chain === "solana", "every flag parses");
  const d = parseArgs([]);
  ok(!d.live && d.maxPriceUsd === DEFAULT_MAX_PRICE_USD && d.only === null && d.limit === Infinity && d.pauseMs === 1500 && d.out === null && d.settleWaitMs === 60_000, "defaults: dry run, the default cap, no filter, a pause between buys");
  ok(parseArgs(["--max-price", "-1"]).maxPriceUsd === DEFAULT_MAX_PRICE_USD && parseArgs(["--max-price", "x"]).maxPriceUsd === DEFAULT_MAX_PRICE_USD, "a bad cap falls back to the default");
  ok(SETTLE_VIA === "payai", "the pass names the facilitator the server registers");
}

console.log(`test-payai-listing-pass: ${n} passed`);
