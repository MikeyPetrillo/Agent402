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
//        Rerunnable: a name that exists is not published again, a trusted publisher
//        already listed (npm trust list) is not added again, and a stop names the
//        next command. A 403 from npm's spam check stops on the name it refused.
//   node scripts/package-renames.js deprecate [--run] AFTER the [publish] run: deprecate every
//        earlier npm name (its forwarding release is on npm by then) and each placeholder.
//   node scripts/package-renames.js pypi              the PyPI steps (web only: PyPI has no
//        deprecate command, and a project is archived from its settings page).
//
// Never unpublish: lockfiles and the forwarding releases depend on every version.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGE_RENAMES, shimDir } from "./lib/package-renames.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REPO = "MikeyPetrillo/Agent402";
export const WORKFLOW = "deploy.yml";
export const ENVIRONMENT = "agent402 / production";
const PYPI_WORKFLOW = "publish-langchain-py.yml";
const NPM = PACKAGE_RENAMES.filter((r) => r.registry === "npm");
const PYPI = PACKAGE_RENAMES.filter((r) => r.registry === "pypi");
export const CLAIM_RERUN = "node scripts/package-renames.js claim --run";

export const placeholderVersion = (r) => `${r.version}-claim.0`;
export const deprecationMessage = (r) => `Renamed to ${r.name}: npm i ${r.name} (same API). This name gets no further releases.`;

