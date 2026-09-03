// Offline unit tests for the route-and-execute tool (src/tools/route-execute.js).
// Uses a miniature catalog — no server boot, no network.
import { createHash } from "node:crypto";
import { buildRouteExecuteTool } from "../src/tools/route-execute.js";
import { USAGE_TOOLS } from "../src/tools/usage-kit.js";
import { isIdentityBoundRoute } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? "ok" : "FAIL"} - ${name}`); };

const CATALOG = {};
const addTool = (def) => { CATALOG[def.route] = def; };
addTool({
  route: "POST /api/hash", slug: "hash", name: "Hash", category: "encoding", price: "$0.001",
  description: "Cryptographic hash of a text string", tags: ["hash", "sha256"],
  discovery: { bodyType: "json", input: { text: "hello" } },
  handler: async ({ text }) => ({ algo: "sha256", hex: `hex(${text})` }),
});
addTool({
  route: "GET /api/screenshot", slug: "screenshot", name: "Screenshot", category: "browser", price: "$0.02",
  description: "Screenshot a web page in a headless browser", tags: ["browser", "screenshot"],
  discovery: { input: { url: "https://example.com" } },
  handler: async () => ({ png: "…" }),
});
addTool({
  route: "POST /api/memory-write", slug: "memory-write", name: "Memory write", category: "memory", price: "$0.002",
  description: "Write to wallet-keyed memory", tags: ["memory"],
  discovery: { bodyType: "json", input: { key: "k", value: "v" } },
  handler: async () => ({ okay: true }),
});
addTool({
  route: "POST /api/images-to-pdf", slug: "images-to-pdf", name: "Images to PDF", category: "pdf", price: "$0.003",
  description: "Combine images into a pdf", tags: ["pdf"],
  discovery: { bodyType: "multipart", input: {} },
  handler: async () => ({ pdf: "…" }),
});
addTool({
  route: "POST /api/broken-tool", slug: "broken-tool", name: "Broken", category: "misc", price: "$0.001",
  description: "always fails with a 422", tags: ["broken"],
  discovery: { bodyType: "json", input: {} },
  handler: async () => { throw Object.assign(new Error("upstream said no"), { statusCode: 422 }); },
});

addTool({
  route: "POST /v1/metered/quoted", slug: "quoted-tool", name: "Quoted", category: "llm", price: "$0.001",
  description: "per-request priced model call", tags: ["metered"],
  discovery: { bodyType: "json", input: { model: "x", messages: [] } },
  quote: () => 0.5,
  handler: async () => ({ text: "should never run through the router" }),
});
addTool({
  route: "POST /api/leaky-tool", slug: "leaky-tool", name: "Leaky", category: "misc", price: "$0.001",
  description: "returns an enumerable meter sentinel the way a pre-fix gateway handler did", tags: ["leaky"],
  discovery: { bodyType: "json", input: {} },
  handler: async () => ({ answer: 42, __meterUpstreamUsd: 0.123 }),
});

const tool = buildRouteExecuteTool({ getCatalog: () => CATALOG, baseUrl: "https://agent402.tools" });
CATALOG[tool.route] = tool;

const expectErr = async (input, statusCode, name, contains) => {
  try {
    await tool.handler(input);
    ok(false, `${name} (no error thrown)`);
  } catch (e) {
    const codeOk = e.statusCode === statusCode;
    const msgOk = !contains || String(e.message).includes(contains);
    ok(codeOk && msgOk, `${name}${codeOk ? "" : ` (got ${e.statusCode})`}${msgOk ? "" : ` (msg: ${e.message})`}`);
  }
};

// 1. Direct slug dispatch — the discovery example's own path.
{
  const r = await tool.handler({ slug: "hash", params: { text: "agent402" } });
  ok(r.result.hex === "hex(agent402)", "slug dispatch runs the tool with params");
  ok(r.receipt.slug === "hash" && r.receipt.resolvedBy === "slug", "receipt names the tool and resolution mode");
  ok(r.receipt.underlyingPriceUsd === 0.001 && r.receipt.paidUsd === 0.01, "receipt itemizes underlying vs paid");
  ok(Math.abs(r.receipt.routingFeeUsd - 0.009) < 1e-9, "routing fee is the spread");
}

// 2. Task resolution via the ranker.
{
  const r = await tool.handler({ task: "sha256 hash of a text string", params: { text: "x" } });
  ok(r.receipt.slug === "hash" && r.receipt.resolvedBy === "task", "task resolves to the hash tool");
}

// 3. Guards.
await expectErr({ slug: "screenshot", params: {} }, 409, "over-cap tool refused with self-correcting 409", "call it directly");
// The 409 must ALSO name the tier that covers the price - the proportional
// ladder is only useful if the refusal points at the right rung.
await expectErr({ slug: "screenshot", params: {} }, 409, "over-cap 409 names the covering tier", "route-execute-plus");
await expectErr({ slug: "memory-write", params: {} }, 409, "memory tools refused", "wallet-keyed");
await expectErr({ slug: "images-to-pdf", params: {} }, 409, "non-JSON bodyType refused", "not dispatchable");
await expectErr({ slug: "route-execute", params: {} }, 409, "self-dispatch refused", "another route-execute tier");
// A per-request-priced tool (quote(body)) is refused even though its CATALOG
// price sits under the cap: the flat routing fee cannot cover a quote, and the
// executor's no-request dispatch would skip the quote and the belt entirely.
await expectErr({ slug: "quoted-tool", params: { model: "x", messages: [] } }, 409, "per-request-priced (quoted) tool refused", "call them directly");
{
  const r = await tool.handler({ slug: "leaky-tool", params: {} });
  ok(r.result.answer === 42 && !("__meterUpstreamUsd" in r.result) && !JSON.stringify(r).includes("__meterUpstreamUsd"), "an inner handler's meter sentinel never rides the nested router result");
}
await expectErr({ slug: "nope-nope", params: {} }, 404, "unknown slug is a 404", "Unknown slug");
await expectErr({}, 400, "missing task and slug is a 400", "Provide");
await expectErr({ task: "screenshot a web page in a headless browser" }, 404, "task resolving only to over-cap tools is a 404", "top hit");

// 4. maxUsd narrows the cap but can't raise it above the ceiling.
await expectErr({ slug: "hash", params: { text: "x" }, maxUsd: 0.0005 }, 409, "caller maxUsd below tool price refuses");
{
  const r = await tool.handler({ slug: "hash", params: { text: "x" }, maxUsd: 99 });
  ok(r.receipt.slug === "hash", "maxUsd above the ceiling clamps to the ceiling, hash still dispatches");
}

// 5. Underlying tool errors surface with the tool's own status code.
await expectErr({ slug: "broken-tool", params: {} }, 422, "underlying tool 422 passes through", "Routed tool");

// 6. Recomputable call identity (issue #282): callRef rides the receipt when
// the request carried an EIP-3009 payment authorization; absent otherwise.
{
  const nonce = "0x" + "ab".repeat(32);
  const header = Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x1111111111111111111111111111111111111111", nonce } } })).toString("base64");
  const req = { header: (n) => (String(n).toLowerCase() === "x-payment" ? header : undefined) };
  const r = await tool.handler({ slug: "hash", params: { text: "x" } }, req);
  ok(typeof r.receipt.ts === "string" && r.receipt.ts.endsWith("Z"), "receipt carries the dispatch timestamp");
  const expected = "sha256:" + createHash("sha256").update(JSON.stringify({ nonce, slug: "hash", ts: r.receipt.ts })).digest("hex");
  ok(r.receipt.callRef === expected, "callRef re-derives from {nonce, slug, ts} exactly");
}
{
  const r = await tool.handler({ slug: "hash", params: { text: "x" } });
  ok(r.receipt.callRef === undefined && typeof r.receipt.ts === "string", "nonce-less call omits callRef but keeps ts");
}
{
  const req = { header: () => Buffer.from("not json").toString("base64") };
  const r = await tool.handler({ slug: "hash", params: { text: "x" } }, req);
  ok(r.receipt.callRef === undefined, "malformed payment header degrades to no callRef, not an error");
}

// 7. Identity-bound tools (audit R-03): the executor must refuse EVERY
// identity-bound def BEFORE dispatch. These tools read the SIGNED payment
// identity off the Express request (payerFromRequest / the memory namespace);
// route-execute invokes handlers as `def.handler(params)` with no request, so
// dispatching my-usage would 502 mid-handler AFTER the buyer paid, and memory
// would key the wrong namespace. Verified with the REAL my-usage definition.
{
  const myUsage = USAGE_TOOLS.find((t) => t.slug === "my-usage");
  ok(!!myUsage && isIdentityBoundRoute(myUsage), "real my-usage def is classified identity-bound");
  CATALOG[myUsage.route] = myUsage;
  // A 409 here (not a 502 from payerFromRequest(undefined)) proves the block
  // fires BEFORE the handler runs — no charged deterministic failure.
  await expectErr({ slug: "my-usage", params: {} }, 409, "real my-usage refused pre-dispatch (not a post-payment 502)", "identity-bound");
}
{
  // Memory-category def: the other arm of isIdentityBoundRoute. Its handler
  // throws a NON-statusCode error, so a clean 409 (not a 500) proves the tool
  // was refused before dispatch and the handler never ran.
  addTool({
    route: "POST /api/memory-incr", slug: "memory-incr", name: "Memory incr", category: "memory", price: "$0.002",
    description: "Increment a wallet-keyed counter", tags: ["memory"],
    discovery: { bodyType: "json", input: { key: "k" } },
    handler: async () => { throw new Error("identity-bound handler must never run through route-execute"); },
  });
  await expectErr({ slug: "memory-incr", params: {} }, 409, "memory-category tool refused pre-dispatch", "identity-bound");
}

// --- external dispatch (SOR external execution, flag-gated) ------------------
{
  const EXT = { seller: "https://ext.example", slug: "zk-prove", url: "https://ext.example/api/zk-prove", method: "POST", price: "$0.12", networks: ["eip155:8453"] };
  let paidWith = null;
  const payExternal = async (url, opts) => { paidWith = { url, opts }; return { result: { proof: "0xabc" }, quote: { usd: 0.12, network: "eip155:8453" }, receipt: { transaction: "0xTX", network: "eip155:8453" } }; };
  const resolveExternal = async () => EXT;

  // flag OFF: never resolves/pays external, returns 404 for an unmatched task
  const off = buildRouteExecuteTool({ getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, resolveExternal, payExternal, externalEnabled: () => false });
  let threw = null;
  try { await off.handler({ task: "summarize a twitter thread", include: "external" }, {}); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 409 && paidWith === null, "include:external + flag OFF: 409, never pays");
  // flag OFF, no include: internal-only, never touches external
  paidWith = null;
  let t0 = null;
  try { await off.handler({ task: "hash a string" }, {}); } catch (e) { t0 = e; }
  ok(paidWith === null, "no include: external never consulted (internal default)");

  // flag ON: pays the external seller, relays result + receipt, marks untrusted
  paidWith = null;
  const on = buildRouteExecuteTool({ getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, resolveExternal, payExternal, externalEnabled: () => true });
  const r = await on.handler({ task: "summarize a twitter thread", include: "external", params: { circuit: "c" } }, {});
  ok(paidWith?.url === EXT.url && paidWith.opts.method === "POST" && paidWith.opts.body.circuit === "c", "external ON: pays the resolved seller url with the params body");
  ok(paidWith.opts.maxAtomic === 500000n, "external ON: margin cap passed as atomic (cap $0.50 → 500000)");
  ok(r.receipt.seller === EXT.seller && r.receipt.external === true && r.receipt.settleTx === "0xTX", "external receipt carries seller + external flag + settle tx");
  ok(r.receipt.underlyingPriceUsd === 0.12 && r.receipt.paidUsd === 0.55, "external receipt shows underlying (from live quote) vs paid tier");
  ok(r.result.proof === "0xabc" && r.result.untrustedContent === true, "external result relayed + marked untrustedContent");

  // The requested model reaches the resolver (it skips chat sellers whose
  // published model list lacks it); absent or blank, nothing is passed.
  {
    const seen = [];
    const spy = buildRouteExecuteTool({ getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
      resolveExternal: async (task, opts) => { seen.push(opts.wantModel); return EXT; }, payExternal, externalEnabled: () => true });
    await spy.handler({ task: "chat completions", include: "external", params: { model: " gpt-4o-mini ", messages: [] } }, {});
    await spy.handler({ task: "chat completions", include: "external", params: { messages: [] } }, {});
    await spy.handler({ task: "chat completions", include: "external", params: { model: "" } }, {});
    ok(seen[0] === "gpt-4o-mini" && seen[1] === null && seen[2] === null, "resolver receives the trimmed params.model, null when absent or blank");
  }

  // THE CALLER PATH for the payTo binding. payX402's own tests hand it a
  // provenPayTo directly, which proves the comparison and says nothing about
  // whether anything ever SUPPLIES one - the same shape of hole that left the
  // metered-billing branch dead with two green tests. So assert the forwarding
  // here, where the resolver and the payer are both injectable.
  paidWith = null;
  const proven = "0x1111111111111111111111111111111111111111";
  const bound = buildRouteExecuteTool({
    getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
    resolveExternal: async () => ({ ...EXT, provenPayTo: proven }), payExternal, externalEnabled: () => true,
  });
  await bound.handler({ task: "summarize a twitter thread", include: "external", params: { circuit: "c" } }, {});
  ok(paidWith?.opts?.provenPayTo === proven,
    "external ON: the resolver's provenPayTo reaches payExternal, so the spend can re-check the accept it signs");

  // A resolver that names no address must forward null, never undefined-by-omission
  // dressed up as a value: the payer treats null as UNKNOWN and does not block.
  paidWith = null;
  const unbound = buildRouteExecuteTool({
    getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
    resolveExternal: async () => EXT, payExternal, externalEnabled: () => true,
  });
  await unbound.handler({ task: "summarize a twitter thread", include: "external", params: { circuit: "c" } }, {});
  ok(paidWith?.opts && "provenPayTo" in paidWith.opts && paidWith.opts.provenPayTo === null,
    "external ON: no proven address forwards an explicit null (UNKNOWN), never a missing key");

  // over-cap external is refused (not paid): resolver returns a $0.60 tool > $0.50 cap
  paidWith = null;
  const pricey = buildRouteExecuteTool({ getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, resolveExternal: async () => ({ ...EXT, price: "$0.60" }), payExternal, externalEnabled: () => true });
  let t2 = null;
  try { await pricey.handler({ task: "xyzzy nonexistent qqzz gibberish nomatch" }, {}); } catch (e) { t2 = e; }
  ok(t2 && t2.statusCode === 404 && paidWith === null, "external over-cap: refused, never pays");
}

// routeExecuteHint quotes the right tier per underlying price
{
  const { routeExecuteHint, EXEC_TIERS } = await import("../src/tools/route-execute.js");
  const { SELF_FUNDING_SLUGS } = await import("../src/payments.js");
  // Self-funding invariant: EVERY exec tier's Base revenue must settle to the
  // burner that pays its external spends. A tier missing from the set is a
  // one-way leak - revenue to the treasury, spend from the burner (the plus
  // tier shipped that way for one commit on 2026-07-29 before this lock).
  for (const t of EXEC_TIERS) {
    ok(SELF_FUNDING_SLUGS.has(t.slug), `SELF_FUNDING_SLUGS covers ${t.slug} - burner pays itself, never a one-way drain`);
  }
  ok(routeExecuteHint(0.003)?.tool === "route-execute", "$0.003 → route-execute tier");
  ok(routeExecuteHint(0.02)?.tool === "route-execute-plus", "$0.02 → route-execute-plus tier (the proportional middle rung)");
  ok(routeExecuteHint(0.04)?.tool === "route-execute-plus", "$0.04 → plus tier boundary inclusive");
  ok(routeExecuteHint(0.05)?.tool === "route-execute-max", "$0.05 → max tier (just over the plus cap)");
  ok(routeExecuteHint(0.12)?.tool === "route-execute-max", "$0.12 → route-execute-max tier");
  // The pro tier (2026-08-07) exists because the $0.50 ceiling excluded every
  // indexed tool priced above it: the router could only answer those with a 409
  // pointing at the seller's own direct route.
  ok(routeExecuteHint(0.9)?.tool === "route-execute-pro", "$0.90 → route-execute-pro (was unroutable before the pro tier)");
  ok(routeExecuteHint(2.99)?.tool === "route-execute-pro", "$2.99 → pro tier - a price the old ceiling excluded");
  ok(routeExecuteHint(3.0)?.tool === "route-execute-pro", "$3.00 → pro tier boundary inclusive");
  ok(routeExecuteHint(3.01) === null, "$3.01 → no tier: the ceiling still exists, it just moved");
  // The fee stays proportional rather than punishing size: 10% at the cap, the
  // same spread as the max tier, not the 27x markup the plus tier was added to fix.
  const pro = routeExecuteHint(3.0);
  ok(Math.abs(pro.routingFeeUsd - 0.3) < 1e-9, `pro tier's fee at the cap is $0.30, a 10% spread (got ${pro.routingFeeUsd})`);
}


