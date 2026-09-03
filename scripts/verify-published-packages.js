// Drive the PUBLISHED npm packages against LIVE production.
//
// Everything else in CI tests the packages from the working tree. That proves
// the source is good; it cannot prove that what people actually `npm install`
// works, because publishing is a separate act with its own failure modes: a
// missing `files` entry, a stale version on the registry, a dependency that
// resolves differently outside this repo, or a package that was simply never
// republished after the surface it talks to moved. Those are invisible to a
// source test and visible to the first user who hits them.
//
// So this installs from the REGISTRY into a scratch directory and points it at
// real prod. Read-only and free: it lists tools, resolves the catalog and reads
// public surfaces. It never buys anything, so it can run on a schedule without
// spending, and a paid path staying unproven here is deliberate - the paid
// canary already owns that.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
let pass = 0;
/** Run `fn`; if it fails a transient check, wait and run it once more. Only what
 *  survives the second attempt is reported - and a NON-transient failure is
 *  raised at once rather than being retried into a slower identical answer. */
const RETRY_DELAY_MS = Number(process.env.VERIFY_RETRY_DELAY_MS || 30_000);
async function retryOnce(fn, isTransient, label) {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    console.log(`  (${label} failed transiently: ${String(e?.message || e).slice(0, 120)} - retrying once in ${RETRY_DELAY_MS / 1000}s)`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return fn();
  }
}

const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "a402-pubverify-"));
console.log(`scratch: ${dir}`);
console.log(`target:  ${TARGET}`);

try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "a402-pubverify", private: true, type: "module" }));
  // Install exactly what a user would get: the registry's `latest`.
  console.log("installing agent402-mcp@latest and agent402-client@latest from the registry...");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "agent402-mcp@latest", "agent402-client@latest"], { cwd: dir, stdio: "inherit" });

  const installed = (name) => JSON.parse(execFileSync("npm", ["ls", name, "--json"], { cwd: dir, encoding: "utf8" }));
  const mcpVer = installed("agent402-mcp").dependencies["agent402-mcp"].version;
  const cliVer = installed("agent402-client").dependencies["agent402-client"].version;
  console.log(`installed agent402-mcp@${mcpVer}  agent402-client@${cliVer}`);

  // --- 1. the published stdio MCP server, spoken to over real stdio ---------
  const proc = spawn("node", [join(dir, "node_modules", "agent402-mcp", "index.js")], {
    env: { ...process.env, AGENT402_BASE_URL: TARGET },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const replies = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); } catch { /* not a frame */ }
    }
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  const rpc = async (id, method, params) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 120; i++) { if (replies.has(id)) return replies.get(id); await sleep(250); }
    return null;
  };

  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "published-package-verify", version: "0.0.0" },
  });
  ok(init && !init.error, `the published agent402-mcp@${mcpVer} completes an MCP initialize over stdio${init?.error ? ` (${JSON.stringify(init.error).slice(0, 160)})` : ""}`);

  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc(2, "tools/list", {});
  const tools = listed?.result?.tools || [];
  ok(tools.length > 0, `it lists ${tools.length} tools`);

  // The package's whole job is reaching OUR catalog. A build that starts and
  // lists nothing recognisable is broken in the way a source test cannot see.
  const names = new Set(tools.map((t) => t.name));
  const wanted = ["catalog.search", "catalog.call", "payment.info"];
  const missing = wanted.filter((w) => !names.has(w));
  ok(missing.length === 0, `it advertises the catalog tools an agent needs${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);

  // A free, read-only call that must reach live prod and come back with real data.
  // Same deploy-window exposure as the SDK check below, but rpc() returns an
  // error OBJECT rather than throwing, so it needs its own second look. The
  // package also logs "Could not load the catalog ... starting with an empty
  // catalog" to stderr when /api/pricing is mid-rollout, which is the same
  // moment expressed a second way.
  let called = await rpc(3, "tools/call", { name: "catalog.search", arguments: { query: "uuid" } });
  if (called?.error || !(called?.result?.content?.[0]?.text || "").length) {
    console.log(`  (catalog.search came back empty or errored - retrying once in ${RETRY_DELAY_MS / 1000}s, prod may be mid-deploy)`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    called = await rpc(4, "tools/call", { name: "catalog.search", arguments: { query: "uuid" } });
  }
  const text = called?.result?.content?.map((c) => c.text || "").join("") || "";
  ok(!called?.error && text.length > 0, `a catalog.search through the published package reaches ${TARGET} and returns results${called?.error ? ` (${JSON.stringify(called.error).slice(0, 160)})` : ""}`);

  proc.kill();
  if (stderr.trim()) console.log(`  (server stderr: ${stderr.trim().split("\n")[0].slice(0, 160)})`);

  // --- 2. the published buyer SDK ------------------------------------------
  const { Agent402 } = await import(join(dir, "node_modules", "agent402-client", "index.js"));
  const client = new Agent402({ baseUrl: TARGET });
  // SINGLE RETRY, the same doctrine every other prod-facing probe in this repo
  // uses. The service is volume-backed, so EVERY deploy has a 60-90s window with
  // no container answering, and this job runs daily plus after each deploy - on
  // 2026-08-31 it ran at 15:33 between main deploys at 15:29 and 15:36 and paged
  // on a 502 that was our own rollout. A published package being unreachable for
  // one moment during our deploy is not the package being broken; a package that
  // is still unreachable 30 seconds later is worth waking someone for.
  const found = await retryOnce(
    () => client.find("generate a uuid"),
    (e) => /HTTP 50[0-9]|fetch failed|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(String(e?.message || e)),
    "agent402-client find()",
  );
  ok(Array.isArray(found) ? found.length > 0 : !!found, `the published agent402-client@${cliVer} resolves a task against live prod via find()`);

  console.log(`\n${pass} passed${process.exitCode ? " (with failures above)" : ", 0 failed"}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