const q = (s) => (/^[\w@./^=:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
export const shown = (args, cwd) => `${cwd ? `(cd ${q(cwd)} && ` : ""}npm ${args.map(q).join(" ")}${cwd ? ")" : ""}`;
const realNpm = (args, opts = {}) => spawnSync("npm", args, { encoding: "utf8", ...opts });

/** "exists", "missing" (the registry answered 404) or "unknown" (any other failure). */
export function registryState(npm, spec) {
  const r = npm(["view", spec, "version"]);
  if (r.status === 0) return "exists";
  return /\bE404\b|404 Not Found/.test(`${r.stderr || ""}${r.stdout || ""}`) ? "missing" : "unknown";
}
const onNpm = (spec) => registryState(realNpm, spec) === "exists";

/** npm's refusal of a new name by its spam check (a 403 that no retry or login changes). */
export const isSpamRefusal = (text) => /\b403\b/.test(String(text || "")) && /spam detection/i.test(String(text || ""));

/** The relationships `npm trust list <pkg> --json` prints: one object, an array, or one object per line. */
export function parseTrustList(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch { /* one object per block */ }
  const out = [];
  for (const m of s.matchAll(/\{[\s\S]*?\n\}/g)) { try { out.push(JSON.parse(m[0])); } catch { /* not an object */ } }
  return out;
}

/** Whether the list holds this repo's GitHub publisher: same workflow file, repo and environment, allowed to publish. */
export function trustState(list) {
  const same = list.filter((t) => t && t.type === "github" && t.file === WORKFLOW
    && String(t.repository || "").toLowerCase() === REPO.toLowerCase() && t.environment === ENVIRONMENT);
  if (!same.length) return { state: "absent" };
  const pub = same.find((t) => !Array.isArray(t.permissions) || t.permissions.includes("createPackage"));
  return pub ? { state: "present", id: pub.id } : { state: "no-publish", id: same[0].id };
}

/** The newest debug log npm wrote into dir (publish runs with --logs-dir), or "". */
function newestLog(dir) {
  try {
    const f = readdirSync(dir).filter((n) => n.endsWith(".log")).sort().pop();
    return f ? readFileSync(join(dir, f), "utf8") : "";
  } catch { return ""; }
}

/**
 * Create each new npm name with a placeholder and add its trusted publisher, skipping
 * every part already done, so a rerun after any stop picks up where it stopped.
 * Returns { ok, stoppedAt }. npm and the io are injected so the suite can drive it offline.
 */
export function runClaim({ run = false, npm = realNpm, log = console.log, err = console.error, renames = NPM, root = ROOT } = {}) {
  const stop = (name, why, next) => {
    err(`  stopped at ${name}: ${why}`);
    for (const n of next) err(`  next: ${n}`);
    return { ok: false, stoppedAt: name };
  };
  log(`Needs npm >= 11.15.0 (npm trust), a login with publish rights on ${REPO}'s packages and 2FA.`);
  const plan = renames.map((r) => ({ r, state: registryState(npm, r.name) }));
  const unknown = plan.find((p) => p.state === "unknown");
  if (unknown) return stop(unknown.r.name, "the registry could not be read", [`npm view ${unknown.r.name} version`, CLAIM_RERUN]);
  const remaining = plan.filter((p) => p.state === "missing");
  log(remaining.length
    ? `Names still to create (${remaining.length}): ${remaining.map((p) => p.r.name).join(", ")}`
    : "Every new name exists; only missing trusted publishers are added.");
  for (const { r, state } of plan) {
    if (state === "exists") log(`${r.name}: exists; publish skipped`);
    else {
      log(`${r.name}: placeholder ${placeholderVersion(r)} (dist-tag claim), from ${r.dir}`);
      // A copy, so the working tree keeps the real version the [publish] run ships.
      const tmp = mkdtempSync(join(tmpdir(), "agent402-claim-"));
      try {
        const dir = join(tmp, "pkg");
        const logs = join(tmp, "logs");
        const args = ["publish", "--access", "public", "--tag", "claim"];
        log(`  ${shown(args, r.dir)}`);
        if (run) {
          cpSync(join(root, r.dir), dir, { recursive: true, filter: (p) => !/node_modules|\.tgz$/.test(p) });
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          pkg.version = placeholderVersion(r);
          writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
          const res = npm([...args, "--logs-dir", logs], { cwd: dir, stdio: "inherit" });
          if (res.status !== 0) {
            const text = `${res.stderr || ""}${res.stdout || ""}${newestLog(logs)}`;
            if (isSpamRefusal(text)) {
              return stop(r.name, `npm refused the name "${r.name}" (403, package name triggered spam detection). No retry or login changes that: choose another name for ${r.dir} in scripts/lib/package-renames.js, rename it everywhere, check it with npm view <name> (404 = free), then rerun`, [CLAIM_RERUN]);
            }
            // The name may exist now even though the call failed (a timeout after the write).
            if (registryState(npm, r.name) !== "exists") return stop(r.name, `npm publish failed (exit ${res.status})`, [CLAIM_RERUN]);
            log(`  ${r.name} exists after the failed call; going on`);
          }
        }
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    const trustArgs = ["trust", "github", r.name, "--file", WORKFLOW, "--repo", REPO, "--env", ENVIRONMENT, "--allow-publish", "-y"];
    if (!run && state === "missing") { log(`  ${shown(trustArgs)}`); continue; }
    const listed = npm(["trust", "list", r.name, "--json"]);
    if (listed.status !== 0) return stop(r.name, `npm trust list failed (exit ${listed.status}): ${String(listed.stderr || "").trim().split("\n").pop() || "no output"}`, [`npm trust list ${r.name} --json`, CLAIM_RERUN]);
    const t = trustState(parseTrustList(listed.stdout));
    if (t.state === "present") { log(`${r.name}: trusted publisher present (${WORKFLOW}, ${ENVIRONMENT}); trust skipped`); continue; }
    if (t.state === "no-publish") {
      return stop(r.name, `its trusted publisher for ${WORKFLOW} is not allowed to publish`, [`npm trust revoke ${r.name} --id=${t.id}`, CLAIM_RERUN]);
    }
    log(`  ${shown(trustArgs)}`);
    if (!run) continue;
    const res = npm(trustArgs, { stdio: "inherit" });
    if (res.status !== 0) return stop(r.name, `npm trust failed (exit ${res.status})`, [shown(trustArgs), CLAIM_RERUN]);
  }
  log(`Then merge the [publish] batch within 2 days: its publish job publishes each of the ${renames.length} new names' real version over OIDC, which validates the trusted publisher.`);
  return { ok: true, stoppedAt: null };
}

function main(argv) {
const [mode = "status", ...rest] = argv;
const RUN = rest.includes("--run");
function step(args, opts = {}) {
  console.log(`  ${shown(args, opts.cwd)}`);
  if (!RUN) return true;
  const r = realNpm(args, { ...opts, stdio: "inherit" });
  if (r.status !== 0) { console.error(`  failed (exit ${r.status}); stopping. Fix the cause above, then rerun: node scripts/package-renames.js ${mode} --run`); process.exit(1); }
  return true;
}

if (mode === "status") {
  for (const r of NPM) {
    console.log(`${r.old}@${r.shimVersion} ${onNpm(`${r.old}@${r.shimVersion}`) ? "on npm" : "not yet"}  ->  ${r.name}@${r.version} ${onNpm(`${r.name}@${r.version}`) ? "on npm" : onNpm(r.name) ? "name exists, version not yet" : "name not created"}`);
  }
  for (const r of PYPI) console.log(`PyPI ${r.old}@${r.shimVersion} -> ${r.name}@${r.version} (see: pypi)`);
} else if (mode === "claim") {
  if (!runClaim({ run: RUN }).ok) process.exit(1);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
