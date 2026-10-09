// Decide phase 3: execution credits and plan execution. Offline: an
// in-memory ledger file, stub catalog handlers, a stub external router.
//
//   node scripts/test-decide-execute.js

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecideLedger, hashToken } from "../src/decide/ledger.js";
import { decideConfig } from "../src/decide/config.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { buildDecideTools } from "../src/tools/decide-kit.js";
import { buildRouteExecuteTool, EXEC_TIERS } from "../src/tools/route-execute.js";
import { makeExecuteHandler, executeQuoteUsd, executeBudgetUsd, makeDecideHandler } from "../src/tools/decide-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const throwsWith = async (fn, status, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && e.statusCode === status && (!frag || String(e.message).includes(frag)), `${m} (${e ? `${e.statusCode} ${String(e.message).slice(0, 90)}` : "no throw"})`); return e; };

const dir = mkdtempSync(join(tmpdir(), "decide-exec-"));
let clock = 1_800_000_000_000;
const now = () => clock;
const ledger = openDecideLedger(join(dir, "ledger.db"));

// ---- credit lifecycle ----
{
  ledger.saveDecision({ decisionId: "d0", depth: "plan", priceUsd: 0.02, payer: "0xa", plan: [], costViaUsd: 0.01, now: clock });
  const c = ledger.mintCredit({ decisionId: "d0", amountUsd: 0.02, ttlMs: 24 * 3600_000, payer: "0xa", now: clock });
  ok(c.token.startsWith("dc_") && ledger.creditAvailableUsd(c.token, "d0", clock) === 0, "a minted credit is pending: worth nothing until its payment settles");
  ok(ledger.redeemCredit(c.token, "d0", "r0", clock) === 0, "a pending credit cannot be redeemed");
  ok(ledger.activateCredit(c.hash) && ledger.creditAvailableUsd(c.token, "d0", clock) === 0.02, "activation (after settlement) makes it spendable");
  ok(ledger.creditAvailableUsd(c.token, "other", clock) === 0, "a credit is bound to its decision");
  ok(ledger.creditAvailableUsd(c.token, "d0", clock + 25 * 3600_000) === 0, "a credit expires after its TTL");
  ok(ledger.redeemCredit(c.token, "d0", "r1", clock) === 0.02 && ledger.redeemCredit(c.token, "d0", "r2", clock) === 0, "exactly one run can redeem a credit");
  ledger.restoreCredit(c.token, "r2");
  ok(ledger.creditState(c.token).state === "redeemed", "only the run that redeemed it can restore it");
  ledger.restoreCredit(c.token, "r1");
  ok(ledger.creditState(c.token).state === "active", "a failed run restores its credit");
  ok(!ledger.db.prepare("SELECT token_hash FROM credits").all().some((r) => r.token_hash === c.token) && ledger.db.prepare("SELECT 1 FROM credits WHERE token_hash = ?").get(hashToken(c.token)), "only the token's hash is stored");
}

// ---- a decision to execute ----
const tool = (id, over = {}) => ({ id, slug: id, name: id, seller: "agent402", firstParty: true, endpoint: `https://agent402.tools/api/${id}`, method: "POST", priceUsd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "x" }, ...over });
const plan = [
  { step: 1, purpose: "one", tool: tool("a"), fallbacks: [tool("b")], dependsOn: [] },
  { step: 2, purpose: "two", tool: tool("ext", { seller: "seller.example", firstParty: false, endpoint: "https://seller.example/x", priceUsd: 0.02 }), fallbacks: [tool("c")], dependsOn: [1] },
];
const calls = [];
let failA = false, routerMode = "ok";
const catalog = {
  a: { slug: "a", route: "POST /api/a", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["a", p]); if (failA) throw Object.assign(new Error("a broke"), { statusCode: 502 }); return { a: p.q }; } },
  b: { slug: "b", route: "POST /api/b", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["b", p]); return { b: p.q }; } },
  c: { slug: "c", route: "POST /api/c", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["c", p]); return { c: p.q }; } },
  rx: { slug: "route-execute-pro", route: "POST /api/route/execute-pro", handler: async (input) => {
    calls.push(["router", input]);
    if (routerMode === "committed") throw Object.assign(new Error("seller settled then failed"), { statusCode: 502, committed: true });
    if (routerMode === "fail") throw Object.assign(new Error("no seller"), { statusCode: 502 });
    if (routerMode === "refused") throw Object.assign(new Error('External seller "https://s.example" failed: Seller refused the payment (HTTP 400); the credential expired unused, nothing charged'), { statusCode: 400 });
    if (routerMode === "hang") return new Promise(() => {});
    return { result: { ext: true }, receipt: { underlyingPriceUsd: 0.018, seller: "seller.example", paidUsd: 3.3, routingFeeUsd: 3.282 } };
  } },
};
const exec = makeExecuteHandler({ ledger, getCatalog: () => catalog, now });
function settle(req, status = 200) { for (const fn of req.__onSettled || []) fn(status === 200); }
function mkReq(payer = "0xabc") { return { headers: {}, ip: payer }; }

ledger.saveDecision({ decisionId: "d1", depth: "plan", priceUsd: 0.02, payer: "0xabc", plan, costViaUsd: 0.031, now: clock });

await throwsWith(() => exec({ decisionId: "d1" }, mkReq()), 409, "not settled", "an unsettled decision cannot be executed");
ledger.markDecisionSettled("d1");
await throwsWith(() => exec({ decisionId: "nope" }, mkReq()), 404, "Unknown decisionId", "unknown decision is a 404 (not charged)");

