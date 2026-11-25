#!/usr/bin/env node
// HTML parsing runs in the worker pool (src/tools/html-pool.js), not on the
// main thread: while a page that takes seconds to parse is in a worker, the
// main thread keeps answering; a parse past the time limit is stopped with a
// 503 and the pool recovers; a full queue answers 503; large pages run one at
// a time; a tool's own 400s stay 400s; idle workers never hold the process
// open. Each scenario is its own process (scripts/lib/html-pool-driver.js)
// because the pool reads its limits from the environment at load. Offline.
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DRIVER = fileURLToPath(new URL("./lib/html-pool-driver.js", import.meta.url));

function scenario(name, env = {}, { waitMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [DRIVER, JSON.stringify({ scenario: name })], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => p.kill("SIGKILL"), waitMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code, signal) => {
      clearTimeout(killer);
      const last = out.trim().split("\n").pop();
      let result;
      try { result = JSON.parse(last); } catch { result = { error: `exit ${code} ${signal || ""}: ${err.slice(-300)}` }; }
      resolve({ result, code, signal, wallMs: Date.now() - t0 });
    });
  });
}

// ---- the main thread stays available during a slow parse ---------------------------
{
  const { result: r } = await scenario("responsive", { HTML_PARSE_TIMEOUT_MS: "60000" });
  ok(r.ok === true, `a deeply nested page still converts when it finishes in time (${JSON.stringify(r)})`);
  ok(r.parseMs > 500, `the page is slow to parse (${r.parseMs} ms), so the next check means something`);
  ok(r.worstLagMs < 250, `the main thread never stalled more than 250 ms while it parsed (worst ${r.worstLagMs} ms)`);
}

// ---- a parse past the limit is stopped and the pool recovers ------------------------
{
  const { result: r } = await scenario("timeout", { HTML_PARSE_TIMEOUT_MS: "1000" });
  ok(r.slow?.ok === false && r.slow.status === 503, `a parse past the limit answers 503 (${JSON.stringify(r.slow)})`);
  ok(/took longer than 1 s/.test(r.slow?.message || ""), "the refusal says it was stopped for time");
  ok(r.elapsedMs < 3000, `it is stopped near the limit, not when the parse would end (${r.elapsedMs} ms)`);
  ok(r.after?.ok === true, "the next call is served by a fresh worker");
}

// ---- a tool's own errors keep their status --------------------------------------------
{
  const { result: r } = await scenario("errors");
  ok(r.missing?.ok === false && r.missing.status === 400 && /html/.test(r.missing.message), `a missing input is still a 400 with its message (${JSON.stringify(r.missing)})`);
  ok(r.badSelector?.ok === false && r.badSelector.status === 400, `an invalid selector is still a 400 (${JSON.stringify(r.badSelector)})`);
  ok(r.fine?.ok === true && r.fine.chars > 0, "a normal call answers");
}

// ---- a full queue is a 503, not an unbounded backlog ------------------------------------
{
  const { result: r } = await scenario("queue", { HTML_POOL_MAX: "1", HTML_POOL_QUEUE_MAX: "1", HTML_PARSE_TIMEOUT_MS: "1500" });
  const statuses = (r.results || []).map((x) => (x.ok ? 200 : x.status));
  ok(r.state?.busy === 1 && r.state?.queued === 1, `one job runs and one waits (${JSON.stringify(r.state)})`);
  ok(statuses.filter((s) => s === 503).length >= 1 && /busy/.test((r.results || []).find((x) => !x.ok && /busy/.test(x.message))?.message || ""), `the job past the queue limit is refused as busy (${JSON.stringify(statuses)})`);
}

// ---- large pages run one at a time; a small job is not held behind them -------------------
{
  const { result: r } = await scenario("large");
  ok(r.state?.largeInFlight === 1, `only one large page is parsed at once (${JSON.stringify(r.state)})`);
  ok((r.results || []).every((x) => x.ok === true), "all three finish");
}

// ---- jsdom's optional canvas backend is not installed where jsdom resolves it ----------------
// jsdom requires its canvas peer at load whenever it can resolve it, so a hoisted
// copy (pdf-parse and pdfjs-dist bring @napi-rs/canvas) would load a native Skia
// module in every HTML worker and give each <img src> a native image. The workers
// never draw, so the lockfile must keep the peer off jsdom's resolution path. Read
// from the lockfile, so it holds for the image's install whatever a parent folder
// of a local checkout holds.
{
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")).packages || {};
  const jsdomPaths = Object.keys(lock).filter((p) => /(^|\/)node_modules\/jsdom$/.test(p) && !lock[p].dev);
  ok(jsdomPaths.length >= 1, `jsdom is a production dependency in the lockfile (${jsdomPaths.join(", ")})`);
  for (const at of jsdomPaths) {
    const peers = Object.keys(lock[at].peerDependencies || {});
    ok(peers.length > 0, `${at} declares its optional canvas peer (${peers.join(", ") || "none"})`);
    for (const peer of peers) {
      // Node's walk from jsdom's own folder up to the root.
      const candidates = [];
      for (let dir = at; ; ) {
        candidates.push(`${dir}/node_modules/${peer}`);
        const i = dir.lastIndexOf("/node_modules/");
        if (i < 0) break;
        dir = dir.slice(0, i);
      }
      candidates.push(`node_modules/${peer}`);
      const hit = [...new Set(candidates)].filter((c) => lock[c]);
      ok(hit.length === 0, `${at} cannot resolve its canvas peer ${peer} (${hit.join(", ") || "not on its path"})`);
    }
  }
}

// ---- idle workers never hold the process open ----------------------------------------------
{
  const { result: r, code, signal, wallMs } = await scenario("exits", {}, { waitMs: 20_000 });
  ok(r.ok === true && code === 0 && !signal, `a process that used the pool exits on its own (exit ${code}, ${wallMs} ms)`);
}

console.log(`\ntest-html-pool: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
