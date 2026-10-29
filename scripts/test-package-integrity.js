#!/usr/bin/env node
// Integrity gate for EVERY publishable package in this repo.
//
// WHY: two distinct bugs shipped to npm because our tests examined the SOURCE
// TREE instead of the artifact a user actually installs.
//
//  1. agent402-mcp imported networks.js, which was missing from package.json's
//     `files` allowlist. npm shipped a tarball without it, so 0.11.0-0.12.2
//     threw ERR_MODULE_NOT_FOUND on the first import for 27 days. Every test
//     passed, because the working tree HAS the file.
//  2. Four adapters declared `agent402-client: ^0.1.0`. On a 0.x version that
//     caret allows only 0.1.x, so npm resolved the FIRST ever client release
//     while the current one was 0.6.3. CI never noticed because the adapter
//     step installs the local client (`npm install ../../client`), testing a
//     dependency graph no published user ever gets.
//
// So this file asserts things about the PACKAGE MANIFEST and the RESOLUTION a
// user would get, not about our checkout:
//   * every relative import of an entry point is inside `files`
//   * every `files` entry actually exists
//   * no dependency range on a sibling workspace package excludes that
//     package's current local version
//
// Offline: manifest and filesystem reads only. scripts/test-mcp-package.js is
// the heavier companion that packs, installs and handshakes the mcp tarball.
//
//   node scripts/test-package-integrity.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

/** Every directory in the repo that publishes to npm. */
function publishableDirs() {
  // facilitator was missing here until 2026-08-14: its own files allowlist
  // didn't list a new sibling module (timeout.js) that its entry point
  // imports, the exact class of bug (1) in the header comment above - this
  // gate simply never looked at that package at all.
  const dirs = ["mcp", "client", "tollbooth", "facilitator"];
  const adapters = join(ROOT, "adapters");
  if (existsSync(adapters)) {
    for (const name of readdirSync(adapters)) {
      if (existsSync(join(adapters, name, "package.json"))) dirs.push(join("adapters", name));
    }
  }
  return dirs.filter((d) => existsSync(join(ROOT, d, "package.json")));
}

const dirs = publishableDirs();
ok(dirs.length >= 10, `found the publishable packages (${dirs.length})`);

// Local versions of our own packages, so a sibling dependency range can be
// checked against what we actually ship rather than against the registry.
const localVersions = new Map();
for (const d of dirs) {
  const pkg = JSON.parse(readFileSync(join(ROOT, d, "package.json"), "utf8"));
  if (pkg.name && pkg.version) localVersions.set(pkg.name, pkg.version);
}

/** Does `range` admit `version`? Handles the forms we actually use: exact,
 *  ^x.y.z, ~x.y.z, >=a <b, and *. Deliberately strict: anything it cannot
 *  parse is reported rather than assumed fine. */
function rangeAdmits(range, version) {
  const v = version.split(".").map(Number);
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  const r = String(range).trim();
  if (r === "*" || r === "latest" || r.startsWith("file:") || r.startsWith("workspace:")) return true;
  const compound = r.match(/^>=\s*([\d.]+)\s+<\s*([\d.]+)$/);
  if (compound) {
    return cmp(v, compound[1].split(".").map(Number)) >= 0 && cmp(v, compound[2].split(".").map(Number)) < 0;
  }
  const caret = r.match(/^\^([\d.]+)$/);
  if (caret) {
    const b = caret[1].split(".").map(Number);
    if (cmp(v, b) < 0) return false;
    // ^0.y.z allows only 0.y.*; ^x.y.z (x>0) allows x.*.*
    return b[0] === 0 ? v[0] === 0 && v[1] === b[1] : v[0] === b[0];
  }
  const tilde = r.match(/^~([\d.]+)$/);
  if (tilde) {
    const b = tilde[1].split(".").map(Number);
    return cmp(v, b) >= 0 && v[0] === b[0] && v[1] === b[1];
  }
  if (/^[\d.]+$/.test(r)) return r === version;
  return null; // unparsed
}

/** Direct `./relative` imports (static or dynamic) out of a single file's source. */
function directImports(filePath) {
  if (!existsSync(filePath)) return [];
  const body = readFileSync(filePath, "utf8");
  return [...new Set([
    ...[...body.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]),
    ...[...body.matchAll(/import\("\.\/([^"]+)"\)/g)].map((m) => m[1]),
  ])];
}

