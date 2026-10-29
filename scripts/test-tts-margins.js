#!/usr/bin/env node
// Speech economics: the per-request quote of /api/tts and /api/tts-hd clears
// the worst-case upstream cost at EVERY text length, on every link that can
// serve the call (each tier's ElevenLabs chain and the shared backups).
//
// Speech bills per input character at the private rate of the model that
// spoke (src/upstream-costs.js `speech`, the model's dearest endpoint), so the
// cost of n characters on a link is rate x n, and the quote is floor + slope x n
// rounded up. The bound is the one the flat tiers held: cost within 70% of
// what the buyer paid, checked from 1 character to the cap. Assertions are
// pass/fail; no rate, cost or ratio is printed.
//
//   UPSTREAM_COSTS_FILE=<private table> node scripts/test-tts-margins.js
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
import { upstreamCosts } from "../src/upstream-costs.js";
import { TTS_TOOLS, TTS_TIERS, TTS_QUOTE, TTS_BACKUP_MODELS, ttsQuoteUsd } from "../src/tools/tts-kit.js";
requireUpstreamCosts("test-tts-margins");

// The share of the paid amount a call's upstream cost may take (the bound the
// speech tiers have always been held to).
const SPEECH_MARGIN = 0.7;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const bySlug = Object.fromEntries(TTS_TOOLS.map((t) => [t.slug, t]));

const quoted = Object.keys(TTS_QUOTE);
ok(quoted.length === 2 && quoted.includes("tts") && quoted.includes("tts-hd"), "both ElevenLabs tiers are quoted per request");
for (const slug of quoted) {
  const tier = TTS_TIERS[slug];
  const links = [...tier.chain, ...TTS_BACKUP_MODELS];
  ok(tier.chain[0] === tier.model, `${slug}: the documented model is the first link`);
  for (const model of links) {
    const rate = upstreamCosts().speech?.[model];
    ok(Number.isFinite(rate) && rate > 0, `${slug}: a private per-char row exists for ${model}`);
    if (!(Number.isFinite(rate) && rate > 0)) continue;
    // Worst ratio of cost to the margin allowance over every length (1.0 =
    // exactly at the bound). Never printed: with the public quote beside it, a
    // ratio (or the length where it crosses) would give the private rate away.
    let worst = 0;
    for (let n = 1; n <= tier.maxChars; n++) worst = Math.max(worst, (rate * n) / (ttsQuoteUsd(slug, n) * SPEECH_MARGIN));
    ok(worst <= 1 + 1e-12, `${slug}: ${model} stays within ${SPEECH_MARGIN * 100}% of the quote at every length to ${tier.maxChars} chars`);
  }
  // The cap bounds the quote: the dearest call is the ceiling the surfaces publish.
  ok(bySlug[slug].quoteMaxUsd === ttsQuoteUsd(slug, tier.maxChars) && tier.maxChars === 2_000, `${slug}: the quote is bounded (cap ${tier.maxChars} chars, ceiling quoteMaxUsd)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
