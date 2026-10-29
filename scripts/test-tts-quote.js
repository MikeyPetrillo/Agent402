#!/usr/bin/env node
// /api/tts and /api/tts-hd are quoted per request from the text's character
// count (src/tools/tts-kit.js ttsQuoteUsd): floor + rate x chars, rounded UP
// to the next $0.001, the rate derived from two anchors per tier.
//
// What it pins (offline, no upstream):
//   - the anchors: 2,000 chars is the anchor price exactly on both tiers, and
//     the HD tier is twice the standard tier at both anchors;
//   - quotes at 1, 100, 2,000 and 5,000 chars; every quote at every length is
//     a whole $0.001, at or above floor + rate x chars and less than $0.001
//     above it; the floor holds at tiny input; quotes never fall with length;
//   - the quote function reads the object the handler serves (handlerInputOf:
//     envelopes unwrapped, the text trimmed as the handler trims it), and a
//     text over the cap quotes the ceiling, never more;
//   - over-cap text is refused before any model call, by the handler and by
//     the input check the Tempo gate runs before its relay;
//   - the handler refuses a body whose quote is above the price it was gated
//     at, before any model call; at or below it, the call goes through;
//   - the formula in words is on the tool and in its description;
//   - tts-lite stays flat; the dub price is unchanged by the quote.
process.env.OPENROUTER_API_KEY ||= "test-key-never-used";
const { TTS_TOOLS, TTS_TIERS, TTS_QUOTE, TTS_QUOTE_ANCHOR_CHARS, ttsQuoteUsd, ttsQuoteFormula, __resetTtsBreakerForTest } = await import("../src/tools/tts-kit.js");
const { handlerInputOf, preValidateInput } = await import("../src/handler-input.js");
const { DUB_MAX_CHARS, dubPriceUsd } = await import("../src/tools/dub-kit.js");
const { METERED_SLUGS } = await import("../src/metered-slugs.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const bySlug = Object.fromEntries(TTS_TOOLS.map((t) => [t.slug, t]));
const milli = (usd) => Math.round(usd * 1000);
const text = (n) => "x".repeat(n);

// --- the anchors and the published points ------------------------------------
ok(TTS_QUOTE_ANCHOR_CHARS === 2000, "the anchor length is 2,000 characters");
ok(ttsQuoteUsd("tts", 2000) === 0.12 && ttsQuoteUsd("tts-hd", 2000) === 0.24, "2,000 characters quotes exactly $0.120 on tts and $0.240 on tts-hd");
ok(TTS_QUOTE["tts-hd"].floorMilli === 2 * TTS_QUOTE.tts.floorMilli && TTS_QUOTE["tts-hd"].anchorMilli === 2 * TTS_QUOTE.tts.anchorMilli, "tts-hd is twice tts at both anchors");
const expected = { tts: { 1: 0.006, 100: 0.011, 2000: 0.12, 5000: 0.293 }, "tts-hd": { 1: 0.011, 100: 0.022, 2000: 0.24, 5000: 0.585 } };
for (const [slug, points] of Object.entries(expected)) {
  for (const [n, usd] of Object.entries(points)) ok(ttsQuoteUsd(slug, Number(n)) === usd, `${slug}: ${n} chars quotes $${usd.toFixed(3)} (got ${ttsQuoteUsd(slug, Number(n))})`);
}

// --- round-up, floor, monotone, at every length ----------------------------------
for (const slug of ["tts", "tts-hd"]) {
  const { floorMilli, anchorMilli } = TTS_QUOTE[slug];
  const cap = TTS_TIERS[slug].maxChars;
  ok(cap === 5000, `${slug}: the cap is 5,000 characters`);
  let bad = null, prev = 0;
  for (let n = 0; n <= cap && !bad; n++) {
    const q = ttsQuoteUsd(slug, n);
    const exactMilli = floorMilli + ((anchorMilli - floorMilli) * n) / TTS_QUOTE_ANCHOR_CHARS;
    if (Math.abs(q * 1000 - milli(q)) > 1e-9) bad = `${n}: ${q} is not a whole $0.001`;
    else if (milli(q) < exactMilli - 1e-9) bad = `${n}: ${q} is below floor + rate x chars`;
    else if (milli(q) >= exactMilli + 1) bad = `${n}: ${q} rounds up by a full $0.001 or more`;
    else if (q < prev) bad = `${n}: ${q} is below the quote for one character fewer`;
    prev = q;
  }
  ok(!bad, `${slug}: every quote from 0 to ${cap} chars is floor + rate x chars rounded up to the next $0.001, never falling with length${bad ? ` (${bad})` : ""}`);
  ok(ttsQuoteUsd(slug, 0) === floorMilli / 1000 && ttsQuoteUsd(slug, 1) === (floorMilli + 1) / 1000, `${slug}: the floor holds at tiny input (0 chars = floor, 1 char = floor + $0.001)`);
  ok(ttsQuoteUsd(slug, cap + 1000) === ttsQuoteUsd(slug, cap) && bySlug[slug].quoteMaxUsd === ttsQuoteUsd(slug, cap), `${slug}: past the cap the quote is the ceiling (quoteMaxUsd)`);
  ok(bySlug[slug].price === `$${(floorMilli / 1000).toFixed(3)}`, `${slug}: the list price is the floor (${bySlug[slug].price})`);
}

// --- the quote reads what the handler serves -------------------------------------
for (const slug of ["tts", "tts-hd"]) {
  const def = bySlug[slug];
  ok(typeof def.quote === "function", `${slug}: carries a per-request quote`);
  ok(def.quote({ text: text(2000) }) === ttsQuoteUsd(slug, 2000), `${slug}: a 2,000-char body quotes the anchor`);
  ok(def.quote(handlerInputOf({ body: { input: { text: text(2000) } } })) === ttsQuoteUsd(slug, 2000), `${slug}: a body wrapped in an input envelope quotes the same as the flat body`);
  ok(def.quote(handlerInputOf({ query: { text: text(100) }, body: {} })) === ttsQuoteUsd(slug, 100), `${slug}: text sent in the query string is quoted too`);
  ok(def.quote({ text: `   ${text(100)}   ` }) === ttsQuoteUsd(slug, 100), `${slug}: surrounding whitespace is not quoted (the handler trims it)`);
  ok(def.quote({}) === ttsQuoteUsd(slug, 0) && def.quote({ text: 7 }) === ttsQuoteUsd(slug, 0), `${slug}: no text quotes the floor (the handler refuses it uncharged)`);
  ok(def.quoteFormula === ttsQuoteFormula(slug) && def.description.includes(def.quoteFormula), `${slug}: the formula is on the tool and in its description`);
  ok(/^\$0\.0\d+ plus \$0\.\d+ per 1,000 characters of text, rounded up to the next \$0\.001 \(2,000 characters: \$0\.\d{3}\)$/.test(def.quoteFormula), `${slug}: the formula reads "${def.quoteFormula}"`);
  ok(METERED_SLUGS.has(slug), `${slug}: excluded from the catalog sweeps as metered`);
}
ok(typeof bySlug["tts-lite"].quote !== "function" && bySlug["tts-lite"].quoteMaxUsd === undefined, "tts-lite stays flat");
ok(DUB_MAX_CHARS === 2000 && dubPriceUsd("standard") === 0.14 && dubPriceUsd("hd") === 0.26, "the dub keeps its 2,000-char cap and its price (the speech step priced at the cap)");

// --- refusals before any model call ----------------------------------------------
const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = async () => { fetched++; throw new Error("SENTINEL upstream reached"); };
const throwsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
try {
  for (const slug of ["tts", "tts-hd"]) {
    const def = bySlug[slug];
    const cap = TTS_TIERS[slug].maxChars;
    fetched = 0; __resetTtsBreakerForTest();
    let e = await throwsWith(() => def.handler({ text: text(cap + 1) }));
    ok(e?.statusCode === 400 && /Text too long/.test(e.message) && fetched === 0, `${slug}: ${cap + 1} chars is refused 400 before any upstream call`);
    const pre = preValidateInput(def, { method: "POST", path: def.route.split(" ")[1], body: { text: text(cap + 1) }, query: {} });
    ok(pre?.status === 400 && /Text too long/.test(pre.body.error), `${slug}: the pre-relay input check (Tempo gate) refuses it too`);
    ok(preValidateInput(def, { method: "POST", path: def.route.split(" ")[1], body: { text: "hi" }, query: {} }) === null, `${slug}: the pre-relay input check passes a text under the cap`);
    // The belt: gated at the 1-char quote, served a 2,000-char body.
    fetched = 0; __resetTtsBreakerForTest();
    e = await throwsWith(() => def.handler({ text: text(2000) }, { __meteredQuoteUsd: ttsQuoteUsd(slug, 1) }));
    ok(e?.statusCode === 400 && /quoted at \$0\.0\d+ but the text being served quotes \$0\.\d+/.test(e.message) && fetched === 0, `${slug}: a body quoting above the gated price is refused 400 before any upstream call`);
    fetched = 0; __resetTtsBreakerForTest();
    e = await throwsWith(() => def.handler({ text: text(2000) }, { __meteredQuoteUsd: ttsQuoteUsd(slug, 2000) }));
    ok(fetched > 0 && e?.statusCode !== 400, `${slug}: a body quoting at the gated price goes through to upstream`);
    fetched = 0; __resetTtsBreakerForTest();
    e = await throwsWith(() => def.handler({ text: text(10) }));
    ok(fetched > 0, `${slug}: with no gated quote (no gate ran) the handler does not refuse`);
  }
} finally { globalThis.fetch = realFetch; __resetTtsBreakerForTest(); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
