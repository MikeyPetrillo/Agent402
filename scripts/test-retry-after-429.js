// Every 429 the server answers carries Retry-After.
//
// A client that is told when to come back waits; one that is not retries at
// once, which is the load the limit exists to shed. Two parts:
//   1. A static scan of src/ (scripts/lib/retry-after-scan.js): every line that
//      answers or raises a 429 sets the header on that response path, goes
//      through limitedWithRetryAfter, or carries a `retryAfter` field the
//      answer turns into the header. A new 429 without one fails here.
//   2. Behavior through a booted FREE_MODE server (port 0, own stores): limiters
//      past their bound answer 429 with a whole-second Retry-After of at least 1,
//      and the shared helpers set it from the limiter's own wait.
//
//   node scripts/test-retry-after-429.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan429, ALLOW, NOT_ANSWERS } from "./lib/retry-after-scan.js";
import { bootServer } from "./lib/boot-server.js";
import { limitedWithRetryAfter, retryAfterFromError, retryAfterSecondsOf, toolErrorRetryAfter } from "../src/rate-limit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const wholeSeconds = (v) => /^\d+$/.test(String(v ?? "")) && Number(v) >= 1;

// ---- 1. the static scan ------------------------------------------------------
const sites = scan429(join(ROOT, "src"), ROOT);
ok(sites.length >= 40, `the scan finds the server's 429 sites (${sites.length})`);
for (const s of sites) {
  if (s.allowed || s.notAnswer) continue;
  ok(s.ok, `${s.file}:${s.line} sets Retry-After on its 429 (${s.text.slice(0, 90)})`);
}
for (const a of [...ALLOW, ...NOT_ANSWERS]) {
  ok(sites.some((s) => s.file.endsWith(a.file) && s.text.includes(a.text)), `the exemption for ${a.file} still matches a site (${a.why})`);
}
// The scan reads what it should: a header named only in a message is not
// evidence, and a site that sets it is.
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "a402-ra429-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), [
    "app.get('/a', (req, res) => {",
    "  if (lim.check(ip).limited) return res.status(429).json({ error: 'retry after Retry-After' });",
    "});",
    "app.get('/b', (req, res) => {",
    "  if (limitedWithRetryAfter(res, lim.check(ip))) return res.status(429).json({});",
    "});",
    "app.get('/c', (req, res) => {",
    "  res.set('Retry-After', '60');",
    "  return res.status(429).end();",
    "});",
    "function d() {",
    "  const e = new Error('busy');",
    "  e.statusCode = 429;",
    "  e.retryAfterSeconds = 5;",
    "  throw e;",
    "}",
    "function f() {",
    "  const e = new Error('busy');",
    "  e.statusCode = 429;",
    "  e.retryAfter = 5;",
    "  throw e;",
    "}",
    "",
  ].join("\n"));
  const got = Object.fromEntries(scan429(join(dir, "src"), dir).map((s) => [s.line, s.ok]));
  ok(got[2] === false, "a 429 whose only Retry-After is in its message fails the scan");
  ok(got[5] === true && got[9] === true, "the helper and a header set before the answer pass");
  ok(got[13] === false, "a thrown 429 with only a body field (retryAfterSeconds) fails the scan");
  ok(got[19] === true, "a thrown 429 carrying retryAfter passes");
}

