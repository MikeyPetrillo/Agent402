// Captcha-kit — offline unit tests. captcha-generate is fully offline;
// captcha-verify's handler is exercised only for input validation (no live
// provider call). node scripts/test-captcha-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash } from "node:crypto";
import { CAPTCHA_TOOLS } from "../src/tools/captcha-kit.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const gen = CAPTCHA_TOOLS.find((t) => t.slug === "captcha-generate");
const verify = CAPTCHA_TOOLS.find((t) => t.slug === "captcha-verify");

ok(CAPTCHA_TOOLS.length === 2, "two tools exported");
ok(/no solving|not defeating|no bypass/i.test(verify.description + gen.description), "descriptions carry the anti-solver stance (verify+generate only, never solve)");

// --- captcha-generate: the salted hash actually verifies the answer ---------
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, "");
for (const type of ["math", "alnum"]) {
  const r = gen.handler({ type, difficulty: 2 });
  ok(r.type === type && typeof r.prompt === "string" && r.prompt.length > 0, `${type}: returns a prompt`);
  ok(/^[0-9a-f]{32}$/.test(r.salt) && /^[0-9a-f]{64}$/.test(r.answerHash), `${type}: salt + sha256 hash shape`);
  // Recover the answer from the prompt and confirm the documented verify formula holds.
  let answer;
  if (type === "math") {
    const m = r.prompt.match(/What is (\d+) ([×+]) (\d+)/);
    answer = String(m[2] === "×" ? Number(m[1]) * Number(m[3]) : Number(m[1]) + Number(m[3]));
  } else {
    answer = r.prompt.match(/Type these characters: (\S+)/)[1];
  }
  const check = createHash("sha256").update(r.salt + norm(answer)).digest("hex");
  ok(check === r.answerHash, `${type}: sha256(salt + normalized answer) === answerHash (the caller's stateless verify works)`);
  // a wrong answer must NOT verify
  const wrong = createHash("sha256").update(r.salt + norm("definitely-wrong")).digest("hex");
  ok(wrong !== r.answerHash, `${type}: a wrong answer fails the hash`);
}

// two generates are independent (fresh salt each time)
ok(gen.handler({ type: "math" }).salt !== gen.handler({ type: "math" }).salt, "each challenge gets a fresh salt");

// --- captcha-verify: input validation before any network ---------------------
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
ok((await threw(() => verify.handler({ provider: "solvr", secret: "x", token: "y" })))?.statusCode === 400, "unknown provider → 400 (allowlist, no SSRF)");
ok((await threw(() => verify.handler({ provider: "turnstile", token: "y" })))?.statusCode === 400, "missing secret → 400");
ok((await threw(() => verify.handler({ provider: "hcaptcha", secret: "x" })))?.statusCode === 400, "missing token → 400");
ok(/turnstile|recaptcha|hcaptcha/.test(verify.discovery.inputSchema.properties.provider.description), "provider allowlist documented");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
