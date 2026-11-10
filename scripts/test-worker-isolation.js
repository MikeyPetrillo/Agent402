// Secretless browser/media worker plumbing + isolation invariants (audit
// F02/F04/F06). Offline: exercises the worker's auth/dispatch/secret-guard and
// the API-side client round-trip WITHOUT launching Chromium or ffmpeg (a stub
// server stands in for the tool handlers). The real render/media-through-worker
// path is verified live with a paid smoke once the worker service is deployed.
//
//   node scripts/test-worker-isolation.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });

// --- 1. The real worker: auth + dispatch (no Chromium/ffmpeg needed) ----------
{
  process.env.RENDER_WORKER_TOKEN = "test-worker-token";
  const { app, HANDLERS } = await import("../worker/server.js");
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;

  ok(Object.keys(HANDLERS).includes("render") && Object.keys(HANDLERS).includes("media-info"), "worker exposes render + media handlers");
  ok(Object.keys(HANDLERS).includes("page-speed") && Object.keys(HANDLERS).includes("html-frames"), "worker exposes the browser-pool page-speed + html-frames handlers");
  // Input validation runs on the worker too: a bad html-frames body is a 400, not a pool slot.
  const badFrames = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-worker-token" }, body: JSON.stringify({ slug: "html-frames", input: { html: "<p>", times: [] } }) });
  ok(badFrames.status === 400, `worker html-frames refuses an empty times list with 400 (got ${badFrames.status})`);
  const health = await (await fetch(`${base}/health`)).json();
  ok(health.ok === true && Array.isArray(health.tools), "worker /health reports ok + tool list");

  const noTok = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "render", input: { url: "https://x.com" } }) });
  ok(noTok.status === 401, "worker rejects a /call with no bearer token (401)");
  const badTok = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ slug: "render", input: {} }) });
  ok(badTok.status === 401, "worker rejects a wrong bearer token (401)");
  const unknown = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-worker-token" }, body: JSON.stringify({ slug: "not-a-tool", input: {} }) });
  ok(unknown.status === 404, "worker 404s an unknown tool slug");
  srv.close();
  delete process.env.RENDER_WORKER_TOKEN;
}

// --- 2. The API-side client: round-trip against a stub worker -----------------
{
  const stub = express();
  stub.use(express.json());
  let sawAuth = null, sawBody = null;
  stub.post("/call", (req, res) => {
    sawAuth = req.headers.authorization; sawBody = req.body;
    if (req.body.slug === "render") return res.json({ url: req.body.input.url, markdown: "# hi", untrustedContent: true });
    if (req.body.slug === "screenshot") return res.json({ __binary: Buffer.from("PNGBYTES").toString("base64"), contentType: "image/png" });
    if (req.body.slug === "boom") return res.status(502).json({ error: "upstream boom" });
    res.status(404).json({ error: "unknown" });
  });
  const srv = await listen(stub);
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.RENDER_WORKER_TOKEN = "client-tok";
  const { workerEnabled, runOnWorker } = await import("../src/worker-client.js");

  ok(workerEnabled() === true, "workerEnabled() true when RENDER_WORKER_URL set");
  const r = await runOnWorker("render", { url: "https://ex.com" });
  ok(r.markdown === "# hi" && r.untrustedContent === true, "client returns the worker's JSON result");
  ok(sawAuth === "Bearer client-tok", "client sends the worker bearer token");
  ok(sawBody?.slug === "render" && sawBody?.input?.url === "https://ex.com", "client posts {slug, input} correctly");
  const shot = await runOnWorker("screenshot", { url: "https://ex.com" });
  ok(Buffer.isBuffer(shot.__binary) && shot.__binary.toString() === "PNGBYTES" && shot.contentType === "image/png", "client decodes a binary (__binary) result to a Buffer");
  let threw = null;
  try { await runOnWorker("boom", {}); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502 && /boom/.test(threw.message), "client propagates a worker error with its status code");
  srv.close();
  delete process.env.RENDER_WORKER_URL;
  delete process.env.RENDER_WORKER_TOKEN;
}

