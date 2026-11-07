#!/usr/bin/env node
// No filesystem path is read from a URL's pathname. `new URL(x,
// import.meta.url).pathname` stays percent-encoded, so on a checkout whose path
// holds a space or another escaped character it names a file that does not
// exist: a spawn fails ENOENT, a read throws, and an "am I the entry script"
// check compares an encoded path with a plain one and quietly never runs the
// CLI. The same mismatch comes from building the module's URL by hand as
// `file://` plus process.argv[1]. The fix is fileURLToPath(...) for a path
// and pathToFileURL(argv[1]).href for an entry check.
//
// Shapes refused, in every tracked .js/.mjs/.cjs/.ts file under the trees
// below:
//   1. import.meta.url).pathname  (any spacing, so also new URL(import.meta.url).pathname)
//   2. a name bound to new URL(..., import.meta.url) whose .pathname is read
//   3. a `file://` string or template joined to process.argv
// The scanner runs on planted samples first, so a clean tree is a result and
// not a scanner that read nothing. Offline; committed files only.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TREES = ["scripts", "client", "mcp", "tollbooth", "openclaw", "adapters", "workers", "src"];
const SELF = "scripts/test-no-url-pathname.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const META = "import" + ".meta.url"; // spelled in parts so this file's own text never matches
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DIRECT = new RegExp(`${esc(META)}\\s*\\)\\s*\\.pathname\\b`);
const BOUND = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new URL\\([^;\\n]*${esc(META)}\\s*\\)\\s*[;\\n]`, "g");
const ARGV_URL = new RegExp("[\"'`]file:\\/\\/(?:\\$\\{\\s*process\\.argv|[\"'`]\\s*\\+\\s*process\\.argv)");

// Matched over the whole source (a call can break across lines), reported by line.
function findings(src) {
  const out = [];
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const bound = [...src.matchAll(BOUND)].map((m) => m[1]);
  const shapes = [
    [new RegExp(DIRECT.source, "g"), "url-pathname"],
    [new RegExp(ARGV_URL.source, "g"), "file-url-from-argv"],
  ];
  if (bound.length) shapes.push([new RegExp(`(?<![\\w$.])(?:${bound.map(esc).join("|")})\\s*\\.pathname\\b`, "g"), "bound-url-pathname"]);
  for (const [re, shape] of shapes) for (const m of src.matchAll(re)) out.push({ line: lineOf(m.index), shape });
  return out;
}

// Controls: each refused shape is seen, and each accepted fix is not.
const bad = [
  `const ROOT = new URL("..", ${META}).pathname;`,
  `spawn(process.execPath, [x], { cwd: new URL("..", ${META})\n  .pathname });`,
  `const isMain = resolve(process.argv[1]) === new URL(${META}).pathname;`,
  `const here = new URL(".", ${META});\nconst p = join(here.pathname, "a.js");`,
  "if (" + META + " === `file://${process.argv[1]}`) main();",
  `const u = new URL("file://" + process.argv[1]);`,
];
for (const s of bad) ok(findings(s).length > 0, `control: refused shape is seen: ${s.split("\n").pop().slice(0, 70)}`);
const good = [
  `const ROOT = fileURLToPath(new URL("..", ${META}));`,
  `const isMain = process.argv[1] && ${META} === pathToFileURL(process.argv[1]).href;`,
  `const here = new URL(".", ${META});\nreadFileSync(new URL("a.json", here));`,
  `const p = new URL(req.url, "http://x").pathname;`,
  `const there = new URL(".", ${META});\nconst u = new URL(card.url); if (u.pathname === "/api") ok();`,
];
for (const s of good) ok(findings(s).length === 0, `control: accepted shape is not flagged: ${s.split("\n").pop().slice(0, 70)}`);

const tracked = execFileSync("git", ["ls-files", "-z", "--", ...TREES], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && /\.(?:m|c)?js$|\.ts$/.test(f) && !f.includes("node_modules/") && f !== SELF);
let readers = 0;
const offenders = [];
for (const f of tracked) {
  let src;
  try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; } // deleted in the working tree
  if (src.includes(META)) readers++;
  for (const hit of findings(src)) offenders.push(`${f}:${hit.line} ${hit.shape}`);
}
ok(tracked.length > 500 && readers > 100, `the scan sees the trees (${tracked.length} files, ${readers} read ${META})`);
ok(offenders.length === 0, `no filesystem path or entry check is built from a URL pathname or a hand-made file:// URL${offenders.length ? `:\n  ${offenders.join("\n  ")}\n  use fileURLToPath(new URL(..., ${META})) for a path and pathToFileURL(process.argv[1]).href for an entry check` : ""}`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
