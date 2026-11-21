#!/usr/bin/env node
// A refusal by one of this server's own spend rules names the rule.
//
// Before: route-execute's spend refusals said which ceiling held only in
// prose, the answer's 429 read errorCode rate_limited, and nothing said the
// limit was ours rather than the caller's input or call rate. Now every spend
// refusal carries attribution "ours", a stable rule code (`rule` in the
// answer, from SPEND_RULES in src/refusal-reason.js), reason routing_paused, a
// hint, a next step and a Retry-After, on each path that refuses: the payer's
// unsettled ceiling, the service-wide unsettled ceiling, the chain wallet's
// daily ceiling, the router's per-minute window inside the payer, and the
// other kits that book outside spend (flights, payability, attest).
//
// Offline: stub resolvers and payers only; nothing is signed or bought.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "spend-refusal-rules-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";
delete process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD;
delete process.env.EXTERNAL_SPEND_EXEMPT;

const guard = await import("../src/external-spend-guard.js");
const { SPEND_RULES, spendRuleOf, refusalReason } = await import("../src/refusal-reason.js");
const { toolErrorFields, notCallersInput } = await import("../src/tool-error-fields.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const buyer = await import("../src/x402-buyer.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const origWarn = console.warn;
const quiet = () => { console.warn = () => {}; };
const loud = () => { console.warn = origWarn; };

const PRO = EXEC_TIERS.find((t) => t.slug === "route-execute-pro");
const cand = (host) => ({ seller: `https://${host}`, slug: host.split(".")[0], url: `https://${host}/x`, method: "POST", price: "$0.001", networks: ["eip155:8453"] });
let payCalls = 0;
const tool = (payExternal) => buildRouteExecuteTool({
  getCatalog: () => ({}), tier: PRO,
  resolveExternal: async () => [cand("seller.example")],
  payExternal: payExternal || (async () => { payCalls++; throw new Error("never reached"); }),
  externalEnabled: () => true, externalChains: () => ["base"],
});
let ipSeq = 0;
const run = async (payExternal) => {
  const req = { ip: `198.51.100.${++ipSeq}` };
  quiet();
  try { await tool(payExternal).handler({ task: "t", include: "external" }, req); return { e: null, payer: `ip:${req.ip}` }; }
  catch (e) { return { e, payer: `ip:${req.ip}` }; }
  finally { loud(); }
};
// The answer's machine-readable fields, as every catalog error writer spreads them.
const expectRule = (e, code, label) => {
  const f = toolErrorFields(e);
  ok(e?.statusCode === 429, `${label}: refused 429 (${e?.statusCode} ${String(e?.message).slice(0, 80)})`);
  ok(e?.spendRule === code && spendRuleOf(e) === code, `${label}: the error names rule ${code} (${e?.spendRule})`);
  ok(f.rule === code && f.reason === "routing_paused" && f.attribution === "ours", `${label}: the answer carries rule, reason routing_paused and attribution ours (${JSON.stringify(f)})`);
  ok(f.hint === SPEND_RULES[code].hint && f.retryAfterSeconds === SPEND_RULES[code].retryAfter && /^Your input is fine\./.test(f.fix || ""), `${label}: with the rule's hint, Retry-After and next step`);
  ok(notCallersInput(e, 429) === true, `${label}: never read as the caller's input (no input schema echoed)`);
  ok(refusalReason(e?.message, 429, e) === "routing_paused", `${label}: the tool log classifies it routing_paused`);
};

// 1. The payer's own unsettled ceiling.
{
  guard.__reset();
  const payer = `ip:198.51.100.${ipSeq + 1}`;
  guard.noteSpend(payer, guard.__config.DEFAULT_MAX_UNSETTLED_USD, { chain: "base" });
  const { e } = await run();
  expectRule(e, "payer_unsettled_ceiling", "payer ceiling");
  ok(/paused for this wallet/.test(e?.message || ""), "the payer refusal still says it is this wallet's limit");
}

// 2. The service-wide unsettled ceiling.
{
  guard.__reset();
  process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD = "0.5";
  guard.noteSpend("ip:192.0.2.77", 0.49, {});
  const { e } = await run();
  expectRule(e, "global_unsettled_ceiling", "global ceiling");
  ok(/paused for everyone/.test(e?.message || ""), "the global refusal still says it is paused for everyone");
  delete process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD;
}

// 3. The chain wallet's daily ceiling.
{
  guard.__reset();
  guard.noteSpend("ip:192.0.2.1", guard.walletDailyCeilingUsd("base") - 0.0001, { chain: "base" });
  const { e } = await run();
  expectRule(e, "wallet_daily_ceiling", "wallet daily ceiling");
}

// 4. The router's per-minute window inside the payer, through route-execute's rewrap.
{
  guard.__reset();
  process.env.SOR_SPEND_CAP_ATOMIC = "1";
  process.env.SOR_SPEND_HARD_CAP_ATOMIC = "1";
  let raw = null;
  try { await buyer.reserveSpend(5n); } catch (x) { raw = x; }
  ok(raw?.spendRule === "router_minute_ceiling" && raw.attribution === "ours", `the payer's minute window names its rule (${raw?.spendRule})`);
  const { e } = await run(async () => { throw raw; });
  expectRule(e, "router_minute_ceiling", "minute window via route-execute");
  delete process.env.SOR_SPEND_CAP_ATOMIC;
  delete process.env.SOR_SPEND_HARD_CAP_ATOMIC;
}

// 5. CONTROL: an allowed spend reaches the payer, and a seller's own failure
// carries no rule.
{
  guard.__reset();
  payCalls = 0;
  const { e } = await run();
  ok(payCalls === 1, `CONTROL: with room under every ceiling the payer is called (${payCalls})`);
  ok(e && !e.spendRule && toolErrorFields(e).rule === undefined, `CONTROL: a failure that is not a spend rule carries no rule (${JSON.stringify(toolErrorFields(e))})`);
}

// 6. The other kits that book outside spend name the rule the same way.
{
  const { buildFlightTools } = await import("../src/tools/flights-kit.js");
  const flights = buildFlightTools({ sellers: { search: [{ url: "https://f.example/search", maxUsd: 0.05 }] }, pay: async () => { throw new Error("never reached"); }, reserveSpend: async () => ({ ok: false, code: "wallet_daily_ceiling" }) });
  const h = flights.find((t) => t.slug === "flight-search");
  let e = null;
  try { await h.handler({ from: "BER", to: "BCN", date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }, { ip: "203.0.113.5", header: () => undefined }); } catch (x) { e = x; }
  ok(e?.statusCode === 429 && e.spendRule === "wallet_daily_ceiling" && toolErrorFields(e).rule === "wallet_daily_ceiling", `flights: the refusal names its rule (${e?.statusCode} ${e?.spendRule} ${String(e?.message).slice(0, 80)})`);
}
{
  const { buildSellerPayabilityTool } = await import("../src/tools/seller-payability-kit.js");
  const src = (await import("node:fs")).readFileSync(new URL("../src/tools/seller-payability-kit.js", import.meta.url), "utf8");
  const attest = (await import("node:fs")).readFileSync(new URL("../src/tools/attest-kit.js", import.meta.url), "utf8");
  ok(typeof buildSellerPayabilityTool === "function" && /spendRefusalFields\(allowed\)/.test(src), "seller-payability attaches the rule fields to its spend refusal");
  ok(/spendRefusalFields\(allowed\)/.test(attest), "attest attaches the rule fields to its spend refusal");
}

// 7. The vocabulary is closed and every code is a decision some guard returns.
{
  ok(Object.isFrozen(SPEND_RULES) && Object.keys(SPEND_RULES).length === 5, "five spend rules, frozen");
  ok(spendRuleOf({ spendRule: "made_up" }) === null && spendRuleOf(null) === null, "an unknown code is never carried");
  ok(guard.SPEND_RULES === SPEND_RULES, "the guard re-exports the one table");
  for (const [code, r] of Object.entries(SPEND_RULES)) ok(/^[a-z][a-z0-9-]{0,39}$/.test(r.hint) && Number.isInteger(r.retryAfter) && r.retryAfter > 0, `${code}: a valid hint and Retry-After`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
