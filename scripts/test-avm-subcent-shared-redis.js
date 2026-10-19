#!/usr/bin/env node
// The Algorand sub-cent pause across containers, on a REAL redis: a settle
// refusal recorded in one process withdraws the sub-cent Algorand accept in a
// second process after one shared read, a refusal older than the hold window
// pauses nothing there, and a process with no shared store is unchanged.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-avm-subcent-shared-redis.js
// Deliberately does not skip without REDIS_URL (CI provides the service container).
import { spawn } from "node:child_process";

if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis; it deliberately does not skip.");
  process.exit(1);
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const PREFIX = `avm${process.pid}${Date.now().toString(36)}`;
const PAYTO = "ALGOPAYTOTESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const req = { scheme: "exact", network: "algorand:mainnet", amount: "1000", payTo: PAYTO, asset: "31566704" };

// One child process = one container. It runs `body` (an async function source
// taking the module `m`) and prints its JSON result on the last line.
function container(body, env = {}) {
  const src = `const m = await import(${JSON.stringify(new URL("../src/avm-sponsorship.js", import.meta.url).href)});
m._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
const out = await (${body})(m);
console.log(JSON.stringify(out));
process.exit(0);`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, SHARED_LIMITS_PREFIX: PREFIX, SHARED_LIMITS: "on", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      const last = out.trim().split("\n").pop();
      try { resolve(JSON.parse(last)); } catch { resolve({ error: `exit ${code}: ${err.slice(-400)} ${out.slice(-200)}` }); }
    });
  });
}

const R = JSON.stringify(req);
// ---- B before any refusal: offered ---------------------------------------------
const b0 = await container(`async (m) => { const n = await m.syncSharedSubcentPause([${JSON.stringify(PAYTO)}]); return { n, paused: m.isSubcentPaused(${JSON.stringify(PAYTO)}), kept: m.withoutPausedSubcentAvm([${R}, { ...${R}, network: "eip155:8453" }]).length }; }`);
ok(b0.n === 0 && b0.paused === false && b0.kept === 2, `before any refusal B offers the sub-cent Algorand accept (${JSON.stringify(b0)})`);

// ---- A records a refusal ---------------------------------------------------------
// The refusal's shared write is fire-and-forget (the settle path never waits on
// Redis), so this container stays up until the flag is readable rather than for
// a fixed time: a cold Redis connection can take longer than any fixed sleep.
const SL = JSON.stringify(new URL("../src/shared-limits.js", import.meta.url).href);
const a = await container(`async (m) => { const p = m.noteAvmSettleRefusal({ network: "algorand:mainnet", payTo: ${JSON.stringify(PAYTO)}, errorReason: "subcent_quota_exceeded" }); const { shared } = await import(${SL}); let landed = false; for (let i = 0; i < 100 && !landed; i++) { const r = await shared.flagGet("avm-subcent-refusal", ${JSON.stringify(PAYTO)}); landed = !!(r?.ok && r.until > 0); if (!landed) await new Promise((r) => setTimeout(r, 100)); } return { p, landed, paused: m.isSubcentPaused(${JSON.stringify(PAYTO)}) }; }`);
ok(a.p === true && a.paused === true, `A pauses on its own refusal (${JSON.stringify(a)})`);
ok(a.landed === true, "A's refusal reaches the shared store");

// ---- B, a separate process, reads it --------------------------------------------
const b1 = await container(`async (m) => { const before = m.isSubcentPaused(${JSON.stringify(PAYTO)}); const n = await m.syncSharedSubcentPause([${JSON.stringify(PAYTO)}]); const reqs = [${R}, { ...${R}, network: "eip155:8453" }]; return { before, n, paused: m.isSubcentPaused(${JSON.stringify(PAYTO)}), kept: m.withoutPausedSubcentAvm(reqs).map((r) => r.network), rails: m.avmSubcentOfferStatus().length }; }`);
ok(b1.before === false, "B is not paused before its shared read");
ok(b1.n === 1 && b1.paused === true, `B pauses after one shared read (${JSON.stringify(b1)})`);
ok(Array.isArray(b1.kept) && b1.kept.length === 1 && b1.kept[0] === "eip155:8453", "B's next 402 drops the sub-cent Algorand accept and keeps the rest");
ok(b1.rails === 1, "B publishes the pause on /api/rails");

// ---- the 402 path itself picks it up: the gate's build kicks the shared read ----------
const b3 = await container(`async (m) => {
  class RS { async buildPaymentRequirementsFromOptions() { return [${R}, { ...${R}, network: "eip155:8453" }]; } }
  m.installAvmSubcentGate(RS);
  const rs = new RS();
  const first = (await rs.buildPaymentRequirementsFromOptions([], {})).length;
  // The first build only kicks the read; wait for that read to apply (bounded),
  // not for a fixed time, since the first read also opens the connection.
  for (let i = 0; i < 100 && !m.isSubcentPaused(${JSON.stringify(PAYTO)}); i++) await new Promise((r) => setTimeout(r, 100));
  const second = (await rs.buildPaymentRequirementsFromOptions([], {})).map((r) => r.network);
  return { first, second };
}`);
ok(b3.first === 2 && Array.isArray(b3.second) && b3.second.length === 1 && b3.second[0] === "eip155:8453", `a fresh container's gate withdraws the accept from the 402 after its first build kicks the shared read (${JSON.stringify(b3)})`);

// ---- B's headroom read inside the hold window does not reopen it -----------------
const b2 = await container(`async (m) => { await m.syncSharedSubcentPause([${JSON.stringify(PAYTO)}]); const v = m.noteSponsorshipStatus(${JSON.stringify(PAYTO)}, { quota: 1000, usedMonth: 10, purchasedRemaining: 0, updatedTs: new Date().toISOString() }); return { v, paused: m.isSubcentPaused(${JSON.stringify(PAYTO)}) }; }`);
ok(b2.v === "held" && b2.paused === true, `a headroom read on B inside the hold keeps it withdrawn (${JSON.stringify(b2)})`);

// ---- a refusal past the hold window pauses nothing --------------------------------
const old = await container(`async (m) => ({ applied: m.applySharedSubcentRefusal(${JSON.stringify(PAYTO)}, Date.now() - 31 * 60_000) })`);
ok(old.applied === false, "a shared refusal older than the hold window is not applied");

// ---- a process with no shared store does not read it ---------------------------------
const mem = await container(`async (m) => { const n = await m.syncSharedSubcentPause([${JSON.stringify(PAYTO)}]); return { n, paused: m.isSubcentPaused(${JSON.stringify(PAYTO)}) }; }`, { SHARED_LIMITS: "off" });
ok(mem.n === 0 && mem.paused === false, `with the shared store off, a process decides on its own state (${JSON.stringify(mem)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
