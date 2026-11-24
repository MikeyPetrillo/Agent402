// The owner's commands around the package renames (scripts/lib/package-renames.js).
// It prints the commands; with --run it runs them from the owner's own npm login.
// Nothing here runs in CI.
//
//   node scripts/package-renames.js status            what the registries hold now (read only)
//   node scripts/package-renames.js claim [--run]     BEFORE the [publish] merge: create each new
//        npm name with a placeholder prerelease and add its trusted publisher (npm trust).
//        OIDC cannot create a package, and npm trust needs the package to exist. The
//        trusted publisher must complete an OIDC publish within 2 days of being added,
//        which the [publish] run does when it publishes the real version.
//   node scripts/package-renames.js deprecate [--run] AFTER the [publish] run: deprecate every
//        earlier npm name (its forwarding release is on npm by then) and each placeholder.
//   node scripts/package-renames.js pypi              the PyPI steps (web only: PyPI has no
//        deprecate command, and a project is archived from its settings page).
//
// Never unpublish: lockfiles and the forwarding releases depend on every version.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_RENAMES, shimDir } from "./lib/package-renames.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = "MikeyPetrillo/Agent402";
const WORKFLOW = "deploy.yml";
const ENVIRONMENT = "agent402 / production";
const PYPI_WORKFLOW = "publish-langchain-py.yml";
const [mode = "status", ...rest] = process.argv.slice(2);
const RUN = rest.includes("--run");
const NPM = PACKAGE_RENAMES.filter((r) => r.registry === "npm");
const PYPI = PACKAGE_RENAMES.filter((r) => r.registry === "pypi");

export const placeholderVersion = (r) => `${r.version}-claim.0`;
export const deprecationMessage = (r) => `Renamed to ${r.name}: npm i ${r.name} (same API). This name gets no further releases.`;

const q = (s) => (/^[\w@./^=:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const npm = (args, opts = {}) => spawnSync("npm", args, { encoding: "utf8", ...opts });
const onNpm = (spec) => npm(["view", spec, "version"]).status === 0;
function step(args, opts = {}) {
  console.log(`  ${opts.cwd ? `(cd ${q(opts.cwd)} && ` : ""}npm ${args.map(q).join(" ")}${opts.cwd ? ")" : ""}`);
  if (!RUN) return true;
  const r = npm(args, { ...opts, stdio: "inherit" });
  if (r.status !== 0) { console.error(`  failed (exit ${r.status}); stopping`); process.exit(1); }
  return true;
}

if (mode === "status") {
  for (const r of NPM) {
    console.log(`${r.old}@${r.shimVersion} ${onNpm(`${r.old}@${r.shimVersion}`) ? "on npm" : "not yet"}  ->  ${r.name}@${r.version} ${onNpm(`${r.name}@${r.version}`) ? "on npm" : onNpm(r.name) ? "name exists, version not yet" : "name not created"}`);
  }
  for (const r of PYPI) console.log(`PyPI ${r.old}@${r.shimVersion} -> ${r.name}@${r.version} (see: pypi)`);
} else if (mode === "claim") {
  console.log(`Needs npm >= 11.15.0 (npm trust), a login with publish rights on ${REPO}'s packages and 2FA.`);
  for (const r of NPM) {
    if (onNpm(r.name)) { console.log(`${r.name}: exists; adding the trusted publisher only`); }
    else {
      console.log(`${r.name}: placeholder ${placeholderVersion(r)} (dist-tag claim), from ${r.dir}`);
      // A copy, so the working tree keeps the real version the [publish] run ships.
      const tmp = mkdtempSync(join(tmpdir(), "agent402-claim-"));
      const dir = join(tmp, "pkg");
      cpSync(join(ROOT, r.dir), dir, { recursive: true, filter: (p) => !/node_modules|\.tgz$/.test(p) });
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      pkg.version = placeholderVersion(r);
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      step(["publish", "--access", "public", "--tag", "claim"], { cwd: RUN ? dir : r.dir });
      rmSync(tmp, { recursive: true, force: true });
    }
    step(["trust", "github", r.name, "--file", WORKFLOW, "--repo", REPO, "--env", ENVIRONMENT, "--allow-publish", "-y"]);
  }
  console.log(`Then merge the [publish] batch within 2 days: its publish job publishes each ${NPM.length} new name's real version over OIDC, which validates the trusted publisher.`);
} else if (mode === "deprecate") {
  for (const r of NPM) {
    const ready = onNpm(`${r.name}@${r.version}`) && onNpm(`${r.old}@${r.shimVersion}`);
    if (!ready) { console.log(`${r.old}: skipped (${r.name}@${r.version} or ${r.old}@${r.shimVersion} is not on npm yet)`); continue; }
    step(["deprecate", r.old, deprecationMessage(r)]);
    if (onNpm(`${r.name}@${placeholderVersion(r)}`)) step(["deprecate", `${r.name}@${placeholderVersion(r)}`, `Placeholder that created the name: install ${r.name}@${r.version} or later.`]);
  }
} else if (mode === "pypi") {
  for (const r of PYPI) {
    console.log(`1. Before the first run: pypi.org -> Your account -> Publishing -> add a pending publisher:
     PyPI project name ${r.name}, owner ${REPO.split("/")[0]}, repository ${REPO.split("/")[1]},
     workflow ${PYPI_WORKFLOW}, environment (blank). The existing ${r.old} project keeps its own
     trusted publisher, which names the same workflow, so one run publishes both.
2. Run the "${PYPI_WORKFLOW}" workflow (Actions -> Run workflow). It uploads ${r.name} ${r.version}
     (adapters/langchain-py) and ${r.old} ${r.shimVersion} (${shimDir(r)}), the release that depends
     on ${r.name}, re-exports it and warns once on import.
3. After both are on PyPI: ${r.old} -> Settings -> Archive project. Archiving says the project takes
     no more releases and keeps every file installable; never delete the project.`);
  }
} else {
  console.error(`unknown mode: ${mode} (status, claim, deprecate, pypi)`);
  process.exit(2);
}