// --- the spending wallet's alarm must cover the biggest call ------------------
// $0.50 was right when only Blockscout ($0.002/call) spent from that wallet.
// A tier that can spend $3.00 in one call makes "ok" mean "has at least $0.50"
// for a wallet that cannot cover a single call - the alarm would stay green
// right up to the failure it exists to prevent. Nothing else reports this.
{
  const { BUYER_LOW_DEFAULT_USD } = await import("../src/tools/blockscout-kit.js");
  const { EXEC_TIERS: TIERS } = await import("../src/tools/route-execute.js");
  const biggest = Math.max(...TIERS.map((t) => t.underlyingMaxUsd));
  ok(BUYER_LOW_DEFAULT_USD >= biggest,
    `the upstream buyer low-water default ($${BUYER_LOW_DEFAULT_USD}) covers the largest tier's underlying spend ($${biggest}) - otherwise "ok" can mean "cannot fund one call"`);
}

// --- every spend-capable tier MUST require a real wallet payment ------------
// route-execute-pro (underlyingMaxUsd $3.00) shipped 2026-08-07 and was never
// added to WALLET_ONLY_SLUGS - live PoW-eligible (free) for days. Found and
// fixed 2026-08-11. The free tier has NO per-caller spend cap for this class
// of call: external-spend-guard.js's maySpend() explicitly returns ok:true,
// UNCAPPED, whenever the payer is unattributable - exactly every free/PoW
// call, since there is no signed EIP-3009 authorization to attribute to. A
// free caller could have solved a cheap PoW puzzle and directed our upstream
// spending wallet to pay up to $3.00 to a seller of their own choosing,
// repeated with zero cumulative limit. This asserts the invariant
// structurally, derived from EXEC_TIERS itself, so the NEXT tier can't ship
// with the same gap - no one has to remember to update a hand-written list.
{
  const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
  const { EXEC_TIERS: TIERS } = await import("../src/tools/route-execute.js");
  for (const t of TIERS) {
    if (t.underlyingMaxUsd > 0) {
      ok(WALLET_ONLY_SLUGS.has(t.slug),
        `${t.slug} can spend up to $${t.underlyingMaxUsd} of our upstream wallet, so it MUST be wallet-only (unattributable free/PoW callers get no cumulative spend cap at all)`);
    }
  }
}

