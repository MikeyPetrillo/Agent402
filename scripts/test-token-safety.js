#!/usr/bin/env node
// The cheap EVM token risk facts, offline.
//
//   node scripts/test-token-safety.js
//
// What this pins is the reading, not the reads (scripts/test-token-facts.js
// pins those): the answer lists named facts with their measured values and
// never a verdict, level or score (owner decision 2026-11-24: no answer may
// read as a statement that a token is fine), and a check that was not
// computed is listed as unknown, never read as the absence of a flag. The
// first cut broke that rule with `(g.sellTaxPct ?? 0)`, which read "upstream
// did not say" as "zero tax".
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { tokenFlags, FLAG_IDS } from "../src/tools/token-safety-kit.js";
import { TOKEN_FACTS_NOTICE } from "../src/token-claims.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const clean = { honeypot: false, openSource: true, mintable: false, hiddenOwner: false,
  blacklist: false, transferPausable: false, buyTaxPct: 0, sellTaxPct: 0 };
const ids = (g) => tokenFlags(g).flags.map((f) => f.id);

// --- each named fact fires its own flag, with the measured value ------------
for (const [label, g, id, value] of [
  ["a reverted sell", { ...clean, honeypot: true }, "sell-simulation-reverted", true],
  ["a full-balance sell that fails", { ...clean, cannotSellAll: true }, "cannot-sell-full-balance", true],
  ["a blocked buy", { ...clean, cannotBuy: true }, "buy-blocked", true],
  ["a counterfeit listing", { ...clean, fakeToken: { value: true } }, "listed-as-counterfeit", true],
  ["a 60% sell tax", { ...clean, sellTaxPct: 60 }, "sell-tax-50-or-more", 60],
  ["a 100% buy tax", { ...clean, buyTaxPct: 100 }, "buy-tax-50-or-more", 100],
  ["a 20% sell tax", { ...clean, sellTaxPct: 20 }, "sell-tax-over-10", 20],
  ["mintable supply", { ...clean, mintable: true }, "mintable", true],
  ["a hidden owner", { ...clean, hiddenOwner: true }, "hidden-owner", true],
  ["reclaimable ownership", { ...clean, canTakeBackOwnership: true }, "ownership-reclaimable", true],
  ["pausable transfers", { ...clean, transferPausable: true }, "transfers-pausable", true],
  ["an unverified source", { ...clean, openSource: false }, "source-not-verified", false],
  ["an upgradeable proxy", { ...clean, proxy: true }, "upgradeable-proxy", true],
]) {
  const { flags } = tokenFlags(g);
  const f = flags.find((x) => x.id === id);
  ok(flags.length === 1 && f && f.value === value && typeof f.description === "string" && f.description.length > 10, `${label} lists exactly the ${id} flag with value ${value} (got ${JSON.stringify(flags)})`);
}
ok(ids({ ...clean, buyTaxPct: 50 }).includes("buy-tax-50-or-more") && !ids({ ...clean, buyTaxPct: 50 }).includes("buy-tax-over-10"), "a 50% buy tax is the 50-or-more fact, stated as a fact");
ok(ids({ ...clean, buyTaxPct: 10 }).length === 0, "a 10% tax lists no tax flag");
ok(new Set(FLAG_IDS).size === FLAG_IDS.length, "flag ids are unique");

// --- no flags is only that, and an unanswered check is unknown ----------------
{
  const r = tokenFlags(clean);
  ok(r.flags.length === 0 && r.unknown.length === 0, "every check computed and none fired: no flags, nothing unknown");
  ok(!("verdict" in r) && !("level" in r) && !("score" in r) && !("because" in r), "the reading carries no verdict, level, score or headline");
  const thin = tokenFlags({ honeypot: false, sellTaxPct: null, buyTaxPct: null }, [{ field: "sellTaxPct", reason: "no DEX pool" }]);
  const sell = thin.unknown.find((u) => u.field === "sellTaxPct");
  ok(sell && sell.reason === "no DEX pool" && thin.unknown.some((u) => u.field === "buyTaxPct" && u.reason === "not computed"), `an unanswered tax is unknown with its reason, not treated as zero (got ${JSON.stringify(thin.unknown)})`);
  ok(!tokenFlags({ ...clean, sellTaxPct: null }).flags.some((f) => /tax/.test(f.id)), "a null tax never fabricates a tax flag");
}

