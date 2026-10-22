// The document CSP limits where a form may submit: this origin, or mailto:
// (the /company contact form opens the visitor's email app). Every form in
// the tree must stay inside that, so the directive can never block a real
// page: no <form action> naming another origin, and no formaction attribute.
//
// Run: node scripts/test-csp-form-action.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setDocumentHeaders } from "../src/security-headers.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const headers = {};
setDocumentHeaders({ setHeader: (k, v) => { headers[k.toLowerCase()] = v; } });
const csp = String(headers["content-security-policy"] || "");
const directives = Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
ok(Array.isArray(directives["form-action"]), `the document CSP sets form-action (${csp.slice(0, 60)}...)`);
const fa = directives["form-action"] || [];
ok(fa.includes("'self'") && fa.every((s) => s === "'self'" || s === "mailto:"), `form-action allows only 'self' and mailto: (${fa.join(" ")})`);
ok((directives["style-src"] || []).includes("'unsafe-inline'") && (directives["script-src"] || []).every((s) => s !== "'unsafe-inline'"), "the other directives are unchanged (style-src keeps 'unsafe-inline', script-src has none)");

// Every form in the shipped tree submits inside form-action.
const ROOT = new URL("..", import.meta.url).pathname;
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(n)) files.push(p);
  }
};
walk(join(ROOT, "src"));
walk(join(ROOT, "assets"));
const offenders = [];
let forms = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/<form\b[^>]*>/gi)) {
    forms++;
    const action = m[0].match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1];
    if (action === undefined) continue; // submits to the page itself
    if (/^mailto:/i.test(action) || (action.startsWith("/") && !action.startsWith("//")) || action === "" || action.startsWith("$")) continue;
    offenders.push(`${f.slice(ROOT.length)}: ${m[0].slice(0, 120)}`);
  }
  for (const m of text.matchAll(/\bformaction\s*=/gi)) offenders.push(`${f.slice(ROOT.length)}: formaction at ${m.index}`);
}
ok(forms > 0, `the scan found the tree's forms (${forms})`);
ok(offenders.length === 0, `no form submits outside 'self' and mailto:${offenders.length ? `\n  ${offenders.join("\n  ")}` : ""}`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
