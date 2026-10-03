// The charged-failure word on /api/gateway-status, which the 5-minute status
// Worker pages on (the GitHub workflow that read the itemised log ran every
// 4-6 h). Genuine failures only: a 402 row is a settlement refusal where the
// buyer kept the money. Public readers get the word, never a count.
process.env.FREE_MODE = "true";
import { readFileSync } from "node:fs";
const { recordChargedFailure, chargedFailuresGenuineSince } = await import("../src/stats.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const t0 = Date.now() - 1;
const before = chargedFailuresGenuineSince(t0);
ok(before === 0 || typeof before === "number", "the window count reads as a number");
recordChargedFailure("test-slug", 402);
ok(chargedFailuresGenuineSince(t0) === before, "a 402 settlement refusal is not a charged failure");
recordChargedFailure("test-slug", 500);
ok(chargedFailuresGenuineSince(t0) === before + 1, "a settled call answered 500 is counted");
ok(chargedFailuresGenuineSince(1e15) === 0, "the window bounds the count (nothing after its start, nothing counted)");

const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const leg = src.slice(src.indexOf("chargedFailures: (() => {"), src.indexOf("chargedFailures: (() => {") + 600);
ok(/const status = n == null \? "unknown" : n > 0 \? "recent" : "ok"/.test(leg), "gateway-status: recent / ok, and unknown when the store cannot be read");
ok(/full \? \{ status, windowHours: hours, count: n \} : \{ status \}/.test(leg), "gateway-status: the count and window are operator-only; the public read gets the word");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
