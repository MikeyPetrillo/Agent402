// Pins for src/x402-boot-init.js and the way payments.js constructs the vendor
// middleware (2026-09-18, the @x402 2.22 -> 2.26 bump).
//
// The class this guards: since @x402/express 2.25 the vendor's own eager init
// exits the PROCESS on a RouteConfigurationError or FacilitatorCapabilityError
// (attachBackgroundInitHandler in @x402/core/http). We drive the init ourselves
// so a facilitator problem at boot degrades paid routes to 500 (the pre-2.25
// contract) instead of crash-looping the container. Offline, no network.
import { readFileSync, readdirSync } from "node:fs";
import { createGuardedInit, withGuardedInit } from "../src/x402-boot-init.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } pass++; };
const tick = () => new Promise((r) => setImmediate(r));

// ---- 1. the vendor really does exit on the fatal classes (so the guard is load-bearing) ----
{
  // The chunk holding attachBackgroundInitHandler has a content-hashed name
  // that changes on every vendor release, so read every esm chunk.
  const distDir = new URL("../node_modules/@x402/core/dist/esm/", import.meta.url);
  const core = readdirSync(distDir).filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(new URL(f, distDir), "utf8")).join("\n")
    + readFileSync(new URL("../node_modules/@x402/express/dist/esm/index.mjs", import.meta.url), "utf8");
  ok(/function attachBackgroundInitHandler[\s\S]{0,400}process\.exit\(1\)/.test(core),
    "vendor: attachBackgroundInitHandler calls process.exit(1) (the behaviour this module exists to keep away from prod)");
  ok(/attachBackgroundInitHandler\(initPromise\)/.test(core), "vendor: paymentMiddlewareFromHTTPServer hangs the exit handler on its own init promise");
}

// ---- 2. payments.js hands the vendor syncFacilitatorOnStart=false and drives init itself ----
{
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(!/\bpaymentMiddleware\(/.test(src), "payments.js: no call to the vendor's paymentMiddleware() (its eager init would own the exit)");
  ok(/paymentMiddlewareFromHTTPServer\(httpServer, undefined, undefined, false\)/.test(src),
    "payments.js: paymentMiddlewareFromHTTPServer(..., false) - the vendor never starts an init of its own");
  ok(/withGuardedInit\(vendorMw, createGuardedInit\(httpServer\), httpServer\)/.test(src),
    "payments.js: the guarded init wraps the vendor middleware");
  ok(/if \(!syncOnStart\) return vendorMw;/.test(src), "payments.js: X402_SYNC_ON_START=false still skips the handshake entirely");
}

// ---- 3. a fatal-class rejection never exits, is logged, and self-heals on the next paid request ----
{
  const exits = [];
  const realExit = process.exit;
  process.exit = (code) => { exits.push(code); };
  const logs = [];
  let calls = 0;
  let mode = "route-error";
  const httpServer = {
    initialize: async () => {
      calls++;
      if (mode === "route-error") { const e = new Error("exact on eip155:42220 is not supported by any facilitator"); e.name = "RouteConfigurationError"; throw e; }
      if (mode === "cap-error") { const e = new Error("capability"); e.name = "FacilitatorCapabilityError"; throw e; }
    },
    requiresPayment: ({ path }) => path.startsWith("/api/"),
  };
  let t = 1000;
  const init = createGuardedInit(httpServer, { log: (l) => logs.push(l), retryAfterMs: 500, now: () => t });
  await tick(); await tick();
  ok(calls === 1, `eager: one attempt at construction (got ${calls})`);
  ok(exits.length === 0, "a RouteConfigurationError at boot does NOT exit the process");
  ok(logs.length === 1 && /RouteConfigurationError/.test(logs[0]) && /process stays up/.test(logs[0]),
    "the failure is logged with its class and says the process stays up");
  ok(init.initialized() === false, "not initialised after a failed attempt");

  // Inside the cooldown a paid request falls through with no new attempt (no fan-out).
  const reached = [];
  const mw = withGuardedInit((req, _res, next) => { reached.push(req.path); next(); }, init, httpServer);
  let nexts = 0;
  await mw({ path: "/api/uuid", method: "GET" }, {}, () => nexts++);
  ok(calls === 1 && reached.length === 1, "paid request inside the cooldown: no new attempt, vendor middleware still reached");
  // A free route never triggers an attempt at all.
  t += 10_000;
  await mw({ path: "/health", method: "GET" }, {}, () => nexts++);
  ok(calls === 1, "a free route never drives an init attempt");
  // Past the cooldown a paid request retries (the vendor's per-request retry, kept).
  await mw({ path: "/api/uuid", method: "GET" }, {}, () => nexts++);
  ok(calls === 2, `paid request past the cooldown re-attempts (got ${calls})`);
  ok(exits.length === 0, "still no process.exit after two failures");

  // Concurrent paid requests share ONE in-flight attempt.
  t += 10_000;
  mode = "cap-error";
  await Promise.all([
    mw({ path: "/api/a", method: "GET" }, {}, () => nexts++),
    mw({ path: "/api/b", method: "GET" }, {}, () => nexts++),
    mw({ path: "/api/c", method: "GET" }, {}, () => nexts++),
  ]);
  ok(calls === 3, `three concurrent paid requests = one attempt (got ${calls})`);
  ok(/FacilitatorCapabilityError/.test(logs.at(-1)), "the second fatal class is logged by name too");
  ok(exits.length === 0, "a FacilitatorCapabilityError does not exit either");

  // Recovery: the facilitator comes back, the next paid request initialises and LATCHES.
  t += 10_000;
  mode = "ok";
  await mw({ path: "/api/uuid", method: "GET" }, {}, () => nexts++);
  ok(init.initialized() === true, "a successful attempt initialises");
  const before = calls;
  t += 10_000;
  await mw({ path: "/api/uuid", method: "GET" }, {}, () => nexts++);
  await mw({ path: "/api/other", method: "GET" }, {}, () => nexts++);
  ok(calls === before, "latched: once initialised nothing re-initialises (a mid-run facilitator death cannot wipe the offer)");
  ok(nexts === reached.length, "every request reached the vendor middleware exactly once");
  process.exit = realExit;
}

// ---- 4. requiresPayment throwing is treated as paid (fail toward waiting, never toward skipping) ----
{
  let calls = 0;
  const httpServer = { initialize: async () => { calls++; }, requiresPayment: () => { throw new Error("shape"); } };
  const init = createGuardedInit(httpServer, { eager: false });
  const mw = withGuardedInit((_r, _s, n) => n(), init, httpServer);
  await mw({ path: "/x", method: "GET" }, {}, () => {});
  ok(calls === 1 && init.initialized(), "an unreadable route table drives the init rather than skipping it");
}

console.log(`\ntest-x402-boot-init: ${pass} assertions passed`);
