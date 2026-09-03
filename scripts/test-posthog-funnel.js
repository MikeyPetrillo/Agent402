// PostHog conversion funnel (discovery → paywall_402 → payment_settled) —
// fully offline, two legs:
//
//   1. UNIT — imports src/posthog.js with POSTHOG_TEST_CAPTURE=1 (the test
//      sink: events go to an in-memory array + `[posthog-test]` log lines,
//      never the network) and exercises every capture function directly:
//      event shapes, the paywall_402 rollup (top-slugs + "_other" remainder,
//      counts preserved exactly), the discovery hourly cap, and the
//      tool_error probe suppression regression.
//
//   2. INTEGRATION — boots the real server in PAID mode against a mock
//      facilitator (a local HTTP server answering GET /supported with an
//      exact/eip155:8453 kind, so real 402 challenges build offline — the
//      X402_SYNC_ON_START lesson), then walks the actual funnel:
//      /llms.txt (discovery) → unpaid /api/hash (402) → PoW-paid /api/hash
//      (settlement, rail=pow) and asserts the exact events from the
//      server's [posthog-test] output.
//
//   node scripts/test-posthog-funnel.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

process.env.POSTHOG_TEST_CAPTURE = "1";
const {
  capturePostHogDiscovery,
  capturePostHogPaywall,
  capturePostHogPowChallenge,
  capturePostHogSettlement,
  capturePostHogToolError,
  capturePostHogToolGone,
  capturePostHogToolCall,
  _flushPaywallRollupForTest,
  _testEventsForTest,
} = await import("../src/posthog.js");

let passed = 0, failed = 0;
// PostHog's own control properties ($-prefixed, e.g. $process_person_profile)
// are not caller data: the leak guards below compare the keys WE set.
const ourKeys = (props) => Object.keys(props || {}).filter((k) => !k.startsWith("$")).sort().join(",");
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const events = _testEventsForTest();
const take = () => events.splice(0, events.length); // read + clear

// --- unit: discovery ------------------------------------------------------------
capturePostHogDiscovery({ surface: "llms.txt", synthetic: false });
ok(take().length === 0, "discovery accumulates silently (rolled up, no event before flush)");
_flushPaywallRollupForTest();
let got = take();
ok(got.length === 1 && got[0].event === "discovery" && got[0].properties.surface === "llms.txt" && got[0].properties.synthetic === false && got[0].properties.count === 1,
  "discovery event carries surface + synthetic + count");
ok(ourKeys(got[0].properties) === "count,surface,synthetic",
  "discovery properties are exactly {count, surface, synthetic} — nothing about the caller");

// --- unit: paywall rollup -------------------------------------------------------
for (let i = 0; i < 3; i++) capturePostHogPaywall({ slug: "hash", priceUsd: 0.001, powEligible: true, synthetic: false });
capturePostHogPaywall({ slug: "screenshot", priceUsd: 0.01, powEligible: false, synthetic: false });
capturePostHogPaywall({ slug: "hash", priceUsd: 0.001, powEligible: true, synthetic: true }); // synthetic bucket is separate
ok(take().length === 0, "paywall captures accumulate silently (no events before flush)");
_flushPaywallRollupForTest();
got = take();
const byKey = new Map(got.map((e) => [`${e.properties.slug}|${e.properties.synthetic ? 1 : 0}`, e.properties]));
ok(got.length === 3 && got.every((e) => e.event === "paywall_402"), `flush emits one paywall_402 per (slug, synthetic) pair (got ${got.length})`);
ok(byKey.get("hash|0")?.count === 3 && byKey.get("hash|0")?.powEligible === true, "counts aggregate per slug");
ok(byKey.get("hash|1")?.count === 1, "synthetic 402s roll up separately");
ok(byKey.get("screenshot|0")?.count === 1 && byKey.get("screenshot|0")?.priceUsd === 0.01, "price rides along");
ok(byKey.get("hash|0")?.attempt === "none", "402 with no payment header rolls up as attempt=none");

