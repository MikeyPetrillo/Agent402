// The server builds and verifies Tempo transactions with `ox` (src/mpp-tempo.js,
// src/mppx-store.js) while mppx signs and parses them with its own `ox`. The
// direct dependency is pinned to the version mppx declares, so one copy is
// installed and both sides share its encoders. A drift reinstalls a second
// copy under mppx and fails here.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const mppx = lock.packages["node_modules/mppx"];
const wanted = mppx?.dependencies?.ox;
ok(typeof wanted === "string" && /^\d+\.\d+\.\d+$/.test(wanted), `mppx declares an exact ox version (${wanted})`);
ok(pkg.dependencies?.ox === wanted, `the direct ox pin (${pkg.dependencies?.ox}) is the version mppx declares`);
ok(lock.packages["node_modules/ox"]?.version === wanted, "the hoisted ox is that version");
ok(!lock.packages["node_modules/mppx/node_modules/ox"], "mppx installs no second ox of its own");

console.log(`test-ox-single-copy: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
