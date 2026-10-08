#!/usr/bin/env node
// The agent402-mcp images (Dockerfile.mcp at the root, used by directory
// health checks such as Glama, and mcp/Dockerfile) must copy every local
// file the server imports, or the image builds and then fails to start.
// Also checks the npm package's "files" list the same way.
import { readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// Local imports of mcp/index.js, followed transitively.
const need = new Set();
const visit = (rel) => {
  if (need.has(rel)) return;
  need.add(rel);
  const src = readFileSync(join(ROOT, "mcp", rel), "utf8");
  for (const m of src.matchAll(/(?:from\s+|import\(\s*)["'](\.\/[^"']+)["']/g)) visit(normalize(join(dirname(rel), m[1])));
};
visit("index.js");
ok(need.size >= 1, `index.js and its local imports: ${[...need].join(", ")}`);

for (const df of ["Dockerfile.mcp", "mcp/Dockerfile"]) {
  const text = readFileSync(join(ROOT, df), "utf8");
  const copied = new Set();
  for (const line of text.split("\n").filter((l) => /^\s*COPY\s/.test(l))) {
    for (const tok of line.trim().split(/\s+/).slice(1, -1)) if (tok.startsWith("mcp/")) copied.add(tok.slice(4));
  }
  const missing = [...need].filter((f) => !copied.has(f));
  ok(missing.length === 0, `${df} copies every file the server imports${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
}
const files = JSON.parse(readFileSync(join(ROOT, "mcp", "package.json"), "utf8")).files || [];
const notShipped = [...need].filter((f) => !files.includes(f));
ok(notShipped.length === 0, `mcp/package.json "files" ships every imported file${notShipped.length ? ` (missing: ${notShipped.join(", ")})` : ""}`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
