// Margin-cap tests for the STT kit. The per-tier duration cap is what keeps
// transcribe/transcribe-pro profitable (OpenAI bills per audio minute, the
// tool charges per call) - these tests prove the cap is enforced locally,
// before any upstream spend, and that the cap itself is sized to the model's
// live per-minute rate (2026-09-18: the standard tier moved off
// gpt-4o-mini-transcribe, which OpenAI retires 2027-02-26, onto gpt-transcribe,
// and its cap dropped 5 -> 4 minutes to stay inside the margin rule). Offline: synthetic WAV buffers, no network.
import { probeDurationSeconds, assertWithinDurationCap, STT_TIERS, UPSTREAM_USD_PER_MINUTE, STT_MARGIN, STT_TOOLS } from "../src/tools/stt-kit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// ---- the cap is a margin bound, derived from the model's rate ----
for (const [slug, tier] of Object.entries(STT_TIERS)) {
  const rate = UPSTREAM_USD_PER_MINUTE[tier.model];
  ok(Number.isFinite(rate) && rate > 0, `${slug}: the model it sends (${tier.model}) has a known per-minute rate`);
  const worst = tier.maxMinutes * rate;
  ok(worst <= STT_MARGIN * tier.priceUsd + 1e-12, `${slug}: worst case ${tier.maxMinutes} min x $${rate}/min = $${worst.toFixed(4)} is under ${STT_MARGIN * 100}% of $${tier.priceUsd} (a 5-min cap on gpt-transcribe would be 75%)`);
  const tool = STT_TOOLS.find((t) => t.slug === slug);
  ok(Math.abs(Number(tool.price.replace("$", "")) - tier.priceUsd) < 1e-9, `${slug}: the catalog price string matches the tier price the margin is computed on`);
  ok(new RegExp(`Max ${tier.maxMinutes} minutes`).test(tool.description) && tool.description.includes(tier.model) && tool.discovery.output.example.model === tier.model, `${slug}: description states the ${tier.maxMinutes}-minute cap and the model; the example names the model actually sent`);
}
// The retiring models are gone from every tier (OpenAI shutdown 2027-02-26).
ok(!Object.values(STT_TIERS).some((t) => /gpt-4o(-mini)?-transcribe|whisper-1/.test(t.model)), "no tier sends gpt-4o-mini-transcribe, gpt-4o-transcribe or whisper-1");
ok(STT_TIERS.transcribe.model === "gpt-transcribe" && STT_TIERS["transcribe-pro"].model === "gpt-transcribe", "both tiers send gpt-transcribe (they differ in cap and price only, and the pro copy says so)");
ok(!/[Hh]igher accuracy/.test(STT_TOOLS.find((t) => t.slug === "transcribe-pro").description), "the pro tier no longer claims higher accuracy than a tier on the same model");

// Minimal valid PCM WAV of the given length: 8 kHz, mono, 8-bit.
function makeWav(seconds) {
  const sr = 8000;
  const dataLen = Math.round(sr * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const short = makeWav(10);          // 10 s - fine on both tiers
const justOver = makeWav(4.5 * 60); // 4.5 min - over the 4-min standard cap (the old 5-min cap let it through), under the pro cap
const mid = makeWav(6.5 * 60);      // 6.5 min - over the standard cap, under the 10-min pro cap
const long = makeWav(11 * 60);      // 11 min - over both caps
const junk = Buffer.from("definitely not an audio container ".repeat(200));

const d = await probeDurationSeconds(short, "audio.wav");
ok(d !== null && Math.abs(d - 10) < 0.5, `probe reads WAV duration from the header (got ${d}s)`);
ok((await probeDurationSeconds(junk, "audio.mp3")) === null, "unreadable bytes probe to null, never throw");

ok((await assertWithinDurationCap(short, "audio.wav", "transcribe")) > 0, "short clip passes the standard tier");
ok((await assertWithinDurationCap(justOver, "audio.wav", "transcribe-pro")) > 0, "4.5-min clip passes the pro tier");
ok((await assertWithinDurationCap(mid, "audio.wav", "transcribe-pro")) > 0, "6.5-min clip passes the pro tier");

await assertWithinDurationCap(justOver, "audio.wav", "transcribe").then(
  () => ok(false, "4.5-min clip must be rejected by the 4-min standard cap (worst case would be 68% of the price and rising with the clip)"),
  (e) => ok(e.statusCode === 422 && /up to 4 minutes/.test(e.message), `4.5-min clip rejected 422 by the standard cap, message states 4 minutes (${e.message})`)
);

await assertWithinDurationCap(mid, "audio.wav", "transcribe").then(
  () => ok(false, "6.5-min clip must be rejected by the standard cap"),
  (e) => {
    ok(e.statusCode === 422, `standard cap rejects with 422 (got ${e.statusCode})`);
    ok(/transcribe-pro/.test(e.message), "standard-tier rejection points at the pro tier");
  }
);

await assertWithinDurationCap(long, "audio.wav", "transcribe-pro").then(
  () => ok(false, "11-min clip must be rejected by the 10-min pro cap"),
  (e) => ok(e.statusCode === 422 && /10 minutes/.test(e.message), "pro cap rejects with 422 and states its limit")
);

await assertWithinDurationCap(junk, "audio.mp3", "transcribe").then(
  () => ok(false, "unreadable duration must be rejected (unbounded upstream bill otherwise)"),
  (e) => ok(e.statusCode === 422 && /duration/i.test(e.message), "unreadable container -> self-explaining 422")
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
