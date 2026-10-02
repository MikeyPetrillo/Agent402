// Bazaar listing copy guard: every curated description names a real catalog
// slug, fits the Bazaar's 500-char cap, reads as what+when (no internal
// cross-references the Bazaar reader cannot follow), no em dashes; the
// generic cap truncates at a sentence/word boundary, never mid-word "...".
import { BAZAAR_DESCRIPTIONS, BAZAAR_DESCRIPTION_MAX, bazaarCapDescription } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const res = await fetch(`${process.env.TARGET_URL || "http://127.0.0.1:3000"}/api/pricing`).then((r) => r.json()).catch(() => null);
const slugs = new Set((res?.endpoints || []).map((e) => e.slug));
ok(slugs.size > 400, `live catalog readable (${slugs.size} slugs) - boot the server or set TARGET_URL`);
for (const [slug, text] of Object.entries(BAZAAR_DESCRIPTIONS)) {
  ok(slugs.has(slug), `curated description key "${slug}" is a real catalog slug`);
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
const live = (res?.endpoints || []).map((e) => e.description || "");
ok(live.length > 0, "catalog descriptions readable");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
