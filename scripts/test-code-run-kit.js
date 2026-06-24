// Code-run-kit (E2B sandbox) tests — same shape as test-search-kit.js:
// strict on input validation (offline, deterministic) and tolerant of upstream
// errors on live calls. Fails only if an assertion breaks or if every live
// call fails (which would mean the E2B integration is broken).
//
// - Validation block always runs — no key, no network required.
// - Live calls are opt-in via E2B_LIVE_TEST=1 + E2B_API_KEY.
//
//   node scripts/test-code-run-kit.js                   # validation only
//   E2B_LIVE_TEST=1 E2B_API_KEY=... node scripts/test-code-run-kit.js  # full
import { CODE_RUN_TOOLS } from "../src/tools/code-run-kit.js";

const tool = (slug) => CODE_RUN_TOOLS.find((t) => t.slug === slug);
const h = (slug) => tool(slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no E2B key, no network) ---
// Each row asserts the handler throws a 400 on bad input. The 503
// "E2B not configured" path only triggers AFTER validation, so these
// work cleanly without E2B_API_KEY.
for (const [slug, args, label] of [
  ["code-run", {}, "code-run rejects missing code"],
  ["code-run", { code: "" }, "code-run rejects empty code"],
  ["code-run", { code: "   " }, "code-run rejects whitespace-only code"],
  ["code-run", { code: "x=1", language: "ruby" }, "code-run rejects unsupported language"],
  ["code-run", { code: "x=1", language: "PYTHON" }, null],  // case-insensitive — should NOT throw 400
  ["code-run-pro", {}, "code-run-pro rejects missing code"],
  ["code-run-pro", { code: "", language: "python" }, "code-run-pro rejects empty code"],
  ["code-run-pro", { code: "x=1", language: "rust" }, "code-run-pro rejects unsupported language"],
]) {
  try {
    await h(slug)(args);
    // If label is null, we expected it to pass validation. Success means
    // E2B key is set and code ran — that's a pass (validation didn't reject).
    if (label === null) ok(true, "case-insensitive language passes validation (E2B ran)");
  } catch (e) {
    if (label === null) {
      // Expected to pass validation → 503 (no key) or 502 (SDK missing) both mean validation passed
      ok(e.statusCode === 503 || e.statusCode === 502, `case-insensitive language passes validation (got ${e.statusCode})`);
    } else {
      ok(e.statusCode === 400, label + ` (got ${e.statusCode})`);
    }
  }
}

// Code length limit — code-run caps at 10k, code-run-pro at 50k.
{
  const longCode = "x = 1\n".repeat(2001); // ~12,006 chars > 10k
  try { await h("code-run")({ code: longCode }); ok(false, "code-run rejects code over 10k chars"); }
  catch (e) { ok(e.statusCode === 400 && /too long/i.test(e.message), `code-run rejects code over 10k chars (got ${e.statusCode})`); }
}
{
  // Same string should pass for pro tier (under 50k)
  const medCode = "x = 1\n".repeat(2001); // ~12k < 50k
  try {
    await h("code-run-pro")({ code: medCode });
    // Success = E2B key is set and code ran — validation passed (12k < 50k cap)
    ok(true, "code-run-pro accepts 12k code (E2B ran)");
  } catch (e) {
    // 503/502 = no key or SDK, but validation still passed (didn't throw 400)
    ok(e.statusCode === 503 || e.statusCode === 502, `code-run-pro accepts 12k code, hits E2B gate (got ${e.statusCode})`);
  }
}

// Discovery round-trip — the example input should match the documented output
// when E2B is available, but at minimum the tool defs must be well-formed.
for (const slug of ["code-run", "code-run-pro"]) {
  const t = tool(slug);
  ok(t.route && t.name && t.slug === slug, `${slug} tool def is well-formed`);
  ok(t.discovery?.inputSchema?.properties?.code, `${slug} has code in inputSchema`);
  ok(t.discovery?.output?.example?.language === "python", `${slug} example output has language=python`);
}

// --- live E2B calls (opt-in, tolerant of upstream errors) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - LIVE ${label}: ${JSON.stringify(r).slice(0, 200)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - LIVE ${label}: unexpected shape ${JSON.stringify(r).slice(0, 300)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - LIVE ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

if (process.env.E2B_LIVE_TEST === "1") {
  // Python hello world — stdout must contain the expected string.
  await live("code-run", { code: "print('Hello from Agent402!')", language: "python" },
    (r) => r.language === "python" && r.stdout.includes("Hello from Agent402!") && r.error === null,
    "Python hello world");

  // JavaScript hello world — same test, different runtime.
  await live("code-run", { code: "console.log('JS works')", language: "javascript" },
    (r) => r.language === "javascript" && r.stdout.includes("JS works") && r.error === null,
    "JavaScript hello world");

  // Python expression result — the last expression should appear in `result`.
  await live("code-run", { code: "2 + 2", language: "python" },
    (r) => r.result !== null && String(r.result).includes("4"),
    "Python expression result");

  // Python syntax error — error field should be populated, not null.
  await live("code-run", { code: "def foo(:", language: "python" },
    (r) => r.error !== null && typeof r.error.name === "string",
    "Python syntax error returns error object");

  // Pro tier — verify it also works (same E2B SDK, different timeout cap).
  await live("code-run-pro", { code: "import sys; print(sys.version)", language: "python" },
    (r) => r.language === "python" && r.stdout.length > 0 && r.error === null,
    "Pro tier Python sys.version");

  // Multi-line with stderr — verify both streams work.
  await live("code-run", { code: "import sys\nprint('out')\nprint('err', file=sys.stderr)", language: "python" },
    (r) => r.stdout.includes("out") && r.stderr.includes("err"),
    "Python stdout + stderr separation");
} else {
  console.log("skip - live E2B tests (set E2B_LIVE_TEST=1 + E2B_API_KEY to enable)");
}

// --- summary ---
console.log(`\nvalidation: ${assertFail === 0 ? "all passed" : `${assertFail} FAILED`}`);
if (process.env.E2B_LIVE_TEST === "1") {
  console.log(`live: ${liveOk} ok, ${liveErr} upstream errors`);
  if (liveOk === 0 && liveErr > 0) {
    console.error("FAIL: every live call errored — E2B integration may be broken");
    process.exit(1);
  }
}
if (assertFail > 0) process.exit(1);
console.log("PASS");
