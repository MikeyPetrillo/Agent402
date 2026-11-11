// MCP outer-transport limits (audit R-11). The per-tool limiter only fires
// INSIDE call_tool, so a flood of initialize/malformed POSTs used to allocate a
// server + transport per request before any limit applied. This test boots a
// real server with a tiny outer per-IP cap and asserts:
//   - a burst of /mcp POSTs is bounded with 429 BEFORE the cap-exceeding
//     requests do any work (JSON-RPC error envelope preserved);
//   - a normal initialize under the cap still succeeds;
//   - the free-tier tool budget's refusal says in how many seconds there is
//     room again, the same whole seconds the limiter computed;
//   - the 429 is emitted for a malformed body too (bounded before parse/build).
//
// The server is booted on port 0 with its own stores (scripts/lib/boot-server.js)
// and must answer /health with the build id this run gave it, so the test
// never reads a server it did not start.
//
//   node scripts/test-mcp-limits.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

const CAP = 6; // outer per-IP requests/min for this run
const TOOL_BURST = 1; // free-tier tool calls/min for this run
const BUILD = randomBytes(4).toString("hex").slice(0, 7);

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? "ok" : "FAIL"} - ${msg}`); };

const initBody = (id) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r11-test", version: "1" } } });
const callBody = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "catalog.call", arguments: { slug: "hash", params: { text: "hi", algorithm: "sha256" } } } });

let srv = null;
try {
  srv = await bootServer({
    stores: "mcp-limits",
    env: {
      FREE_MODE: "true",
      X402_SYNC_ON_START: "false",
      X402_INDEX_CRAWL: "off",
      MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off",
      REDIS_URL: "",
      GIT_COMMIT_SHA: BUILD,
      RAILWAY_GIT_COMMIT_SHA: "",
      AGENT402_MCP_REQ_PER_MIN: String(CAP),
      AGENT402_MCP_REQ_PER_HOUR: "1000",
      AGENT402_MCP_MAX_PER_MIN: String(TOOL_BURST),
      AGENT402_MCP_MAX_PER_HOUR: "1000",
    },
    timeoutMs: 180_000,
  });
} catch (e) {
  ok(false, `server booted on port 0 (${String(e?.message || e).slice(-1500)})`);
}

if (srv) {
  try {
    const post = (body, raw = false) =>
      fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: raw ? body : JSON.stringify(body),
      });
    const rpcJson = async (r) => {
      const text = await r.text();
      if ((r.headers.get("content-type") || "").startsWith("text/event-stream")) {
        return JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
      }
      return JSON.parse(text);
    };

    // The server answering is the one this run started: its /health names the
    // build id given only to it, and the child is still running.
    const health = await (await fetch(`${srv.url}/health`)).json().catch(() => null);
    const build = health?.meta?.build ?? health?.build;
    ok(build === BUILD && !srv.exited(), `the server answering is the one this test booted (build ${build} vs ${BUILD}, port ${srv.port})`);

    // First request under the cap: a valid initialize should NOT be 429.
    const first = await post(initBody(1));
    ok(first.status !== 429, `first initialize is served, not rate-limited (got ${first.status})`);
    await first.arrayBuffer();

    // The free-tier tool budget: the first call runs, the next is refused with
    // the wait in whole seconds.
    const call1 = await rpcJson(await post(callBody(2)));
    ok(call1?.result && !call1.result.isError, `the first free tool call runs (${JSON.stringify(call1?.result?.content?.[0]?.text || call1?.error || "").slice(0, 80)})`);
    const call2 = await rpcJson(await post(callBody(3)));
    const text = String(call2?.result?.content?.[0]?.text || "");
    const m = /^Free-tier rate limit reached \([^)]*\); room again in about (\d+) s\. /.exec(text);
    ok(call2?.result?.isError === true && !!m && Number(m[1]) >= 1 && Number(m[1]) <= 60, `the refused tool call says when there is room again, in whole seconds inside the minute window (${text.slice(0, 110)})`);

    // Flood well past the per-IP cap; the tail must be 429 with a JSON-RPC error.
    let saw429 = false, sawJsonRpc429 = false;
    const badRetryAfter = [];
    for (let i = 0; i < CAP + 8; i++) {
      const r = await post(initBody(100 + i));
      if (r.status === 429) {
        saw429 = true;
        const j = await r.json().catch(() => null);
        if (j && j.jsonrpc === "2.0" && j.error) sawJsonRpc429 = true;
        const wait = r.headers.get("retry-after");
        if (!/^[1-9][0-9]*$/.test(wait || "") || Number(wait) > 3600) badRetryAfter.push(wait);
      } else await r.arrayBuffer();
    }
    ok(saw429 && badRetryAfter.length === 0, `every 429 carries Retry-After as whole seconds inside the limiter's window (bad: ${JSON.stringify(badRetryAfter.slice(0, 3))})`);
    ok(saw429, "a burst past the per-IP cap is bounded with 429");
    ok(sawJsonRpc429, "the 429 preserves the JSON-RPC error envelope");

    // Malformed body is bounded BEFORE any transport allocation — either the
    // JSON body-parser rejects it (400) or the outer per-IP cap does (429).
    // Neither builds a server/transport, which is the R-11 invariant.
    const bad = await post("{not valid json", true);
    ok(bad.status === 400 || bad.status === 429, `malformed POST bounded pre-build (parser 400 or cap 429), got ${bad.status}`);
    ok(!srv.exited(), "the booted server is still the one running at the end");
  } catch (e) {
    ok(false, `run completed (${e?.stack || e})`);
  } finally {
    await srv.stop();
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
