// The package renames (scripts/lib/package-renames.js), offline:
//  - each new name is the package its directory publishes, at the listed version;
//  - each earlier name's forwarding release under renamed/ depends on exactly its
//    new name's minor line, ships its README and license, and, installed beside
//    the new package, exports what the new package exports and prints its
//    notice once however often it is imported;
//  - no published name carries another party's mark (the names below);
//  - outside the places that record history or the move itself, an earlier
//    name appears only on a line that says it was renamed;
//  - the publish job publishes the forwarding releases after every new name and
//    its trusted-publisher probe reads renamed/.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { PACKAGE_RENAMES, shimDir, forwardRange, renameNotice } from "./lib/package-renames.js";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const LEGAL = "Copyright (c) 2026 Cardhavok LLC (doing business as Havok Holdings LLC)";

// Marks of other parties that no published package name may carry.
const MARKS = ["openai", "anthropic", "claude", "google", "gemini", "adk", "langchain", "llamaindex", "llama", "vercel", "ai-sdk", "coinbase", "agentkit", "cdp", "strands", "aws", "bedrock", "agentcore", "eliza", "openclaw", "x402"];
const markIn = (name) => MARKS.find((m) => new RegExp(`(^|[-_])${m}([-_]|$)`).test(name));
ok(markIn("agent402-openai-tools") === "openai" && markIn("elizaos-plugin-agent402") === undefined && markIn("agent402-ai-sdk") === "ai-sdk", "control: the mark check reads a mark as a whole name part");

const pubDirs = ["mcp", "client", "tollbooth", "openclaw", ...readdirSync(join(ROOT, "adapters")).map((d) => `adapters/${d}`)];
for (const d of pubDirs) {
  const name = existsSync(join(ROOT, d, "package.json")) ? json(`${d}/package.json`).name
    : (/^name = "([^"]+)"/m.exec(readFileSync(join(ROOT, d, "pyproject.toml"), "utf8")) || [])[1];
  ok(/^agent402-/.test(name) && !markIn(name) && !/elizaos/.test(name), `${d} publishes ${name}: agent402- first, no other party's mark`);
}

for (const r of PACKAGE_RENAMES) {
  const tag = `${r.registry} ${r.old} -> ${r.name}`;
  if (r.registry === "npm") {
    const p = json(`${r.dir}/package.json`);
    ok(p.name === r.name && p.version === r.version, `${tag}: ${r.dir} publishes ${p.name}@${p.version}`);
    ok(new RegExp(`Formerly ${r.old}\\.`).test(p.description) && /^Agent402 /.test(p.description), `${tag}: the description leads with Agent402 and names the earlier name`);
    ok(readFileSync(join(ROOT, r.dir, "README.md"), "utf8").startsWith(`# ${r.name}\n`), `${tag}: the README's heading is the new name`);
    const s = json(`${shimDir(r)}/package.json`);
    ok(s.name === r.old && s.version === r.shimVersion, `${tag}: ${shimDir(r)} publishes ${s.name}@${s.version}`);
    ok(JSON.stringify(s.dependencies) === JSON.stringify({ [r.name]: forwardRange(r) }), `${tag}: the forwarding release depends on ${r.name}@${forwardRange(r)} alone`);
    ok(s.files.every((f) => existsSync(join(ROOT, shimDir(r), f))) && !s.scripts, `${tag}: every listed file exists and no install script runs`);
    ok(readFileSync(join(ROOT, shimDir(r), "LICENSE"), "utf8").includes(LEGAL) && s.license === "MIT", `${tag}: MIT, with the license naming Cardhavok LLC`);
    ok(readFileSync(join(ROOT, shimDir(r), "README.md"), "utf8").includes(`Renamed to [\`${r.name}\`]`), `${tag}: the README says where it moved`);
    if (p.bin) ok(JSON.stringify(Object.keys(s.bin)) === JSON.stringify([r.old]) && Object.keys(p.bin).includes(r.name), `${tag}: the earlier command name runs the new one`);
  } else {
    const py = readFileSync(join(ROOT, r.dir, "pyproject.toml"), "utf8");
    const mod = r.name.replace(/-/g, "_");
    ok(py.includes(`name = "${r.name}"`) && readFileSync(join(ROOT, r.dir, mod, "__init__.py"), "utf8").includes(`__version__ = "${r.version}"`), `${tag}: ${r.dir} builds ${r.name} ${r.version}`);
    const s = readFileSync(join(ROOT, shimDir(r), "pyproject.toml"), "utf8");
    ok(s.includes(`name = "${r.old}"`) && s.includes(`version = "${r.shimVersion}"`) && s.includes(`"${r.name}>=${r.version},<`), `${tag}: the forwarding release ${r.old} ${r.shimVersion} depends on ${r.name}`);
    const init = readFileSync(join(ROOT, shimDir(r), r.old.replace(/-/g, "_"), "__init__.py"), "utf8");
    ok(init.includes("DeprecationWarning") && init.includes(`from ${mod} import *`), `${tag}: the forwarding module warns and re-exports ${mod}`);
  }
}

