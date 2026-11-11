#!/usr/bin/env node
// Offline test for workers/status-probe — the Cloudflare cron observer.
//
// This Worker decides what /status reports about production, so the failure
// that matters is not "it crashed", it is "it recorded a broken component as
// operational". Every check below drives the real probe() against a stubbed
// fetch and asserts the mapping, including the cases where production answers
// but answers WRONG (a 200 where a 402 is required, a collapsed catalog, a
// rail silently missing from the offer) — the quiet regressions a plain
// reachability check would wave through.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { probe, observe, run, solvePow, checkPaidCall, PAID_CALL_MAX_DIFFICULTY, SOLVE_CAP_FACTOR } from "../workers/status-probe/src/index.js";

const PROD = "https://prod.test";
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const offer = (nets) => btoa(JSON.stringify({ accepts: nets.map((n) => ({ network: n })) }));

// The paid-call legs, modelled on the server: a probe challenge at 4 bits, and
// a /api/hash that CHECKS the submitted nonce really meets the difficulty (so a
// green run proves the Worker's solver, not just its plumbing) and answers the
// sha256 of the text it was sent, through the PoW gate.
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
let issued = new Map(); // challenge -> difficulty
const challengeAt = (difficulty) => () => {
  const c = randomBytes(16).toString("hex");
  issued.set(c, difficulty);
  return Response.json({ algorithm: "sha256", challenge: c, difficulty, slug: "hash", token: `${c}.1.${difficulty}.hash.probe.sig`, ttlSeconds: 120 });
};
const healthyHash = (_u, init) => {
  const sol = init?.headers?.["X-Pow-Solution"] || "";
  const nonce = sol.slice(sol.lastIndexOf(":") + 1);
  const c = sol.split(".")[0];
  const d = issued.get(c);
  if (d === undefined || lz(createHash("sha256").update(`${c}:${nonce}`).digest()) < d) {
    return new Response("{}", { status: 402, headers: { "x-pow-error": "insufficient work" } });
  }
  const text = JSON.parse(init.body).text;
  return new Response(JSON.stringify({ algo: "sha256", hex: createHash("sha256").update(text).digest("hex") }), { status: 200, headers: { "x-pow-accepted": "true" } });
};

/** Install a fetch stub. `over` overrides any leg of a healthy production. */
let seen = [];
function stub(over = {}) {
  issued = new Map();
  seen = [];
  const healthy = {
    health: () => new Response("ok", { status: 200 }),
    pricing: () => Response.json({ endpoints: new Array(516).fill({}) }),
    mcp: () => new Response(JSON.stringify({ result: { serverInfo: { name: "agent402" } } }), { status: 200 }),
    extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453", "solana:mainnet"]) } }),
    record: () => new Response("{}", { status: 200 }),
    challenge: challengeAt(4),
    hash: healthyHash,
  };
  const legs = { ...healthy, ...over };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push({ u, init });
    if (u.endsWith("/health")) return legs.health(u, init);
    if (u.endsWith("/api/pricing")) return legs.pricing(u, init);
    if (u.endsWith("/mcp")) return legs.mcp(u, init);
    if (u.endsWith("/api/extract")) return legs.extract(u, init);
    if (u.endsWith("/api/status/probe")) return legs.record(u, init);
    if (u.includes("/api/pow/challenge?")) return legs.challenge(u, init);
    if (u.endsWith("/api/hash")) return legs.hash(u, init);
    throw new Error("unexpected url " + u);
  };
}
const TOKEN = "status-probe-only-token-bbbbbbbbbbbb";

console.log("status-probe worker — observation mapping");

{
  stub();
  const { components, fails } = await probe(PROD);
  check("healthy production: all five components operational", () => {
    for (const k of ["api", "catalog", "mcp", "paywall", "rails"]) {
      assert.equal(components[k]?.ok, true, `${k} should be ok`);
    }
    assert.equal(fails.length, 0);
  });
  check("with the paid-call check off, paid-call is never claimed", () => {
    assert.equal(components["paid-call"], undefined,
      "no check ran; claiming the component would be a fabricated observation");
    assert.ok(!seen.some((x) => x.u.includes("/api/pow/")), "and nothing was asked of the PoW route");
  });
}

{
  // The dangerous one: production answers 200 instead of 402. A reachability
  // check calls that healthy; it is actually paid tools being given away.
  stub({ extract: () => new Response("{}", { status: 200 }) });
  const { components } = await probe(PROD);
  check("paywall serving 200 instead of 402 is an outage, not a success", () => {
    assert.equal(components.paywall.ok, false);
    assert.match(components.paywall.detail, /200/);
  });
  check("an unreadable offer marks rails down rather than guessing", () => {
    assert.equal(components.rails.ok, false);
  });
}

{
  stub({ extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["solana:mainnet"]) } }) });
  const { components } = await probe(PROD);
  check("Base dropping out of the offer is caught even though the 402 is correct", () => {
    assert.equal(components.paywall.ok, true, "the paywall itself is fine");
    assert.equal(components.rails.ok, false, "but the rail is gone");
  });
}

