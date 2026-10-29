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
//      A bespoke route (/api/dns, sendToolError) whose refusal text is a
//      configured value answers and logs it scrubbed, and so does an operator
//      route (/__operator/well-known). The discovery, wish and memory catches,
//      and every route block in server.js, are read from source.
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
// /api/dns refuses a malformed name with exactly this text (src/tools/dns-name-filter.js).
const ECHO_VALUE = "Invalid domain name";
// /__operator/well-known refuses an unknown content type with exactly this text
// (src/well-known-store.js); the operator token is built at runtime.
const OP_ECHO_VALUE = 'contentType must be "application/json" or "text/plain"';
const OP_TOKEN = ["op", "Canary", "Token", String(process.pid)].join("");

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
  // Error text can carry a caller's input, so the scan must stay linear on
  // any shape: a long dotted run, and the same with URLs and @ in it.
  for (const [label, text] of [
    ["a dotted run", "Cannot parse duration: " + "a.".repeat(50_000) + "-"],
    ["a dotted run with a URL and @", "x://" + "a.".repeat(50_000) + "@"],
    ["repeated scheme-like runs", ("ab+c.d-".repeat(20) + "://u:" + "p".repeat(300) + " ").repeat(200) + "@"],
  ]) {
    const t0 = performance.now(); r(text); const ms = performance.now() - t0;
    ok(ms < 100, `redaction of ${text.length} chars (${label}) takes ${ms.toFixed(1)} ms, under 100`);
  }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// --- 1b. every other buyer-facing error responder scrubs too -------------------
// The discovery routes (/api/find, /api/route) cannot be made to throw from
// outside, so their catch is read from source, with the wish and memory ones.
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(join(ROOT, "src", "server.js"), "utf8");
  const discovery = server.slice(server.indexOf("async function serveCachedDiscovery("), server.indexOf("async function serveCachedDiscovery(") + 8000);
  ok(/const errorMessage = redactSecrets\(err\?\.message\);\s+logToolError\(analyticsSlug, status, errorMessage[^;]*;\s+res\.status\(status\)\.json\(\{ error: errorMessage \}\)/.test(discovery), "the discovery catch answers and logs the scrubbed message");
  const send = server.slice(server.indexOf("function sendToolError("), server.indexOf("function sendToolError(") + 1500);
  ok(/const errorMessage = redactSecrets\(err\?\.message\)/.test(send) && /error: errorMessage \|\| "request failed"/.test(send) && !/err\?\.message \|\| "request failed"/.test(send), "sendToolError answers the scrubbed message");
  const wish = server.slice(server.indexOf('app.post("/api/wish"'), server.indexOf('app.post("/api/wish"') + 600);
  ok(/json\(\{ error: redactSecrets\(err\?\.message\) \}\)/.test(wish), "/api/wish answers the scrubbed message");
  const mem = server.slice(server.indexOf("const memHandler = "), server.indexOf("const memHandler = ") + 2500);
  ok(/json\(\{ error: redactSecrets\(err\?\.message\) \}\)/.test(mem), "the memory routes answer the scrubbed message");
  // No route block answers or logs a thrown message raw: inside every app
  // route (literal paths and the catalog binder's app[method](path, ...)), a
  // line that builds a json/send answer, an error/detail/message field or a
  // console line from e.message or err.message wraps it in redactSecrets.
  // ALLOW lists lines whose message is proven constant (none today).
  const ALLOW = [];
  const ANSWER = /json\(|send\(|\b(?:error|detail|message):|console\.(?:log|warn|error)\(/;
  const RAW = /(?<!redactSecrets\()(?<!redactSecrets\(String\()\b(?:e|err)\??\.message\b/;
  const lines = server.split("\n");
  let route = null; const raw = []; let routes = 0, opRoutes = 0;
  for (const [i, line] of lines.entries()) {
    const m = /^\s*app\.(?:get|post|put|delete|all|use)\(\s*"([^"]+)"|^\s*app\[/.exec(line);
    if (m) { route = m[1] || "catalog binder"; routes++; if (route.startsWith("/__operator")) opRoutes++; }
    else if (/^(?:function|async function|const|let|export|for) /.test(line)) route = null;
    if (!route || /^\s*\/\//.test(line) || !ANSWER.test(line) || !RAW.test(line)) continue;
    if (ALLOW.some((a) => line.includes(a))) continue;
    raw.push(`${i + 1} ${route}`);
  }
  ok(opRoutes > 40 && routes > 200 && raw.length === 0, `no route answers or logs a raw thrown message (${routes} route blocks, ${opRoutes} operator${raw.length ? `; raw at ${raw.join(", ")}` : ""})`);
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
    // A configured value that a bespoke route's own refusal carries verbatim:
    // the sendToolError answer must scrub it like any secret.
    PROBE_ECHO_SECRET: ECHO_VALUE,
    PROBE_OPERATOR_ECHO_SECRET: OP_ECHO_VALUE,
    AGENT402_OPERATOR_TOKEN: OP_TOKEN,
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
  // A bespoke route's error (sendToolError): the refusal text is a configured value.
  const dns = await fetch(`http://127.0.0.1:${port}/api/dns?name=${encodeURIComponent("bad!name.example.com")}`);
  const dnsBody = await dns.text();
  ok(dns.status === 400 && /"error":"\[redacted\]"/.test(dnsBody) && !dnsBody.includes(ECHO_VALUE), `a bespoke route's error answer (sendToolError) is scrubbed (${dns.status} ${dnsBody.slice(0, 80)})`);
  await new Promise((r) => setTimeout(r, 300));
  ok(!log.split("\n").some((l) => l.includes("[tool-error]") && l.includes("slug=dns") && l.includes(ECHO_VALUE)), "...and its [tool-error] line too");
  // An operator route's error answer (operator-only, still never a secret).
  const op = await fetch(`http://127.0.0.1:${port}/__operator/well-known`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": OP_TOKEN },
    body: JSON.stringify({ path: "probe-verification/x", body: "x", contentType: "text/html" }),
  });
  const opBody = await op.text();
  ok(op.status === 400 && opBody.includes("[redacted]") && !opBody.includes(OP_ECHO_VALUE), `an operator route's error answer is scrubbed (${op.status} ${opBody.slice(0, 80)})`);
  // The MCP connector's free path books a tool error through logToolError with
  // the handler's own message, so the scrub inside logToolError is the only
  // one between that message and the log.
  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.call", arguments: { slug: "regex", params: { pattern: `(${SECRET} ${DB_URL}`, text: "a" } } } }),
  });
  const mcpBody = await mcp.text();
  await new Promise((r) => setTimeout(r, 300));
  const regexLines = log.split("\n").filter((l) => l.includes("[tool-error]") && l.includes("slug=regex"));
  ok(regexLines.length >= 2 && /Invalid regex/.test(mcpBody), `an MCP catalog.call error is logged under [tool-error] too (${regexLines.length} regex lines)`);
  ok(!regexLines.some((l) => l.includes(SECRET) || l.includes(DB_PASS)), "...and its log line is scrubbed");
  const errLine = regexLines[0] || "";
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
