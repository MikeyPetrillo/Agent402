// The PoW free tier is the documented "no wallet, no problem" path. Existing
// tests lock the challenge envelope and the /api/pow info copy, but none
// prove that an honest solver actually unlocks a tool call. A regression
// where the solver formula silently drifts (challenge concatenation changed,
// difficulty interpretation flipped, header parsing dropped a field) would
// pass every other test in CI and still break every free-tier caller.
//
// FREE_MODE deliberately bypasses BOTH the paywall and the PoW gate (it's
// the test seam other suites use). To test PoW end-to-end the paywall has to
// be ACTIVE — same setup test-idempotency.js uses: WALLET_ADDRESS set + an
// unreachable facilitator (X402_SYNC_ON_START=false) so we never actually
// touch the network for settlement. PoW bypasses settlement entirely.
//
// This test boots the paid-mode server and walks the documented protocol:
//
//   1. GET /api/pow — confirm difficulty + header name + format are present.
//   2. GET /api/pow/challenge?slug=hash — fetch a challenge (hash is the
//      reference PoW tool used by all guides).
//   3. Solve in-process: find a nonce N where sha256(challenge + ":" + N)
//      has >= `difficulty` leading zero bits.
//   4. POST /api/hash with `X-Pow-Solution: <token>:<nonce>` — assert 200,
//      deterministic body (the hex of sha256("hello world")), and the
//      `X-Pow-Accepted: true` response header.
//   5. Replay the same solution → 4xx (single-use guarantee; without this,
//      one solve = unlimited calls).
//   6. No solution header → 402 (paid-mode paywall fires).
//
//   node scripts/test-pow-solve-roundtrip.js
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3087;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// Pure-CPU solver. Throws after a budget so a runaway-difficulty regression
// fails fast instead of hanging CI.
function solve(challenge, difficulty, maxIter = 5_000_000) {
  for (let n = 0; n < maxIter; n++) {
    const h = createHash("sha256").update(challenge + ":" + n).digest();
    if (leadingZeroBits(h) >= difficulty) return n;
  }
  throw new Error(`solver gave up after ${maxIter} iterations at difficulty=${difficulty}`);
}

// Paid-mode boot — paywall is on, but FACILITATOR_URL points at a URL we
// never touch (X402_SYNC_ON_START=false; PoW path bypasses settlement).
// POW_DIFFICULTY=12 keeps solve time under ~10ms; the default of 16 is also
// tractable but adds runtime variance.
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network",
    X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
    FREE_MODE: "",
  },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {} await sleep(500); }

  // 1. Published rule.
  const info = await (await fetch(`${BASE}/api/pow`)).json();
  ok(info.difficultyBits === 12, `info.difficultyBits=12 (env override; got ${info.difficultyBits})`);
  ok(info.submitHeader === "X-Pow-Solution", `info.submitHeader='X-Pow-Solution'`);
  ok(info.submitFormat === "<token>:<nonce>", `info.submitFormat='<token>:<nonce>'`);
  ok(Array.isArray(info.eligibleTools) && info.eligibleTools.includes("hash"), `'hash' is PoW-eligible (the canonical example tool)`);

  // 2. Challenge.
  const ch = await (await fetch(`${BASE}/api/pow/challenge?slug=hash`)).json();
  ok(typeof ch.challenge === "string" && ch.challenge.length > 0, `challenge issued for hash`);
  ok(ch.difficulty === 12, `challenge difficulty=12 (got ${ch.difficulty})`);

  // 3. Solve + local verify (catches solver-formula drift before any network).
  const t0 = Date.now();
  const nonce = solve(ch.challenge, ch.difficulty);
  const solveMs = Date.now() - t0;
  ok(typeof nonce === "number" && nonce >= 0, `nonce found in ${solveMs}ms (nonce=${nonce})`);
  const verifyHash = createHash("sha256").update(ch.challenge + ":" + nonce).digest();
  ok(leadingZeroBits(verifyHash) >= ch.difficulty, `local verify: >= ${ch.difficulty} leading zero bits (got ${leadingZeroBits(verifyHash)})`);

  // 4. Tool call with the solution. sha256('hello world') = b94d27b9... —
  // pin the prefix so a route-misroute (returning some other tool's output)
  // surfaces here instead of just "got JSON".
  const callHash = (sol) => fetch(`${BASE}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": sol },
    body: JSON.stringify({ text: "hello world" }),
  });
  const solution = `${ch.token}:${nonce}`;
  const res = await callHash(solution);
  ok(res.status === 200, `POST /api/hash with valid solution → 200 (got ${res.status})`);
  ok(res.headers.get("x-pow-accepted") === "true", `X-Pow-Accepted: true header set (got ${res.headers.get("x-pow-accepted")})`);
  const body = await res.json();
  // Deterministic body — same input always yields the same hash. A regression
  // where the gate passed but routed to the wrong handler would fail here.
  ok(typeof body.hex === "string" && body.hex.startsWith("b94d27b9"), `hash response is sha256('hello world') (got ${body.hex?.slice(0, 16)}…)`);

  // 5. Replay — same solution again. The pow module's markStmt PK constraint
  // is the single-use enforcement; if this passes, single-use is broken.
  const replay = await callHash(solution);
  ok(replay.status !== 200, `replayed solution → not 200 (got ${replay.status}) — single-use guarantee`);
  // The exact failure code after the PoW rejection depends on the x402
  // middleware's response to an unreachable facilitator (we use a fake URL
  // so settlement never happens). What matters here is that the call is
  // NOT served — single-use enforcement happens at the PoW layer, surfaced
  // via the X-Pow-Error response header below.
  const replayPowError = replay.headers.get("x-pow-error");
  ok(typeof replayPowError === "string" && replayPowError.includes("already used"), `replay attaches X-Pow-Error explaining single-use (got '${replayPowError}')`);

  // 6. No solution at all — must not be served. The exact status depends on
  // the x402 middleware response to a missing payment header against an
  // unreachable facilitator, but the X-Pow-Challenge advertisement header is
  // set by our PoW middleware before x402 runs, so we can assert that
  // discovery hint is in place regardless of the downstream status code.
  const bare = await fetch(`${BASE}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(bare.status !== 200, `no-solution call → not 200 (got ${bare.status}) — paywall fires`);
  ok(bare.headers.get("x-pow-challenge")?.includes("/api/pow/challenge?slug=hash"), `bare response advertises X-Pow-Challenge URL (got '${bare.headers.get("x-pow-challenge")}')`);

  console.log(`\n${pass} passed (solveMs=${solveMs}, nonce=${nonce}, hex=${body.hex.slice(0, 16)})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