/** Every local file reachable from `entryFile` by following relative imports
 *  transitively (not just the entry point's own direct imports) - a future
 *  file importing a second new sibling two hops deep must still be caught. */
function transitiveLocalImports(dir, entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const imp of directImports(join(ROOT, dir, f))) {
      if (!seen.has(imp)) queue.push(imp);
    }
  }
  seen.delete(entryFile);
  return [...seen];
}

for (const d of dirs) {
  const pkg = JSON.parse(readFileSync(join(ROOT, d, "package.json"), "utf8"));
  const name = pkg.name || d;
  const files = new Set(pkg.files || []);
  const main = pkg.main || "index.js";

  // --- the tarball must contain everything the entry point imports -----------
  if (files.size) {
    const missing = directImports(join(ROOT, d, main)).filter((i) => !files.has(i) && i !== main);
    ok(missing.length === 0, `${name}: entry-point imports are all in files${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    // --- and everything files promises must exist ---------------------------
    const ghosts = [...files].filter((f) => !f.includes("*") && !existsSync(join(ROOT, d, f)));
    ok(ghosts.length === 0, `${name}: every files entry exists${ghosts.length ? ` (absent: ${ghosts.join(", ")})` : ""}`);
  }

  // --- a sibling dependency range must admit the version we ship ------------
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[field] || {})) {
      if (!localVersions.has(dep)) continue;
      const current = localVersions.get(dep);
      const admits = rangeAdmits(range, current);
      ok(admits === true,
        `${name}: ${field}.${dep} "${range}" admits the version we ship (${current})${admits === null ? " [unparsed range - tighten this test]" : ""}`);
    }
  }

  // --- a package that hands the client a userAgent needs a client that reads
  // it: agent402-client takes the option from 0.8.21, so the range's floor
  // must exclude every earlier client (one would silently drop the token).
  const clientRange = pkg.dependencies?.["agent402-client"];
  const passesUserAgent = existsSync(join(ROOT, d, main)) && /\buserAgent\s*:/.test(readFileSync(join(ROOT, d, main), "utf8"));
  if (clientRange && passesUserAgent) {
    ok(rangeAdmits(clientRange, "0.8.20") === false && rangeAdmits(clientRange, "0.8.21") === true,
      `${name}: passes userAgent, so its agent402-client range "${clientRange}" starts at 0.8.21`);
  }
}

// --- facilitator/ ALSO ships as a Docker image with its own, separate file
// manifest - Dockerfile.facilitator's explicit COPY list, distinct from
// package.json's `files` (which only governs the npm tarball). A real
// deploy broke on this exact gap (2026-08-14): timeout.js was added to
// `files` and imported from index.js, but Dockerfile.facilitator's COPY
// line was never updated, so the built image threw ERR_MODULE_NOT_FOUND on
// boot - caught only by the actual Railway deploy failing, not by CI, not
// by this file (which didn't look at the Dockerfile at all). No other
// package in this repo has this shape: the main Dockerfile/Dockerfile.worker
// COPY whole directories (src/), so an added file is included automatically
// - this per-file COPY list is unique to facilitator's minimal image and so
// is this check.
{
  const dockerfilePath = join(ROOT, "Dockerfile.facilitator");
  if (existsSync(dockerfilePath)) {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    // Plain string splitting, not a single combined regex: CodeQL flagged the
    // prior version (nested \S+\s* quantifiers inside a repeated group) as
    // vulnerable to exponential backtracking. Splitting on whitespace in JS
    // has no backtracking at all, and is simpler besides.
    const copiedFiles = new Set(
      [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
        .flatMap((m) => m[1].trim().split(/\s+/))
        .filter((tok) => tok.startsWith("facilitator/"))
        .map((f) => f.replace(/^facilitator\//, "")),
    );
    ok(copiedFiles.size > 0, `Dockerfile.facilitator: found at least one COPY of a facilitator/ file (got ${copiedFiles.size})`);
    const needed = transitiveLocalImports("facilitator", "index.js");
    const missingFromImage = needed.filter((f) => !copiedFiles.has(f));
    ok(missingFromImage.length === 0,
      `Dockerfile.facilitator: every local module index.js imports (transitively) is COPYd into the image${missingFromImage.length ? ` (missing: ${missingFromImage.join(", ")})` : ""}`);
  }
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
