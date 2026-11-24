#!/usr/bin/env node
// Every npm package the publish job ships carries TypeScript declarations a
// strict TypeScript project can import, and they describe what the package
// exports. For each package (scripts/lib/published-packages.js):
//   1. package.json names "types" and a "types" condition on every exports
//      subpath, and each declaration file it names is in "files";
//   2. a consumer file importing every subpath by the package's own name
//      compiles under strict, module and moduleResolution nodenext, against
//      the package as installed (a node_modules link in a temporary folder,
//      symlinks preserved, so it resolves only what a buyer's install would);
//   3. every name the runtime module exports is declared as a value, and
//      every declared value is exported at runtime (the runtime names are
//      read from the source's export statements, so the check needs none of
//      the package's peers; the declared ones are `keyof typeof` the module
//      in a compiled file, whose two lines fail and name the difference);
//   4. per package, a misuse the declarations must reject (a wrong option
//      type) fails to compile, so a declaration that collapsed to `any`
//      fails here.
// Every compile is the typescript package's own `tsc` CLI (the package
// exports no compiler API since 7.0), run by this node with --noEmit on a
// tsconfig written per consumer; diagnostics are read by file and line.
// elizaos-plugin-agent402's declarations import its host's @elizaos/core,
// which an Eliza project always has and this repository does not install;
// it gets checks 1 and 3 only. agent402-tollbooth's root and ./edge are
// typed; its other subpaths (the Worker entry, the replay stores, the MPP
// helpers, the dashboard and sinks) are listed in UNTYPED_SUBPATHS, and a
// subpath any package adds outside that list must ship declarations.
//   node scripts/test-package-types.js
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedPackageDirs } from "./lib/published-packages.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The compiler is the pinned devDependency's own bin.
const require = createRequire(import.meta.url);
const TS_PKG = require.resolve("typescript/package.json");
const TSC = join(dirname(TS_PKG), JSON.parse(readFileSync(TS_PKG, "utf8")).bin.tsc);

const HOST_TYPED = new Set(["adapters/eliza"]);
const UNTYPED_SUBPATHS = { tollbooth: ["./worker", "./worker.js", "./dashboard.js", "./sinks.js", "./replay", "./replay.js", "./mpp", "./mpp.js", "./edge-mpp", "./edge-mpp.js", "./mpp-codec.js"] };
// A call each package's declarations must refuse (check 4).
const MISUSE = {
  "client": `new m.Agent402({ baseUrl: 42 });`,
  "tollbooth": `m.createTollbooth({ mode: 42 });`,
  "openclaw": `m.selectAccept("not a list");`,
  "adapters/openai-tools": `m.agent402Tools({ slugs: "hash" });`,
  "adapters/anthropic-tools": `m.agent402Tools({ freeOnly: "yes" });`,
  "adapters/ai-sdk": `m.agent402ToolSpecs({ maxPerCallUsd: {} });`,
  "adapters/langchain": `m.agent402ToolSpecs({ dailyLimitUsd: [2] });`,
  "adapters/openai-agents": `m.agent402ToolSpecs({ baseUrl: 1 });`,
  "adapters/llamaindex": `m.agent402Execute({ maxPerHostUsd: {} });`,
  "adapters/strands": `m.agent402Tools({ slugs: [1] });`,
  "adapters/google-adk": `m.agent402ToolSpecs({ fetch: "x" });`,
  "adapters/agentkit": `m.agent402Actions({ payees: "0xabc" });`,
};

/** Names a JS module exports, read from its export statements. */
function runtimeExports(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const src = readFileSync(file, "utf8");
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  if (/^export\s+default\b/m.test(src)) out.add("default");
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = /\s+as\s+([\w$]+)$/.exec(t);
      out.add(as ? as[1] : t);
    }
  }
  for (const m of src.matchAll(/^export\s*\*\s*from\s*["']([^"']+)["']/gm)) {
    for (const n of runtimeExports(join(dirname(file), m[1]), seen)) if (n !== "default") out.add(n);
  }
  return out;
}

{
  const rt = runtimeExports(join(ROOT, "openclaw/index.js"));
  ok(["acceptUsd", "KNOWN_ASSETS", "resolvePayFetch", "plugin", "buildProvider", "startProxy", "default"].every((n) => rt.has(n)), `control: the export reader sees each export form (${rt.size} names in openclaw/index.js)`);
}
const dirs = publishedPackageDirs();
ok(dirs.length >= 14, `the publish job's packages are read (${dirs.length})`);
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "a402-types-")));

