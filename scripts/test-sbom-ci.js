// The deploy workflow's `sbom` job: CycloneDX SBOMs of the server and every
// published package (scripts/sbom-release.js), uploaded as a workflow artifact
// on every push to main. Pinned here: the job runs on a push to main, holds no
// secret and no write permission, installs nothing, pins its actions by SHA,
// uploads every SBOM, and gates no release (no job needs it, and it needs no
// job, so the deploy and publish conditions are unchanged). The package list
// equals the directories the publish job releases from. Then the generator
// itself, offline: a package with a lockfile and the server.
//
//   node scripts/test-sbom-ci.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";
import { PACKAGE_DIRS, sbomFileName } from "./sbom-release.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const wf = load(expandedDeployWorkflow());
const jobs = wf.jobs || {};
const job = jobs.sbom || {};
const steps = job.steps || [];
const raw = JSON.stringify(job);

ok(!!jobs.sbom, "deploy.yml has an sbom job");
ok(String(job.if || "").replace(/\s+/g, " ").trim() === "github.event_name == 'push' && github.ref == 'refs/heads/main'", `it runs on every push to main (${job.if})`);
ok(job.needs === undefined, "it waits on no job (a skipped marker or lane never drops it)");
const dependents = Object.entries(jobs).filter(([, j]) => [].concat(j.needs || []).includes("sbom")).map(([n]) => n);
ok(dependents.length === 0, `no job needs it, so it gates no release (${dependents.join(", ") || "none"})`);
ok(!/\bsbom\b/.test(String(jobs.deploy?.if || "") + String(jobs.publish?.if || "")), "the deploy and publish conditions do not read it");
ok(JSON.stringify(job.permissions) === JSON.stringify({ contents: "read" }), `its token reads the tree and nothing else (${JSON.stringify(job.permissions)})`);
ok(!/secrets\./.test(raw) && job.environment === undefined, "it holds no secret and no deployment environment");
ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] <= 30, "it is bounded");
ok(steps.filter((s) => s.uses).every((s) => /@[0-9a-f]{40}$/.test(String(s.uses))), "every action it uses is pinned by commit SHA");
const runs = steps.map((s) => String(s.run || "")).join("\n");
ok(!/\bnpm (ci|install|i)\b|\bnpx\b/.test(runs), "no step installs packages into the runner (the generator reads lockfiles)");
const buildAt = steps.findIndex((s) => /^node scripts\/sbom-release\.js --out sbom$/.test(String(s.run || "").trim()));
const upAt = steps.findIndex((s) => /^actions\/upload-artifact@/.test(String(s.uses || "")));
ok(buildAt >= 0, "a step runs scripts/sbom-release.js --out sbom");
ok(upAt > buildAt, "the upload follows the build");
const up = steps[upAt] || {};
ok(up.with?.path === "sbom/*.cdx.json" && up.with?.["if-no-files-found"] === "error", "the upload takes every SBOM and fails when there is none");
ok(/^sbom-\$\{\{ github\.sha \}\}$/.test(String(up.with?.name || "")) && Number(up.with?.["retention-days"]) >= 30, "the artifact is named by the commit and kept at least 30 days");
ok(!steps.some((s) => s["continue-on-error"]), "no step hides its own failure");

// The package list is the publish job's: every `cd <dir>` that precedes an npm publish.
const publishRuns = (jobs.publish?.steps || []).map((s) => String(s.run || "")).filter((r) => /npm publish --provenance/.test(r));
const published = [...new Set(publishRuns.map((r) => (/\bcd ([\w./-]+)/.exec(r) || [])[1]).filter(Boolean))].sort();
ok(published.length >= 10, `the publish job's package directories are read (${published.length})`);
ok(JSON.stringify([...PACKAGE_DIRS].sort()) === JSON.stringify(published), `the SBOM list equals the published packages${JSON.stringify([...PACKAGE_DIRS].sort()) === JSON.stringify(published) ? "" : ` (sbom ${PACKAGE_DIRS.join(",")}; publish ${published.join(",")})`}`);
ok(new Set(PACKAGE_DIRS.map((d) => sbomFileName(JSON.parse(readFileSync(join(ROOT, d, "package.json"), "utf8")).name))).size === PACKAGE_DIRS.length, "every package gets its own file");
ok(sbomFileName("@scope/pkg") === "scope__pkg.cdx.json" && sbomFileName("agent402-mcp") === "agent402-mcp.cdx.json", "a scoped name folds into a file name");

// The generator, offline: the server and the one package that keeps its own lockfile.
const out = mkdtempSync(join(tmpdir(), "a402-sbom-ci-"));
try {
  const r = spawnSync(process.execPath, ["scripts/sbom-release.js", "--out", out, "--only", "server,mcp"], { cwd: ROOT, encoding: "utf8" });
  ok(r.status === 0, `the generator exits 0 for the server and mcp (${r.status}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""})`);
  const files = readdirSync(out).sort();
  ok(JSON.stringify(files) === JSON.stringify(["agent402-mcp.cdx.json", "agent402.cdx.json"]), `it writes one file per package (${files.join(", ")})`);
  for (const f of files) {
    const bom = JSON.parse(readFileSync(join(out, f), "utf8"));
    ok(bom.bomFormat === "CycloneDX" && bom.specVersion === "1.5" && bom.components.length > 10, `${f} is a CycloneDX 1.5 document with its components (${bom.components.length})`);
    ok(!bom.components.some((c) => c.scope === "excluded"), `${f} leaves out development packages`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
