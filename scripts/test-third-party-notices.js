#!/usr/bin/env node
// THIRD_PARTY_NOTICES.txt matches what scripts/gen-third-party-notices.js
// builds from the committed lockfiles, so a dependency change that skips the
// regeneration fails here; and no shipped package carries a copyleft-only or
// undeclared license that the file does not call out.
//
//   node scripts/test-third-party-notices.js
//
// Offline: reads the lockfiles and package manifests only.
import { readFileSync } from "node:fs";
import { buildNotices, OUT } from "./gen-third-party-notices.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const built = buildNotices();
let committed = "";
try { committed = readFileSync(OUT, "utf8"); } catch {}
ok(committed === built, "THIRD_PARTY_NOTICES.txt is current (else: node scripts/gen-third-party-notices.js --write)");

for (const t of ["Server image", "Facilitator image", "agent402-mcp", "Other published npm packages", "Outside npm"]) {
  ok(built.includes(t), `covers: ${t}`);
}
// Every shipped row whose license is copyleft is either a choice that names the
// permissive license it is used under, or a failure to look at by hand.
const shipped = built.split("\n").filter((l) => /^ {2}\S+@\S+ {2}/.test(l));
ok(shipped.length > 300, `lists the shipped packages (${shipped.length} rows)`);
const copyleftOnly = shipped.filter((l) => /\b(A?GPL|LGPL|MPL|SSPL|EUPL|EPL|CDDL)\b/i.test(l) && !/used under /.test(l));
ok(copyleftOnly.length === 0, `no shipped package is under a copyleft-only license${copyleftOnly.length ? ":\n    " + copyleftOnly.join("\n    ") : ""}`);
const unknown = shipped.filter((l) => /UNKNOWN/.test(l));
ok(unknown.every((l) => built.includes(`${l.trim().split(/\s+/)[0]} declares no license`)), "a package with no declared license is called out in the notes");
ok(readFileSync(new URL("../NOTICE", import.meta.url), "utf8").includes("THIRD_PARTY_NOTICES.txt"), "NOTICE points at THIRD_PARTY_NOTICES.txt");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