// The WHY behind a refused payment (src/payment-reject.js). Added 2026-08-30
// with that classifier: without this, the rollup could silently stop carrying
// the reason and the only symptom would be a diagnosis that quietly went blank
// - the same shape of failure the classifier exists to end.
capturePostHogPaywall({ slug: "render", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed", reason: "amount-below-price" });
capturePostHogPaywall({ slug: "render", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed", reason: "amount-below-price" });
capturePostHogPaywall({ slug: "render", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed", reason: "authorization-expired" });
capturePostHogPaywall({ slug: "render", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed" });
// A reason is only ever meaningful for a payment that was actually tried.
capturePostHogPaywall({ slug: "render", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "none", reason: "amount-below-price" });
_flushPaywallRollupForTest();
const rr = take().filter((e) => e.properties.slug === "render");
const byReason = new Map(rr.map((e) => [`${e.properties.attempt}|${e.properties.reason ?? "-"}`, e.properties]));
ok(byReason.get("usdc_failed|amount-below-price")?.count === 2, `identical reasons aggregate (got ${byReason.get("usdc_failed|amount-below-price")?.count})`);
ok(byReason.get("usdc_failed|authorization-expired")?.count === 1, "different reasons roll up separately, so the split is readable");
ok(byReason.get("usdc_failed|-")?.count === 1,
  "a refused payment we could not diagnose carries no reason, and does not merge with the ones we could");
ok(byReason.get("none|-")?.count === 1, "a 402 with no payment at all stays its own bucket");
ok(rr.every((e) => e.properties.reason === undefined || typeof e.properties.reason === "string"),
  "reason is a string or absent - never an object that could carry caller text");
ok(!rr.some((e) => e.properties.attempt === "none" && e.properties.reason),
  "attempt=none never carries a reason: nothing was tried, so there is nothing to explain");
_flushPaywallRollupForTest();
ok(take().length === 0, "empty rollup flush emits nothing");

// --- unit: attempt dimension splits couldn't-pay from wouldn't-pay ---------------
capturePostHogPaywall({ slug: "search", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "none" });
capturePostHogPaywall({ slug: "search", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed" });
capturePostHogPaywall({ slug: "search", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "usdc_failed" });
capturePostHogPaywall({ slug: "search", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "pow_failed" });
_flushPaywallRollupForTest();
got = take().filter((e) => e.properties.slug === "search");
const byAttempt = new Map(got.map((e) => [e.properties.attempt, e.properties.count]));
ok(got.length === 3, `same slug splits into one event per attempt (got ${got.length})`);
ok(byAttempt.get("none") === 1 && byAttempt.get("usdc_failed") === 2 && byAttempt.get("pow_failed") === 1,
  `attempt buckets counted independently (none=${byAttempt.get("none")}, usdc_failed=${byAttempt.get("usdc_failed")}, pow_failed=${byAttempt.get("pow_failed")})`);
capturePostHogPaywall({ slug: "search", priceUsd: 0.02, powEligible: false, synthetic: false, attempt: "bogus" });
_flushPaywallRollupForTest();
ok(take().find((e) => e.properties.slug === "search")?.properties.attempt === "none", "unknown attempt value normalizes to none");

// --- unit: pow_challenge rollup (free-tier issuance) -----------------------------
for (let i = 0; i < 4; i++) capturePostHogPowChallenge({ slug: "hash", synthetic: false });
capturePostHogPowChallenge({ slug: "qr", synthetic: false });
capturePostHogPowChallenge({ slug: "hash", synthetic: true });
ok(take().length === 0, "pow_challenge captures accumulate silently until flush");
_flushPaywallRollupForTest();
got = take().filter((e) => e.event === "pow_challenge");
const pc = new Map(got.map((e) => [`${e.properties.slug}|${e.properties.synthetic ? 1 : 0}`, e.properties.count]));
ok(pc.get("hash|0") === 4 && pc.get("qr|0") === 1 && pc.get("hash|1") === 1,
  `pow_challenge rolls up per (slug, synthetic) (hash=${pc.get("hash|0")}, qr=${pc.get("qr|0")}, hash-synth=${pc.get("hash|1")})`);
ok(got.every((e) => ourKeys(e.properties) === "count,slug,synthetic"),
  "pow_challenge properties are exactly {slug, count, synthetic} — no caller identity");

// --- unit: rollup "_other" remainder keeps the exact total -----------------------
for (let i = 0; i < 60; i++) {
  for (let n = 0; n <= i % 3; n++) capturePostHogPaywall({ slug: `slug-${i}`, priceUsd: 0.001, powEligible: true, synthetic: false });
}
const expectedTotal = Array.from({ length: 60 }, (_, i) => (i % 3) + 1).reduce((a, b) => a + b, 0);
_flushPaywallRollupForTest();
got = take();
ok(got.length === 51, `60 slugs flush as top-50 + one _other (got ${got.length})`);
ok(got.some((e) => e.properties.slug === "_other"), "_other remainder event present");
const total = got.reduce((s, e) => s + e.properties.count, 0);
ok(total === expectedTotal, `sum(count) is the exact 402 total — nothing sampled away (${total} = ${expectedTotal})`);

// --- unit: settlement ------------------------------------------------------------
capturePostHogSettlement({ slug: "hash", rail: "usdc", network: "eip155:8453", priceUsd: 0.001, synthetic: false });
capturePostHogSettlement({ slug: "hash", rail: "pow", network: null, priceUsd: 0.001, synthetic: false });
got = take();
ok(got.length === 2 && got.every((e) => e.event === "payment_settled"), "settlements are per-event, never rolled up");
ok(got[0].properties.rail === "usdc" && got[0].properties.network === "eip155:8453", "USDC settlement carries the chain");
ok(got[1].properties.rail === "pow" && got[1].properties.network === null, "PoW settlement has no chain");
ok(ourKeys(got[0].properties) === "network,paid,priceUsd,rail,slug,synthetic",
  "settlement properties are exactly {slug, rail, network, priceUsd, paid, synthetic} — no payer identity");

// `paid` is the fix for a real misreading, so assert the distinction it draws
// rather than just its presence. `synthetic` means OUR OWN traffic, NOT free:
// a proof-of-work call is genuine external demand served for nothing, so it is
// synthetic=false AND paid=false. Filtering on `synthetic` alone therefore
// counts free traffic as revenue — measured 2026-08-06, that was 388 free
// against 385 paid over a week, i.e. slightly over 2x, and three saved
// dashboards were reading that way.
ok(got[0].properties.paid === true, "a USDC settlement is paid=true");
ok(got[1].properties.paid === false, "a proof-of-work call is paid=FALSE — served, but no money moved");
ok(got[1].properties.synthetic === false && got[1].properties.paid === false,
  "free is NOT synthetic: external PoW demand is synthetic=false yet paid=false (the exact confusion this property removes)");
ok(got[1].properties.priceUsd === 0.001,
  "a free call KEEPS its list price (the free-tier subsidy metric) — `paid` is what makes revenue sums honest, not a zeroed price");

// Every rail the gate can accept must land on one side of the paid split, so a
// rail added later cannot default into "revenue" unnoticed.
for (const [rail, expected] of [["usdc", true], ["marketplace", true], ["pow", false], ["trial", false], ["heartbeat", false]]) {
  capturePostHogSettlement({ slug: "hash", rail, network: null, priceUsd: 0.001, synthetic: false });
  const [e] = take();
  ok(e.properties.paid === expected, `rail "${rail}" is paid=${expected}`);
}

// --- unit: settlement clientUa (SDK attribution, product token only) --------------
capturePostHogSettlement({ slug: "hash", rail: "usdc", network: "eip155:8453", priceUsd: 0.001, synthetic: false, clientUa: "agent402-client/0.6.1" });
capturePostHogSettlement({ slug: "hash", rail: "pow", network: null, priceUsd: 0, synthetic: false, clientUa: "x".repeat(80) });
got = take();
ok(got[0].properties.clientUa === "agent402-client/0.6.1",
  "settlement carries the caller's UA product token when provided (clientUa)");
ok(got[1].properties.clientUa === "x".repeat(40),
  `clientUa is hard-capped at 40 chars (got ${got[1].properties.clientUa?.length})`);

// --- unit: tool_error probe suppression still holds through the sink refactor ----
capturePostHogToolError({ slug: "hash", status: 400, message: "x", shape: [], synthetic: false, probe: true });
ok(take().length === 0, "probe tool_errors stay suppressed (regression lock)");
capturePostHogToolError({ slug: "hash", status: 500, message: "x", shape: ["b:url"], synthetic: false, probe: false });
got = take();
ok(got.length === 1 && got[0].event === "tool_error" && got[0].properties.errorClass === "5xx", "real tool_errors still captured");

// --- unit: discovery rollup (the 2026-08-25 scanner: 57k /api/find calls in a day) ---
for (let i = 0; i < 1200; i++) capturePostHogDiscovery({ surface: "find", synthetic: false });
capturePostHogDiscovery({ surface: "find", synthetic: true });
ok(take().length === 0, "1,201 discovery hits produce no events before the flush");
_flushPaywallRollupForTest();
got = take().filter((e) => e.event === "discovery");
const findRow = got.find((e) => e.properties.surface === "find" && e.properties.synthetic === false);
ok(got.length === 2 && findRow?.count !== 0 && findRow?.properties.count === 1200,
  `1,200 find hits flush as ONE discovery event with count 1200 (+1 synthetic row; got ${got.length} events, count ${findRow?.properties.count})`);

// --- unit: _find / _route tool_call rollup; real slugs stay per-event -------------
for (let i = 0; i < 5; i++) capturePostHogToolCall({ slug: "_find", latencyMs: 10 + i, cached: i < 3, errored: false, status: 200, synthetic: false });
capturePostHogToolCall({ slug: "_route", latencyMs: 700, cached: false, errored: false, status: 200, synthetic: false });
capturePostHogToolCall({ slug: "hash", latencyMs: 2, cached: false, errored: false, status: 200, synthetic: false });
got = take();
ok(got.length === 1 && got[0].event === "tool_call" && got[0].properties.slug === "hash" && !("count" in got[0].properties),
  "a real tool call is still one per-event tool_call (no count field)");
_flushPaywallRollupForTest();
got = take().filter((e) => e.event === "tool_call");
const findCached = got.find((e) => e.properties.slug === "_find" && e.properties.cached === true);
const findMiss = got.find((e) => e.properties.slug === "_find" && e.properties.cached === false);
const routeRow = got.find((e) => e.properties.slug === "_route");
ok(got.length === 3 && findCached?.properties.count === 3 && findMiss?.properties.count === 2 && routeRow?.properties.count === 1,
  `_find/_route roll up per (slug, cached): got ${got.length} rows, _find cached ${findCached?.properties.count} miss ${findMiss?.properties.count} _route ${routeRow?.properties.count}`);
ok(findCached?.properties.latencyMs === 11 && findMiss?.properties.latencyMs === 14,
  `rolled-up latencyMs is the window average (cached ${findCached?.properties.latencyMs}, miss ${findMiss?.properties.latencyMs})`);

// --- unit: tool_gone rollup (scanners walk all ~970 retired routes daily) --------
for (let r = 0; r < 60; r++) for (let i = 0; i <= r % 3; i++) capturePostHogToolGone({ route: `/api/convert/unit${r}-to-other`, replacement: "POST /api/unit-convert" });
ok(take().length === 0, "tool_gone accumulates silently");
_flushPaywallRollupForTest();
got = take().filter((e) => e.event === "tool_gone");
const goneOther = got.find((e) => e.properties.route === "_other");
const goneTotal = got.reduce((s, e) => s + e.properties.count, 0);
ok(got.length === 51 && goneOther?.properties.routes === 10 && goneTotal === 120,
  `60 retired routes flush as 50 rows + one _other (10 routes) with the exact total (got ${got.length} rows, other routes ${goneOther?.properties.routes}, total ${goneTotal})`);

// --- integration: the real funnel through a paid-mode server ----------------------
const FAC_PORT = 3082, PORT = 3081, B = `http://127.0.0.1:${PORT}`;
// Mock facilitator: /supported advertises the exact scheme on Base so the
// middleware's kind sync succeeds and real 402 challenges build offline.
const facilitator = createServer((req, res) => {
  if (req.url.startsWith("/supported")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    X402_SYNC_ON_START: "true", // the kind sync MUST run for 402s to build
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
    FREE_MODE: "",
    POSTHOG_TEST_CAPTURE: "1",
    POSTHOG_PAYWALL_FLUSH_MS: "1000", // flush fast so the test can observe it
    SALES_LEDGER_DB: `/tmp/a402-funnel-sales-${process.pid}.db`, // isolated ledger for the /api/sales assertion
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout.on("data", (d) => { serverLog += d; });
proc.stderr.on("data", (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const solve = (c) => { let n = 0; while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++; return n; };

try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/api/pow`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "paid-mode server booted against the mock facilitator");

  // Stage 1: discovery. DRAIN each body before asserting: the server captures
  // discovery from res.on("finish"), which only fires once the response has
  // actually been written out — and an unread body leaves the response
  // half-consumed, so "finish" can lag past this test's observation window.
  // /llms.txt (~107 KB) happened to win that race while /api/pricing (~258 KB)
  // did not, which is why the pricing assertion failed only on CI runners and
  // only as the catalog grew. Reading the body makes both deterministic.
  const llms = await fetch(`${B}/llms.txt`);
  await llms.text();
  ok(llms.ok, "GET /llms.txt serves");
  const pricing = await fetch(`${B}/api/pricing`);
  await pricing.text();
  ok(pricing.ok, "GET /api/pricing serves");

  // Stage 2: an unpaid catalog call must get a REAL 402 (not a 500 — that
  // would mean the kind sync failed, the exact bug the wallet E2E hit).
  const unpaid = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  ok(unpaid.status === 402, `unpaid catalog call answers 402 (got ${unpaid.status})`);

  // Stage 3: settle via proof-of-work and get the result.
  const c = await (await fetch(`${B}/api/pow/challenge?slug=hash`)).json();
  const paid = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": `${c.token}:${solve(c)}` },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(paid.status === 200 && (await paid.json()).hex.slice(0, 8) === "b94d27b9", "PoW-paid call settles and answers");

  await sleep(1800); // let the paywall rollup flush (1s window) + finish hooks run

  const captured = serverLog.split("\n")
    .filter((l) => l.includes("[posthog-test]"))
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
    .filter(Boolean);
  const of = (name) => captured.filter((e) => e.event === name);

  const disc = of("discovery").map((e) => e.properties.surface);
  ok(disc.includes("llms.txt") && disc.includes("pricing"), `server captured discovery for llms.txt + pricing (got: ${disc.join(", ")})`);
  const pw = of("paywall_402").find((e) => e.properties.slug === "hash");
  ok(Boolean(pw) && pw.properties.count >= 1 && pw.properties.powEligible === true,
    `server captured the 402 rollup for hash (count ${pw?.properties.count})`);
  ok(pw?.properties.attempt === "none",
    `the unpaid 402 is classified attempt=none — no payment header was sent (got ${pw?.properties.attempt})`);
  const chal = of("pow_challenge").find((e) => e.properties.slug === "hash");
  ok(Boolean(chal) && chal.properties.count >= 1,
    `server captured a pow_challenge issuance for hash (count ${chal?.properties.count})`);
  const settled = of("payment_settled");
  ok(settled.length === 1 && settled[0].properties.slug === "hash" && settled[0].properties.rail === "pow",
    `exactly one settlement, slug=hash rail=pow (got ${settled.length}: ${JSON.stringify(settled.map((e) => e.properties))})`);
  ok(!captured.some((e) => JSON.stringify(e).match(/userAgent|"ip"|remoteAddr|x-forwarded/i)),
    "no caller identity in any captured event");

  // Sales ledger rides the same settle hook: the PoW purchase above must be
  // one named row, served by the free /api/sales endpoint.
  const sales = await (await fetch(`${B}/api/sales`)).json();
  ok(sales.totals?.byRail?.["external:pow"] === 1, `sales ledger recorded the PoW sale by name (byRail: ${JSON.stringify(sales.totals?.byRail)})`);
  ok(sales.totals?.external?.revenueUsd === 0, "free-tier sale adds usage, not revenue");
} catch (e) {
  ok(false, `integration leg threw: ${e.message}`);
} finally {
  proc.kill("SIGKILL");
  facilitator.close();
}

// 3. ENV GUARD — initPostHog must refuse a dev/test boot even with a key
// present (the 2026-07-13 incident: a local sweep with a copied .env put a
// burst of "not configured" tool_errors in prod telemetry). Docker sets
// NODE_ENV=production (verified: railway.toml builder=DOCKERFILE →
// Dockerfile ENV), so every real deployment activates; POSTHOG_FORCE=true is
// the bare-metal escape hatch. Fresh subprocess per combo — module state
// caches the decision.
{
  const initWith = (env) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e",
      'const m = await import(new URL("../src/posthog.js", "file://" + process.cwd() + "/scripts/").href); console.log(JSON.stringify(m.initPostHog()))'],
      { env: { PATH: process.env.PATH, ...env }, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ ok: null, raw: out }); } });
  });
  const FAKE = { POSTHOG_API_KEY: "phc_test_not_a_real_key" };
  const dev = await initWith({ ...FAKE });
  ok(dev.ok === false && /non-production/.test(dev.reason || ""), `key present but NODE_ENV unset → disabled (got ${JSON.stringify(dev)})`);
  const prod = await initWith({ ...FAKE, NODE_ENV: "production" });
  ok(prod.ok === true, `key + NODE_ENV=production → enabled (got ${JSON.stringify(prod)})`);
  const forced = await initWith({ ...FAKE, POSTHOG_FORCE: "true" });
  ok(forced.ok === true, `key + POSTHOG_FORCE=true overrides a non-prod NODE_ENV (got ${JSON.stringify(forced)})`);
  const nokey = await initWith({ NODE_ENV: "production" });
  ok(nokey.ok === false && nokey.reason === "no-key", `no key stays a no-op regardless of NODE_ENV (got ${JSON.stringify(nokey)})`);
}

// ---- verify_failed: reason + chain + path, never the payer, capped per hour (2026-08-28) ----
{
  const { capturePostHogVerifyFailed, _testEventsForTest } = await import("../src/posthog.js");
  const before = _testEventsForTest().filter((e) => e.event === "verify_failed").length;
  capturePostHogVerifyFailed({ network: "eip155:8453", scheme: "exact", resource: "https://agent402.tools/api/x402-trending?x=1", errorReason: "invalid_exact_evm_payload_authorization_value_insufficient", synthetic: false });
  const ev = _testEventsForTest().filter((e) => e.event === "verify_failed").pop();
  ok(ev && ev.properties.network === "eip155:8453" && ev.properties.scheme === "exact" && ev.properties.path === "/api/x402-trending" && /insufficient/.test(ev.properties.errorReason) && !("payer" in ev.properties), "verify_failed carries chain, scheme, route path and reason - no payer, no query string");
  for (let i = 0; i < 400; i++) capturePostHogVerifyFailed({ network: "eip155:8453", scheme: "exact", resource: "https://agent402.tools/api/random", errorReason: "x" });
  const after = _testEventsForTest().filter((e) => e.event === "verify_failed").length;
  ok(after - before <= 300, `verify_failed is capped per hour (${after - before} of 401 captured)`);
}

// ---- wrong_method: the 405 dead end is counted (2026-08-28) ----
{
  const { capturePostHogWrongMethod, _testEventsForTest } = await import("../src/posthog.js");
  capturePostHogWrongMethod({ path: "/api/search", method: "POST", allow: ["GET"], ua: "axios/1.14.0 (foo)" });
  const ev = _testEventsForTest().filter((e) => e.event === "wrong_method").pop();
  ok(ev && ev.properties.path === "/api/search" && ev.properties.method === "POST" && ev.properties.allow === "GET" && ev.properties.uaFamily === "axios", "wrong_method carries path, method, allow and the UA family only");
}

// Server events are ANONYMOUS (2026-08-28): person processing bills at about
// five times the anonymous rate once the free allowance is spent, and the one
// constant-id profile carried no signal (every query here reads event
// properties). Every captured event must say so.
{
  const evs = _testEventsForTest();
  const missing = evs.filter((e) => e?.properties?.$process_person_profile !== false);
  ok(evs.length > 0 && missing.length === 0, `every server event carries $process_person_profile:false (${evs.length} events, ${missing.length} missing${missing.length ? ": " + missing.slice(0, 3).map((e) => e.event).join(",") : ""})`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
