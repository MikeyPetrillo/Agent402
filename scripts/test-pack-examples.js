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
// `--controls` runs only the offline controls below and needs no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { SKILL_PACKS } from "../src/skills.js";
import { fredMaintenanceError } from "../src/tools/macro-kit.js";
import { sourceAllowanceVerdict } from "./lib/upstream-outage.js";
import { createPackGrader, firstStepOf } from "./lib/pack-sweep-grade.js";

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
};
// Not our defect and never fatal: a missing third-party key on this deployment,
// an upstream refusing or rate-limiting us. Same doctrine as probe-classify.js -
// only OUR code failing fails the run.
// Deliberately tight. "fetch failed" is NOT here: undici says that for a
// connection problem, but a URL we built wrong can look similar, and an
// excuse list that grows to cover everything is how a guard stops meaning
// anything. "terminated" is anchored because it is undici's whole message for
// a socket the peer closed mid-body.
// TLS is a transport failure like any other, and this list had every other one.
// 2026-09-12: blog.cloudflare.com refused the runner's TLS handshake
// (ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE) and content-grade's extract step
// was graded as OUR defect, failing a build over a diff that touched none of
// it - while the identical failure one layer down (ECONN, ENOTFOUND, socket
// hang up) was correctly reported as upstream. The same URL answered 200 from
// a laptop at the same minute.
//
// Added narrowly: the TLS/SSL transport tokens only, NOT a blanket
// "fetch failed". probe-classify's own history is the reason - it was
// corrected once for matching "upstream"/"timeout"/"aborted" inside a 4xx,
// because our own messages carry those words, and a classifier that excuses
// too much stops being able to fail.
//
// 2026-10-07: a site answering the CI runner 403 was graded as OUR defect
// (seo-audit's meta step), while the non-metered sweep already reads the same
// refusal as upstream. fetch-guard words an access refusal by a third-party
// host in one fixed sentence (attribution "upstream-access"); that sentence,
// anchored to its start, is excused here and nothing broader. A 4xx that
// means the URL is wrong ("Source URL returned HTTP 404") still fails.
const NOT_OURS_BASE = /not configured|rate.?limited|HTTP 5\d\d|upstream|timed? out|ECONN|ENOTFOUND|socket hang up|temporarily|HTTP 429|did not respond within|ERR_SSL|ERR_TLS|TLS_ALERT|EPROTO|handshake failure|^terminated$/i;
const ACCESS_REFUSED = /^The host refused this server's request \(HTTP (401|403|407|451)\)/i;
// Most examples now target agent402.tools: an access refusal from our own site
// is our defect and is NOT excused for a pack whose input names it.
// FRED's scheduled maintenance: the FRED tools answer it in one fixed sentence
// (fredMaintenanceError), only when FRED serves its maintenance page in place
// of data. That exact sentence is excused, nothing broader.
const FRED_MAINTENANCE = fredMaintenanceError().message;
const baseNotOurs = (s) => NOT_OURS_BASE.test(s) || String(s) === FRED_MAINTENANCE;
if (!baseNotOurs(FRED_MAINTENANCE) || baseNotOurs("FRED returned no rows") || baseNotOurs(`${FRED_MAINTENANCE} x`)) {
  console.error("FAIL - control: only FRED's exact maintenance sentence is excused");
  process.exit(1);
}
// A step whose source allowance this server spent (us-macro-series' BLS day),
// or whose source refused the server's read, answers a fixed sentence: that
// may be ours, so the answer is excused only when the source refuses the
// runner's own direct read of a host the tool declares too
// (sourceAllowanceVerdict, scripts/lib/upstream-outage.js; graded by
// scripts/lib/pack-sweep-grade.js). One read a run, kept for every step.
const BLS_SPENT = "The U.S. Bureau of Labor Statistics daily query allowance of this server is used up; this decade of the series is not held yet. Retry tomorrow.";
const BLS_REFUSED = "The U.S. Bureau of Labor Statistics API did not answer or refused the read (the publisher's own limit or outage); retry shortly.";
{
  const refused = async () => ({ status: 200, text: JSON.stringify({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold"] }) });
  const answered = async () => ({ status: 200, text: JSON.stringify({ status: "REQUEST_SUCCEEDED", Results: {} }) });
  const checks = [
    [baseNotOurs(BLS_SPENT) === false, "the allowance sentence is not excused on its text alone"],
    [(await sourceAllowanceVerdict({ slug: "us-macro-series", error: BLS_SPENT, read: refused }))?.verdict === "upstream", "a spent allowance is excused when BLS refuses the runner's direct read too"],
    [(await sourceAllowanceVerdict({ slug: "us-macro-series", error: BLS_SPENT, read: async () => ({ status: 503, text: "" }) }))?.verdict === "upstream", "a spent allowance is excused when BLS does not answer the runner"],
    [(await sourceAllowanceVerdict({ slug: "us-macro-series", error: BLS_SPENT, read: answered }))?.verdict === "fail", "a spent allowance fails when BLS answers the runner (the spent budget is ours)"],
    [(await sourceAllowanceVerdict({ slug: "stats-summary", error: BLS_SPENT, read: refused }))?.verdict === "fail", "a spent allowance fails on a tool that does not declare api.bls.gov"],
    [(await sourceAllowanceVerdict({ slug: "us-macro-series", error: "us-macro-series: unsupported series id", read: refused })) === null, "another error is no allowance answer"],
    [(await sourceAllowanceVerdict({ slug: "cpi-yoy", error: BLS_REFUSED, read: refused }))?.verdict === "upstream", "BLS refusing the server's read is excused when BLS refuses the runner's direct read too"],
    [(await sourceAllowanceVerdict({ slug: "cpi-yoy", error: BLS_REFUSED, read: answered }))?.verdict === "fail", "BLS refusing the server's read fails when BLS answers the runner"],
  ];
  const noStep = `No step in the "p" pack succeeded, so there is nothing to return. Nothing was charged. us-macro-series: ${BLS_SPENT}; forecast-eval: need ≥6 observations`;
  const f = firstStepOf(noStep, ["us-macro-series", "forecast-eval"]);
  checks.push([f?.slug === "us-macro-series" && f.error === BLS_SPENT, "a pack's no-step answer yields its first step and that step's own message"]);
  checks.push([firstStepOf(`x ${noStep}`, ["us-macro-series"]) === null, "only the pack's own no-step sentence is read"]);
  for (const [c, m] of checks) if (!c) { console.error(`FAIL - control: ${m}`); process.exit(1); }
  if (process.argv.includes("--controls")) { console.log(`ok - ${checks.length} pack-sweep controls (the grading itself: scripts/test-upstream-outage.js)`); process.exit(0); }
}
const grader = createPackGrader();
let NOT_OURS = { test: baseNotOurs };
const notOursFor = (body) => {
  const ours = /agent402\.tools/i.test(JSON.stringify(body));
  return { test: (s) => baseNotOurs(s) || (!ours && ACCESS_REFUSED.test(s)) };
};

// With an active stock data provider (stock-history listed) these two packs take a stock ticker, and
// a ticker is legitimately not a FRED series id. With none they run without
// the stock step on a FRED series id, so us-macro-series is the data step: a key
// or upstream failure is classified below like any other, a code failure
// fails. The server's own catalog says which state it is in.
const STOCK_ON = (await (await fetch(`${BASE}/api/pricing`)).json().catch(() => ({}))).endpoints?.some?.((e) => e.slug === "stock-history") === true;
if (STOCK_ON) {
  EXPECTED_MISSES["trend-analysis"] = ["us-macro-series"];
  EXPECTED_MISSES["forecasting-bake-off"] = ["us-macro-series"];
}
console.log(`stock data provider ${STOCK_ON ? "on: us-macro-series misses excused for the ticker-fed packs" : "off: us-macro-series is judged on every pack"}`);

let failed = 0, reported = 0, checked = 0;
for (const pack of SKILL_PACKS) {
  const body = Object.fromEntries((pack.promptArgs || []).map((a) => [a.name, a.substitute]));
  NOT_OURS = notOursFor(body);
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
    const json = await r.json();
    await grader.judge(json, pack.toolSlugs);
    return { res: r, json };
  };
  const isClean = (r, j) => grader.isClean({ status: r.status, json: j, expectedMisses: EXPECTED_MISSES[pack.slug] || [], notOurs: NOT_OURS });

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

  const g = grader.grade({ slug: pack.slug, status: res.status, json, toolSlugs: pack.toolSlugs, expectedMisses: EXPECTED_MISSES[pack.slug] || [], notOurs: NOT_OURS });
  for (const line of g.lines) console.log(line);
  reported += g.reported;
  if (g.failed) failed++;
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
