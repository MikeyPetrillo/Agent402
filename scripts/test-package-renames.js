// The package renames (scripts/lib/package-renames.js), offline:
//  - each new name is the package its directory publishes, at the listed version;
//  - each earlier name's forwarding release under renamed/ depends on exactly its
//    new name's minor line, ships its README and license, and, installed beside
//    the new package, exports what the new package exports and prints its
//    notice once however often it is imported;
//  - no published name carries another party's mark (the names below);
//  - outside the places that record history or the move itself, an earlier
//    name appears only on a line that says it was renamed; the generated
//    package list is read by its fields instead (an earlier name's entry
//    carries its replacement in `renamedTo`);
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
import { escapeRegex } from "../src/tools/safe-regex.js";
import { runClaim, trustState, parseTrustList, isSpamRefusal, WORKFLOW, REPO, ENVIRONMENT, CLAIM_RERUN } from "./package-renames.js";

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
  const re = new RegExp(`(?<![\\w-])(${olds.map(escapeRegex).join("|")}|agent402_langchain)(?![\\w-])`);
  // The generated package list is data, not prose: it names each earlier
  // package on purpose (the pages built from it say where each one moved), so
  // it is read by its fields. An entry under an earlier name must carry
  // `renamedTo` with that name's replacement on the same registry, and the
  // earlier name appears nowhere else in the file.
  const LIST = "src/generated/official-packages.json";
  const listFindings = (text) => {
    const out = [];
    let doc; try { doc = JSON.parse(text); } catch { return ["not JSON"]; }
    const { packages = [], ...rest } = doc;
    for (const p of packages) {
      if (!re.test(String(p.name))) {
        if (re.test(JSON.stringify(p))) out.push(`${p.name}: an earlier name in an entry that is not its own`);
        continue;
      }
      const want = PACKAGE_RENAMES.find((r) => r.old === p.name && r.registry === p.registry)?.name;
      if (!want) out.push(`${p.name} (${p.registry}): no rename is recorded for it`);
      else if (p.renamedTo !== want) out.push(`${p.name} (${p.registry}): renamedTo is ${p.renamedTo === undefined ? "missing" : p.renamedTo}, expected ${want}`);
      const others = Object.entries(p).filter(([k]) => !["name", "registry", "path", "renamedTo"].includes(k));
      if (others.some(([, v]) => re.test(JSON.stringify(v)))) out.push(`${p.name}: an earlier name in another field`);
    }
    if (re.test(JSON.stringify(rest))) out.push("an earlier name outside the package entries");
    return out;
  };
  {
    const text = readFileSync(join(ROOT, LIST), "utf8");
    const found = listFindings(text);
    const doc = JSON.parse(text);
    const paired = doc.packages.filter((p) => p.renamedTo);
    ok(found.length === 0 && paired.length >= PACKAGE_RENAMES.length, `${LIST}: every earlier name is paired with its replacement (${paired.length} entries)${found.length ? `: ${found.slice(0, 6).join("; ")}` : ""}`);
    // Controls on copies of the real list: the pairing removed, pointed at
    // another package, and an earlier name in an entry that is not its own.
    const mutate = (fn) => { const d = JSON.parse(text); fn(d.packages); return listFindings(JSON.stringify(d)); };
    const at = (ps) => ps.find((p) => p.renamedTo);
    ok(mutate((ps) => { delete at(ps).renamedTo; }).some((m) => /renamedTo is missing/.test(m)), "control: an earlier name without its replacement fails");
    ok(mutate((ps) => { at(ps).renamedTo = "agent402-client"; }).some((m) => /expected /.test(m)), "control: an earlier name paired with another package fails");
    ok(mutate((ps) => { ps.find((p) => !p.renamedTo).note = `install ${olds[0]}`; }).some((m) => /not its own/.test(m)), "control: an earlier name in a current package's entry fails");
    ok(mutate((ps) => { ps.push({ name: "agent402_langchain", registry: "npm", path: "x" }); }).some((m) => /no rename is recorded/.test(m)), "control: an earlier name with no recorded rename fails");
  }
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && f !== LIST && !KEEP.has(f) && !f.startsWith("renamed/") && !/\.(png|jpe?g|gif|ico|woff2?|ttf|otf|pdf)$/.test(f));
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
  // The forwarding release publishes only after PyPI serves the new name.
  const pySteps = py.jobs?.publish?.steps || [];
  const iNew = pySteps.findIndex((st) => st.with?.["packages-dir"] === "dist/new/");
  const iCheck = pySteps.findIndex((st) => /pypi\.org\/pypi\/agent402-structured-tools\/\$V\/json/.test(String(st.run || "")) && /exit 1/.test(String(st.run || "")));
  const iShim = pySteps.findIndex((st) => st.with?.["packages-dir"] === "dist/shim/");
  ok(iNew >= 0 && iCheck > iNew && iShim > iCheck && !pySteps.some((st) => st.with?.["packages-dir"] === "dist/"), `the PyPI forwarding release publishes only after PyPI serves the new name (${iNew} < ${iCheck} < ${iShim})`);
  ok(build.includes("dist/new") && build.includes("dist/shim"), "the two PyPI projects build into separate directories");
}

