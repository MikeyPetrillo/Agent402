// Runtime smoke for the tollbooth dashboard. features.test.js asserts the
// HTML *string* shape returned by dashboardHtml(); this boots the actual CLI
// process, hits /__tollbooth and /__tollbooth/stats over HTTP, and verifies:
//
//   1. /__tollbooth returns 200 text/html.
//   2. The HTML carries every dashboard contract the features test pins (the
//      probes panel, the sparkline meta, the derived ratios) — i.e. the
//      runtime path actually delivers what the unit test asserted.
//   3. /__tollbooth/stats returns valid JSON with every counter key the
//      dashboard's `cards` array reads. A silent rename on either side
//      (counter renamed in index.js, card label still expects the old key)
//      would surface here as a key the JSON doesn't have.
//   4. The <origin> placeholder is present in the HTML — so initProbes()'s
//      client-side substitution has something to substitute. (We can't run
//      the JS without a DOM; this is the static guard for the runtime piece.)
//
//   node scripts/test-tollbooth-runtime.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4099;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot the published CLI entrypoint. TOLLBOOTH_UPSTREAM points at a closed
// port — the dashboard + stats routes mount before the proxy and don't need a
// reachable origin to answer.
const proc = spawn(process.execPath, [join(ROOT, "tollbooth", "index.js")], {
  cwd: join(ROOT, "tollbooth"),
  env: {
    ...process.env,
    PORT: String(PORT),
    TOLLBOOTH_UPSTREAM: "http://127.0.0.1:1",
    TOLLBOOTH_SECRET: "test-secret-runtime-smoke",
  },
  stdio: "ignore",
});

try {
  // Wait for the listener — the dashboard route is the cheapest readiness probe.
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/__tollbooth`); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  ok(up, `tollbooth listens on :${PORT} and serves /__tollbooth`);

  const dashRes = await fetch(`${BASE}/__tollbooth`);
  ok(dashRes.status === 200, `/__tollbooth → 200 (got ${dashRes.status})`);
  ok((dashRes.headers.get("content-type") || "").includes("text/html"), `/__tollbooth content-type is text/html`);
  const html = await dashRes.text();
  ok(html.startsWith("<!doctype html>"), "dashboard body opens with <!doctype html>");

  // Contract surfaces — every section the unit test asserts must actually
  // arrive at the runtime endpoint, not just exist in the source.
  ok(html.includes('id="probes"') && html.includes("Operator probes"), "runtime: operator-probes panel is served");
  ok(html.includes('id="ratenow"') && html.includes('id="paidnow"'), "runtime: sparkline rate meta is served");
  ok(html.includes('id="paidpct"') && html.includes('id="usdcpct"'), "runtime: derived ratios are served");
  ok(html.includes("&lt;origin&gt;"), "runtime: <origin> placeholder present for client-side substitution");
  ok(html.includes("initProbes") && html.includes("navigator.clipboard"), "runtime: clipboard handler is in the served script");

  // Stats endpoint shape — every counter the dashboard's `cards` array reads
  // must appear in the JSON. A silent rename on either side surfaces here.
  const statsRes = await fetch(`${BASE}/__tollbooth/stats`);
  ok(statsRes.status === 200, `/__tollbooth/stats → 200 (got ${statsRes.status})`);
  const stats = await statsRes.json();
  for (const key of ["requests", "freeAllowed", "wouldCharge", "charged", "powSolved", "x402Paid", "difficultyNow"]) {
    ok(key in stats, `stats.${key} present (got keys: ${Object.keys(stats).join(",")})`);
  }
  ok(typeof stats.requests === "number" && stats.requests >= 0, `stats.requests is a non-negative number (got ${stats.requests})`);

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
