#!/usr/bin/env node
// The cheap EVM token-safety verdict, offline.
//
//   node scripts/test-token-safety.js
//
// Why the tool exists: our only EVM answer to "is this token safe to trade" was
// token-risk at $0.60, an LLM-synthesised report - the wrong shape and price for
// a pre-trade check an agent makes in one call. Solana already had
// sol-token-safety at $0.005; EVM had nothing under sixty cents.
//
// What this pins is the judgement, not the reads (scripts/test-token-facts.js
// pins those): the verdict is derived from named facts, and a check that was
// not computed is never counted as safe. The first cut
// broke that rule with `(g.sellTaxPct ?? 0)`, which read "upstream did not say"
// as "zero tax" - caught by writing this table.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { safetyVerdict } from "../src/tools/token-safety-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const clean = { honeypot: false, openSource: true, mintable: false, hiddenOwner: false,
  blacklist: false, transferPausable: false, buyTaxPct: 0, sellTaxPct: 0 };

// --- blocking: things that take the buyer's money outright -----------------
for (const [label, g] of [
  ["a honeypot", { ...clean, honeypot: true }],
  ["cannot sell the full balance", { ...clean, cannotSellAll: true }],
  ["buying blocked", { ...clean, cannotBuy: true }],
  ["a counterfeit of another token", { ...clean, fakeToken: { value: true } }],
  ["a 60% sell tax", { ...clean, sellTaxPct: 60 }],
]) {
  const v = safetyVerdict(g);
  ok(v.verdict === "unsafe", `${label} is unsafe (got ${v.verdict}: ${v.because})`);
  ok(v.blocking.length > 0, `...and says which fact blocked it`);
}

// --- caution: powers an owner COULD use, but has not ------------------------
for (const [label, g] of [
  ["mintable supply", { ...clean, mintable: true }],
  ["a hidden owner", { ...clean, hiddenOwner: true }],
  ["reclaimable ownership", { ...clean, canTakeBackOwnership: true }],
  ["pausable transfers", { ...clean, transferPausable: true }],
  ["an unverified source", { ...clean, openSource: false }],
  ["an upgradeable proxy", { ...clean, proxy: true }],
]) {
  const v = safetyVerdict(g);
  ok(v.verdict === "caution", `${label} is caution, not unsafe (got ${v.verdict})`);
}

// --- ok, and the rule that makes it trustworthy -----------------------------
{
  const v = safetyVerdict(clean);
  ok(v.verdict === "ok" && !v.blocking.length && !v.warnings.length, "a clean token is ok");

  // THE RULE: an unanswered check is UNKNOWN, never safe. `(x ?? 0)` quietly
  // broke this - a null sell tax compared as 0 and passed every threshold.
  const thin = safetyVerdict({ honeypot: false, sellTaxPct: null, buyTaxPct: null });
  ok(thin.unknown.includes("sell tax") && thin.unknown.includes("buy tax"),
     `an unanswered tax is listed as unknown, not treated as zero (got ${JSON.stringify(thin.unknown)})`);
  ok(/not computed/.test(thin.because),
     "...and the headline says some checks went unanswered rather than implying a clean bill");
  const hugeNull = safetyVerdict({ ...clean, sellTaxPct: null });
  ok(!hugeNull.blocking.some((b) => /sell tax/.test(b)), "a null tax never fabricates a tax finding");
}

// --- no score, on purpose ---------------------------------------------------
{
  const v = safetyVerdict(clean);
  ok(!("score" in v) && !("rating" in v),
     "the verdict carries no number: a score invites a ranking, and a ranking over vendor flags reads as a measurement we did not make");
}

