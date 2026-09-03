// Every skill pack must actually WORK on its own published example.
//
// This is the guard whose absence let nine broken packs sell for two months.
// Every check we had asserted SHAPE - an HTTP 200 and the documented top-level
// keys - and the partial-success envelope is a valid shape whatever the steps
// did. So a pack returning "0/N steps succeeded" passed everything, and a pack
// whose published example was placeholder prose ("these 10 URLs",
// "yesterday's snapshot", "/tmp/upload-abc123") or a fabricated identifier (an
// all-zero tx hash, api.example.com) failed on every call a buyer ever made.
//
// The rule here is about OUTCOMES, not shape: drive each pack with the exact
// input we publish, and require its steps to succeed. That is the same lesson
// as emptyPromisedArrays (2026-08-29) - a documented example that returns
// nothing is a broken tool - applied to the wrapper that hid it.
//
// Needs a booted server: TARGET_URL=http://127.0.0.1:PORT node scripts/test-pack-examples.js
import { SKILL_PACKS } from "../src/skills.js";

const BASE = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

// A step that fails on the published example FOR A STATED REASON. Each entry
// is a claim someone has to defend, not a mute skip - the point of the file is
// that "this step always fails" is never allowed to be invisible again.
const EXPECTED_MISSES = {
  // These packs deliberately throw one artifact at several decoders/converters
  // and report which stuck. The misses ARE the answer, the same way a JWT is
  // not gzip.
  "decode-blob": ["gunzip", "brotli-decompress", "hex"],
  "any-to-markdown": ["pdf-to-markdown", "image-ocr"],
  "content-extraction": ["pdf-to-markdown", "pdf-extract-pages", "image-ocr"],
  "document-intel": ["image-ocr", "barcode-decode", "pdf-merge", "images-to-pdf"],
  // media-info runs ffprobe, and whether a still PNG reads as a decodable
  // stream depends on the ffmpeg build: it succeeds locally and fails on the
  // CI runner. Environment-dependent, so it cannot be a pass/fail signal here;
  // the handler itself is covered by test-media.js.
  "media-pipeline": ["barcode-decode", "audio-normalize", "media-info"],
  // A stock ticker is legitimately not a FRED series id.
  "trend-analysis": ["fred-series"],
  "forecasting-bake-off": ["fred-series"],
  // example.com publishes no sitemap; an SEO audit of a site without one is a
  // real finding, but the tool reports it as an error rather than a result.
  "seo-audit": ["sitemap"],
};

// Not our defect and never fatal: a missing third-party key on this deployment,
// an upstream refusing or rate-limiting us. Same doctrine as probe-classify.js -
// only OUR code failing fails the run.
// Deliberately tight. "fetch failed" is NOT here: undici says that for a
// connection problem, but a URL we built wrong can look similar, and an
// excuse list that grows to cover everything is how a guard stops meaning
// anything. "terminated" is anchored because it is undici's whole message for
// a socket the peer closed mid-body.
const NOT_OURS = /not configured|rate.?limited|HTTP 5\d\d|upstream|timed? out|ECONN|ENOTFOUND|socket hang up|temporarily|HTTP 429|did not respond within|^terminated$/i;

let failed = 0, reported = 0, checked = 0;
for (const pack of SKILL_PACKS) {
  const body = Object.fromEntries((pack.promptArgs || []).map((a) => [a.name, a.substitute]));
  // Single retry, the doctrine the heartbeat, the Algorand canary and
  // probe-classify all use: this sweep drives ~53 live third-party hosts, so a
  // one-off blip is guaranteed eventually. Only what SURVIVES a retry is
  // classified. The alternative is widening the not-ours list every time a
  // publisher hiccups, and an excuse list that grows to cover everything is how
  // a guard stops meaning anything.
  const drive = async () => {
    const r = await fetch(`${BASE}/api/skill/${pack.slug}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { res: r, json: await r.json() };
  };
  const isClean = (r, j) => r.status === 200 && !(j.steps || []).some(
    (s) => !s.ok && !(EXPECTED_MISSES[pack.slug] || []).includes(s.slug) && !NOT_OURS.test(String(s.error || ""))
  );

  let res, json;
  try {
    ({ res, json } = await drive());
    if (!isClean(res, json)) {
      await new Promise((r) => setTimeout(r, 2000));
      const second = await drive();
      // Keep the retry only if it is better; a flake that clears is the point.
      if (isClean(second.res, second.json)) ({ res, json } = second);
    }
  } catch (err) {
    console.log(`report - ${pack.slug}: could not be driven (${err.message})`); reported++; continue;
  }
  checked++;

  if (res.status !== 200) {
    const why = String(json?.error || "");
    if (NOT_OURS.test(why)) { console.log(`report - ${pack.slug}: ${res.status} upstream/key, not ours`); reported++; continue; }
    console.log(`FAIL - ${pack.slug}: HTTP ${res.status} on its OWN published example - ${why.slice(0, 160)}`);
    failed++; continue;
  }

  // A step can only be judged on its own merits if what it depends on ran.
  // When an earlier step was blocked by a missing key or an upstream, the
  // steps downstream of it fail for that reason and not for ours - locally
  // that is most of the noise, and calling it a defect would train everyone
  // to ignore this file.
  const upstreamBlocked = (json.steps || []).some((s) => !s.ok && NOT_OURS.test(String(s.error || "")));
  const allowed = new Set(EXPECTED_MISSES[pack.slug] || []);
  const bad = (json.steps || []).filter((s) => !s.ok && !allowed.has(s.slug) && !NOT_OURS.test(String(s.error || "")));
  const upstream = (json.steps || []).filter((s) => !s.ok && NOT_OURS.test(String(s.error || "")));
  if (upstream.length) { console.log(`report - ${pack.slug}: ${upstream.length} step(s) blocked by a key/upstream, not ours`); reported++; }
  if (bad.length && upstreamBlocked) {
    console.log(`report - ${pack.slug}: ${bad.length} step(s) downstream of an upstream/key failure`);
    reported++; continue;
  }
  if (bad.length) {
    console.log(`FAIL - ${pack.slug}: ${bad.length} step(s) fail on its OWN published example:`);
    for (const s of bad) console.log(`         ${s.slug}: ${String(s.error || "").slice(0, 140)}`);
    failed++; continue;
  }
  // A pack whose every step is excused is not a working pack.
  const ok = (json.steps || []).filter((s) => s.ok).length;
  if (ok === 0) { console.log(`FAIL - ${pack.slug}: no step succeeded on its own example`); failed++; continue; }
  console.log(`ok - ${pack.slug}: ${json.summary}`);
}

console.log(`\n${checked} packs driven with their own published example; ${reported} report-only (key/upstream), ${failed} failed`);

// A run that measured nothing must never read as a pass. Caught in development:
// the server under test had died, every pack reported "could not be driven",
// and this file exited 0 - the exact shape of the defect it exists to find.
const MIN_DRIVEN = Math.ceil(SKILL_PACKS.length * 0.5);
if (checked < MIN_DRIVEN) {
  console.log(`FAIL - only ${checked} of ${SKILL_PACKS.length} packs could be driven (need ${MIN_DRIVEN}). Is TARGET_URL (${BASE}) serving?`);
  process.exit(1);
}
if (failed) process.exit(1);
