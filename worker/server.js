// Secretless browser + media worker (audit F02/F04/F06).
//
// Runs Chromium (render/screenshot) and ffmpeg/ffprobe (media) in a service that
// holds NO payment/DB/operator/provider secrets and no /data mount. A renderer
// or native-parser compromise from hostile page/media content therefore lands in
// a box with nothing worth stealing. The API calls POST /call over the private
// network with a shared bearer token.
//
// It imports ONLY the browser/media code subtree (render.js, media-kit.js and
// their pure deps), never payments/db/operator, so those modules never even load
// here. A boot guard also fails LOUD if a payment/DB/operator secret is present
// in this process's env — the worker must be secretless by construction.
import "../src/tls-distrust-boot.js"; // refuse TLS chains through a distrusted intermediate CA
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderArticle, screenshotPage } from "../src/tools/render.js";
import { MEDIA_TOOLS } from "../src/tools/media-kit.js";
import { BROWSER_MEASURE_TOOLS } from "../src/tools/browser-measure-kit.js";
import { startEgressProxy } from "./egress-proxy.js";

const PORT = Number(process.env.PORT) || 3999;
const TOKEN = (process.env.RENDER_WORKER_TOKEN || "").trim();

// The tools this worker will run, reusing the exact in-process implementations.
const HANDLERS = {
  render: (input) => renderArticle(input?.url),
  screenshot: async (input) => {
    const png = await screenshotPage(input?.url, { fullPage: input?.fullPage === true || input?.fullPage === "true" });
    return { __binary: Buffer.from(png).toString("base64"), contentType: "image/png" };
  },
};
for (const t of MEDIA_TOOLS) HANDLERS[t.slug] = (input) => t.handler(input || {});
for (const t of BROWSER_MEASURE_TOOLS) HANDLERS[t.slug] = (input) => t.handler(input || {});

// Boot guard: this worker must be SECRETLESS by construction. Enforced ONLY at
// boot (see the isMain block), not at module import — so a test/CI process, which
// legitimately has its own GITHUB_TOKEN etc., can import the exports without
// tripping it.
// FR4-05 (strict allowlist, P1.2): the worker boots ONLY if every set env var is
// explicitly allowed or a known non-secret system/Railway var. Anything
// unrecognized — or anything that looks secret-bearing — refuses boot. This is
// the strict form: an unknown var is denied, not just secret-shaped ones. A
// genuinely-new benign var must be added to ALLOWED_EXACT/ALLOWED_SYSTEM. Because
// Railway health-gates the deploy, a false positive fails the NEW deploy (the old
// worker keeps serving) rather than causing an outage.
const ALLOWED_EXACT = new Set([
  "PORT", "NODE_ENV", "WORKER_MODE", "TZ",
  "RENDER_WORKER_TOKEN", "RENDER_WORKER_URL", "RENDER_WORKER_TIMEOUT_MS",
  "RENDER_WORKER_MAX_BYTES", "RENDER_EGRESS_PROXY_URL", "RENDER_WORKER_REQUIRED",
]);
// Non-secret vars injected by Docker / Node / the shell / Playwright — plus the
// macOS/dev/editor runtime noise a developer would have when running the worker
// locally. Broad on purpose: it's SAFE because secret-shaped names are blocked
// first (SECRET_SHAPE_RE below), so nothing sensitive can slip through here.
const ALLOWED_SYSTEM = /^(PATH|HOME|HOSTNAME|PWD|OLDPWD|SHLVL|SHELL|TERM|COLORTERM|COLORFGBG|LANG|LANGUAGE|LC_[A-Z]+|LS_COLORS|LSCOLORS|USER|LOGNAME|MAIL|EDITOR|PAGER|LESS|TMPDIR|TMP|TEMP|DISPLAY|HISTFILE|HISTSIZE|INFOPATH|MANPATH|COMMAND_MODE|MallocNanoZone|SECURITYSESSIONID|_|NODE_[A-Z_]*|npm_[a-z_0-9]*|YARN_[A-Z_]*|PLAYWRIGHT[_A-Z]*|CHROME[_A-Z]*|CHROMIUM[_A-Z]*|PUPPETEER[_A-Z]*|LD_LIBRARY_PATH|LD_PRELOAD|SSL_CERT_[A-Z]+|NODE_EXTRA_CA_CERTS|DEBIAN_FRONTEND|GPG_[A-Z_]*|container|__CF[A-Za-z_]*|XPC_[A-Z_]*|Apple[A-Za-z_]*|SSH_[A-Z]+|TERM_[A-Z_]*|ITERM_[A-Z_]*|VSCODE_[A-Z_]*|CURSOR_[A-Z_]*|ZSH[A-Z_]*|BASH[A-Z_]*)$/;
// Secret-shaped names are ALWAYS blocked (in every environment), except the
// worker's own inbound-auth token — this is the auditor's URL/DSN/DB/ledger
// concern (those carry credentials) plus keys, tokens, mnemonics, passwords.
// NB: no bare "PRIVATE" — it false-positives on Railway's benign
// RAILWAY_PRIVATE_DOMAIN (took a deploy down once); a private KEY is caught by "KEY".
const SECRET_SHAPE_RE = /(KEY|SECRET|TOKEN|MNEMONIC|PASSWORD|PASSWD|CREDENTIAL|DSN|LEDGER|DATABASE|REDIS|POSTGRES|MONGO|MYSQL|CONN(ECTION)?_?STR(ING)?)/i;
const SECRET_ALLOW = new Set(["RENDER_WORKER_TOKEN"]);
// Pure + exported for tests: env var names that BLOCK a secretless boot.
//
// The STRICT allowlist ("deny anything not explicitly allowed") is enforced only
// in the controlled deployment — on Railway (RAILWAY_ENVIRONMENT present) or when
// forced with WORKER_STRICT_ENV — where the container env is minimal and known.
// In dev/CI the process env is full of benign editor/OS/tooling noise (a real
// run here surfaced 25+ such vars), so applying deny-unknown there just refuses
// to boot on harmless names; instead we enforce the secret-SHAPE denylist, which
// still blocks every credential-shaped name. Railway health-gates the deploy, so
// a strict-mode false positive fails the NEW deploy (old worker keeps serving).
export function forbiddenSecretsIn(env) {
  const strict = Boolean((env.RAILWAY_ENVIRONMENT || "").trim())
    || /^(1|true|yes|on)$/i.test((env.WORKER_STRICT_ENV || "").trim());
  return Object.keys(env).filter((k) => {
    if (!(env[k] || "").trim()) return false;                          // unset/empty → ignore
    if (SECRET_SHAPE_RE.test(k) && !SECRET_ALLOW.has(k)) return true;  // secret-shaped: always block
    if (!strict) return false;                                         // dev/CI: shape denylist only
    if (ALLOWED_EXACT.has(k) || ALLOWED_SYSTEM.test(k) || /^RAILWAY_/.test(k)) return false;
    return true;                                                       // Railway strict: unrecognized → deny
  });
}
const secretsPresent = () => forbiddenSecretsIn(process.env);