// ---- pricing ----
{
  const c = ledger.mintCredit({ decisionId: "d1", amountUsd: 0.02, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  ok(executeBudgetUsd({}, ledger.getDecision("d1")) === 0.031 && executeBudgetUsd({ maxBudgetUsd: 0.01 }, ledger.getDecision("d1")) === 0.01, "budget is the plan's via-Agent402 estimate, or the caller's maxBudgetUsd");
  ok(executeBudgetUsd({}, ledger.getDecision("d1"), undefined, 0.05) === 0.05 && executeBudgetUsd({}, ledger.getDecision("d1"), undefined, 0.02) === 0.031 && executeBudgetUsd({ maxBudgetUsd: 0.01 }, ledger.getDecision("d1"), undefined, 0.05) === 0.01, "with no maxBudgetUsd the budget is the larger of the estimate and the credit already held; an asked budget wins");
  ok(executeQuoteUsd({ decisionId: "d1" }, { ledger, now: clock }) === 0.031, "no credit: the 402 quotes the whole budget");
  ok(executeQuoteUsd({ decisionId: "d1", creditToken: c.token }, { ledger, now: clock }) === 0.011, "a valid credit is taken off the quote");
  ok(executeQuoteUsd({ decisionId: "d1", creditToken: c.token, maxBudgetUsd: 0.01 }, { ledger, now: clock }) === 0.001, "a credit larger than the budget leaves the settlement floor");
  ok(executeQuoteUsd({ decisionId: "missing" }, { ledger, now: clock }) === 0.001, "an unknown decision quotes the floor (and the handler then refuses, uncharged)");
  globalThis.__credit1 = c.token;
}

// ---- a full run: first party, then an external step through the router ----
{
  calls.length = 0;
  const req = mkReq();
  const out = await exec({ decisionId: "d1", creditToken: globalThis.__credit1, params: { 2: { q: "given" } } }, req);
  ok(out.status === "complete" && out.steps.length === 2 && out.steps.every((s) => s.status === "ok"), "both steps ran");
  const rcall = calls.find((c) => c[0] === "router")?.[1];
  ok(rcall && rcall.include === "external" && rcall.target === "https://seller.example/x" && rcall.params.q === "given", "the external step is pinned to the planned endpoint and gets the caller's params");
  ok(out.steps[1].costUsd === 0.0189 && out.steps[1].routingFeeUsd === 0.0009 && out.steps[0].costUsd === 0.01, "cost = seller's actual price + disclosed fee on third-party steps; list price, no fee, on first-party");
  ok(out.creditAppliedUsd === 0.02 && out.paidUsd === 0.011 && out.budgetUsd === 0.031, "the credit is redeemed against the run");
  ok(out.charges.firstPartyUsd === 0.01 && out.charges.passThroughUsd === 0.018 && out.charges.routingFeesUsd === 0.0009 && out.charges.uncertainUsd === 0, `charges on separate lines: our tool, pass-through to the seller, routing fee (${JSON.stringify(out.charges)})`);
  ok(out.leftoverCredit && out.leftoverCredit.amountUsd === 0.0021 && ledger.creditState(out.leftoverCredit.token).state === "pending", "unspent budget comes back as a credit, pending until settlement");
  settle(req, 200);
  ok(ledger.creditState(out.leftoverCredit.token).state === "active", "the leftover credit activates on a settled 200");
  ok(ledger.creditState(out.leftoverCredit.token).expiresAt === ledger.getDecision("d1").createdAt + 24 * 3600_000, "the leftover keeps the decision's expiry: no fresh window");
  ok(out.steps[1].untrustedContent === true, "third-party output is marked untrusted");
  ok(out.steps[1].receipt.paidUsd === out.steps[1].costUsd && out.steps[1].receipt.routingFeeUsd === out.steps[1].routingFeeUsd && out.steps[1].receipt.underlyingPriceUsd === 0.018, `the step receipt carries this run's charge, not the router's own price (${JSON.stringify(out.steps[1].receipt)})`);
}

// ---- fallback order, and a first-party failure falls to the next tool ----
{
  calls.length = 0;
  failA = true;
  const out = await exec({ decisionId: "d1", params: { 2: { q: "z" } }, maxBudgetUsd: 0.05 }, mkReq("0xf"));
  failA = false;
  ok(out.steps[0].status === "ok" && out.steps[0].tool.slug === "b" && out.steps[0].attempts[0].error, "a failing primary falls to its fallback");
}

// ---- budget hard stop ----
{
  calls.length = 0;
  const out = await exec({ decisionId: "d1", maxBudgetUsd: 0.015, params: { 2: { q: "z" } } }, mkReq("0xg"));
  ok(out.spentUsd <= 0.015 && out.steps[1].status === "failed" && out.steps[1].attempts.every((a) => a.skipped === "over the remaining budget"), `spend never passes the budget (${out.spentUsd})`);
  ok(!calls.some((c) => c[0] === "router"), "a step that does not fit the remaining budget is never started");
}

// ---- params that do not fit the schema are never sent ----
{
  calls.length = 0;
  const out = await exec({ decisionId: "d1", params: { 1: { wrong: 1 }, 2: { q: "z" } } }, mkReq("0xh"));
  ok(out.steps[0].status === "failed" && out.steps[0].attempts.every((a) => /params do not fit/.test(a.skipped)) && !calls.some((c) => c[0] === "a"), "invalid params: the tool is not called");
}

// ---- ceilings hold under concurrency (checks and booking in one turn) ----
{
  const l2 = openDecideLedger(join(mkdtempSync(join(tmpdir(), "decide-race-")), "l.db"));
  const ext = { id: "e", slug: "e", name: "e", seller: "s.example", firstParty: false, endpoint: "https://s.example/x", method: "POST", priceUsd: 2, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: [] }, exampleParams: { q: "x" } };
  l2.saveDecision({ decisionId: "dr", depth: "plan", priceUsd: 0.02, payer: "p", plan: [{ step: 1, purpose: "x", tool: ext, fallbacks: [], dependsOn: [] }], costViaUsd: 2.1 });
  l2.markDecisionSettled("dr");
  let paidOut = 0;
  const cat = { rx: { slug: "route-execute-pro", route: "POST /x", handler: async () => { await new Promise((r) => setTimeout(r, 20)); paidOut += 2; return { result: {}, receipt: { underlyingPriceUsd: 2 } }; } } };
  // A slow wallet read: before the fix, every request passed the caps on the same reading.
  const ex2 = makeExecuteHandler({ ledger: l2, getCatalog: () => cat, runBudgetMs: () => null, spendingWalletStatus: () => new Promise((r) => setTimeout(() => r({ status: "ok" }), 50)) });
  const reqs = Array.from({ length: 8 }, () => ({ headers: {}, ip: "203.0.113.9", __meteredQuoteUsd: 2.1 }));
  const out = await Promise.allSettled(reqs.map((q) => ex2({ decisionId: "dr" }, q)));
  const ran = out.filter((o) => o.status === "fulfilled").length;
  const cap = decideConfig().execute.perWalletHourUsd;
  ok(ran * 2.1 <= cap + 1e-9 && ran >= 1 && paidOut <= cap, `8 concurrent $2.10 runs from one wallet stay under its $${cap} hourly ceiling (${ran} ran, $${paidOut} paid out)`);
  ok(out.filter((o) => o.status === "rejected").every((o) => o.reason.statusCode === 429), "the rest are refused 429 before anything is paid");
}
{
  // The seller ceiling: legs of different payers to one seller, concurrently.
  const l3 = openDecideLedger(join(mkdtempSync(join(tmpdir(), "decide-race3-")), "l.db"));
  const ext = { id: "e", slug: "e", name: "e", seller: "one.example", firstParty: false, endpoint: "https://one.example/x", method: "POST", priceUsd: 2, inputSchema: { type: "object", properties: {}, required: [] }, exampleParams: {} };
  let paid3 = 0;
  const cat = { rx: { slug: "route-execute-pro", route: "POST /x", handler: async () => { await new Promise((r) => setTimeout(r, 30)); paid3 += 2; return { result: {}, receipt: { underlyingPriceUsd: 2 } }; } } };
  const ex3 = makeExecuteHandler({ ledger: l3, getCatalog: () => cat, runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  const ids = Array.from({ length: 12 }, (_, i) => `ds${i}`);
  for (const id of ids) { l3.saveDecision({ decisionId: id, depth: "plan", priceUsd: 0.02, payer: id, plan: [{ step: 1, purpose: "x", tool: ext, fallbacks: [], dependsOn: [] }], costViaUsd: 2.1 }); l3.markDecisionSettled(id); }
  await Promise.allSettled(ids.map((id, i) => ex3({ decisionId: id }, { headers: {}, ip: `198.51.100.${i + 1}`, __meteredQuoteUsd: 2.1 })));
  const sellerCap = decideConfig().execute.perSellerDayUsd;
  ok(paid3 <= sellerCap && l3.sellerSpendUsd("one.example", 0) <= sellerCap + 1e-9, `12 concurrent legs to one seller stay under its $${sellerCap} daily ceiling ($${paid3} paid, $${l3.sellerSpendUsd("one.example", 0)} booked)`);
}

// ---- a tool marked call-directly is never attempted by execute ----
{
  const l4 = openDecideLedger(join(mkdtempSync(join(tmpdir(), "decide-cd-")), "l.db"));
  const ext = { id: "e", slug: "e", name: "e", seller: "x.example", firstParty: false, endpoint: "https://x.example/x", method: "POST", priceUsd: 0.02, callDirectly: true, executeViaAgent402Usd: null, inputSchema: { type: "object", properties: {}, required: [] }, exampleParams: {} };
  l4.saveDecision({ decisionId: "dc", depth: "plan", priceUsd: 0.02, payer: "p", plan: [{ step: 1, purpose: "x", tool: ext, fallbacks: [], dependsOn: [] }], costViaUsd: 0.05 });
  l4.markDecisionSettled("dc");
  let routed = 0;
  const ex4 = makeExecuteHandler({ ledger: l4, getCatalog: () => ({ rx: { slug: "route-execute-pro", route: "POST /x", handler: async () => { routed++; return { result: {}, receipt: {} }; } } }), runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  const out = await ex4({ decisionId: "dc", maxBudgetUsd: 0.05 }, { headers: {}, ip: "192.0.2.4", __meteredQuoteUsd: 0.05 }).catch((e) => e);
  ok(routed === 0 && (out?.steps?.[0]?.attempts?.[0]?.skipped || out?.message || "").match(/call this tool directly|nothing was charged|caller/), `a call-directly step is skipped without paying anyone (${out?.steps?.[0]?.attempts?.[0]?.skipped || out?.message})`);
}

// ---- a first-party step past its timeout has its outbound calls cut off ----
{
  const { installDrainAwareFetch } = await import("../src/drain-abort.js");
  const realFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = installDrainAwareFetch({ fetchImpl: (u, init) => new Promise((res, rej) => { init?.signal?.addEventListener("abort", () => { aborted = true; rej(init.signal.reason); }); }) });
  const l5 = openDecideLedger(join(mkdtempSync(join(tmpdir(), "decide-to-")), "l.db"));
  const slow = { slug: "slow", route: "POST /api/slow", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => { await fetch("https://upstream.example/slow"); return { never: true }; } };
  l5.saveDecision({ decisionId: "dt", depth: "plan", priceUsd: 0.02, payer: "p", plan: [{ step: 1, purpose: "x", tool: tool("slow"), fallbacks: [], dependsOn: [] }], costViaUsd: 0.01 });
  l5.markDecisionSettled("dt");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { stepTimeoutMs: 150 } });
  const ex5 = makeExecuteHandler({ ledger: l5, getCatalog: () => ({ slow }), runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  await ex5({ decisionId: "dt" }, { headers: {}, ip: "192.0.2.8", __meteredQuoteUsd: 0.01 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 20));
  delete process.env.DECIDE_CONFIG;
  globalThis.fetch = realFetch;
  ok(aborted, "the timed-out step's upstream request is aborted, not left running");
}

// ---- a placeholder the plan could not fill is never sent to a paid tool ----
{
  calls.length = 0;
  const out = await exec({ decisionId: "d1", params: { 1: { q: "<q>" }, 2: { q: "z" } } }, mkReq("0xph"));
  ok(out.steps[0].status === "skipped" && /needs q: pass params/.test(out.steps[0].reason) && !calls.some((c) => c[0] === "a" || c[0] === "b"), "a step still holding a <placeholder> is skipped, not paid for");
}

// ---- a chained step takes the value an earlier step produced ----
{
  const { valueForParam, resolveStepRefs } = await import("../src/decide/step-refs.js");
  const A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  ok(valueForParam("address", { name: "vitalik.eth", address: A, found: true }).value === A, "a field named like the parameter is taken");
  ok(valueForParam("wallet", { data: { resolved: A } }).value === A, "an address parameter takes the one address in the output");
  ok(!valueForParam("wallet", { from: A, to: "0x" + "1".repeat(40) }).ok, "two different addresses: no guess");
  ok(!valueForParam("address", { name: "x.eth", address: null, found: false }).ok, "a null field is not a value");
  ok(valueForParam("q", "hello").value === "hello", "a scalar output is the value");
  ok(!valueForParam("q", { q: "x".repeat(5000) }).ok, "an oversized value does not travel");
  ok(valueForParam("ip", { host: "github.com", answers: [{ type: "A", data: "140.82.112.3" }] }).value === "140.82.112.3", "an ip parameter takes the one IP in the output");
  ok(!valueForParam("ip", { answers: ["140.82.112.3", "140.82.112.4"] }).ok, "several IPs: no guess");
  ok(!resolveStepRefs({ q: "{{step 1}}" }, {}).ok, "a reference to a step that did not run is not resolved");
  const r = resolveStepRefs({ address: "{{step 1}}", chain: "base" }, { 1: { address: A } });
  ok(r.ok && r.params.address === A && r.params.chain === "base", "a resolved reference keeps the step's other params");

  calls.length = 0;
  const ens = tool("ens", { inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, exampleParams: { name: "vitalik.eth" } });
  const bal = tool("bal", { inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] }, exampleParams: { address: "{{step 1}}" } });
  const cat = { ...catalog,
    ens: { slug: "ens", route: "POST /api/ens", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["ens", p]); return p.name === "none.eth" ? { name: p.name, address: null, found: false } : { name: p.name, address: A, found: true }; } },
    bal: { slug: "bal", route: "POST /api/bal", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["bal", p]); return { address: p.address, tokens: [] }; } } };
  const exc = makeExecuteHandler({ ledger, getCatalog: () => cat, now });
  const chainPlan = [{ step: 1, purpose: "resolve", tool: ens, fallbacks: [], dependsOn: [] }, { step: 2, purpose: "balances", tool: bal, fallbacks: [], dependsOn: [1] }];
  ledger.saveDecision({ decisionId: "dchain", depth: "plan", priceUsd: 0.02, payer: "0xch", plan: chainPlan, costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("dchain");
  const out = await exc({ decisionId: "dchain" }, { headers: {}, ip: "0xch", __meteredQuoteUsd: 0.02 });
  ok(out.steps[1].status === "ok" && calls.some((c) => c[0] === "bal" && c[1].address === A), `step 2 runs on step 1's address (${out.steps[1].status} ${out.steps[1].reason || ""})`);

  calls.length = 0;
  ledger.saveDecision({ decisionId: "dchain2", depth: "plan", priceUsd: 0.02, payer: "0xch", plan: chainPlan, costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("dchain2");
  const out2 = await exc({ decisionId: "dchain2", params: { 1: { name: "none.eth" } } }, { headers: {}, ip: "0xch2", __meteredQuoteUsd: 0.02 });
  ok(out2.steps[1].status === "skipped" && /step 1's output has no value for "address"/.test(out2.steps[1].reason) && !calls.some((c) => c[0] === "bal"), "an earlier step that found nothing skips the chained step unpaid");
}

// ---- a backup tool that names the step's one input differently gets it under its own name ----
{
  const { fitParamsToSchema } = await import("../src/decide/params.js");
  const q = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  ok(JSON.stringify(fitParamsToSchema(q, { name: "vitalik.eth" })) === '{"query":"vitalik.eth"}', "one unknown key, one missing required key: renamed");
  ok(JSON.stringify(fitParamsToSchema(q, { name: "a", chain: "base" })) === '{"name":"a","chain":"base"}', "two unknown keys: left alone, never guessed or dropped");
  ok(JSON.stringify(fitParamsToSchema({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, { name: "x" })) === '{"name":"x"}', "a value the backup's declared type refuses is not moved");
  ok(JSON.stringify(fitParamsToSchema(q, { query: "x" })) === '{"query":"x"}' && JSON.stringify(fitParamsToSchema(q, { name: { a: 1 } })) === '{"name":{"a":1}}', "matching params and non-scalar values are untouched");

  calls.length = 0;
  const prim = tool("pn", { inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, exampleParams: { name: "vitalik.eth" } });
  const back = tool("bq", { inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, exampleParams: undefined }); // a plan from before backups carried their own params
  const cat2 = { ...catalog,
    pn: { slug: "pn", route: "POST /api/pn", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => { throw Object.assign(new Error("down"), { statusCode: 502 }); } },
    bq: { slug: "bq", route: "POST /api/bq", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["bq", p]); return { ok: true }; } } };
  const exb = makeExecuteHandler({ ledger, getCatalog: () => cat2, now });
  ledger.saveDecision({ decisionId: "dren", depth: "plan", priceUsd: 0.02, payer: "0xrn", plan: [{ step: 1, purpose: "resolve", tool: prim, fallbacks: [back], dependsOn: [] }], costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("dren");
  const out = await exb({ decisionId: "dren" }, { headers: {}, ip: "0xrn", __meteredQuoteUsd: 0.02 }).catch((e) => ({ steps: [{ status: String(e.message).slice(0, 160) }] }));
  ok(out.steps[0].status === "ok" && calls.some((c) => c[0] === "bq" && c[1].query === "vitalik.eth" && !("name" in c[1])), `the backup ran with the value under its own name (${out.steps[0].status})`);
}

// ---- a seller that refuses a valid payment counts against that seller ----
{
  routerMode = "refused";
  const ext = tool("xr", { seller: "s.example", firstParty: false, endpoint: "https://s.example/x", priceUsd: 0.01 });
  ledger.saveDecision({ decisionId: "dref", depth: "plan", priceUsd: 0.02, payer: "0xrf", plan: [{ step: 1, purpose: "x", tool: ext, fallbacks: [tool("b")], dependsOn: [] }], costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("dref");
  const out = await exec({ decisionId: "dref" }, { headers: {}, ip: "0xrf", __meteredQuoteUsd: 0.02 }).catch((e) => ({ steps: [{ attempts: [] }] }));
  const a = (out.steps[0].attempts || []).find((x) => x.id === "xr");
  ok(a && a.toolFault === true && a.status === 400, `a refused payment is the seller's fault although the router relays a 4xx (${JSON.stringify(a)})`);
  routerMode = "ok";
}

// ---- each backup runs with the params the plan wrote for it ----
{
  calls.length = 0;
  const prim = tool("pd", { inputSchema: { type: "object", properties: { S: {}, K: {} }, required: ["S", "K"] }, exampleParams: { S: 100, K: 105 } });
  const back = tool("bs", { inputSchema: { type: "object", properties: { spot: { type: "number" }, strike: { type: "number" } }, required: ["spot", "strike"] }, exampleParams: { spot: 100, strike: 105 } });
  const miss = tool("pm", { inputSchema: { type: "object", properties: { area: { type: "string" } }, required: ["area"] }, exampleParams: { area: "<area>" } });
  const cat3 = { ...catalog,
    pd: { slug: "pd", route: "POST /api/pd", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => { throw Object.assign(new Error("seller down"), { statusCode: 502 }); } },
    bs: { slug: "bs", route: "POST /api/bs", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["bs", p]); return { price: 1.2 }; } },
    pm: { slug: "pm", route: "POST /api/pm", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["pm", p]); return {}; } } };
  const exo = makeExecuteHandler({ ledger, getCatalog: () => cat3, now });
  ledger.saveDecision({ decisionId: "down", depth: "plan", priceUsd: 0.02, payer: "0xow", plan: [{ step: 1, purpose: "price", tool: prim, fallbacks: [back], dependsOn: [] }, { step: 2, purpose: "labor", tool: miss, fallbacks: [tool("bq2", { slug: "bs", inputSchema: back.inputSchema, exampleParams: { spot: 1, strike: 2 } })], dependsOn: [] }], costViaUsd: 0.03, now: clock });
  ledger.markDecisionSettled("down");
  const out = await exo({ decisionId: "down" }, { headers: {}, ip: "0xow", __meteredQuoteUsd: 0.03 }).catch((e) => ({ steps: [{ status: String(e.message).slice(0, 120) }, {}] }));
  ok(out.steps[0].status === "ok" && calls.some((c) => c[0] === "bs" && c[1].spot === 100 && c[1].strike === 105), `a backup with differently named fields runs with its own params (${out.steps[0].status})`);
  ok(out.steps[1].status === "ok" && !calls.some((c) => c[0] === "pm") && /needs area/.test(JSON.stringify(out.steps[1].attempts || [])), "a tool missing an input is passed over and the next one runs; the step is not skipped whole");
}

// ---- a paid external failure is not followed by another paid seller ----
{
  calls.length = 0;
  routerMode = "committed";
  const plan2 = [{ step: 1, purpose: "x", tool: tool("e1", { firstParty: false, seller: "s1.example", endpoint: "https://s1.example/x" }), fallbacks: [tool("e2", { firstParty: false, seller: "s2.example", endpoint: "https://s2.example/x" })], dependsOn: [] },
    { step: 2, purpose: "y", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d2", depth: "plan", priceUsd: 0.02, plan: plan2, costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("d2");
  const out = await exec({ decisionId: "d2" }, mkReq("0xi"));
  routerMode = "ok";
  ok(calls.filter((c) => c[0] === "router").length === 1 && out.steps[0].status === "failed", "a committed external payment stops the step: no second paid seller");
  ok(ledger.sellerSpendUsd("s1.example", clock - 1) > 0, "...and what that seller may have been paid counts toward its daily ceiling");
}

// ---- a low spending wallet pauses outside steps before anything is paid ----
{
  calls.length = 0;
  routerMode = "ok";
  const low = makeExecuteHandler({ ledger, getCatalog: () => catalog, now, spendingWalletStatus: async () => ({ status: "low" }) });
  const planL = [{ step: 1, purpose: "x", tool: tool("eL", { firstParty: false, seller: "l.example", endpoint: "https://l.example/x", priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dL1", depth: "plan", priceUsd: 0.02, plan: planL, costViaUsd: 0.0105, now: clock });
  ledger.markDecisionSettled("dL1");
  await throwsWith(() => low({ decisionId: "dL1" }, mkReq("0xlow")), 503, "spending wallet", "an all-outside plan is refused 503 while the spending wallet is low");
  ok(!calls.some((c) => c[0] === "router"), "...and no seller was called");
  const planM = [{ step: 1, purpose: "x", tool: tool("eM", { firstParty: false, seller: "m.example", endpoint: "https://m.example/x", priceUsd: 0.01 }), fallbacks: [tool("a")], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dL2", depth: "plan", priceUsd: 0.02, plan: planM, costViaUsd: 0.0105, now: clock });
  ledger.markDecisionSettled("dL2");
  const out = await low({ decisionId: "dL2" }, mkReq("0xlow2"));
  ok(!calls.some((c) => c[0] === "router") && out.steps[0].status === "ok" && out.steps[0].tool.firstParty, "a mixed step skips the outside seller and runs our fallback");
  ok(out.charges && out.charges.firstPartyUsd > 0 && out.charges.passThroughUsd === 0 && out.charges.routingFeesUsd === 0, `the answer separates our tools, pass-through and fees (${JSON.stringify(out.charges)})`);
}

// ---- a run key: the same plan never runs twice for one key ----
{
  calls.length = 0;
  ledger.saveDecision({ decisionId: "dK", depth: "plan", priceUsd: 0.02, plan: [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }], costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("dK");
  const first = await exec({ decisionId: "dK", runKey: "k-1" }, mkReq("0xkey"));
  ok(first.status === "complete", "the first run with a key runs");
  const ran = calls.length;
  await throwsWith(() => exec({ decisionId: "dK", runKey: "k-1" }, mkReq("0xkey")), 409, first.runId, "the same key again is a 409 naming the first run (not charged)");
  ok(calls.length === ran, "...and no tool ran twice");
  const byHeader = await exec({ decisionId: "dK" }, { ...mkReq("0xkey"), headers: { "idempotency-key": "hdr-1" } });
  await throwsWith(() => exec({ decisionId: "dK" }, { ...mkReq("0xkey"), headers: { "idempotency-key": "hdr-1" } }), 409, byHeader.runId, "an Idempotency-Key header works as the run key");
  const other = await exec({ decisionId: "dK", runKey: "k-2" }, mkReq("0xkey"));
  ok(other.runId !== first.runId, "a different key is a different run");
  const again = await exec({ decisionId: "dK", runKey: "k-1" }, mkReq("0xkey")).catch((e) => e);
  ok(again.statusCode === 409 && again.priorRun?.id === first.runId && again.priorRun.status === "complete" && Array.isArray(again.priorRun.steps) && again.priorRun.steps[0]?.status === "ok", "the payer that ran it gets the earlier run's outcome back on the 409");
  const stranger = await exec({ decisionId: "dK", runKey: "k-1" }, mkReq("0xother")).catch((e) => e);
  ok(stranger.statusCode === 409 && !stranger.priorRun, "another payer holding the same key gets the id only, never the results");
  // A run that failed having spent nothing frees its key.
  failA = true;
  const failed = await exec({ decisionId: "dK", runKey: "k-fail" }, mkReq("0xkey")).catch((e) => e);
  failA = false;
  const retried = await exec({ decisionId: "dK", runKey: "k-fail" }, mkReq("0xkey"));
  ok(failed && (failed.statusCode >= 400 || failed.status === "failed") && retried.status === "complete", `a failed run that spent nothing can be retried with the same key (${failed.statusCode || failed.status} then ${retried.status})`);
  await throwsWith(() => exec({ decisionId: "dK", runKey: "k-fail" }, mkReq("0xkey")), 409, retried.runId, "once that retry spent, the key is held again");
}

// ---- one outside seller cannot take more than its daily ceiling ----
{
  calls.length = 0;
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { perSellerDayUsd: 0.001 } });
  const planS = [{ step: 1, purpose: "x", tool: tool("e9", { firstParty: false, seller: "capped.example", endpoint: "https://capped.example/x", priceUsd: 0.01 }), fallbacks: [tool("a")], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dS", depth: "plan", priceUsd: 0.02, plan: planS, costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("dS");
  const out = await exec({ decisionId: "dS" }, mkReq("0xseller"));
  delete process.env.DECIDE_CONFIG;
  ok(!calls.some((c) => c[0] === "router") && /daily execution ceiling/.test(out.steps[0].attempts?.[0]?.skipped || ""), "a seller over its daily ceiling is skipped before any payment; the fallback runs instead");
}

// ---- nothing succeeds: 502, not charged, credit restored ----
{
  routerMode = "fail";
  failA = true;
  const plan3 = [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d3", depth: "quick", priceUsd: 0.005, plan: plan3, costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("d3");
  const c = ledger.mintCredit({ decisionId: "d3", amountUsd: 0.005, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  const e = await throwsWith(() => exec({ decisionId: "d3", creditToken: c.token }, mkReq("0xj")), 502, "Nothing was charged", "a run where no step succeeds is a 502 (settlement cancelled)");
  ok(ledger.creditState(c.token).state === "active", "...and its credit is back");
  failA = false; routerMode = "ok";
}

// ---- a settled-then-failed payment puts the redeemed credit back ----
{
  const plan4 = [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d4", depth: "quick", priceUsd: 0.005, plan: plan4, costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("d4");
  const c = ledger.mintCredit({ decisionId: "d4", amountUsd: 0.005, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  const req = mkReq("0xk");
  await exec({ decisionId: "d4", creditToken: c.token }, req);
  ok(ledger.creditState(c.token).state === "redeemed", "redeemed during the run");
  settle(req, 402);
  ok(ledger.creditState(c.token).state === "redeemed", "settlement failed after the run spent money: the credit is forfeited, not restored (no credit funds run after run)");
}

// ---- concurrent redemption: a credit raced away refuses the run, uncharged ----
{
  const plan5 = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }, { step: 2, purpose: "y", tool: tool("c", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d5", depth: "plan", priceUsd: 0.02, plan: plan5, costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("d5");
  const c = ledger.mintCredit({ decisionId: "d5", amountUsd: 0.02, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  // N racers all quoted $0.001 (the credit covered the budget); the gate stashed that.
  const racers = Array.from({ length: 4 }, () => ({ ...mkReq("0xrace"), __meteredQuoteUsd: 0.001 }));
  calls.length = 0;
  const outcomes = await Promise.allSettled(racers.map((r) => exec({ decisionId: "d5", creditToken: c.token }, r)));
  const won = outcomes.filter((o) => o.status === "fulfilled");
  const refused = outcomes.filter((o) => o.status === "rejected" && o.reason.statusCode === 409);
  ok(won.length === 1 && refused.length === 3, `one racer runs on the credit, the rest are refused 409 before spending (${won.length} ran, ${refused.length} refused)`);
  ok(calls.filter((x) => x[0] === "a").length === 1, "only the winning run called a tool");
  ok(won[0].value.paidUsd === 0.001 && won[0].value.spentUsd <= 0.021, "the winner spends at most what was paid plus the credit");
}

// ---- what was paid is the settled quote, never a recomputation ----
{
  const planQ = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dQ", depth: "quick", priceUsd: 0.005, plan: planQ, costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("dQ");
  const req = { ...mkReq("0xq"), __meteredQuoteUsd: 0.004 };
  await throwsWith(() => exec({ decisionId: "dQ" }, req), 409, "no longer available", "a settled quote below the budget with no credit behind it is refused, uncharged");
}

// ---- a timed-out or committed external leg books its worst case and stops ----
{
  routerMode = "hang";
  const planT = [{ step: 1, purpose: "x", tool: tool("e1", { firstParty: false, seller: "s1.example", endpoint: "https://s1.example/x", priceUsd: 0.01 }), fallbacks: [tool("e2", { firstParty: false, seller: "s2.example", endpoint: "https://s2.example/x", priceUsd: 0.01 })], dependsOn: [] },
    { step: 2, purpose: "y", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dT", depth: "plan", priceUsd: 0.02, plan: planT, costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("dT");
  const execFast = makeExecuteHandler({ ledger, getCatalog: () => catalog, now, runBudgetMs: () => 30_000 });
  calls.length = 0;
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { externalStepTimeoutMs: 1200 } });
  const out = await execFast({ decisionId: "dT" }, mkReq("0xt"));
  delete process.env.DECIDE_CONFIG;
  routerMode = "ok";
  ok(calls.filter((x) => x[0] === "router").length === 1, "a timed-out external leg is not followed by another paid seller");
  ok(out.steps[0].attempts[0].mayHavePaid === true && out.spentUsd >= 0.015 * 1.05 - 1e-9, `...and its worst case is booked against the budget (${out.spentUsd})`);
  ok(out.steps[0].attempts[0].bookedUsd > 0, `...and the attempt records the worst case booked for it (${out.steps[0].attempts[0].bookedUsd})`);
}

// ---- report products never run as a plan step ----
{
  const planR = [{ step: 1, purpose: "x", tool: tool("rep"), fallbacks: [tool("b")], dependsOn: [] }];
  catalog.rep = { slug: "rep", route: "POST /api/rep", price: "$0.60", discovery: { bodyType: "json" }, handler: async () => { calls.push(["rep"]); return {}; } };
  ledger.saveDecision({ decisionId: "dR", depth: "quick", priceUsd: 0.005, plan: planR, costViaUsd: 0.7, now: clock });
  ledger.markDecisionSettled("dR");
  calls.length = 0;
  const execR = makeExecuteHandler({ ledger, getCatalog: () => catalog, now, isComposite: (slug) => slug === "rep" });
  const out = await execR({ decisionId: "dR" }, mkReq("0xr"));
  ok(!calls.some((x) => x[0] === "rep") && out.steps[0].tool.slug === "b" && /report product/.test(out.steps[0].attempts[0].skipped), "a report composite is skipped (it runs only as a direct call); the fallback runs");
}

// ---- first-party steps never receive the paying request ----
{
  let seen = "unset";
  catalog.spy = { slug: "spy", route: "POST /api/spy", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p, r) => { seen = r; return {}; } };
  ledger.saveDecision({ decisionId: "dS", depth: "quick", priceUsd: 0.005, plan: [{ step: 1, purpose: "x", tool: tool("spy"), fallbacks: [], dependsOn: [] }], costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("dS");
  await exec({ decisionId: "dS" }, { ...mkReq("0xs"), headers: { "payment-signature": "secret" } });
  ok(seen === undefined, "a first-party step is called without the request object");
}

// ---- a repriced first-party tool is charged at its live price ----
{
  catalog.a.price = "$0.02";
  ledger.saveDecision({ decisionId: "dP", depth: "quick", priceUsd: 0.005, plan: [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }], costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("dP");
  const out = await exec({ decisionId: "dP" }, mkReq("0xp"));
  catalog.a.price = "$0.01";
  ok(out.steps[0].costUsd === 0.02, "cost uses the live catalog price, not the plan's stored one");
}

// ---- stale running rows and the caps ----
{
  const now0 = Date.now();
  ledger.createRun({ runId: "old", decisionId: "d1", payer: "0xstale", budgetUsd: 2.5, creditUsd: 0, now: now0 - 20 * 60_000 });
  ok(ledger.payerExposureUsd("0xstale", now0 - 3_600_000, now0) === 0, "a run 'running' past the longest possible run no longer holds cap headroom");
  const reopened = openDecideLedger(join(dir, "ledger.db"));
  ok(reopened.getRun("old").status === "abandoned", "a restart marks cut-off runs abandoned");
}

// ---- no roll-forward: a decision past its window returns no leftover credit ----
{
  const planL = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.001 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dL", depth: "quick", priceUsd: 0.005, plan: planL, costViaUsd: 0.001, now: clock - 24 * 3600_000 + 30_000 });
  ledger.markDecisionSettled("dL");
  const out = await exec({ decisionId: "dL", maxBudgetUsd: 0.01 }, mkReq("0xroll"));
  ok(out.leftoverCredit === null, "a decision about to expire mints no leftover credit, so none outlives it");
}

// ---- caps, refused before spending ----
{
  catalog.big = { slug: "big", route: "POST /api/big", price: "$2", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["big", p]); return { ok: 1 }; } };
  const plan6 = [{ step: 1, purpose: "x", tool: tool("big", { priceUsd: 2 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d6", depth: "quick", priceUsd: 0.005, plan: plan6, costViaUsd: 2, now: clock });
  ledger.markDecisionSettled("d6");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { perWalletHourUsd: 3, globalDayUsd: 100 } });
  await exec({ decisionId: "d6" }, mkReq("0xcap"));
  calls.length = 0;
  await throwsWith(() => exec({ decisionId: "d6" }, mkReq("0xcap")), 429, "hourly execution ceiling", "the per-wallet hourly ceiling refuses before spending");
  ok(!calls.length, "...and no tool ran");
  // The global ceiling guards the spending wallet: a plan with an outside step
  // is held to it, a plan of our own tools only is not.
  ledger.saveDecision({ decisionId: "d6x", depth: "quick", priceUsd: 0.005, plan: [{ step: 1, purpose: "x", tool: tool("ext6", { seller: "seller.example", firstParty: false, endpoint: "https://seller.example/x", priceUsd: 2 }), fallbacks: [], dependsOn: [] }], costViaUsd: 2.1, now: clock });
  ledger.markDecisionSettled("d6x");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { globalDayUsd: 1, perPayerDayShare: 1, perWalletHourUsd: 100 } });
  calls.length = 0;
  await throwsWith(() => exec({ decisionId: "d6x" }, mkReq("0xother")), 429, "paused for everyone", "the global daily ceiling refuses a plan with outside steps");
  ok(!calls.some((c) => c[0] === "router"), "...before any outside payment");
  const fp = await exec({ decisionId: "d6" }, mkReq("0xfirstparty")).catch((e) => e);
  ok(!/paused for everyone/.test(String(fp?.message || "")), `a plan of first-party tools only is not held to the wallet's global ceiling (${fp?.status || fp?.message})`);
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { globalDayUsd: 100, perPayerDayShare: 0.01, perWalletHourUsd: 100 } });
  await throwsWith(() => exec({ decisionId: "d6" }, mkReq("0xshare")), 429, "daily execution ceiling", "one wallet may use only its share of the global daily ceiling");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { perCallMaxUsd: 0.5 } });
  ok(executeBudgetUsd({ maxBudgetUsd: 10 }, ledger.getDecision("d6")) === 0.5, "per-call ceiling caps the budget whatever the caller asks");
  delete process.env.DECIDE_CONFIG;
}

// ---- decide mints a pending credit, activated only by a settled 200 ----
{
  const saved = [];
  const fakeLedger = { ...ledger, saveDecision: (x) => saved.push(x), mintCredit: ledger.mintCredit, activateCredit: ledger.activateCredit, markDecisionSettled: () => {} };
  const realFetch = globalThis.fetch;
  process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
  globalThis.fetch = async () => new Response(JSON.stringify({ decisionId: "dx", plan: [{ step: 1, tool: tool("a"), fallbacks: [] }], gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 });
  const req = mkReq();
  const out = await makeDecideHandler({ ledger: fakeLedger, now })({ task: "do it", depth: "full" }, req);
  globalThis.fetch = realFetch;
  ok(out.executionCredit?.amountUsd === 0.05 && out.executionCredit.activeAfterPaymentSettles, "decide returns a credit worth the fee (config: 100%)");
  ok(ledger.creditState(out.executionCredit.token).state === "pending", "...pending until the decision's payment settles");
  settle(req, 402);
  ok(ledger.creditState(out.executionCredit.token).state === "pending", "a failed settlement never activates it");
  settle(req, 200);
  ok(ledger.creditState(out.executionCredit.token).state === "active", "a settled 200 does");

  // An empty plan, or one the model never judged, is refused (never charged).
  process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
  const minted = [];
  const ledger2 = { ...fakeLedger, mintCredit: (x) => { minted.push(x); return ledger.mintCredit(x); } };
  globalThis.fetch = async () => new Response(JSON.stringify({ decisionId: "de", plan: [], gaps: ["translate a paragraph"], estimatedCostViaAgent402Usd: 0 }), { status: 200 });
  await throwsWith(() => makeDecideHandler({ ledger: ledger2, now })({ task: "translate", depth: "plan" }, mkReq()), 422, "not charged", "an empty plan is a 422, not a sale");
  globalThis.fetch = async () => new Response(JSON.stringify({ decisionId: "dj", plan: [{ step: 1, tool: tool("a"), fallbacks: [] }], judged: false, gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 });
  await throwsWith(() => makeDecideHandler({ ledger: ledger2, now })({ task: "x", depth: "plan" }, mkReq()), 503, "not charged", "a plan the model could not judge is a 503, not a sale");
  ok(!minted.length, "...and neither refusal mints a credit");
  // A Tempo-paid decision is bounded inside the credential's settle window.
  let sentDeadline = 0;
  globalThis.fetch = async (_u, init) => { sentDeadline = JSON.parse(init.body).deadlineAt; return new Response(JSON.stringify({ decisionId: "dt", plan: [{ step: 1, tool: tool("a"), fallbacks: [] }], judged: true, gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 }); };
  const t0 = Date.now();
  await makeDecideHandler({ ledger: ledger2, now })({ task: "x", depth: "full" }, { ...mkReq(), mppTempoCredential: {} });
  ok(sentDeadline - t0 <= 14_000 + 3_000 + 50, `a Tempo-paid full decision is given at most ~17s, not the full 29s (${sentDeadline - t0}ms)`);
  const { requiredSecondsFor } = await import("../src/avm-validity.js");
  ok(requiredSecondsFor("decide") >= 30, "an Algorand payment for a decision must stay valid long enough for a full one");
  globalThis.fetch = realFetch;
}

// ---- the REAL router: a seller that settles and then errors is a paid leg ----
{
  const pays = [];
  const realRouter = buildRouteExecuteTool({
    getCatalog: () => ({}), baseUrl: "https://agent402.tools", tier: EXEC_TIERS.find((t) => t.slug === "route-execute-pro"),
    externalEnabled: () => true, externalChains: () => ["base"],
    resolveExternal: async (task, { onlyUrl }) => [{ seller: new URL(onlyUrl).origin, url: onlyUrl, method: "POST", price: "$0.01", priceUsd: 0.01, networks: ["eip155:8453"], wire: "x402" }],
    payExternal: async (url, opts) => { pays.push({ url, maxAtomic: opts.maxAtomic }); throw Object.assign(new Error("seller settled then answered 500"), { statusCode: 502, committed: true, signedUsd: 0.01 }); },
  });
  const catalogR = { rx: realRouter, b: catalog.b };
  const planP = [{ step: 1, purpose: "x", tool: tool("e1", { firstParty: false, seller: "s1.example", endpoint: "https://s1.example/x", priceUsd: 0.01 }), fallbacks: [tool("e2", { firstParty: false, seller: "s2.example", endpoint: "https://s2.example/x", priceUsd: 0.01 })], dependsOn: [] },
    { step: 2, purpose: "y", tool: tool("b"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dReal", depth: "plan", priceUsd: 0.02, plan: planP, costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("dReal");
  const c = ledger.mintCredit({ decisionId: "dReal", amountUsd: 0.05, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  const execReal = makeExecuteHandler({ ledger, getCatalog: () => catalogR, now });
  const req = { ...mkReq("0xreal"), __meteredQuoteUsd: 0.001 };
  const obs = [];
  const realFetch2 = globalThis.fetch;
  process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
  globalThis.fetch = async (u, init) => { if (String(u).includes("/internal/observations")) obs.push(...JSON.parse(init.body).observations); return new Response("{}", { status: 200 }); };
  const out = await execReal({ decisionId: "dReal", creditToken: c.token }, req);
  await new Promise((r) => setTimeout(r, 20));
  globalThis.fetch = realFetch2;
  ok(obs.some((o) => o.toolId === out.steps[0].attempts[0].id && o.ok === false), "a leg that may have been paid and then failed is reported as a failure of that tool");
  ok(obs.length > 0 && obs.every((o) => /^[0-9a-f]{16}$/.test(o.by || "") && o.by !== "0xreal"), "every observation names its payer by a short one-way hash, never the address");
  ok(pays.length === 1 && pays[0].url === "https://s1.example/x", `the real router paid once and no fallback seller was paid (${pays.length} payment(s))`);
  ok(out.steps[0].status === "failed" && out.steps[0].attempts[0].mayHavePaid === true, "the paid-then-failed leg is recognised through the real router's error");
  ok(out.spentUsd >= 0.01 * 1.05 - 1e-9, `...and its signed amount is booked (${out.spentUsd})`);
  settle(req, 402);
  ok(ledger.creditState(c.token).state === "redeemed", "a settlement that fails after a paid leg does not restore the credit");
}

// ---- a run that fails only on the caller's own inputs is a 400 ----
{
  ledger.saveDecision({ decisionId: "dIn", depth: "quick", priceUsd: 0.005, plan: [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }], costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("dIn");
  await throwsWith(() => exec({ decisionId: "dIn", params: { 1: { nope: 1 } } }, mkReq("0xin")), 400, "No step", "params that fit no tool: 400 (not counted as a spend-then-fail)");
}

// ---- every decide tool is wallet-only: none may run on the free tier ----
{
  const tools = buildDecideTools({ getCatalog: () => ({}), ledger });
  ok(tools.length >= 2 && tools.every((t) => WALLET_ONLY_SLUGS.has(t.slug)), `every decide tool is wallet-only (${tools.map((t) => t.slug).join(", ")})`);
  ok(tools.find((t) => t.slug === "decide-execute")?.spendsOwnWallet === true, "execute is marked as spending our wallet before settlement");
  const dq = tools.find((t) => t.slug === "decide"), ex = tools.find((t) => t.slug === "decide-execute");
  ok(dq.quoteMaxUsd === decideConfig().prices.full && dq.quote({ task: "x", depth: "full" }) <= dq.quoteMaxUsd && dq.quote({ task: "x", depth: "plan" }) > Number(dq.price.replace("$", "")), `decide publishes its own range: from the quick price to full's (${dq.price} to $${dq.quoteMaxUsd}), and the default depth quotes above the floor`);
  ok(ex.quoteMaxUsd === decideConfig().execute.perCallMaxUsd, "execute's ceiling is its per-call budget cap, not the model gateway's");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/def\.quoteRange = \{ minUsd: floor, maxUsd: Number\.isFinite\(def\.quoteMaxUsd\)/.test(src), "the published range reads a tool's own quoteMaxUsd");
}


// ---- an outside POST that declares no inputs is never paid with an empty body ----
{
  calls.length = 0;
  const blind = tool("blind", { firstParty: false, seller: "blind.example", endpoint: "https://blind.example/x", method: "POST", inputSchema: { type: "object", properties: {}, required: [] }, exampleParams: {} });
  ledger.saveDecision({ decisionId: "dblind", depth: "plan", priceUsd: 0.02, plan: [{ step: 1, purpose: "x", tool: blind, fallbacks: [], dependsOn: [] }], costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("dblind");
  let out; try { out = await exec({ decisionId: "dblind" }, mkReq("0xblind")); } catch (e) { out = { error: e }; }
  ok(calls.filter((c) => c[0] === "router").length === 0, "no payment is attempted for an empty body to a seller that declares no inputs");
  const attempts = JSON.stringify(out?.steps || out?.error?.message || out);
  ok(/declares no inputs: pass params/.test(attempts), "the step says why and how to run it (pass params)");
}
// ---- a free plan sketch runs through execute by its slugs ----
{
  calls.length = 0;
  catalog.s1 = { slug: "s1", route: "POST /api/s1", price: "$0.004", discovery: { bodyType: "json", inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } }, handler: async (p) => { calls.push(["s1", p]); return { q: `${p.text}-s1` }; } };
  catalog.s2 = { slug: "s2", route: "POST /api/s2", price: "$0.006", discovery: { bodyType: "json", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } }, handler: async (p) => { calls.push(["s2", p]); return { s2: p.q }; } };
  const getCatalog = () => catalog;
  ok(executeQuoteUsd({ steps: ["s1", "s2"] }, { ledger, now: clock, getCatalog }) === 0.01, "a sketch run is quoted at its steps' list prices");
  ok(executeQuoteUsd({ steps: ["s1", "s2"], maxBudgetUsd: 0.005 }, { ledger, now: clock, getCatalog }) === 0.005, "a caller's budget caps the sketch quote");
  ok(executeQuoteUsd({ steps: ["nope", "none"] }, { ledger, now: clock, getCatalog }) === 0.001, "unknown slugs quote the floor (the handler then refuses, uncharged)");
  await throwsWith(() => exec({}, mkReq("0xs")), 400, "steps", "with neither decisionId nor steps the refusal names both");
  await throwsWith(() => exec({ steps: ["s1"] }, mkReq("0xs")), 400, "2 to 5", "one step is not a plan");
  await throwsWith(() => exec({ steps: ["s1", "nope"] }, mkReq("0xs")), 400, 'no tool "nope"', "an unknown slug is refused before anything runs");
  await throwsWith(() => exec({ steps: ["s1", "route-execute-pro"] }, mkReq("0xs")), 400, "route-execute", "a tool execute may not dispatch is refused by name");
  catalog.s3 = { slug: "s3", route: "POST /api/s3", price: "$0.01", quote: () => 0.01, discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["s3", p]); return { s3: true }; } };
  await throwsWith(() => exec({ steps: ["s1", "s3"], params: { 1: { text: "hi" } } }, mkReq("0xs")), 400, "step 2 (s3)", "a per-request-priced tool is refused by name before step 1 runs");
  ok(!calls.length, "no refused sketch ran a step");
  await throwsWith(() => exec({ steps: ["s1", "s2"] }, mkReq("0xs2")), 400, "needs text", "without step-1 params nothing runs and the refusal names the field");
  ok(!calls.length, "the placeholder is never sent to a tool");
  const req = mkReq("0xs");
  const out = await exec({ steps: ["s1", "s2"], params: { 1: { text: "hi" } } }, req);
  ok(out.status === "complete" && out.decisionId.startsWith("skt_") && out.steps.length === 2, `a sketch runs end to end (${out.status}, ${out.decisionId})`);
  ok(out.steps[1].result?.s2 === "hi-s1", "step 2 takes its one required input from step 1's output");
  ok(out.paidUsd === 0.01 && out.spentUsd === 0.01 && out.creditAppliedUsd === 0 && out.charges.firstPartyUsd === 0.01, `priced at list, nothing else (${out.paidUsd}/${out.spentUsd})`);
  const d2 = ledger.getDecision(out.decisionId);
  ok(d2 && d2.depth === "sketch" && d2.priceUsd === 0 && d2.settled && d2.plan[1].tool.exampleParams.q === "{{step 1}}", "the sketch is kept as a free, settled decision whose later step references the one before");
  const again = await exec({ decisionId: out.decisionId, params: { 1: { text: "yo" } } }, mkReq("0xs"));
  ok(again.steps[1].result?.s2 === "yo-s1", "the kept sketch decision runs again by id");
  const both = await exec({ decisionId: out.decisionId, steps: ["s2", "s1"], params: { 1: { text: "id" } } }, mkReq("0xs"));
  ok(both.decisionId === out.decisionId && both.steps[0].tool.slug === "s1", "a decisionId wins over steps");
  ok(!("sweeps" in out), "no sweep bookkeeping leaks into a run answer");
}

console.log(`\ntest-decide-execute: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
