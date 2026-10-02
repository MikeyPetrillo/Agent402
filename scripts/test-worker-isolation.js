// Secretless browser/media worker plumbing + isolation invariants (audit
// F02/F04/F06). Offline: exercises the worker's auth/dispatch/secret-guard and
// the API-side client round-trip WITHOUT launching Chromium or ffmpeg (a stub
// server stands in for the tool handlers). The real render/media-through-worker
// path is verified live with a paid smoke once the worker service is deployed.
//
//   node scripts/test-worker-isolation.js
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

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
