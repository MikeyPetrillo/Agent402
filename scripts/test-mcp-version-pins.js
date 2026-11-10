// Every place that tells someone which agent402-mcp to install names the
// version in mcp/package.json: the package's own AGENT402_MCP_VERSION and
// every `agent402-mcp@x.y.z` pin in the shipped trees, docs and pages.
// Changelog history is a record and is not read.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { AGENT402_MCP_VERSION } from "../mcp/output-schemas.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const version = JSON.parse(readFileSync(new URL("../mcp/package.json", import.meta.url), "utf8")).version;
ok(AGENT402_MCP_VERSION === version, `AGENT402_MCP_VERSION (${AGENT402_MCP_VERSION}) matches mcp/package.json (${version})`);
const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "--", ".", ":!CHANGELOG.md", ":!src/changelog.js", ":!**/package-lock.json", ":!package-lock.json"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => /\.(js|mjs|md|json|html|txt)$/.test(f));
const stale = [];
for (const f of files) {
  let s; try { s = readFileSync(root + f, "utf8"); } catch { continue; }
  for (const m of s.matchAll(/agent402-mcp@(\d+\.\d+\.\d+)/g)) if (m[1] !== version) stale.push(`${f}: ${m[0]}`);
}
ok(stale.length === 0, `every agent402-mcp install pin names ${version}${stale.length ? `; stale: ${stale.slice(0, 5).join(", ")}` : ""}`);
// An install line with no pin at all is not seen by the scan above: in the
// markdown trees every `npx -y agent402-mcp` and every "-y", "agent402-mcp"
// argument names the version.
const UNPINNED = /(?:npx -y |"-y",\s*")agent402-mcp(?!@\d+\.\d+\.\d+)/g;
ok("npx -y agent402-mcp\n".match(UNPINNED) && '"args": ["-y", "agent402-mcp"]'.match(UNPINNED) && !`npx -y agent402-mcp@${version}`.match(UNPINNED), "control: an unpinned install line is matched, a pinned one is not");
const bare = [];
for (const f of files.filter((x) => x.endsWith(".md"))) {
  let s; try { s = readFileSync(root + f, "utf8"); } catch { continue; }
  for (const m of s.matchAll(UNPINNED)) bare.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
}
ok(bare.length === 0, `every markdown install line pins agent402-mcp@${version}${bare.length ? `; unpinned: ${bare.slice(0, 8).join(", ")}` : ""}`);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
