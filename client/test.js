// agent402-client tested against a server with the x402 paywall ACTIVE, so the
// client really exercises the proof-of-work auto-payment path. The facilitator
// is never contacted (X402_SYNC_ON_START=false); PoW bypasses settlement.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent402, OutputValidationError, withNetworkPreference, withPayeeAllowlist, NETWORK_CAIP2 } from "./index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3081;
const proc = spawn("node", ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// Offline: withNetworkPreference pins the settlement chain (e.g. USDG on
// Robinhood Chain) on any duck-typed x402 client - no @x402 dependency here.
{
  ok(NETWORK_CAIP2.robinhood === "eip155:4663", "NETWORK_CAIP2 knows robinhood -> eip155:4663");
  const accepts = [{ network: "eip155:8453", a: "base" }, { network: "eip155:4663", a: "usdg" }];
  const seen = [];
  const fake = { createPaymentPayload: (pr) => { seen.push(pr.accepts.map((x) => x.a)); return "ok"; } };
  withNetworkPreference(fake, ["robinhood"]);
  ok(fake.createPaymentPayload({ accepts }) === "ok", "wrapped client delegates");
  ok(JSON.stringify(seen[0]) === '["usdg"]', "preference filters accepts to the pinned chain");
  let threw = false;
  const none = { createPaymentPayload: () => "x" };
  withNetworkPreference(none, ["eip155:1"]);
  try { none.createPaymentPayload({ accepts }); } catch { threw = true; }
  ok(threw, "no-match preference throws before paying");
  const untouched = { createPaymentPayload: (pr) => pr.accepts.length };
  withNetworkPreference(untouched, []);
  ok(untouched.createPaymentPayload({ accepts }) === 2, "empty preference leaves the client untouched");
}

// Offline: withPayeeAllowlist refuses a 402 whose payTo is not allowlisted -
// the buyer-side "who gets paid" control (filters accepts before any signature).
{
  const calls = [];
  const fake = { createPaymentPayload: async (pr) => { calls.push(pr); return { ok: true }; } };
  withPayeeAllowlist(fake, ["0xABCDEF0000000000000000000000000000000001"]);
  await fake.createPaymentPayload({ accepts: [
    { network: "eip155:8453", payTo: "0xabcdef0000000000000000000000000000000001" },
    { network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" },
  ] });
  if (calls.length !== 1 || calls[0].accepts.length !== 1 || calls[0].accepts[0].payTo !== "0xabcdef0000000000000000000000000000000001") { console.error("FAIL: withPayeeAllowlist should keep only the allowlisted payee (case-insensitive 0x)"); process.exit(1); }
  let refused = null;
  try { await fake.createPaymentPayload({ accepts: [{ network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" }] }); } catch (e) { refused = e; }
  if (!refused || !/payee allowlist refused/.test(refused.message)) { console.error("FAIL: withPayeeAllowlist must refuse a quote with no allowlisted payee"); process.exit(1); }
  let empty = null; try { withPayeeAllowlist({ createPaymentPayload: async () => {} }, []); } catch (e) { empty = e; }
  if (!empty) { console.error("FAIL: withPayeeAllowlist with no payees must throw"); process.exit(1); }
  console.log("ok - withPayeeAllowlist filters accepts to allowlisted payees and refuses otherwise");
}
// Offline: buyer spending caps refuse to overpay BEFORE signing (defends the
// x402 "wallet drain via uncapped spending" failure mode). No server needed  - 
// stub the catalog and a paying fetch.
{
  const okResp = { ok: true, json: async () => ({ ok: true }) };
  const mk = (opts) => {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { paid++; return okResp; },     // x402 payFetch (wallet-only path)
      fetchImpl: async () => okResp,                       // plain fetch (unused; catalog is stubbed)
      ...opts,
    });
    c._catalog = new Map([
      ["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }],
      ["pricey", { method: "POST", path: "/api/pricey", computePayable: false, price: "$1.00" }],
    ]);
    return { c, paid: () => paid };
  };

  // per-call cap refuses an over-price tool before any payment
  {
    const { c, paid } = mk({ maxPerCallUsd: 0.05 });
    let e = null; try { await c.call("pricey"); } catch (err) { e = err; }
    ok(e && e.name === "SpendingLimitError" && e.limit === "maxPerCallUsd", "maxPerCallUsd blocks an over-price tool");
    ok(paid() === 0, "blocked call never paid (refused before signing)");
    await c.call("cheap");
    ok(paid() === 1, "under-cap tool pays normally");
    ok(c.spendingSummary().dailyUsd === 0.01, "settled spend is recorded");
  }

  // daily cap sums across calls and blocks the one that would cross it
  {
    const { c, paid } = mk({ dailyLimitUsd: 0.025 });
    await c.call("cheap"); await c.call("cheap"); // 0.02 total
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "dailyLimitUsd", "dailyLimitUsd blocks the call that would cross the ceiling");
    ok(paid() === 2, "exactly the two under-budget calls paid");
  }

  // per-host cap bounds spend to a single seller host
  {
    const { c } = mk({ maxPerHostUsd: 0.015 });
    await c.call("cheap");
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "maxPerHostUsd", "maxPerHostUsd bounds per-seller spend");
  }

  // no caps configured → behavior unchanged (pays regardless of price)
  {
    const { c, paid } = mk({});
    await c.call("pricey");
    ok(paid() === 1, "no caps → default behavior, pays any price");
  }

  // a failed paid call does NOT count against the budget (commit only on settle)
  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false, dailyLimitUsd: 0.05,
      fetch: async () => { paid++; return { ok: false, status: 500 }; },
      fetchImpl: async () => okResp,
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let failed = false; try { await c.call("cheap"); } catch { failed = true; }
    ok(failed && paid === 1, "a failed paid call throws");
    ok(c.spendingSummary().dailyUsd === 0, "a failed paid call does not count against the budget");
  }
}

// Offline: caller-supplied output validators bind buyer intent without a peer
// dependency. Validation happens before cache admission, contracted cache hits
// are revalidated, and settled spend survives invalid delivery.
{
  const bodyResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  const paidClient = ({ outputValidator, creditsKey } = {}) => {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example",
      outputValidator,
      creditsKey,
      fetch: creditsKey ? undefined : async () => { paid++; return bodyResponse({ value: 42 }); },
      fetchImpl: async () => { paid++; return bodyResponse({ value: 42 }); },
    });
    c._catalog = new Map([["answer", { method: "POST", path: "/answer", computePayable: false, price: "$0.01" }]]);
    return { c, paid: () => paid };
  };

  // Invalid controls fail before catalog/network work.
  {
    let touched = 0;
    const c = new Agent402({ fetchImpl: async () => { touched++; return bodyResponse({}); } });
    let err = null;
    try { await c.call("answer", {}, { outputValidator: { id: "", validate: () => true } }); } catch (e) { err = e; }
    ok(err instanceof TypeError && touched === 0 && c._catalog === null,
      "invalid per-call outputValidator fails before catalog or network access");
  }

  // A buyer-owned validator is caller code we AWAIT inside call(), and on a paid
  // route the money has already moved by the time it runs - so one that never
  // settles would hang the call forever holding a paid-but-undelivered result.
  // Bounded, and a timeout REJECTS: an unfinished contract is not a satisfied one.
  {
    const c = new Agent402({ fetchImpl: async () => ({}) });
    const started = Date.now();
    let err = null;
    try { await c._assertOutput("slow", { a: 1 }, { id: "hangs/v1", validate: () => new Promise(() => {}), timeoutMs: 200 }, { paid: true }); } catch (e) { err = e; }
    ok(err?.name === "OutputValidationError", `a validator that never settles rejects rather than hanging (got ${err?.name})`);
    ok(err?.paid === true, "and still reports the call WAS paid, so the buyer knows money moved");
    ok(Date.now() - started < 2000, `it gives up promptly (${Date.now() - started}ms)`);
    ok(!!(await c._assertOutput("ok", { a: 1 }, { id: "fine/v1", validate: () => true })), "a normal validator is unaffected");
    ok(!!(await c._assertOutput("ok", { a: 1 }, { id: "slowish/v1", validate: () => new Promise((r) => setTimeout(() => r(true), 30)) })),
      "a slow but finishing validator still passes - the bound is a ceiling, not a race");
  }

  // A valid paid result is admitted and namespaced by its semantic id.
  {
    const { c, paid } = paidClient({ outputValidator: { id: "answer-number/v1", validate: (v) => v.value === 42 } });
    const first = await c.call("answer");
    const second = await c.call("answer");
    ok(first === second && paid() === 1, "valid contracted paid result is cached under its contract identity");
  }

  // A different id never consumes the first contract's cache entry.
  {
    const { c, paid } = paidClient();
    await c.call("answer", {}, { outputValidator: { id: "answer/v1", validate: () => true } });
    await c.call("answer", {}, { outputValidator: { id: "answer/v2", validate: () => true } });
    ok(paid() === 2 && c._cache.size === 2, "different validator ids have disjoint cache entries");
  }

  // Mutating a returned object cannot turn a cache hit into invalid success.
  {
    const validator = { id: "answer-number/v1", validate: (v) => v.value === 42 };
    const { c, paid } = paidClient({ outputValidator: validator });
    const first = await c.call("answer");
    first.value = "wrong";
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.cacheHit && !err.paid,
      "mutated contracted cache hit is rejected and labelled as an unpaid cache hit");
    ok(paid() === 1 && c._cache.size === 0, "invalid cache hit is evicted without another payment");
  }

  // Validation failure occurs after HTTP success and must not erase settled spend.
  {
    const { c, paid } = paidClient({ outputValidator: { id: "answer-impossible/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid && err.contractId === "answer-impossible/v1",
      "false validator result is failed paid delivery with contract identity");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01,
      "invalid paid delivery remains in settled-spend accounting");
    ok(c._cache.size === 0, "invalid paid delivery is never cached");
  }

  // Async callbacks and thrown validation errors have the same fail-closed path.
  {
    const { c } = paidClient({ outputValidator: { id: "async/v1", validate: async () => { throw new Error("bad shape"); } } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.cause?.message === "bad shape" && err.paid,
      "async validator exceptions are wrapped without losing paid-delivery state");
  }

  // Credits are another settled paid path and retain spend on invalid output.
  {
    const creditsKey = `a402_${"A".repeat(32)}`;
    const { c } = paidClient({ creditsKey, outputValidator: { id: "credits/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid && c.spendingSummary().dailyUsd === 0.01,
      "credits-paid invalid delivery retains settled spend and fails closed");
  }

  // Null cannot silently weaken an inherited constructor validator.
  {
    const { c } = paidClient({ outputValidator: { id: "deny/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer", {}, { outputValidator: null }); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid,
      "per-call null preserves the inherited constructor validator");
  }
}

// Offline (#1126): the default Idempotency-Key survives an AGENT-LEVEL retry.
// A lost response is retried one level up - the framework calls call() again -
// so the key must be stable across call() invocations on one client, fresh per
// invocation only when the caller opted out of caching, and distinct between
// client instances. Driven on the credits path, where the server binds the key
// to the credits key hash and replays the paid answer (the wallet path signs a
// fresh authorization per call() and is documented as a new payment).
{
  const creditsKey = `a402_${"B".repeat(32)}`;
  const mk = () => {
    const keys = [];
    let n = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example",
      creditsKey,
      fetchImpl: async (url, init) => {
        keys.push(init.headers["Idempotency-Key"]);
        // First send: the response is LOST after the server has charged.
        if (++n === 1) throw new Error("socket hang up");
        return { ok: true, status: 200, json: async () => ({ value: 7 }) };
      },
    });
    c._catalog = new Map([["answer", { method: "POST", path: "/answer", computePayable: false, price: "$0.01" }]]);
    return { c, keys };
  };
  {
    const { c, keys } = mk();
    let lost = false;
    try { await c.call("answer", { q: 1 }); } catch { lost = true; }
    const out = await c.call("answer", { q: 1 }); // the framework's retry
    ok(lost && out.value === 7 && keys.length === 2 && keys[0] === keys[1] && /^a402-[0-9a-f]{24}$/.test(keys[0]),
      "a retried call() after a lost response reuses the same default Idempotency-Key");
    const other = await c.call("answer", { q: 2 });
    ok(other.value === 7 && keys[2] !== keys[0], "different params on the same client get a different key");
  }
  {
    const { c, keys } = mk();
    try { await c.call("answer", { q: 1 }, { cache: false }); } catch { /* lost */ }
    await c.call("answer", { q: 1 }, { cache: false });
    ok(keys[0] !== keys[1], "{ cache: false } means distinct purchases: a fresh key per invocation");
  }
  {
    const { c, keys } = mk();
    try { await c.call("answer", { q: 1 }, { idempotencyKey: "mine-1" }); } catch { /* lost */ }
    await c.call("answer", { q: 1 }, { idempotencyKey: "mine-1" });
    ok(keys[0] === "mine-1" && keys[1] === "mine-1", "an explicit idempotencyKey always wins");
  }
  {
    const a = mk(), b = mk();
    try { await a.c.call("answer", { q: 1 }); } catch { /* lost */ }
    try { await b.c.call("answer", { q: 1 }); } catch { /* lost */ }
    ok(a.keys[0] !== b.keys[0], "two client instances buying the same thing are two purchases (per-client salt)");
  }
}

// Offline: route() is read-only discovery - exact query encoding, bounded k,
// include/network filters, empty results, non-2xx errors, and no /api/pricing.
{
  const calls = [];
  const routeBody = (task, { k = 5, include = "all", network } = {}) => ({
    query: String(task ?? ""),
    include: include === "external" || include === "local" ? include : "all",
    count: 0,
    sellers: 0,
    results: [],
    ...(network ? { network: String(network) } : {}),
  });
  const mkRoute = () => new Agent402({
    baseUrl: "https://router.example",
    cache: false,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = new URL(url);
      if (u.pathname !== "/api/route") return { ok: false, status: 404, json: async () => ({}) };
      const task = u.searchParams.get("q") ?? "";
      const k = Number(u.searchParams.get("k"));
      const include = u.searchParams.get("include") ?? "all";
      const network = u.searchParams.get("network");
      return { ok: true, json: async () => routeBody(task, { k, include, network }) };
    },
  });

  {
    const c = mkRoute();
    await c.route("screenshot webpage", { k: 3, include: "external", network: "robinhood" });
    ok(calls.length === 1, "route() makes one request");
    const u = new URL(calls[0]);
    ok(u.pathname === "/api/route", "route() hits /api/route");
    ok(u.searchParams.get("q") === "screenshot webpage", "route() encodes task as q");
    ok(u.searchParams.get("k") === "3", "route() encodes bounded k");
    ok(u.searchParams.get("include") === "external", "route() encodes include=external");
    ok(u.searchParams.get("network") === "robinhood", "route() encodes network filter");
    ok(!calls.some((x) => x.includes("/api/pricing")), "route() does not load /api/pricing");
  }

  {
    const c = mkRoute();
    const out = await c.route("", { k: 99, include: "bogus" });
    ok(out.count === 0 && out.results.length === 0, "route() returns empty results for blank task");
    ok(new URL(calls.at(-1)).searchParams.get("k") === "25", "route() caps k at 25");
    ok(new URL(calls.at(-1)).searchParams.get("include") === "all", "route() normalizes unknown include to all");
  }

  {
    const c = mkRoute();
    await c.route("hash", { include: "local" });
    ok(new URL(calls.at(-1)).searchParams.get("include") === "local", "route() passes include=local");
  }

  {
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "busy" }) }),
    });
    let err = null;
    try { await c.route("ocr"); } catch (e) { err = e; }
    ok(err && /route failed: HTTP 503/.test(err.message), "route() throws on non-2xx");
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetch: async () => { paid++; return { ok: true, json: async () => ({}) }; },
      fetchImpl: async (url) => {
        if (String(url).includes("/api/pricing")) return { ok: true, json: async () => ({ endpoints: [] }) };
        return { ok: true, json: async () => ({ query: "x", include: "all", count: 0, sellers: 0, results: [] }) };
      },
    });
    await c.route("summarize pdf");
    ok(paid === 0, "route() does not invoke the payment fetch");
    ok(!c._catalog, "route() does not warm the paid-tool catalog");
  }

  {
    const serverRow = {
      seller: "https://external.example",
      sellerHome: "https://external.example",
      sellerName: "External",
      slug: "render-page",
      name: "render",
      method: "POST",
      route: "/api/render",
      url: "https://external.example/api/render",
      price: "$0.004",
      priceUsd: 0.004,
      executeVia: { tool: "route-execute", price: "$0.01", underlyingPriceUsd: 0.004, routingFeeUsd: 0.006 },
      untrustedContent: true,
      source: "https://external.example",
    };
    const serverBody = {
      query: "screenshot webpage",
      include: "external",
      count: 1,
      sellers: 1,
      results: [serverRow],
      containsUntrustedContent: true,
    };
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetchImpl: async () => ({ ok: true, json: async () => serverBody }),
    });
    const out = await c.route("screenshot webpage", { include: "external" });
    ok(JSON.stringify(out.results[0]) === JSON.stringify(serverRow),
      "route() returns an opaque server-owned result row unchanged (including executeVia)");
  }
}

