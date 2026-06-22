// Tests for the opt-in tollbooth features: charge modes, analytics counters,
// adaptive proof-of-work, and per-challenge difficulty. Verifies the DEFAULTS
// are unchanged (so live deployments aren't affected) and the new behavior only
// kicks in when explicitly enabled. Drives the middleware directly with mocks.
import { createHash } from "node:crypto";
import { createTollbooth, createPow, memorySink, httpStatsSink } from "./index.js";
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
ok(["requests", "freeAllowed", "wouldCharge", "charged", "powSolved", "x402Paid", "difficultyNow"].every((k) => html.includes(k)), "dashboard references every stat field");
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

console.log(`\n${pass} passed`);
