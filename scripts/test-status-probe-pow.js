// The status Worker's paid-call challenge (2026-09-28).
//
// The Cloudflare status Worker (workers/status-probe) observes the paid-call
// path by walking the proof-of-work path end to end, on a probe challenge of
// its own rather than the buyer's (the heartbeat walks the buyer's). It is
// sized to the tightest Workers CPU limit, which a normal 16-bit solve would
// blow many times over, and it deliberately does not hold POW_SECRET, so it
// cannot mark its own call as ours with a heartbeat token. So the server hands
// a caller presenting STATUS_PROBE_TOKEN (X-Operator-Token) a low-difficulty
// challenge for ONE pure-CPU slug, marked as the probe's inside the signature,
// and books the call it unlocks as internal exactly like the heartbeat's.
//
// The easy half is that it works. What this test has to prove is everything
// around it:
//   - no token, a wrong token, the operator token, a Bearer, or another slug
//     gets the NORMAL challenge;
//   - the unlocked call is booked as internal (viaHeartbeat, never
//     viaProofOfWork), with a control proving an ordinary solve IS booked as
//     outside proof-of-work traffic, so the delta check can see a difference;
//   - the probe challenge is single-use, redeems on its own slug only, and
//     its mark and difficulty cannot be added, stripped or lowered;
//   - the token grants nothing else on a paid route;
//   - with STATUS_PROBE_TOKEN unset the feature is off entirely.
//
// Boots two real servers: a paid-mode one with the token (the PoW gate only
// runs when the paywall is active - same setup as test-pow-solve-roundtrip)
// and a FREE_MODE one without it (the challenge route does not depend on mode).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getFreePorts } from "./lib/free-port.js";
import { PAID_CALL_MAX_DIFFICULTY, SOLVE_CAP_FACTOR, checkPaidCall } from "../workers/status-probe/src/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const OP = "operator-root-token-aaaaaaaaaaaaaaaa";
const PROBE = "status-probe-only-token-bbbbbbbbbbbb";
const NORMAL = 12; // POW_DIFFICULTY for the booted server: keeps the ordinary solves quick
const [PORT, PORT_OFF] = await getFreePorts(2);
const base = `http://127.0.0.1:${PORT}`;
const baseOff = `http://127.0.0.1:${PORT_OFF}`;

const boot = (port, env) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(port), X402_INDEX_CRAWL: "off", POW_DIFFICULTY: String(NORMAL), POW_SECRET: "status-probe-pow-test-secret", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.log = "";
  child.stdout.on("data", (d) => { child.log += d; });
  child.stderr.on("data", (d) => { child.log += d; });
  return child;
};
// Paid mode: WALLET_ADDRESS set and an unreachable facilitator never touched
// (X402_SYNC_ON_START=false; the proof-of-work path bypasses settlement).
const paid = boot(PORT, {
  FREE_MODE: "",
  WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  NETWORK: "base",
  FACILITATOR_URL: "https://facilitator.payai.network",
  X402_SYNC_ON_START: "false",
  AGENT402_OPERATOR_TOKEN: OP,
  STATUS_PROBE_TOKEN: PROBE,
});
const off = boot(PORT_OFF, { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: OP, STATUS_PROBE_TOKEN: "" });
const done = (code) => { for (const c of [paid, off]) { try { c.kill("SIGKILL"); } catch { /* */ } } process.exit(code); };

const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
function solve(challenge, difficulty) {
  for (let n = 0; n < 5_000_000; n++) if (lz(createHash("sha256").update(`${challenge}:${n}`).digest()) >= difficulty) return n;
  throw new Error(`no nonce at difficulty ${difficulty}`);
}
const challenge = async (b, slug, headers = {}) => (await fetch(`${b}/api/pow/challenge?slug=${slug}`, { headers })).json();
const call = (route, solution, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(solution ? { "X-Pow-Solution": solution } : {}), ...headers },
  body: JSON.stringify(body),
});
const counters = async () => (await (await fetch(`${base}/api/stats`)).json()).toolCallsServed;
// recordServedCall runs on the response's "finish"; give it a moment rather
// than racing it.
async function countersAfter(before, key) {
  for (let i = 0; i < 20; i++) {
    const c = await counters();
    if (c[key] !== before[key]) return c;
    await wait(100);
  }
  return counters();
}
const sha = (t) => createHash("sha256").update(t).digest("hex");

