#!/usr/bin/env node
// One-product MCP endpoint (/mcp/sec, 2026-09-10): the same connector mounted
// a second time with a profile - only the SEC filings tools listed under
// their own dotted names, the catalog meta tools hidden, its own server name
// and instructions - while /mcp is unchanged. Boots its own FREE_MODE server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
const proc = spawn("node", ["src/server.js"], { env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" }, stdio: ["ignore", "ignore", "inherit"] });
const done = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", done);
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
const rpc = async (path, method, params = {}, id = 1) => {
  const res = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, body: JSON.parse(line ? line.slice(5) : text) };
};
const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
{
  const r = await rpc("/mcp/sec", "initialize", init);
  ok(r.status === 200 && r.body.result?.serverInfo?.name === "agent402-sec-filings", `initialize on /mcp/sec names the product server (got ${r.body.result?.serverInfo?.name})`);
  ok(/SEC filings over MCP/.test(r.body.result?.instructions || ""), "its instructions describe the one product");
  const l = await rpc("/mcp/sec", "tools/list");
  const names = (l.body.result?.tools || []).map((t) => t.name).sort();
  ok(names.includes("sec.filing_report") && names.includes("sec.company_lookup") && names.includes("sec.fund_report") && names.includes("sec.insider_report"), `the SEC tools are listed under dotted names (${names.join(", ")})`);
  ok(!names.some((n) => n.startsWith("catalog.")) && !names.includes("sellers.list") && !names.includes("demand.request"), "no catalog meta tools on the product endpoint");
  ok(names.includes("payment.info") && names.includes("server.describe"), "payment.info and server.describe stay (how to pay, who serves it)");
  ok(names.length <= 12, `the list is one product's worth (${names.length} tools)`);
  const meta = await rpc("/mcp/sec", "tools/call", { name: "catalog.search", arguments: { query: "hash" } });
  ok(meta.body.result?.isError === true && /not available on \/mcp\/sec/.test(meta.body.result?.content?.[0]?.text || ""), "calling a hidden meta tool answers isError naming the full connector");
  const call = await rpc("/mcp/sec", "tools/call", { name: "sec.company_lookup", arguments: { ticker: "AAPL" } });
  ok(call.status === 200 && call.body.result && (call.body.result.isError === true || call.body.result.content), "a product tool is callable by its dotted name (wallet-only: paid-access text on the authless connector)");
  const g = await fetch(`${B}/mcp/sec`);
  ok(g.status === 405, "GET /mcp/sec is 405 like /mcp");
}
{
  const l = await rpc("/mcp", "tools/list");
  const names = (l.body.result?.tools || []).map((t) => t.name);
  ok(names.includes("catalog.search") && names.includes("web.search") && !names.includes("sec.filing_report"), "/mcp is unchanged: catalog meta tools and the flagships, no sec.* names");
  const r = await rpc("/mcp", "initialize", init);
  ok(r.body.result?.serverInfo?.name === "agent402", "/mcp still initializes as agent402");
}
done();
// Two mounts, ONE task store (security review 2026-09-10): a second store over
// the same directory shared records through disk but not the in-memory run
// controllers, so a cancel on the other path could discard a paid result.
{
  process.env.AGENT402_MCP_TASKS = "on";
  const { mountMcp, _sharedTaskStoreForTest } = await import("../src/mcp-http.js");
  const fakeApp = { use() {}, post() {}, get() {}, delete() {} };
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mcp-tasks-"));
  const loopback = async () => ({ status: 402, headers: new Headers(), body: "" });
  const catalog = { "POST /api/x": { slug: "x", name: "x", price: "$0.001", description: "x", category: "c", route: "POST /api/x", handler: async () => ({}), discovery: {} } };
  mountMcp(fakeApp, catalog, { baseUrl: "http://t", isComputePayable: () => false, mppLoopback: loopback, taskStoreDir: dir });
  const first = _sharedTaskStoreForTest();
  mountMcp(fakeApp, catalog, { baseUrl: "http://t", isComputePayable: () => false, mppLoopback: loopback, taskStoreDir: dir, path: "/mcp/x", profile: { metaTools: false, flagshipSlugs: ["x"] } });
  ok(first && _sharedTaskStoreForTest() === first, "a second mount reuses the first mount's task store (one runs map, so a cancel on either path aborts the run)");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
