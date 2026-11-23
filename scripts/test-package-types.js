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
//   3. every name the runtime module exports is declared, and every declared
//      value is exported at runtime (read from the source's export
//      statements, so the check needs none of the package's peers);
//   4. per package, a misuse the declarations must reject (a wrong option
//      type) fails to compile, so a declaration that collapsed to `any`
//      fails here.
// elizaos-plugin-agent402's declarations import its host's @elizaos/core,
// which an Eliza project always has and this repository does not install;
// it gets checks 1 and 3 only. agent402-tollbooth's root and ./edge are
// typed; its other subpaths (the Worker entry, the replay stores, the MPP
// helpers, the dashboard and sinks) are listed in UNTYPED_SUBPATHS, and a
// subpath any package adds outside that list must ship declarations.
//   node scripts/test-package-types.js
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { publishedPackageDirs } from "./lib/published-packages.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

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
const tmp = mkdtempSync(join(tmpdir(), "a402-types-"));
try {
  const nm = join(tmp, "node_modules");
  mkdirSync(nm);
  const pkgs = dirs.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) }));
  for (const { dir, pkg } of pkgs) {
    const target = join(nm, ...pkg.name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(ROOT, dir), target, "dir");
  }
  const consumer = [];
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
      // 3. runtime exports and declared exports agree
      if (typeof types === "string" && typeof runtime === "string" && existsSync(join(ROOT, dir, types))) {
        const rt = runtimeExports(join(ROOT, dir, runtime));
        const program = ts.createProgram([join(ROOT, dir, types)], { noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noResolve: HOST_TYPED.has(dir) });
        const checker = program.getTypeChecker();
        const sf = program.getSourceFile(join(ROOT, dir, types));
        const sym = sf && checker.getSymbolAtLocation(sf);
        const declared = new Set();
        const values = new Set();
        for (const s of sym ? checker.getExportsOfModule(sym) : []) {
          declared.add(s.getName());
          const t = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
          if (t.flags & ts.SymbolFlags.Value) values.add(s.getName());
        }
        const undeclared = [...rt].filter((n) => !declared.has(n));
        const phantom = [...values].filter((n) => !rt.has(n));
        ok(undeclared.length === 0, `${pkg.name}${sp === "." ? "" : sp.slice(1)}: every runtime export is declared (${rt.size})${undeclared.length ? `; undeclared: ${undeclared.join(", ")}` : ""}`);
        ok(phantom.length === 0, `${pkg.name}${sp === "." ? "" : sp.slice(1)}: every declared value exists at runtime${phantom.length ? `; missing: ${phantom.join(", ")}` : ""}`);
      }
      if (!HOST_TYPED.has(dir)) consumer.push({ dir, name: pkg.name, spec: sp === "." ? pkg.name : `${pkg.name}${sp.slice(1)}` });
    }
  }

  // 2. one strict consumer per package; 4. its misuse must not compile.
  const options = {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    preserveSymlinks: true, skipLibCheck: false, types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")], lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const compile = (files) => {
    const program = ts.createProgram(files, options);
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? `${d.file.fileName.replace(tmp, "").replace(ROOT, "")}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : "";
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  };
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "types-consumer", private: true, type: "module" }));
  const good = [];
  for (const [i, c] of consumer.entries()) {
    const f = join(tmp, `use-${i}.ts`);
    writeFileSync(f, `import * as m from "${c.spec}";\nexport const names: string[] = Object.keys(m);\n`);
    good.push(f);
  }
  const diags = compile(good);
  ok(good.length >= 13 && diags.length === 0, `${good.length} strict nodenext consumers compile against the packages as installed${diags.length ? `:\n  ${diags.slice(0, 12).join("\n  ")}` : ""}`);
  for (const [dir, line] of Object.entries(MISUSE)) {
    const c = consumer.find((x) => x.dir === dir && !x.spec.includes("/", x.name.length));
    if (!c) { ok(false, `${dir}: has a consumer for its misuse check`); continue; }
    const f = join(tmp, `misuse-${dir.replace(/\W/g, "_")}.ts`);
    writeFileSync(f, `import * as m from "${c.spec}";\n${line}\n`);
    const d = compile([f]);
    // Every error is on the misuse line (2): an import that failed would be on line 1.
    ok(d.length > 0 && d.every((x) => /:2 /.test(x)), `${c.name}: the declarations refuse a misuse (${line.trim()})${d.length ? (d.every((x) => /:2 /.test(x)) ? "" : `: an error off the misuse line: ${d[0]}`) : ": it compiled, so the declarations are too loose"}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntest-package-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
