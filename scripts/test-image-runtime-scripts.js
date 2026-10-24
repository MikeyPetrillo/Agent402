#!/usr/bin/env node
// The Dockerfile used to `COPY scripts ./scripts`, which shipped ~90 test files
// into the production image and put a cache-busting layer in front of every
// layer below it - and a test-only edit is the most common change in this repo,
// so almost every deploy rebuilt from that point down.
//
// It now copies only the files the SERVER needs at runtime, by name. That is
// faster and smaller, and it is also a trapdoor: adding a runtime import from
// scripts/ and forgetting the Dockerfile produces an image that passes every
// test here and crashes on boot in production, where the file is absent.
//
// So the required set is DERIVED from the source, never listed. Anything src/,
// worker/ or start.js reaches for under scripts/ must be copied.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const root = new URL("../", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");

// Every file under a runtime directory, recursively.
const walk = (dir, acc = []) => {
  let entries = [];
  try { entries = readdirSync(new URL(dir, root)); } catch { return acc; }
  for (const e of entries) {
    const rel = `${dir}${e}`;
    let st; try { st = statSync(new URL(rel, root)); } catch { continue; }
    if (st.isDirectory()) walk(`${rel}/`, acc);
    else if (rel.endsWith(".js")) acc.push(rel);
  }
  return acc;
};
const runtimeFiles = [...walk("src/"), ...walk("worker/"), "start.js"].filter((f) =>
  existsSync(new URL(f, root)));
ok(runtimeFiles.length > 50, `expected the runtime source tree, found ${runtimeFiles.length} files`);

// Static imports, dynamic imports, and readFileSync(new URL(...)) all count -
// the last one is how /demo.js is served, and a name-only scan would miss it.
const REFS = [
  /from\s+["'][^"']*\/scripts\/([\w.-]+\.js)["']/g,
  /import\s*\(\s*["'][^"']*\/scripts\/([\w.-]+\.js)["']\s*\)/g,
  /new URL\(\s*["'][^"']*\/scripts\/([\w.-]+\.js)["']/g,
  // path.join(..., "scripts", "x.js") / resolve(...) and a bare "scripts/x.js"
  // string handed to readFileSync - the shapes a name-only scan of the three
  // above would miss (raised in the 2026-08-25 review; no instance today).
  /["']scripts["']\s*,\s*["']([\w.-]+\.js)["']/g,
  /readFileSync\(\s*["'](?:\.\/)?scripts\/([\w.-]+\.js)["']/g,
];
const needed = new Map(); // file -> where it was referenced
for (const f of runtimeFiles) {
  const src = readFileSync(new URL(f, root), "utf8");
  for (const re of REFS) {
    for (const m of src.matchAll(re)) if (!needed.has(m[1])) needed.set(m[1], f);
  }
}
ok(needed.size > 0, "detector found no scripts/ references at all - it has gone blind");
// A runtime script's own relative imports ship too (a copied file that imports
// a sibling the image lacks crashes on boot). Followed transitively.
const SIBLING = [
  /from\s+["']\.\/([\w.-]+\.js)["']/g,
  /import\s*\(\s*["']\.\/([\w.-]+\.js)["']\s*\)/g,
];
for (const queue = [...needed.keys()]; queue.length;) {
  const file = queue.shift();
  let src = "";
  try { src = readFileSync(new URL(`scripts/${file}`, root), "utf8"); } catch { continue; }
  for (const re of SIBLING) {
    for (const m of src.matchAll(re)) if (!needed.has(m[1])) { needed.set(m[1], `scripts/${file}`); queue.push(m[1]); }
  }
}

for (const [file, where] of needed) {
  // Escape EVERY regex metacharacter, not only '.'. The capture pattern admits
  // [\w.-] so '-' is the only other char that can appear, and it is inert here,
  // but a partial escape is the shape CodeQL flags (js/incomplete-sanitization)
  // and it is right to: the next person to widen the capture would silently
  // inherit a regex injection. Escape fully and the class is closed.
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  ok(new RegExp(`COPY[^\\n]*scripts/${esc}`).test(dockerfile),
    `${where} uses scripts/${file} at runtime but the Dockerfile does not COPY it - ` +
    "the image boots without it and crashes in production");
}

// And the wholesale copy must not come back: it is what made every test edit
// invalidate the image.
ok(!/COPY\s+scripts\s+\.\/scripts\s*$/m.test(dockerfile),
  "Dockerfile copies the whole scripts/ directory again - every test edit rebuilds the image from there down");

// Mutation control: the detector must see each reference shape it claims to.
const probe = (s) => REFS.some((re) => [...s.matchAll(re)].length > 0);
ok(probe('import { x } from "../scripts/revenue-scan-solana.js";'), "blind to static imports");
ok(probe('await import("../scripts/thing.js")'), "blind to dynamic imports");
ok(probe('readFileSync(new URL("../scripts/demo-payment.js", import.meta.url))'), "blind to readFileSync(new URL())");

console.log(`${pass} passed, ${fail} failed (${needed.size} runtime script(s): ${[...needed.keys()].join(", ")})`);
process.exit(fail ? 1 : 0);
