// Log-injection guard (audit F24). Attacker-controlled strings interpolated
// into log lines must have CR/LF, ANSI/CSI escapes, and other control
// characters stripped, so they cannot forge log lines or emit terminal
// control sequences.
//
//   node scripts/test-log-safe.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { logSafe } from "../src/log-safe.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const evil = "client\r\n[fake] forged log line\x1b[31m\x00\x07\x9b";
const out = logSafe(evil);
ok(!/[\r\n]/.test(out), "strips CR/LF (no log-line forging)");
ok(!/\x1b/.test(out), "strips ANSI/CSI escape introducer");
ok(!/[\x00-\x1f\x7f-\x9f]/.test(out), "strips all C0/C1 control characters + DEL");
ok(out.includes("client") && out.includes("forged log line"), "keeps the printable text");
ok(logSafe(null) === "" && logSafe(undefined) === "", "null/undefined become empty string");
ok(logSafe("x".repeat(500), 80).length === 80, "length-capped");
ok(logSafe("normal-client@1.2.3") === "normal-client@1.2.3", "leaves benign input untouched");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
