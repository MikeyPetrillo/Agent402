// PostHog analytics-proxy abuse controls (audit R-17). The public /e/* proxy
// forwards to two FIXED posthog hosts (no SSRF), but was otherwise open. This
// boots a real server with a tiny per-IP cap and asserts the outer gate:
//   - disallowed methods are refused (405) before any upstream fetch;
//   - only the paths the analytics library asks for are relayed (404 for any
//     other, before an upstream call), every answer carries nosniff, and an
//     upstream page (text/html) is never relayed;
//   - a burst from one IP is rate-limited (429) — the gate runs ahead of the
//     upstream call, so a flood can't pump our PostHog quota/bandwidth.
// Every live request here is refused before the upstream call, so the test
// sends nothing off the machine.
// (The response-size cap is a straight-line code guard; not exercised here
// because it needs a controllable oversized upstream.)
//
//   node scripts/test-posthog-proxy.js
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { posthogProxyPathAllowed, posthogProxyTypeAllowed } from "../src/posthog-proxy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3131;
const CAP = 8;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// The path and type allowlists (src/posthog-proxy.js), offline.
{
  // The loader asks for <api_host>/static/array.js; keep that working.
  const loader = readFileSync(join(ROOT, "assets/js/posthog-loader.js"), "utf8");
  ok(/api_host\+"\/static\/array\.js"/.test(loader) && posthogProxyPathAllowed("static/array.js"), "the loader's static/array.js is relayed");
  for (const p of ["static/web-vitals.js", "static/lazy/recorder.js", "array/phc_abc123/config.js", "array/phc_abc123/config", "e/", "e", "i/v0/e/", "batch/", "flags/", "decide/", "s/"]) {
    ok(posthogProxyPathAllowed(p), `relayed: ${p}`);
  }
  for (const p of ["", "anything", "static/x.html", "static/../x.js", "static//x.js", "static/.hidden.js", "api/projects/", "array/abc/other", "e/x", "static/x.js?y", "admin/"]) {
    ok(!posthogProxyPathAllowed(p), `refused: ${JSON.stringify(p)}`);
  }
  ok(posthogProxyTypeAllowed("application/javascript") && posthogProxyTypeAllowed("application/json; charset=utf-8") && posthogProxyTypeAllowed("text/plain") && posthogProxyTypeAllowed(null), "scripts, JSON, text and an absent type are relayed");
  ok(!posthogProxyTypeAllowed("text/html; charset=utf-8") && !posthogProxyTypeAllowed("TEXT/HTML") && !posthogProxyTypeAllowed("application/xhtml+xml") && !posthogProxyTypeAllowed("image/svg+xml") && !posthogProxyTypeAllowed("text/xml"), "an upstream page is never relayed");
  const src = readFileSync(join(ROOT, "src/server.js"), "utf8");
  const route = src.slice(src.indexOf("app.all(/^\\/e\\/(.*)$/"), src.indexOf("app.all(/^\\/e\\/(.*)$/") + 4000);
  const at = (s) => route.indexOf(s);
  ok(at("posthogProxyPathAllowed(") > 0 && at("posthogProxyPathAllowed(") < at("await fetch(upstream"), "the path check runs before the upstream call");
  ok(at("posthogProxyTypeAllowed(") > at("await fetch(upstream") && at("posthogProxyTypeAllowed(") < at("res.status(up.status)"), "the type check runs before any upstream byte or status is relayed");
}

const env = { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", POSTHOG_PROXY_MAX_PER_MIN: String(CAP) };
delete env.X402_ECONOMY_DB;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
const log = [];
proc.stdout.on("data", (d) => log.push(String(d)));
proc.stderr.on("data", (d) => log.push(String(d)));
let exited = false; proc.on("exit", () => { exited = true; });
const status = async (path, opts) => (await fetch(`http://127.0.0.1:${PORT}${path}`, opts)).status;

try {
  let up = false;
  for (let i = 0; i < 120 && !exited; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(up, `server booted${up ? "" : ` — tail:\n${log.join("").slice(-1200)}`}`);
  if (up) {
    // Disallowed method is refused before any upstream fetch.
    ok((await status("/e/anything", { method: "DELETE" })) === 405, "disallowed method (DELETE) → 405");
    ok((await status("/e/anything", { method: "PUT" })) === 405, "disallowed method (PUT) → 405");

    // Only the paths the analytics library uses are relayed; every other path
    // is a 404 before any upstream call, and every answer carries nosniff.
    for (const p of ["/e/anything", "/e/static/page.html", "/e/static/%2e%2e/x.js", "/e/api/projects/", "/e/static/", "/e/array/abc/other"]) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      ok(r.status === 404, `a path the library never asks for is refused: ${p} → ${r.status}`);
      ok(r.headers.get("x-content-type-options") === "nosniff", `...with nosniff (${p})`);
    }
    const m = await fetch(`http://127.0.0.1:${PORT}/e/anything`, { method: "DELETE" });
    ok(m.headers.get("x-content-type-options") === "nosniff", "a refused method also carries nosniff");

    // Burst past the per-IP cap is rate-limited (429). Allowed method, so the
    // 429 comes from the outer gate, not the method check. The path is one the
    // proxy refuses, so the under-cap requests stop at the 404 and nothing
    // reaches the upstream.
    let saw429 = false;
    for (let i = 0; i < CAP + 6; i++) {
      if ((await status(`/e/not-relayed/?i=${i}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })) === 429) { saw429 = true; break; }
    }
    ok(saw429, "a burst past the per-IP cap is rate-limited (429) before the upstream call");
  }
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