// Offline: every request the SDK issues carries its own User-Agent product
// token (agent402-client/<version>) - the plain-fetch path AND the x402
// payFetch path that settles real payments - so sellers can attribute paid
// traffic to this SDK (payment_settled.clientUa server-side).
{
  const uas = [];
  const grab = async (_url, init) => { uas.push(init?.headers?.["User-Agent"] ?? null); return { ok: true, json: async () => ({ endpoints: [] }) }; };
  const packageVersion = JSON.parse(readFileSync(join(ROOT, "client/package.json"), "utf8")).version;
  const expectedUa = `agent402-client/${packageVersion}`;
  const c = new Agent402({ baseUrl: "https://seller.example", cache: false, fetch: grab, fetchImpl: grab });
  await c._loadCatalog(); // plain fetch path
  c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
  await c.call("cheap"); // payFetch path
  ok(uas.length >= 2 && uas.every((u) => u === expectedUa),
    `every request carries the current ${expectedUa} product token (got ${JSON.stringify(uas)})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const a = new Agent402({ baseUrl: `http://localhost:${PORT}` });

  // 1. find() resolves a task to the right tool.
  const matches = await a.find("hash text with sha256");
  ok(matches.some((m) => m.slug === "hash"), `find() returns the hash tool (got ${matches.map((m) => m.slug).slice(0, 3).join(",")})`);

  // 2. call() auto-solves the proof-of-work on a paywalled free tool.
  const out = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out.hex && out.hex.slice(0, 8) === "b94d27b9", `call() auto-pays via PoW and returns the result (got ${out.hex?.slice(0, 8)})`);

  // 3. second identical call is served from cache (same reference, no re-solve).
  const out2 = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out2 === out, "identical call is served from cache");

  // 4. cache can be bypassed.
  const out3 = await a.call("hash", { text: "hello world", algo: "sha256" }, { cache: false });
  ok(out3 !== out && out3.hex === out.hex, "cache:false re-fetches but returns the same value");

  // 5. solvePow() produces a valid nonce for a difficulty.
  const sol = Agent402.solvePow({ challenge: "abc", difficulty: 8, token: "t" });
  const nonce = sol.split(":").pop();
  const lz = (b) => { let n = 0; for (const x of b) { if (!x) { n += 8; continue; } n += Math.clz32(x) - 24; break; } return n; };
  ok(lz(createHash("sha256").update(`abc:${nonce}`).digest()) >= 8, "solvePow finds a nonce meeting the difficulty");

  // 6. unknown slug is a clear error.
  let threw = false; try { await a.call("definitely-not-a-tool", {}); } catch { threw = true; }
  ok(threw, "unknown slug throws");

  // 7. findWorkflows() surfaces multi-tool skill packs for task-shaped queries.
  const packs = await a.findWorkflows("security audit");
  ok(packs.some((p) => p.slug === "security-audit"), `findWorkflows("security audit") returns the security-audit pack (got ${packs.map((p) => p.slug).slice(0, 3).join(",")})`);

  // 8. getWorkflowPrompt() returns rendered messages with args substituted in.
  const rendered = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
  const promptText = rendered.messages?.[0]?.content?.text ?? "";
  ok(promptText.includes("stripe.com") && !promptText.includes("{{domain}}"), "getWorkflowPrompt substitutes args into the rendered prompt");

  // 9. topSellers() proxies /api/leaderboard with the right envelope. CI runs
  // before the first chain scan finishes, so results may be empty - but the
  // envelope shape and sort/include echo must be correct regardless.
  const sellers = await a.topSellers({ limit: 5, sort: "calls", include: "all" });
  ok(sellers.sort === "calls" && sellers.include === "all", `topSellers echoes sort+include (got sort=${sellers.sort}, include=${sellers.include})`);
  ok(Array.isArray(sellers.results) && sellers.results.length <= 5, `topSellers honors limit (got ${sellers.results?.length} rows)`);
  ok(typeof sellers.source === "string" && sellers.source.endsWith("/api/leaderboard"), "topSellers links to /api/leaderboard");

  // 10. route() proxies /api/route and preserves executeVia metadata.
  const routed = await a.route("hash text with sha256", { k: 3, include: "all" });
  ok(routed.include === "all" && Array.isArray(routed.results), "route() returns the server envelope");
  ok(typeof routed.count === "number" && routed.count <= 3, "route() honors k against the live server");
  const selfHit = routed.results.find((r) => r.slug === "hash" || r.seller === "self");
  ok(selfHit, "route() ranks a local catalog match");
  if (selfHit?.executeVia) ok(typeof selfHit.executeVia.tool === "string", "route() preserves executeVia.tool");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