// --- 3. The boot guard: a forbidden secret in the worker's env aborts start ---
{
  const child = spawn(process.execPath, [join(ROOT, "worker", "server.js")], {
    // RAILWAY_ENVIRONMENT triggers strict mode (the real runtime): WALLET_ADDRESS
    // isn't secret-SHAPED, but strict mode refuses any non-allowlisted var.
    env: { ...process.env, RAILWAY_ENVIRONMENT: "production", WALLET_ADDRESS: "0xdeadbeef", PORT: "0", RENDER_WORKER_URL: "", RENDER_WORKER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((res) => child.on("exit", res));
  ok(code === 1, `worker REFUSES to boot with a payment secret in env (exit ${code})`);
  ok(/secret env present in the SECRETLESS worker/i.test(out) && /WALLET_ADDRESS/.test(out), "boot guard names the offending secret and fails loud");
}

// --- 4. Shared-image dispatcher: WORKER_MODE selects the worker, else the API -
// start.js boots worker/server.js when WORKER_MODE is truthy (the worker service
// runs the SAME image as main, distinguished only by this env). Assert the exact
// dispatch decision the file uses so a regression can't silently boot the wrong
// server on the worker service.
{
  const src = readFileSync(join(ROOT, "start.js"), "utf8");
  const m = src.match(/\/\^\([^)]*\)\$\/i/);
  ok(Boolean(m), "start.js gates worker mode on a WORKER_MODE regex");
  const re = m ? new RegExp(m[0].slice(1, -2), "i") : /$^/;
  const decide = (v) => (re.test((v || "").trim()) ? "worker" : "api");
  ok(decide("true") === "worker" && decide("1") === "worker" && decide("on") === "worker", "WORKER_MODE=true/1/on -> worker/server.js");
  ok(decide("") === "api" && decide(undefined) === "api" && decide("false") === "api", "WORKER_MODE unset/false -> src/server.js (main byte-identical)");
  ok(/import\([\s\S]{0,80}?["']\.\/worker\/server\.js["']\s*:\s*["']\.\/src\/server\.js["']\s*\)/.test(src) && /import\(["']\.\/services\/decide\/server\.js["']\)/.test(src) && !/child_process|spawn\(|fork\(/.test(src), "start.js imports (not spawns) the selected server so the gosu entrypoint keeps PID 1");
}

// --- 5. Boot-guard secret detection: catches real secrets, not infra vars ---
{
  const { forbiddenSecretsIn } = await import("../worker/server.js");
  // The real secretless worker env on Railway must pass (no false positive) —
  // this is the RAILWAY_PRIVATE_DOMAIN regression that took a deploy down.
  const cleanWorkerEnv = {
    PORT: "3999", WORKER_MODE: "true", RENDER_WORKER_TOKEN: "abc",
    RAILWAY_ENVIRONMENT: "production", // triggers STRICT mode (the real Railway runtime)
    RAILWAY_PRIVATE_DOMAIN: "agent402-worker.railway.internal",
    RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_PROJECT_ID: "x",
    RAILWAY_SERVICE_ID: "y", RAILWAY_SERVICE_AGENT402_URL: "z",
    RAILWAY_DOCKERFILE_PATH: "Dockerfile.worker", PATH: "/usr/bin", HOME: "/home/node",
    HOSTNAME: "abc", NODE_VERSION: "22", npm_config_cache: "/tmp",
    RENDER_EGRESS_PROXY_URL: "http://127.0.0.1:5",
  };
  ok(forbiddenSecretsIn(cleanWorkerEnv).length === 0, "the real (strict-mode) Railway worker env passes: only allowlisted / system / RAILWAY_* vars");
  // Real secrets the OLD denylist missed must now trip it.
  for (const k of ["GITHUB_TOKEN", "E2B_API_KEY", "STELLAR_FACILITATOR_KEY", "ALGORAND_BURNER_MNEMONIC", "OPENROUTER_API_KEY", "CDP_API_KEY_SECRET"]) {
    ok(forbiddenSecretsIn({ [k]: "v", RENDER_WORKER_TOKEN: "t" }).includes(k), `guard catches ${k} (pattern-based, not the old 12-name denylist)`);
  }
  // Non-pattern secrets stay covered; the worker's own token stays allowed.
  ok(forbiddenSecretsIn({ DATABASE_URL: "postgres://x" }).includes("DATABASE_URL"), "a DB connection string (DATABASE_URL) is caught in every mode (secret-shaped)");
  ok(forbiddenSecretsIn({ RAILWAY_ENVIRONMENT: "production", WALLET_ADDRESS: "0x" }).includes("WALLET_ADDRESS"), "a non-secret-shaped operator var (WALLET_ADDRESS) is caught in strict (Railway) mode");
  ok(forbiddenSecretsIn({ RENDER_WORKER_TOKEN: "t" }).length === 0, "the worker's OWN inbound-auth token is allowed");
  ok(forbiddenSecretsIn({ FOO_KEY: "" }).length === 0, "an empty secret var is ignored (only set values count)");
  // FR4-05: credential-bearing URL/DSN/DB/ledger names (which don't contain
  // KEY/SECRET/TOKEN) must now trip the guard too.
  for (const k of ["REDIS_URL", "SENTRY_DSN", "REVENUE_LEDGER_URL", "ECONOMY_DATABASE_URL", "MONGO_URI", "SALES_LEDGER"]) {
    ok(forbiddenSecretsIn({ [k]: "v", RENDER_WORKER_TOKEN: "t" }).includes(k), `guard catches credential-bearing ${k}`);
  }
  ok(forbiddenSecretsIn({ RAILWAY_SERVICE_AGENT402_URL: "http://x", RENDER_WORKER_TOKEN: "t" }).length === 0, "benign Railway service-metadata URL is allowed (RAILWAY_* URLs exempt)");
  ok(forbiddenSecretsIn({ RAILWAY_TOKEN: "secret" }).includes("RAILWAY_TOKEN"), "but RAILWAY_TOKEN (a real secret) is still caught");
  // STRICT allowlist (P1.2), enforced in the Railway runtime (RAILWAY_ENVIRONMENT
  // present): an UNRECOGNIZED var — even one with no secret-shaped name — refuses
  // boot; only explicitly-allowed / system / Railway metadata pass.
  ok(forbiddenSecretsIn({ RAILWAY_ENVIRONMENT: "production", SOME_RANDOM_CONFIG: "x", RENDER_WORKER_TOKEN: "t" }).includes("SOME_RANDOM_CONFIG"), "strict (Railway) mode: an unrecognized (non-secret-shaped) var refuses boot");
  ok(forbiddenSecretsIn({ RAILWAY_ENVIRONMENT: "production", PATH: "/usr/bin", NODE_ENV: "production", npm_config_cache: "/tmp", RENDER_WORKER_TIMEOUT_MS: "60000" }).length === 0, "strict mode: known system + exact-allowed vars pass");
  // Dev/CI (no RAILWAY_ENVIRONMENT): benign unknown noise is tolerated so the
  // worker still boots locally — but secret-shaped names are STILL blocked.
  ok(forbiddenSecretsIn({ SOME_EDITOR_VAR: "x", __CF_USER_TEXT_ENCODING: "0x1F5", RENDER_WORKER_TOKEN: "t" }).length === 0, "dev mode: benign unknown vars are tolerated (no false-positive boot failure)");
  ok(forbiddenSecretsIn({ GITHUB_TOKEN: "ghp_x" }).includes("GITHUB_TOKEN"), "dev mode: a secret-shaped name is STILL blocked (shape denylist applies everywhere)");
}

// --- 6. FR4-06: render-worker config is atomic (both URL+token or neither) ----
{
  const { workerEnabled, assertWorkerConfig } = await import("../src/worker-client.js");
  const save = { u: process.env.RENDER_WORKER_URL, t: process.env.RENDER_WORKER_TOKEN };
  const set = (u, t) => { u == null ? delete process.env.RENDER_WORKER_URL : process.env.RENDER_WORKER_URL = u; t == null ? delete process.env.RENDER_WORKER_TOKEN : process.env.RENDER_WORKER_TOKEN = t; };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  set("http://w.internal:3999", "tok");
  ok(workerEnabled() === true, "workerEnabled() true only when BOTH url and token are set");
  ok(!threw(assertWorkerConfig), "assertWorkerConfig passes when both are set");
  set("http://w.internal:3999", null);
  ok(workerEnabled() === false, "workerEnabled() false when the token is missing (would 401 every paid call)");
  ok(threw(assertWorkerConfig), "assertWorkerConfig THROWS on a partial config (url without token)");
  set(null, "tok");
  ok(threw(assertWorkerConfig), "assertWorkerConfig THROWS on a partial config (token without url)");
  set(null, null);
  ok(workerEnabled() === false && !threw(assertWorkerConfig), "neither set -> in-process, no throw");
  // P1.1: RENDER_WORKER_REQUIRED makes a missing worker config a HARD boot failure
  // (prod can demand isolation instead of silently running browser/media in-process).
  const saveReq = process.env.RENDER_WORKER_REQUIRED;
  process.env.RENDER_WORKER_REQUIRED = "true";
  set(null, null);
  ok(threw(assertWorkerConfig), "RENDER_WORKER_REQUIRED=true + no worker config -> THROWS (fail closed)");
  set("http://w.internal:3999", "tok");
  ok(!threw(assertWorkerConfig), "RENDER_WORKER_REQUIRED=true + full config -> ok");
  if (saveReq == null) delete process.env.RENDER_WORKER_REQUIRED; else process.env.RENDER_WORKER_REQUIRED = saveReq;
  // restore
  set(save.u, save.t);
}

// --- 7. Worker threads start with an allowlisted environment ------------------
// A Worker created without an `env` option gets a copy of the whole process
// environment. Every `new Worker(` in the serving tree names its env, and the
// parser workers (PDF, image, HTML, regex, markdown, office) get threadEnv():
// the helper-binary allowlist, NODE_ENV, NODE_OPTIONS and their own knobs.
{
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n.startsWith(".")) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(n) ? [p] : [];
  });
  // The options text of each `new Worker(` call: brackets balanced, strings skipped.
  const callText = (text, open) => {
    let depth = 0, i = open, q = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) break; }
    }
    return text.slice(open, i + 1);
  };
  // The one worker that is not a parser: the router replica builds its own
  // env (the process's, minus its stores) because it runs the index module.
  const OWN_ENV = { "src/router-pool.js": /\{\s*env:\s*workerEnv\(\)\s*\}/ };
  const sites = [];
  for (const dir of ["src", "worker", "services"]) {
    for (const f of walk(join(ROOT, dir))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\bnew Worker\(/g)) sites.push({ file: f.slice(ROOT.length + 1), call: callText(text, m.index + m[0].length - 1) });
    }
  }
  ok(sites.length >= 7, `the worker thread call sites are found (${sites.length})`);
  const bare = sites.filter((x) => !/[{,]\s*env\s*:/.test(x.call)).map((x) => x.file);
  ok(bare.length === 0, `every new Worker( passes an explicit env (without one: ${bare.join(", ") || "none"})`);
  const loose = sites.filter((x) => (OWN_ENV[x.file] ? !OWN_ENV[x.file].test(x.call) : !/[{,]\s*env:\s*threadEnv\(/.test(x.call))).map((x) => x.file);
  ok(loose.length === 0, `every parser worker's env is threadEnv(...) (otherwise: ${loose.join(", ") || "none"})`);
  ok(sites.every((x) => !/SHARE_ENV|env:\s*process\.env\b/.test(x.call)), "no worker shares or is handed process.env itself");

  // Behavior: a secret-shaped variable planted in this process is not in any
  // parser worker's environment. Each pool runs one real job (so the worker
  // still works with the narrowed env); the Worker constructor is wrapped to
  // record the options each real worker was created with, and a probe thread
  // started with exactly that `env` reports what such a worker can read.
  const PLANTED = { PLANTED_PROVIDER_API_KEY: "sk-LEAKCANARY-0123456789", PLANTED_DATABASE_URL: "postgres://u:planted-pw@db.internal/x", X402_UPSTREAM_BUYER_KEY: "0xplanted" };
  Object.assign(process.env, PLANTED);
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const wt = createRequire(import.meta.url)("node:worker_threads");
  const RealWorker = wt.Worker;
  const made = [];
  wt.Worker = class extends RealWorker {
    constructor(file, options) { super(file, options); made.push({ file: String(file).split("/").pop(), options }); }
  };
  syncBuiltinESMExports();
  const probe = (options) => new Promise((res, rej) => {
    const w = new RealWorker('require("node:worker_threads").parentPort.postMessage({ ...process.env })', { eval: true, ...options });
    w.once("message", res); w.once("error", rej);
  });
  try {
    // Control: without an env option a worker does read the planted secret.
    const inherited = await probe({});
    ok(inherited.PLANTED_PROVIDER_API_KEY === PLANTED.PLANTED_PROVIDER_API_KEY, "control: a worker created with no env option reads the planted secret");

    const { KIT } = await import("../src/tools/kit.js");
    const { runMarkdown } = await import("../src/tools/markdown-pool.js");
    const { runHtml } = await import("../src/tools/html-pool.js");
    const { runOfficeOp } = await import("../src/tools/office-pool.js");
    const { validateXlsx } = await import("../src/tools/office-ops.js");
    const { runPdfOp } = await import("../src/tools/pdf-offthread.js");
    const { runImageOffThread } = await import("../src/tools/image-pool.js");
    const { PDFDocument } = await import("pdf-lib");
    const { PNG } = await import("pngjs");
    const doc = await PDFDocument.create(); doc.addPage([200, 200]);
    const pdf = Buffer.from(await doc.save());
    const png = new PNG({ width: 20, height: 20 }); png.data.fill(200);
    const pngBuf = PNG.sync.write(png);

    const rx = await KIT.find((t) => t.slug === "regex").handler({ pattern: "(\\w+)@(\\w+)", text: "mail a@b now" });
    ok(rx.matchCount === 1 && rx.matches[0].groups[1] === "b", "regex worker: a job answers as before");
    const md = await runMarkdown("# hi");
    ok(/<h1[^>]*>hi<\/h1>/.test(JSON.stringify(md)), "markdown worker: a job answers as before");
    const meta = await runHtml("meta", { html: "<html><head><title>T</title></head><body>x</body></html>", url: "https://example.com/" });
    ok(meta?.title === "T", `html worker: a job answers as before (${JSON.stringify(meta).slice(0, 80)})`);
    const xl = await runOfficeOp("xlsx", validateXlsx({ rows: [["a", 1]] }));
    ok(!!xl && JSON.stringify(xl).length > 20, "office worker: a job answers as before");
    const info = await runPdfOp("info", [pdf]);
    ok((info?.pages ?? info?.pageCount) === 1, `pdf worker: a job answers as before (${JSON.stringify(info).slice(0, 80)})`);
    const small = await runImageOffThread({ op: "resize", buffer: pngBuf, params: { width: 10 } });
    ok(!!small && JSON.stringify(small).length > 20, "image worker: a job answers as before");

    const WORKERS = ["regex-worker.js", "markdown-worker.js", "html-worker.js", "office-worker.js", "pdf-worker.js", "image-worker.js"];
    const ALLOWED = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
      "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "NODE_ENV", "NODE_OPTIONS", "LAZY_DEPS_WARM_GAP_MS", "HTML_POOL_MAX", "HTML_POOL_QUEUE_MAX", "HTML_PARSE_TIMEOUT_MS"]);
    for (const name of WORKERS) {
      const rec = made.find((m) => m.file === name);
      if (!rec) { ok(false, `${name}: no worker was created by its job`); continue; }
      const seen = await probe({ env: rec.options?.env });
      const leaked = Object.keys(PLANTED).filter((k) => k in seen);
      const extra = Object.keys(seen).filter((k) => !ALLOWED.has(k));
      ok(rec.options?.env && typeof rec.options.env === "object" && leaked.length === 0, `${name}: a worker with its env cannot read a planted secret (${leaked.join(", ") || "none read"})`);
      ok(extra.length === 0 && seen.PATH === process.env.PATH, `${name}: its env holds only allowlisted names (${extra.join(", ") || "no others"})`);
    }
    const { threadEnv } = await import("../src/tools/child-env.js");
    ok(threadEnv(["A_KNOB"], { A_KNOB: "1", NODE_OPTIONS: "--enable-source-maps", SECRET_KEY: "x", PATH: "/bin" }).SECRET_KEY === undefined
      && JSON.stringify(threadEnv(["A_KNOB"], { A_KNOB: "1", NODE_OPTIONS: "--enable-source-maps", SECRET_KEY: "x", PATH: "/bin" })) === JSON.stringify({ PATH: "/bin", NODE_OPTIONS: "--enable-source-maps", A_KNOB: "1" }),
      "threadEnv carries the allowlist, NODE_OPTIONS and the named knobs only");
  } catch (e) {
    ok(false, `worker env check threw: ${e?.stack || e}`);
  } finally {
    wt.Worker = RealWorker;
    syncBuiltinESMExports();
    for (const k of Object.keys(PLANTED)) delete process.env[k];
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
