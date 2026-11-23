#!/usr/bin/env node
// Every npm package the publish job ships installs clean for the person who
// installs it: the package is packed from the tree, the tarball is installed
// into an empty directory with --ignore-scripts (the way a buyer's `npm i` or
// `npx` resolves it: the package's own `overrides` do NOT apply there, npm
// reads overrides only from the root project), and `npm audit --omit=dev`
// must report no high or critical advisory.
//
// It also fails when a package's README in the tree differs from the README
// inside the published tarball of the same version: npm shows a README only
// as it was published, so a README edit needs a patch bump to reach readers.
//
// The package list is read from the deploy.yml publish job (each "Publish ...
// to npm" step's `cd <dir>`), so a package added there is audited here.
// It runs in the publish gate (a release only; scripts/test-deploy-release-order.js
// pins that), so a new upstream advisory never holds a deploy. An advisory
// that cannot be fixed yet is accepted in scripts/package-audit-accepted.json,
// keyed "<package>@<version>:<dependency>" (one exact version of ours, so the
// next release is judged afresh), each with a reason. A missing npm fails; an
// unreachable registry (a network error, a registry 5xx) is a loud ::warning::
// and exit 0, as in scripts/socket-check.js: someone else's outage is not
// evidence about our packages, and the publish that follows needs the same
// registry anyway.
//
//   node scripts/test-package-audit.js            # every published package
//   PACKAGE_AUDIT_ONLY=mcp,client node scripts/test-package-audit.js
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedPackageDirs } from "./lib/published-packages.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// High and critical counts from an `npm audit --json` answer (npm 7+ shape).
function highFindings(auditJson) {
  const v = auditJson?.metadata?.vulnerabilities || {};
  const names = Object.entries(auditJson?.vulnerabilities || {})
    .filter(([, x]) => x?.severity === "high" || x?.severity === "critical")
    .map(([n, x]) => `${n} (${x.severity})`);
  return { count: Number(v.high || 0) + Number(v.critical || 0), names };
}

const ACCEPTED_FILE = join(ROOT, "scripts", "package-audit-accepted.json");
const warn = (msg) => console.log(`\n::warning::${msg}\n[package-audit] ${msg}`);

// An npm failure that says the registry could not be reached, as opposed to
// an answer from it (a 404, an ERESOLVE, an audit with findings).
export function registryUnreachable(text) {
  return /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|network request to .* failed|E50[0-4]|50[0-4] (Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out))\b/i.test(String(text || ""));
}

// The accepted list: { "<package>@<version>:<dependency>": "reason" }.
export function readAccepted(raw) {
  const out = new Map(), bad = [];
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!obj) return { accepted: out, bad: ["the file is not a JSON object"] };
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+[^:]*:(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(k)) bad.push(`${k}: key is not "<package>@<version>:<dependency>"`);
    else if (typeof v !== "string" || v.trim().length < 20) bad.push(`${k}: needs a reason`);
    else out.set(k, v);
  }
  return { accepted: out, bad };
}

const npm = (args, opts = {}) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });

const unread = [];

