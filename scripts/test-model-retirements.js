// Upstream model retirements, checked against our code. A quoted model id
// that appears in live code after its retirement date fails the build; before
// the date the guard only reports how many days are left. Comments are not
// matched: only quoted strings, which is where a request would name the model.
//
//   node scripts/test-model-retirements.js
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RETIRING = [
  { vendor: "OpenAI", ids: ["gpt-image-1", "openai/gpt-image-1", "gpt-4o-2024-05-13", "gpt-4.1-nano-2025-04-14"], retires: "2026-10-23" },
  { vendor: "OpenAI", ids: ["gpt-image-1-mini", "openai/gpt-image-1-mini", "gpt-image-1.5", "openai/gpt-image-1.5"], retires: "2026-12-01" },
  { vendor: "OpenAI", ids: ["gpt-5", "openai/gpt-5", "gpt-5-mini", "openai/gpt-5-mini", "gpt-5-nano", "openai/gpt-5-nano"], retires: "2026-12-11" },
  { vendor: "OpenAI", ids: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"], retires: "2027-01-06" },
  { vendor: "Anthropic", ids: ["claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5-20250929"], retires: "2026-11-30" },
];

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = sources(new URL("../src", import.meta.url).pathname);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const now = Date.now();
let fail = 0, pass = 0;
for (const r of RETIRING) {
  const days = Math.ceil((Date.parse(r.retires) - now) / 86_400_000);
  const hits = [];
  for (const id of r.ids) {
    const needles = [`"${id}"`, `'${id}'`, `\`${id}\``];
    for (const [f, src] of text) if (needles.some((n) => src.includes(n))) hits.push(`${id} in ${f.replace(/^.*\/src\//, "src/")}`);
  }
  if (!hits.length) { pass++; continue; }
  if (days <= 0) { fail++; console.log(`FAIL ${r.vendor} retired ${r.retires}, still in code:\n  ${hits.join("\n  ")}`); }
  else console.log(`warn ${r.vendor} retires ${r.retires} (${days} days): still referenced in ${hits.length} place(s)`);
}
console.log(`${pass} retirement groups clean, ${fail} failing`);
process.exit(fail ? 1 : 0);