const BASE_OPTIONS = {
  strict: true, noEmit: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext",
  preserveSymlinks: true, skipLibCheck: false, types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")], lib: ["es2022", "dom"],
  pretty: false,
};
/**
 * Compiles `files` with tsc --noEmit -p <a tsconfig written for them>.
 * Returns { status, diags: [{ file, line, text }] } (file relative to tmp).
 */
function compile(name, files, extra = {}) {
  const config = join(tmp, `tsconfig.${name}.json`);
  writeFileSync(config, JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, ...extra }, files }, null, 2));
  const r = spawnSync(process.execPath, [TSC, "-p", config, "--noEmit", "--pretty", "false"], { cwd: tmp, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const diags = [];
  for (const raw of `${r.stdout || ""}${r.stderr || ""}`.split("\n")) {
    const m = /^(.+?)\((\d+),\d+\): (?:error|warning) (TS\d+: .*)$/.exec(raw);
    if (m) diags.push({ file: resolve(tmp, m[1]).replace(tmp + "/", "").replace(ROOT, ""), line: Number(m[2]), text: m[3] });
    else if (/^error TS\d+/.test(raw)) diags.push({ file: "", line: 0, text: raw });
    else if (raw.trim() && diags.length) diags[diags.length - 1].text += ` ${raw.trim()}`;
  }
  return { status: r.status, error: r.error, diags };
}
const show = (d) => `${d.file}:${d.line} ${d.text}`;

try {
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "types-consumer", private: true, type: "module" }));
  // control: the CLI runs, refuses a known error on the line it is on, and
  // its output is read (so every "it compiled" below is a real compile).
  {
    writeFileSync(join(tmp, "control-ok.ts"), `export const n: number = 1;\n`);
    writeFileSync(join(tmp, "control-bad.ts"), `export const a = 1;\nexport const n: number = "one";\n`);
    const good = compile("control-ok", ["control-ok.ts"]);
    const bad = compile("control-bad", ["control-bad.ts"]);
    const version = (spawnSync(process.execPath, [TSC, "--version"], { encoding: "utf8" }).stdout || "").trim();
    ok(!good.error && good.status === 0 && good.diags.length === 0, `control: ${version || "tsc"} compiles a clean file (exit ${good.status})`);
    ok(bad.status !== 0 && bad.diags.length === 1 && bad.diags[0].file === "control-bad.ts" && bad.diags[0].line === 2 && /TS2322/.test(bad.diags[0].text), `control: tsc refuses a wrong type and its diagnostic is read at control-bad.ts:2 (${bad.diags.map(show).join("; ") || "none"})`);
  }

  const nm = join(tmp, "node_modules");
  mkdirSync(nm);
  const pkgs = dirs.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) }));
  for (const { dir, pkg } of pkgs) {
    const target = join(nm, ...pkg.name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(ROOT, dir), target, "dir");
  }
  const consumer = [];
  const parity = [];
  for (const { dir, pkg } of pkgs) {
    // 1. the manifest
    ok(typeof pkg.types === "string" && existsSync(join(ROOT, dir, pkg.types)), `${pkg.name}: package.json names its declarations (${pkg.types ?? "none"})`);
    // A package with no exports map (a bin first, such as agent402-mcp)
    // is resolved through "types" alone.
    const exp = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : { ".": { types: pkg.types, default: pkg.main || "./index.js" } };
    const untyped = UNTYPED_SUBPATHS[dir] || [];
    const subpaths = Object.keys(exp).filter((k) => k.startsWith(".") && !untyped.includes(k));
    for (const u of untyped) ok(u in exp && !(exp[u] && typeof exp[u] === "object" && exp[u].types), `${pkg.name}: ${u} is still an untyped subpath (remove it from UNTYPED_SUBPATHS once typed)`);
    for (const sp of subpaths) {
      const entry = exp[sp];
      const types = entry && typeof entry === "object" ? entry.types : null;
      const runtime = entry && typeof entry === "object" ? (entry.default || entry.import) : entry;
      ok(typeof types === "string" && existsSync(join(ROOT, dir, types)), `${pkg.name}: exports["${sp}"] has a types condition (${types ?? "none"})`);
      const inFiles = (f) => (pkg.files || []).some((x) => x === f.replace(/^\.\//, "") || x === f);
      if (typeof types === "string") ok(inFiles(types), `${pkg.name}: ${types} is in "files"`);
      const spec = sp === "." ? pkg.name : `${pkg.name}${sp.slice(1)}`;
      // 3. runtime exports and declared values agree: line 4 fails naming
      // the undeclared runtime names, line 5 the declared values missing at
      // runtime. The declarations are read through the types condition, so
      // the file compiled is the one the manifest names.
      if (typeof types === "string" && typeof runtime === "string" && existsSync(join(ROOT, dir, types))) {
        const rt = [...runtimeExports(join(ROOT, dir, runtime))];
        const f = `parity-${parity.length}.ts`;
        const union = rt.length ? rt.map((n) => JSON.stringify(n)).join(" | ") : "never";
        writeFileSync(join(tmp, f), [
          `import * as m from "${spec}";`,
          `type Declared = keyof typeof m;`,
          `type Runtime = ${union};`,
          `export const undeclared: [Exclude<Runtime, Declared>] extends [never] ? true : { undeclared: Exclude<Runtime, Declared> } = true;`,
          `export const phantom: [Exclude<Declared, Runtime>] extends [never] ? true : { missing: Exclude<Declared, Runtime> } = true;`,
          "",
        ].join("\n"));
        parity.push({ dir, f, label: `${pkg.name}${sp === "." ? "" : sp.slice(1)}`, count: rt.length });
      }
      if (!HOST_TYPED.has(dir)) consumer.push({ dir, name: pkg.name, spec });
    }
  }

  // 3. One compile per package for its parity files. Library checking is
  // skipped here (as the strict consumer below does not): a host-typed
  // package's declarations import a host this repository does not install.
  for (const d of [...new Set(parity.map((p) => p.dir))]) {
    const mine = parity.filter((p) => p.dir === d);
    const { diags, error } = compile(`parity-${d.replace(/\W/g, "_")}`, mine.map((p) => p.f), { skipLibCheck: true });
    for (const p of mine) {
      const own = diags.filter((x) => x.file === p.f);
      const at = (line) => own.filter((x) => x.line === line);
      ok(!error && own.every((x) => x.line !== 1), `${p.label}: its declarations resolve by the package's own name${own.length && !own.every((x) => x.line !== 1) ? `: ${show(at(1)[0])}` : ""}`);
      ok(!error && at(4).length === 0, `${p.label}: every runtime export is declared (${p.count})${at(4).length ? `; ${at(4).map((x) => x.text).join(" ")}` : ""}`);
      ok(!error && at(5).length === 0, `${p.label}: every declared value exists at runtime${at(5).length ? `; ${at(5).map((x) => x.text).join(" ")}` : ""}`);
      const other = own.filter((x) => ![1, 4, 5].includes(x.line));
      ok(other.length === 0, `${p.label}: its parity file has no other error${other.length ? `: ${show(other[0])}` : ""}`);
    }
  }

  // 2. one strict consumer per package; 4. its misuse must not compile.
  const good = [];
  for (const [i, c] of consumer.entries()) {
    const f = `use-${i}.ts`;
    writeFileSync(join(tmp, f), `import * as m from "${c.spec}";\nexport const names: string[] = Object.keys(m);\n`);
    good.push({ ...c, f });
  }
  let consumers = 0;
  for (const d of [...new Set(good.map((g) => g.dir))]) {
    const mine = good.filter((g) => g.dir === d);
    const { diags, status, error } = compile(`use-${d.replace(/\W/g, "_")}`, mine.map((g) => g.f));
    consumers += mine.length;
    ok(!error && status === 0 && diags.length === 0, `${mine[0].name}: ${mine.length} strict nodenext consumer(s) compile against the package as installed${diags.length ? `:\n  ${diags.slice(0, 12).map(show).join("\n  ")}` : status !== 0 ? ` (tsc exit ${status})` : ""}`);
  }
  ok(consumers >= 13, `${consumers} strict nodenext consumers compiled across the packages`);
  for (const [dir, line] of Object.entries(MISUSE)) {
    const c = consumer.find((x) => x.dir === dir && !x.spec.includes("/", x.name.length));
    if (!c) { ok(false, `${dir}: has a consumer for its misuse check`); continue; }
    const f = `misuse-${dir.replace(/\W/g, "_")}.ts`;
    writeFileSync(join(tmp, f), `import * as m from "${c.spec}";\n${line}\n`);
    const { diags: d, status } = compile(`misuse-${dir.replace(/\W/g, "_")}`, [f]);
    // Every error is on the misuse line (2): an import that failed would be on line 1.
    const onLine = d.length > 0 && d.every((x) => x.file === f && x.line === 2);
    ok(status !== 0 && onLine, `${c.name}: the declarations refuse a misuse (${line.trim()})${d.length ? (onLine ? "" : `: an error off the misuse line: ${show(d.find((x) => !(x.file === f && x.line === 2)))}`) : ": it compiled, so the declarations are too loose"}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntest-package-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
