// The shared numeric-setting readers (src/env-num.js), which replaced copies
// across money limits, breakers and timeouts: zero, negatives, blanks, junk
// and non-finite values fall back to the default; a valid value is kept.
import { positiveNum, envPositive, envAtLeast } from "../src/env-num.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

for (const v of [undefined, null, "", " ", "abc", "0", 0, -1, "-5", "NaN", "Infinity", Infinity]) ok(positiveNum(v, 7) === 7, `positiveNum(${JSON.stringify(v)}) falls back`);
ok(positiveNum("2.5", 7) === 2.5 && positiveNum(3, 7) === 3, "positiveNum keeps a value above zero");

process.env.TEST_ENV_NUM = "0"; ok(envPositive("TEST_ENV_NUM", 9) === 9, "envPositive: zero falls back");
process.env.TEST_ENV_NUM = "12"; ok(envPositive("TEST_ENV_NUM", 9) === 12, "envPositive keeps a set value");
delete process.env.TEST_ENV_NUM; ok(envPositive("TEST_ENV_NUM", 9) === 9, "envPositive: unset falls back");

process.env.TEST_ENV_NUM = "0"; ok(envAtLeast("TEST_ENV_NUM", 5) === 5, "envAtLeast: below the minimum (1) falls back");
process.env.TEST_ENV_NUM = "0"; ok(envAtLeast("TEST_ENV_NUM", 5, 0) === 0, "envAtLeast: zero is kept when the minimum is 0");
process.env.TEST_ENV_NUM = "x"; ok(envAtLeast("TEST_ENV_NUM", 5, 0) === 5, "envAtLeast: junk falls back");
process.env.TEST_ENV_NUM = "3"; ok(envAtLeast("TEST_ENV_NUM", 5) === 3, "envAtLeast keeps a value at or above the minimum");
delete process.env.TEST_ENV_NUM;

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
