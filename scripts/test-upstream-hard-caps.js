// Hard daily ceilings for the pay-as-you-go upstreams (src/upstream-hard-caps.js).
//
// The budgets in src/upstream-budgets.js only alarm. These refuse: a host past
// its ceiling is never called, the caller gets an uncharged 503, and the
// ceiling is read the same way as every other spend guard (0 refuses all,
// `off` disables, malformed reads as the default).
import {
  HARD_CAPS, hardCapOf, takeHardCap, hardCapRefusalForHost, hardCapStatus, _resetHardCaps,
} from "../src/upstream-hard-caps.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const cap = (name) => HARD_CAPS.find((c) => c.name === name);
const T0 = Date.parse("2026-10-19T12:00:00Z");

// --- reading a ceiling --------------------------------------------------------
{
  const c = cap("brave");
  ok(hardCapOf(c, {}) === c.dflt, "unset reads as the default");
  ok(hardCapOf(c, { [c.env]: "" }) === c.dflt, "blank reads as the default");
  ok(hardCapOf(c, { [c.env]: "junk" }) === c.dflt, "malformed reads as the default, never as disabled");
  ok(hardCapOf(c, { [c.env]: "-5" }) === c.dflt, "negative reads as the default");
  ok(hardCapOf(c, { [c.env]: "0" }) === 0, "0 is a ceiling of zero");
  ok(hardCapOf(c, { [c.env]: "off" }) === null, "off disables");
  ok(hardCapOf(c, { [c.env]: " 25 " }) === 25, "a number is the ceiling");
}

// --- refusing past the ceiling ------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "3";
  const host = "api.search.brave.com";
  const r = [1, 2, 3, 4, 5].map(() => hardCapRefusalForHost(host, T0));
  ok(r.slice(0, 3).every((x) => x === null), "calls under the ceiling go ahead");
  ok(r[3]?.statusCode === 503 && r[4]?.statusCode === 503, "calls past the ceiling are refused with 503");
  ok(/This call is not charged on x402\./.test(r[3].message) && !/Nothing was charged/.test(r[3].message) && !/brave/i.test(r[3].message), "the refusal scopes the charge to x402 and does not name the upstream");
  const s = hardCapStatus(T0);
  ok(s.status === "capped" && s.upstreams.brave.refusedToday === 2 && s.upstreams.brave.usedToday === 3, "status reads capped and counts the refusals");
  ok(hardCapRefusalForHost(host, T0 + 86_400_000) === null, "a new UTC day starts the count again");
  ok(hardCapStatus(T0 + 86_400_000).status === "ok", "and the status clears with it");
  delete process.env.HARDCAP_BRAVE_CALLS;
}

// --- host matching ------------------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_ALCHEMY_CALLS = "1";
  ok(hardCapRefusalForHost("base-mainnet.g.alchemy.com", T0) === null, "an Alchemy subdomain takes the shared ceiling");
  ok(hardCapRefusalForHost("solana-mainnet.g.alchemy.com", T0)?.statusCode === 503, "every subdomain folds into ONE ceiling");
  ok(hardCapRefusalForHost("notalchemy.com", T0) === null, "a host that merely ends in the same letters is not matched");
  ok(hardCapRefusalForHost("example.com", T0) === null, "an uncapped host is never refused");
  delete process.env.HARDCAP_ALCHEMY_CALLS;
}

// --- zero and off -------------------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_OPENAI_CALLS = "0";
  ok(hardCapRefusalForHost("api.openai.com", T0)?.statusCode === 503, "a ceiling of 0 refuses the first call");
  process.env.HARDCAP_OPENAI_CALLS = "off";
  ok(hardCapRefusalForHost("api.openai.com", T0) === null, "off lets calls through");
  ok(hardCapStatus(T0).upstreams.openai.status === "disabled", "and reads disabled");
  delete process.env.HARDCAP_OPENAI_CALLS;
}

// --- a kit-counted ceiling (E2B sandboxes) ------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_E2B_SANDBOXES = "2";
  ok(takeHardCap("e2b", T0) && takeHardCap("e2b", T0), "sandboxes under the ceiling start");
  ok(takeHardCap("e2b", T0) === false, "the next sandbox is refused");
  delete process.env.HARDCAP_E2B_SANDBOXES;
}

// --- the fetch hook refuses before any network call ---------------------------
// The meter wraps whatever globalThis.fetch is when it installs, once per
// process, so every later block swaps `inner`, never globalThis.fetch.
const realFetch = globalThis.fetch;
let inner = async () => new Response("{}");
globalThis.fetch = (...a) => inner(...a);
const { installEgressMeter } = await import("../src/egress-meter.js");
installEgressMeter();
{
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "1";
  let reached = 0;
  inner = async () => { reached++; return new Response("{}"); };
  await fetch("https://api.search.brave.com/res/v1/web/search?q=a");
  let err = null;
  try { await fetch("https://api.search.brave.com/res/v1/web/search?q=b"); } catch (e) { err = e; }
  ok(reached === 1, `the refused call never reached the network (reached ${reached})`);
  ok(err?.statusCode === 503 && err?.hardCap === true, "the caller gets the 503 refusal");
  await fetch("https://example.com/");
  ok(reached === 2, "other hosts are untouched");
  delete process.env.HARDCAP_BRAVE_CALLS;
}

