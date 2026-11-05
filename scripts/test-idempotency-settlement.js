// FR4-01: idempotency must be SETTLEMENT-AWARE. @x402/express (v2.16) runs the
// handler first and only settles a <400 response; on settlement failure it
// rewrites the buffered 200 into a 402. The old idempotency cache committed at
// res.json() time (handler completion, BEFORE settlement), so a 200 whose
// payment never settled could be replayed. The fix commits only on 'finish' when
// the FINAL status is 200 (post-settlement reality).
//
// This boots the real server (FREE_MODE) and proves the caching now keys on the
// FINAL response status: a 200 is cached + replayed, a NON-200 (stand-in for a
// settlement-failure 402) is NOT cached. Uses X-Pow-Solution as the credential so
// idemHashKey engages without needing a live payment.
//
//   node scripts/test-idempotency-settlement.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same-class as FR4-01: the LLM-gateway prompt/embeddings cache must ALSO commit
// only after settlement. The handlers now stash on req.__deferredCache and the
// route binder commits on a final 200 (an e2e needs upstream keys; lock the wiring).
{
  const gw = readFileSync(join(ROOT, "src", "tools", "llm-gateway-kit.js"), "utf8");
  const srv = readFileSync(join(ROOT, "src", "server.js"), "utf8");
  ok(/req\.__deferredCache \?\?= \[\]\)\.push\(w\)/.test(gw) && (gw.match(/__deferredCache/g) || []).length >= 2, "gateway chat+embeddings handlers STASH the cache write on req.__deferredCache (not a direct pre-settlement write)");
  ok(/res\.on\("finish", \(\) => \{[\s\S]*?if \(res\.statusCode !== 200\) return;[\s\S]*?req\.__deferredCache/.test(srv), "route binder commits req.__deferredCache only on a final 200 (post-settlement)");
}

const PORT = 3959;
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), NODE_ENV: "test" },
  stdio: ["ignore", "ignore", "inherit"],
});
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 200)); }
};

try {
  const up = await until(async () => (await fetch(`${BASE}/health`)).ok);
  if (!up) { console.error("server did not start"); srv.kill("SIGKILL"); process.exit(1); }

  const call = (path, { key, body, method = "POST" }) => fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key, "x-pow-solution": "test-credential" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 1. A 200 IS cached and replayed on retry with the same key+credential.
  {
    const r1 = await call("/api/hash", { key: "k-ok", body: { text: "idem-settlement-test" } });
    ok(r1.status === 200, "first hash call returns 200");
    const r2 = await call("/api/hash", { key: "k-ok", body: { text: "idem-settlement-test" } });
    ok(r2.status === 200 && r2.headers.get("x-idempotent-replay") === "true", "identical retry is served from cache (X-Idempotent-Replay: true)");
  }

  // 2. A NON-200 final response (stand-in for a settlement-failure 402) is NOT
  //    cached — the whole point of FR4-01. /api/render with no url returns 400
  //    before any Chromium work; the retry must re-run (no replay), not serve a
  //    cached body.
  {
    const r1 = await call("/api/render", { key: "k-bad", body: {} });
    ok(r1.status >= 400 && r1.status < 500, `non-200 request returns ${r1.status} (not cached)`);
    const r2 = await call("/api/render", { key: "k-bad", body: {} });
    ok(r2.headers.get("x-idempotent-replay") !== "true", "a non-200 response is NOT replayed from cache (settlement-failure bypass closed)");
    ok(r2.status === r1.status, "the retry re-runs the handler and gets the same non-200 status");
  }

  // 3. Sanity: a different body under the same key does not collide.
  {
    const a = await call("/api/hash", { key: "k-body", body: { text: "aaa" } });
    const b = await call("/api/hash", { key: "k-body", body: { text: "bbb" } });
    ok(a.status === 200 && b.status === 200 && b.headers.get("x-idempotent-replay") !== "true", "different body under the same key is not a cache hit");
  }
} finally {
  srv.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
