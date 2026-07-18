// PostHog analytics-proxy abuse controls (audit R-17). The public /e/* proxy
// forwards to two FIXED posthog hosts (no SSRF), but was otherwise open. This
// boots a real server with a tiny per-IP cap and asserts the outer gate:
//   - disallowed methods are refused (405) before any upstream fetch;
//   - a burst from one IP is rate-limited (429) — the gate runs ahead of the
//     upstream call, so a flood can't pump our PostHog quota/bandwidth.
// (The response-size cap is a straight-line code guard; not exercised here
// because it needs a controllable oversized upstream.)
//
//   node scripts/test-posthog-proxy.js
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3131;
const CAP = 5;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const env = { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", POSTHOG_PROXY_MAX_PER_MIN: String(CAP) };
delete env.X402_ECONOMY_DB;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
const log = [];
proc.stdout.on("data", (d) => log.push(String(d)));
proc.stderr.on("data", (d) => log.push(String(d)));
let exited = false; proc.on("exit", () => { exited = true; });
const status = async (path, opts) => (await fetch(`http://localhost:${PORT}${path}`, opts)).status;

try {
  let up = false;
  for (let i = 0; i < 120 && !exited; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(up, `server booted${up ? "" : ` — tail:\n${log.join("").slice(-1200)}`}`);
  if (up) {
    // Disallowed method is refused before any upstream fetch.
    ok((await status("/e/anything", { method: "DELETE" })) === 405, "disallowed method (DELETE) → 405");
    ok((await status("/e/anything", { method: "PUT" })) === 405, "disallowed method (PUT) → 405");

    // Burst past the per-IP cap is rate-limited (429). Allowed method, so the
    // 429 comes from the outer gate, not the method check. (Under-cap requests
    // may 502 on the unreachable upstream — we only assert the cap fires.)
    let saw429 = false;
    for (let i = 0; i < CAP + 6; i++) {
      if ((await status(`/e/e/?i=${i}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })) === 429) { saw429 = true; break; }
    }
    ok(saw429, "a burst past the per-IP cap is rate-limited (429) before the upstream call");
  }
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
