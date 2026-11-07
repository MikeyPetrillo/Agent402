#!/usr/bin/env node
// The gateway's cached repeat is free to a request that carries a payment,
// and that payment is not charged, except a Tempo transfer the buyer sends
// before the call, which is final when sent. Every published sentence that
// says a repeat's payment "is not charged" names that exception.
import { fileURLToPath } from "node:url";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walk } from "./lib/shipped-files.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const files = [join(ROOT, "README.md")];
for (const d of ["src", "wiki", "docs", "mcp", "client", "openclaw"]) { try { files.push(...walk(join(ROOT, d)).filter((f) => /\.(js|md)$/.test(f))); } catch { /* absent */ } }

const missing = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  // Sentences (or wrapped lines joined) that promise an uncharged repeat.
  for (const m of text.matchAll(/[^.\n]*(?:\n[^.\n]+)*?payment[^.]{0,40}is not charged[^.]*\./g)) {
    if (!/Tempo transfer/.test(m[0])) missing.push(`${f.slice(ROOT.length)}: ${m[0].replace(/\s+/g, " ").trim().slice(0, 90)}`);
  }
}
ok(missing.length === 0, `every "repeat's payment is not charged" sentence names the Tempo transfer exception${missing.length ? `:\n  ${missing.join("\n  ")}` : ""}`);

// The cached repeat is free only to the payer that paid for it, on a fresh
// payment of its own (an EOA-signed x402 v2 exact payment, a verified Tempo
// sender, or the same credits key); every other payer and rail is charged.
// A sentence that promises a free or uncharged repeat must scope it to that
// payer; the unscoped wording below is what the copy said before the scope.
const UNSCOPED = [
  /identical (?:inputs|repeats)[^.|]{0,60}(?:are|is) (?:served )?\**free(?![^.]{0,20}to the payer)/i,
  /byte-identical repeats? (?:within 10 minutes )?(?:is|are) served (?:\*\*)?free(?:\*\*)?(?![^.]{0,25}to the payer)/i,
  /repeat within 10 minutes that carries your payment is served FREE/,
  /(?:^|[^'s])\bfree repeat\b/i,
];
const unscoped = [];
for (const f of files) {
  const rel = f.slice(ROOT.length);
  if (/(?:^|\/)changelog\.js$/.test(rel)) continue; // dated history, not a promise
  // Code comments describe the mechanism; the strings and the markdown are the copy.
  const raw = readFileSync(f, "utf8");
  const text = f.endsWith(".js") ? raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1") : raw;
  for (const re of UNSCOPED) {
    const m = text.match(re);
    if (m) unscoped.push(`${rel}: ${m[0].slice(0, 90)}`);
  }
  // Every sentence offering a free cached repeat names whose repeat it is.
  for (const m of text.matchAll(/[^.\n]*(?:\n[^.\n]+)*?(?:repeat[^.]{0,80}(?:served |is |are )(?:\*\*)?free|cached repeat served free)[^.]*\./gi)) {
    if (!/payer that paid for it|same (?:payer|wallet)|Response caching/.test(m[0])) unscoped.push(`${rel}: ${m[0].replace(/\s+/g, " ").trim().slice(0, 90)}`);
  }
}
ok(unscoped.length === 0, `every free cached repeat is scoped to the payer that paid for it${unscoped.length ? `:\n  ${unscoped.join("\n  ")}` : ""}`);
for (const [file, re, what] of [
  ["src/tools/llm-gateway-kit.js", /payer that paid for it[^"]{0,400}Other payers and payment methods are charged on each call[\s\S]*?payer that paid for it[^"]{0,400}Other payers and payment methods are charged on each call/, "embeddings and rerank descriptions"],
  ["src/skill-md.js", /X-Cache: hit[\s\S]{0,120}payer that paid for it[\s\S]{0,400}Other payers and payment methods are charged/, "skill.md X-Cache line"],
  ["README.md", /payer that paid for it[\s\S]{0,600}charged on each call/, "README gateway paragraph"],
  ["wiki/Embeddings.md", /payer that paid for it[\s\S]{0,400}charged on each call/, "wiki Embeddings callout"],
  ["src/payments.js", /"v1-embeddings": "[^"]*payer that paid for it[^"]*"/, "Bazaar embeddings description"],
]) ok(re.test(readFileSync(join(ROOT, file), "utf8")), `${what} scope the free repeat to the paying payer`);

const kit = readFileSync(join(ROOT, "src", "tools", "llm-gateway-kit.js"), "utf8");
ok((kit.match(/except a Tempo transfer you send before the call, which is final when sent/g) || []).length >= 2, "the embeddings and rerank descriptions name the exception");
const skill = readFileSync(join(ROOT, "src", "skill-md.js"), "utf8");
ok(/X-Cache: hit[\s\S]{0,500}except a Tempo transfer sent before the call/.test(skill), "skill.md names the exception beside X-Cache: hit");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