// --- the answer: computed facts, their sources and limits ---------------------
{
  const { TOKEN_SAFETY_TOOLS, FACT_FIELDS, TOKEN_SAFETY_SOURCE } = await import("../src/tools/token-safety-kit.js");
  const { SOURCIFY_ATTRIBUTION } = await import("../src/data-attribution.js");
  const t = TOKEN_SAFETY_TOOLS.find((x) => x.slug === "token-safety");
  const ex = t.discovery.output.example;
  ok(Object.keys(ex.facts).join(",") === FACT_FIELDS.join(","), "the published example lists every fact field, in order");
  ok(["chain", "address", "flags", "unknown", "facts", "source", "sources", "limits", "notice"].every((k) => k in ex), "the example lists flags, unknown, facts, sources, limits and the notice");
  ok(!["verdict", "because", "blocking", "warnings", "score", "level"].some((k) => k in ex), "the example carries no verdict, headline, level or score");
  ok(ex.notice === TOKEN_FACTS_NOTICE, "the example carries the fixed notice word for word");
  ok(ex.source === TOKEN_SAFETY_SOURCE && Array.isArray(ex.sources) && ex.sources.length >= 3 && ex.limits.every((l) => l.field && l.reason), "source says what is computed; sources and limits are filled");
  ok(ex.limits.every((l) => FACT_FIELDS.includes(l.field)), "limits name only fields the answer carries");
  ok(ex.facts.honeypot === false && ex.facts.buyTaxPct === 0 && ex.facts.openSource === true && ex.flags.map((f) => f.id).join() === "mintable", "the example is a real computed reading (AERO on Base: simulated, verified, mintable)");
  ok(t.resaleCleared === true && /chain reads/.test(t.resaleClearedBy), "cleared for resale: every source it reads is cleared");
  ok(/simulated buy and sell/.test(t.description) && /no verdict, level or score/.test(t.description) && /listed in unknown with its reason/.test(t.description), "the description says what is computed and how an uncomputed fact reads");
  const { rugcheckEnabled } = await import("../src/rugcheck-switch.js");
  ok(/see sol-token-safety/.test(t.description) === rugcheckEnabled(), "the description points to sol-token-safety only while the RugCheck tools are listed");
  // token-safety, token-risk and token-risk-pro read through token-facts.js,
  // so each declares the keyless hosts that module reads, as a literal list.
  {
    const { TOKEN_CHAIN_NAMES, tokenRpcLanes } = await import("../src/tools/token-facts.js");
    const { TOKEN_RISK_TOOLS } = await import("../src/tools/token-risk-kit.js");
    const want = new Set(["sourcify.dev", "api.dexscreener.com"]);
    for (const c of TOKEN_CHAIN_NAMES) for (const u of tokenRpcLanes(c, {})) want.add(new URL(u).host);
    for (const tool of [t, ...TOKEN_RISK_TOOLS]) {
      const got = [...(tool.upstreamHosts || [])].sort().join(",");
      ok(got === [...want].sort().join(","), `${tool.slug}: upstreamHosts lists the hosts token-facts.js reads (${got})`);
    }
  }
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
    ok(r.flags.map((f) => f.id).join() === "mintable" && r.facts.honeypot === null && r.unknown.some((u) => u.field === "honeypot" && /no DEX pool/.test(u.reason)) && r.unknown.some((u) => u.field === "sellTaxPct"), "no pool listed: the flags name the fact read, the uncomputed checks are unknown with their reasons");
    ok(r.notice === TOKEN_FACTS_NOTICE && !("verdict" in r), "the live answer carries the notice and no verdict");
    ok(r.limits.some((l) => l.field === "honeypot" && /no DEX pool/.test(l.reason)) && r.credit === SOURCIFY_ATTRIBUTION && r.source === TOKEN_SAFETY_SOURCE, "limits say why; the Sourcify credit rides an answer whose verification was read");
    ok(Object.keys(r.facts).join(",") === FACT_FIELDS.join(","), "the live answer's facts are the published fields");
    ok(r.limits.length > 0 && r.limits.every((l) => FACT_FIELDS.includes(l.field)), `the live answer's limits name only fields it carries (${r.limits.map((l) => l.field).join(", ")})`);
  } finally { globalThis.fetch = realFetch; }
}

console.log(`test-token-safety: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
