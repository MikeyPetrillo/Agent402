// The hosted connector's serverInfo.version is the version the MCP Registry
// lists for it (mcp/package.json, the same figure mcp/server.json carries)
// with the deploy's commit as semver build metadata: "0.13.32+build.abc1234".
// A client comparing serverInfo with the registry entry sees one version.
// Boots a free-mode server on port 0 with a known commit in the environment,
// and checks the image ships the file the connector reads.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pkg = JSON.parse(readFileSync(join(ROOT, "mcp", "package.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(ROOT, "mcp", "server.json"), "utf8"));
ok(registry.version === pkg.version, `the registry entry lists the package version (${registry.version} vs ${pkg.version})`);
// A missing or unreadable package file yields 0.0.0, never a throw at import.
{
  const { mcpPackageVersionFrom } = await import("../src/mcp-package-version.js");
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const missing = mcpPackageVersionFrom(new URL("file:///nonexistent/mcp/package.json"));
  const real = mcpPackageVersionFrom(new URL("../mcp/package.json", import.meta.url));
  console.warn = warn;
  ok(missing === "0.0.0" && warned === 1, "a missing mcp/package.json reads as 0.0.0 with one warning");
  ok(real === pkg.version, "the package file's version is read as written");
}
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
ok(/^COPY\s+mcp\/package\.json\s+\.\/mcp\/package\.json\s*$/m.test(dockerfile), "the image copies mcp/package.json, which the connector reads at import");

const SHA = "0123abcdef4567890123abcdef4567890123abcd";
const want = `${pkg.version}+build.${SHA.slice(0, 7)}`;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env, ...ownStoreEnv("mcp-version"), FREE_MODE: "true", PORT: "0", X402_SYNC_ON_START: "false",
    RAILWAY_GIT_COMMIT_SHA: SHA, GIT_COMMIT_SHA: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });
let exited = null;
proc.on("exit", (code, signal) => { exited = { code, signal }; });
try {
  let base = null;
  for (let i = 0; i < 240 && !base && !exited; i++) { const m = log.match(/listening on :(\d+)/); if (m) base = `http://127.0.0.1:${m[1]}`; else await sleep(250); }
  if (!base) throw new Error(`server never came up${exited ? ` (exited ${JSON.stringify(exited)})` : ""}:\n${log.slice(-800)}`);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-mcp-server-version", version: "0.0.0" } } }),
  });
  const text = await res.text();
  const json = (res.headers.get("content-type") || "").startsWith("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    : JSON.parse(text);
  const version = json?.result?.serverInfo?.version;
  ok(version === want, `initialize serverInfo.version is the package version with the build as metadata (${version} vs ${want})`);
  ok(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\+[0-9A-Za-z.-]+$/.test(String(version)), `serverInfo.version is semver with build metadata (${version})`);
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  proc.kill("SIGKILL");
}
console.log(`test-mcp-server-version: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
