// Every offline suite pins its own backends before any src/ module reads the
// environment: its first import statement is ./lib/offline-stores.js (or the
// older ./lib/file-mode.js, which clears the same variables).
//
// Why: several modules choose a backend once, at import (REDIS_URL, the state
// database, the Redis journals). A suite written against the per-process and
// file backends that lacks the pin fails, hangs, or writes its fixtures into a
// shared database whenever the developer's shell exports one of them, while CI
// (which exports none in an offline step) stays green. See
// scripts/lib/offline-stores.js.
//
// A suite is offline unless it is meant to run on a real store:
//   - a workflow step that runs it sets STATE_DATABASE_URL or REDIS_URL,
//   - its name ends -pg.js or -redis.js,
//   - it calls requireTestPg (scripts/lib/test-pg.js) or refuses to run
//     without REDIS_URL.
// A suite that touches no src/ module (statically, dynamically, or by booting
// src/server.js) needs no pin.
//
// Static check only; offline; no server.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandWorkflow } from "./lib/ci-workflow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const PIN_RE = /^\s*import\s+["']\.\/lib\/(offline-stores|file-mode)\.js["']/;

// A src/ module reached from the suite: a static or dynamic import, a spawned
// src/ entry point, or a path built from "src".
const SRC_USE_RES = [
  /\bfrom\s+["'`]\.\.\/src\//,
  /\bimport\s+["'`]\.\.\/src\//,
  /\bimport\s*\(\s*["'`][^"'`]*\.\.\/src\//,
  /["'`](?:\.\.\/|\.\/)?src\/[\w./-]+\.(?:m?js)["'`]/,
  /\bjoin\([^)]*["'`]src["'`]/,
  /\bimport\s*\(\s*(?:new URL\()?\s*["'`][^"'`]*src\//,
];

export function usesSrc(text) {
  return SRC_USE_RES.some((re) => re.test(text));
}

// The first static import statement in the file (a column-0 `import`, single
// or multi-line), or null when it has none. ES modules evaluate their imports in
// order, so the pin must be this one: a builtin or a package listed above it is
// harmless today and is not where a later edit should have to look.
export function firstImport(text) {
  for (const line of text.split("\n")) {
    if (/^import[\s{*"']/.test(line)) return line;
  }
  return null;
}

export function pinnedFirst(text) {
  const line = firstImport(text);
  return line != null && PIN_RE.test(line);
}

// Scripts named in a workflow step whose env sets a real store.
export function storeStepScripts(yamlText) {
  const out = new Set();
  const lines = yamlText.split("\n");
  let step = [];
  const flush = () => {
    const body = step.join("\n");
    if (/^\s*(STATE_DATABASE_URL|REDIS_URL)\s*:\s*\S/m.test(body) && !/^\s*(STATE_DATABASE_URL|REDIS_URL)\s*:\s*["']{2}\s*$/m.test(body)) {
      for (const m of body.matchAll(/scripts\/(test-[\w.-]+\.js)/g)) out.add(m[1]);
    }
    step = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+(name|uses|run)\s*:/.test(line) || /^\s{2}[\w-]+:\s*$/.test(line)) flush();
    step.push(line);
  }
  flush();
  return out;
}

export function realStoreSuite(name, text, storeSteps) {
  if (/-(pg|redis)\.js$/.test(name)) return "name";
  if (storeSteps.has(name)) return "workflow step sets a store";
  if (/\brequireTestPg\s*\(/.test(text)) return "requireTestPg";
  if (/if\s*\(\s*!\s*process\.env\.REDIS_URL\b[^)]*\)[^;\n]*(process\.exit|throw|SKIP|FAIL)/.test(text)) return "requires REDIS_URL";
  return null;
}

// A pinned suite that re-runs itself in a child with a store variable of its
// own choosing must say so (OFFLINE_STORES_KEEP), or the child's pin drops it.
const SELF_SPAWN_RE = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath\s*,\s*\[\s*(?:fileURLToPath\(import\.meta\.url\)|process\.argv\[1\])/;
const STORE_SET_RE = /\b(?:REDIS_URL|STATE_DATABASE_URL|LEDGER_JOURNAL_REDIS)\s*:\s*["'`][^"'`]/;
export function dropsOwnChildStore(text) {
  return SELF_SPAWN_RE.test(text) && STORE_SET_RE.test(text) && !/\bOFFLINE_STORES_KEEP\b/.test(text);
}

export function violations({ scriptsDir = SCRIPTS, workflowsDir = WORKFLOWS } = {}) {
  const storeSteps = new Set();
  for (const f of readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    // deploy.yml's test lists live in scripts/ci/lanes; read them in their steps.
    const text = readFileSync(join(workflowsDir, f), "utf8");
    for (const s of storeStepScripts(f === "deploy.yml" ? expandWorkflow(text).text : text)) storeSteps.add(s);
  }
  const bad = [], keepless = [];
  let offline = 0;
  for (const name of readdirSync(scriptsDir).sort()) {
    if (!/^test-.*\.(m?js)$/.test(name)) continue;
    const text = readFileSync(join(scriptsDir, name), "utf8");
    if (!usesSrc(text)) continue;
    if (realStoreSuite(name, text, storeSteps)) continue;
    offline++;
    if (!pinnedFirst(text)) bad.push(name);
    else if (dropsOwnChildStore(text)) keepless.push(name);
  }
  return { bad, offline, keepless };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let failed = 0;
  const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };

  // The rules read themselves right on fixtures before they read the tree.
  check(pinnedFirst(`#!/usr/bin/env node\n// why\nimport "./lib/offline-stores.js"; // x\nimport { a } from "../src/a.js";\n`), "a pin as the first import counts");
  check(!pinnedFirst(`import assert from "node:assert";\nimport "./lib/offline-stores.js";\nimport { a } from "../src/a.js";\n`), "a pin after a builtin import does not count");
  check(!pinnedFirst(`import {\n  a,\n} from "../src/a.js";\nimport "./lib/offline-stores.js";\n`), "a multi-line import above the pin is caught");
  check(!pinnedFirst(`import { a } from "../src/a.js";\nimport "./lib/offline-stores.js";\n`), "a pin after a src/ import does not count");
  check(!pinnedFirst(`import { b } from "./lib/own-stores.js";\nimport "./lib/offline-stores.js";\n`), "a pin after another local import does not count");
  check(!pinnedFirst(`import assert from "node:assert";\nconst m = await import("../src/a.js");\n`), "a dynamic src/ import with no pin is caught");
  check(usesSrc(`const m = await import("../src/a.js");`), "a dynamic src/ import is a src/ use");
  check(usesSrc(`spawn(process.execPath, ["src/server.js"], { env })`), "booting src/server.js is a src/ use");
  check(!usesSrc(`import { readFileSync } from "node:fs";\nreadFileSync("README.md");`), "a file read alone is not a src/ use");
  check(realStoreSuite("test-x-pg.js", "", new Set()) === "name", "a -pg suite is a real-store suite");
  check(realStoreSuite("test-x.js", "requireTestPg({ label })", new Set()) === "requireTestPg", "requireTestPg marks a real-store suite");
  check(realStoreSuite("test-x.js", "", new Set(["test-x.js"])) != null, "a store step's suite is a real-store suite");
  check(realStoreSuite("test-x.js", "", new Set()) === null, "anything else is offline");
  const yml = [
    "      - name: offline",
    "        run: node scripts/test-a.js",
    "      - name: store",
    "        env:",
    "          REDIS_URL: redis://127.0.0.1:6379",
    "        run: |",
    "          t node scripts/test-b.js",
    "      - name: after",
    "        run: node scripts/test-c.js",
  ].join("\n");
  const ss = storeStepScripts(yml);
  check(ss.has("test-b.js") && !ss.has("test-a.js") && !ss.has("test-c.js"), "only the step that sets a store exempts its scripts");

  check(dropsOwnChildStore(`spawnSync(process.execPath, [fileURLToPath(import.meta.url), "shared"], { env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1" } })`), "a self-spawn that sets REDIS_URL without OFFLINE_STORES_KEEP is caught");
  check(!dropsOwnChildStore(`spawnSync(process.execPath, [fileURLToPath(import.meta.url), "shared"], { env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1", OFFLINE_STORES_KEEP: "REDIS_URL" } })`), "...and passes when the child is told to keep it");
  check(!dropsOwnChildStore(`spawnSync(process.execPath, [fileURLToPath(import.meta.url), "geo"], { env: { ...process.env, REDIS_URL: "" } })`), "a self-spawn that clears REDIS_URL needs nothing");

  // The pin itself, run: a child with every store variable exported drops them
  // all, and one told to keep REDIS_URL keeps only that (and not the list).
  const pinUrl = new URL("./lib/offline-stores.js", import.meta.url).href;
  const probe = `await import(${JSON.stringify(pinUrl)}); console.log(JSON.stringify(["REDIS_URL", "STATE_DATABASE_URL", "STATE_DATABASE_URL_FOR_TEST", "LEDGER_JOURNAL_REDIS", "OFFLINE_STORES_KEEP"].filter((k) => k in process.env)));`;
  const exported = { REDIS_URL: "redis://127.0.0.1:1", STATE_DATABASE_URL: "postgres://127.0.0.1:1/x", STATE_DATABASE_URL_FOR_TEST: "postgres://127.0.0.1:1/x", LEDGER_JOURNAL_REDIS: "on" };
  const left = (extra) => { const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, ...exported, ...extra }, encoding: "utf8" }); return (r.stdout || "").trim(); };
  check(left({}) === "[]", `the pin clears every exported store variable (left: ${left({})})`);
  check(left({ OFFLINE_STORES_KEEP: "REDIS_URL" }) === '["REDIS_URL"]', `OFFLINE_STORES_KEEP keeps only what it names (left: ${left({ OFFLINE_STORES_KEEP: "REDIS_URL" })})`);

  const { bad, offline, keepless } = violations();
  check(offline > 100, `read ${offline} offline suites that reach src/`);
  check(bad.length === 0, bad.length ? `offline suites without ./lib/offline-stores.js as their first import: ${bad.join(", ")}` : "every offline suite pins its stores first");
  check(keepless.length === 0, keepless.length ? `suites that re-run themselves with a store variable the child's pin drops (add OFFLINE_STORES_KEEP): ${keepless.join(", ")}` : "every self-spawned child keeps the store variable its parent chose");
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall offline-stores import checks passed");
}
