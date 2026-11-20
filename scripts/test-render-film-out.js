// render-film's --out: a relative path lands under the repository root and an
// absolute path is used as given, never joined under the repository (offline).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const { outDirOf } = await import("./render-film.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const abs = join(tmpdir(), "a402-film-out");
ok(outDirOf(abs) === abs, `an absolute --out is used as given (${outDirOf(abs)})`);
ok(!outDirOf(abs).startsWith(ROOT + "/"), "an absolute --out never lands inside the repository");
ok(outDirOf("dist/media") === join(ROOT, "dist/media"), "a relative --out is read from the repository root");
ok(outDirOf("") === join(ROOT, "dist/media") && outDirOf(undefined) === join(ROOT, "dist/media"), "no --out keeps the default dist/media");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
