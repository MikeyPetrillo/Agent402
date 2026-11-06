// Tests for the opt-in tollbooth features: charge modes, analytics counters,
// adaptive proof-of-work, and per-challenge difficulty. Verifies the DEFAULTS
// are unchanged (so live deployments aren't affected) and the new behavior only
// kicks in when explicitly enabled. Drives the middleware directly with mocks.
import { createHash } from "node:crypto";
import { createTollbooth, createPow, memorySink, httpStatsSink } from "./index.js";
import { sqliteReplayStore, redisReplayStore } from "./replay.js";
import { dashboardHtml } from "./dashboard.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const mockReq = (headers = {}, url = "/x") => ({ headers, method: "GET", url, originalUrl: url, socket: { remoteAddress: "1.2.3.4" } });
function run(gate, req) {
  let nexted = false, status = 200, body = null; const hdrs = {};
  const res = { status(n) { status = n; return this; }, json(o) { body = o; return this; }, setHeader(k, v) { hdrs[k] = v; } };
  gate(req, res, () => { nexted = true; });
  return { nexted, status, body, hdrs };
}
const humanUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const botUA = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

// --- default "bots" mode unchanged (regression guard for live deployments) ---
let gate = createTollbooth({ powDifficulty: 12 });
ok(run(gate, mockReq({ "user-agent": humanUA })).nexted === true, "default: human UA passes free");
ok(run(gate, mockReq({ "user-agent": botUA })).status === 402, "default: AI bot UA charged");

// --- mode "all": charge everything (UA is not a security boundary) ---
gate = createTollbooth({ mode: "all", powDifficulty: 12 });
ok(run(gate, mockReq({ "user-agent": humanUA, accept: "text/html" })).status === 402, 'mode "all" charges humans too');
ok(run(gate, mockReq({})).status === 402, 'mode "all" charges no-UA clients');

// --- mode "strict": only real-browser requests pass ---
gate = createTollbooth({ mode: "strict", powDifficulty: 12 });
ok(run(gate, mockReq({ "user-agent": humanUA, accept: "text/html,application/xhtml+xml" })).nexted === true, "strict: browser + html accept passes free");
ok(run(gate, mockReq({ "user-agent": "curl/8.0", accept: "*/*" })).status === 402, "strict: curl charged");
ok(run(gate, mockReq({ "user-agent": humanUA, accept: "application/json" })).status === 402, "strict: browser UA without html accept charged");

// --- explicit charge()/free() still win over mode ---
gate = createTollbooth({ mode: "all", free: () => true });
ok(run(gate, mockReq({ "user-agent": botUA })).nexted === true, "free() wins over mode");

// --- analytics counters ---
gate = createTollbooth({ powDifficulty: 12 });
run(gate, mockReq({ "user-agent": humanUA })); // free
run(gate, mockReq({ "user-agent": botUA }));   // charged
const s = gate.stats();
ok(s.requests === 2 && s.freeAllowed === 1 && s.charged === 1, `stats count requests/free/charged (got ${JSON.stringify(s)})`);

// --- adaptive PoW: difficulty rises under load when enabled ---
gate = createTollbooth({ mode: "all", adaptive: true, powDifficulty: 14, adaptivePerBit: 3, maxDifficulty: 20 });
const first = run(gate, mockReq({})).body.proofOfWork.difficulty;
for (let i = 0; i < 9; i++) run(gate, mockReq({}));
const later = run(gate, mockReq({})).body.proofOfWork.difficulty;
ok(first === 14, `adaptive starts at base difficulty (got ${first})`);
ok(later > first && later <= 20, `adaptive difficulty rises under load, capped (got ${later})`);

// --- adaptive OFF (default): difficulty stays flat regardless of load ---
gate = createTollbooth({ mode: "all", powDifficulty: 14 });
const d0 = run(gate, mockReq({})).body.proofOfWork.difficulty;
for (let i = 0; i < 20; i++) run(gate, mockReq({}));
const d1 = run(gate, mockReq({})).body.proofOfWork.difficulty;
ok(d0 === 14 && d1 === 14, `non-adaptive difficulty flat under load (got ${d0} -> ${d1})`);

// --- per-challenge difficulty in pow.js + verify enforces it ---
const pow = createPow({ difficulty: 10, secret: "s" });
const ch = pow.challenge("/r", 14);
ok(ch.difficulty === 14, "pow honors per-call difficulty override");
const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
let nonce = 0; while (lz(createHash("sha256").update(`${ch.challenge}:${nonce}`).digest()) < 14) nonce++;
ok(pow.verify(`${ch.token}:${nonce}`, "/r").ok === true, "solution at the per-call difficulty verifies");

