// Offline test for the edge gate (Web Crypto + Fetch globals; Node 20+).
import { createEdgeTollbooth } from "./edge.js";

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

console.log("\nedge tollbooth: all assertions passed ✓");