(async () => {
  for (const [name, b, c] of [["paid-mode", base, paid], ["token-unset", baseOff, off]]) {
    let up = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${b}/api/pow`)).ok) { up = true; break; } } catch { /* */ }
      await wait(500);
    }
    ok(up, `${name} server booted`);
    if (!up) { console.error(c.log.slice(-1500)); return done(1); }
  }
  const info = await (await fetch(`${base}/api/pow`)).json();
  ok(info.difficultyBits === NORMAL, `normal difficulty is ${NORMAL} on the booted server`);
  ok(info.eligibleTools.includes("hash") && info.eligibleTools.includes("hmac"), "hash and hmac are proof-of-work eligible (the probe slug and a control slug)");

  // 1. The token gets the low difficulty, on the probe slug only.
  const pc = await challenge(base, "hash", { "X-Operator-Token": PROBE });
  ok(pc.difficulty === 4 && pc.difficulty < NORMAL, `the probe token gets a 4-bit challenge on hash (got ${pc.difficulty})`);
  ok(pc.slug === "hash" && pc.token.split(".").length === 6 && pc.token.split(".")[4] === "probe", "and its signed token carries the probe mark");
  ok(pc.ttlSeconds <= 120, `with a short life (${pc.ttlSeconds}s)`);
  ok(pc.difficulty <= PAID_CALL_MAX_DIFFICULTY, `and it is within what the Worker will solve (<= ${PAID_CALL_MAX_DIFFICULTY} bits)`);

  // 2. Everything else gets the normal challenge.
  const normalFor = async (label, b, slug, headers) => {
    const c = await challenge(b, slug, headers);
    ok(c.difficulty === NORMAL && c.token.split(".").length === 5 && !c.token.includes(".probe."),
      `${label} -> normal challenge (difficulty ${c.difficulty}, ${c.token.split(".").length}-part token)`);
    return c;
  };
  await normalFor("no token", base, "hash", {});
  await normalFor("a wrong token", base, "hash", { "X-Operator-Token": "wrong-token-cccccccccccccccccccccc" });
  // Same length as the real one: a length-only comparison would pass this.
  await normalFor("a near-miss of the same length", base, "hash", { "X-Operator-Token": PROBE.slice(0, -1) + "c" });
  await normalFor("the ROOT operator token (it has no business on a public route)", base, "hash", { "X-Operator-Token": OP });
  // Authorization is a payment/credits header on this API; the probe token is
  // read from X-Operator-Token only.
  await normalFor("the probe token as an Authorization Bearer", base, "hash", { Authorization: `Bearer ${PROBE}` });
  await normalFor("the probe token on ANOTHER slug", base, "hmac", { "X-Operator-Token": PROBE });
  const offC = await challenge(baseOff, "hash", { "X-Operator-Token": PROBE });
  ok(offC.difficulty === NORMAL && offC.token.split(".").length === 5, `STATUS_PROBE_TOKEN unset on the server: the feature is off (difficulty ${offC.difficulty})`);

  // 3. CONTROL first: an ordinary external solve is booked as outside
  //    proof-of-work traffic. Without this, "viaProofOfWork did not move"
  //    below could be a counter that never moves at all.
  let before = await counters();
  const nc = await challenge(base, "hash");
  const cr = await call("/api/hash", `${nc.token}:${solve(nc.challenge, nc.difficulty)}`, { text: "control" });
  ok(cr.status === 200, `control: an ordinary solve is served (got ${cr.status})`);
  let after = await countersAfter(before, "viaProofOfWork");
  ok(after.viaProofOfWork === before.viaProofOfWork + 1 && after.viaHeartbeat === before.viaHeartbeat,
    `control: it is booked as outside proof-of-work (pow +${after.viaProofOfWork - before.viaProofOfWork}, heartbeat +${after.viaHeartbeat - before.viaHeartbeat})`);

  // 4. The probe's call: served, unlocked by the gate, and booked as internal.
  before = await counters();
  const text = `status-probe ${pc.challenge}`;
  const probeSolution = `${pc.token}:${solve(pc.challenge, pc.difficulty)}`;
  const r = await call("/api/hash", probeSolution, { text });
  ok(r.status === 200 && r.headers.get("x-pow-accepted") === "true", `the probe's solved call is served through the PoW gate (got ${r.status})`);
  const j = await r.json();
  ok(j.hex === sha(text), "and answers the hash of what it sent");
  after = await countersAfter(before, "viaHeartbeat");
  ok(after.viaHeartbeat === before.viaHeartbeat + 1, `it is booked as internal probe traffic (heartbeat +${after.viaHeartbeat - before.viaHeartbeat})`);
  ok(after.viaProofOfWork === before.viaProofOfWork, `and never as outside free-tier demand (pow +${after.viaProofOfWork - before.viaProofOfWork})`);
  ok(after.viaUSDC === before.viaUSDC, "nor as a sale");
  const recent = (await (await fetch(`${base}/api/stats`)).json()).recentCalls || [];
  ok(recent[0]?.slug === "hash" && recent[0]?.paidWith === "heartbeat", `the activity feed files it as heartbeat (got ${JSON.stringify(recent[0])})`);

  // 5. Single use.
  const replay = await call("/api/hash", probeSolution, { text });
  ok(replay.status !== 200 && /already used/.test(replay.headers.get("x-pow-error") || ""), `a replayed probe solution is refused (${replay.status}, ${replay.headers.get("x-pow-error")})`);

  // 6. It redeems on its own slug only.
  const pc2 = await challenge(base, "hash", { "X-Operator-Token": PROBE });
  const other = await call("/api/hmac", `${pc2.token}:${solve(pc2.challenge, pc2.difficulty)}`, { text: "x", key: "y" });
  ok(other.status !== 200 && /scoped to "hash"/.test(other.headers.get("x-pow-error") || ""), `a probe challenge does not unlock another tool (${other.status}, ${other.headers.get("x-pow-error")})`);

  // 7. The mark and the difficulty are inside the signature. Each forgery is
  //    submitted with a nonce that DOES meet the work, so the signature is the
  //    only thing that can refuse it.
  const tamper = async (label, mutate) => {
    const c = await challenge(base, "hash", { "X-Operator-Token": PROBE });
    const t = mutate(c.token.split("."));
    const res = await call("/api/hash", `${t}:${solve(c.challenge, c.difficulty)}`, { text: "t" });
    ok(res.status !== 200 && /bad signature|malformed/.test(res.headers.get("x-pow-error") || ""), `${label} is refused (${res.status}, ${res.headers.get("x-pow-error")})`);
  };
  await tamper("a probe token with its mark stripped", (p) => [...p.slice(0, 4), p[5]].join("."));
  await tamper("a probe token with its difficulty lowered to 0", (p) => [p[0], p[1], "0", ...p.slice(3)].join("."));
  {
    const c = await challenge(base, "hash");
    const p = c.token.split(".");
    const forged = [...p.slice(0, 4), "probe", p[4]].join(".");
    const res = await call("/api/hash", `${forged}:${solve(c.challenge, NORMAL)}`, { text: "t" });
    ok(res.status !== 200 && /bad signature/.test(res.headers.get("x-pow-error") || ""), `a normal token with a probe mark added is refused (${res.status}, ${res.headers.get("x-pow-error")})`);
  }

  // 8. The token buys nothing on a paid route: no solution, no service. (This
  //    harness's facilitator is deliberately unreachable, so the paywall answers
  //    an unpaid call 500 here rather than 402 - what matters is that the
  //    handler never runs, as for any caller without a payment.)
  const bare = await call("/api/hash", null, { text: "x" });
  for (const [route, body] of [["/api/hash", { text: "x" }], ["/api/extract", { url: "https://example.com" }]]) {
    for (const h of [{ "X-Operator-Token": PROBE }, { Authorization: `Bearer ${PROBE}` }]) {
      const res = await call(route, null, body, h);
      const txt = await res.text();
      ok(res.status !== 200 && res.status === bare.status && res.headers.get("x-pow-accepted") === null && !txt.includes(sha("x")),
        `the probe token alone on POST ${route} (${Object.keys(h)[0]}) is refused like any unpaid call (got ${res.status}, unpaid baseline ${bare.status})`);
    }
  }

  // 9. The Worker's own check, driven against this server end to end.
  before = await counters();
  const w = await checkPaidCall(base, PROBE);
  ok(w.ok === true, `the Worker's checkPaidCall observes the path against the real server (${JSON.stringify(w)})`);
  after = await countersAfter(before, "viaHeartbeat");
  ok(after.viaHeartbeat === before.viaHeartbeat + 1 && after.viaProofOfWork === before.viaProofOfWork, "and its call is booked as internal too");
  const wOff = await checkPaidCall(baseOff, PROBE);
  ok(!!wOff.skip && /did not honour the probe token/.test(wOff.skip), `against a server without the token it declines to solve and records nothing (${JSON.stringify(wOff)})`);
  ok(SOLVE_CAP_FACTOR * 2 ** PAID_CALL_MAX_DIFFICULTY <= 256, "the Worker's worst-case solve stays at 256 hashes");

  // 10. A wrong token on the challenge route is charged like a wrong operator
  //     credential anywhere else (same per-source budget, same guessing
  //     pager), so this public route is no better a place to guess from. Three
  //     wrong ones were already spent above; the budget is ten a minute.
  const opStats = () => fetch(`${base}/__operator/stats`, { headers: { "X-Operator-Token": OP } });
  ok((await opStats()).status === 200, "control: the operator token still works from this source");
  for (let i = 0; i < 10; i++) await challenge(base, "hash", { "X-Operator-Token": `wrong-guess-${i}-dddddddddddddddddddd` });
  ok((await opStats()).status !== 200, "after a burst of wrong tokens on the challenge route, this source's operator budget is spent");
  // ...and once it is spent, even the RIGHT probe token is not compared from
  // that source, so the route cannot be used to keep guessing past the budget.
  {
    const j = await challenge(base, "hash", { "X-Operator-Token": PROBE });
    ok(j.difficulty === NORMAL && j.token?.split(".")[4] !== "probe", `after the budget is spent the probe token earns no probe challenge from that source (difficulty ${j.difficulty})`);
  }

  // 11. Source guards: the grant is wired in one place and read in one file.
  const src = await readFile("src/server.js", "utf8");
  ok([...src.matchAll(/statusProbeTokenOk\(/g)].length === 2, "statusProbeTokenOk is called from exactly two places (the probe route's gate and the challenge's)");
  ok([...src.matchAll(/statusProbeChallengeAuthed\(/g)].length === 2, "statusProbeChallengeAuthed is declared once and called once");
  ok(/app\.get\("\/api\/pow\/challenge"[\s\S]{0,1600}?statusProbeChallengeAuthed\(req\)/.test(src), "and its one caller is GET /api/pow/challenge");
  ok([...src.matchAll(/statusProbePow = true/g)].length === 1 && /result\.probe === true\) req\.statusProbePow = true/.test(src), "statusProbePow is set in exactly one place, from a verified probe solution");
  // The synthetic marker feeds telemetry this test cannot read (PostHog, the
  // analytics table), so pin that it recognises the probe's call from source.
  ok(/function isSyntheticRequest\(req\) \{[\s\S]{0,200}?ownTrue\(req, "statusProbePow"\)/.test(src), "isSyntheticRequest marks the probe's call synthetic");
  ok([...src.matchAll(/issueChallenge\([^)]*probe/g)].length === 1 && /issueChallenge\(requested, \{ probe \}\)/.test(src), "the probe challenge is issued from the challenge route only");

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
