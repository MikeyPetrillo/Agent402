import vm from "node:vm";
// Guards for CALLER-SUPPLIED regexes that run on the main event loop.
//
// All ~1,400 tools share one Node event loop, and a synchronous regex with
// catastrophic backtracking (ReDoS) freezes it for everyone — an unauthenticated,
// free-tier DoS. The dedicated `regex` tool sandboxes arbitrary patterns in a
// worker thread with a hard timeout; convenience tools that accept a user regex
// (json-validate's schema.pattern, html-links' filter) use this lightweight guard
// instead: it rejects the common backtracking forms and over-long patterns before
// compiling. Not a full sandbox — a length + shape guard sized to the risk.

export function compileUserRegex(pattern, flags = "") {
  const p = String(pattern ?? "");
  const fail = (msg) => { const e = new Error(msg); e.statusCode = 400; throw e; };
  if (p.length > 200) fail("regex pattern too long (max 200 chars)");
  // Classic ReDoS signature: a quantifier, a group close, another quantifier —
  // (a+)+, (a*)*, (.+)*, ([a-z]+)+ … These blow up exponentially and are the
  // exact shape the DoS review demonstrated. Reject them.
  if (/[+*]\)[+*]/.test(p) || /[+*]\)\{/.test(p) || /\}\)[+*]/.test(p)) {
    fail("regex rejected: nested quantifiers risk catastrophic backtracking - simplify the pattern");
  }
  // The shape list above was bypassable ((a|a)*b, (a+b?)+c, ^(\w+\s?)*$ all
  // passed and ran for seconds on the event loop, review 2026-08-28). Every
  // exponential family needs a QUANTIFIED GROUP or a backreference, so refuse
  // those outright; what remains is at worst polynomial, and the callers cap
  // the subject length so polynomial stays milliseconds.
  if (/\)\s*[+*?{]/.test(p)) fail("regex rejected: a quantifier applied to a group (like (ab)+ or (a|b)*) is not allowed here - use a character class such as [ab]+ instead");
  if (/\\[1-9]|\(\?<[A-Za-z]/.test(p) && /\\k<|\\[1-9]/.test(p)) fail("regex rejected: backreferences are not allowed here");
  if ((p.match(/[+*?]|\{\d/g) || []).length > 10) fail("regex rejected: too many quantifiers (max 10)");
  try {
    return new RegExp(p, flags);
  } catch (e) {
    return fail(`invalid regex: ${e.message}`);
  }
}

// Escape a value so it can be inserted into a regex as a LITERAL (no injection).
/** Cap the SUBJECT a caller regex may run over: a polynomial pattern on an
 *  unbounded string is still a stall. */
export const USER_REGEX_MAX_SUBJECT = 10_000;
export const USER_REGEX_TIMEOUT_MS = 50;
/** Run a caller regex under a HARD time bound. V8 interrupts a running regex
 *  when a vm script times out (measured: a+a+b on 10k chars, 137 s unbounded,
 *  103 ms under the timeout), so the shape guard above is a first filter and
 *  this is the actual guarantee: no caller pattern holds the event loop past
 *  USER_REGEX_TIMEOUT_MS. A timeout is the caller's 400, never a stall. */
export function testUserRegex(re, subject) {
  const s = String(subject ?? "");
  const sub = s.length > USER_REGEX_MAX_SUBJECT ? s.slice(0, USER_REGEX_MAX_SUBJECT) : s;
  try {
    return vm.runInNewContext("re.test(s)", { re, s: sub }, { timeout: USER_REGEX_TIMEOUT_MS });
  } catch (e) {
    if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { const err = new Error(`regex took longer than ${USER_REGEX_TIMEOUT_MS} ms on this input - simplify the pattern`); err.statusCode = 400; throw err; }
    throw e;
  }
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
