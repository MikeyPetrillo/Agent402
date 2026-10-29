// A tool error never carries a configured secret or a credential-bearing URL
// to the buyer or the log (src/tools/redact.js, the route binder's error path
// and logToolError in src/server.js).
//
//   1. redactSecrets in process: secret-named values, database and Redis URLs
//      (STATE_DATABASE_URL, REDIS_URL) whole, any *_URL with userinfo or a
//      credential query parameter (and each entry of a URL list), a
//      userinfo password in the text itself; a plain URL and innocent text
//      pass through.
//   2. The caller path: a real FREE_MODE boot (port 0) with a secret and a
//      database URL configured, and a tool (regex) whose error message quotes
//      its input. The 400 body and every server log line carry neither value.
//
//   node scripts/test-tool-error-redaction.js
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Values built at runtime so the tree carries no credential-shaped literal.
const SECRET = ["canary", "Secret", "Value", String(Date.now() % 1e6)].join("");
const DB_PASS = ["pw", "Canary", String(process.pid)].join("");
const DB_URL = `postgres://agent:${DB_PASS}@db.internal.test:5432/state`;
const REDIS_PASS = ["rd", "Canary", "Pass9"].join("");
const REDIS_URL = `redis://default:${REDIS_PASS}@redis.internal.test:6379`;
const FEED_KEY = ["feed", "Canary", "Key77"].join("");

// --- 1. redactSecrets in process ---------------------------------------------
{
  const saved = { ...process.env };
  Object.assign(process.env, {
    PROBE_UPSTREAM_TOKEN: SECRET,
    STATE_DATABASE_URL: DB_URL,
    REDIS_URL,
    PROBE_FEED_URL: `https://feed.example.test/v1?api_key=${FEED_KEY}&fmt=json`,
    PROBE_FALLBACK_URLS: `https://a.example.test/, https://user:${DB_PASS}x@b.example.test/`,
    PROBE_PLAIN_URL: "https://public.example.test/docs",
  });
  const { redactSecrets } = await import("../src/tools/redact.js");
  const r = (s) => redactSecrets(s);
  ok(!r(`upstream said ${SECRET}`).includes(SECRET), "a secret-named value is redacted");
  ok(!r(`connect ECONNREFUSED ${DB_URL}`).includes(DB_URL) && !r(`connect ECONNREFUSED ${DB_URL}`).includes(DB_PASS), "STATE_DATABASE_URL is redacted whole");
  ok(!r(`password authentication failed (${DB_PASS})`).includes(DB_PASS), "...and its password on its own");
  ok(!r(`redis error at ${REDIS_URL}`).includes(REDIS_PASS), "REDIS_URL is redacted");
  ok(!r(`GET https://feed.example.test/v1?api_key=${FEED_KEY}&fmt=json failed`).includes(FEED_KEY), "a *_URL with a credential query parameter is redacted");
  ok(!r(`fell back past ${FEED_KEY}`).includes(FEED_KEY), "...and the parameter's value on its own");
  ok(!r(`b failed: https://user:${DB_PASS}x@b.example.test/`).includes(`${DB_PASS}x`), "an entry of a *_URLS list with userinfo is redacted");
  const loose = ["loose", "Canary", "Pw"].join("");
  ok(!r(`dial mysql://root:${loose}@10.0.0.9/app`).includes(loose), "a userinfo password in the text itself is redacted even when no variable names it");
  ok(r("see https://public.example.test/docs for the shape") === "see https://public.example.test/docs for the shape", "a plain URL passes through unchanged");
  ok(r("Missing or invalid \"pattern\"") === "Missing or invalid \"pattern\"", "innocent text passes through unchanged");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// --- 2. the caller path: route binder answer and log ---------------------------
const TMP = mkdtempSync(join(tmpdir(), "a402-err-redact-"));
const child = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    FREE_MODE: "true",
    PORT: "0",
    X402_SYNC_ON_START: "false",
    X402_INDEX_CRAWL: "off",
    X402_PAYWALL_PROBES_PER_CYCLE: "0",
    AGENT402_TASK_DATA_DIR: join(TMP, "tasks"),
    MEMORY_DB_FILE: process.env.MEMORY_DB_FILE || join(TMP, "memory.db"),
    PROBE_UPSTREAM_TOKEN: SECRET,
    // A credential-bearing database URL under a URL name the server does not
    // read (STATE_DATABASE_URL itself would switch the state store on).
    PROBE_DATABASE_URL: DB_URL,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not listen within 120s\n${log.slice(-2000)}`)), 120_000);
    const onData = (d) => {
      log += d.toString();
      const m = log.match(/Agent402 listening on :(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code} before listening\n${log.slice(-2000)}`)); });
  });
  // The regex tool's error quotes its pattern, so the handler throws an error
  // whose message carries both configured values.
  const res = await fetch(`http://127.0.0.1:${port}/api/regex`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pattern: `(${SECRET} ${DB_URL}`, text: "a" }),
  });
  const body = await res.text();
  ok(res.status === 400, `the throwing handler answers 400 (${res.status})`);
  ok(/Invalid regex/.test(body) && body.includes("[redacted]"), `the answer keeps the error and marks what it removed (${body.slice(0, 120)})`);
  ok(!body.includes(SECRET), "the answer carries no configured secret");
  ok(!body.includes(DB_PASS) && !body.includes(DB_URL), "the answer carries no database URL or its password");
  await new Promise((r) => setTimeout(r, 300));
  const errLine = log.split("\n").find((l) => l.includes("[tool-error]") && l.includes("slug=regex")) || "";
  ok(errLine.length > 0, "the error is logged under [tool-error]");
  ok(!log.includes(SECRET), "no log line carries the configured secret");
  ok(!log.includes(DB_PASS), "no log line carries the database URL's password");
} catch (e) {
  fail++; console.error(`FAIL - ${e?.stack || e}`);
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
