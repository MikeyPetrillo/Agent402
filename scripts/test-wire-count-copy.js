// Copy that counts the model gateway's wires ("five tiers on three wires")
// must match the wires the gateway serves. A Gemini wire went live on every
// tier while /why, the README, the wiki and three pages kept saying three
// (truth audit 2026-10-02). The count is derived from the kits' own routes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LLM_GATEWAY_TOOLS } from "../src/tools/llm-gateway-kit.js";
import { LLM_MESSAGES_TOOLS } from "../src/tools/llm-messages-kit.js";
import { LLM_RESPONSES_TOOLS } from "../src/tools/llm-responses-kit.js";
import { LLM_GEMINI_TOOLS } from "../src/tools/llm-gemini-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const wires = [
  LLM_GATEWAY_TOOLS.some((t) => /\/chat\/completions$/.test(t.route)),
  LLM_RESPONSES_TOOLS.length > 0,
  LLM_MESSAGES_TOOLS.length > 0,
  LLM_GEMINI_TOOLS.length > 0,
].filter(Boolean).length;
const WORDS = ["zero", "one", "two", "three", "four", "five", "six"];
// Model-wire counts only: "two wires" elsewhere means the payment wires (x402, MPP).
const COUNT = /\btiers? on (two|three|four|five|six) wires\b|\b(two|three|four|five|six) wires (?:on every\s+tier|\(OpenAI)/gi;
ok(wires === 4, `the gateway serves ${wires} wires`);
ok([..."five tiers on three wires".matchAll(COUNT)].length === 1, "control: the pattern finds a wire count in prose");
const root = new URL("..", import.meta.url).pathname;
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/node_modules|\.git/.test(f)) walk(p); } else if (/\.(js|md)$/.test(f)) files.push(p); } };
for (const d of ["src", "wiki", "docs"]) walk(join(root, d));
files.push(join(root, "README.md"));
const bad = [];
for (const f of files) {
  if (/llm-gemini-kit\.js$/.test(f)) continue; // its header narrates the wires that existed before it
  for (const m of readFileSync(f, "utf8").matchAll(COUNT)) if (WORDS.indexOf((m[1] || m[2]).toLowerCase()) !== wires) bad.push(`${f.slice(root.length)}: "${m[0]}"`);
}
ok(files.length > 300, `swept ${files.length} copy files`);
ok(bad.length === 0, `every wire count in copy says ${WORDS[wires]}${bad.length ? ` - ${bad.join("; ")}` : ""}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
