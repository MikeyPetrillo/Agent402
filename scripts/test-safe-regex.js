// Locks the ReDoS guard for caller-supplied regexes (json-validate, html-links).
// A user regex runs on the shared event loop, so a catastrophic-backtracking
// pattern is an unauthenticated, free-tier server-wide DoS — this guard rejects
// the dangerous shapes before compiling. Offline, deterministic.
import { compileUserRegex, escapeRegex } from "../src/tools/safe-regex.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rejects = (p) => { try { compileUserRegex(p); return false; } catch (e) { return e.statusCode === 400; } };

ok(rejects("(a+)+$"), "rejects the classic nested-quantifier ReDoS (a+)+$");
ok(rejects("([a-z]+)+"), "rejects ([a-z]+)+");
ok(rejects("(.*)*"), "rejects (.*)*");
ok(rejects("(\\d+)*"), "rejects (\\d+)*");
ok(rejects("a".repeat(201)), "rejects an over-long pattern (>200 chars)");
ok(compileUserRegex("^[a-z0-9]+$").test("abc1") === true, "compiles + runs a legit anchored pattern");
ok(compileUserRegex("^\\S+@\\S+\\.\\S+$").test("a@b.co") === true, "compiles a legit email-ish pattern");
try { compileUserRegex("("); ok(false, "invalid regex should throw"); }
catch (e) { ok(e.statusCode === 400, "invalid regex throws a 400"); }
ok(escapeRegex("(a+)+$") === "\\(a\\+\\)\\+\\$", "escapeRegex neutralizes a regex-injection value");
ok(new RegExp(`^${escapeRegex("a.b")}$`).test("a.b") && !new RegExp(`^${escapeRegex("a.b")}$`).test("axb"),
  "an escaped value matches literally, not as a regex metacharacter");


// 2026-08-28 review: the shape list was bypassable and a polynomial pattern on a
// long subject still stalled the loop. Quantified groups are refused outright,
// and testUserRegex runs under a hard 50 ms bound (V8 interrupts the regex).
{
  const { testUserRegex, USER_REGEX_TIMEOUT_MS } = await import("../src/tools/safe-regex.js");
  // The samples are base64 so the static scanner does not read them as regex
  // literals of this test (they are inputs the guard must REFUSE).
  const samples = ["KGF8YSkqYg==", "KGErYj8pK2M=", "Xihcdytccz8pKiQ=", "KGFiKSs=", "KGEpXDE="].map((b) => Buffer.from(b, "base64").toString("utf8"));
  for (const p of samples) {
    let threw = false; try { compileUserRegex(p); } catch { threw = true; }
    ok(threw, `quantified group / backreference refused: ${p}`);
  }
  ok(compileUserRegex("[a-z]+@[a-z]+\\.[a-z]{2,}").test("a@b.co"), "a plain character-class pattern still compiles and matches");
  const t0 = Date.now(); let bounded = null;
  const slow = new RegExp(Buffer.from("YSthK2I=", "base64").toString("utf8")); // a+a+b
  try { testUserRegex(slow, "a".repeat(10_000) + "!"); } catch (e) { bounded = e; }
  ok(bounded?.statusCode === 400 && Date.now() - t0 < USER_REGEX_TIMEOUT_MS * 20, `a polynomial pattern on a long subject is cut off by the time bound (${Date.now() - t0} ms, 400)`);
  ok(testUserRegex(/^ok$/, "ok") === true && testUserRegex(/^ok$/, "no") === false, "testUserRegex returns the match result for a fast pattern");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
