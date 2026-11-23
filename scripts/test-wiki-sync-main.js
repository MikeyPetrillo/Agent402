// The wiki mirror (.github/workflows/wiki.yml) publishes wiki/ from main only:
// its push trigger names main and no other branch, and the sync job runs only
// when the ref is main, so a manual run from another branch publishes nothing.
//
//   node scripts/test-wiki-sync-main.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const wf = readFileSync(`${ROOT}/.github/workflows/wiki.yml`, "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const push = /\n  push:\n([\s\S]*?)\n  [a-z_]+:/.exec(wf);
const branches = push ? [...push[1].matchAll(/^\s+- "?([^"\n]+)"?$/gm)].map((m) => m[1]).filter((b) => !b.includes("/**") && !b.endsWith(".yml")) : [];
ok(branches.length === 1 && branches[0] === "main", `push trigger names main only (read: ${JSON.stringify(branches)})`);
ok(!/branches-ignore|tags:/.test(wf), "no other branch or tag filter publishes the wiki");
const job = /\n  sync:\n([\s\S]*?)\n    steps:/.exec(wf);
ok(job && /\n    if: github\.ref == 'refs\/heads\/main'/.test(job[1]), "the sync job runs only on refs/heads/main");

console.log(`\ntest-wiki-sync-main: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