// --- a partial refusal is never a charged 200 ----------------------------------
// multi-search fans out one upstream call per query; when the ceiling refuses
// any of them the call answers the ceiling's 503, not the searches that ran.
{
  process.env.BRAVE_API_KEY = "test-key";
  const { SEARCH_TOOLS } = await import("../src/tools/search.js");
  const multi = SEARCH_TOOLS.find((t) => t.slug === "multi-search");
  const braveOk = (q) => new Response(JSON.stringify({ web: { results: [{ title: `t ${q}`, url: "https://example.com/", description: "d" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  inner = async (url) => braveOk(new URL(String(url)).searchParams.get("q"));
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "1";
  let out = null, err = null;
  try { out = await multi.handler({ queries: ["alpha", "beta"] }); } catch (e) { err = e; }
  ok(!out && err?.statusCode === 503 && err?.hardCap === true, `multi-search: one query refused by the ceiling -> the ceiling's 503, never a partial 200 (${err?.statusCode ?? "200"})`);
  // Control: another upstream failure on one query still serves the rest.
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "100";
  inner = async (url) => { const q = new URL(String(url)).searchParams.get("q"); return q === "beta" ? new Response("{}", { status: 500 }) : braveOk(q); };
  out = null; err = null;
  try { out = await multi.handler({ queries: ["alpha", "beta"] }); } catch (e) { err = e; }
  ok(out?.searches?.[0]?.count === 1 && /HTTP 500/.test(out?.searches?.[1]?.error || ""), "multi-search: a non-ceiling upstream error on one query keeps the partial answer");
  delete process.env.HARDCAP_BRAVE_CALLS;
}
// Token metadata enrichment: a lookup the ceiling refused fails the call with
// the ceiling's 503 instead of a charged row with blank metadata.
{
  process.env.ALCHEMY_API_KEY = "test-key";
  const { ALCHEMY_DATA_TOOLS, __test: alchemyTest } = await import("../src/tools/alchemy-data-kit.js");
  const balances = ALCHEMY_DATA_TOOLS.find((t) => t.slug === "token-balances");
  const allowance = ALCHEMY_DATA_TOOLS.find((t) => t.slug === "token-allowance");
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", SPENDER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
  let metaStatus = 200;
  inner = async (url, init = {}) => {
    const body = JSON.parse(init.body || "{}");
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (body.method === "alchemy_getTokenBalances") return json({ jsonrpc: "2.0", id: 1, result: { tokenBalances: [{ contractAddress: USDC, tokenBalance: "0x10" }] } });
    if (body.method === "alchemy_getTokenAllowance") return json({ jsonrpc: "2.0", id: 1, result: "0x0" });
    if (body.method === "alchemy_getTokenMetadata") return metaStatus === 200 ? json({ jsonrpc: "2.0", id: 1, result: { symbol: "USDC", name: "USDC", decimals: 6 } }) : new Response("{}", { status: metaStatus });
    return json({ jsonrpc: "2.0", id: 1, result: null });
  };
  for (const [label, run] of [["token-balances", () => balances.handler({ address: WALLET, contracts: [USDC], network: "ethereum" })], ["token-allowance", () => allowance.handler({ contract: USDC, owner: WALLET, spender: SPENDER, network: "ethereum" })]]) {
    alchemyTest.clearMetadataCache();
    _resetHardCaps();
    process.env.HARDCAP_ALCHEMY_CALLS = "1"; // the main read takes it; the metadata lookup is refused
    metaStatus = 200;
    let out = null, err = null;
    try { out = await run(); } catch (e) { err = e; }
    ok(!out && err?.statusCode === 503 && err?.hardCap === true, `${label}: metadata refused by the ceiling -> the ceiling's 503, never a partial 200 (${err?.statusCode ?? "200"})`);
    // Control: a metadata upstream error still answers with blank metadata.
    alchemyTest.clearMetadataCache();
    _resetHardCaps();
    process.env.HARDCAP_ALCHEMY_CALLS = "100";
    metaStatus = 500;
    out = null; err = null;
    try { out = await run(); } catch (e) { err = e; }
    ok(!err && out && (out.tokens ? out.tokens[0].decimals === null : out.decimals === null), `${label}: a non-ceiling metadata error keeps the answer with blank metadata`);
  }
  delete process.env.HARDCAP_ALCHEMY_CALLS;
}
inner = async () => new Response("{}");

// --- the kit gate: no sandbox is created past the ceiling ----------------------
{
  const { CODE_RUN_TOOLS, __test: codeRunTest } = await import("../src/tools/code-run-kit.js");
  process.env.E2B_API_KEY = "test-key";
  let created = 0;
  codeRunTest.setSandbox({ create: async () => { created++; return { runCode: async () => ({ logs: { stdout: ["ok"], stderr: [] }, text: null }), kill: async () => {} }; } });
  const run = CODE_RUN_TOOLS.find((t) => t.slug === "code-run");
  _resetHardCaps();
  process.env.HARDCAP_E2B_SANDBOXES = "0";
  let err = null;
  try { await run.handler({ code: "print(1)", language: "python" }); } catch (e) { err = e; }
  ok(created === 0 && err?.statusCode === 503 && err?.hardCap === true, `code-run: a ceiling of 0 refuses with the ceiling's 503 and creates no sandbox (created ${created})`);
  // Control: under the ceiling the same stub is created and runs.
  _resetHardCaps();
  process.env.HARDCAP_E2B_SANDBOXES = "5";
  err = null;
  try { await run.handler({ code: "print(1)", language: "python" }); } catch (e) { err = e; }
  ok(created === 1 && !err, `code-run: under the ceiling the sandbox is created (created ${created}${err ? `, ${err.message}` : ""})`);
  codeRunTest.setSandbox(undefined);
  delete process.env.HARDCAP_E2B_SANDBOXES;
  delete process.env.E2B_API_KEY;
}
globalThis.fetch = realFetch;

console.log(`\ntest-upstream-hard-caps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
