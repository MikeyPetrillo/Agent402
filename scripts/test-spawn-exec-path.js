// A suite that starts Node starts THIS Node (process.execPath), never the
// first `node` on PATH. A different Node on PATH (a Node 24 beside the Node 22
// the native modules were built for) crashed every child server at boot, and
// with its stderr discarded the suite read only "never reported the port".
// Scans the scripts and the package and adapter trees for a child started as
// the bare word node (spawn, execFile, their Sync forms, or a shell string
// that opens with it), and fails naming each place.
//
//   node scripts/test-spawn-exec-path.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const BARE = "no" + "de";
// spawn("node", ...), execFile('node', ...), spawnSync(`node`, ...), and a
// shell string that starts with the word: execSync("node scripts/x.js").
export const BARE_NODE_CALL = new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync)\\(\\s*(["'\`])${BARE}\\1|\\b(?:exec|execSync)\\(\\s*(["'\`])${BARE}\\s`);

const TREES = ["scripts", "adapters", "client", "tollbooth", "mcp", "openclaw", "workers", "facilitator"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "generated"]);
function* jsFiles(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) yield* jsFiles(p); }
    else if (/\.(?:m?js|cjs)$/.test(n) && p !== SELF) yield p;
  }
}

// Controls: the pattern finds each form and passes the fixed one.
for (const bad of [`spawn("${BARE}", ["src/server.js"])`, `execFileSync('${BARE}', ["x"])`, `spawnSync(\`${BARE}\`, [])`, `execSync("${BARE} scripts/x.js")`]) ok(BARE_NODE_CALL.test(bad), `control: the guard reads ${bad}`);
for (const good of ["spawn(process.execPath, [\"src/server.js\"])", `spawn("${BARE}js-tool")`, `execSync("${BARE}mon x")`]) ok(!BARE_NODE_CALL.test(good), `control: the guard passes ${good}`);

const offenders = [];
let scanned = 0;
for (const tree of TREES) {
  for (const f of jsFiles(join(ROOT, tree))) {
    scanned++;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => { if (BARE_NODE_CALL.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}`); });
  }
}
for (const o of offenders) console.log(`  starts the PATH ${BARE}: ${o}`);
ok(scanned > 500 && offenders.length === 0, `no script or package test starts the ${BARE} on PATH; each uses process.execPath (${scanned} files, ${offenders.length} offenders)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
