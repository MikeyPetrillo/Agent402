#!/usr/bin/env node
// Pre-publish gate for the agent402-mcp npm package.
//
// WHY THIS EXISTS: package.json's `files` allowlist decides what npm ships, so
// a module that exists in the repo can be absent from the tarball. That is
// invisible to every test that runs from the working tree - and it happened:
// networks.js was added and imported but never listed, so published versions
// 0.11.0 through 0.12.2 threw ERR_MODULE_NOT_FOUND on the first line for 27
// days. `node mcp/test.js` passed the whole time because the working tree has
// the file. The post-publish check only read the version number back.
//
// So this test refuses to trust the tree: it PACKS the package, INSTALLS the
// tarball into a temp dir, and drives a real MCP initialize handshake against
// the installed copy. Any missing file, bad entry point, or broken import
// fails here instead of in a buyer's terminal.
//
//   node scripts/test-mcp-package.js
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "mcp");
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

// --- static check: every relative import is in `files` ------------------------
// Fast, precise, and names the missing file. The install check below is the
// backstop that catches anything this misses (transitive imports, bad main).
const entry = readFileSync(join(PKG_DIR, pkg.main || "index.js"), "utf8");
const localImports = [...entry.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
const shipped = new Set([...(pkg.files || []), pkg.main || "index.js", "package.json"]);
ok(localImports.length > 0, `entry point has relative imports to check (found ${localImports.length})`);
for (const imp of localImports) {
  ok(shipped.has(imp), `"${imp}" is imported by the entry point AND listed in files`);
}

// --- the real thing: pack, install, run --------------------------------------
let tgz = null, dir = null;
try {
  const out = execFileSync("npm", ["pack", "--silent"], { cwd: PKG_DIR, encoding: "utf8" });
  tgz = out.trim().split("\n").filter(Boolean).pop();
  ok(Boolean(tgz), `npm pack produced a tarball (${tgz})`);

  dir = mkdtempSync(join(tmpdir(), "a402-mcp-pkg-"));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", join(PKG_DIR, tgz)], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const installed = join(dir, "node_modules", "agent402-mcp");
  ok(existsSync(join(installed, pkg.main || "index.js")), "installed tarball contains the entry point");
  for (const imp of localImports) {
    ok(existsSync(join(installed, imp)), `installed tarball contains "${imp}"`);
  }

  // Drive a real handshake against the INSTALLED copy. A missing module or a
  // broken import surfaces here as a non-zero exit / no JSON-RPC reply.
  const req = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package-gate", version: "1" } },
  });
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(installed, pkg.main || "index.js")], {
      input: req + "\n", encoding: "utf8", timeout: 90_000,
      env: { ...process.env, AGENT402_URL: process.env.AGENT402_URL || "https://agent402.tools", AGENT402_KEY_STORE: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    // The server stays open on stdin; a timeout kill still gives us its stdout.
    stdout = String(e?.stdout || "");
    if (!stdout) throw e;
  }
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  const reply = line ? JSON.parse(line) : null;
  ok(Boolean(reply?.result?.protocolVersion), `installed package answers initialize (protocol ${reply?.result?.protocolVersion || "none"})`);
  ok(reply?.result?.serverInfo?.version === pkg.version,
    `serverInfo.version matches package.json (${reply?.result?.serverInfo?.version} vs ${pkg.version})`);
} catch (e) {
  failed++;
  console.error(`FAIL - pack/install/run the published artifact: ${String(e?.message || e).slice(0, 300)}`);
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (tgz && existsSync(join(PKG_DIR, tgz))) unlinkSync(join(PKG_DIR, tgz));
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
