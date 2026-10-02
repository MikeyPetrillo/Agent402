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
  // A Worker still holding only the ROOT operator token (mid-rotation) records
  // the other components with it, but never sends it to the public challenge
  // route: the paid-call check takes STATUS_PROBE_TOKEN or nothing.
  stub();
  const out = await run({ PROD, OPERATOR_TOKEN: "operator-root-token-aaaaaaaaaaaaaaaa" }, { sleep: async () => {} });
  check("with only OPERATOR_TOKEN, paid-call is skipped and the root token never leaves for a public route", () => {
    assert.equal(out.recorded, true);
    assert.equal(out.paidCall.observed, false);
    assert.ok(!seen.some((x) => x.u.includes("/api/pow/")), "asked for a challenge");
    const leaked = seen.filter((x) => !x.u.endsWith("/api/status/probe") && JSON.stringify(x.init?.headers || {}).includes("operator-root-token"));
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
  // closing an open issue (a comment and a PATCH each).
  let calls = 0;
  const HEALTHY_GW = { status: "ok", upstreamBuyer: { status: "low", trend: "ok" }, upstreamBuyerAvm: { status: "ok" }, upstreamBuyerTempo: { status: "ok" }, subscriptionFeePayer: { status: "ok" }, databases: { leads: { status: "ok" }, analytics: { status: "ok" } }, operatorAuth: { status: "ok" }, tweetQueue: { status: "ok" }, chargedFailures: { status: "ok", windowHours: 6 } };
  const { ALARMS } = await import("../workers/status-probe/src/index.js");
  stub({ health: () => new Response("down", { status: 503 }) });
  const prodStub = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    const u = String(url);
    if (u.endsWith("/api/gateway-status")) return Response.json(HEALTHY_GW);
    if (u.endsWith("/api/status")) return Response.json({ components: [{ key: "settlement", current: { state: "operational" } }] });
    if (u.includes("/issues?state=open")) return Response.json(ALARMS.filter((a) => a.title !== "Upstream buyer wallet LOW (x402)").map((a, i) => ({ number: i + 1, title: a.title })));
    if (u.startsWith("https://api.github.com")) return new Response("{}", { status: 200 });
    return prodStub(url, init);
  };
  const out = await run({ PROD, STATUS_PROBE_TOKEN: TOKEN, GITHUB_ISSUES_TOKEN: "t" }, { sleep: async () => {} });
  check(`worst-case run makes ${calls} subrequests, at least ten under the limit of 50`, () => {
    assert.equal(out.paidCall.observed, true, "the scenario must include the paid-call legs");
    assert.equal(out.alarms.closed.length, ALARMS.length - 1, "the scenario must include every close");
    assert.ok(calls <= 40, `${calls} subrequests`);
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
    status: "ok",
    upstreamBuyer: { status: "ok", trend: "ok" },
    upstreamBuyerAvm: { status: "ok" },
    upstreamBuyerTempo: { status: "ok" },
    subscriptionFeePayer: { status: "ok" },
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
      if (u.includes("/issues?state=open")) return Response.json(openIssues);
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

  // The class that filed #1057 on a perfectly healthy service: production is
  // volume-backed, so every deploy has a 60-90s no-container window and a
  // reading taken inside it is indistinguishable from a fault.
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

  await acheck("recovery closes the open issue, whoever opened it", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(closed.length, 1);
    // One subrequest per close: the close is the recovery record, no comment.
    assert.equal(comments.length, 0);
  });

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

  await acheck("every alarm title also exists in the GitHub workflow that raises it, so the two never fork", async () => {
    const yml = (await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"))
      + (await readFile(new URL("../.github/workflows/charged-failure-alert.yml", import.meta.url), "utf8"));
    for (const a of ALARMS) assert.ok(yml.includes(a.title), `no workflow has "${a.title}"`);
    const { DOWN_TITLE } = await import("../workers/status-probe/src/index.js");
    assert.ok(yml.includes(DOWN_TITLE), `heartbeat.yml has no "${DOWN_TITLE}"`);
  });

  await acheck("charged failures: recent pages, ok clears, unknown or absent does neither", async () => {
    const { judge } = await import("../workers/status-probe/src/index.js");
    const T = "Charged failure: a paid tool returned an error to a paying agent";
    assert.equal(judge({ gateway: { chargedFailures: { status: "recent" } } })[T], "bad");
    assert.equal(judge({ gateway: { chargedFailures: { status: "ok" } } })[T], "good");
    assert.equal(judge({ gateway: { chargedFailures: { status: "unknown" } } })[T], "quiet");
    assert.equal(judge({ gateway: {} })[T], "quiet");
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
}

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
