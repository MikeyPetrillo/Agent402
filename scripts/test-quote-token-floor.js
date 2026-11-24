// The metered quote's input count has a characters-per-token floor
// (src/tools/llm-gateway-kit.js QUOTE_MAX_CHARS_PER_TOKEN): each 1 KB piece of
// the body counts at least one token per that many characters, so a body of
// runs the quoting tokenizer merges into very long tokens (spaces, rule
// characters, alternating pairs, ideographic spaces) is never quoted at a
// fraction of what another vendor's tokenizer may count. Text whose pieces
// count denser than the floor (prose, code, JSON, CJK) is quoted exactly as
// before, and the warm (yielding) count equals the cold one.
//
//   node scripts/test-quote-token-floor.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { countTokens } from "gpt-tokenizer/model/gpt-4o";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const k = await import("../src/tools/llm-gateway-kit.js");
const tier = k.TIERS["v1-chat-metered"];
const MODEL = "deepseek/deepseek-v4-flash";
const body = (content) => ({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 64 });
const textOf = (b) => { const p = { ...b }; delete p.max_tokens; return JSON.stringify(p, (key, v) => (key === "image_url" ? undefined : v)); };
// The plain count the kit made before the floor: o200k in 1 KB pieces, one token per cut.
const plainPieces = (t) => {
  const out = [];
  for (let i = 0; i < t.length;) {
    let j = Math.min(t.length, i + 1024);
    const c = t.charCodeAt(j - 1);
    if (c >= 0xd800 && c <= 0xdbff && j < t.length) j++;
    out.push(t.slice(i, j)); i = j;
  }
  return out;
};
const plainCount = (t) => { const ps = plainPieces(t); return ps.reduce((n, p) => n + countTokens(p), 0) + (ps.length - 1); };

ok(Number.isInteger(k.QUOTE_MAX_CHARS_PER_TOKEN) && k.QUOTE_MAX_CHARS_PER_TOKEN >= 6 && k.QUOTE_MAX_CHARS_PER_TOKEN <= 8, `the floor is between 6 and 8 characters per token (${k.QUOTE_MAX_CHARS_PER_TOKEN})`);
const K = k.QUOTE_MAX_CHARS_PER_TOKEN;

// 1. Runs a tokenizer merges into long tokens are counted at the floor.
for (const [name, content] of [["spaces", " ".repeat(200_000)], ["dashes", "-".repeat(200_000)], ["alternating -=", "-=".repeat(100_000)], ["ideographic spaces", "　".repeat(200_000)]]) {
  const t = textOf(body(content));
  const plain = plainCount(t);
  const quoted = k.promptTokensFor(body(content), tier);
  ok(plain * K < t.length && quoted >= Math.floor((t.length / K) * 1.15), `${name}: quoted at the floor, not the tokenizer's merge (${quoted} tokens for ${t.length} chars; the tokenizer alone counts ${plain})`);
}
// A run inside ordinary text is floored piece by piece, not averaged away.
{
  const prose = "The committee reviewed the quarterly figures and asked for a revised forecast by Friday. ".repeat(1200);
  const mixed = prose + " ".repeat(100_000);
  const quoted = k.promptTokensFor(body(mixed), tier);
  const proseOnly = k.promptTokensFor(body(prose), tier);
  ok(quoted - proseOnly >= Math.floor((100_000 / K) * 1.15) - 50, `a whitespace run beside prose adds its own floor (${quoted - proseOnly} more tokens for 100,000 spaces)`);
}

// 2. Control: text denser than the floor is quoted as before.
for (const [name, content] of [
  ["English prose", "Agents pay per call in USDC and get a signed receipt for every answer they buy. ".repeat(2500)],
  ["code", "function add(a, b) {\n  return a + b;\n}\nconst xs = [1, 2, 3].map((v) => v * 2);\n".repeat(2000)],
  ["CJK", Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 0x5000))).join("")],
  ["a markdown table", "| col a | col b |\n|-------|-------|\n| 1 | 2 |\n".repeat(3000)],
]) {
  const t = textOf(body(content));
  const want = Math.ceil(Math.ceil(plainCount(t) * 1.15) * k.tokenizerFactor(MODEL));
  const quoted = k.promptTokensFor(body(content), tier);
  ok(quoted === want, `${name}: quoted exactly as the tokenizer counts it (${quoted} vs ${want})`);
}

// 3. The warm count (counted ahead, yielding) equals the cold one under the floor.
{
  const b = body(" ".repeat(150_000) + "tail");
  k._clearQuoteWarm();
  const cold = k.promptTokensFor(b, tier);
  await k.warmQuoteTokenCounts(() => k.promptTokensFor(b, tier));
  const hits = k._quoteWarmStats().hits;
  const warm = k.promptTokensFor(b, tier);
  ok(k._quoteWarmStats().hits > hits && warm === cold, `the warm count reads the same floored figure (${warm} vs ${cold})`);
  k._clearQuoteWarm();
}

console.log(`\ntest-quote-token-floor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
