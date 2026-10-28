#!/usr/bin/env node
// The retry-safety contract we publish must be TRUE, including its edge case.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-retry-contract.js
//
// WHY: we told agents "a failed call is NEVER charged - structurally". Our own
// charged-failure alarm exists precisely for the case where that is false: a
// non-200 carrying a settle receipt that does not say success:false is counted
// as charged-but-failed and paged on. Publishing an absolute where we operate a
// detector for the exception is an overclaim, and it is the kind a buyer only
// discovers when they are the exception.
//
// The published contract is now derivable by the buyer from the response they
// already hold. This asserts the four branches stay stated, stay mutually
// exclusive, and that the copy never re-absolutises.
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const llms = await (await fetch(`${TARGET}/llms-full.txt`)).text();
ok(llms.length > 500, "llms.txt served");

// --- the four branches are all stated ---------------------------------------
ok(/No .?PAYMENT-RESPONSE.? header/i.test(llms), "branch 1: no receipt → not charged");
ok(/success: false/.test(llms), "branch 2: receipt success:false → rejected, not charged");
ok(/charged and served/i.test(llms), "branch 3: settled + under 400 → charged and served");
ok(/residual case/i.test(llms) && /may have moved without service/i.test(llms),
  "branch 4: settled + 400-or-above → the residual case is DISCLOSED, not hidden");

// --- the overclaim must not come back ---------------------------------------
// "never charged" as an absolute is the exact phrasing our own alarm refutes.
ok(!/failed call is never charged/i.test(llms),
  "the absolute claim 'a failed call is never charged' is NOT published");
ok(!/cannot happen/i.test(llms.replace(/rather than claim it cannot happen/i, "")),
  "no other 'cannot happen' absolute crept in");

// --- the operational facts a retrying buyer needs ---------------------------
ok(/single-use/i.test(llms), "states that an authorization is single-use, so a retry needs a fresh signature");
ok(/Idempotency-Key/.test(llms), "states how to make a paid retry replay instead of re-charging");
ok(/Do NOT blind-retry/i.test(llms), "tells the buyer explicitly when NOT to retry");

// --- the claim must match the code that enforces it -------------------------
// If the server ever settles a >=400, or stops treating success:false as
// not-charged, this copy becomes a lie. Pin the two facts the contract rests on.
const src = await (await fetch(`${TARGET}/health`)).json().catch(() => ({}));
ok(Boolean(src), "server reachable for the code-fact check");
const { readFileSync } = await import("node:fs");
const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/receipt\?\.success === false/.test(serverSrc),
  "the server still treats an explicit success:false as NOT charged (branch 2 holds)");
ok(/recordChargedFailure\(/.test(serverSrc),
  "the server still detects and records the residual charged-failure case (branch 4 is real, not theoretical)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
