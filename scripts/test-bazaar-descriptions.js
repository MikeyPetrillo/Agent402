// Bazaar listing copy guard: every curated description names a real catalog
// slug, fits the Bazaar's 500-char cap, reads as what+when (no internal
// cross-references the Bazaar reader cannot follow), no em dashes; the
// generic cap truncates at a sentence/word boundary, never mid-word "...".
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFile } from "node:fs/promises";
import { BAZAAR_DESCRIPTIONS, BAZAAR_DESCRIPTION_MAX, bazaarCapDescription, fitChallenge, CHALLENGE_SHORT_DESCRIPTION_MAX, isExamplePointer, x402ServiceName, x402ServiceNames, SERVICE_NAME_MAX, catalogServiceNameFor } from "../src/payments.js";
import { RUGCHECK_SLUGS, rugcheckEnabled } from "../src/tools/solana-intel-kit.js";
import { JUDGE_TOOLS, judgeEnabled } from "../src/tools/judge-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const res = await fetch(`${process.env.TARGET_URL || "http://127.0.0.1:3000"}/api/pricing`).then((r) => r.json()).catch(() => null);
const slugs = new Set((res?.endpoints || []).map((e) => e.slug));
ok(slugs.size > 400, `live catalog readable (${slugs.size} slugs) - boot the server or set TARGET_URL`);
for (const [slug, text] of Object.entries(BAZAAR_DESCRIPTIONS)) {
  // A tool switched off on this boot keeps its copy for when it is listed again.
  const gatedOff = (!rugcheckEnabled() && RUGCHECK_SLUGS.has(slug)) || (!judgeEnabled() && JUDGE_TOOLS.some((t) => t.slug === slug));
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
// A hint drops itself, not the sentences after it (the listing keeps what it says).
ok(bazaarCapDescription("Read from a store. ?key=k returns the value; omit key to list keys. Keys expire on their TTL. Reads your own store by default; add ?owner=0x1 to read a granted one.") === "Read from a store. Keys expire on their TTL. Reads your own store by default.",
  `cap: a sentence opening with a hint goes, later sentences stay, and a hint clause after a semicolon goes with its clause (got ${JSON.stringify(bazaarCapDescription("Read from a store. ?key=k returns the value; omit key to list keys. Keys expire on their TTL. Reads your own store by default; add ?owner=0x1 to read a granted one."))})`);
ok(bazaarCapDescription("Look up a MIME type by file extension (?ext=png) or extensions by MIME type (?type=image/png). Covers ~50 common types.") === "Look up a MIME type by file extension or extensions by MIME type. Covers ~50 common types.", "cap: a hint in parentheses is removed in place");
ok(bazaarCapDescription("Series data. ?id=GDPC1&units=pc1 This product is not endorsed by the Federal Reserve Bank of St. Louis.") === "Series data.", "cap: an abbreviation (St.) does not end a sentence, so no fragment is left behind");
{
  const { bazaarTagsFor, BAZAAR_ICON_PATH } = await import("../src/payments.js");
  ok(JSON.stringify(bazaarTagsFor({ category: "time", tags: ["cron", "schedule"], slug: "cron-next" })) === JSON.stringify(["time", "cron", "schedule", "cron-next", "agents"]), "tags: category, own tags, then the slug, and a filler only when those run out");
  ok(bazaarTagsFor({ category: "web", tags: ["a", "b", "c", "d", "e"], slug: "s" }).length === 5, "tags: at most five");
  ok(/\.(?:png|jpe?g|webp|gif)$/.test(BAZAAR_ICON_PATH), `icon: the listing icon path names a format the Bazaar lists (${BAZAAR_ICON_PATH})`);
}
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
  // descriptionFirst (the typed-judgment kits): past the input descriptions the
  // sample output points to /openapi.json before the input's types-only cut or
  // the description; a block that fits once the output is a pointer keeps both.
  {
    const enumBlock = { ...block, inputSchema: { properties: { model: { type: "string", enum: ["a", "b"], description: "z".repeat(300) } } } };
    const noOut = JSON.stringify(declare({ ...enumBlock, inputSchema: { properties: { model: { type: "string", enum: ["a", "b"] } } }, output: { type: "json", example: { truncated: true, note: "full example in /openapi.json" } } })).length;
    const df = fitChallenge(enumBlock, long, declare, noOut + long.length, { descriptionFirst: true });
    ok(df.trimmed.join() === "input-descriptions,output-example" && df.description === long && JSON.stringify(df.slim.inputSchema.properties.model.enum) === '["a","b"]' && isExamplePointer(df.slim.output.example),
      `budget: descriptionFirst gives the sample output up before the input enum and the description (got ${df.trimmed.join()})`);
    const plain = fitChallenge(enumBlock, long, declare, noOut + long.length);
    ok(plain.trimmed.includes("input-types-only") || plain.trimmed.includes("description"), "budget: without descriptionFirst the same block cuts the input or the description first");
    const roomyDf = fitChallenge(enumBlock, long, declare, 1_000_000, { descriptionFirst: true });
    ok(roomyDf.trimmed.length === 0 && roomyDf.slim.output.example === block.output.example, "budget: descriptionFirst under the budget keeps the real sample output");
  }
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
  const catalogNames = x402ServiceNames(names);
  let bad = [];
  for (const n of names) {
    const sn = catalogNames.get(n);
    if (!ResourceInfoSchema.safeParse({ url: "https://x.test/a", serviceName: sn }).success) { bad.push(`${n} -> ${sn}`); continue; }
    if (sn.length === n.trim().length) continue; // kept whole: the tool's own name
    if (unbalanced(sn) || /[\s\-,:;/&+|]$/.test(sn) || /\s(and|or|of|for|to|the|a|an|with|by|in|on)$/i.test(sn)) bad.push(`${n} -> ${sn}`);
  }
  ok(bad.length === 0, `every catalog serviceName is valid and ends on a whole clause (${bad.length} not: ${bad.slice(0, 5).join(" | ")})`);
  // NO NEW COLLISIONS. The cut before the whole-clause rule (frozen here):
  // two catalog names it told apart must still read apart, so a tier family
  // keeps its tier word ("Gemini generateContent nano").
  const oldCut = (raw) => {
    const clean = String(raw).replace(/[\u2192\u2794\u27a1]/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return "Agent402.tools";
    if (clean.length <= 32) return clean;
    return clean.slice(0, 32).replace(/\s+\S*$/, "").trim() || clean.slice(0, 32);
  };
  const uniq = [...new Set(names)];
  const merged = [];
  const byNew = new Map();
  for (const n of uniq) { const k = catalogNames.get(n); byNew.set(k, [...(byNew.get(k) || []), n]); }
  for (const [k, group] of byNew) {
    const olds = new Set(group.map(oldCut));
    if (olds.size > 1) merged.push(`${k} <- ${group.join(" / ")}`);
  }
  ok(merged.length === 0, `no two catalog entries the old serviceNames kept apart share a new one (${merged.length}: ${merged.slice(0, 3).join(" | ")})`);
  const gem = ["nano", "auto", "base", "pro", "premium", "metered"].map((t) => `Gemini generateContent (${t} tier)`);
  const gemMap = x402ServiceNames(gem);
  ok(gemMap.get(gem[0]) === "Gemini generateContent nano" && new Set(gem.map((g) => gemMap.get(g))).size === gem.length, `a tier family keeps its tier word (got ${JSON.stringify(gem.map((g) => gemMap.get(g)))})`);
  // A tag is the tool's own words: a hyphenated word is never split, and a
  // capitalized modifier never leaves the noun it modifies, so no listing
  // carries a vendor word its own name does not attach to it.
  const pair = x402ServiceNames(["Image generation", "Image generation (OpenAI-compatible)"]);
  ok(pair.get("Image generation") === "Image generation" && pair.get("Image generation (OpenAI-compatible)") === "Image OpenAI-compatible", `a hyphenated tag stays whole and the cut gives way (got ${JSON.stringify([...pair.values()])})`);
  const stt = x402ServiceNames(["Speech-to-text", "Speech-to-text (OpenAI transcription wire)"]);
  ok(stt.get("Speech-to-text") === "Speech-to-text" && !/OpenAI$/.test(stt.get("Speech-to-text (OpenAI transcription wire)")) && stt.get("Speech-to-text (OpenAI transcription wire)") !== "Speech-to-text", `a capitalized modifier is not a tag on its own (got ${JSON.stringify([...stt.values()])})`);
  // Only a name that still collides is tagged: a sibling told apart by its own
  // lead word is tagged, and the other keeps the shared cut.
  const dd = ["Company due-diligence dossier (grounded, cited)", "Company due-diligence dossier - MAX (exhaustive)"];
  const ddMap = x402ServiceNames(dd);
  ok(ddMap.get(dd[0]) === "Company due-diligence dossier" && /MAX$/.test(ddMap.get(dd[1])), `a name whose sibling is told apart keeps its cut untagged (got ${JSON.stringify(dd.map((d) => ddMap.get(d)))})`);
  const tr = ["Token & contract risk report (on-chain evidence)", "Token & contract risk report - PRO (static scan + reputation)"];
  const trMap = x402ServiceNames(tr);
  ok(trMap.get(tr[0]) === "Token & contract risk report" && trMap.get(tr[1]) === "Token & contract risk report PRO", `and so does the token risk report (got ${JSON.stringify(tr.map((d) => trMap.get(d)))})`);
  // A cut that enters a clause after a comma drops back to the comma.
  const li = "LinkedIn article, ready to publish (research + copy + sized images)";
  ok(x402ServiceName(li) === "LinkedIn article", `a cut inside a comma clause ends on the phrase before it (got ${JSON.stringify(x402ServiceName(li))})`);
  // A list is never cut to its first item, which would read as the whole
  // product: two or more whole items, else the label before a colon.
  for (const [raw, want] of [
    ["Ticker pack: dossier, insider flow and institutional holders", "Ticker pack"],
    ["Bundle: quotes, bars, trades and corporate actions", "Bundle: quotes, bars, trades"],
  ]) {
    const got = x402ServiceName(raw);
    ok(got === want && got.length <= SERVICE_NAME_MAX, `a list keeps whole items or its label: ${JSON.stringify(raw)} -> ${JSON.stringify(want)} (got ${JSON.stringify(got)})`);
  }
  // Across the catalog: a name that fits whole is kept whole, every word of a
  // serviceName is a whole word of its own name, and no two names share one.
  const wordSet = (t) => new Set(String(t).replace(/[\u2192\u2794\u27a1]/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/[()[\]{},;:+]/g, " ").split(/\s+/).filter(Boolean));
  const notWhole = [], foreign = [], seen = new Map(), dup = [];
  for (const n of uniq) {
    const clean = n.replace(/[\u2192\u2794\u27a1]/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
    const sn = catalogNames.get(n);
    if (clean.length <= SERVICE_NAME_MAX && sn !== clean) notWhole.push(`${n} -> ${sn}`);
    const own = wordSet(clean);
    if ([...wordSet(sn)].some((w) => !own.has(w) && !own.has(w.replace(/[,:;.\-]+$/, "")))) foreign.push(`${n} -> ${sn}`);
    if (seen.has(sn) && seen.get(sn) !== n) dup.push(`${sn} <- ${seen.get(sn)} / ${n}`); else seen.set(sn, n);
  }
  ok(notWhole.length === 0, `every name that fits is kept whole (${notWhole.length}: ${notWhole.slice(0, 3).join(" | ")})`);
  ok(foreign.length === 0, `every serviceName word is a whole word of its own name (${foreign.length}: ${foreign.slice(0, 3).join(" | ")})`);
  ok(dup.length === 0, `no two catalog names share a serviceName (${dup.length}: ${dup.slice(0, 3).join(" | ")})`);
  // The middleware lists each route under the catalog-settled name
  // (catalogServiceNameFor), so a tier family's routes read apart.
  {
    const cat = Object.fromEntries([...gem, "Image generation", "Image generation (OpenAI-compatible)"].map((n, i) => [`POST /r${i}`, { name: n }]));
    const nameFor = catalogServiceNameFor(cat);
    const listed = Object.values(cat).map(nameFor);
    ok(new Set(listed).size === listed.length, `the middleware's serviceNames are distinct across a catalog (got ${JSON.stringify(listed)})`);
    ok(nameFor({ name: "" }) === "Agent402.tools" && nameFor({}) === "Agent402.tools", "an item with no name lists under the host name");
    const src = await readFile(new URL("../src/payments.js", import.meta.url), "utf8");
    const mw = src.slice(src.indexOf("export async function buildPaymentMiddleware("));
    ok(/const serviceNameFor = catalogServiceNameFor\(catalog\);/.test(mw) && /serviceName: serviceNameFor\(item\)/.test(mw), "buildPaymentMiddleware lists routes through catalogServiceNameFor(catalog)");
  }
  // The Bazaar refresh compares each listing with that derived name, not the
  // raw catalog name (which reads stale for every name over 32 characters).
  {
    const { expectedServiceNamesByPath } = await import("./refresh-bazaar.js");
    const eps = (res?.endpoints || []).filter((e) => e?.path);
    const want = await expectedServiceNamesByPath(eps);
    const long = eps.find((e) => typeof e.name === "string" && e.name.length > SERVICE_NAME_MAX);
    ok(long && want.get(long.path) === catalogNames.get(long.name) && want.get(long.path).length <= SERVICE_NAME_MAX, `a long name's expected Bazaar name is its serviceName (${long?.name} -> ${long && want.get(long.path)})`);
    const src = await readFile(new URL("./refresh-bazaar.js", import.meta.url), "utf8");
    ok(/expected = await expectedServiceNamesByPath\(/.test(src.slice(src.indexOf("async function loadStaleRoutes"))), "the stale scan reads expectedServiceNamesByPath");
  }
  ok(x402ServiceNames(["Chat completions - metered (pay what the call costs)"]).get("Chat completions - metered (pay what the call costs)") === "Chat completions - metered", "a name with no sibling keeps its whole-clause cut");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