// The claim run (scripts/package-renames.js claim --run) against a fake npm: a rerun
// skips every name that exists and every trusted publisher already listed, and a
// spam-check 403 stops on the refused name with the rerun command.
{
  const NPMS = PACKAGE_RENAMES.filter((r) => r.registry === "npm").slice(0, 3);
  const ours = { id: "t1", type: "github", file: WORKFLOW, repository: REPO, environment: ENVIRONMENT, permissions: ["createPackage", "createStagedPackage"] };
  const fake = ({ exists = new Set(), trusted = new Set(), spam = new Set() }) => {
    const calls = [];
    const npm = (args) => {
      calls.push(args.join(" "));
      const name = args[0] === "view" ? args[1] : args[0] === "trust" ? args[2] : null;
      if (args[0] === "view") return exists.has(name) ? { status: 0, stdout: "0.0.0\n", stderr: "" } : { status: 1, stdout: "", stderr: "npm error code E404\n" };
      if (args[0] === "trust" && args[1] === "list") return { status: 0, stdout: trusted.has(name) ? JSON.stringify(ours, null, 2) : "", stderr: "" };
      if (args[0] === "trust") { trusted.add(name); return { status: 0 }; }
      if (args[0] === "publish") {
        const pkg = calls.length && NPMS.find((r) => !exists.has(r.name));
        if (pkg && spam.has(pkg.name)) return { status: 1, stdout: "", stderr: "npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - Package name triggered spam detection\n" };
        if (pkg) exists.add(pkg.name);
        return { status: 0 };
      }
      return { status: 1 };
    };
    return { npm, calls };
  };
  const quiet = { log: () => {}, err: () => {} };
  const first = NPMS[0].name;
  const f1 = fake({ exists: new Set([first]), trusted: new Set([first]) });
  const r1 = runClaim({ run: true, npm: f1.npm, renames: NPMS, ...quiet });
  const pubs1 = f1.calls.filter((c) => c.startsWith("publish")).length;
  const trusts1 = f1.calls.filter((c) => /^trust github/.test(c)).map((c) => c.split(" ")[2]);
  ok(r1.ok && pubs1 === NPMS.length - 1 && !trusts1.includes(first) && trusts1.length === NPMS.length - 1, `claim --run skips an existing name with its publisher and does the rest (${pubs1} publishes, trust on ${trusts1.join(", ")})`);
  const f2 = fake({ exists: new Set(NPMS.map((r) => r.name)), trusted: new Set(NPMS.map((r) => r.name)) });
  const r2 = runClaim({ run: true, npm: f2.npm, renames: NPMS, ...quiet });
  ok(r2.ok && !f2.calls.some((c) => /^publish|^trust github/.test(c)), "a rerun after a full claim publishes nothing and adds no publisher");
  const f3 = fake({ exists: new Set([first]) });
  runClaim({ run: true, npm: f3.npm, renames: NPMS.slice(0, 1), ...quiet });
  ok(f3.calls.includes(`trust github ${first} --file ${WORKFLOW} --repo ${REPO} --env ${ENVIRONMENT} --allow-publish -y`), "an existing name without its publisher gets the publisher added");
  const errs = [];
  const f4 = fake({ exists: new Set([first]), trusted: new Set([first]), spam: new Set([NPMS[1].name]) });
  const r4 = runClaim({ run: true, npm: f4.npm, renames: NPMS, log: () => {}, err: (m) => errs.push(m) });
  ok(!r4.ok && r4.stoppedAt === NPMS[1].name && errs.some((m) => m.includes(`"${NPMS[1].name}"`) && /spam detection/.test(m)) && errs.some((m) => m.includes(CLAIM_RERUN))
    && !f4.calls.some((c) => c.startsWith(`trust github ${NPMS[1].name}`)) && f4.calls.filter((c) => c.startsWith("publish")).length === 1, "a spam-check 403 stops on the refused name, names it and prints the rerun command");
  const logs = [];
  runClaim({ run: false, npm: fake({ exists: new Set([first]), trusted: new Set([first]) }).npm, renames: NPMS, log: (m) => logs.push(m), err: () => {} });
  ok(logs.some((m) => m.startsWith("Names still to create (2):") && NPMS.slice(1).every((r) => m.includes(r.name)) && !m.includes(first)), "the claim prints every name still to create before it publishes");
  ok(trustState(parseTrustList(`${JSON.stringify(ours, null, 2)}\n${JSON.stringify({ ...ours, id: "t2", file: "other.yml" }, null, 2)}`)).state === "present"
    && trustState([{ ...ours, environment: "staging" }]).state === "absent" && trustState([{ ...ours, permissions: ["createStagedPackage"] }]).state === "no-publish"
    && isSpamRefusal("npm error 403 Forbidden - Package name triggered spam detection") && !isSpamRefusal("npm error 403 Forbidden - You do not have permission"), "trust list parsing and the spam-refusal test read the right fields");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
