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
for (const must of ["search", "answer", "extract", "render", "vin-decode", "geo-lookup", "hash", "sql-guard", "route-execute", "v1-chat-auto", "v1-embeddings", "image-ocr", "memory-write", "memory-read"]) ok(!!BAZAAR_DESCRIPTIONS[must], `flagship ${must} has curated Bazaar copy`);
// memory-read's listing: the catalog text is mostly query hints, so the
// curated copy says what a read returns and whose namespace it reads.
{
  const mr = BAZAAR_DESCRIPTIONS["memory-read"] || "";
  ok(bazaarCapDescription(mr) === mr && /paying wallet/.test(mr) && /omit it to list/.test(mr) && /own namespace by default/.test(mr) && /granted/.test(mr) && !/\?[a-z]+=/.test(mr), "memory-read: curated copy reads whole and names the key read, the key list, the payer's own namespace and a granted one");
}
// The cut runs in linear time: long runs of whitespace, separators or hints
// (100,000 characters each) are cut in well under the bound, where a pattern
// that rescans a run from each of its positions takes seconds.
{
  const N = 100_000, BOUND_MS = 250;
  const hostile = {
    spaces: " ".repeat(N), "spaces then an open hint": `a${" ".repeat(N)}(?x=1`, "spaces between words": `a${" ".repeat(N)}b`,
    "a hint then spaces": `word ?x=1${" ".repeat(N)}z`, "a sentence head then spaces": `Lorem ipsum dolor sit amet${" ".repeat(N)}x ?a=1`,
    "a sentence head then commas": `Lorem ipsum dolor sit amet${",".repeat(N)}x ?a=1`, "a head then a lead-in word run": `Lorem ipsum dolor sit amet${" via".repeat(N / 4)} ?a=1`,
    "open hints": "(?a=".repeat(N / 4), "hint keys": "?a=".repeat(N / 3), "sentence ends": ". ".repeat(N / 2) + "?a=1",
    "an attribution tail after spaces": `${" ".repeat(N)}This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.`,
  };
  for (const [name, text] of Object.entries(hostile)) {
    const t0 = performance.now();
    bazaarCapDescription(text);
    bazaarCapDescription(text, CHALLENGE_SHORT_DESCRIPTION_MAX);
    const ms = performance.now() - t0;
    ok(ms < BOUND_MS, `cap: ${name} (${text.length} chars) is cut in ${ms.toFixed(1)} ms (under ${BOUND_MS})`);
  }
}
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
ok(bazaarCapDescription("Series data. ?id=GDPC1&units=pc1. This product is not endorsed by the Federal Reserve Bank of St. Louis.") === "Series data. This product is not endorsed by the Federal Reserve Bank of St. Louis.", "cap: a hint that ends its own sentence goes alone, and the notice after it stays");
// The FRED terms require their notice on every surface that serves the data.
// The set of FRED routes is derived from code, not from which text already
// carries the notice: the macro kit's functions that reach a FRED host,
// closed over the calls between them, and every tool whose handler calls one.
// Each must carry attribution "fred", end its catalog text with the notice,
// and keep it in its listing at the Bazaar cut and at the 402 budget's
// shorter cut (the most any 402, with any upto networks on, cuts it to).
{
  const { FRED_NOTICE, attributionTailOf } = await import("../src/data-attribution.js");
  const { MACRO_TOOLS } = await import("../src/tools/macro-kit.js");
  const { readdir } = await import("node:fs/promises");
  const FRED_HOST = /stlouisfed\.org/;
  const kitSrc = await readFile(new URL("../src/tools/macro-kit.js", import.meta.url), "utf8");
  const fns = new Map();
  for (const m of kitSrc.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)) {
    const close = kitSrc.indexOf("\n}\n", m.index);
    fns.set(m[1], kitSrc.slice(m.index, close < 0 ? undefined : close));
  }
  const reached = new Set(["FRED_BASE"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of fns) {
      if (reached.has(name)) continue;
      if (FRED_HOST.test(body) || [...reached].some((r) => new RegExp(`\\b${r}\\b`).test(body.slice(body.indexOf("{"))))) { reached.add(name); grew = true; }
    }
  }
  ok(["fredObservations", "fetchFredYields", "fetchLatestYieldCurve", "fetchFredYieldsViaKeyedApi"].every((n) => reached.has(n)), `FRED-reaching functions derived from the kit (${[...reached].join(", ")})`);
  const callsFred = (t) => { const h = String(t.handler); return FRED_HOST.test(h) || [...reached].some((r) => new RegExp(`\\b${r}\\b`).test(h)); };
  const derived = MACRO_TOOLS.filter(callsFred).map((t) => t.slug).sort();
  const marked = MACRO_TOOLS.filter((t) => t.attribution === "fred").map((t) => t.slug).sort();
  ok(derived.length >= 12 && JSON.stringify(derived) === JSON.stringify(marked), `every tool whose handler reaches FRED carries attribution "fred", and only those (derived ${derived.join(",")}; marked ${marked.join(",")})`);
  const otherKits = [];
  for (const file of await readdir(new URL("../src/tools/", import.meta.url))) {
    if (!file.endsWith(".js") || file === "macro-kit.js") continue;
    if (FRED_HOST.test(await readFile(new URL(`../src/tools/${file}`, import.meta.url), "utf8"))) otherKits.push(file);
  }
  ok(otherKits.length === 0, `no other kit calls a FRED host directly (${otherKits.join(", ") || "none"})`);
  for (const t of MACRO_TOOLS.filter((x) => x.attribution === "fred")) {
    ok(attributionTailOf(t.description) === FRED_NOTICE, `${t.slug}: the catalog text ends with the FRED notice`);
    const listed = bazaarCapDescription(BAZAAR_DESCRIPTIONS[t.slug] || t.description);
    const cut = bazaarCapDescription(listed, CHALLENGE_SHORT_DESCRIPTION_MAX);
    ok(listed.endsWith(FRED_NOTICE) && cut.endsWith(FRED_NOTICE) && cut.length <= CHALLENGE_SHORT_DESCRIPTION_MAX, `${t.slug}: the listing keeps the FRED notice at both cuts (${listed.length} / ${cut.length} chars)`);
    const live = (res?.endpoints || []).find((e) => e.slug === t.slug);
    ok(!live || String(live.description || "").endsWith(FRED_NOTICE), `${t.slug}: the live catalog text ends with the notice`);
  }
  // The cut keeps a trailing attribution sentence for any route: the text
  // before it is shortened at a sentence end, and the notice is never cut.
  const lead = "A first sentence about the data that runs on for a while. A second sentence that adds detail and runs on further than the cut allows here.";
  const kept = bazaarCapDescription(`${lead} ${FRED_NOTICE}`, 200);
  ok(kept === `A first sentence about the data that runs on for a while. ${FRED_NOTICE}`, `cut: a trailing attribution sentence stays whole and the text before it is cut at a sentence (got ${JSON.stringify(kept)})`);
  ok(bazaarCapDescription(`${lead} Not the notice.`, 200).endsWith("allows here.") === false, "cut: text without an attribution tail is cut as before");
}
// Every source whose terms require an attribution (src/data-attribution.js):
// the set is read from code, the tools' `attribution` marks across every kit
// and the tools each skill pack runs, never from which text already carries a
// sentence. A marked tool's catalog text, its curated copy (if any) and its
// listing at both cuts end with its sentence; a pack's do the same with the
// sentences of every source its tools serve; and text that ends with a
// sentence belongs to a tool marked with it.
{
  const { ATTRIBUTIONS, attributionTailOf } = await import("../src/data-attribution.js");
  const { readdir } = await import("node:fs/promises");
  const { buildSkillTools } = await import("../src/tools/skill-runner.js");
  const { SKILL_PACKS } = await import("../src/skills.js");
  const SENTENCES = Object.values(ATTRIBUTIONS);
  const tools = new Map();
  for (const file of (await readdir(new URL("../src/tools/", import.meta.url))).filter((f) => f.endsWith(".js") && !/-worker\.js$/.test(f)).sort()) {
    const mod = await import(new URL(`../src/tools/${file}`, import.meta.url));
    for (const v of Object.values(mod)) if (Array.isArray(v)) for (const t of v) if (t && typeof t === "object" && typeof t.slug === "string" && typeof t.route === "string" && typeof t.description === "string" && !tools.has(t.slug)) tools.set(t.slug, t);
  }
  const live = new Map((res?.endpoints || []).map((e) => [e.slug, e]));
  const listingEnds = (slug, text, want) => {
    const listed = bazaarCapDescription(BAZAAR_DESCRIPTIONS[slug] || text);
    const cut = bazaarCapDescription(listed, CHALLENGE_SHORT_DESCRIPTION_MAX);
    const keeps = (x) => { const tail = attributionTailOf(x) || ""; return want.every((w) => tail.includes(w)) && x.endsWith(want[want.length - 1]); };
    return { ok: keeps(listed) && keeps(cut) && cut.length <= CHALLENGE_SHORT_DESCRIPTION_MAX, listed, cut };
  };
  const bySource = {};
  const unknownKeys = [], unmarkedTails = [], midText = [];
  for (const t of tools.values()) {
    const tail = attributionTailOf(t.description);
    for (const sentence of SENTENCES) if (t.description.includes(sentence) && !(tail || "").includes(sentence)) midText.push(t.slug);
    if (t.attribution === undefined) { if (tail) unmarkedTails.push(t.slug); continue; }
    const want = ATTRIBUTIONS[t.attribution];
    if (!want) { unknownKeys.push(`${t.slug}=${t.attribution}`); continue; }
    (bySource[t.attribution] ||= []).push(t.slug);
    ok(tail === want, `${t.slug}: the catalog text ends with the ${t.attribution} attribution`);
    if (BAZAAR_DESCRIPTIONS[t.slug]) ok(attributionTailOf(BAZAAR_DESCRIPTIONS[t.slug]) === want, `${t.slug}: the curated listing copy ends with the ${t.attribution} attribution`);
    const r = listingEnds(t.slug, t.description, [want]);
    ok(r.ok, `${t.slug}: the listing keeps the ${t.attribution} attribution at both cuts (${r.listed.length} / ${r.cut.length} chars)`);
    const e = live.get(t.slug);
    ok(!e || attributionTailOf(String(e.description || "")) === want, `${t.slug}: the live catalog text ends with the ${t.attribution} attribution`);
  }
  ok(unknownKeys.length === 0, `every tool attribution names a known source (${unknownKeys.join(", ") || "none unknown"})`);
  ok(unmarkedTails.length === 0, `text that ends with an attribution belongs to a tool marked with that source (${unmarkedTails.join(", ") || "none unmarked"})`);
  ok(midText.length === 0, `no attribution sentence sits anywhere but the end of a description (${midText.join(", ") || "none"})`);
  const counts = Object.fromEntries(Object.keys(ATTRIBUTIONS).map((k) => [k, (bySource[k] || []).length]));
  ok(Object.values(counts).every((n) => n > 0) && counts.fred >= 12 && counts.coingecko >= 24 && counts.jupiter >= 5, `every source is marked on the tools that serve it (${JSON.stringify(counts)})`);
  // Skill packs: the sources of the tools each pack runs, in pack order.
  const catalog = Object.fromEntries([...tools.values()].map((t) => [t.route, t]));
  const packTools = new Map(buildSkillTools({ getCatalog: () => catalog }).map((t) => [t.slug, t]));
  let packsWithSources = 0;
  for (const pack of SKILL_PACKS) {
    const keys = [...new Set(pack.toolSlugs.map((s) => tools.get(s)?.attribution).filter(Boolean))];
    const def = packTools.get(`skill-${pack.slug}`);
    const tail = attributionTailOf(def?.description || "") || "";
    if (!keys.length) { ok(!tail, `skill-${pack.slug}: no tool it runs needs an attribution, and its text carries none`); continue; }
    packsWithSources++;
    const want = keys.map((k) => ATTRIBUTIONS[k]);
    ok(want.every((w) => tail.includes(w)) && tail.length === want.join(" ").length, `skill-${pack.slug}: the pack text ends with the ${keys.join(" + ")} attribution`);
    const r = listingEnds(def.slug, def.description, want);
    ok(r.ok, `skill-${pack.slug}: the listing keeps the ${keys.join(" + ")} attribution at both cuts (${r.listed.length} / ${r.cut.length} chars)`);
    const e = live.get(def.slug);
    ok(!e || attributionTailOf(String(e.description || "")) === tail, `skill-${pack.slug}: the live catalog text ends with the same attribution`);
  }
  ok(packsWithSources >= 10, `the packs whose tools need an attribution are read from their steps (${packsWithSources})`);
  // The cut keeps a run of two sentences whole, as a two-source pack needs.
  const two = `${ATTRIBUTIONS.fred} ${ATTRIBUTIONS.coingecko}`;
  const kept2 = bazaarCapDescription(`${lead2()} ${two}`, CHALLENGE_SHORT_DESCRIPTION_MAX);
  ok(kept2.endsWith(two) && kept2.length <= CHALLENGE_SHORT_DESCRIPTION_MAX && attributionTailOf(kept2) === two, `cut: a run of two attribution sentences stays whole (got ${JSON.stringify(kept2.slice(-80))})`);
  function lead2() { return "A first sentence about the data that runs on for a while. ".repeat(8).trim(); }
  // Over the 402 budget, a listing that ends with an attribution cuts its lead
  // further before it gives up its sample output, and keeps the sentence.
  const declare = (bl) => ({ bazaar: { info: { input: bl.input, output: bl.output } } });
  const block = { input: { q: "x" }, output: { type: "json", example: { rows: [1, 2, 3, 4, 5, 6, 7, 8] } } };
  const text = `${lead2()} ${ATTRIBUTIONS.openstreetmap}`;
  const short = bazaarCapDescription(text, CHALLENGE_SHORT_DESCRIPTION_MAX);
  const budget = JSON.stringify(declare(block)).length + short.length - 40;
  const f = fitChallenge(block, text, declare, budget);
  ok(f.trimmed.includes("description-lead") && !isExamplePointer(f.slim.output.example) && f.description.endsWith(ATTRIBUTIONS.openstreetmap) && f.bytes <= budget,
    `budget: an attributed listing shortens its lead, keeps the sentence and its sample output (${f.trimmed.join()}; ${f.description.length} chars)`);
  const tight = fitChallenge(block, text, declare, JSON.stringify(declare(block)).length + 60);
  ok(isExamplePointer(tight.slim.output.example) && tight.description.endsWith(ATTRIBUTIONS.openstreetmap), "budget: with no room for a lead the sample output gives way and the sentence stays");
}
{
  const { bazaarTagsFor, BAZAAR_ICON_PATH } = await import("../src/payments.js");
  ok(JSON.stringify(bazaarTagsFor({ category: "time", tags: ["schedule"], slug: "cron-next" })) === JSON.stringify(["time", "schedule", "cron-next", "agents", "x402"]), "tags: category, own tags, then the slug, and a filler only when those run out");
  ok(JSON.stringify(bazaarTagsFor({ category: "skill-pack", tags: ["workflow", "fixed-income-desk"], slug: "skill-fixed-income-desk" })) === JSON.stringify(["skill-pack", "workflow", "fixed-income-desk", "agents", "x402"]), "tags: a slug that holds an existing tag (skill-fixed-income-desk beside fixed-income-desk) is not repeated");
  ok(!bazaarTagsFor({ category: "crypto", tags: ["price", "spot"], slug: "price-coingecko" }).includes("price-coingecko"), "tags: a slug that is a tag plus the data source's name is not repeated");
  ok(bazaarTagsFor({ category: "math", tags: ["percent"], slug: "percentage" }).includes("percentage"), "tags: a tag inside a slug's word (percent in percentage) is not a repeat");
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