// --- observe mode: classifies + counts but NEVER returns 402 ---
gate = createTollbooth({ observe: true, powDifficulty: 12 });
let r = run(gate, mockReq({ "user-agent": botUA }));
ok(r.nexted === true && r.status === 200, "observe: bot UA passes through (no 402)");
ok(r.hdrs["X-Tollbooth-Observed"] === "would-charge", "observe: bot UA gets X-Tollbooth-Observed header");
r = run(gate, mockReq({ "user-agent": humanUA }));
ok(r.nexted === true && !r.hdrs["X-Tollbooth-Observed"], "observe: human still classified as free (no would-charge header)");
const obsStats = gate.stats();
ok(obsStats.wouldCharge === 1 && obsStats.freeAllowed === 1 && obsStats.observe === true, `observe stats expose wouldCharge + observe flag (got ${JSON.stringify(obsStats)})`);

// --- observe regression: default mode still 402s bots (unchanged for live deploys) ---
gate = createTollbooth({ powDifficulty: 12 });
ok(run(gate, mockReq({ "user-agent": botUA })).status === 402, "non-observe: bot UA still charged 402 (regression guard)");

// --- pluggable statsSink: write-through to a sink AND in-process mirror ---
const sink = memorySink();
gate = createTollbooth({ statsSink: sink, powDifficulty: 12 });
run(gate, mockReq({ "user-agent": botUA }));
run(gate, mockReq({ "user-agent": humanUA }));
const memSnap = gate.stats();
ok(memSnap.requests === 2 && memSnap.charged === 1 && memSnap.freeAllowed === 1, "statsSink: in-process mirror still works");
const durableSnap = await gate.snapshot();
ok(durableSnap.requests === 2 && durableSnap.charged === 1 && durableSnap.freeAllowed === 1, "statsSink: durable snapshot agrees with in-process mirror");

// --- httpStatsSink batches deltas to a fake collector ---
const calls = [];
const fakeFetch = async (url, opts = {}) => {
  if (opts.method === "POST") {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  }
  return { ok: true, status: 200, json: async () => ({ requests: 42 }) };
};
const httpSink = httpStatsSink("http://collector.test/stats", { token: "t", batchMs: 1, fetchImpl: fakeFetch, allowInsecure: true });
gate = createTollbooth({ statsSink: httpSink, powDifficulty: 12 });
run(gate, mockReq({ "user-agent": botUA }));
run(gate, mockReq({ "user-agent": humanUA }));
await new Promise((res) => setTimeout(res, 10)); // let the batched flush fire
ok(calls.length >= 1, `httpStatsSink batched at least one POST (got ${calls.length})`);
const batch = calls[calls.length - 1].body;
ok(batch.incr && batch.incr.requests === 2 && batch.incr.charged === 1 && batch.incr.freeAllowed === 1, `httpStatsSink batch contains correct deltas (got ${JSON.stringify(batch.incr)})`);
const httpSnap = await gate.snapshot();
ok(httpSnap.requests === 42, "httpStatsSink: snapshot GETs from collector");

// --- security: a throwing custom statsSink MUST NOT break the gate ---
const throwingSink = {
  incr() { throw new Error("sink boom"); },
  flush() { throw new Error("flush boom"); },
  snapshot() { throw new Error("snapshot boom"); },
};
gate = createTollbooth({ statsSink: throwingSink, powDifficulty: 12 });
let safe = false;
try { run(gate, mockReq({ "user-agent": botUA })); safe = true; } catch {}
ok(safe, "throwing sink.incr() must not propagate out of the gate");
let flushOk = false;
try { await gate.flush(); flushOk = true; } catch {}
ok(flushOk, "throwing sink.flush() must not propagate out of gate.flush()");

