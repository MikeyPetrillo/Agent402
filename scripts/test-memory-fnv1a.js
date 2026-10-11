// The local embedding's token hash (fnv1a in src/tools/memory.js) takes a
// string and reads a bounded number of characters. The hashes of the strings
// it has always been given must not change: stored embeddings were made with
// them, so a changed hash would silently break similarity recall. A
// non-string input is hashed as its string form (it used to read `.length`
// off whatever it was handed), and an oversized input is read up to the
// bound, never for as long as the caller says it is.
import { fnv1a } from "../src/tools/memory.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Recorded from the implementation before the change (the first three are the
// published FNV-1a 32-bit test vectors).
const KNOWN = [["", 2166136261], ["a", 3826002220], ["foobar", 3214735720], ["wallet", 2402270636], ["agent402", 1781569632], ["usdc_base", 3084378068], ["x402#", 3761694552], ["memory_recall#", 3913380975], ["été", 2745047931], ["\u{1F600}", 3409036472], ["z".repeat(5000), 359919237]];
for (const [s, h] of KNOWN) ok(fnv1a(s) === h, `hash unchanged for ${JSON.stringify(s.length > 40 ? `${s[0]} x ${s.length}` : s)} (${fnv1a(s)})`);

ok(fnv1a(123) === fnv1a("123"), "a number is hashed as its string form");
ok(fnv1a(null) === fnv1a("null") && fnv1a(undefined) === fnv1a("undefined"), "null and undefined are hashed as their string forms");
const t0 = Date.now();
const huge = fnv1a({ length: 1e12, toString: () => "small" });
ok(huge === fnv1a("small") && Date.now() - t0 < 1000, "an object claiming a huge length is hashed as its string form, at once");
const long = "q".repeat(3 * 1024 * 1024);
const t1 = Date.now();
ok(Number.isInteger(fnv1a(long)) && Date.now() - t1 < 2000, "an oversized string is read up to the bound");

console.log(`\ntest-memory-fnv1a: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
