// scripts/sbom.js: a CycloneDX 1.5 SBOM from package-lock.json, offline and
// deterministic. A fixture lockfile pins the mapping (scoped names, hashes,
// nested resolution, dev scope); the repository's own lockfile pins coverage.
//
//   node scripts/test-sbom.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSbom, purlOf, hashesOf, resolveFrom } from "./sbom.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const fixture = JSON.stringify({
  name: "demo", version: "1.0.0", lockfileVersion: 3,
  packages: {
    "": { name: "demo", version: "1.0.0", license: "MIT", dependencies: { a: "^1", "@s/b": "2" }, devDependencies: { t: "1" } },
    "node_modules/a": { version: "1.2.3", resolved: "https://registry.npmjs.org/a/-/a-1.2.3.tgz", integrity: "sha512-AAAA", license: "MIT", dependencies: { c: "1" } },
    "node_modules/a/node_modules/c": { version: "1.0.0", integrity: "sha1-AAAA" },
    "node_modules/c": { version: "2.0.0" },
    "node_modules/@s/b": { version: "2.0.0", license: "(MIT OR Apache-2.0)", optional: true, dependencies: { c: "2" } },
    "node_modules/t": { version: "1.0.0", dev: true },
    "node_modules/linked": { link: true, resolved: "packages/linked" },
  },
});

const bom = buildSbom(fixture);
const byRef = new Map(bom.components.map((c) => [c["bom-ref"], c]));
ok(bom.bomFormat === "CycloneDX" && bom.specVersion === "1.5" && bom.version === 1, "CycloneDX 1.5 envelope");
ok(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bom.serialNumber), `the serial number is a well-formed UUID (${bom.serialNumber})`);
ok(JSON.stringify(buildSbom(fixture)) === JSON.stringify(bom), "two builds of one lockfile are identical (no clock, no randomness)");
ok(!JSON.stringify(bom).includes("timestamp"), "no timestamp is written");
ok(purlOf("@s/b", "2.0.0") === "pkg:npm/%40s/b@2.0.0" && byRef.get("pkg:npm/%40s/b@2.0.0")?.group === "@s" && byRef.get("pkg:npm/%40s/b@2.0.0")?.name === "b", "a scoped package carries its group and a percent-encoded purl");
ok(hashesOf("sha512-AAAA")[0]?.alg === "SHA-512" && hashesOf("sha512-AAAA")[0]?.content === "000000" && hashesOf("md5-xx").length === 0, "integrity becomes hex hashes; an unknown algorithm is skipped");
ok(byRef.get("pkg:npm/a@1.2.3")?.licenses?.[0]?.license?.id === "MIT" && byRef.get("pkg:npm/%40s/b@2.0.0")?.licenses?.[0]?.expression === "(MIT OR Apache-2.0)", "a license id and a license expression are told apart");
ok(byRef.get("pkg:npm/t@1.0.0")?.scope === "excluded" && byRef.get("pkg:npm/%40s/b@2.0.0")?.scope === "optional" && byRef.get("pkg:npm/a@1.2.3")?.scope === "required", "dev packages are excluded, optional ones optional, the rest required");
ok(!bom.components.some((c) => c.name === "linked"), "a workspace link is not a component");
ok(resolveFrom(JSON.parse(fixture).packages, "node_modules/a", "c") === "node_modules/a/node_modules/c" && resolveFrom(JSON.parse(fixture).packages, "node_modules/@s/b", "c") === "node_modules/c", "dependencies resolve the way npm nests them");
const deps = new Map(bom.dependencies.map((d) => [d.ref, d.dependsOn]));
ok(deps.get("pkg:npm/a@1.2.3")?.join() === "pkg:npm/c@1.0.0" && deps.get("pkg:npm/%40s/b@2.0.0")?.join() === "pkg:npm/c@2.0.0", "the dependency graph follows nested resolution");
ok(deps.get("pkg:npm/demo@1.0.0")?.length === 3 && bom.metadata.component.name === "demo", "the root lists its direct dependencies, dev included");
const noDev = buildSbom(fixture, { omitDev: true });
ok(!noDev.components.some((c) => c.name === "t") && noDev.components.length === bom.components.length - 1, "--omit-dev leaves out development-only packages");
let threw = false; try { buildSbom(JSON.stringify({ lockfileVersion: 1, dependencies: {} })); } catch { threw = true; }
ok(threw, "a v1 lockfile with no packages map is refused");

// The repository's own lockfile, through the CLI.
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const expected = Object.entries(lock.packages).filter(([p, e]) => p && !e.link && e.version).length;
const r = spawnSync(process.execPath, ["scripts/sbom.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
ok(r.status === 0, `the CLI exits 0 (${r.status}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""})`);
let repo = null; try { repo = JSON.parse(r.stdout); } catch { /* checked below */ }
ok(repo && repo.components.length > 100 && repo.components.length <= expected, `the repository SBOM lists the lockfile's packages (${repo?.components.length} of ${expected} paths)`);
ok(repo && repo.components.every((c) => c.purl && c.version && c.scope), "every component carries a purl, a version and a scope");
const r2 = spawnSync(process.execPath, ["scripts/sbom.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
ok(r2.stdout === r.stdout, "two CLI runs print the same bytes");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
