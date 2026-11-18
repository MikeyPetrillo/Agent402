#!/usr/bin/env node
// SQL text in src/ is built from code, never from a caller: values travel as
// bound parameters ($1, ?, @name), and what a template literal interpolates
// is a schema or table name, a column list, a placeholder list or a number the
// code clamped itself.
//
//   node scripts/test-sql-interpolation.js
//
// Offline and static. Every template literal under src/ whose text starts
// with a SQL statement keyword is read, and each `${...}` inside it must not
// name a request-shaped value (req, request, input, body, query, args,
// payload, search, params.<field>, headers, cookies). A string-concatenated
// statement must not add one either. A new interpolation of a caller's value
// fails here; bind it as a parameter instead.
//
// Live control: the same reader is run on planted snippets that do interpolate
// a request value, and must flag every one, and on the bound-parameter form of
// each, and must flag none.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|LOCK|SET\s+LOCAL|DECLARE|FETCH|PRAGMA|EXPLAIN|TRUNCATE|MERGE|UPSERT)\b/i;
const CALLER = /\b(?:req|request|input|body|query|args|payload|search|headers|cookies)\b(?!\s*\()|\bparams\s*\.\s*(?!length\b)\w/;

/** Each `${...}` of `body`, with nested braces kept whole. */
function interpolations(body) {
  const out = [];
  for (let i = body.indexOf("${"); i !== -1; i = body.indexOf("${", i + 2)) {
    let depth = 1, j = i + 2;
    for (; j < body.length && depth; j++) { if (body[j] === "{") depth++; else if (body[j] === "}") depth--; }
    out.push(body.slice(i + 2, j - 1).trim());
  }
  return out;
}

/** Findings for one file's text: [{ line, expr }]. */
function sqlFindings(text) {
  const found = [];
  const lineOf = (idx) => text.slice(0, idx).split("\n").length;
  const tpl = /`((?:[^`\\]|\\[\s\S])*)`/g;
  let m;
  while ((m = tpl.exec(text))) {
    if (!SQL_START.test(m[1]) || !m[1].includes("${")) continue;
    // String literals inside the expression are SQL text the code wrote (a
    // column name passed to a helper), not values: only the code is read.
    for (const expr of interpolations(m[1])) if (CALLER.test(expr.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "''"))) found.push({ line: lineOf(m.index), expr });
  }
  const concat = /(["'])\s*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|AND|OR|FROM|VALUES|LIMIT|OFFSET|ORDER BY)\b[^"'\n]*\1\s*\+\s*([^;\n]+)/gi;
  while ((m = concat.exec(text))) {
    const rhs = m[2].replace(/(["'])(?:\\.|(?!\1).)*\1/g, "");
    if (CALLER.test(rhs)) found.push({ line: lineOf(m.index), expr: m[2].trim().slice(0, 80) });
  }
  return found;
}

// Live control first: the reader flags a caller's value and passes its bound form.
const PLANTED = [
  "db.prepare(`SELECT * FROM sales WHERE payer = '${req.query.payer}'`).all();",
  "await c.query(`SELECT body FROM ${T('records')} WHERE id = ${input.id}`);",
  "await q(`DELETE FROM kv WHERE k = '${body.key}'`);",
  "await q(`UPDATE t SET v = 1 WHERE name LIKE '%${search}%'`);",
  "await q(`SELECT * FROM t LIMIT ${params.limit}`);",
  "db.prepare(\"SELECT * FROM t WHERE id = \" + req.params.id).get();",
];
const BOUND = [
  "db.prepare(`SELECT * FROM sales WHERE payer = ?`).all(req.query.payer);",
  "await c.query(`SELECT body FROM ${T('records')} WHERE id = $1`, [input.id]);",
  "await q(`INSERT INTO ${s}.x (a) VALUES ${vals.join(',')}`, params);",
  "await q(`SELECT * FROM t LIMIT ${Math.min(500, lim)}`, [params.length]);",
];
for (const s of PLANTED) ok(sqlFindings(s).length > 0, `control: the reader flags ${s.slice(0, 70)}`);
for (const s of BOUND) ok(sqlFindings(s).length === 0, `control: the reader passes the bound form ${s.slice(0, 70)}`);

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (f !== "node_modules") walk(p); }
    else if (/\.(?:m?js|cjs)$/.test(f)) files.push(p);
  }
};
walk(join(ROOT, "src"));
let statements = 0;
const findings = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const tpl = /`((?:[^`\\]|\\[\s\S])*)`/g;
  let m;
  while ((m = tpl.exec(text))) if (SQL_START.test(m[1]) && m[1].includes("${")) statements++;
  for (const x of sqlFindings(text)) findings.push(`${relative(ROOT, f)}:${x.line} interpolates ${x.expr}`);
}
ok(files.length > 100 && statements > 50, `read ${files.length} source files and ${statements} SQL templates that interpolate`);
for (const x of findings) console.error(`  ${x}`);
ok(findings.length === 0, `no SQL template or concatenation in src/ interpolates a caller's value (${findings.length} found)`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