// --- security: httpStatsSink.snapshot() sanitizes a malicious collector response ---
const evil = async (url, opts = {}) => {
  if (opts.method === "POST") return { ok: true, status: 200 };
  return {
    ok: true,
    status: 200,
    // Try to inject HTML into the dashboard, arbitrary key, negative value.
    json: async () => ({ requests: "<img src=x onerror=alert(1)>", evil: "yes", charged: -999, freeAllowed: 12 }),
  };
};
const malSink = httpStatsSink("http://evil.test/stats", { token: "t", batchMs: 1, fetchImpl: evil, allowInsecure: true });
const malSnap = await malSink.snapshot();
ok(malSnap.requests === 0, `string requests coerced to 0 (got ${JSON.stringify(malSnap.requests)})`);
ok(!("evil" in malSnap), "unknown keys are stripped from the snapshot");
ok(malSnap.charged === 0, "negative values are clamped to 0");
ok(malSnap.freeAllowed === 12, "valid numeric values still pass through");

// --- security: httpStatsSink refuses to send a bearer token over plaintext ---
let plaintextRejected = false;
try { httpStatsSink("http://collector.test/stats", { token: "leaky", fetchImpl: async () => ({ ok: true }) }); }
catch (e) { plaintextRejected = /non-HTTPS/i.test(e.message); }
ok(plaintextRejected, "httpStatsSink rejects bearer token over http:// without allowInsecure");
// And accepts HTTPS:
let httpsAccepted = false;
try { httpStatsSink("https://collector.example/stats", { token: "t", fetchImpl: async () => ({ ok: true }) }); httpsAccepted = true; } catch {}
ok(httpsAccepted, "httpStatsSink accepts bearer token over https://");

// --- dashboard renders and points at the stats endpoint ---
const html = dashboardHtml();
ok(html.startsWith("<!doctype html>") && html.includes("/__tollbooth/stats"), "dashboard is HTML that reads /__tollbooth/stats");
ok(["requests", "freeAllowed", "wouldCharge", "charged", "powSolved", "x402Paid", "mppPaid", "difficultyNow"].every((k) => html.includes(k)), "dashboard references every stat field");
// Derived operator ratios — answer "is the gate converting?" and "are they
// paying USDC or just grinding PoW?" without forcing operators to do
// the arithmetic mentally.
ok(html.includes('id="paidpct"') && html.includes("Paid conversion"), "dashboard renders Paid conversion ratio card");
ok(html.includes('id="usdcpct"') && html.includes("Paid in USDC"), "dashboard renders Paid-in-USDC share card");
// The client-side denominator must guard the 0-requests case (no NaN%) and
// the no-paid-requests case (no 0/0 in the USDC share). Both are computed
// in tick() — assert the source has the guards so we don't regress them.
ok(/reqs\s*\?/.test(html), "paid conversion guards requests==0");
ok(/paid\s*\?/.test(html), "USDC share guards paid==0 (no NaN)");
// Sparkline meta (rate-now, peak, paid overlay) — operator-friendly numbers
// that mean operators don't have to eyeball the chart for magnitude. All
// derived client-side from the existing snapshot fields, no sink changes.
ok(html.includes('id="ratenow"') && html.includes('id="ratepeak"'), "dashboard renders rate + peak meta near sparkline");
ok(html.includes('id="paidnow"'), "dashboard renders paid arrival rate meta");
ok(html.includes('id="sparkpaid"'), "dashboard renders the paid-arrivals overlay polyline");
ok(html.includes("paidSeries"), "dashboard tracks a paidSeries parallel to series");
// rateperminute math: deltas are 5s apart, so * (60/5) = *12 — locking the
// scalar means an operator-visible "rate/min" stays correct if the poll
// interval changes (the test reminds you to update both spots).
ok(/\*\s*12\b/.test(html), "rate/min math (*12 from 5s polls) is present");
// Operator probes panel — copy-paste curls let operators verify the gate is
// doing what the counters say without leaving the page. <origin> placeholders
// must be present in the source (initProbes substitutes them client-side from
// window.location.origin so what the operator copies is what they can run).
ok(html.includes('id="probes"') && html.includes("Operator probes"), "dashboard renders the Operator probes panel");
ok(html.includes("/__tollbooth/stats") && /curl/.test(html), "probes include a stats-scrape curl");
ok(/GPTBot/.test(html) && /Mozilla\/5\.0/.test(html), "probes include both a bot UA and a browser UA curl");
ok(html.includes("&lt;origin&gt;"), "probes carry an <origin> placeholder for client-side host substitution");
ok(html.includes("initProbes") && html.includes("navigator.clipboard"), "probes wire a copy-to-clipboard handler (with execCommand fallback)");

