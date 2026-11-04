// html-frames through the server: failed documents (uncharged 4xx) are bounded
// per payer, else per client address (src/server.js wraps the tool with
// withHtmlFramesFailureBound from src/tools/render.js). A free-mode boot on
// port 0 sends HTML_FRAMES_FAIL_MAX bodies the tool refuses, then one more:
// that one answers 429 with Retry-After, before any browser work. A caller
// from another address is still served. The wrapper's own window is unit
// tested in scripts/test-html-frames-isolation.js; this pins that the route
// is wired to it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX = 3;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "frames-bound-"));
const srv = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: "0", FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_PAYWALL_PROBES_PER_CYCLE: "0",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATE_DATABASE_URL: "", REDIS_URL: "", MEMORY_DB_FILE: join(tmp, "memory.db"), TRUST_PROXY_HOPS: "1",
    HTML_FRAMES_FAIL_MAX: String(MAX), HTML_FRAMES_FAIL_WINDOW_MS: "600000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => { log += d; });
srv.stderr.on("data", (d) => { log += d; });
try {
  let B = null;
  for (let i = 0; i < 180 && !B; i++) { const m = log.match(/listening on :(\d+)/); if (m) B = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
  if (!B) throw new Error(`server never came up:\n${log.slice(-600)}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }

  // A body the tool refuses before any browser work (no html).
  const post = (xff) => fetch(`${B}/api/html-frames`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ html: "" }) })
    .then(async (r) => ({ status: r.status, retryAfter: r.headers.get("retry-after"), text: await r.text() }));
  const statuses = [];
  for (let i = 0; i < MAX; i++) statuses.push((await post("198.51.100.7")).status);
  ok(statuses.every((s) => s >= 400 && s < 500 && s !== 429), `the first ${MAX} refused documents answer the tool's own 4xx (${statuses.join(", ")})`);
  const over = await post("198.51.100.7");
  ok(over.status === 429 && Number(over.retryAfter) > 0, `the next one from the same caller is a 429 with Retry-After (got ${over.status}, Retry-After ${over.retryAfter})`);
  const other = await post("198.51.100.8");
  ok(other.status !== 429, `a caller from another address is not held by it (got ${other.status})`);
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  srv.kill("SIGKILL");
}
console.log(`\ntest-html-frames-failure-bound: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
