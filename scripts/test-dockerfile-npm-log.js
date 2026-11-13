#!/usr/bin/env node
// Both images (Dockerfile, Dockerfile.worker) install with `npm ci`, and a
// failed install must say why in the build log: the dependency step prints
// the tail of npm's debug log and the build still fails with npm's own exit
// code. A success prints nothing extra and goes on to the rest of the step.
//
// The install group is read out of each Dockerfile and run under /bin/sh
// (the shell Docker's RUN uses) with a stub `npm` on PATH that writes a debug
// log where npm does ($HOME/.npm/_logs) and exits with a chosen code.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

/** The RUN instructions of a Dockerfile, continuation lines joined and comment lines dropped. */
function runInstructions(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (cur !== null && /^\s*#/.test(line)) continue;
    if (cur === null) {
      if (!/^RUN\s/.test(line)) continue;
      cur = line.replace(/^RUN\s+/, "");
    } else cur += ` ${line.trim()}`;
    if (cur.endsWith("\\")) { cur = cur.slice(0, -1).trimEnd(); continue; }
    out.push(cur);
    cur = null;
  }
  return out;
}

/** The install group: the leading `{ npm ci ... }` of the RUN that installs. */
function installGroup(run) {
  if (!run.startsWith("{ npm ci ")) return null;
  let depth = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return run.slice(0, i + 1);
  }
  return null;
}

function runGroup(group, npmExit) {
  const dir = mkdtempSync(join(tmpdir(), "a402-npm-log-"));
  try {
    const bin = join(dir, "bin"), home = join(dir, "home");
    mkdirSync(bin); mkdirSync(home);
    writeFileSync(join(bin, "npm"), [
      "#!/bin/sh",
      'mkdir -p "$HOME/.npm/_logs"',
      `echo "0 verbose cli npm stub" > "$HOME/.npm/_logs/2026-01-01T00_00_00_000Z-debug-0.log"`,
      `echo "1 error code ESTUB_FAILURE_MARKER" >> "$HOME/.npm/_logs/2026-01-01T00_00_00_000Z-debug-0.log"`,
      `exit ${npmExit}`,
    ].join("\n") + "\n");
    chmodSync(join(bin, "npm"), 0o755);
    const r = spawnSync("/bin/sh", ["-c", `${group} && echo AFTER_INSTALL`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: "utf8", timeout: 20_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const df of ["Dockerfile", "Dockerfile.worker"]) {
  const runs = runInstructions(readFileSync(join(ROOT, df), "utf8")).filter((r) => /\bnpm ci\b/.test(r));
  ok(runs.length === 1, `${df} has one RUN that runs npm ci (${runs.length})`);
  const group = runs[0] ? installGroup(runs[0]) : null;
  ok(!!group && /npm ci --omit=dev/.test(group), `${df} installs inside a group that handles a failed npm ci (${(group || runs[0] || "").slice(0, 80)})`);
  if (!group) continue;
  const bad = runGroup(group, 7);
  ok(bad.code === 7, `${df}: a failed npm ci fails the step with npm's exit code (${bad.code})`);
  ok(/ESTUB_FAILURE_MARKER/.test(bad.out), `${df}: a failed npm ci prints npm's debug log`);
  ok(!/AFTER_INSTALL/.test(bad.out), `${df}: nothing after the install runs when it fails`);
  const good = runGroup(group, 0);
  ok(good.code === 0 && /AFTER_INSTALL/.test(good.out), `${df}: a clean npm ci goes on to the rest of the step (${good.code})`);
  ok(!/ESTUB_FAILURE_MARKER|npm ci failed/.test(good.out), `${df}: a clean npm ci prints no log`);
}

console.log(`test-dockerfile-npm-log: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