// --- USDG on Robinhood Chain: the quote carries the operator's network/asset ---
{
  const usdg = createTollbooth({ payTo: "0x000000000000000000000000000000000000dEaD", network: "eip155:4663", asset: "USDG", powDifficulty: 12 });
  const r = run(usdg, mockReq({ "user-agent": botUA }));
  ok(r.status === 402, "USDG gate: bot gets a 402");
  const acc = r.body?.accepts?.[0];
  ok(acc && acc.network === "eip155:4663", "USDG gate: accept names Robinhood Chain (eip155:4663)");
  ok(acc && acc.asset === "USDG", "USDG gate: accept names USDG as the asset");
  ok(acc && acc.payTo === "0x000000000000000000000000000000000000dEaD", "USDG gate: payTo flows through");
  // env-driven default path (what a Docker operator sets)
  process.env.TOLLBOOTH_ASSET = "USDG";
  process.env.TOLLBOOTH_NETWORK = "eip155:4663";
  const envGate = createTollbooth({ payTo: "0x000000000000000000000000000000000000dEaD", powDifficulty: 12 });
  const r2 = run(envGate, mockReq({ "user-agent": botUA }));
  ok(r2.body?.accepts?.[0]?.asset === "USDG" && r2.body?.accepts?.[0]?.network === "eip155:4663", "TOLLBOOTH_ASSET/NETWORK env vars drive the quote");
  delete process.env.TOLLBOOTH_ASSET;
  delete process.env.TOLLBOOTH_NETWORK;
  // defaults unchanged (regression guard)
  const def = createTollbooth({ payTo: "0x000000000000000000000000000000000000dEaD", powDifficulty: 12 });
  const r3 = run(def, mockReq({ "user-agent": botUA }));
  ok(r3.body?.accepts?.[0]?.asset === "USDC" && r3.body?.accepts?.[0]?.network === "base", "defaults still USDC on base");
}

// --- proof-of-work difficulty floor -----------------------------------------
// The difficulty rides INSIDE the signed token, so a forged or downgraded token
// could claim difficulty 0 and pass with no work at all. verify() must hold
// every solution to the configured difficulty regardless of what the token says.
{
  const secret = "test-secret-for-difficulty-floor";
  const engine = createPow({ difficulty: 12, secret });
  const resource = "GET https://example.test/paid";

  // A legitimate solve at the configured difficulty still passes.
  const chal = engine.challenge(resource);
  let nonce = 0;
  const bits = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
  while (bits(createHash("sha256").update(`${chal.challenge}:${nonce}`).digest()) < chal.difficulty) nonce++;
  ok(engine.verify(`${chal.token}:${nonce}`, resource).ok === true, "a real solve at the configured difficulty verifies");

  // A token whose difficulty field is downgraded to 0 must be refused even
  // though it is signed with the real secret and its nonce trivially "solves"
  // the zero-bit requirement. This is the leaked/placeholder-secret case.
  const forged = createPow({ difficulty: 0, secret });
  const weak = forged.challenge(resource, 0);
  const v = engine.verify(`${weak.token}:0`, resource);
  ok(v.ok === false, `a difficulty-0 token is refused by a difficulty-12 gate (got ${JSON.stringify(v)})`);
  ok(v.reason === "difficulty below policy", `refusal names the policy (got ${v.reason})`);

  // Adaptive difficulty only ever RAISES, so a higher-difficulty token is fine.
  const hard = engine.challenge(resource, 14);
  let n2 = 0;
  while (bits(createHash("sha256").update(`${hard.challenge}:${n2}`).digest()) < hard.difficulty) n2++;
  ok(engine.verify(`${hard.token}:${n2}`, resource).ok === true, "a token above the floor still verifies (adaptive raises)");
}

