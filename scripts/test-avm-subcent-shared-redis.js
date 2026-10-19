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

// One child process = one container: scripts/lib/avm-subcent-driver.js runs one
// named operation (data only, never code) and prints its JSON result last.
const DRIVER = new URL("./lib/avm-subcent-driver.js", import.meta.url).pathname;
function container(op, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [DRIVER, JSON.stringify({ op, payTo: PAYTO, req })], { env: { ...process.env, SHARED_LIMITS_PREFIX: PREFIX, SHARED_LIMITS: "on", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      const last = out.trim().split("\n").pop();
      try { resolve(JSON.parse(last)); } catch { resolve({ error: `exit ${code}: ${err.slice(-400)} ${out.slice(-200)}` }); }
    });
  });
}

// ---- B before any refusal: offered ---------------------------------------------
const b0 = await container("offer");
ok(b0.n === 0 && b0.paused === false && b0.kept === 2, `before any refusal B offers the sub-cent Algorand accept (${JSON.stringify(b0)})`);

// ---- A records a refusal ---------------------------------------------------------
// The refusal's shared write is fire-and-forget (the settle path never waits on
// Redis), so this container stays up until the flag is readable rather than for
// a fixed time: a cold Redis connection can take longer than any fixed sleep.
const a = await container("refuse");
ok(a.p === true && a.paused === true, `A pauses on its own refusal (${JSON.stringify(a)})`);
ok(a.landed === true, "A's refusal reaches the shared store");

// ---- B, a separate process, reads it --------------------------------------------
const b1 = await container("read");
ok(b1.before === false, "B is not paused before its shared read");
ok(b1.n === 1 && b1.paused === true, `B pauses after one shared read (${JSON.stringify(b1)})`);
ok(Array.isArray(b1.kept) && b1.kept.length === 1 && b1.kept[0] === "eip155:8453", "B's next 402 drops the sub-cent Algorand accept and keeps the rest");
ok(b1.rails === 1, "B publishes the pause on /api/rails");

// ---- the 402 path itself picks it up: the gate's build kicks the shared read ----------
// The first build only kicks the read; the driver waits for that read to apply
// (bounded), not for a fixed time, since the first read also opens the connection.
const b3 = await container("gate");
ok(b3.first === 2 && Array.isArray(b3.second) && b3.second.length === 1 && b3.second[0] === "eip155:8453", `a fresh container's gate withdraws the accept from the 402 after its first build kicks the shared read (${JSON.stringify(b3)})`);

// ---- B's headroom read inside the hold window does not reopen it -----------------
const b2 = await container("headroom");
ok(b2.v === "held" && b2.paused === true, `a headroom read on B inside the hold keeps it withdrawn (${JSON.stringify(b2)})`);

// ---- a refusal past the hold window pauses nothing --------------------------------
const old = await container("old");
ok(old.applied === false, "a shared refusal older than the hold window is not applied");

// ---- a process with no shared store does not read it ---------------------------------
const mem = await container("sync", { SHARED_LIMITS: "off" });
ok(mem.n === 0 && mem.paused === false, `with the shared store off, a process decides on its own state (${JSON.stringify(mem)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
