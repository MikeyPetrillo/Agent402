// A COUNT must never be the length of a LIMITed list. Repo-wide.
//
// 2026-08-30: `distinctToolsSoldExternal` was `qExtBySlug.all(since).length`
// and that query carries LIMIT 20; `distinctExternalBuyers` was the same shape
// over LIMIT 10. Both were min(actual, limit) and could never report more,
// however many tools sold or buyers paid. Both are published (host-entry.js ->
// /marketplace, /leaderboard, every chain page, /api/index), and the capped
// figure "20 of 627 priced tools had any external use, 10 buyers" was the
// measurement that justified retiring 40 tools and 29 skill packs. Eleven of
// those packs had real outside buyers inside the window.
//
// A ceiling that looks like a count is worse than no count: it reads as a
// finding, and someone acts on it. This is a SOURCE scan because a fixture
// small enough to unit-test sits under every limit and passes either way -
// which is exactly why nothing caught it for five days.
import { readFile, readdir } from "node:fs/promises";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const files = [];
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
};
await walk("src");

// Every prepared statement whose SQL carries a LIMIT, by variable name.
const limited = new Map();
for (const f of files) {
  const src = await readFile(f, "utf8");
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*db\.prepare\(`([\s\S]*?)`\)/g)) {
    if (/\bLIMIT\b/i.test(m[2])) limited.set(m[1], f);
  }
}
ok(limited.size > 0, `found LIMITed prepared statements to check (${limited.size})`);

// Any `.length` taken on one of those results, directly or through a local
// binding in the SAME function body.
const offences = [];
for (const f of files) {
  const src = await readFile(f, "utf8");
  for (const name of limited.keys()) {
    for (const m of src.matchAll(new RegExp(String.raw`\b${name}\.all\([^)]*\)\s*\.length`, "g"))) {
      offences.push(`${f}:${src.slice(0, m.index).split("\n").length}  ${name}.all(...).length`);
    }
    // const x = q.all(...)  ->  x.length, bounded to the enclosing block so a
    // reused variable name elsewhere in the file is not a false positive.
    for (const m of src.matchAll(new RegExp(String.raw`const\s+(\w+)\s*=\s*${name}\.all\(`, "g"))) {
      const varName = m[1];
      const body = src.slice(m.index, src.indexOf("\n}", m.index) + 2);
      for (const u of body.matchAll(new RegExp(String.raw`\b(\w+)\s*:\s*${varName}\.length\b`, "g"))) {
        // A page-size field is honest; a count-named one is not.
        if (/^(count|total|distinct\w*|\w+Count|\w+Total|buyers|tools|sellers|settlements|sales)$/i.test(u[1])) {
          offences.push(`${f}:${src.slice(0, m.index + u.index).split("\n").length}  ${u[1]}: ${varName}.length (from ${name}, LIMITed)`);
        }
      }
    }
  }
}
ok(offences.length === 0, `no count-named field is the length of a LIMITed query result${offences.length ? `\n       ${offences.join("\n       ")}` : ""}`);

// The two that were wrong must stay right.
const ledger = await readFile("src/sales-ledger.js", "utf8");
for (const q of ["qExtDistinctSlugs", "qExtDistinctPayers"]) {
  const decl = ledger.slice(ledger.indexOf(`const ${q} = `), ledger.indexOf(`const ${q} = `) + 260);
  ok(/COUNT\(DISTINCT/i.test(decl) && !/\bLIMIT\b/i.test(decl), `${q} is an uncapped COUNT(DISTINCT ...)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
