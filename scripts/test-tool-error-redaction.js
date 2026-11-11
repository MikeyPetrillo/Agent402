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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { leastOurs } from "./lib/ours-clock.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Values built at runtime so the tree carries no credential-shaped literal.
// RUN is the per-run part: a digit and twelve random hex characters, the same
// length on every machine. A process id or a clock remainder is one to seven
// digits, and in a fresh container (a pid under 1000) a canary built from it
// is shorter than the shortest value the redactor reads as a credential.
const RUN = `9${randomBytes(6).toString("hex")}`;
const SECRET = ["canary", "Secret", "Value", RUN].join("");
const DB_PASS = ["pw", "Canary", RUN].join("");
const DB_URL = `postgres://agent:${DB_PASS}@db.internal.test:5432/state`;
const REDIS_PASS = ["rd", "Canary", "Pass9"].join("");
const REDIS_URL = `redis://default:${REDIS_PASS}@redis.internal.test:6379`;
const FEED_KEY = ["feed", "Canary", "Key77"].join("");
// /api/dns refuses a malformed name with exactly this text (src/tools/dns-name-filter.js).
const ECHO_VALUE = "Invalid domain name";
// /__operator/well-known refuses an unknown content type with exactly this text
// (src/well-known-store.js); the operator token is built at runtime.
const OP_ECHO_VALUE = 'contentType must be "application/json" or "text/plain"';
const OP_TOKEN = ["op", "Canary", "Token", RUN].join("");

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
  // RPC endpoints carry the key in the path; Basic credentials are base64;
  // salts are secrets under a name that says neither KEY nor TOKEN.
  const PATH_KEY = ["Rpc", "Canary", "Path", "Key", RUN].join("");
  process.env.PROBE_SOLANA_RPC_URL = `https://sol.example.test/v2/${PATH_KEY}`;
  process.env.PROBE_BASE_RPCS = `https://a.example.test/${PATH_KEY}b, https://b.example.test/rpc?x=${PATH_KEY}c`;
  process.env.PROBE_TEMPO_RPC = `https://tempo.example.test/${PATH_KEY}d`;
  process.env.PROBE_HOOK_URL = `https://hooks.example.test/services/${PATH_KEY}e`;
  process.env.PROBE_FEED_API_KEY = `fk-${PATH_KEY}f`;
  process.env.PROBE_ID_SALT = `salt-${PATH_KEY}g`;
  ok(!r(`fetch failed: https://sol.example.test/v2/${PATH_KEY}`).includes(PATH_KEY), "a *_RPC_URL whose path carries the key is redacted");
  ok(!r(`HTTP request failed. URL: https://sol.example.test/v2/${PATH_KEY}/`).includes(PATH_KEY), "...in its parsed form too, and its key segment on its own");
  ok(!r(`a failed: https://a.example.test/${PATH_KEY}b`).includes(PATH_KEY), "an entry of a *_RPCS list is redacted");
  ok(!r(`b failed: https://b.example.test/rpc?x=${PATH_KEY}c`).includes(PATH_KEY), "...and an RPC query value under any parameter name");
  ok(!r(`dial https://tempo.example.test/${PATH_KEY}d`).includes(PATH_KEY), "a *_RPC value is redacted");
  ok(!r(`post to https://hooks.example.test/services/${PATH_KEY}e failed`).includes(PATH_KEY), "a long key-like path segment of a *_URL is redacted");
  const basicKey = Buffer.from(`fk-${PATH_KEY}f:`).toString("base64");
  const basicPair = Buffer.from(`fk-${PATH_KEY}f:pw123`).toString("base64");
  ok(!r(`echo ${basicKey}`).includes(basicKey.slice(0, 12)), "a secret's base64 form as a Basic user is redacted");
  const pairOut = r(`echo ${basicPair}`);
  ok(!pairOut.includes(basicPair.slice(0, 12)) && !pairOut.includes(basicPair.slice(-6)), "...with the rest of its base64 run");
  const other = Buffer.from("someone:" + ["other", "Canary", "Pw"].join("")).toString("base64");
  ok(r(`Authorization: Basic ${other}`) === "Authorization: Basic [redacted]", "a Basic token in the text loses its credentials whatever their source");
  ok(!r(`hash salt salt-${PATH_KEY}g`).includes(PATH_KEY), "a *_SALT value is redacted");
  for (const prose of ["Basic arithmetic is fine", "Basic Authentication required", "use Basic AuthenticationHeaders"]) ok(r(prose) === prose, `the word Basic in prose passes through ("${prose}")`);
  // A configured *_URL that carries no credential stays readable, whatever
  // its path; one that carries a credential loses that part only.
  process.env.PROBE_DOCS_URL = "https://docs.example.test/guides/getting-started-guide-2024/configuration-reference?section=webhooks-and-retries";
  const docsText = "see https://docs.example.test/guides/getting-started-guide-2024/configuration-reference?section=webhooks-and-retries";
  ok(r(docsText) === docsText, `a non-secret *_URL with long word segments passes through (${r(docsText)})`);
  const HOOK_TOKEN = ["Hook", "Canary", "Tok", RUN, "zz"].join("");
  process.env.PROBE_WEBHOOK_URL = `https://hooks.example.test/services/team-alerts/${HOOK_TOKEN}?channel=ops`;
  const hookOut = r(`post to https://hooks.example.test/services/team-alerts/${HOOK_TOKEN}?channel=ops failed`);
  ok(hookOut === "post to https://hooks.example.test/services/team-alerts/[redacted]?channel=ops failed", `a *_URL loses only its credential segment (${hookOut})`);
  const QTOKEN = ["q", "Canary", RUN, "Abc", "def"].join("");
  process.env.PROBE_EXPORT_URL = `https://export.example.test/v1/data?cursor=${QTOKEN}&format=csv`;
  ok(r(`GET https://export.example.test/v1/data?cursor=${QTOKEN}&format=csv`) === "GET https://export.example.test/v1/data?cursor=[redacted]&format=csv", "a credential-looking query value under any name is redacted, the rest kept");
  // Known key shapes and random runs are credentials; words are not.
  const { looksLikeCredential } = await import("../src/tools/redact.js");
  const shapes = [["sk", "live", "Q1w2E3r4T5y6U7i8"].join("_"), ["ghp", "AbCdEfGhIjKlMnOpQrSt"].join("_"), "123e4567-e89b-42d3-a456-426614174000", "xqzvbnmlkjhgfdsapoiuyt"];
  for (const s of shapes) ok(looksLikeCredential(s), `looksLikeCredential: ${s.slice(0, 6)}... is a credential`);
  for (const s of ["getting-started-guide-2024", "configuration-reference", "internationalization", "release-notes-2026-11-04"]) ok(!looksLikeCredential(s), `looksLikeCredential: ${s} is not`);
  // Encoded spellings of a secret: percent-encoded (either hex case), hex
  // (either case) and with JSON-escaped slashes.
  const ENC = ["enc", "Canary", "/Key+", RUN, "=x"].join("");
  process.env.PROBE_ENCODED_API_KEY = ENC;
  const pct = encodeURIComponent(ENC);
  for (const [label, form] of [["percent-encoded", pct], ["percent-encoded, lowercase escapes", pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
    ["hex", Buffer.from(ENC).toString("hex")], ["uppercase hex", Buffer.from(ENC).toString("hex").toUpperCase()], ["JSON-escaped slashes", ENC.replaceAll("/", "\\/")]]) {
    const out = r(`upstream echoed ${form} back`);
    ok(out === "upstream echoed [redacted] back", `a secret's ${label} form is redacted (${out.slice(0, 60)})`);
  }
  // upstreamErrorText: what a keyless kit relays from an upstream error body.
  {
    const { upstreamErrorText: u } = await import("../src/tools/redact.js");
    ok(u(JSON.stringify({ error: { code: 7, message: "unknown product" }, html: "<p>".repeat(100) })) === "unknown product", "upstreamErrorText: a JSON body gives up its message field only");
    ok(u(JSON.stringify({ message: `bad key fk-${PATH_KEY}f` })).includes("[redacted]") && !u(JSON.stringify({ message: `bad key fk-${PATH_KEY}f` })).includes(PATH_KEY), "upstreamErrorText: the relayed text is redacted");
    const long = u(`x${"\u200b"}y\n\n\tz ${"w".repeat(5000)}`, 120);
    ok(long.startsWith("xy z ") && long.length <= 123 && !long.includes("\u200b") && !/[\n\t]/.test(long), "upstreamErrorText: hidden and control characters go, whitespace folds, the text is bounded");
    const straddle = u(`${"a".repeat(195)} fk-${PATH_KEY}f`, 200);
    ok(!straddle.includes("fk-"), "upstreamErrorText: the whole text is redacted before it is cut, so a cut leaves no key head");
    ok(u("") === "" && u(null) === "" && u("plain text") === "plain text", "upstreamErrorText: empty and plain text pass through");
  }
  // Error text can carry a caller's input, so the scan must stay linear on
  // any shape: a long dotted run, and the same with URLs and @ in it.
  for (const [label, text] of [
    ["a dotted run", "Cannot parse duration: " + "a.".repeat(50_000) + "-"],
    ["a dotted run with a URL and @", "x://" + "a.".repeat(50_000) + "@"],
    ["repeated scheme-like runs", ("ab+c.d-".repeat(20) + "://u:" + "p".repeat(300) + " ").repeat(200) + "@"],
  ]) {
    // Synchronous, so read as the time the thread had a core, least of three.
    const { ms } = leastOurs(() => r(text), { giveUp: 1000 });
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
  // line that builds a json/send answer, a problem body, an error/detail/message field or a
  // console line from e.message or err.message wraps it in redactSecrets.
  // ALLOW lists lines whose message is proven constant (none today).
  const ALLOW = [];
  const ANSWER = /json\(|send\(|Problem\(|\b(?:error|detail|message):|console\.(?:log|warn|error)\(/;
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

// The secret list is built once per distinct set of secret-bearing variables,
// not on every call: a page redacts hundreds of lines in one turn, and the
// encoded forms of a large secret cost far more than the scan.
{
  const { redactSecrets, _secretBuildsForTests } = await import("../src/tools/redact.js");
  process.env.CACHE_PROBE_API_KEY = "cacheprobe-" + "k".repeat(24);
  redactSecrets("warm");
  const before = _secretBuildsForTests();
  let allRedacted = true;
  for (let i = 0; i < 100; i++) if (!redactSecrets(`line ${i} ${process.env.CACHE_PROBE_API_KEY}`).includes("[redacted]")) allRedacted = false;
  ok(_secretBuildsForTests() === before && allRedacted, `100 redactions with the same variables build the secret list once (${_secretBuildsForTests() - before} rebuilds) and redact every line`);
  ok(redactSecrets(`jwt=${Buffer.from(process.env.CACHE_PROBE_API_KEY).toString("base64url")}`).includes("[redacted]"), "a secret's base64url form is redacted too");
  process.env.CACHE_PROBE_API_KEY = "cacheprobe-" + "z".repeat(24);
  const next = redactSecrets(`after the change ${process.env.CACHE_PROBE_API_KEY}`);
  ok(_secretBuildsForTests() === before + 1 && next.includes("[redacted]") && !next.includes("zzzz"), "...and a changed secret is picked up and redacted on the next call");
  delete process.env.CACHE_PROBE_API_KEY;
}

// The [tool-error] console line strips control characters from the message as
// well as the key names, so a caller-chosen message is always one log line.
{
  const { stripControlChars } = await import("../src/prepayment-refusal.js");
  const { readFileSync: rf } = await import("node:fs");
  ok(!/[\n\r\u2028\u2029\u0007]/.test(stripControlChars("a\nb\r\u2028c\u2029d\u0007e")), "stripControlChars leaves no newline, carriage return, line or paragraph separator or bell");
  const server = rf(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("function logToolError(");
  const fn = server.slice(at, at + 4000);
  ok(/console\.error\(`\[tool-error\][^`]*msg=\$\{stripControlChars\(message/.test(fn), "logToolError prints the message through stripControlChars");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
