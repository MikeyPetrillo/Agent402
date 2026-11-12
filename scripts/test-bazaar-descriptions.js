// Bazaar listing copy guard: every curated description names a real catalog
// slug, fits the Bazaar's 500-char cap, reads as what+when (no internal
// cross-references the Bazaar reader cannot follow), no em dashes; the
// generic cap truncates at a sentence/word boundary, never mid-word "...".
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { BAZAAR_DESCRIPTIONS, BAZAAR_DESCRIPTION_MAX, bazaarCapDescription, fitChallenge, CHALLENGE_SHORT_DESCRIPTION_MAX, isExamplePointer, x402ServiceName, SERVICE_NAME_MAX } from "../src/payments.js";
import { RUGCHECK_SLUGS, rugcheckEnabled } from "../src/tools/solana-intel-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const res = await fetch(`${process.env.TARGET_URL || "http://127.0.0.1:3000"}/api/pricing`).then((r) => r.json()).catch(() => null);
const slugs = new Set((res?.endpoints || []).map((e) => e.slug));
ok(slugs.size > 400, `live catalog readable (${slugs.size} slugs) - boot the server or set TARGET_URL`);
for (const [slug, text] of Object.entries(BAZAAR_DESCRIPTIONS)) {
  // A tool switched off on this boot keeps its copy for when it is listed again.
  const gatedOff = !rugcheckEnabled() && RUGCHECK_SLUGS.has(slug);
  ok(slugs.has(slug) || gatedOff, `curated description key "${slug}" is a real catalog slug`);
  ok(text.length <= BAZAAR_DESCRIPTION_MAX && text.length >= 120, `${slug}: ${text.length} chars (120..${BAZAAR_DESCRIPTION_MAX})`);
  ok(/Use it|use it|Use this/.test(text), `${slug}: says WHEN to use it`);
  ok(!text.includes("—"), `${slug}: no em dashes`);
  ok(!/untrustedContent|\/api\/|see also/i.test(text), `${slug}: no internal cross-references / schema jargon`);
}
// the flagships all have curated copy
for (const must of ["search", "answer", "extract", "render", "vin-decode", "geo-lookup", "hash", "sql-guard", "route-execute", "v1-chat-auto", "v1-embeddings", "image-ocr", "memory-write"]) ok(!!BAZAAR_DESCRIPTIONS[must], `flagship ${must} has curated Bazaar copy`);
// generic cap behaviour
const long = "A".repeat(298) + ". " + "B".repeat(600);
ok(bazaarCapDescription(long) === "A".repeat(298) + ".", "cap: truncates at the last sentence end under 500 (when it sits past the halfway mark)");
ok(bazaarCapDescription("Cryptographically secure randomness. ?bytes=1..1024 returns hex; or ?min=&max= returns a uniform integer; ?count=1..100.") === "Cryptographically secure randomness.", "cap: a trailing query-parameter hint is dropped from the Bazaar copy");
ok(bazaarCapDescription("Generate UUIDs. ?version=4 (default, random) or 7 (time-ordered), ?count=1..100.") === "Generate UUIDs.", "cap: ...whatever punctuation precedes it");
ok(bazaarCapDescription("A short sentence with no hint.") === "A short sentence with no hint.", "cap: text without a hint is untouched");
ok(bazaarCapDescription("Current time, optionally rendered in any IANA timezone via ?tz=America/New_York.") === "Current time, optionally rendered in any IANA timezone.", "cap: a preposition left dangling by the hint goes with it");
ok(bazaarCapDescription("Screens a page cheaply. Query params: ?url=, ?fullPage=true.") === "Screens a page cheaply.", "cap: a sentence that only introduces the hint goes with it");
ok(bazaarCapDescription("Tiny. " + "word ".repeat(200)).length <= 500 && !bazaarCapDescription("Tiny. " + "word ".repeat(200)).includes("..."), "cap: an early-only sentence end is not preferred over keeping text; falls back to a word boundary");
const words = "word ".repeat(200).trim();
const capped = bazaarCapDescription(words);
ok(capped.length <= BAZAAR_DESCRIPTION_MAX && capped.endsWith("word.") && !capped.includes("..."), `cap: word boundary + period, never mid-word '...' (${capped.length} chars)`);
ok(bazaarCapDescription("short") === "short" && bazaarCapDescription("") === "", "cap: short/empty untouched");
// The per-route 402 budget: under it nothing changes; over it the route gives
// up input descriptions first, then description length, then its sample output.
{
  const declare = (b) => ({ bazaar: { info: { input: b.input, output: b.output }, schema: { input: b.inputSchema } } });
  const long = "A long description sentence about the tool. ".repeat(20).trim();
  const block = {
    input: { values: [1, 2, 3] },
    inputSchema: { properties: { values: { type: "array", description: "x".repeat(400) }, horizon: { type: "number", description: "y".repeat(400) } } },
    output: { type: "json", example: { forecast: Array.from({ length: 40 }, (_, i) => ({ step: i, point: i * 1.5 })) }, schema: { type: "object" } },
  };
  const roomy = fitChallenge(block, long, declare, 1_000_000);
  ok(roomy.trimmed.length === 0 && roomy.slim === block && roomy.description === long, "budget: a route under it keeps its block and description untouched");
  const one = fitChallenge(block, long, declare, JSON.stringify(declare(block)).length + long.length - 100);
  ok(one.trimmed[0] === "input-descriptions" && !JSON.stringify(one.slim.inputSchema).includes("xxxx") && one.slim.inputSchema.properties.values.type === "array" && one.slim.output.example === block.output.example && one.description === long,
    "budget: the input side gives way first; the description, names, types and the sample output stay");
  const all = fitChallenge(block, long, declare, 200);
  ok(all.trimmed.join() === "input-descriptions,input-types-only,description,output-example" && all.description.length <= CHALLENGE_SHORT_DESCRIPTION_MAX && isExamplePointer(all.slim.output.example) && all.slim.output.schema === undefined && all.slim.inputSchema.properties.values.type === "array",
    "budget: input detail goes before the description and the sample output, which go last (the pointer takes the output schema with it)");
  // A tool's own sample output can carry a "truncated" field (a paged list): it is still trimmed.
  const paged = { ...block, output: { type: "json", example: { truncated: true, results: Array.from({ length: 60 }, (_, i) => ({ id: i })) } } };
  ok(isExamplePointer(fitChallenge(paged, "short", declare, 200).slim.output.example), "budget: a sample output with its own truncated field is still replaced by the pointer");
  // A long string in the input example (an inline image) gives way last; short fields stay.
  const inline = { input: { prompt: "an apple", image: "data:image/png;base64," + "A".repeat(1200) }, output: { type: "json", example: { ok: true } } };
  const fitInline = fitChallenge(inline, "short", declare, 300);
  ok(fitInline.trimmed.includes("input-example-strings") && fitInline.slim.input.prompt === "an apple" && fitInline.slim.input.image.length < 100 && /openapi/.test(fitInline.slim.input.image),
    "budget: a long input example string becomes a pointer to /openapi.json, and short fields stay");
  ok(fitChallenge(null, "short", declare, 10).slim === null, "budget: a route with no discovery block only shortens its description");
}
const live = (res?.endpoints || []).map((e) => e.description || "");
ok(live.length > 0, "catalog descriptions readable");
// The x402 serviceName: printable ASCII, at most SERVICE_NAME_MAX (the
// protocol's ResourceInfoSchema ceiling), and a cut name ends on a whole
// clause: no bracket left open, no dangling separator or connective.
{
  const { ResourceInfoSchema } = await import("@x402/core/schemas");
  ok(SERVICE_NAME_MAX === 32, `serviceName ceiling matches ResourceInfoSchema (got ${SERVICE_NAME_MAX})`);
  ok(x402ServiceName("Chat completions - metered (pay what the call costs)") === "Chat completions - metered", `the metered chat name ends on a whole clause (got ${JSON.stringify(x402ServiceName("Chat completions - metered (pay what the call costs)"))})`);
  ok(x402ServiceName("EDGAR company lookup (ticker \u2192 CIK)") === "EDGAR company lookup", "an arrow is normalized and the open aside dropped");
  ok(x402ServiceName("Short name (with aside)") === "Short name (with aside)", "a name under the ceiling is kept whole");
  ok(x402ServiceName("Alpha beta gamma delta epsilon zeta") === "Alpha beta gamma delta epsilon", "a cut on a word boundary keeps whole words");
  ok(x402ServiceName("Weather forecast and air quality for any city") === "Weather forecast and air quality", "a cut that ends on a word end keeps the word");
  ok(x402ServiceName("SQL statement guard with signed verdict") === "SQL statement guard", "a cut inside a clause backs off to its last connective");
  ok(x402ServiceName("Rate a call you paid for") === "Rate a call you paid for", "a name under the ceiling ending on a connective is kept whole");
  ok(x402ServiceName("") === "Agent402.tools" && x402ServiceName("\u2603") === "Agent402.tools", "an empty or non-ASCII-only name falls back to the host name");
  const unbalanced = (s) => { let d = 0; for (const c of s) { if (c === "(") d++; else if (c === ")") d = Math.max(0, d - 1); } return d !== 0; };
  const names = (res?.endpoints || []).map((e) => e.name).filter((n) => typeof n === "string" && n.trim());
  ok(names.length > 400, `catalog names readable (${names.length})`);
  let bad = [];
  for (const n of names) {
    const sn = x402ServiceName(n);
    if (!ResourceInfoSchema.safeParse({ url: "https://x.test/a", serviceName: sn }).success) { bad.push(`${n} -> ${sn}`); continue; }
    if (sn.length === n.trim().length) continue; // kept whole: the tool's own name
    if (unbalanced(sn) || /[\s\-,:;/&+|]$/.test(sn) || /\s(and|or|of|for|to|the|a|an|with|by|in|on)$/i.test(sn)) bad.push(`${n} -> ${sn}`);
  }
  ok(bad.length === 0, `every catalog serviceName is valid and ends on a whole clause (${bad.length} not: ${bad.slice(0, 5).join(" | ")})`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