// Installed beside the new packages, each forwarding release exports the same
// names and prints its notice once. --preserve-symlinks resolves every import
// inside the temporary tree, as an install would.
{
  const tmp = mkdtempSync(join(tmpdir(), "a402-renames-"));
  try {
    mkdirSync(join(tmp, "node_modules"));
    symlinkSync(join(ROOT, "client"), join(tmp, "node_modules", "agent402-client"));
    const npm = PACKAGE_RENAMES.filter((r) => r.registry === "npm");
    for (const r of npm) {
      symlinkSync(join(ROOT, r.dir), join(tmp, "node_modules", r.name));
      symlinkSync(join(ROOT, shimDir(r)), join(tmp, "node_modules", r.old));
    }
    for (const r of npm) {
      const code = `const a = await import(${JSON.stringify(r.old)}); await import(${JSON.stringify(r.old)}); const b = await import(${JSON.stringify(r.name)});
        const ka = Object.keys(a).sort().join(","), kb = Object.keys(b).sort().join(",");
        if (ka !== kb || a.default !== b.default) { console.log("MISMATCH", ka, "|", kb); process.exit(3); }
        setTimeout(() => console.log("keys", Object.keys(a).length), 10);`;
      const out = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", code], { cwd: tmp, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
      const notices = (out.stderr.match(/AGENT402_PACKAGE_RENAMED/g) || []).length;
      ok(out.status === 0 && /keys \d+/.test(out.stdout), `${r.old}: imports and exports what ${r.name} exports (${out.stdout.trim() || out.stderr.trim().slice(0, 200)})`);
      ok(notices === 1 && out.stderr.includes(renameNotice(r)), `${r.old}: prints its notice once across two imports (${notices})`);
    }
    const oc = npm.find((r) => r.old === "agent402-openclaw");
    const cli = spawnSync(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", join(tmp, "node_modules", oc.old, "cli.js"), "help"], { cwd: tmp, encoding: "utf8" });
    ok(cli.status === 0 && cli.stdout.includes(`${oc.name} setup`) && cli.stderr.includes(renameNotice(oc)), `${oc.old} help runs ${oc.name}'s command and prints the notice (${cli.status})`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// An earlier name outside the records of history and the move itself appears
// only on a line that says it was renamed (an install or import line naming it
// would send a reader to a name that takes no further releases).
{
  const KEEP = new Set(["CHANGELOG.md", "src/changelog.js", "scripts/lib/package-renames.js", "scripts/test-package-renames.js", "src/sale-path.js", "workers/status-probe/src/previous-issue-titles.js"]);
  const olds = [...new Set(PACKAGE_RENAMES.map((r) => r.old))];
  const re = new RegExp(`(?<![\\w-])(${olds.map((o) => o.replace(/[-]/g, "\\-")).join("|")}|agent402_langchain)(?![\\w-])`);
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && !KEEP.has(f) && !f.startsWith("renamed/") && !/\.(png|jpe?g|gif|ico|woff2?|ttf|otf|pdf)$/.test(f));
  const bad = [];
  for (const f of files) {
    let s; try { s = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    if (!re.test(s)) continue;
    s.split("\n").forEach((line, i) => { if (re.test(line) && !/formerly|renamed|is now|earlier name/i.test(line)) bad.push(`${f}:${i + 1}`); });
  }
  ok(bad.length === 0, `an earlier package name appears only where the move is stated${bad.length ? `: ${bad.slice(0, 12).join(", ")}` : ""}`);
}

// The publish job.
{
  const wf = load(expandedDeployWorkflow());
  const steps = wf.jobs?.publish?.steps || [];
  const names = steps.map((s) => String(s.name || ""));
  const fwd = names.findIndex((n) => /forwarding releases to npm$/.test(n));
  const lastNew = Math.max(...PACKAGE_RENAMES.filter((r) => r.registry === "npm").map((r) => names.indexOf(`Publish ${r.name} to npm`)));
  ok(PACKAGE_RENAMES.filter((r) => r.registry === "npm").every((r) => names.includes(`Publish ${r.name} to npm`)), "the publish job publishes every new name");
  ok(fwd > lastNew && lastNew >= 0, `the forwarding releases publish after every new name (${fwd} > ${lastNew})`);
  const run = String(steps[fwd]?.run || "");
  ok(/for DIR in renamed\/\*\/;/.test(run) && /npm publish --provenance --access public/.test(run) && /npm view "\$TARGET" version/.test(run), "that step publishes each renamed/ package with provenance, only once its target is on npm");
  const probe = String(steps.find((s) => /OIDC preflight/.test(String(s.name || "")))?.run || "");
  ok(/for DIR in mcp tollbooth client openclaw adapters\/\*\/ renamed\/\*\/;/.test(probe), "the trusted-publisher probe reads renamed/ too");
  const py = load(readFileSync(join(ROOT, ".github/workflows/publish-langchain-py.yml"), "utf8"));
  const build = JSON.stringify(py.jobs?.build?.steps || []);
  ok(build.includes("adapters/langchain-py") && build.includes("renamed/agent402-langchain-py") && JSON.stringify(py.jobs?.publish?.steps || []).includes("skip-existing"), "the PyPI workflow builds both projects and skips a file PyPI already holds");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