// The unpaid-quote budget's 429 (src/unpaid-quote-budget.js): this Worker
// reads from Cloudflare's shared addresses, so a refusal by that budget says
// nothing about the paywall. One re-read after Retry-After (capped); two
// budget refusals leave paywall and rails unobserved, never failed. Any other
// non-402, a plain 429 included, still fails.
{
  const budget429 = () => new Response(JSON.stringify({ ok: false, error: "rate-limited", reason: "unpaid-quote-budget", retryAfterSeconds: 1800 }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1800" } });
  const healthy402 = () => new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453"]) } });
  const { PAYWALL_BUDGET_WAIT_MAX_MS } = await import("../workers/status-probe/src/index.js");

  let n = 0;
  stub({ extract: () => (++n === 1 ? budget429() : healthy402()) });
  const waits = [];
  const once = await probe(PROD, { sleep: async (ms) => { waits.push(ms); } });
  check("a budget 429 then a 402: re-read once after a capped Retry-After, paywall and rails ok", () => {
    assert.equal(n, 2, "exactly one re-read");
    assert.deepEqual(waits, [PAYWALL_BUDGET_WAIT_MAX_MS], "the hour-long Retry-After is capped");
    assert.ok(PAYWALL_BUDGET_WAIT_MAX_MS <= 10_000, "the wait stays well inside a run");
    assert.equal(once.components.paywall.ok, true);
    assert.equal(once.components.rails.ok, true);
    assert.equal(once.fails.length, 0);
    assert.equal(once.paywall.observed, true);
  });

  n = 0;
  stub({ extract: () => { n++; return budget429(); } });
  const twice = await probe(PROD, { sleep: async () => {} });
  check("a budget 429 twice: paywall and rails unobserved, no failure", () => {
    assert.equal(n, 2, "one re-read, no more");
    assert.equal(twice.components.paywall, undefined, "an unobserved paywall is not recorded");
    assert.equal(twice.components.rails, undefined, "nor are the rails");
    assert.equal(twice.fails.length, 0, `no fail: ${twice.fails.join(" ")}`);
    assert.equal(twice.paywall.observed, false);
  });
  stub({ extract: budget429 });
  let recordedBody = null;
  const recordLeg = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/status/probe")) { recordedBody = JSON.parse(init.body); return new Response("{}", { status: 200 }); }
    return recordLeg(url, init);
  };
  const out = await run({ PROD, STATUS_PROBE_TOKEN: TOKEN }, { sleep: async () => {} });
  check("a budget 429 twice through run(): recorded without paywall or rails, no retry pass, no page", () => {
    assert.equal(out.fails.length, 0);
    assert.ok(recordedBody && !("paywall" in recordedBody.components) && !("rails" in recordedBody.components), JSON.stringify(recordedBody?.components));
    assert.equal(recordedBody.components.api.ok, true, "the rest is still recorded");
    assert.notEqual(out.outage?.action, "opened");
    assert.deepEqual(out.alarms?.opened || [], []);
  });

  for (const [label, leg] of [
    ["a plain 429", () => Response.json({ ok: false, error: "rate-limited" }, { status: 429, headers: { "retry-after": "5" } })],
    ["a 429 naming another reason", () => Response.json({ ok: false, error: "rate-limited", reason: "something-else" }, { status: 429 })],
    ["a 500", () => new Response("boom", { status: 500 })],
  ]) {
    n = 0;
    stub({ extract: () => { n++; return leg(); } });
    const r = await probe(PROD, { sleep: async () => {} });
    check(`${label} still fails the paywall as before, with no re-read`, () => {
      assert.equal(n, 1);
      assert.equal(r.components.paywall.ok, false);
      assert.equal(r.components.rails.ok, false);
      assert.ok(r.fails.some((f) => f.startsWith("paywall(")));
    });
  }
}

{
  stub({ pricing: () => Response.json({ endpoints: new Array(12).fill({}) }) });
  const { components } = await probe(PROD);
  check("a collapsed catalog is caught (12 routes is not a catalog)", () => {
    assert.equal(components.catalog.ok, false);
    assert.match(components.catalog.detail, /12/);
  });
  check("a collapsed catalog does not drag unrelated components down", () => {
    assert.equal(components.api.ok, true);
    assert.equal(components.mcp.ok, true);
  });
}

{
  stub({ mcp: () => new Response(JSON.stringify({ result: {} }), { status: 200 }) });
  const { components } = await probe(PROD);
  check("a 200 from /mcp without the server identity is still a failure", () => {
    assert.equal(components.mcp.ok, false);
  });
}

{
  stub({ health: () => { throw new Error("ECONNREFUSED"); } });
  const { components } = await probe(PROD);
  check("a thrown request records a failure, never a silent pass", () => {
    assert.equal(components.api.ok, false);
    assert.match(components.api.detail, /ECONNREFUSED/);
  });
  check("one dead endpoint does not abort the remaining checks", () => {
    assert.equal(components.catalog.ok, true, "catalog should still have been probed");
    assert.equal(components.paywall.ok, true, "paywall should still have been probed");
  });
}

{
  // Total outage: every leg throws. Nothing may come back ok.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead, pricing: dead, mcp: dead, extract: dead });
  const { components } = await probe(PROD);
  check("total outage marks every observed component down", () => {
    for (const [k, v] of Object.entries(components)) assert.equal(v.ok, false, `${k} claimed ok during a total outage`);
    assert.ok(Object.keys(components).length >= 5);
  });
}

{
  // Deploy-blip retry (2026-07-29): a single failed attempt that recovers by
  // the retry is recorded CLEAN — one probe landing inside a deploy restart
  // must not amber the whole day's bar on /status.
  let calls = 0;
  const blip = () => { calls++; if (calls === 1) throw new Error("connection reset"); return new Response("ok", { status: 200 }); };
  stub({ health: blip });
  const result = await observe(PROD, { sleep: async () => {} });
  check("transient blip: retry succeeds and is recorded clean", () => {
    assert.equal(result.retried, true, "should have retried");
    assert.equal(result.fails.length, 0, `expected no recorded fails, got: ${result.fails.join(" ")}`);
    assert.equal(result.components.api.ok, true);
  });
}

{
  // A failure that SURVIVES the retry is a real outage and must be recorded —
  // the retry may never soften a sustained failure.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead });
  const result = await observe(PROD, { sleep: async () => {} });
  check("sustained failure: recorded down even after the retry", () => {
    assert.equal(result.retried, true);
    assert.equal(result.components.api.ok, false, "a real outage must never be retried away");
    assert.ok(result.fails.some((f) => f.startsWith("api(")));
  });
}

{
  // Healthy path never pays the retry pause.
  stub();
  let slept = false;
  const result = await observe(PROD, { sleep: async () => { slept = true; } });
  check("healthy production: no retry, no pause", () => {
    assert.equal(result.retried, false);
    assert.equal(slept, false, "healthy path must not sleep");
  });
}


// --- paid-call ---------------------------------------------------------------
// The proof-of-work path, walked with the probe-only challenge. What matters is
// the same as everywhere else in this file (never record a broken path as
// operational) plus one thing specific to this check: it must never solve a
// challenge it cannot afford, because blowing the Worker's CPU limit kills the
// whole run and every other observation with it.
{
  stub();
  const { components, fails, paidCall } = await probe(PROD, { paidCallToken: TOKEN });
  check("healthy paid path: paid-call is observed operational", () => {
    assert.equal(components["paid-call"]?.ok, true, JSON.stringify(components["paid-call"]));
    assert.equal(paidCall.observed, true);
    assert.equal(fails.length, 0);
  });
  check("it asks for the challenge with the probe token and names itself", () => {
    const c = seen.find((x) => x.u.includes("/api/pow/challenge?slug=hash"));
    assert.ok(c, "no challenge request");
    assert.equal(c.init.headers["X-Operator-Token"], TOKEN);
    assert.match(c.init.headers["User-Agent"], /^agent402-status-probe\//);
  });
  check("the call carries a solution that really meets the difficulty (the stub checked it)", () => {
    const h = seen.find((x) => x.u.endsWith("/api/hash"));
    assert.ok(h && /\.probe\.sig:\d+$/.test(h.init.headers["X-Pow-Solution"]), JSON.stringify(h?.init?.headers));
  });
  check("the text it hashes is unique per call, so no cached answer can pass", () => {
    const h = seen.find((x) => x.u.endsWith("/api/hash"));
    assert.match(JSON.parse(h.init.body).text, /^status-probe [0-9a-f]{32}$/);
  });
}

{
  stub();
  const { components, paidCall } = await probe(PROD, { paidCallToken: "" });
  check("no STATUS_PROBE_TOKEN: skipped, never claimed, and no request made", () => {
    assert.equal(components["paid-call"], undefined);
    assert.equal(paidCall.observed, false);
    assert.match(paidCall.reason, /no STATUS_PROBE_TOKEN/);
    assert.ok(!seen.some((x) => x.u.includes("/api/pow/")));
  });
}

{
  // What an older server, or one without STATUS_PROBE_TOKEN, hands back: the
  // normal 16-bit challenge. Solving it would take hundreds of milliseconds of
  // CPU and kill the run. It must be refused before a single hash, and reported
  // as not observed - the paid path itself may be perfectly healthy.
  stub({ challenge: challengeAt(16) });
  let digests = 0;
  const real = crypto.subtle.digest.bind(crypto.subtle);
  Object.defineProperty(crypto.subtle, "digest", { value: (...a) => { digests++; return real(...a); }, configurable: true });
  const { components, fails, paidCall } = await probe(PROD, { paidCallToken: TOKEN });
  delete crypto.subtle.digest;
  check("a normal 16-bit challenge is REFUSED, not solved", () => {
    assert.equal(digests, 0, `hashed ${digests} times`);
    assert.ok(!seen.some((x) => x.u.endsWith("/api/hash")), "made the call anyway");
  });
  check("and it is reported as not observed, never as an outage", () => {
    assert.equal(components["paid-call"], undefined);
    assert.equal(fails.length, 0);
    assert.equal(paidCall.observed, false);
    assert.match(paidCall.reason, /16 bits/);
  });
}

{
  // The hard cap. A digest that never yields a zero bit forces the worst case.
  // (Past 4x the cap it gives in and returns an all-zero digest, so a solver
  // with no cap FAILS here quickly instead of spinning until the CI timeout.)
  stub();
  let digests = 0;
  const giveIn = SOLVE_CAP_FACTOR * 2 ** 4 * 4;
  Object.defineProperty(crypto.subtle, "digest", { value: async () => { digests++; return new Uint8Array(32).fill(digests > giveIn ? 0 : 0xff).buffer; }, configurable: true });
  const r = await checkPaidCall(PROD, TOKEN);
  delete crypto.subtle.digest;
  const cap = SOLVE_CAP_FACTOR * 2 ** 4;
  check(`an unlucky solve stops at the cap (${cap} hashes) and is not observed`, () => {
    assert.equal(digests, cap);
    assert.match(r.skip || "", /no nonce within/);
    assert.ok(!seen.some((x) => x.u.endsWith("/api/hash")));
  });
}

// Each broken shape of the path is a FAILURE, with a detail that says which.
const failCases = [
  ["challenge route erroring", { challenge: () => new Response("{}", { status: 500 }) }, /challenge 500/],
  ["challenge route unreachable", { challenge: () => { throw new Error("ECONNRESET"); } }, /challenge ECONNRESET/],
  ["challenge unreadable", { challenge: () => Response.json({ nope: true }) }, /challenge unreadable/],
  ["challenge for the wrong slug", { challenge: () => Response.json({ challenge: "ab", token: "t", difficulty: 4, slug: "uuid" }) }, /challenge unreadable/],
  ["solution refused", { hash: () => new Response("{}", { status: 402, headers: { "x-pow-error": "challenge already used" } }) }, /call 402 \(challenge already used\)/],
  ["a 200 that did not come through the PoW gate", { hash: (u, init) => { const r = healthyHash(u, init); return new Response(r.body, { status: r.status }); } }, /without X-Pow-Accepted/],
  ["a wrong payload", { hash: () => new Response(JSON.stringify({ hex: "00" }), { status: 200, headers: { "x-pow-accepted": "true" } }) }, /payload is not the hash/],
  ["the call throwing", { hash: () => { throw new Error("socket hang up"); } }, /call socket hang up/],
];
for (const [name, over, detail] of failCases) {
  stub(over);
  const { components, fails } = await probe(PROD, { paidCallToken: TOKEN });
  check(`paid-call: ${name} is recorded down`, () => {
    assert.equal(components["paid-call"]?.ok, false, JSON.stringify(components["paid-call"]));
    assert.match(components["paid-call"].detail, detail);
    assert.ok(fails.some((f) => f.startsWith("paid-call(")));
    assert.equal(components.api.ok, true, "and nothing else is dragged down");
  });
}

{
  // A Worker holding only the ROOT operator token does not use it at all: the
  // probe token is STATUS_PROBE_TOKEN or nothing, so nothing is sent anywhere.
  stub();
  const out = await run({ PROD, OPERATOR_TOKEN: "operator-root-token-aaaaaaaaaaaaaaaa" }, { sleep: async () => {} });
  check("with only OPERATOR_TOKEN, the Worker refuses to probe and the root token never leaves", () => {
    assert.equal(out.ok, false);
    assert.equal(out.error, "no probe token");
    const leaked = seen.filter((x) => JSON.stringify(x.init?.headers || {}).includes("operator-root-token"));
    assert.deepEqual(leaked.map((x) => x.u), []);
  });
}

{
  // The single-retry rule covers paid-call like every other check.
  let n = 0;
  stub({ challenge: (u, i) => (++n === 1 ? new Response("{}", { status: 502 }) : challengeAt(4)(u, i)) });
  const r = await observe(PROD, { sleep: async () => {}, paidCallToken: TOKEN });
  check("paid-call blip: the retry succeeds and it is recorded clean", () => {
    assert.equal(r.retried, true);
    assert.equal(r.components["paid-call"].ok, true);
    assert.equal(r.fails.length, 0);
  });
  stub({ hash: () => new Response("{}", { status: 500 }) });
  const r2 = await observe(PROD, { sleep: async () => {}, paidCallToken: TOKEN });
  check("paid-call sustained failure: recorded down after the retry", () => {
    assert.equal(r2.retried, true);
    assert.equal(r2.components["paid-call"].ok, false);
  });
}

{
  // The budget, as arithmetic, so raising either knob fails HERE with the
  // reason instead of in production as a killed run. Measured 2026-09-28:
  // about 10 us of CPU per crypto.subtle.digest in Node 22 (the SLOWER of Node
  // and workerd), against a 10 ms per-invocation CPU limit, with at least 3x
  // headroom required for the solve.
  const NODE_US_PER_HASH = 10;
  const worstHashes = SOLVE_CAP_FACTOR * 2 ** PAID_CALL_MAX_DIFFICULTY;
  const powSrc = await readFile(new URL("../src/pow.js", import.meta.url), "utf8");
  const serverDifficulty = Number(powSrc.match(/export const PROBE_POW_DIFFICULTY = (\d+);/)?.[1]);
  check(`worst-case solve (${worstHashes} hashes, ~${(worstHashes * NODE_US_PER_HASH / 1000).toFixed(1)} ms) leaves >= 3x headroom under 10 ms`, () => {
    assert.ok(worstHashes * NODE_US_PER_HASH * 3 <= 10_000, `${worstHashes} hashes x ${NODE_US_PER_HASH} us x 3 > 10 ms`);
  });
  check(`the server's probe difficulty (${serverDifficulty}) is one the Worker will solve (<= ${PAID_CALL_MAX_DIFFICULTY})`, () => {
    assert.ok(Number.isInteger(serverDifficulty) && serverDifficulty >= 1, "PROBE_POW_DIFFICULTY not found in src/pow.js");
    assert.ok(serverDifficulty <= PAID_CALL_MAX_DIFFICULTY, "the Worker would refuse every challenge and never observe the path");
  });
  // Informational: the solve as this machine runs it (not asserted - CI
  // runners are too noisy for a timing gate; the arithmetic above is the gate).
  const t0 = performance.now();
  await solvePow("0123456789abcdef0123456789abcdef", 256, worstHashes);
  console.log(`       (this runner: ${worstHashes} hashes in ${(performance.now() - t0).toFixed(2)} ms wall)`);
}

{
  // Subrequests. The worst run this Worker can make: every probe leg on both
  // attempts (a failure forces the retry, the paid-call reaches its call both
  // times), the record, a confirmed alarm reading, and every other alarm
  // closing an open issue (a comment and a PATCH each), and the paywall read
  // refused by the unpaid-quote budget once per attempt (one re-read each).
  let calls = 0;
  const HEALTHY_GW = { status: "ok", revenueLive: { status: "fresh" }, upstreamBuyer: { status: "low", trend: "ok" }, upstreamBuyerAvm: { status: "ok" }, upstreamBuyerEvm: { status: "ok" }, upstreamBuyerTempo: { status: "ok" }, subscriptionFeePayer: { status: "ok", ceiling: "ok" }, databases: { leads: { status: "ok" }, analytics: { status: "ok" } }, operatorAuth: { status: "ok" }, tweetQueue: { status: "ok" }, circlePending: { status: "ok" }, gatewayPending: { status: "ok" }, lateSettlements: { status: "ok" }, chargedFailures: { status: "ok", windowHours: 6 }, refundsOwed: { status: "ok" }, ledgerDeadLetter: { status: "none" }, redisPersistence: { status: "on" }, backup: { status: "ok" }, outboundDestinations: { status: "ok" },
    upstreamBuyerSvm: { status: "ok" }, stellarFacilitator: { status: "ok" }, upstreamBudgets: { status: "ok" }, upstreamHardCaps: { status: "ok" }, exaAllowance: { status: "ok" }, xDataSpend: { status: "ok" }, exaSpend: { status: "ok" }, routerSpendWindow: { status: "ok" }, gatewayBalance: { status: "ok" }, sharedLimits: { status: "on", alert: "ok" }, replayStore: { status: "ok", alert: "ok" }, stateDb: { status: "on" }, sanctions: { status: "ok" }, sanctionsScreen: { status: "fresh" }, email: { status: "ok" }, upstreamCosts: { status: "ok" },
    mppReconcile: { status: "ok", window7d: "ok", chargedFailedStatus: "ok" },
    toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, toolAnswers: { status: "ok" }, containedTurns: { status: "ok" }, brokenListings: { status: "ok" }, topBuyerFailures: { status: "ok" }, buyerRefusals: { status: "ok" }, settleFailures: { status: "ok" }, unsettledReports: { status: "ok" }, robinhoodSettler: { status: "ok" }, subscriptionRenewals: { status: "ok" }, directUpstream: { status: "ok" }, creditsRefunds: { status: "ok" }, cdnOrigin: { status: "ok" } };
  const { ALARMS, MAX_ISSUE_WRITES } = await import("../workers/status-probe/src/index.js");
  let extractReads = 0;
  stub({
    health: () => new Response("down", { status: 503 }),
    extract: () => (++extractReads % 2 === 1
      ? Response.json({ ok: false, error: "rate-limited", reason: "unpaid-quote-budget" }, { status: 429, headers: { "retry-after": "60" } })
      : new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453"]) } })),
  });
  const prodStub = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    const u = String(url);
    if (u.endsWith("/api/gateway-status")) return Response.json(HEALTHY_GW);
    if (u.endsWith("/api/status")) return Response.json({ components: [{ key: "settlement", current: { state: "operational" } }] });
    if (u === "https://api.github.com/user") return Response.json({ login: "probe-bot" });
    if (u.includes("/issues?state=open")) return Response.json(ALARMS.filter((a) => a.title !== "Upstream buyer wallet LOW (x402)").map((a, i) => ({ number: i + 1, title: a.title, user: { login: "probe-bot" } })));
    if (new URL(u).hostname === "api.github.com") return new Response("{}", { status: 200 });
    return prodStub(url, init);
  };
  const out = await run({ PROD, STATUS_PROBE_TOKEN: TOKEN, GITHUB_ISSUES_TOKEN: "t" }, { sleep: async () => {} });
  check(`worst-case run makes ${calls} subrequests, at least ten under the limit of 50`, () => {
    assert.equal(out.paidCall.observed, true, "the scenario must include the paid-call legs");
    assert.equal(extractReads, 4, "the scenario must include a budget re-read on both attempts");
    // Every alarm but one wants closing and that one wants opening: more
    // writes than one run may make, so the scenario reaches the write cap.
    assert.ok(ALARMS.length > MAX_ISSUE_WRITES, "the scenario must exceed the write cap");
    assert.deepEqual(out.alarms.opened, ["Upstream buyer wallet LOW (x402)"], "the open goes first");
    assert.equal(out.alarms.closed.length, MAX_ISSUE_WRITES - 1, "closes fill the rest of the cap");
    assert.equal(out.alarms.deferred.length, ALARMS.length - MAX_ISSUE_WRITES, "the remainder waits for the next run");
    assert.ok(calls <= 40, `${calls} subrequests`);
  });
  // The README states the figure this scenario measures; a change that moves
  // it moves both.
  const readme = await readFile(new URL("../workers/status-probe/README.md", import.meta.url), "utf8");
  check(`the README states the measured worst case (${calls} subrequests)`, () => {
    assert.equal(calls, 40, "the measured worst case moved: update this pin and the README together");
    assert.match(readme.replace(/\s+/g, " "), new RegExp(`alarms opening and closing\\) is ${calls}, pinned in`));
  });
}

// --- the alarms ------------------------------------------------------------
// heartbeat.yml carries eighteen alarm checks and is their ONLY observer, but
// GitHub does not deliver its schedule: measured 2026-08-30, `*/15` gave gaps
// of 2-12 h and a gentler `9,39` gave ONE run in 9.8 h. This Worker's 5-minute
// cron IS honoured, so it takes over every alarm readable from one public
// endpoint. These pin the four properties that keep a faster observer from
// being worse than a slow one: it never pages on a single reading, it never
// closes on silence, it never duplicates the workflow's issue, and it cannot
// spend or deploy anything (issues-only credential, no workflow dispatch).
{
  const { syncAlarms, judge, ALARMS } = await import("../workers/status-probe/src/index.js");
  const acheck = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  };
  const HEALTHY_GATEWAY = {
    status: "ok", revenueLive: { status: "fresh" },
    upstreamBuyer: { status: "ok", trend: "ok" }, upstreamBuyerEvm: { status: "ok" },
    upstreamBuyerAvm: { status: "ok" },
    upstreamBuyerTempo: { status: "ok" },
    subscriptionFeePayer: { status: "ok", ceiling: "ok" },
    databases: { leads: { status: "ok" }, analytics: { status: "ok" } },
    operatorAuth: { status: "ok" },
  };
  const HEALTHY_STATUS = { components: [{ key: "settlement", current: { state: "operational", ageMs: 3600000 } }] };
  const HEALTHY = { gateway: HEALTHY_GATEWAY, status: HEALTHY_STATUS };
  const withGateway = (over) => ({ gateway: { ...HEALTHY_GATEWAY, ...over }, status: HEALTHY_STATUS });
  const ENV = { GITHUB_ISSUES_TOKEN: "t" };
  const realFetch = globalThis.fetch;
  let created, closed, comments, calls;
  const mkGh = (openIssues = []) => {
    created = []; closed = []; comments = []; calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url); const m = (init.method || "GET").toUpperCase();
      calls.push(`${m} ${u.replace("https://api.github.com", "")}`);
      if (u === "https://api.github.com/user") return Response.json({ login: "probe-bot" });
      // A fixture with no author is one the Worker itself opened.
      if (u.includes("/issues?state=open")) return Response.json(openIssues.map((x) => ({ user: { login: "probe-bot" }, ...x })));
      if (m === "POST" && /\/issues$/.test(u)) { created.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
      if (m === "POST" && /\/comments$/.test(u)) { comments.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
      if (m === "PATCH" && /\/issues\/\d+$/.test(u)) { closed.push(u); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    };
  };
  const nosleep = { sleep: async () => {}, confirmDelayMs: 0 };
  const feed = (...bodies) => { let i = 0; return async () => bodies[Math.min(i++, bodies.length - 1)]; };

  await acheck("a healthy read opens nothing", async () => {
    mkGh();
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.bad, []);
    assert.ok(!calls.some((c) => c.startsWith("POST")), `posted: ${calls}`);
  });

  await acheck("a bad reading CONFIRMED by a second read opens exactly one issue", async () => {
    mkGh();
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "Upstream buyer wallet LOW (x402)");
  });

  // The class that filed #1057 on a perfectly healthy service: a reading
  // taken while a deploy swaps containers can fail on its own and is
  // indistinguishable from a fault until a second read disagrees.
  await acheck("a bad reading the second read does NOT confirm pages nobody", async () => {
    mkGh();
    const bad = withGateway({ databases: { leads: { status: "unreachable" }, analytics: { status: "ok" } } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, HEALTHY) });
    assert.deepEqual(r.opened, []);
    assert.equal(created.length, 0, `created: ${JSON.stringify(created)}`);
  });

  await acheck("an alarm the workflow already opened is never duplicated", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, []);
    assert.equal(created.length, 0);
    // and it does not comment either: 288 ticks a day would be 288 comments
    assert.equal(comments.length, 0);
  });

  await acheck("recovery closes an open alarm issue the heartbeat workflow opened", async () => {
    mkGh([{ number: 78, title: "Upstream buyer wallet LOW (x402)", user: { login: "github-actions[bot]" } }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, ["Upstream buyer wallet LOW (x402)"]);
    assert.ok(closed[0].endsWith("/issues/78"));
  });

  await acheck("an issue another account opened under an alarm title is not an alarm: never closed, never suppresses a page", async () => {
    mkGh([{ number: 90, title: "Upstream buyer wallet LOW (x402)", user: { login: "someone-else" } }]);
    const healthy = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(healthy.closed, []);
    assert.equal(closed.length, 0, `closed: ${closed}`);
    mkGh([{ number: 90, title: "Upstream buyer wallet LOW (x402)", user: { login: "someone-else" } }]);
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const paged = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(paged.opened, ["Upstream buyer wallet LOW (x402)"], "the Worker opens its own issue");
  });

  await acheck("GITHUB_ISSUES_LOGIN names the posting account without a /user read", async () => {
    mkGh([{ number: 91, title: "Upstream buyer wallet LOW (x402)", user: { login: "Named-Bot" } }]);
    const r = await syncAlarms({ GITHUB_ISSUES_TOKEN: "t2", GITHUB_ISSUES_LOGIN: "named-bot" }, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, ["Upstream buyer wallet LOW (x402)"]);
    assert.ok(!calls.some((c) => c === "GET /user"), `calls: ${calls}`);
  });

  await acheck("recovery closes the open issue the Worker opened", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(closed.length, 1);
    // One subrequest per close: the close is the recovery record, no comment.
    assert.equal(comments.length, 0);
  });

  // containedTurns and brokenListings live in the server's memory: a restart
  // reads ok at once, so one ok read across a deploy is not a recovery. They
  // close on the second ok read in a row; the first marks the issue body (the
  // same mark heartbeat.yml writes), a bad read removes the mark.
  for (const [field, badWord, title] of [["containedTurns", "repeating", "containedTurns: a scheduled turn is throwing every minute"], ["brokenListings", "widespread", "brokenListings: seller listings are failing to read across many origins"]]) {
    await acheck(`${field}: closes only on the second ok read in a row; a bad read between starts the count again`, async () => {
      const { CLEARING_MARK } = await import("../workers/status-probe/src/index.js");
      const ISSUE = `/api/gateway-status reports ${field}.status=${badWord}: details.`;
      let body = ISSUE;
      const run = async (word) => {
        mkGh([{ number: 55, title, body }]);
        const patches = [];
        const inner = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => { if ((init.method || "").toUpperCase() === "PATCH") patches.push(JSON.parse(init.body)); return inner(url, init); };
        const g = withGateway({ [field]: { status: word } });
        const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(g, g) });
        for (const p of patches) if (typeof p.body === "string") body = p.body;
        return { r, patches };
      };
      let { r, patches } = await run("ok");
      assert.deepEqual(r.closed, [], "one ok read does not close");
      assert.deepEqual(r.clearing, [title]);
      assert.equal(patches.length, 1);
      assert.ok(body.startsWith(`${ISSUE}\n\n${CLEARING_MARK}`), body);
      const markedBody = body;
      ({ r, patches } = await run("ok"));
      assert.deepEqual(r.closed, [title], "the second ok read in a row closes");
      assert.deepEqual(patches, [{ state: "closed" }]);
      body = markedBody;
      ({ r, patches } = await run(badWord));
      assert.deepEqual(patches, [{ body: ISSUE }], "a bad read removes the mark line");
      assert.deepEqual(r.opened, []);
      ({ r, patches } = await run(badWord));
      assert.deepEqual(patches, [], "a bad read with no mark writes nothing");
      ({ r, patches } = await run("ok"));
      assert.deepEqual(r.closed, [], "after ok, bad, the next ok marks again rather than closing");
      for (const b of [ISSUE, markedBody]) {
        body = b;
        ({ r, patches } = await run("unknown"));
        assert.deepEqual(patches, [], "unknown neither marks, unmarks nor closes");
      }
    });
  }

  await acheck("a pull request with a colliding title is not an alarm", async () => {
    mkGh([{ number: 9, title: "Upstream buyer wallet LOW (x402)", pull_request: { url: "x" } }]);
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
  });

  // unknown/unconfigured must do NOTHING - never page, and never close a real
  // alarm on the strength of silence.
  await acheck("unknown neither opens nor closes", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const unk = withGateway({ status: "unknown", upstreamBuyer: { status: "unknown", trend: "unknown" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(unk) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.closed, []);
    assert.equal(created.length + closed.length, 0);
  });

  await acheck("an unreadable endpoint changes nothing at all", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: async () => { throw new Error("502"); } });
    assert.match(r.error, /unreadable/);
    assert.equal(created.length + closed.length, 0);
    assert.ok(!calls.length, `touched GitHub: ${calls}`);
  });

  await acheck("without a token it is an env-gated no-op", async () => {
    mkGh();
    const r = await syncAlarms({}, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.match(r.error, /no GITHUB_ISSUES_TOKEN/);
    assert.ok(!calls.length);
  });

  // The whole point of choosing issues:write over actions:write. A token that
  // can dispatch workflows can deploy production (deploy.yml), post as the
  // company (announce.yml) and spend the canary and refund wallets.
  await acheck("it never calls a workflow dispatch or any Actions endpoint", async () => {
    mkGh();
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "draining" } });
    await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.ok(!calls.some((c) => /\/actions\/|dispatches/.test(c)), `Actions call: ${calls}`);
  });

  await acheck("the unreadable-balance alarm needs 180 minutes, not one bad read", async () => {
    assert.equal(judge({ gateway: { status: "unknown", unknownForMinutes: 30 } })["Gateway balance UNREADABLE (OpenRouter)"], "quiet");
    assert.equal(judge({ gateway: { status: "unknown", unknownForMinutes: 200 } })["Gateway balance UNREADABLE (OpenRouter)"], "bad");
  });

  // Settlement freshness moved here from heartbeat.yml on 2026-08-30: GitHub
  // was delivering that workflow about once every five hours, and the canary
  // had already gone 16 h without buying with nothing paging.
  const SETTLE = "Settlement stale - the paid canary is not buying";
  await acheck("a stale settlement observation pages", async () => {
    mkGh();
    const stale = { gateway: HEALTHY_GATEWAY, status: { components: [{ key: "settlement", current: { state: "unknown", ageMs: 99 * 3600000 } }] } };
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(stale, stale) });
    assert.deepEqual(r.opened, [SETTLE]);
    assert.match(created[0].body, /99h/);
    // It cannot dispatch the canary (issues-only credential), so it must SAY so.
    assert.match(created[0].body, /gh workflow run paid-canary\.yml/);
  });
  await acheck("a fresh settlement observation closes it", async () => {
    mkGh([{ number: 5, title: SETTLE }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, [SETTLE]);
  });
  await acheck("an unreadable /api/status neither pages nor closes settlement", async () => {
    mkGh([{ number: 5, title: SETTLE }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed({ gateway: HEALTHY_GATEWAY, status: null }) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.closed, []);
  });
  await acheck("the gateway alarms still work when /api/status is missing", async () => {
    mkGh();
    const low = { gateway: { ...HEALTHY_GATEWAY, upstreamBuyer: { status: "low", trend: "ok" } }, status: null };
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
  });

  // The server tweet queue (src/tweet-queue.js) publishes one word. Four words
  // page, ok and off close, and retrying (a post waiting for its one retry) or
  // an unrecognised word does neither.
  const TQ = "Tweet queue needs attention (server poster)";
  await acheck("each tweet-queue word maps to page, clear or quiet", async () => {
    for (const w of ["halted", "no_credentials", "refused", "in_doubt"]) assert.equal(judge(withGateway({ tweetQueue: { status: w } }))[TQ], "bad", w);
    for (const w of ["ok", "off"]) assert.equal(judge(withGateway({ tweetQueue: { status: w } }))[TQ], "good", w);
    for (const w of ["retrying", "unknown", "something-new"]) assert.equal(judge(withGateway({ tweetQueue: { status: w } }))[TQ], "quiet", w);
    assert.equal(judge(HEALTHY)[TQ], "quiet", "a gateway without the field (an older build) changes nothing");
  });
  const CP = "Arc pending settlements need attention";
  await acheck("each Arc pending-book word maps to page, clear or quiet; the body echoes only known words", async () => {
    for (const w of ["unresolved", "full"]) assert.equal(judge(withGateway({ circlePending: { status: w } }))[CP], "bad", w);
    for (const w of ["ok", "off"]) assert.equal(judge(withGateway({ circlePending: { status: w } }))[CP], "good", w);
    for (const w of ["near_capacity", "unknown", "something-new"]) assert.equal(judge(withGateway({ circlePending: { status: w } }))[CP], "quiet", w);
    const a = ALARMS.find((x) => x.title === CP);
    assert.doesNotMatch(a.body({ gateway: { circlePending: { status: "<script>" } } }), /<script/i);
  });
  const GP = "Gateway pending settlements need attention";
  await acheck("each Gateway pending-book word maps to page, clear or quiet; the body echoes only known words", async () => {
    for (const w of ["unresolved", "full"]) assert.equal(judge(withGateway({ gatewayPending: { status: w } }))[GP], "bad", w);
    for (const w of ["ok", "off"]) assert.equal(judge(withGateway({ gatewayPending: { status: w } }))[GP], "good", w);
    for (const w of ["pending", "near_capacity", "unknown", "something-new"]) assert.equal(judge(withGateway({ gatewayPending: { status: w } }))[GP], "quiet", w);
    assert.equal(judge({ gateway: {} })[GP], "quiet", "a gateway without the field (an older build) changes nothing");
    const a = ALARMS.find((x) => x.title === GP);
    assert.doesNotMatch(a.body({ gateway: { gatewayPending: { status: "<script>" } } }), /<script/i);
    assert.match(a.body({ gateway: { gatewayPending: { status: "full" } } }), /gatewayPending\.status=full\./);
  });
  await acheck("a Gateway pending entry past its bound opens the issue; ok closes it", async () => {
    mkGh();
    const bad = withGateway({ gatewayPending: { status: "unresolved" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, bad) });
    assert.ok(r.opened.includes(GP), JSON.stringify(r.opened));
    mkGh([{ number: 77, title: GP }]);
    const good = withGateway({ gatewayPending: { status: "ok" } });
    const r2 = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(good, good) });
    assert.ok(r2.closed.includes(GP), JSON.stringify(r2.closed));
  });
  const SC = "Subscription gas sponsor CEILING reached";
  await acheck("sponsor ceiling: reached pages, ok clears, unknown or absent does neither; the body carries no figure", async () => {
    assert.equal(judge(withGateway({ subscriptionFeePayer: { status: "ok", ceiling: "reached" } }))[SC], "bad");
    assert.equal(judge(withGateway({ subscriptionFeePayer: { status: "low", ceiling: "reached" } }))[SC], "bad", "pages whatever the balance word");
    assert.equal(judge(withGateway({ subscriptionFeePayer: { status: "ok", ceiling: "ok" } }))[SC], "good");
    for (const g of [{ status: "ok", ceiling: "unknown" }, { status: "ok" }, { status: "unconfigured" }]) assert.equal(judge(withGateway({ subscriptionFeePayer: g }))[SC], "quiet", JSON.stringify(g));
    assert.equal(judge(withGateway({ subscriptionFeePayer: { status: "ok", ceiling: "reached" } }))["Subscription gas sponsor LOW (PathUSD)"], "good", "the balance alarm is its own");
    assert.doesNotMatch(ALARMS.find((x) => x.title === SC).body({}), /\$[0-9]|[0-9]+ (tx|transactions)/, "no figure in the body");
  });
  await acheck("sponsor ceiling reached opens the issue; below the ceiling closes it", async () => {
    mkGh();
    const bad = withGateway({ subscriptionFeePayer: { status: "ok", ceiling: "reached" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, bad) });
    assert.ok(r.opened.includes(SC), JSON.stringify(r.opened));
    mkGh([{ number: 79, title: SC }]);
    const good = withGateway({ subscriptionFeePayer: { status: "ok", ceiling: "ok" } });
    const r2 = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(good, good) });
    assert.ok(r2.closed.includes(SC), JSON.stringify(r2.closed));
  });
  await acheck("the sponsor-ceiling step in heartbeat.yml reads the same word, title and body as the Worker", async () => {
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    const step = yml.split("\n      - name: ").find((x) => x.startsWith("Subscription gas sponsor ceiling check")) || "";
    assert.ok(step.includes(".subscriptionFeePayer.ceiling"), "reads the ceiling word");
    assert.ok(step.includes(`TITLE="${SC}"`), "same title");
    assert.ok(step.includes(ALARMS.find((x) => x.title === SC).body({})), "same body");
    assert.match(step, /\[ "\$WORD" = "reached" \][\s\S]*gh issue create/, "reached opens");
    assert.match(step, /\[ "\$WORD" = "ok" \] && \[ -n "\$OPEN" \][\s\S]*gh issue close/, "ok closes");
  });
  const LS = "Late settlements need attention";
  await acheck("each late-settlement word maps to page, clear or quiet; the body echoes only known words", async () => {
    for (const w of ["unresolved", "full"]) assert.equal(judge(withGateway({ lateSettlements: { status: w } }))[LS], "bad", w);
    for (const w of ["ok", "near_capacity"]) assert.equal(judge(withGateway({ lateSettlements: { status: w } }))[LS], "good", w);
    for (const w of ["unknown", "something-new"]) assert.equal(judge(withGateway({ lateSettlements: { status: w } }))[LS], "quiet", w);
    assert.equal(judge({ gateway: {} })[LS], "quiet", "a gateway without the field (an older build) changes nothing");
    const a = ALARMS.find((x) => x.title === LS);
    assert.doesNotMatch(a.body({ gateway: { lateSettlements: { status: "<script>" } } }), /<script/i);
    assert.match(a.body({ gateway: { lateSettlements: { status: "full" } } }), /lateSettlements\.status=full\./);
    assert.doesNotMatch(a.body({ gateway: { lateSettlements: { status: "unresolved" } } }), /[0-9]/, "the body carries no figure");
    const named = a.body({ gateway: { lateSettlements: { status: "unresolved" } } });
    assert.match(named, /POST \/__operator\/late-settlements: action resolve/, "the body names the operator action that clears it");
    assert.match(named, /booked_owed/);
    assert.match(named, /acknowledge_unrecorded/);
  });
  await acheck("an unresolved late settlement opens the issue; ok closes it", async () => {
    mkGh();
    const bad = withGateway({ lateSettlements: { status: "unresolved" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, bad) });
    assert.ok(r.opened.includes(LS), JSON.stringify(r.opened));
    mkGh([{ number: 78, title: LS }]);
    const good = withGateway({ lateSettlements: { status: "ok" } });
    const r2 = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(good, good) });
    assert.ok(r2.closed.includes(LS), JSON.stringify(r2.closed));
  });
  await acheck("the late-settlement step in heartbeat.yml carries the Worker's title and body", async () => {
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    const step = yml.split("\n      - name: ").find((x) => x.startsWith("Late settlements check")) || "";
    assert.ok(step.includes(`TITLE="${LS}"`), "same title");
    const body = ALARMS.find((x) => x.title === LS).body({ gateway: { lateSettlements: { status: "full" } } }).replace("status=full.", "status=$WORD.");
    assert.ok(step.includes(body), "same body");
    assert.match(step, /\n\s+ok\|near_capacity\)\n/, "ok and near_capacity close the issue, as in the Worker");
  });
  await acheck("an in-doubt tweet post confirmed by a second read opens the issue", async () => {
    mkGh();
    const bad = withGateway({ tweetQueue: { status: "in_doubt" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, bad) });
    assert.deepEqual(r.opened, [TQ]);
    assert.match(created[0].body, /tweetQueue\.status=in_doubt/);
    assert.match(created[0].body, /\/__operator\/tweet-queue\.json/);
  });
  await acheck("a retrying queue neither opens nor closes the issue", async () => {
    mkGh([{ number: 31, title: TQ }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(withGateway({ tweetQueue: { status: "retrying" } })) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.closed, []);
  });
  await acheck("ok closes it", async () => {
    mkGh([{ number: 31, title: TQ }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(withGateway({ tweetQueue: { status: "ok" } })) });
    assert.deepEqual(r.closed, [TQ]);
  });
  await acheck("the issue body echoes only a known word", async () => {
    const a = ALARMS.find((x) => x.title === TQ);
    assert.match(a.body({ gateway: { tweetQueue: { status: "<script>" } } }), /tweetQueue\.status=unknown/);
  });

  // The write cap: opens before closes, and what a run could not write is
  // written by the next one.
  await acheck("issue writes are capped per run: opens first, the rest wait for the next run", async () => {
    const titles = ALARMS.map((a) => a.title);
    const allOpen = titles.filter((t) => t !== "Upstream buyer wallet LOW (x402)").map((title, i) => ({ number: i + 1, title }));
    const everythingHealthy = { gateway: { ...HEALTHY_GATEWAY, upstreamBuyer: { status: "low", trend: "ok" }, tweetQueue: { status: "ok" }, circlePending: { status: "ok" }, gatewayPending: { status: "ok" }, lateSettlements: { status: "ok" }, chargedFailures: { status: "ok" }, refundsOwed: { status: "ok" }, ledgerDeadLetter: { status: "none" }, redisPersistence: { status: "on" }, backup: { status: "ok" }, outboundDestinations: { status: "new" }, upstreamBuyerSvm: { status: "ok" }, stellarFacilitator: { status: "ok" }, upstreamBudgets: { status: "ok" }, upstreamHardCaps: { status: "ok" }, exaAllowance: { status: "ok" }, xDataSpend: { status: "ok" }, exaSpend: { status: "ok" }, routerSpendWindow: { status: "ok" }, gatewayBalance: { status: "ok" }, sharedLimits: { status: "on", alert: "ok" }, replayStore: { status: "ok", alert: "ok" }, stateDb: { status: "on" }, sanctions: { status: "ok" }, sanctionsScreen: { status: "fresh" }, email: { status: "ok" }, upstreamCosts: { status: "ok" }, mppReconcile: { status: "ok", window7d: "ok", chargedFailedStatus: "ok" }, toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, toolAnswers: { status: "ok" }, containedTurns: { status: "ok" }, brokenListings: { status: "ok" }, topBuyerFailures: { status: "ok" }, buyerRefusals: { status: "ok" }, settleFailures: { status: "ok" }, unsettledReports: { status: "ok" }, robinhoodSettler: { status: "ok" }, subscriptionRenewals: { status: "ok" }, directUpstream: { status: "ok" }, creditsRefunds: { status: "ok" }, cdnOrigin: { status: "ok" } }, status: HEALTHY_STATUS };
    mkGh(allOpen);
    const r1 = await syncAlarms(ENV, { ...nosleep, maxWrites: 4, probe: { paywallObserved: true }, fetchStatus: feed(everythingHealthy, everythingHealthy) });
    assert.deepEqual(r1.opened, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(r1.closed.length, 3);
    assert.equal(created.length + closed.length, 4, "no more than the cap");
    assert.equal(r1.deferred.length, allOpen.length - 3);
    const stillOpen = allOpen.filter((x) => !r1.closed.includes(x.title));
    mkGh([...stillOpen, { number: 999, title: "Upstream buyer wallet LOW (x402)" }]);
    const r2 = await syncAlarms(ENV, { ...nosleep, maxWrites: 100, probe: { paywallObserved: true }, fetchStatus: feed(everythingHealthy, everythingHealthy) });
    assert.deepEqual(r2.opened, [], "the open landed last run and is not repeated");
    // A closeAfterTwoOk alarm's first ok read is a mark (one write), not a close.
    assert.deepEqual(new Set([...r2.closed, ...r2.clearing]), new Set(r1.deferred), "the next run writes exactly what was deferred");
    assert.ok(r2.clearing.every((t) => ALARMS.find((a) => a.title === t)?.closeAfterTwoOk), `only the two-ok alarms are marked (${r2.clearing})`);
  });

  // Words that only heartbeat.yml watched until 2026-10-20. Each maps to
  // page, clear or quiet exactly as that workflow's step does (unknown and
  // absent never page and never close).
  await acheck("each moved gateway-status word maps to page, clear or quiet", async () => {
    const cases = [
      ["Solana upstream buyer wallet LOW (x402)", "upstreamBuyerSvm", ["low"], ["ok"]],
      ["containedTurns: a scheduled turn is throwing every minute", "containedTurns", ["repeating"], ["ok"]],
      // Listings of many distinct origins failing to read inside the window (src/x402-index.js).
      ["brokenListings: seller listings are failing to read across many origins", "brokenListings", ["widespread"], ["ok"]],
      ["Stellar facilitator fee account LOW (XLM)", "stellarFacilitator", ["low"], ["ok"]],
      ["Upstream call budget ELEVATED", "upstreamBudgets", ["elevated"], ["ok"]],
      ["Upstream hard ceiling REACHED", "upstreamHardCaps", ["capped"], ["ok"]],
      ["Exa prepaid allowance LOW", "exaAllowance", ["low"], ["ok", "unconfigured"]],
      ["X data daily spend OVER its ceiling", "xDataSpend", ["over", "capped"], ["ok", "off"]],
      ["Exa daily spend OVER its ceiling", "exaSpend", ["over", "capped"], ["ok", "off"]],
      ["Router spend per minute OVER its ceiling", "routerSpendWindow", ["over", "capped"], ["ok", "off"]],
      ["State database DEGRADED (Postgres)", "stateDb", ["degraded"], ["on"]],
      ["Sanctions lists STALE or UNLOADED (OFAC SDN)", "sanctions", ["stale", "unloaded"], ["ok"]],
      ["Payment-party screen STALE or MISSING (OFAC SDN)", "sanctionsScreen", ["stale", "missing"], ["fresh"]],
      ["Transactional email is not sending", "email", ["exhausted", "failing"], ["ok"]],
      ["Upstream cost table missing or incomplete in production", "upstreamCosts", ["missing", "partial"], ["ok"]],
      // A paying buyer refused by the settle breaker (src/gateway-settle-breaker.js).
      ["buyerRefusals: a paying buyer was refused by the settle breaker", "buyerRefusals", ["refusing"], ["ok"]],
      // Distinct buyers' /v1 payments failing to settle (an alarm only, src/gateway-settle-breaker.js).
      ["settleFailures: a burst of buyers' payments verified and then failed to settle", "settleFailures", ["burst"], ["ok"]],
      // Report runs served and then unsettled (an alarm only, src/composite-spend-guard.js).
      ["unsettledReports: a burst of report runs were served and then did not settle", "unsettledReports", ["burst"], ["ok"]],
      // The direct upstream (src/gateway-direct-pricebook.js); starting does neither.
      ["directUpstream: the direct upstream is degraded", "directUpstream", ["degraded"], ["ok", "off"]],
    ];
    for (const [T, field, bad, good] of cases) {
      assert.ok(ALARMS.some((a) => a.title === T), `the Worker has "${T}"`);
      for (const w of bad) assert.equal(judge({ gateway: { [field]: { status: w } } })[T], "bad", `${field}=${w}`);
      for (const w of good) assert.equal(judge({ gateway: { [field]: { status: w } } })[T], "good", `${field}=${w}`);
      for (const w of ["unknown", "something-new"]) assert.equal(judge({ gateway: { [field]: { status: w } } })[T], "quiet", `${field}=${w}`);
      assert.equal(judge({ gateway: {} })[T], "quiet", `${field} absent`);
    }
    const D = "MPP reconciliation MISMATCH";
    assert.equal(judge({ gateway: { mppReconcile: { status: "mismatch" } } })[D], "bad");
    assert.equal(judge({ gateway: { mppReconcile: { status: "ok" } } })[D], "good");
    assert.equal(judge({ gateway: { mppReconcile: { status: "unknown" } } })[D], "quiet");
    const C = "MPP paid-but-failed call";
    assert.equal(judge({ gateway: { mppReconcile: { chargedFailedStatus: "charged_failed" } } })[C], "bad");
    assert.equal(judge({ gateway: { mppReconcile: { chargedFailedStatus: "ok" } } })[C], "good");
    assert.equal(judge({ gateway: { mppReconcile: { chargedFailedStatus: "unknown" } } })[C], "quiet");
  });

  await acheck("issue bodies of the moved words echo only known words", async () => {
    const body = (T, gateway) => ALARMS.find((a) => a.title === T).body({ gateway });
    assert.match(body("Sanctions lists STALE or UNLOADED (OFAC SDN)", { sanctions: { status: "<x>" } }), /reads stale on/);
    assert.match(body("Payment-party screen STALE or MISSING (OFAC SDN)", { sanctionsScreen: { status: "missing" } }), /reads missing on/);
    assert.match(body("Transactional email is not sending", { email: { status: "<x>" } }), /email\.status=exhausted\./);
    assert.match(body("Upstream cost table missing or incomplete in production", { upstreamCosts: { status: "partial" } }), /upstreamCosts\.status=partial\./);
    const br = body("buyerRefusals: a paying buyer was refused by the settle breaker", { buyerRefusals: { status: "<x>", refusalsWindow: 7 } });
    assert.match(br, /buyerRefusals\.status=refusing\./);
    assert.match(br, /\/__operator\/tool-failures\.json/);
    assert.doesNotMatch(br, /\b7\b|0x|<x>/, "the body carries the word and the operator endpoint, never a count or an address");
    const sf = body("settleFailures: a burst of buyers' payments verified and then failed to settle", { settleFailures: { status: "<x>", buyersInWindow: 7 } });
    assert.match(sf, /settleFailures\.status=burst\./);
    assert.match(sf, /No request is refused for it/);
    assert.doesNotMatch(sf, /\b7\b|0x|<x>/, "the body carries the word and the operator read, never a count or an address");
    const ur = body("unsettledReports: a burst of report runs were served and then did not settle", { unsettledReports: { status: "<x>", unsettledInWindow: 7 } });
    assert.match(ur, /unsettledReports\.status=burst\./);
    assert.match(ur, /No request is refused for it/);
    assert.doesNotMatch(ur, /\b7\b|0x|<x>/, "the body carries the word and the operator read, never a count or an address");
    const rec = body("MPP reconciliation MISMATCH", { mppReconcile: { status: "mismatch", day: "2026-10-14", categories: { paid_unrecorded: "mismatch", served_unpaid: "ok", "<b>": "mismatch" } } });
    assert.match(rec, /for 2026-10-14 found/);
    assert.match(rec, /categories: paid_unrecorded\)/);
    assert.match(body("MPP reconciliation MISMATCH", { mppReconcile: { day: "<script>" } }), /for the latest day found/);
  });

  // window7d: the seven days ending at the latest reconciled day. A day's
  // own alarm closes when the next day reads ok; this keeps an unresolved
  // mismatch visible while it is still in the window.
  const WIN = "MPP reconciliation 7-day window MISMATCH";
  await acheck("window7d: mismatch pages only while the latest day reads ok", async () => {
    const j = (r) => judge({ gateway: { mppReconcile: r } })[WIN];
    assert.equal(j({ status: "ok", window7d: "mismatch" }), "bad");
    assert.equal(j({ status: "mismatch", window7d: "mismatch" }), "quiet", "the daily alarm owns a mismatched day: one event, one page");
    assert.equal(j({ status: "unknown", window7d: "mismatch" }), "quiet", "a stale or unread day says nothing about the window's age");
    assert.equal(j({ status: "ok", window7d: "ok" }), "good");
    assert.equal(j({ status: "mismatch", window7d: "ok" }), "good");
    assert.equal(j({ status: "ok", window7d: "unknown" }), "quiet");
    assert.equal(judge({ gateway: {} })[WIN], "quiet");
  });
  await acheck("window7d: a mismatch confirmed by a second read opens one issue; one read alone opens nothing", async () => {
    const win = withGateway({ mppReconcile: { status: "ok", day: "2026-10-19", window7d: "mismatch", chargedFailedStatus: "ok" } });
    mkGh();
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(win, win) });
    assert.deepEqual(r.opened, [WIN]);
    assert.match(created[0].body, /latest day \(2026-10-19\) reads ok/);
    assert.match(created[0].body, /\/__operator\/mpp-reconcile\.json/);
    mkGh();
    const r2 = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(win, withGateway({ mppReconcile: { status: "unknown", window7d: "unknown" } })) });
    assert.deepEqual(r2.opened, []);
    mkGh([{ number: 41, title: WIN }]);
    const r3 = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(withGateway({ mppReconcile: { status: "ok", window7d: "ok", chargedFailedStatus: "ok" } })) });
    assert.deepEqual(r3.closed, [WIN]);
  });

  // The class guard: a heartbeat.yml step that reads a word on the public
  // /api/gateway-status must also be a Worker alarm, so a new word cannot
  // again be watched only by a schedule GitHub delivers hours late.
  await acheck("every heartbeat.yml step that reads /api/gateway-status is also a Worker alarm", async () => {
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    const steps = yml.split("\n      - name: ").slice(1);
    const titles = new Set(ALARMS.map((a) => a.title));
    let n = 0;
    for (const s of steps) {
      if (!s.includes("/api/gateway-status")) continue;
      for (const m of s.matchAll(/(?<![A-Z_])TITLE2?="([^"]+)"/g)) { n++; assert.ok(titles.has(m[1]), `heartbeat-only alarm: "${m[1]}"`); }
    }
    assert.ok(n >= 25, `found only ${n} gateway-status titles in heartbeat.yml`);
  });

  await acheck("the Postgres body names what the leads database still carries, not the retired waitlist", async () => {
    const b = ALARMS.find((a) => a.title === "Postgres UNREACHABLE (leads/analytics)").body({ gateway: { databases: { leads: { status: "unreachable" }, analytics: { status: "<x>" } } } });
    assert.doesNotMatch(b, /tollbooth/i);
    assert.match(b, /leads=unreachable, analytics=unknown/);
  });

  await acheck("every alarm title also exists in the GitHub workflow that raises it, so the two never fork", async () => {
    const yml = (await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"))
      + (await readFile(new URL("../.github/workflows/charged-failure-alert.yml", import.meta.url), "utf8"));
    for (const a of ALARMS) assert.ok(yml.includes(a.title), `no workflow has "${a.title}"`);
    const { DOWN_TITLE } = await import("../workers/status-probe/src/index.js");
    assert.ok(yml.includes(DOWN_TITLE), `heartbeat.yml has no "${DOWN_TITLE}"`);
  });

  await acheck("EVM chains wallet: low pages, ok and off clear; unreadable pages only after an hour", async () => {
    const { judge } = await import("../workers/status-probe/src/index.js");
    const LOW = "EVM chains upstream buyer wallet LOW (x402)", UNR = "EVM chains upstream buyer wallet UNREADABLE (x402)";
    const j = (e) => judge({ gateway: { upstreamBuyerEvm: e } });
    assert.equal(j({ status: "low" })[LOW], "bad");
    assert.equal(j({ status: "ok" })[LOW], "good");
    assert.equal(j({ status: "off" })[LOW], "good");
    assert.equal(j({ status: "unknown", unknownForMinutes: 500 })[LOW], "quiet");
    assert.equal(j({ status: "unknown", unknownForMinutes: 59 })[UNR], "quiet");
    assert.equal(j({ status: "unknown", unknownForMinutes: 60 })[UNR], "bad");
    assert.equal(j({ status: "off" })[UNR], "good");
    assert.equal(j({ status: "low" })[UNR], "good");
    assert.equal(judge({ gateway: {} })[UNR], "quiet");
    assert.equal(judge({ gateway: {} })[LOW], "quiet");
  });

  await acheck("charged failures: recent pages, ok clears, unknown or absent does neither", async () => {
    const { judge } = await import("../workers/status-probe/src/index.js");
    const T = "Charged failure: a paid tool returned an error to a paying agent";
    assert.equal(judge({ gateway: { chargedFailures: { status: "recent" } } })[T], "bad");
    assert.equal(judge({ gateway: { chargedFailures: { status: "ok" } } })[T], "good");
    assert.equal(judge({ gateway: { chargedFailures: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
  });

  await acheck("refunds owed: owed, aging and stuck page, ok clears, unknown or absent does neither; body echoes only known words", async () => {
    const { judge, ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Refunds owed to a buyer are waiting";
    assert.equal(judge({ gateway: { refundsOwed: { status: "owed" } } })[T], "bad");
    assert.equal(judge({ gateway: { refundsOwed: { status: "aging" } } })[T], "bad");
    assert.equal(judge({ gateway: { refundsOwed: { status: "stuck" } } })[T], "bad");
    assert.equal(judge({ gateway: { refundsOwed: { status: "ok" } } })[T], "good");
    assert.equal(judge({ gateway: { refundsOwed: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
    const a = ALARMS.find((x) => x.title === T);
    assert.match(a.body({ gateway: { refundsOwed: { status: "stuck" } } }), /refundsOwed\.status=stuck/);
    // An unexpected word is never echoed: the body names only a known word.
    assert.match(a.body({ gateway: { refundsOwed: { status: "<b>x</b>" } } }), /refundsOwed\.status=owed\./);
    const owedBody = a.body({ gateway: { refundsOwed: { status: "owed" } } });
    assert.match(owedBody, /refundsOwed\.status=owed\./);
    assert.match(owedBody, /actions\/workflows\/refund\.yml/);
    assert.match(owedBody, /dry run first, then live/);
    assert.match(owedBody, /human-checkout\.json/, "an owed card refund is read on the report store's operator list");
    assert.doesNotMatch(owedBody, /0x[0-9a-fA-F]{40}|\$\d/);
  });

  await acheck("outbound destinations: burst pages, ok and new clear, unknown or absent does neither; body never carries a word from the response", async () => {
    const { judge, ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Outbound payments reached a burst of NEW destinations";
    assert.equal(judge({ gateway: { outboundDestinations: { status: "burst" } } })[T], "bad");
    assert.equal(judge({ gateway: { outboundDestinations: { status: "ok" } } })[T], "good");
    assert.equal(judge({ gateway: { outboundDestinations: { status: "new" } } })[T], "good", "a first buy from a newly proven seller is expected, never a page");
    assert.equal(judge({ gateway: { outboundDestinations: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: { outboundDestinations: { status: "<b>x</b>" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
    const a = ALARMS.find((x) => x.title === T);
    const body = a.body({ gateway: { outboundDestinations: { status: "<b>x</b>" } } });
    assert.match(body, /outboundDestinations\.status=burst/);
    assert.doesNotMatch(body, /<b>/, "the body is fixed text, never an echo of the response");
    assert.match(body, /\/__operator\/outbound-destinations\.json/, "it points at the operator listing, the only place an address is read");
    assert.doesNotMatch(body, /0x[0-9a-f]{40}/i, "no address in the alarm text");
  });

  await acheck("ledger dead-letter: stuck and local page, none and off clear, pending and unknown do neither", async () => {
    const { judge, ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Ledger rows waiting on local disk (dead-letter stuck)";
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "stuck" } } })[T], "bad");
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "local" } } })[T], "bad");
    const a = ALARMS.find((x) => x.title === T);
    assert.match(a.body({ gateway: { ledgerDeadLetter: { status: "local" } } }), /ledgerDeadLetter\.status=local\./);
    // An unexpected word is never echoed.
    assert.match(a.body({ gateway: { ledgerDeadLetter: { status: "<b>x</b>" } } }), /ledgerDeadLetter\.status=stuck\./);
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "none" } } })[T], "good");
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "off" } } })[T], "good");
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "pending" } } })[T], "quiet");
    assert.equal(judge({ gateway: { ledgerDeadLetter: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
  });

  await acheck("ledger dead-letter: the worker's and heartbeat.yml's issue bodies name all six journals and their log lines", async () => {
    const { ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Ledger rows waiting on local disk (dead-letter stuck)";
    const worker = ALARMS.find((x) => x.title === T).body({ gateway: { ledgerDeadLetter: { status: "stuck" } } });
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    const step = yml.slice(yml.indexOf(`TITLE="${T}"`), yml.indexOf("gh issue close", yml.indexOf(`TITLE="${T}"`)));
    assert.ok(step.length > 0, "heartbeat.yml has the dead-letter step");
    for (const [name, text] of [["worker", worker], ["heartbeat.yml", step]]) {
      assert.ok(text.includes("a sale, a refund debt, a card report's final record, a subscription record, a decide write or an outbound payment record"), `${name} names the six journals`);
      assert.ok(text.includes("Each journal's replay retries on a timer"), `${name} says each replay retries on a timer`);
      for (const tag of ["[sales-ledger]", "[refund-ledger]", "[human-checkout]", "[subscriptions]", "[decide]", "[outbound-ledger]"]) assert.ok(text.includes(tag), `${name} lists the ${tag} log lines`);
      assert.ok(text.includes("counts per journal"), `${name} says the operator view has the counts per journal`);
    }
  });

  await acheck("redis persistence: off and degraded page, on clears, unknown and absent do neither; body echoes only known words", async () => {
    const { judge, ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Redis append-only persistence is not on";
    assert.equal(judge({ gateway: { redisPersistence: { status: "off" } } })[T], "bad");
    assert.equal(judge({ gateway: { redisPersistence: { status: "degraded" } } })[T], "bad");
    assert.equal(judge({ gateway: { redisPersistence: { status: "on" } } })[T], "good");
    assert.equal(judge({ gateway: { redisPersistence: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
    assert.equal(judge(HEALTHY)[T], "quiet", "a gateway without the field (an older build) changes nothing");
    const a = ALARMS.find((x) => x.title === T);
    assert.match(a.body({ gateway: { redisPersistence: { status: "degraded" } } }), /redisPersistence\.status=degraded\./);
    // An unexpected word is never echoed.
    assert.match(a.body({ gateway: { redisPersistence: { status: "<b>x</b>" } } }), /redisPersistence\.status=off\./);
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    const step = yml.slice(yml.indexOf(`TITLE="${T}"`), yml.indexOf("gh issue close", yml.indexOf(`TITLE="${T}"`)));
    assert.ok(step.length > 0, "heartbeat.yml has the Redis persistence step");
    for (const [name, text] of [["worker", a.body({ gateway: { redisPersistence: { status: "off" } } })], ["heartbeat.yml", step]]) {
      assert.ok(text.includes("--appendonly yes --appendfsync everysec"), `${name} names the start command`);
      assert.ok(text.includes("INFO persistence"), `${name} says to read INFO persistence`);
      assert.ok(text.includes("LEDGER_JOURNAL_REDIS has no effect until it reads on"), `${name} says the journals stay on local disk`);
      assert.ok(text.includes("Auto-closes when the word is on"), `${name} says when it closes`);
    }
  });

  await acheck("offsite backup: held, failed, stale, unencrypted and unconfigured page, ok clears, off and unknown do neither; body echoes only known words", async () => {
    const { judge, ALARMS } = await import("../workers/status-probe/src/index.js");
    const T = "Offsite backup is not current";
    for (const w of ["held", "failed", "stale", "unencrypted", "unconfigured"]) assert.equal(judge({ gateway: { backup: { status: w } } })[T], "bad", w);
    assert.equal(judge({ gateway: { backup: { status: "ok" } } })[T], "good");
    assert.equal(judge({ gateway: { backup: { status: "off" } } })[T], "quiet");
    assert.equal(judge({ gateway: { backup: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
    const a = ALARMS.find((x) => x.title === T);
    assert.match(a.body({ gateway: { backup: { status: "held" } } }), /backup\.status=held\./);
    assert.match(a.body({ gateway: { backup: { status: "unconfigured" } } }), /backup\.status=unconfigured\.[\s\S]*- unconfigured: the BACKUP_S3_\* bucket variables are unset in production/);
    assert.match(a.body({ gateway: { backup: { status: "<b>x</b>" } } }), /backup\.status=unknown\./);
  });

  await acheck("production DOWN: opens only after the confirm reads also fail; a blip opens nothing; recovery closes", async () => {
    const { syncOutage, DOWN_TITLE } = await import("../workers/status-probe/src/index.js");
    mkGh([]);
    let reads = 0;
    const r1 = await syncOutage(ENV, { apiFailed: true, detail: "api(health 503)", sleep: async () => {}, healthRead: async () => { reads++; return false; } });
    assert.equal(r1.action, "opened");
    assert.equal(reads, 2, "two confirm reads before opening");
    assert.equal(created.length, 1);
    mkGh([]);
    const r2 = await syncOutage(ENV, { apiFailed: true, sleep: async () => {}, healthRead: async () => true });
    assert.equal(r2.action, "none", "a deploy blip that answers on a confirm read opens nothing");
    assert.equal(created.length, 0);
    mkGh([{ number: 5, title: DOWN_TITLE }]);
    const r3 = await syncOutage(ENV, { apiFailed: false, sleep: async () => {} });
    assert.equal(r3.action, "closed");
    mkGh([{ number: 5, title: DOWN_TITLE }]);
    const r4 = await syncOutage(ENV, { apiFailed: true, sleep: async () => {}, healthRead: async () => false });
    assert.equal(r4.action, "none", "an open outage issue is not duplicated");
  });

  globalThis.fetch = realFetch;
}

// --- the deploy workflow ---------------------------------------------------
// Nothing deployed this Worker for a month: CI tested workers/status-probe on
// every push and no step shipped it, so on 2026-08-30 the live code was from
// 07-29 with three merged commits behind it. A deploy step fixes that instance;
// what rots is the step itself, so pin the two properties that make it worth
// having - it fails loudly with no credential, and it proves the deploy against
// the RUNNING Worker rather than trusting wrangler's exit code.
{
  const wf = await readFile(new URL("../.github/workflows/deploy-status-probe.yml", import.meta.url), "utf8");
  const acheck = (name, cond) => {
    if (cond) { console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name}`); }
  };
  acheck("it deploys on a push to main that touches the worker", /branches:\s*\[main\]/.test(wf) && /workers\/status-probe\/\*\*/.test(wf));
  acheck("a missing CLOUDFLARE_API_TOKEN FAILS the run, never a silent pass", /::error::CLOUDFLARE_API_TOKEN is not set/.test(wf) && /exit 1/.test(wf));
  acheck("the sha is injected so the running Worker can be asked what it is", /--var BUILD_SHA:/.test(wf));
  acheck("the deploy is verified against the live Worker, not wrangler's exit code", /\/run/.test(wf) && /\.recorded == true/.test(wf));
  // It must POLL for propagation (Cloudflare's edge lags a deploy by seconds)
  // but still FAIL if the new build never arrives: "deployed but not serving"
  // is the state this check exists to catch.
  acheck("and the verify requires the reported build to BE the deployed sha", /still reports build \$BUILD, not \$GITHUB_SHA/.test(wf));
  acheck("it polls for edge propagation rather than reading once", /edge still serving/.test(wf) && /for i in \$\(seq 1 20\)/.test(wf));
  acheck("a daily drift check exists and can page", /schedule:/.test(wf) && /Status probe Worker is NOT the code on main/.test(wf));
  acheck("an unreadable Worker is 'unknown', never reported as drift", /state=unknown/.test(wf));
  acheck("the drift issue auto-closes on recovery", /gh issue close/.test(wf));
  // The Worker has to actually serve the identity the workflow reads.
  const src = await readFile(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  acheck("the Worker serves /version with its BUILD_SHA", /"\/version"/.test(src) && /env\.BUILD_SHA/.test(src));
  acheck("the deploy pins wrangler to an exact version", /npx --yes wrangler@\d+\.\d+\.\d+ deploy/.test(wf) && !/wrangler@\d+ /.test(wf));
}

{
  // Manual triggers: STATUS_PROBE_TOKEN only, compared in constant time.
  const mod = await import("../workers/status-probe/src/index.js");
  const { tokenEquals, probeToken } = mod;
  const worker = mod.default;
  check("tokenEquals: equal matches; a differing byte, a different length, or an empty expected token does not", () => {
    assert.equal(tokenEquals("abcdef", "abcdef"), true);
    assert.equal(tokenEquals("abcdeF", "abcdef"), false);
    assert.equal(tokenEquals("abcdefg", "abcdef"), false);
    assert.equal(tokenEquals("", ""), false);
    assert.equal(tokenEquals(null, "abcdef"), false);
  });
  check("probeToken reads STATUS_PROBE_TOKEN only, never the root operator token", () => {
    assert.equal(probeToken({ OPERATOR_TOKEN: "root" }), "");
    assert.equal(probeToken({ STATUS_PROBE_TOKEN: "narrow", OPERATOR_TOKEN: "root" }), "narrow");
  });
  const env = { STATUS_PROBE_TOKEN: "narrow-token", OPERATOR_TOKEN: "root-token" };
  for (const path of ["/run", "/verify"]) {
    const wrong = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST", headers: { "X-Operator-Token": "narrow-tokeX" } }), env);
    const root = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST", headers: { "X-Operator-Token": "root-token" } }), env);
    const none = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST" }), env);
    check(`${path}: a wrong token, the root operator token, or none is 401`, () => {
      assert.equal(wrong.status, 401); assert.equal(root.status, 401); assert.equal(none.status, 401);
    });
  }
  const verifyOk = await worker.fetch(new Request("https://w.test/verify", { method: "POST", headers: { "X-Operator-Token": "narrow-token" } }), { STATUS_PROBE_TOKEN: "narrow-token" });
  check("/verify: the right token passes the gate (control)", () => {
    assert.equal(verifyOk.status, 200);
  });
  const src = await readFile(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  check("no direct !== compare against the trigger token remains", () => {
    assert.ok(!/get\("X-Operator-Token"\) !== want/.test(src));
  });
}

// --- Paywall not observed ---------------------------------------------------
// A caller spending the unpaid-quote budget from the Worker's address keeps
// every paywall read unobserved. Driven through run() against a production
// stub whose status store works like the real one: an observed run records a
// paywall row, and /api/status reports the newest row's age. Five-minute runs:
// two unobserved in a row do not page, the third pages once, a fourth does not
// page again, and the next observed read closes it.
{
  const { ALARMS, PAYWALL_UNOBSERVED_TITLE: T, PAYWALL_UNOBSERVED_PAGE_AFTER_RUNS, PROBE_CADENCE_MS, judge } = await import("../workers/status-probe/src/index.js");
  check("the paywall alarm pages after three unobserved runs at the five-minute cadence", () => {
    assert.equal(T, "Paywall not observed");
    assert.equal(PAYWALL_UNOBSERVED_PAGE_AFTER_RUNS, 3);
    assert.equal(PROBE_CADENCE_MS, 5 * 60_000);
    assert.ok(ALARMS.some((a) => a.title === T));
  });
  const budget429 = () => Response.json({ ok: false, error: "rate-limited", reason: "unpaid-quote-budget", retryAfterSeconds: 1800 }, { status: 429, headers: { "retry-after": "1800" } });
  let clock = 0;            // the stub's own minutes clock
  let lastPaywallTs = null; // the store's newest paywall row
  let blind = false;
  let issues = [];          // open issues by title
  let created = [], closedNums = [];
  stub({ extract: () => (blind ? budget429() : new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453"]) } })) });
  const prodStub = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/api/status/probe")) {
      const b = JSON.parse(init.body);
      if (b.components && "paywall" in b.components) lastPaywallTs = clock;
      return new Response("{}", { status: 200 });
    }
    if (u.endsWith("/api/gateway-status")) return Response.json({ status: "ok" });
    if (u.endsWith("/api/status")) return Response.json({ components: lastPaywallTs == null ? [] : [{ key: "paywall", current: { state: "operational", ageMs: clock - lastPaywallTs } }] });
    if (u === "https://api.github.com/user") return Response.json({ login: "probe-bot" });
    if (u.includes("/issues?state=open")) return Response.json(issues.map((x) => ({ number: x.number, title: x.title, body: "", user: { login: "probe-bot" } })));
    if (u.endsWith("/issues") && init.method === "POST") {
      const t = JSON.parse(init.body).title; const number = 500 + created.length;
      created.push(t); issues.push({ number, title: t });
      return Response.json({ number }, { status: 201 });
    }
    const m = u.match(/\/issues\/(\d+)$/);
    if (m && init.method === "PATCH" && JSON.parse(init.body).state === "closed") {
      closedNums.push(Number(m[1])); issues = issues.filter((x) => x.number !== Number(m[1]));
      return Response.json({});
    }
    if (new URL(u).hostname === "api.github.com") return new Response("{}", { status: 200 });
    return prodStub(url, init);
  };
  const ENV = { PROD, STATUS_PROBE_TOKEN: TOKEN, GITHUB_ISSUES_TOKEN: "t" };
  const tick = async (isBlind) => { blind = isBlind; const out = await run(ENV, { sleep: async () => {} }); clock += PROBE_CADENCE_MS; return out; };
  const pages = () => created.filter((t) => t === T).length;
  const r0 = await tick(false);
  const r1 = await tick(true);
  const r2 = await tick(true);
  check("one and two unobserved runs in a row: no page", () => {
    assert.equal(r0.paywall.observed, true);
    assert.equal(r1.paywall.observed, false);
    assert.equal(r2.paywall.observed, false);
    assert.equal(pages(), 0, `created ${created.join(", ")}`);
  });
  const r3 = await tick(true);
  check("three unobserved runs in a row: one page, under its own title", () => {
    assert.equal(pages(), 1);
    assert.deepEqual(r3.alarms.opened, [T]);
  });
  await tick(true);
  check("a fourth unobserved run: no second page", () => assert.equal(pages(), 1));
  const r5 = await tick(false);
  check("the next observed read closes it", () => {
    assert.deepEqual(r5.alarms.closed, [T]);
    assert.equal(issues.some((x) => x.title === T), false);
  });
  // The verdict on its own: observed is good, no probe facts or no paywall
  // row is quiet, never a page.
  check("the verdict: observed good; unobserved under three runs, no row, or no probe facts quiet", () => {
    const st = (ageMs) => ({ components: [{ key: "paywall", current: { ageMs } }] });
    assert.equal(judge({ status: st(0), probe: { paywallObserved: true } })[T], "good");
    assert.equal(judge({ status: st(10 * 60_000), probe: { paywallObserved: false } })[T], "quiet");
    assert.equal(judge({ status: st(15 * 60_000), probe: { paywallObserved: false } })[T], "bad");
    assert.equal(judge({ status: { components: [] }, probe: { paywallObserved: false } })[T], "quiet");
    assert.equal(judge({ status: null, probe: { paywallObserved: false } })[T], "quiet");
    assert.equal(judge({ status: st(60 * 60_000) })[T], "quiet");
  });
  // The paywall's age is its newest row from ANY observer: /api/status names
  // an outage row as current over a fresher operational one, so a stale
  // outage from another observer beside a fresh operational read is not
  // "unobserved", and the page names the newest row's age.
  check("the verdict reads the newest of the paywall's sources, not current's row", () => {
    const both = (outageAge, upAge) => ({ components: [{ key: "paywall", current: { state: "outage", ageMs: outageAge, source: "heartbeat", sources: [{ source: "status-worker", state: "operational", ageMs: upAge }, { source: "heartbeat", state: "outage", ageMs: outageAge }] } }] });
    assert.equal(judge({ status: both(40 * 60_000, 2 * 60_000), probe: { paywallObserved: false } })[T], "quiet");
    assert.equal(judge({ status: both(40 * 60_000, 20 * 60_000), probe: { paywallObserved: false } })[T], "bad");
    const alarm = ALARMS.find((a) => a.title === T);
    assert.match(alarm.body({ status: both(40 * 60_000, 20 * 60_000), probe: { paywallObserved: false } }), /about 20 minutes/);
  });
}

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
