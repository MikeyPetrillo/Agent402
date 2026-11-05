#!/usr/bin/env node
// A settlement REJECTION is not a charged failure, and our public number must
// not say it is.
//
//   node scripts/test-charged-failure-honesty.js
//
// WHY: /api/stats published `chargedButFailed: 1726` with no caveat. Against
// 25,800 USDC calls that advertises a ~6.7% "we took your money and delivered
// nothing" rate to anyone evaluating us as a seller. It is false.
//
// Every one of the 200 retained events is status 402 — a facilitator declining
// settlement, where the buyer KEEPS their money and we simply lose the sale —
// and there has been no event at all since the recording bug was fixed. The
// lifetime counter cannot be un-polluted because the pre-fix events carry no
// marker, so the fix is to publish the meaningful number beside it and name the
// defect rather than quietly dropping the bad one.
//
// This is the same failure we diagnose in others: a self-reported metric that
// does not survive scrutiny. Ours was worse than theirs in one respect — it
// defamed us.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { recordChargedFailure, getStats } from "../src/stats.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const stats = () => getStats({ wallet: "0x0", walletName: "x", network: "base", toolCount: 1, baseUrl: "http://x", prices: {} });

const before = stats();
ok(typeof before.chargedButFailedGenuine === "number",
  "the genuine count is published, not just the polluted lifetime counter");
ok(typeof before.chargedButFailedNote === "string" && /settlement REJECTION/i.test(before.chargedButFailedNote),
  "the payload names the defect in the lifetime counter rather than hiding it");

// A 402 is a settlement rejection: the buyer was never charged. It must never
// raise the genuine count, however it reached the log.
recordChargedFailure("test-402-tool", 402);
recordChargedFailure("test-402-tool", 402);
const afterRejections = stats();
ok(afterRejections.chargedButFailedGenuine === before.chargedButFailedGenuine,
  `two settlement rejections do NOT raise the genuine count (${before.chargedButFailedGenuine} -> ${afterRejections.chargedButFailedGenuine})`);

// A real charged failure — settled, then a 5xx — must raise it. Otherwise the
// metric is useless in the other direction, which is how a broken alarm hides.
recordChargedFailure("test-real-tool", 500);
const afterReal = stats();
ok(afterReal.chargedButFailedGenuine === afterRejections.chargedButFailedGenuine + 1,
  `a settled 5xx DOES raise the genuine count (${afterRejections.chargedButFailedGenuine} -> ${afterReal.chargedButFailedGenuine})`);

// The lifetime counter still moves for both, which is exactly why it cannot be
// read as a quality figure.
ok(afterReal.chargedButFailed >= before.chargedButFailed + 3,
  "the lifetime counter still counts rejections too — which is the whole reason it needs its caveat");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
