// What STATUS_PROBE_TOKEN opens is stated where it is read (src/server.js),
// and the statement must match the code: the env value is read once, only
// statusProbeAuthed() compares it, and the comment names every route that
// calls statusProbeAuthed().
//
// Run: node scripts/test-status-probe-token-scope.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const ROOT = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(ROOT, "src/server.js"), "utf8");

// The env value is read in exactly one place in the shipped tree.
const reads = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".js") && /process\.env\.STATUS_PROBE_TOKEN|env\[["']STATUS_PROBE_TOKEN/.test(readFileSync(p, "utf8"))) reads.push(p.slice(ROOT.length)); } };
walk(join(ROOT, "src"));
ok(reads.length === 1 && reads[0] === "src/server.js" && (src.match(/process\.env\.STATUS_PROBE_TOKEN/g) || []).length === 1, `STATUS_PROBE_TOKEN is read once, in src/server.js (${reads.join(", ")})`);

// Every route that calls statusProbeAuthed() is named in the comment.
// Each call site belongs to the nearest route registration above it.
const routes = [];
for (const m of src.matchAll(/(?<!function )statusProbeAuthed\(req\)/g)) {
  const before = src.slice(0, m.index);
  const regs = [...before.matchAll(/\napp\.(get|post)\("([^"]+)"/g)];
  const last = regs[regs.length - 1];
  if (last) routes.push(`${last[1].toUpperCase()} ${last[2]}`);
}
ok(routes.length >= 2, `found the routes that accept the probe token (${routes.join(", ")})`);
const at = src.indexOf("const STATUS_PROBE_TOKEN = ");
// The comment block right above the read, as one line of prose.
const comment = src.slice(Math.max(0, at - 1600), at).split("\n").map((l) => l.replace(/^\s*\/\/\s?/, "")).join(" ");
for (const r of routes) ok(comment.includes(r), `the comment at the read names ${r}`);
ok(!/nowhere else in the tree/.test(comment), "the comment does not claim a single use");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
