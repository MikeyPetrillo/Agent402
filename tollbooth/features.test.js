// Tests for the opt-in tollbooth features: charge modes, analytics counters,
// adaptive proof-of-work, and per-challenge difficulty. Verifies the DEFAULTS
// are unchanged (so live deployments aren't affected) and the new behavior only
// kicks in when explicitly enabled. Drives the middleware directly with mocks.
import { createHash } from "node:crypto";
import { createTollbooth, createPow } from "./index.js";

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

console.log(`\n${pass} passed`);