// --- shared proof-of-work replay store ---------------------------------------
// Single-use is only as wide as the store that records it. With a stable secret
// (which multi-worker deploys need so tokens verify at all) the per-process
// default makes one solved token redeemable ONCE PER PROCESS inside its TTL.
// These assertions cover the default, the shared-store fix, the fail-closed
// posture, and the async-store shape.
{
  const bits = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
  const solveFor = (chal, diff) => { let n = 0; while (bits(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };
  const secret = "shared-replay-store-test-secret";
  const resource = "GET https://seller.example/paid";
  const solved = (engine) => {
    const c = engine.challenge(resource);
    return `${c.token}:${solveFor(c.challenge, c.difficulty)}`;
  };

  // 1. Default (no store): unchanged single-process behavior.
  const solo = createPow({ difficulty: 10, secret });
  const soloSolution = solved(solo);
  ok(solo.verify(soloSolution, resource).ok === true, "default store: first use of a solved token is accepted");
  const soloReplay = solo.verify(soloSolution, resource);
  ok(soloReplay.ok === false && soloReplay.reason === "already used", `default store: second use is refused (got ${JSON.stringify(soloReplay)})`);

  // 2. THE DEFECT: two engines with the SAME secret are two workers behind one
  // load balancer. Without a shared store each keeps its own record, so one
  // solve is redeemed twice.
  const workerA = createPow({ difficulty: 10, secret });
  const workerB = createPow({ difficulty: 10, secret });
  const crossSolution = solved(workerA);
  ok(workerA.verify(crossSolution, resource).ok === true, "two engines, no shared store: worker A accepts the solve");
  ok(workerB.verify(crossSolution, resource).ok === true, "two engines, no shared store: worker B ALSO accepts it (the per-process limit this option exists to close)");

  // 3. THE FIX: one shared store, two independent engines, one redemption.
  const shared = sqliteReplayStore(await openTestDb(), { table: "replay_two_workers" });
  const sharedA = createPow({ difficulty: 10, secret, replayStore: shared });
  const sharedB = createPow({ difficulty: 10, secret, replayStore: shared });
  const sharedSolution = solved(sharedA);
  ok(sharedA.verify(sharedSolution, resource).ok === true, "shared store: worker A redeems the solve");
  const refused = sharedB.verify(sharedSolution, resource);
  ok(refused.ok === false && refused.reason === "already used", `shared store: worker B is refused the same token (got ${JSON.stringify(refused)})`);
  // A worker restart must not reopen the hole: a fresh engine on the same store
  // is the recycled-worker case, and the record outlives the process memory.
  const sharedC = createPow({ difficulty: 10, secret, replayStore: shared });
  ok(sharedC.verify(sharedSolution, resource).ok === false, "shared store: a freshly constructed engine (recycled worker) is refused too");
  // An unrelated solve still works, so the store refuses replays and not traffic.
  ok(sharedB.verify(solved(sharedB), resource).ok === true, "shared store: a different solved token still verifies");

  // 4. FAIL CLOSED: a store that cannot answer must produce a refusal, never a
  // pass. An unavailable store means we do not know whether the token was spent.
  const boom = createPow({ difficulty: 10, secret, replayStore: { claim() { throw new Error("store down"); } } });
  const boomResult = boom.verify(solved(boom), resource);
  ok(boomResult.ok === false, `throwing claim() refuses the request (got ${JSON.stringify(boomResult)})`);
  ok(boomResult.reason === "replay store unavailable", `refusal names the store outage (got ${boomResult.reason})`);
  const rejects = createPow({ difficulty: 10, secret, replayStore: { claim: async () => { throw new Error("store down"); } } });
  const rejectResult = await rejects.verify(solved(rejects), resource);
  ok(rejectResult.ok === false && rejectResult.reason === "replay store unavailable", `a REJECTING async claim() also refuses (got ${JSON.stringify(rejectResult)})`);

  // 5. Async store: claim returns a promise, so verify returns one.
  const seen = new Map();
  const asyncStore = {
    claim: async (token, expMs) => {
      await new Promise((r) => setTimeout(r, 1));
      if (seen.has(token)) return false;
      seen.set(token, expMs);
      return true;
    },
  };
  const asyncA = createPow({ difficulty: 10, secret, replayStore: asyncStore });
  const asyncB = createPow({ difficulty: 10, secret, replayStore: asyncStore });
  const asyncSolution = solved(asyncA);
  const pending = asyncA.verify(asyncSolution, resource);
  ok(typeof pending.then === "function", "async store: verify returns a thenable (never a bare object hiding an unresolved claim)");
  ok((await pending).ok === true, "async store: first use is accepted");
  ok((await asyncB.verify(asyncSolution, resource)).ok === false, "async store: a second engine is refused the same token");
  // A misconfigured store must be loud, not silently downgraded to per-process.
  let shapeRejected = false;
  try { createPow({ secret, replayStore: {} }); } catch (e) { shapeRejected = /claim/.test(e.message); }
  ok(shapeRejected, "createPow refuses a replayStore without claim() instead of silently using process memory");

  // 6. End to end through the middleware: an async store must not let the gate
  // answer before the claim resolves. `run()` is synchronous, so a promise-blind
  // gate would show up here as no response and no next().
  const gateStore = { claim: async (t) => (seen.has(t) ? false : (seen.set(t, 1), true)) };
  const g1 = createTollbooth({ mode: "all", powDifficulty: 10, powSecret: secret, replayStore: gateStore, resourceBaseUrl: "https://seller.example" });
  const g2 = createTollbooth({ mode: "all", powDifficulty: 10, powSecret: secret, replayStore: gateStore, resourceBaseUrl: "https://seller.example" });
  const quote = run(g1, mockReq({})).body.proofOfWork;
  const header = `${quote.token}:${solveFor(quote.challenge, quote.difficulty)}`;
  const firstHit = await runAsync(g1, mockReq({ "x-pow-solution": header }));
  ok(firstHit.nexted === true && firstHit.hdrs["X-Tollbooth-Paid"] === "pow", `gate + async store: solved request passes through (got ${JSON.stringify(firstHit)})`);
  const secondHit = await runAsync(g2, mockReq({ "x-pow-solution": header }));
  ok(secondHit.nexted === false && secondHit.status === 402, `gate + async store: the second worker 402s the replay (got status ${secondHit.status}, nexted ${secondHit.nexted})`);
  ok(secondHit.hdrs["X-Pow-Error"] === "already used", `gate + async store: refusal reason reaches the client header (got ${secondHit.hdrs["X-Pow-Error"]})`);

  // 7. redisReplayStore builds the right SET for each client. The dangerous bug
  // here is silent: send node-redis's options object to ioredis and the NX flag
  // is dropped, so every replay overwrites the key and passes. Stub clients pin
  // the call shape without a Redis server or a driver dependency.
  const nodeRedisCalls = [];
  // sendCommand is the node-redis marker; detection is positive now, because an
  // unidentified client used to fall through to a guessed SET shape.
  const nodeRedis = { sendCommand() {}, set: async (...args) => { nodeRedisCalls.push(args); return args[0].includes("__nxselftest__") ? (nodeRedisCalls.filter((a) => a[0] === args[0]).length === 1 ? "OK" : null) : (nodeRedisCalls.filter((a) => a[0] === args[0]).length === 1 ? "OK" : null); } };
  const nrStore = redisReplayStore(nodeRedis, { prefix: "tb:" });
  ok((await nrStore.claim("tok", Date.now() + 60_000)) === true, "redis store (node-redis shape): a fresh token is granted");
  ok((await nrStore.claim("tok", Date.now() + 60_000)) === false, "redis store (node-redis shape): a declined SET NX is a refusal");
  const nrTok = nodeRedisCalls.filter((a) => !String(a[0]).includes("__nxselftest__"));
  ok(nrTok[0][0] === "tb:tok", "redis store: the key carries the configured prefix");
  ok(nrTok[0][2]?.NX === true && nrTok[0][2]?.PX > 0, `redis store (node-redis shape): SET carries NX + a positive PX (got ${JSON.stringify(nrTok[0][2])})`);
  const ioredisCalls = [];
  const ioredis = { defineCommand() {}, set: async (...args) => { ioredisCalls.push(args); return ioredisCalls.filter((a) => a[0] === args[0]).length === 1 ? "OK" : null; } };
  ok((await redisReplayStore(ioredis).claim("tok", Date.now() + 60_000)) === true, "redis store (ioredis shape): a fresh token is granted");
  const ioTok = ioredisCalls.filter((a) => !String(a[0]).includes("__nxselftest__"));
  ok(ioTok[0][2] === "PX" && Number(ioTok[0][3]) > 0 && ioTok[0][4] === "NX", `redis store (ioredis shape): SET uses the positional PX/NX form (got ${JSON.stringify(ioTok[0].slice(2))})`);
}

// --- edge build: never quote a price it cannot take ---------------------------
// edge.js emitted an accepts block whenever payTo was set, but had no code path
// that read a payment header at all. A crawler that paid correctly was 402'd
// forever: no money moved, nobody was charged, and the operator believed the
// gate was earning.
{
  const { createEdgeTollbooth } = await import("./edge.js");
  const PAYTO = "0x1111111111111111111111111111111111111111";
  const req = (headers = {}) => new Request("https://seller.example/paid", { headers: { "user-agent": "GPTBot/1.0", ...headers } });

  const noVerifier = createEdgeTollbooth({ secret: "s", payTo: PAYTO, pow: false });
  const r1 = await noVerifier(req());
  const b1 = await r1.clone().json();
  ok(r1.status === 402, "edge still charges without a verifier");
  ok(Array.isArray(b1.accepts) && b1.accepts.length === 0, "no verifier means NO usdc quote is advertised");

  const withVerifier = createEdgeTollbooth({ secret: "s", payTo: PAYTO, pow: false, verifyX402: async () => true });
  const r2 = await withVerifier(req());
  const b2 = await r2.clone().json();
  ok(b2.accepts.length === 1 && b2.accepts[0].payTo === PAYTO, "a verifier means the usdc quote IS advertised");

  const paid = await withVerifier(req({ "payment-signature": "sig" }));
  ok(paid === null, "a presented payment is accepted on the PAYMENT-SIGNATURE header");
  const paidLegacy = await withVerifier(req({ "x-payment": "sig" }));
  ok(paidLegacy === null, "and on the legacy X-PAYMENT header");

  const throwing = createEdgeTollbooth({ secret: "s", payTo: PAYTO, pow: false, verifyX402: async () => { throw new Error("facilitator down"); } });
  const r3 = await throwing(req({ "payment-signature": "sig" }));
  ok(r3 !== null && r3.status === 402, "a verifier that throws fails CLOSED");
}

// --- redis replay store must fail closed on a client it cannot trust ---------
{
  const { redisReplayStore } = await import("./replay.js");
  let threw = false;
  try { redisReplayStore({ set: async () => "OK" }); } catch { threw = true; }
  ok(threw, "an unrecognised redis client is refused rather than guessed at");

  // A client that ignores NX would grant every replay. The one-time proof
  // catches it before the store is trusted.
  const ignoresNx = redisReplayStore({ sendCommand() {}, set: async () => "OK" });
  let refused = false;
  try { await ignoresNx.claim("t", Date.now() + 60_000); } catch { refused = true; }
  ok(refused, "a client that ignores NX is caught by the self-test and refuses");

  // ...and KEEPS refusing. Calling claim() once was the whole coverage here,
  // which is why a verdict that refused exactly once and then granted every
  // replay forever read as a working guard. A gate that fails closed only on
  // its first request is not failing closed.
  let stillRefusing = true;
  for (let i = 0; i < 3; i++) {
    try { await ignoresNx.claim(`t${i}`, Date.now() + 60_000); stillRefusing = false; } catch { /* expected */ }
  }
  ok(stillRefusing, "and every subsequent claim is refused too, not just the first");

  // A probe that THROWS is a Redis outage, not a verdict: the next call must
  // re-probe rather than remember a failure that was never observed.
  let attempts = 0;
  const flaky = redisReplayStore({
    sendCommand() {},
    async set(k) {
      attempts++;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      if (String(k).includes("__nxselftest__")) return attempts === 2 ? "OK" : null;
      return "OK";
    },
  });
  let firstFailed = false;
  try { await flaky.claim("x", Date.now() + 60_000); } catch { firstFailed = true; }
  ok(firstFailed, "a claim during a redis outage fails closed");
  ok((await flaky.claim("x", Date.now() + 60_000)) === true, "and the store recovers once redis returns — an outage is not a verdict");

  const seen = new Set();
  const good = redisReplayStore({ sendCommand() {}, async set(k) { if (seen.has(k)) return null; seen.add(k); return "OK"; } });
  ok((await good.claim("t1", Date.now() + 60_000)) === true, "a correct client claims once");
  ok((await good.claim("t1", Date.now() + 60_000)) === false, "and refuses the replay");
}

// --- x402 middleware mode: a method the middleware does not price is not free ---
// A real @x402/express v2 middleware priced on "GET /*" (and, like the CLI, on
// "/*", which its matcher never applies to OPTIONS) calls next() for anything
// outside its routes. The gate has already decided the request pays, so that
// next() is not a payment: POST, PUT, OPTIONS, a method-override header or a
// junk payment header on an unpriced method get the gate's 402, never the
// handler. Controls: an unpaid GET draws the middleware's lifted 402 and a
// stock x402 client pays GET through a stub facilitator.
{
  const { createServer } = await import("node:http");
  const { default: express } = await import("express");
  const { paymentMiddleware } = await import("@x402/express");
  const { HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server");
  const { ExactEvmScheme } = await import("@x402/evm/exact/server");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const PAYTO = "0x000000000000000000000000000000000000dEaD";
  const settles = [];
  const fac = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const p = b ? JSON.parse(b) : {};
      if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (req.url === "/verify") return reply({ isValid: true, payer: p.paymentPayload?.payload?.authorization?.from });
      if (req.url === "/settle") { settles.push(p); return reply({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: p.paymentPayload?.payload?.authorization?.from }); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => fac.listen(0, "127.0.0.1", r));
  const servers = [fac];
  const boot = async (pattern) => {
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: `http://127.0.0.1:${fac.address().port}` })).register("eip155:8453", new ExactEvmScheme());
    const mw = paymentMiddleware({ [pattern]: { accepts: [{ scheme: "exact", network: "eip155:8453", price: "$0.001", payTo: PAYTO }], description: "page", mimeType: "application/json" } }, rs);
    const e = express();
    e.use(createTollbooth({ mode: "all", payTo: PAYTO, price: "$0.001", network: "eip155:8453", x402: mw, powSecret: "s", mpp: false }));
    // A handler that serves the content on every method, as a catch-all or a proxied origin does.
    e.all("/page", (_req, res) => res.json({ page: "paid content" }));
    const srv = e.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    servers.push(srv);
    return `http://127.0.0.1:${srv.address().port}/page`;
  };
  try {
    for (const pattern of ["GET /*", "/*"]) {
      const url = await boot(pattern);
      const unpaid = await fetch(url);
      ok(unpaid.status === 402 && !!unpaid.headers.get("payment-required"), `${pattern}: control: an unpaid GET draws the 402 with the middleware's PAYMENT-REQUIRED`);
      const cases = [["OPTIONS", {}], ["POST", { "x-http-method-override": "GET" }], ["OPTIONS", { "x-payment": "junk" }]];
      if (pattern === "GET /*") cases.push(["POST", {}], ["PUT", {}], ["DELETE", { "payment-signature": "junk" }]);
      for (const [method, headers] of cases) {
        const r = await fetch(url, { method, headers });
        const body = await r.text();
        ok(r.status === 402 && !body.includes("paid content") && r.headers.get("x-tollbooth-paid") === null, `${pattern}: ${method}${Object.keys(headers).length ? ` with ${Object.keys(headers)[0]}` : ""} on a method the middleware does not price is refused, not served (${r.status} ${r.headers.get("x-tollbooth-error")})`);
      }
      const head = await fetch(url, { method: "HEAD" });
      ok(head.status === 402, `${pattern}: an unpaid HEAD is refused (${head.status})`);
      const xc = new x402Client(); registerExactEvmScheme(xc, { signer: privateKeyToAccount(generatePrivateKey()) });
      const before = settles.length;
      const paid = await wrapFetchWithPayment(fetch, xc)(url);
      ok(paid.status === 200 && (await paid.json()).page === "paid content" && paid.headers.get("x-tollbooth-paid") === "x402" && settles.length === before + 1, `${pattern}: control: a stock x402 client pays GET and the payment settles (${paid.status})`);
    }
  } finally { for (const s of servers) s.close(); }
}

