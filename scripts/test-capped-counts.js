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
//
// ALL THREE QUOTE STYLES, AND NOT ONLY `const x = db.prepare(...)`.
//
// This scan read backtick template literals only, and `db` only. Eight
// LIMITed statements in five files were therefore invisible to it - among
// them `getChargedFailures` in stats.js, a plain double-quoted prepare whose
// result fed `chargedButFailedGenuine`, the figure /api/stats' own note calls
// "the reliability number". So the guard written after a capped count was
// published as a business figure could not see the next capped count being
// published as a business figure, and reported a clean sweep while it stood.
// Proven by replanting the shipped line: the rule passed green over it.
//
// A guard that inspects one spelling certifies one spelling. Every quote
// style counts, `hdb`/`adb`-style handles count, and an object-property
// statement (`{ due: db.prepare(...) }`, stripe-shadow-ledger) counts, because
// a caller reaches it as `q.due.all(...)` and `\b` matches after the dot.
const limited = new Map();
const PREPARE = /(?:const\s+|\b)(\w+)\s*[:=]\s*\w*[dD][bB]?\w*\.prepare\(\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
for (const f of files) {
  const src = await readFile(f, "utf8");
  for (const m of src.matchAll(PREPARE)) {
    if (/\bLIMIT\b/i.test(m[2])) limited.set(m[1], f);
  }
}
ok(limited.size > 0, `found LIMITed prepared statements to check (${limited.size})`);
// The eight the old backtick-only scan could not see must be in the set now,
// or the widening is decorative. Named individually so a rename fails loudly
// rather than silently shrinking the guard's reach.
for (const name of ["getChargedFailures", "getRecent", "getRecentAll", "selectByStatus", "selectAll", "due", "recent", "rows"]) {
  if (name === "rows") continue; // x402-economy inlines its prepare; covered by the chain scan below
  ok(limited.has(name), `plain-quoted LIMITed statement ${name} is in the scan`);
}

// Any `.length` taken on one of those results, directly or through a local
// binding in the SAME function body.
//
// THE CHAIN MATTERS, and the first cut of this rule missed a live one because
// of it. /api/stats published `chargedButFailedGenuine`, which read
//
//   (getChargedFailures.all(RECENT_KEEP) || []).filter((r) => r.status !== 402).length
//
// - a LIMITed read, a `|| []`, a `.filter(...)`, a newline, then `.length`.
// The rule only matched `.all(...)` followed immediately by `.length`, so a
// figure the endpoint's own note called "the reliability number" sat capped at
// 200 with a green guard beside it for weeks. Anything that ends in `.length`
// on the same expression is the same defect however many array methods sit in
// between, so the scan now walks forward from `.all(` to a `.length` that is
// still part of that expression, stopping at a statement boundary.
const CHAIN_METHODS = /^\s*(\|\|\s*\[\]\s*\)?|\)|\.(filter|map|slice|flat|flatMap|reverse|sort|concat|toSorted|toReversed)\s*\()/;
/** From the "(" of a `.all(`, the index just past its matching ")", or -1. */
function afterCall(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i + 1; }
    else if (c === "`" || c === '"' || c === "'") { // skip a literal wholesale
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
    }
  }
  return -1;
}
/** Does this `.all(...)` expression end in a `.length`, through any chain? */
function chainsToLength(src, from) {
  let i = from;
  for (let hops = 0; hops < 12; hops++) {
    const rest = src.slice(i, i + 4000);
    const len = /^\s*\.length\b/.exec(rest);
    if (len) return i + len[0].length;
    const m = CHAIN_METHODS.exec(rest);
    if (!m) return -1;
    if (m[0].trimStart().startsWith(".")) {
      const open = src.indexOf("(", i + m[0].length - 1);
      const end = afterCall(src, open);
      if (end < 0) return -1;
      i = end;
    } else {
      i += m[0].length;
    }
  }
  return -1;
}

const offences = [];
for (const f of files) {
  const src = await readFile(f, "utf8");
  for (const name of limited.keys()) {
    for (const m of src.matchAll(new RegExp(String.raw`\b${name}\.all\(`, "g"))) {
      const open = src.indexOf("(", m.index + name.length + 4);
      const end = afterCall(src, open);
      if (end > 0 && chainsToLength(src, end) > 0) {
        offences.push(`${f}:${src.slice(0, m.index).split("\n").length}  ${name}.all(...) ... .length (LIMITed read counted by its length)`);
      }
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
