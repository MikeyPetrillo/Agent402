#!/usr/bin/env node
// scripts/phone-path-check.js, the release check of the phone path, run
// against a FREE_MODE boot of this tree (port 0) and against two drifted
// copies of it behind a local proxy (port 0): one whose connector refuses the
// free call, one with no /recipes. The real boot passes every step; each drift
// exits 1 and names the step that broke. Real Chromium (sweeps lane).
//
//   node scripts/test-phone-path-check.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

/** Run the check against `target`; resolves { code, out }. */
const runCheck = (target) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/phone-path-check.js"], { cwd: ROOT, env: { ...process.env, TARGET_URL: target }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("exit", (code) => resolve({ code, out }));
});

/** A proxy to `upstream` that answers `override(req)` itself when it returns a response. */
async function proxy(upstream, override) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const own = override(req, body);
    if (own) { res.writeHead(own.status, { "content-type": own.type || "application/json" }); res.end(own.body); return; }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
    const r = await fetch(`${upstream}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" });
    const buf = Buffer.from(await r.arrayBuffer());
    const out = {};
    r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(r.status, out);
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

let srv = null;
try {
  srv = await bootServer({ stores: "phone-path", timeoutMs: 180_000, env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", REDIS_URL: "", CREDITS_SALES: "", MCP_OAUTH: "", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
} catch (e) { ok(false, `server booted (${String(e?.message || e).slice(-800)})`); }

if (srv) {
  try {
    const real = await runCheck(srv.url);
    ok(real.code === 0, `the phone path passes on this tree (exit ${real.code})${real.code ? `\n${real.out.slice(-1500)}` : ""}`);
    for (const step of ["copies the connector address", "a free hash call through it returns the digest", "its 8 Copy buttons are 44 px targets", "a tap copies the first prompt"]) {
      ok(real.out.includes(`ok - ${step}`) || new RegExp(`ok - [^\\n]*${step}`).test(real.out), `it checked: ${step}`);
    }

    // Initialize is passed through; the tool call is answered as a refusal.
    const refusing = await proxy(srv.url, (req, body) => (req.method === "POST" && req.url === "/mcp" && String(body).includes('"tools/call"') ? { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "refused" }], isError: true } }) } : null));
    try {
      const r = await runCheck(refusing.url);
      ok(r.code === 1 && /ok - the connector answers initialize/.test(r.out) && /FAIL - a free hash call/.test(r.out), `a connector that refuses the free call fails the check at that step (exit ${r.code})`);
    } finally { await refusing.close(); }

    const noRecipes = await proxy(srv.url, (req) => (req.url.startsWith("/recipes") ? { status: 404, type: "text/html", body: "<!doctype html><title>Not found</title><main>Not found</main>" } : null));
    try {
      const r = await runCheck(noRecipes.url);
      ok(r.code === 1 && /FAIL - \/recipes opens/.test(r.out) && /ok - a free hash call/.test(r.out), `a missing /recipes fails the check at that step, after the earlier steps pass (exit ${r.code})`);
    } finally { await noRecipes.close(); }
  } finally {
    await srv.stop();
  }
}

console.log(`\n${pass} passed, ${failed} failed (phone path check)`);
process.exit(failed ? 1 : 0);