// The README's x402 example is what operators copy: it prices every method the
// gate charges, and the upgrade note says an unpriced method now gets the 402.
{
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes("paymentMiddleware("));
  ok(blocks.length >= 1, "README: an x402 middleware example exists");
  ok(blocks.every((b) => !/"(GET|HEAD) \/\*"/.test(b)), "README: the x402 example does not price GET alone");
  ok(/^## Upgrading from 0\.10\.8 or earlier$/m.test(readme) && /gets the\s+gate's 402/.test(readme), "README: the upgrade note names the 402 on an unpriced method");
}

console.log(`\n${pass} passed`);

// In-memory SQLite for the shared-store assertions. Prefers the built-in
// node:sqlite (Node 22.5+) and falls back to better-sqlite3, so the test adds no
// dependency to the tollbooth package. Neither available is a hard failure: the
// shared store is a security fix and an untested security fix is worse than a
// noisy one.
async function openTestDb() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(":memory:");
  } catch { /* fall through to better-sqlite3 */ }
  const { default: Database } = await import("better-sqlite3");
  return new Database(":memory:");
}

// Async-aware variant of run(): the middleware returns a promise when a shared
// replay store answers with one, and the whole point of the assertions above is
// that the response has landed by the time we look at it.
async function runAsync(gate, req) {
  let nexted = false, status = 200, body = null; const hdrs = {};
  const res = { status(n) { status = n; return this; }, json(o) { body = o; return this; }, setHeader(k, v) { hdrs[k] = v; } };
  await gate(req, res, () => { nexted = true; });
  return { nexted, status, body, hdrs };
}
