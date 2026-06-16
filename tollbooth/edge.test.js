// Offline test for the edge gate (Web Crypto + Fetch globals; Node 20+).
import { createEdgeTollbooth, memorySink } from "./edge.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const lz = (bytes) => { let n = 0; for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const solve = async (chal, diff) => { let n = 0; while (lz(await sha(`${chal}:${n}`)) < diff) n++; return n; };

const gate = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 16, payTo: "0x000000000000000000000000000000000000dEaD" });
const req = (ua, extra = {}) => new Request("https://site.test/article", { headers: { "user-agent": ua, ...extra } });
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

// 1. Human allowed (gate returns null).
let res = await gate(req(HUMAN));
if (res !== null) fail("human should be allowed (null)");
console.log("1. human -> allow (null) ✓");

// 2. Bot charged 402 with both rails.
res = await gate(req(BOT));
if (!res || res.status !== 402) fail(`bot should be charged 402, got ${res && res.status}`);
const q = await res.json();
if (!q.proofOfWork?.challenge) fail("402 must include a proof-of-work challenge");
if (!q.accepts?.[0]?.payTo) fail("402 must include an x402 quote");
console.log("2. bot -> 402 with PoW challenge + x402 quote ✓");

// 3. Solve the PoW -> allowed.
const nonce = await solve(q.proofOfWork.challenge, q.proofOfWork.difficulty);
const solution = `${q.proofOfWork.token}:${nonce}`;
res = await gate(req(BOT, { "x-pow-solution": solution }));
if (res !== null) fail("valid PoW should be allowed (null)");
console.log("3. bot solves proof-of-work -> allow ✓");

// 4. Replay rejected (single-use).
res = await gate(req(BOT, { "x-pow-solution": solution }));
if (res === null) fail("replayed PoW solution must not be accepted");
console.log(`4. replayed solution -> ${res.status} (single-use) ✓`);

// 5. Resource-bound: a /article token must not unlock /other.
const gate2 = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 16 });
res = await gate2(new Request("https://site.test/other", { headers: { "user-agent": BOT, "x-pow-solution": solution } }));
if (res === null) fail("PoW token bound to /article must not work on /other");
console.log(`5. cross-resource reuse -> ${res.status} (resource-bound) ✓`);

// 6. REGRESSION (bug 1.1): dotted paths + query strings must work on the edge.
for (const path of ["/blog/post.html", "/a?v=1.2.3", "/feed.xml?since=2024.01"]) {
  let rr = await gate(new Request(`https://site.test${path}`, { headers: { "user-agent": BOT } }));
  if (!rr || rr.status !== 402) fail(`edge dotted path ${path} should 402`);
  const qq = await rr.json();
  const nn = await solve(qq.proofOfWork.challenge, qq.proofOfWork.difficulty);
  rr = await gate(new Request(`https://site.test${path}`, { headers: { "user-agent": BOT, "x-pow-solution": `${qq.proofOfWork.token}:${nn}` } }));
  if (rr !== null) fail(`edge dotted path ${path} should unlock with valid PoW, got ${rr && rr.status}`);
}
console.log("6. edge: dotted paths + query strings unlock correctly ✓");

// 7. Stats counter exists on the edge gate (regression: didn't before 0.3.0).
const counted = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 12 });
await counted(req(HUMAN));
await counted(req(BOT));
const s = counted.stats();
if (s.requests !== 2 || s.freeAllowed !== 1 || s.charged !== 1) fail(`edge stats wrong: ${JSON.stringify(s)}`);
console.log("7. edge gate exposes .stats() counters ✓");

// 8. Observe mode: never returns a 402; bumps wouldCharge.
const obs = createEdgeTollbooth({ secret: "test-secret", observe: true, powDifficulty: 12 });
const oRes = await obs(req(BOT));
if (oRes !== null) fail(`observe must never 402, got ${oRes && oRes.status}`);
const oStats = obs.stats();
if (oStats.wouldCharge !== 1 || oStats.observe !== true) fail(`observe stats wrong: ${JSON.stringify(oStats)}`);
console.log("8. edge observe mode: bot lets through, wouldCharge counted ✓");

// 9. Pluggable statsSink: snapshot() returns the sink's view (durable path).
const externalSink = memorySink();
const piped = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 12, statsSink: externalSink });
await piped(req(HUMAN));
await piped(req(BOT));
const durable = await piped.snapshot();
if (durable.requests !== 2 || durable.charged !== 1) fail(`edge durable snapshot wrong: ${JSON.stringify(durable)}`);
// flush() is a no-op for memorySink but must resolve.
await piped.flush();
console.log("9. edge statsSink: snapshot() reads from sink, flush() resolves ✓");

console.log("\nedge tollbooth: all assertions passed ✓");