// --- the answer: computed facts, their sources and limits ---------------------
{
  const { TOKEN_SAFETY_TOOLS, FACT_FIELDS, TOKEN_SAFETY_SOURCE } = await import("../src/tools/token-safety-kit.js");
  const { SOURCIFY_ATTRIBUTION } = await import("../src/data-attribution.js");
  const t = TOKEN_SAFETY_TOOLS.find((x) => x.slug === "token-safety");
  const ex = t.discovery.output.example;
  ok(Object.keys(ex.facts).join(",") === FACT_FIELDS.join(","), "the published example lists every fact field, in order");
  ok(["chain", "address", "verdict", "because", "blocking", "warnings", "unknown", "facts", "source", "sources", "limits"].every((k) => k in ex), "the example keeps every field it had and adds sources and limits");
  ok(ex.source === TOKEN_SAFETY_SOURCE && Array.isArray(ex.sources) && ex.sources.length >= 3 && ex.limits.every((l) => l.field && l.reason), "source says what is computed; sources and limits are filled");
  ok(ex.limits.every((l) => FACT_FIELDS.includes(l.field)), "limits name only fields the answer carries");
  ok(ex.facts.honeypot === false && ex.facts.buyTaxPct === 0 && ex.facts.openSource === true && ex.verdict === "caution", "the example is a real computed reading (AERO on Base: simulated, verified, mintable)");
  ok(t.resaleCleared === true && /chain reads/.test(t.resaleClearedBy), "cleared for resale: every source it reads is cleared");
  ok(/simulated buy and sell/.test(t.description) && /never counted as safe/.test(t.description), "the description says what is computed and how an uncomputed fact reads");
  const refused = await t.handler({ address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", chain: "avalanche" }).then(() => null, (e) => e);
  ok(refused?.statusCode === 422 && /celo/.test(refused.message) && /ethereum/.test(refused.message), "an unsupported chain is a 422 naming the supported chains");
  const bad = await t.handler({ address: "0x12", chain: "base" }).then(() => null, (e) => e);
  ok(bad?.statusCode === 422, "a malformed address is a 422");

  // The handler, end to end over a stubbed chain: an EOA is refused, a token answers.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/dexscreener/.test(url)) return new Response("[]", { status: 200 });
    if (/sourcify/.test(url)) return new Response("{}", { status: 404 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, ...(b.method === "eth_getCode" ? { result: "0x" } : { error: { code: 3, message: "execution reverted" } }) }))), { status: 200 });
  };
  try {
    const eoa = await t.handler({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "base" }).then(() => null, (e) => e);
    ok(eoa?.statusCode === 422 && /not a token/.test(eoa.message), `an address with no code is refused 422, not answered (${eoa?.message})`);
  } finally { globalThis.fetch = realFetch; }
  const word = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
  globalThis.fetch = async (url, init) => {
    if (/dexscreener/.test(url)) return new Response("[]", { status: 200 });
    if (/sourcify/.test(url)) return new Response(JSON.stringify({ match: "exact_match", abi: [{ type: "function", name: "mint", stateMutability: "nonpayable" }], sources: {} }), { status: 200 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.map((b) => {
      if (b.method === "eth_getCode") return { jsonrpc: "2.0", id: b.id, result: "0x6080" };
      if (b.method === "eth_getStorageAt") return { jsonrpc: "2.0", id: b.id, result: word(0) };
      const sel = b.params?.[0]?.data?.slice(0, 10);
      if (sel === "0x313ce567") return { jsonrpc: "2.0", id: b.id, result: word(18) };
      if (sel === "0x18160ddd") return { jsonrpc: "2.0", id: b.id, result: word(10n ** 24n) };
      return { jsonrpc: "2.0", id: b.id, error: { code: 3, message: "execution reverted" } };
    })), { status: 200 });
  };
  try {
    const r = await t.handler({ address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", chain: "base" });
    ok(r.verdict === "caution" && r.because === "supply is mintable" && r.facts.honeypot === null && r.unknown.includes("honeypot") && r.unknown.includes("sell tax"), "no pool listed: the verdict names the fact it read and lists the uncomputed checks as unknown");
    ok(r.limits.some((l) => l.field === "honeypot" && /no DEX pool/.test(l.reason)) && r.credit === SOURCIFY_ATTRIBUTION && r.source === TOKEN_SAFETY_SOURCE, "limits say why; the Sourcify credit rides an answer whose verification was read");
    ok(Object.keys(r.facts).join(",") === FACT_FIELDS.join(","), "the live answer's facts are the published fields");
    ok(r.limits.length > 0 && r.limits.every((l) => FACT_FIELDS.includes(l.field)), `the live answer's limits name only fields it carries (${r.limits.map((l) => l.field).join(", ")})`);
  } finally { globalThis.fetch = realFetch; }
}

// --- buy tax at or above half blocks, like sell tax ----------------------------------
{
  const v = safetyVerdict({ ...clean, buyTaxPct: 100 });
  ok(v.verdict === "unsafe" && v.blocking.includes("buy tax 100%"), "a buy that keeps half or more is unsafe");
}

console.log(`test-token-safety: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
