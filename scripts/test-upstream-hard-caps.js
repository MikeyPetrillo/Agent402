// Hard daily ceilings for the pay-as-you-go upstreams (src/upstream-hard-caps.js).
//
// The budgets in src/upstream-budgets.js only alarm. These refuse: a host past
// its ceiling is never called, the caller gets an uncharged 503, and the
// ceiling is read the same way as every other spend guard (0 refuses all,
// `off` disables, malformed reads as the default).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  HARD_CAPS, hardCapOf, takeHardCap, hardCapRefusalForHost, hardCapStatus, _resetHardCaps,
  neverReachedUpstream, releaseHardCap, upstreamRefusedBeforeWork,
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
// --- a unit is a call the upstream may have served ----------------------------
// A call that provably never left this process, or that the upstream refused
// with a 4xx before doing any work, gives its unit back; a 2xx, a 5xx, a
// timeout and a reset all keep theirs.
{
  const used = () => hardCapStatus().upstreams.brave.usedToday;
  const fetchFailed = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  // The release runs on a handler attached to the call's promise: wait for the
  // count to settle rather than for a fixed time.
  const settled = async (want) => { for (let i = 0; i < 200 && used() !== want; i++) await new Promise((r) => setImmediate(r)); return used(); };
  const call = async (opts) => { try { await fetch("https://api.search.brave.com/res/v1/web/search?q=a", opts); } catch { /* the outcome is read from the count */ } };
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "100";
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    inner = async () => { throw fetchFailed(code); };
    await call();
    ok(await settled(0) === 0, `a call that failed with ${code} never reached the upstream and is not counted (used ${used()})`);
  }
  inner = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "ENETUNREACH" })], "all failed"), {}) }); };
  await call();
  ok(await settled(0) === 0, "a connect failure on every address tried is not counted");
  ok(hardCapStatus().upstreams.brave.releasedToday === 7, `the units given back are counted on the operator view (${hardCapStatus().upstreams.brave.releasedToday})`);
  // A signal already aborted when the call is made: nothing is sent.
  const dead = AbortSignal.abort();
  inner = async () => { throw new DOMException("This operation was aborted", "AbortError"); };
  await call({ signal: dead });
  ok(await settled(0) === 0, "a call made on an already-aborted signal is not counted");
  // The same signal carried on a Request object rather than in init.
  await (async () => { try { await fetch(new Request("https://api.search.brave.com/res/v1/web/search?q=a", { signal: dead })); } catch { /* read from the count */ } })();
  ok(await settled(0) === 0, "a Request whose own signal was already aborted is not counted");

  // A 4xx answer is a refusal before any work (a bad request, our key
  // refused, a rate limit): its unit goes back.
  const releasedBefore = hardCapStatus().upstreams.brave.releasedToday;
  for (const status of [400, 401, 402, 403, 404, 408, 413, 422, 429]) {
    inner = async () => new Response("{}", { status });
    await call();
    ok(await settled(0) === 0, `an upstream refusal of ${status} served nothing and is not counted (used ${used()})`);
  }
  ok(hardCapStatus().upstreams.brave.releasedToday === releasedBefore + 9, "each refusal's unit shows as given back on the operator view");
  // The 4xx give-backs are bounded, per caller and per cap, each per hour: a
  // caller who sends inputs the upstream refuses cannot make calls the
  // ceiling never counts. Past a bound the unit is kept.
  {
    const { runAsCallerOf } = await import("../src/dispatch-caller.js");
    const asCaller = (ip, fn) => runAsCallerOf({ ip, headers: {} }, fn);
    _resetHardCaps();
    process.env.HARDCAP_REFUSED_RELEASES_PER_CALLER_HOUR = "3";
    process.env.HARDCAP_REFUSED_RELEASES_PER_HOUR = "5";
    inner = async () => new Response("{}", { status: 400 });
    for (let i = 0; i < 5; i++) await asCaller("198.51.100.1", () => call());
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === 2, `one caller's refused calls give back at most its hourly share; the rest are counted (used ${used()} of 5)`);
    for (let i = 0; i < 3; i++) await asCaller("198.51.100.2", () => call());
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === 3, `the cap's own hourly bound holds across callers (used ${used()}: 2 + 1 of 3)`);
    inner = async () => { throw fetchFailed("ECONNREFUSED"); };
    for (let i = 0; i < 4; i++) await asCaller("198.51.100.1", () => call());
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === 3, `a call that never left this process is still given back past the bound (used ${used()})`);
    ok(hardCapStatus().upstreams.brave.refusedReleasesKept === 3, `the units kept past the bound are counted on the operator view (${hardCapStatus().upstreams.brave.refusedReleasesKept})`);
    // The direct reading, across the hour.
    const { releaseHardCapRefused } = await import("../src/upstream-hard-caps.js");
    _resetHardCaps();
    const H0 = Date.UTC(2026, 10, 23, 10, 5);
    for (let i = 0; i < 4; i++) takeHardCap("brave", H0);
    const got = [0, 1, 2, 3].map(() => releaseHardCapRefused("brave", H0, { caller: "payer:a", now: H0 }));
    ok(got.join() === "true,true,true,false" && hardCapStatus(H0).upstreams.brave.usedToday === 1, `a caller gives back three in the hour, the fourth keeps its unit (${got.join()})`);
    takeHardCap("brave", H0 + 3_600_000);
    ok(releaseHardCapRefused("brave", H0 + 3_600_000, { caller: "payer:a", now: H0 + 3_600_000 }) === true, "the next hour, the same caller gives back again");
    delete process.env.HARDCAP_REFUSED_RELEASES_PER_CALLER_HOUR;
    delete process.env.HARDCAP_REFUSED_RELEASES_PER_HOUR;
    _resetHardCaps();
  }
  // Everything below MAY have been served: each keeps its unit.
  let want = 0;
  for (const status of [200, 201, 204, 302, 500, 502, 503]) {
    inner = async () => new Response(status === 204 ? null : "{}", { status });
    await call(); want++;
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === want, `an upstream answer of ${status} is counted (used ${used()} of ${want})`);
  }
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "EPIPE", "ETIMEDOUT"]) {
    inner = async () => { throw fetchFailed(code); };
    await call(); want++;
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === want, `a call that failed with ${code} may have been read by the upstream and is counted (used ${used()} of ${want})`);
  }
  // A live signal aborted mid-flight (a timeout): the request was on the wire.
  {
    const ac = new AbortController();
    inner = async () => { ac.abort(); throw new DOMException("This operation was aborted", "AbortError"); };
    await call({ signal: ac.signal }); want++;
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    ok(used() === want, `a call aborted after it was made is counted (used ${used()} of ${want})`);
  }
  // Several addresses tried, one of them reset after connecting: counted.
  inner = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "ECONNRESET" })], "all failed") }); };
  await call(); want++;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  ok(used() === want, `a failure on several addresses where one may have been read is counted (used ${used()} of ${want})`);
  inner = async () => { throw new Error("no code at all"); };
  await call(); want++;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  ok(used() === want, "an unclassified failure is counted");

  // The ceiling still holds while calls are in flight: the unit is taken first.
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "2";
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached = 0;
  inner = async () => { reached++; await gate; return new Response("{}"); };
  const inFlight = [call(), call(), call(), call()];
  ok(reached === 2, `with two calls in flight at a ceiling of 2, the third and fourth are refused before the network (reached ${reached})`);
  release(); await Promise.all(inFlight);
  // A refused connection frees its unit for the next call.
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "1";
  inner = async () => { throw fetchFailed("ECONNREFUSED"); };
  await call();
  await settled(0);
  reached = 0;
  inner = async () => { reached++; return new Response("{}"); };
  await call();
  ok(reached === 1, "after a call that never connected, the next call still has its unit");
  await call();
  ok(reached === 1, "and the one after that meets the ceiling");

  // A rate-limited call frees its unit for the next call too.
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "1";
  inner = async () => new Response("{}", { status: 429 });
  await call();
  await settled(0);
  reached = 0;
  inner = async () => { reached++; return new Response("{}"); };
  await call();
  ok(reached === 1, "after a call the upstream refused with 429, the next call still has its unit");
  await call();
  ok(reached === 1, "and the one after that meets the ceiling");

  // The classifier and the release, read directly.
  ok(upstreamRefusedBeforeWork(new Response("{}", { status: 429 })) && !upstreamRefusedBeforeWork(new Response("{}", { status: 200 })) && !upstreamRefusedBeforeWork(new Response("{}", { status: 503 })) && !upstreamRefusedBeforeWork(null) && !upstreamRefusedBeforeWork(new Error("x")), "the refusal classifier: 4xx only, 2xx and 5xx counted, unknown counted");
  ok(neverReachedUpstream(fetchFailed("ENOTFOUND")) && !neverReachedUpstream(fetchFailed("ECONNRESET")) && !neverReachedUpstream(null) && !neverReachedUpstream(new Error("x")), "the classifier reads the cause chain and defaults to counted");
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "5";
  ok(releaseHardCap("brave", T0, T0) === false, "nothing is given back when nothing was taken");
  takeHardCap("brave", T0);
  ok(releaseHardCap("brave", T0, T0 + 86_400_000) === false && hardCapStatus(T0 + 86_400_000).upstreams.brave.usedToday === 0, "a unit taken on an earlier day is not given back to today");
  // Across UTC midnight with a unit taken today too: yesterday's unit is not
  // given back out of today's count.
  takeHardCap("brave", T0 + 86_400_000);
  ok(releaseHardCap("brave", T0, T0 + 86_400_000) === false && hardCapStatus(T0 + 86_400_000).upstreams.brave.usedToday === 1, `a unit taken yesterday leaves today's taken unit counted (used ${hardCapStatus(T0 + 86_400_000).upstreams.brave.usedToday})`);
  ok(releaseHardCap("brave", T0 + 86_400_000, T0 + 86_400_000) === true && hardCapStatus(T0 + 86_400_000).upstreams.brave.usedToday === 0, "control: today's unit is given back on today's release");
  delete process.env.HARDCAP_BRAVE_CALLS;
}
inner = async () => new Response("{}");