async function main() {
  // Offline controls of the two readers, so a blind parser cannot pass.
  {
    const wf = "jobs:\n  publish:\n    steps:\n      - name: Publish a to npm\n        run: |\n          cd adapters/a\n          npm publish\n      - name: Verify\n        run: cd nope\n";
    const d = publishedPackageDirs(wf);
    ok(d.length === 1 && d[0] === "adapters/a", `control: the publish-step reader takes only "Publish ... to npm" steps (${JSON.stringify(d)})`);
    const h = highFindings({ metadata: { vulnerabilities: { low: 2, high: 1, critical: 0 } }, vulnerabilities: { ws: { severity: "high" }, x: { severity: "low" } } });
    ok(h.count === 1 && h.names.join() === "ws (high)", `control: a high advisory is counted and named (${h.count}, ${h.names})`);
    ok(highFindings({ metadata: { vulnerabilities: { low: 3, moderate: 1 } } }).count === 0, "control: low and moderate advisories are not counted");
    ok(registryUnreachable("npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/x failed") && registryUnreachable("npm error code E503") && !registryUnreachable("npm error code ERESOLVE") && !registryUnreachable("npm error code E404"), "control: a network failure or registry 5xx reads unreachable; ERESOLVE and 404 do not");
    const a = readAccepted({ _note: "x", "a402-example@1.2.3:ws": "held by a pinned dependency with no patched release; drop on the next bump", "client:ws": "a reason that is long enough", "x@1.0.0:y": "" });
    ok(a.accepted.size === 1 && a.accepted.has("a402-example@1.2.3:ws") && a.bad.length === 2, `control: an accepted entry needs an exact version and a reason (${a.accepted.size} kept, ${a.bad.length} refused)`);
  }

  let accepted = new Map();
  {
    let raw = null;
    try { raw = JSON.parse(readFileSync(ACCEPTED_FILE, "utf8")); } catch (e) { raw = null; }
    const r = readAccepted(raw);
    ok(raw && !r.bad.length, `scripts/package-audit-accepted.json reads, every entry keyed to one version with a reason${r.bad.length ? ` (${r.bad.join("; ")})` : ""}`);
    accepted = r.accepted;
  }

  let npmVersion = "";
  try { npmVersion = npm(["--version"]).trim(); } catch (e) { npmVersion = ""; }
  ok(Boolean(npmVersion), `npm is available (${npmVersion || "missing"}); a missing npm fails`);
  if (!npmVersion) return;

  try { npm(["ping"]); } catch (e) {
    const why = String(e?.stderr || e?.message || e);
    if (registryUnreachable(why)) { warn(`the npm registry is unreachable (${(why.split("\n").find((l) => registryUnreachable(l)) || why).trim().slice(0, 160)}): the consumer-install audit did NOT run on this release`); return; }
    ok(false, `npm ping answered with an error that is not a network failure (${why.slice(-300)})`);
    return;
  }

  let dirs = publishedPackageDirs();
  ok(dirs.length >= 14 && ["mcp", "client", "openclaw", "tollbooth", "adapters/eliza"].every((d) => dirs.includes(d)),
    `the publish job's npm packages are read (${dirs.length}: ${dirs.join(", ")})`);
  const only = String(process.env.PACKAGE_AUDIT_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (only.length) {
    if (process.env.CI) { ok(false, "PACKAGE_AUDIT_ONLY narrows the run and is refused under CI"); return; }
    dirs = dirs.filter((d) => only.includes(d));
  }

  for (const dir of dirs) {
    const pkgDir = join(ROOT, dir);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const label = `${pkg.name}@${pkg.version}`;
    const work = mkdtempSync(join(tmpdir(), "a402-pkg-audit-"));
    try {
      // 1. Pack the tree's package and install it the way a consumer does.
      const tgzName = npm(["pack", "--silent", "--pack-destination", work], { cwd: pkgDir }).trim().split("\n").filter(Boolean).pop();
      const tgz = join(work, tgzName);
      const host = join(work, "host");
      execFileSync("mkdir", ["-p", host]);
      writeFileSync(join(host, "package.json"), JSON.stringify({ name: "a402-audit-host", private: true, version: "0.0.0" }));
      let installed = false, installErr = "";
      for (let attempt = 1; attempt <= 2 && !installed; attempt++) {
        try {
          npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tgz], { cwd: host });
          installed = true;
        } catch (e) { installErr = String(e?.stderr || e?.message || e).slice(-600); }
      }
      if (!installed && registryUnreachable(installErr)) { unread.push(`${label}: install`); continue; }
      ok(installed, `${label}: the packed tarball installs into an empty directory with --ignore-scripts${installed ? "" : ` (${installErr})`}`);
      if (!installed) continue;

      // 2. npm audit of what the consumer got. Exit 1 means findings; the
      //    JSON is on stdout either way. No JSON at all is an unread audit.
      let out = "";
      try { out = npm(["audit", "--omit=dev", "--json"], { cwd: host }); }
      catch (e) { out = String(e?.stdout || ""); }
      let audit = null;
      try { audit = JSON.parse(out); } catch { audit = null; }
      const read = Boolean(audit && audit.metadata && !audit.error);
      if (!read && registryUnreachable(JSON.stringify(audit?.error || out))) { unread.push(`${label}: audit`); continue; }
      ok(read, `${label}: npm audit answered${read ? "" : ` (${String(audit?.error?.summary || out).slice(0, 300)})`}`);
      if (!read) continue;
      const h = highFindings(audit);
      const open = h.names.filter((n) => !accepted.has(`${pkg.name}@${pkg.version}:${n.replace(/ \((high|critical)\)$/, "")}`));
      const kept = h.names.length - open.length;
      ok(open.length === 0, `${label}: npm audit --omit=dev finds no high or critical advisory in a consumer install${kept ? ` beyond ${kept} accepted` : ""}${open.length ? ` (${open.length}: ${open.join(", ")})` : ""}`);

      // 3. A README edited after its version was published never reaches npm.
      let published = false;
      try { published = npm(["view", `${pkg.name}@${pkg.version}`, "version"]).trim() === pkg.version; } catch { published = false; }
      if (!published) { ok(true, `${label}: not on npm yet; its README ships with this version`); continue; }
      const reg = join(work, "registry");
      execFileSync("mkdir", ["-p", reg]);
      const regTgz = npm(["pack", "--silent", "--pack-destination", reg, `${pkg.name}@${pkg.version}`], { cwd: reg }).trim().split("\n").filter(Boolean).pop();
      execFileSync("tar", ["-xzf", join(reg, regTgz), "-C", reg]);
      const pubReadme = join(reg, "package", "README.md");
      const treeReadme = join(pkgDir, "README.md");
      const same = existsSync(pubReadme) && existsSync(treeReadme) && readFileSync(pubReadme, "utf8") === readFileSync(treeReadme, "utf8");
      ok(same, `${label}: the README in the tree is the one published with ${pkg.version}${same ? "" : " (it changed after publishing: bump the patch version so npm shows it)"}`);
    } catch (e) {
      ok(false, `${label}: ${String(e?.stderr || e?.message || e).slice(-600)}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

await main();
if (unread.length) warn(`the npm registry could not be reached for ${unread.length} step(s) (${unread.join(", ")}): those were NOT audited on this release`);
console.log(`\ntest-package-audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