// Fail CLOSED: a request is authorized only if it presents the exact configured
// token. An empty/unset TOKEN denies everything (and the boot guard below also
// refuses to start the listener without one), so /call can never be open on the
// private mesh via a missing-token misconfiguration.
const tokenOk = (got) => {
  if (!TOKEN) return false;
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const app = express();
app.disable("x-powered-by");
// html-frames sends a document of up to 512 KB, JSON-escaped.
app.use(express.json({ limit: "3mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, tools: Object.keys(HANDLERS) }));

app.post("/call", async (req, res) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tokenOk(auth)) return res.status(401).json({ error: "unauthorized" });
  const { slug, input } = req.body || {};
  // Object.hasOwn so a slug like "constructor"/"toString" can't resolve to an
  // inherited Object.prototype function instead of an actual handler.
  const handler = typeof slug === "string" && Object.hasOwn(HANDLERS, slug) ? HANDLERS[slug] : null;
  if (!handler) return res.status(404).json({ error: `unknown worker tool: ${String(slug).slice(0, 40)}` });
  try {
    res.json(await handler(input || {}));
  } catch (err) {
    if (Number.isInteger(err?.retryAfter)) res.set("Retry-After", String(err.retryAfter));
    res.status(err?.statusCode || 502).json({ error: err?.message || "worker error", ...(Number.isInteger(err?.retryAfter) ? { retryAfterSeconds: err.retryAfter } : {}) });
  }
});

// Start listening when run directly (`node worker/server.js`) OR when the shared
// image's start.js dispatcher selected worker mode via WORKER_MODE. Imports by a
// test (argv is the test file, WORKER_MODE unset) still just read the exports.
// FR4-12: compare resolved paths (not a forward-slash suffix) so `node
// worker\server.js` on Windows also triggers the boot guard, not only WORKER_MODE.
const isMain = (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  || /^(1|true|yes|on)$/i.test((process.env.WORKER_MODE || "").trim());
if (isMain) {
  // Enforce the secretless invariant and the auth requirement ONLY when actually
  // booting as the worker (not on import), and fail loud on either.
  const leaked = secretsPresent();
  if (leaked.length) {
    console.error(`[worker] FATAL: secret env present in the SECRETLESS worker: ${leaked.join(", ")}. Remove these from the worker service and redeploy.`);
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("[worker] FATAL: RENDER_WORKER_TOKEN is not set — /call would be unauthenticated on the private mesh. Set it (same value on the main service) and redeploy.");
    process.exit(1);
  }
  // F04: start the validating + pinning egress proxy and point Chromium at it,
  // so the browser can't resolve/connect to a private/metadata/railway.internal
  // destination even under DNS rebinding. Set before the first render (Chromium
  // launches lazily and reads RENDER_EGRESS_PROXY_URL then).
  const proxy = await startEgressProxy();
  process.env.RENDER_EGRESS_PROXY_URL = proxy.url;
  console.log(`[worker] egress proxy (F04 validate+pin) on ${proxy.url}`);
  // Bind IPv6 `::` (dual-stack) so Railway PRIVATE networking can reach the
  // worker at <service>.railway.internal (its private mesh is IPv6-only).
  const srv = app.listen(PORT, "::", () => console.log(`[worker] secretless browser/media worker on :${PORT} — tools: ${Object.keys(HANDLERS).join(", ")}`));
  // Graceful drain (2026-08-25): this process had no SIGTERM handler, so a
  // redeploy killed it mid-render and the main service saw an upstream failure
  // for a request it had already accepted. Same shape as the main server's
  // shutdown: stop accepting, sweep idle keep-alives, let in-flight renders
  // finish, hard exit at a deadline under the platform grace.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received - closing listener, draining in-flight work (exit 0)`);
    srv.close(() => process.exit(0));
    srv.closeIdleConnections();
    setInterval(() => srv.closeIdleConnections(), 5_000).unref();
    setTimeout(() => process.exit(0), 45_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

export { app, HANDLERS, tokenOk };