// ---- 2a. the helpers ---------------------------------------------------------
{
  const headers = {};
  const res = { set(k, v) { headers[k] = v; return this; } };
  ok(limitedWithRetryAfter(res, { limited: false }) === false && !("Retry-After" in headers), "a limiter with room sets nothing");
  ok(limitedWithRetryAfter(res, { limited: true, retryAfterSeconds: 12.2 }) === true && headers["Retry-After"] === "13", "the limiter's own wait, rounded up");
  limitedWithRetryAfter(res, { limited: true, retryAfterSeconds: 0 });
  ok(headers["Retry-After"] === "60", "no wait named: the fallback");
  limitedWithRetryAfter(res, { limited: true, retryAfterSeconds: 0.01 });
  ok(headers["Retry-After"] === "1", "never under one second");
  const h2 = {};
  const raw = { setHeader(k, v) { h2[k] = v; } };
  limitedWithRetryAfter(raw, { limited: true, retryAfterSeconds: 7 });
  ok(h2["Retry-After"] === "7", "a bare node response gets it through setHeader");
  const h3 = {};
  const r3 = { set(k, v) { h3[k] = v; return this; } };
  ok(retryAfterFromError(r3, { statusCode: 400, retryAfter: 9 }) === r3 && !("Retry-After" in h3), "a relayed 400 gets no Retry-After");
  retryAfterFromError(r3, { statusCode: 429, retryAfter: 9 });
  ok(h3["Retry-After"] === "9", "a relayed 429 carries its error's retryAfter");
  ok(retryAfterSecondsOf(undefined, 600) === 600 && retryAfterSecondsOf(-3) === 60, "retryAfterSecondsOf falls back on a missing or negative wait");
  // A tool error (the three tool-error answers in src/server.js): a 429 that
  // names no wait still carries the header; its own whole seconds win; any
  // other status that names none gets none.
  const tool = () => { const h = {}; return { h, r: { set(k, v) { h[k] = v; return this; } } }; };
  const t1 = tool(); toolErrorRetryAfter(t1.r, { statusCode: 429 }, 429);
  ok(t1.h["Retry-After"] === "60", `a tool error with status 429 and no retryAfter still carries Retry-After (${t1.h["Retry-After"]})`);
  const t2 = tool(); toolErrorRetryAfter(t2.r, { statusCode: 429, retryAfter: 2.5 }, 429);
  ok(t2.h["Retry-After"] === "3", `a fractional retryAfter on a 429 is rounded up (${t2.h["Retry-After"]})`);
  const t3 = tool(); toolErrorRetryAfter(t3.r, { statusCode: 503, retryAfter: 30 }, 503);
  ok(t3.h["Retry-After"] === "30", "an error's whole-second retryAfter is sent on any status");
  const t4 = tool(); toolErrorRetryAfter(t4.r, { statusCode: 502 }, 502);
  ok(!("Retry-After" in t4.h), "control: a 502 naming no wait gets no Retry-After");
  const serverSrc = (await import("node:fs")).readFileSync(join(ROOT, "src", "server.js"), "utf8");
  ok((serverSrc.match(/toolErrorRetryAfter\(res, err, status\);/g) || []).length === 3 && !/if \(Number\.isInteger\(err\?\.retryAfter\)\) res\.set\("Retry-After"/.test(serverSrc),
    "every tool-error answer in src/server.js sets Retry-After through toolErrorRetryAfter");
}

// ---- 2b. a booted server -----------------------------------------------------
const srv = await bootServer({
  stores: "retry-after-429",
  env: { FREE_MODE: "true", RATE_LIMIT_REPLICAS: "1", POW_CHALLENGE_PER_MIN: "10", OPERATOR_TOKEN: "t".repeat(40) },
});
try {
  // The proof-of-work challenge limiter (a per-minute window of its own).
  let last = null;
  for (let i = 0; i < 12; i++) last = await fetch(`${srv.url}/api/pow/challenge?slug=hash`);
  ok(last.status === 429, `the 11th challenge in a minute is refused (${last.status})`);
  const powWait = last.headers.get("retry-after");
  ok(wholeSeconds(powWait) && Number(powWait) <= 60, `the challenge 429 carries Retry-After inside its minute (${powWait})`);

  // The wish intake (ten an hour per address): a thrown refusal relayed by the route.
  const wish = (i) => fetch(`${srv.url}/api/wish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ need: `a retry-after probe tool number ${i} for a test` }) });
  let w = null;
  for (let i = 0; i < 11; i++) w = await wish(i);
  ok(w.status === 429, `the 11th wish in an hour is refused (${w.status})`);
  const wishWait = w.headers.get("retry-after");
  ok(wholeSeconds(wishWait) && Number(wishWait) <= 3600, `the wish 429 carries Retry-After inside its hour (${wishWait})`);

  // The operator sign-in limiter (five a minute per address).
  let o = null;
  for (let i = 0; i < 7; i++) o = await fetch(`${srv.url}/__operator/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `wrong-${i}` }) });
  ok(o.status === 429, `the operator sign-in past its minute bound is refused (${o.status})`);
  const opWait = o.headers.get("retry-after");
  ok(wholeSeconds(opWait) && Number(opWait) <= 3600, `the operator sign-in 429 carries the limiter's Retry-After (${opWait})`);
} finally {
  await srv.stop();
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