// --- fallthrough on a seller 5xx (2026-09-01) -------------------------------
// A seller whose own upstream is down (5xx) must not fail a route another
// resolved seller can serve - but the money-safety rules are strict: only a
// 5xx falls through, never a 4xx (cancels settlement, our request is wrong),
// and never an error carrying a settle receipt (we may have paid).
{
  const A = { seller: "https://a.example", slug: "svc-a", url: "https://a.example/x", method: "POST", price: "$0.01", networks: ["eip155:8453"] };
  const B = { seller: "https://b.example", slug: "svc-b", url: "https://b.example/y", method: "POST", price: "$0.01", networks: ["eip155:8453"] };
  const good = { result: { ok: true }, quote: { usd: 0.01, network: "eip155:8453" }, receipt: { transaction: "0xTX" } };
  const mk = (payExternal, resolveExternal) => buildRouteExecuteTool({
    getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
    resolveExternal, payExternal, externalEnabled: () => true,
  });
  const err = (msg, sc, extra = {}) => Object.assign(new Error(msg), { statusCode: sc, ...extra });

  // A fails PRE-COMMIT (unreachable, no payable accept - payX402 never sent the
  // authorization, so nothing was spent), B serves -> B's result, A skipped.
  {
    let calls = [];
    const pay = async (url) => { calls.push(url); if (url === A.url) throw err("Seller unreachable", 502); return good; };
    const r = await mk(pay, async () => [A, B]).handler({ task: "t", include: "external" }, {});
    ok(calls.length === 2 && calls[0] === A.url && calls[1] === B.url && r.receipt.seller === B.seller,
      "a PRE-commit failure (nothing spent) falls through to the next candidate, which serves");
  }
  // A fails POST-COMMIT (committed:true - the authorization went out, we may
  // have paid) -> STOP, never try B. This is the double-spend hinge: the
  // seller's HTTP status is irrelevant, only whether OUR code sent the header.
  {
    let calls = [];
    const pay = async (url) => { calls.push(url); if (url === A.url) throw err("Seller rejected the paid retry (HTTP 502)", 502, { committed: true }); return good; };
    let threw = null;
    try { await mk(pay, async () => [A, B]).handler({ task: "t", include: "external" }, {}); } catch (e) { threw = e; }
    ok(calls.length === 1 && threw && threw.statusCode === 502, "a POST-commit 5xx (committed:true) does NOT fall through - we may have paid, so no second spend");
  }
  // A 400s (pre-commit, but our request is wrong) -> B would reject it the same,
  // yet it IS pre-commit so it is safe to try; assert it advances and B serves.
  {
    let calls = [];
    const pay = async (url) => { calls.push(url); if (url === A.url) throw err("bad input", 400); return good; };
    const r = await mk(pay, async () => [A, B]).handler({ task: "t", include: "external" }, {});
    ok(calls.length === 2 && r.receipt.seller === B.seller, "a pre-commit 4xx (nothing spent) falls through - the next seller may accept the same params");
  }
  // A REFUSES the payment and the buyer proved on chain it was not charged
  // (committed:false + refused) -> falls through; B was admitted UNPROVEN, so
  // the buyer is told to allow it and the receipt says so (2026-09-02).
  {
    const U = { ...B, unproven: true };
    let calls = [], opts = [];
    const pay = async (url, o) => { calls.push(url); opts.push(o); if (url === A.url) throw err("Seller refused the payment (HTTP 402); chain shows no debit, nothing charged", 502, { committed: false, refused: true }); return good; };
    const r = await mk(pay, async () => [A, U]).handler({ task: "t", include: "external" }, {});
    ok(calls.length === 2 && r.receipt.seller === B.seller, "a chain-verified refusal (committed:false) falls through to the next candidate");
    ok(opts[0].allowUnproven === false && opts[1].allowUnproven === true, "allowUnproven rides to the buyer ONLY for the candidate the resolver admitted unproven");
    ok(r.receipt.sellerProof === "unproven", "the receipt says the serving seller was unproven");
    const r2 = await mk(async () => good, async () => [A]).handler({ task: "t", include: "external" }, {});
    ok(!("sellerProof" in r2.receipt), "a proven seller's receipt carries no such flag");
  }
  // Every candidate fails PRE-commit -> throw the last error, both attempted.
  {
    let calls = [];
    const pay = async (url) => { calls.push(url); throw err("down", 503); };
    let threw = null;
    try { await mk(pay, async () => [A, B]).handler({ task: "t", include: "external" }, {}); } catch (e) { threw = e; }
    ok(calls.length === 2 && threw && threw.statusCode === 503, "all candidates fail pre-commit: both tried, last error thrown");
  }
  // Single candidate (limit-1 legacy shape: resolver returns an object) still works.
  {
    let calls = [];
    const pay = async (url) => { calls.push(url); return good; };
    const r = await mk(pay, async () => A).handler({ task: "t", include: "external" }, {});
    ok(calls.length === 1 && r.receipt.seller === A.seller, "a single resolved object (legacy shape) is paid normally");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
