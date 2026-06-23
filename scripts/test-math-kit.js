// Tests for math-kit (prime-factorize, gcd-lcm, combinatorics,
// matrix-multiply, mod-arithmetic). Pure functions, no server needed.
import { MATH_TOOLS } from "../src/tools/math-kit.js";

const tool = (slug) => MATH_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// --- prime-factorize ---

// Validation: rejects number < 2
let threw = false;
try { run("prime-factorize", { number: 1 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "prime-factorize rejects number < 2");

// Validation: rejects number > 10^15
threw = false;
try { run("prime-factorize", { number: 1e16 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "prime-factorize rejects number > 10^15");

// 12 = 2*2*3
let r = run("prime-factorize", { number: 12 });
ok(JSON.stringify(r.factors) === JSON.stringify([2, 2, 3]), `prime-factorize 12 factors (got ${JSON.stringify(r.factors)})`);
ok(r.isPrime === false, "prime-factorize 12 is not prime");

// 17 is prime
r = run("prime-factorize", { number: 17 });
ok(JSON.stringify(r.factors) === JSON.stringify([17]), `prime-factorize 17 factors (got ${JSON.stringify(r.factors)})`);
ok(r.isPrime === true, "prime-factorize 17 is prime");

// 360 factorization includes multiplication sign
r = run("prime-factorize", { number: 360 });
ok(r.factorization.includes("\u00d7"), `prime-factorize 360 factorization includes \u00d7 (got "${r.factorization}")`);

// Deterministic
const r2 = run("prime-factorize", { number: 360 });
ok(JSON.stringify(r) === JSON.stringify(r2), "prime-factorize is deterministic");

// --- gcd-lcm ---

// Validation: rejects non-positive
threw = false;
try { run("gcd-lcm", { a: 0, b: 5 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "gcd-lcm rejects non-positive a");

threw = false;
try { run("gcd-lcm", { a: 5, b: -1 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "gcd-lcm rejects non-positive b");

// 48, 18
r = run("gcd-lcm", { a: 48, b: 18 });
ok(r.gcd === 6, `gcd-lcm gcd(48,18) = 6 (got ${r.gcd})`);
ok(r.lcm === 144, `gcd-lcm lcm(48,18) = 144 (got ${r.lcm})`);
ok(r.coprime === false, "gcd-lcm 48,18 not coprime");

// 7, 13 are coprime
r = run("gcd-lcm", { a: 7, b: 13 });
ok(r.coprime === true, "gcd-lcm 7,13 coprime");

// Deterministic
const r3 = run("gcd-lcm", { a: 48, b: 18 });
ok(JSON.stringify(run("gcd-lcm", { a: 48, b: 18 })) === JSON.stringify(r3), "gcd-lcm is deterministic");

// --- combinatorics ---

// Validation: rejects r > n
threw = false;
try { run("combinatorics", { n: 3, r: 5 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "combinatorics rejects r > n");

// C(10,3) = 120
r = run("combinatorics", { n: 10, r: 3, type: "combination" });
ok(r.result === "120", `combinatorics C(10,3) = 120 (got "${r.result}")`);

// P(5,3) = 60
r = run("combinatorics", { n: 5, r: 3, type: "permutation" });
ok(r.result === "60", `combinatorics P(5,3) = 60 (got "${r.result}")`);

// Result is a string (BigInt safety)
ok(typeof r.result === "string", "combinatorics result is a string");

// C(100,50) is a very large string
r = run("combinatorics", { n: 100, r: 50, type: "combination" });
ok(typeof r.result === "string" && r.result.length > 15, `combinatorics C(100,50) is a large string (length ${r.result.length})`);

// Deterministic
const r4 = run("combinatorics", { n: 10, r: 3, type: "combination" });
ok(JSON.stringify(run("combinatorics", { n: 10, r: 3, type: "combination" })) === JSON.stringify(r4), "combinatorics is deterministic");

// --- matrix-multiply ---

// Validation: rejects dimension mismatch
threw = false;
try { run("matrix-multiply", { a: [[1, 2, 3]], b: [[1, 2], [3, 4]] }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "matrix-multiply rejects dimension mismatch");

// [[1,2],[3,4]] x [[5,6],[7,8]] = [[19,22],[43,50]]
r = run("matrix-multiply", { a: [[1, 2], [3, 4]], b: [[5, 6], [7, 8]] });
ok(JSON.stringify(r.result) === JSON.stringify([[19, 22], [43, 50]]), `matrix-multiply 2x2 (got ${JSON.stringify(r.result)})`);

// Identity matrix
r = run("matrix-multiply", { a: [[1, 0], [0, 1]], b: [[5, 6], [7, 8]] });
ok(JSON.stringify(r.result) === JSON.stringify([[5, 6], [7, 8]]), `matrix-multiply identity (got ${JSON.stringify(r.result)})`);

// Returns dimensions
ok(r.dimensions && r.dimensions.m === 2 && r.dimensions.k === 2 && r.dimensions.n === 2, `matrix-multiply returns dimensions (got ${JSON.stringify(r.dimensions)})`);

// --- mod-arithmetic ---

// Validation: rejects invalid op
threw = false;
try { run("mod-arithmetic", { op: "bogus", a: 1, m: 2 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "mod-arithmetic rejects invalid op");

// mod: 7 mod 3 = 1
r = run("mod-arithmetic", { op: "mod", a: 7, m: 3 });
ok(r.result === "1", `mod-arithmetic 7 mod 3 = 1 (got "${r.result}")`);

// modpow: 7^256 mod 13 = 9
r = run("mod-arithmetic", { op: "modpow", a: 7, b: 256, m: 13 });
ok(r.result === "9", `mod-arithmetic 7^256 mod 13 = 9 (got "${r.result}")`);

// modinverse: 3 mod 7 = 5 (3*5=15, 15 mod 7=1)
r = run("mod-arithmetic", { op: "modinverse", a: 3, m: 7 });
ok(r.result === "5", `mod-arithmetic modinverse 3 mod 7 = 5 (got "${r.result}")`);

// modinverse throws when no inverse exists (2 mod 4, gcd=2)
threw = false;
try { run("mod-arithmetic", { op: "modinverse", a: 2, m: 4 }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "mod-arithmetic modinverse throws when no inverse (2 mod 4)");

// Deterministic
const r5 = run("mod-arithmetic", { op: "modpow", a: 7, b: 256, m: 13 });
ok(JSON.stringify(run("mod-arithmetic", { op: "modpow", a: 7, b: 256, m: 13 })) === JSON.stringify(r5), "mod-arithmetic is deterministic");

// --- catalog checks ---
ok(MATH_TOOLS.length === 5, `exports 5 tools (got ${MATH_TOOLS.length})`);
for (const t of MATH_TOOLS) {
  ok(typeof t.route === "string" && t.route.includes("/api/"), `${t.slug} has route`);
  ok(typeof t.name === "string" && t.name.length > 0, `${t.slug} has name`);
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug} has slug`);
  ok(typeof t.category === "string", `${t.slug} has category`);
  ok(t.price === "$0.001", `${t.slug} price is $0.001`);
  ok(typeof t.handler === "function", `${t.slug} has handler`);
  ok(Array.isArray(t.tags) && t.tags.length > 0, `${t.slug} has tags`);
  ok(t.discovery && t.discovery.inputSchema, `${t.slug} has discovery.inputSchema`);
}

// --- summary ---
console.log(`\nmath-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }
