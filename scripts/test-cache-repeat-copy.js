#!/usr/bin/env node
// The gateway's cached repeat is free to a request that carries a payment,
// and that payment is not charged, except a Tempo transfer the buyer sends
// before the call, which is final when sent. Every published sentence that
// says a repeat's payment "is not charged" names that exception.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const files = [join(ROOT, "README.md")];
const walk = (d) => { for (const n of readdirSync(d)) { if (n === "node_modules" || n.startsWith(".")) continue; const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(js|md)$/.test(n)) files.push(f); } };
for (const d of ["src", "wiki", "docs", "mcp", "client", "openclaw"]) { try { walk(join(ROOT, d)); } catch { /* absent */ } }

const missing = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  // Sentences (or wrapped lines joined) that promise an uncharged repeat.
  for (const m of text.matchAll(/[^.\n]*(?:\n[^.\n]+)*?payment[^.]{0,40}is not charged[^.]*\./g)) {
    if (!/Tempo transfer/.test(m[0])) missing.push(`${f.slice(ROOT.length)}: ${m[0].replace(/\s+/g, " ").trim().slice(0, 90)}`);
  }
}
ok(missing.length === 0, `every "repeat's payment is not charged" sentence names the Tempo transfer exception${missing.length ? `:\n  ${missing.join("\n  ")}` : ""}`);

const kit = readFileSync(join(ROOT, "src", "tools", "llm-gateway-kit.js"), "utf8");
ok((kit.match(/except a Tempo transfer you send before the call, which is final when sent/g) || []).length >= 2, "the embeddings and rerank descriptions name the exception");
const skill = readFileSync(join(ROOT, "src", "skill-md.js"), "utf8");
ok(/X-Cache: hit[\s\S]{0,200}except a Tempo transfer sent before the call/.test(skill), "skill.md names the exception beside X-Cache: hit");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
