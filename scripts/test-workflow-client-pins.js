#!/usr/bin/env node
// The workflows install the x402 CLIENT packages with `npm install --no-save
// <pkg>@<version>` at ~19 sites, and those literals drift from package.json:
// 2026-08-29 found 38 sites at 2.16 against a 2.22 server, and 2026-09-18 found
// 19 at 2.22 (and @solana/kit 5) against a 2.26 / kit-8 lock, where the root
// `overrides` would have made the old lines downgrade what npm ci installed.
// Nothing pinned them, so this does: every `<pkg>@<x.y.z>` literal in
// .github/workflows for a package the root package.json declares must equal
// the root's declared version (caret stripped). Standalone package.json files
// that ship examples (scripts/agentkit-live, examples/*) must not name an
// OLDER @x402 major.minor than the root either. Offline, fast.
import { readFileSync, readdirSync, existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const strip = (v) => String(v).replace(/^[\^~]/, "");
const rootDeps = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies || {};
// Every @x402/* package ships at one version, so any @x402 literal (core is
// transitive here and not in package.json) is held to the root's @x402/express;
// @solana/kit and @solana-program/* to their own root rows.
const X402_VERSION = strip(rootDeps["@x402/express"]);
ok(/^\d+\.\d+\.\d+$/.test(X402_VERSION), `root @x402/express declares an exact-looking version (${X402_VERSION})`);
const wantFor = (pkg) => pkg.startsWith("@x402/") ? X402_VERSION : (rootDeps[pkg] ? strip(rootDeps[pkg]) : null);
const TRACKED = Object.keys(rootDeps).filter((k) => k === "@solana/kit" || k.startsWith("@solana-program/"));
ok(TRACKED.length >= 2, `tracks @x402/* plus ${TRACKED.length} Solana client packages from package.json (${TRACKED.join(", ")})`);

// Workflows: literal pins.
const wfDir = join(root, ".github", "workflows");
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const re = new RegExp(`(@x402/[a-z0-9-]+|${TRACKED.map(escapeRe).join("|")})@(\\d+\\.\\d+\\.\\d+)`, "g");
const drift = [];
let seen = 0;
for (const f of readdirSync(wfDir).filter((f) => f.endsWith(".yml"))) {
  const text = readFileSync(join(wfDir, f), "utf8");
  for (const m of text.matchAll(re)) {
    seen++;
    const want = wantFor(m[1]);
    if (want && m[2] !== want) drift.push(`${f}: ${m[1]}@${m[2]} (package.json says ${want})`);
  }
}
ok(seen >= 10, `found ${seen} client pin literals across the workflows (a scan that sees none is broken)`);
ok(drift.length === 0, `every workflow client pin equals package.json${drift.length ? `:\n    ${drift.join("\n    ")}` : ""}`);

// Standalone package.json files: not behind the root on @x402 major.minor.
const mm = (v) => strip(v).split(".").slice(0, 2).map(Number);
const behind = [];
const standalone = [join(root, "scripts", "agentkit-live", "package.json"), ...(existsSync(join(root, "examples")) ? readdirSync(join(root, "examples")).map((d) => join(root, "examples", d, "package.json")) : [])].filter(existsSync);
for (const p of standalone) {
  const deps = { ...(JSON.parse(readFileSync(p, "utf8")).dependencies || {}) };
  for (const [k, v] of Object.entries(deps)) {
    if (!k.startsWith("@x402/")) continue;
    const [ra, rb] = mm(X402_VERSION); const [a, b] = mm(v);
    if (a < ra || (a === ra && b < rb)) behind.push(`${p.replace(root + "/", "")}: ${k} ${v} (root ${X402_VERSION})`);
  }
}
ok(standalone.length >= 2, `checked ${standalone.length} standalone package.json files`);
ok(behind.length === 0, `no standalone example pins an @x402 minor behind the root${behind.length ? `:\n    ${behind.join("\n    ")}` : ""}`);

// Standalone lockfiles: every one `npm ci` can install from its package.json.
// agentkit-live.yml copies its pair into a scratch dir and runs `npm ci`, and
// a reader installs an example the same way; npm refuses a lockfile whose
// entries do not cover every declared dependency, so a lock edited by hand or
// by a bot that drops a nested copy breaks at install. An offline dry run on
// a scratch copy of the pair (no node_modules, no registry, no audit) makes
// the same check here; it needs the pair only, never the tree.
const desynced = [];
let locked = 0;
for (const p of standalone) {
  const lock = join(p, "..", "package-lock.json");
  if (!existsSync(lock)) continue;
  locked++;
  const dir = mkdtempSync(join(tmpdir(), "lock-sync-"));
  try {
    copyFileSync(p, join(dir, "package.json"));
    copyFileSync(lock, join(dir, "package-lock.json"));
    // A dry run reads the registry only for metadata a lock entry does not carry
    // (a peer range, for one), so it is not run offline; a desynced lock still fails.
    const r = spawnSync("npm", ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) desynced.push(`${lock.replace(root + "/", "")}: ${(r.stderr || "").split("\n").filter((l) => /Missing|Invalid|in sync/.test(l)).slice(0, 4).join(" | ") || `exit ${r.status}`}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
ok(locked >= 2, `checked ${locked} standalone lockfiles against their package.json`);
ok(desynced.length === 0, `every standalone lockfile installs with npm ci${desynced.length ? `:\n    ${desynced.join("\n    ")}` : ""}`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