globalThis.fetch = realFetch;

// --- the settle point TAKES its unit, never only reads the ceiling -------------
// (src/settle-first.js settleBeforeUpstreamHolding). Two armed runs reach
// their settle points together with one unit left: one takes it and settles;
// the other is refused before its payment is taken. The unit is the run's
// call's own (no second unit taken), and it goes back when the payment does
// not settle or the run ends without using it.
{
  const sf = await import("../src/settle-first.js");
  const { hardCapHold } = await import("../src/upstream-hard-caps.js");
  let current = null;
  sf.setSettleFirstAmbient(() => current);
  const used = () => hardCapStatus().upstreams.brave.usedToday;
  process.env.HARDCAP_BRAVE_CALLS = "1";
  _resetHardCaps();
  let runs = 0, open;
  const gate = new Promise((r) => { open = r; });
  const armed = (run) => { const req = {}; sf.armSettleFirst(req, { run }); return req; };
  const a = armed(async () => { runs++; await gate; }), b = armed(async () => { runs++; await gate; });
  const settleAt = (req) => { try { return Promise.resolve(sf.settleBeforeUpstreamHolding(hardCapHold("brave"), req)); } catch (e) { return Promise.reject(e); } };
  const both = Promise.allSettled([settleAt(a), settleAt(b)]);
  open();
  const [, rb] = await both;
  const eb = rb.status === "rejected" ? rb.reason : null;
  ok(runs === 1 && eb?.hardCap === true && eb.statusCode === 503 && used() === 1,
    `two runs at their settle points with one unit left: one settles, the other is refused before any payment (runs ${runs}, ${eb?.statusCode}, used ${used()})`);
  current = a;
  const aCall = hardCapRefusalForHost("api.search.brave.com");
  current = null;
  const other = hardCapRefusalForHost("api.search.brave.com");
  ok(aCall === null && other?.hardCap === true && used() === 1, `the settled run's call uses the unit its settle point took (no second unit); another call is refused (used ${used()})`);
  sf.disarmSettleFirst(a);
  ok(used() === 1, "a unit the call used stays counted when the run ends");

  _resetHardCaps();
  const c = armed(async () => { throw sf.settleFirstRefusal(null); });
  let ec = null;
  try { await sf.settleBeforeUpstreamHolding(hardCapHold("brave"), c); } catch (e) { ec = e; }
  ok(sf.isSettleFirstRefusal(ec) && used() === 0, `a payment that does not settle gives its unit back (used ${used()})`);

  _resetHardCaps();
  const d = armed(async () => {});
  await sf.settleBeforeUpstreamHolding(hardCapHold("brave"), d);
  const held = used();
  sf.disarmSettleFirst(d);
  ok(held === 1 && used() === 0, `a unit held and never used is given back when the run ends (${held} -> ${used()})`);

  _resetHardCaps();
  const plain = {};
  const r = sf.settleBeforeUpstreamHolding(hardCapHold("brave"), plain);
  ok(r === undefined && used() === 0, "a run the server did not arm takes nothing at the settle point (its call takes its unit as before)");
  sf.setSettleFirstAmbient(null);
  delete process.env.HARDCAP_BRAVE_CALLS;
  _resetHardCaps();
}

console.log(`\ntest-upstream-hard-caps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
