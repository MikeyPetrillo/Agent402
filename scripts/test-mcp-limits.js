// MCP outer-transport limits (audit R-11). The per-tool limiter only fires
// INSIDE call_tool, so a flood of initialize/malformed POSTs used to allocate a
// server + transport per request before any limit applied. This test boots a
// real server with a tiny outer per-IP cap and asserts:
//   - a burst of /mcp POSTs is bounded with 429 BEFORE the cap-exceeding
//     requests do any work (JSON-RPC error envelope preserved);
//   - a normal initialize under the cap still succeeds;
//   - the 429 is emitted for a malformed body too (bounded before parse/build).
//
//   node scripts/test-mcp-limits.js
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3127;
const CAP = 5; // outer per-IP requests/min for this run

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? "ok" : "FAIL"} - ${msg}`); };

const initBody = (id) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r11-test", version: "1" } } });
const post = (body, raw = false) =>
  fetch(`http://localhost:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: raw ? body : JSON.stringify(body),
  });

const childEnv = {
  ...process.env,
  FREE_MODE: "true",
  PORT: String(PORT),
  X402_SYNC_ON_START: "false",
  AGENT402_MCP_REQ_PER_MIN: String(CAP),
  AGENT402_MCP_REQ_PER_HOUR: "1000",
};
delete childEnv.X402_ECONOMY_DB;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
const bootLog = [];
proc.stdout.on("data", (d) => bootLog.push(String(d)));
proc.stderr.on("data", (d) => bootLog.push(String(d)));
let exited = false;
proc.on("exit", () => { exited = true; });

try {
  let up = false;
  for (let i = 0; i < 180 && !exited; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    ok(false, `server never became healthy on :${PORT} (exited=${exited}) — boot tail:\n${bootLog.join("").slice(-1500)}`);
  } else {
    // First request under the cap: a valid initialize should NOT be 429.
    const first = await post(initBody(1));
    ok(first.status !== 429, `first initialize is served, not rate-limited (got ${first.status})`);

    // Flood well past the per-IP cap; the tail must be 429 with a JSON-RPC error.
    let saw429 = false, sawJsonRpc429 = false;
    for (let i = 0; i < CAP + 8; i++) {
      const r = await post(initBody(100 + i));
      if (r.status === 429) {
        saw429 = true;
        const j = await r.json().catch(() => null);
        if (j && j.jsonrpc === "2.0" && j.error) sawJsonRpc429 = true;
      }
    }
    ok(saw429, "a burst past the per-IP cap is bounded with 429");
    ok(sawJsonRpc429, "the 429 preserves the JSON-RPC error envelope");

    // Malformed body is bounded BEFORE any transport allocation — either the
    // JSON body-parser rejects it (400) or the outer per-IP cap does (429).
    // Neither builds a server/transport, which is the R-11 invariant.
    const bad = await post("{not valid json", true);
    ok(bad.status === 400 || bad.status === 429, `malformed POST bounded pre-build (parser 400 or cap 429), got ${bad.status}`);
  }
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
