// The keep-alive must actually run on a schedule, and page when it doesn't.
//
// CDP's seller docs: "Resources that go 30 days without a settlement are
// removed." Measured 2026-08-31: our oldest surviving Bazaar listing was dated
// exactly 30 days back and 405 of 573 routes had aged out - not a registration
// failure, a cull. scripts/refresh-bazaar.js already carried the remedy
// (MODE=sweep) and had been wired to workflow_dispatch ONLY, so it had never
// run on a cadence in the catalog's life.
//
// So the properties worth pinning are not about the payment logic - that script
// is unchanged and tested elsewhere - but about the things that would silently
// undo this again: no schedule, too slow a cadence, a missing key treated as a
// skip, or a failure nobody hears about.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wf = await readFile(new URL("../.github/workflows/bazaar-keepalive.yml", import.meta.url), "utf8");

ok(/^on:/m.test(wf) && /schedule:/.test(wf), "it is scheduled at all - the whole defect was a dispatch-only job");

// Cadence: a 30-day rule needs real headroom, because GitHub throttles
// schedules (measured 2026-08-30: a */15 cron delivered one run in 9.8 hours).
const cron = (wf.match(/cron:\s*"([^"]+)"/) || [])[1] || "";
const dom = cron.split(/\s+/)[2], dow = cron.split(/\s+/)[4];
ok(cron !== "", `carries a cron (${cron})`);
ok(dow !== "*" && dom === "*", "weekly, not monthly - four missed runs still leave the listings alive");

ok(/MODE:\s*sweep/.test(wf), "uses the sweep mode that re-settles every affordable route");
// The scheduled ceiling and the per-batch cap: a fixed-price route above the
// ceiling has no scheduled buyer, and a batch whose estimate is over the cap
// refuses to start.
const ceiling = Number((wf.match(/MAX_PRICE_USD:\s*\$\{\{\s*inputs\.max_price_usd\s*\|\|\s*'([0-9.]+)'/) || [])[1]);
const batchCap = Number((wf.match(/MAX_SPEND_USD:\s*\$\{\{\s*inputs\.max_spend_usd\s*\|\|\s*'([0-9.]+)'/) || [])[1]);
ok(ceiling >= 0.1, `the scheduled pass buys routes priced up to at least $0.10 (${ceiling})`);
ok(batchCap >= 2 && batchCap <= 5, `the per-batch cap leaves room for a batch with every route due and stays bounded (${batchCap})`);
// A weekly pass with a 21-day threshold reaches a listing once before the
// 30-day removal (at 21 to 28 days); at 14 it reaches it twice.
const staleDays = Number((wf.match(/STALE_DAYS:\s*\$\{\{\s*inputs\.stale_days\s*\|\|\s*'([0-9]+)'/) || [])[1]);
ok(staleDays >= 7 && staleDays <= 16, `the scheduled pass buys a listing with no settlement in ${staleDays} days, early enough for a second weekly attempt`);
ok(/SLUGS:\s*\$\{\{\s*inputs\.slugs\s*\}\}/.test(wf), "a dispatch can name exact slugs");
// The script's own money bounds and request shapes.
{
  const { examplesFromSpec, sweepRequest, atRiskFailures, sweepVerdict } = await import("./refresh-bazaar.js");
  const src = await readFile(new URL("./refresh-bazaar.js", import.meta.url), "utf8");
  ok(/if \(estCost > MAX_SPEND_USD\) \{[\s\S]{0,200}return 2;/.test(src), "a pass whose estimate is over the spend cap refuses to start");
  ok(/Math\.min\(MAX_PRICE_USD \+ 0\.05, MAX_SPEND_USD\)/.test(src), "one signature pays at most the per-route ceiling plus five cents, never above the run's cap");
  const ex = examplesFromSpec({ paths: {
    "/v1/audio/transcriptions": { post: { requestBody: { content: { "multipart/form-data": { example: { file: "<audio bytes, multipart part named file>", language: "en" } } } } } },
    "/api/hash": { post: { requestBody: { content: { "application/json": { example: { text: "hello" } } } } } },
    "/api/time": { get: { parameters: [{ name: "tz", example: "UTC" }] } },
  } });
  ok(ex.multipart.has("POST /v1/audio/transcriptions") && !ex.multipart.has("POST /api/hash") && ex.get("POST /api/hash").text === "hello", "a multipart operation is told apart from a JSON one");
  const clip = async () => new Uint8Array([82, 73, 70, 70]);
  const mp = await sweepRequest({ method: "POST", path: "/v1/audio/transcriptions" }, ex, { target: "http://t", headers: { "X-H": "1" }, clip });
  ok(mp.init.body instanceof FormData && mp.init.body.get("file") instanceof Blob && mp.init.body.get("file").size === 4 && mp.init.body.get("language") === "en" && !("Content-Type" in mp.init.headers) && mp.init.headers["X-H"] === "1", "a multipart route is paid with a file part and its text fields, with no JSON content type");
  const js = await sweepRequest({ method: "POST", path: "/api/hash" }, ex, { target: "http://t", headers: { "X-H": "1" }, clip });
  ok(js.init.body === '{"text":"hello"}' && js.init.headers["Content-Type"] === "application/json" && js.init.headers["X-H"] === "1" && js.url === "http://t/api/hash", "a JSON route is paid with its JSON example and the caller's headers");
  const gt = await sweepRequest({ method: "GET", path: "/api/time" }, ex, { target: "http://t", headers: { "X-H": "1" }, clip });
  ok(gt.url === "http://t/api/time?tz=UTC" && gt.init.body === undefined && gt.init.headers["X-H"] === "1", "a GET route is paid with its query example and the caller's headers");
  const day = 86400000;
  const fresh = new Map([["/a", 5 * day], ["/b", 20 * day], ["/c", 29 * day], ["/d", 19.9 * day]]);
  ok(JSON.stringify(atRiskFailures(["/a", "/b", "/c", "/d", "/unlisted"], fresh)) === JSON.stringify(["/b", "/c", "/unlisted"]), "a failed buy puts a listing at risk when it is unlisted or 20 days from its last settlement");
  ok(sweepVerdict({ ok: 9, fail: 1, failedPaths: ["/b"] }, fresh).exitCode === 1 && sweepVerdict({ ok: 9, fail: 1, failedPaths: ["/a"] }, fresh).exitCode === 0, "the pass fails on a failed buy at risk and passes on one that is not");
  ok(sweepVerdict({ ok: 0, fail: 2, failedPaths: ["/a", "/d"] }, fresh).exitCode === 1 && sweepVerdict({ ok: 0, fail: 0, failedPaths: [] }, fresh).exitCode === 0 && sweepVerdict({ ok: 3, fail: 0, failedPaths: [] }, new Map()).exitCode === 0, "a wipeout fails; nothing to buy and a clean pass do not");
  ok(/AT_RISK_DAYS \|\| "20"/.test(src), "the at-risk age defaults to 20 days");
  ok(atRiskFailures(["/a", "/c"], new Map()).length === 0 && atRiskFailures([], fresh).length === 0, "with no feed read, or no failed buy, nothing is at risk");
  ok(/const verdict = sweepVerdict\(results, freshness, AT_RISK_DAYS\);[\s\S]{0,400}return verdict\.exitCode;/.test(src) && /Failed buys \(/.test(src), "the sweep names every failed buy and returns the verdict's exit code");
}
ok(/BATCH_COUNT/.test(wf) && /BATCH_INDEX/.test(wf), "batches the pass so one run cannot time out mid-catalog");
ok(/max-parallel:\s*1/.test(wf), "batches run sequentially - one burner address, concurrent buys race their own nonces");

// A missing key must FAIL, never skip: a silent skip is indistinguishable from
// success for 30 days, and then the catalog is gone.
ok(/BURNER_KEY is not set/.test(wf) && /exit 1/.test(wf), "a missing burner key fails the run loudly, never skips");
ok(/add-mask/.test(wf), "the key is masked in the log");
ok(/secrets\.BURNER_KEY/.test(wf), "uses the same burner secret as the existing sweep job, not a new one");

// Nobody watches a weekly job, so it has to speak up.
ok(/issues:\s*write/.test(wf), "may open an issue");
ok(/Bazaar keep-alive FAILED/.test(wf), "pages on failure with a title that says what breaks");
ok(/gh issue close/.test(wf), "and closes the issue when a later run succeeds");
ok(/if:\s*always\(\)/.test(wf), "the report step runs even when the sweep failed - the failure is the point");

// The file must PARSE, not merely contain the right substrings. Every check
// above is a regex over the raw text, and a regex is happy with a YAML file
// GitHub would reject: adding an env key that already existed produced a
// duplicate mapping key on 2026-08-31 and all 13 assertions still passed. A
// workflow that cannot parse never runs, and a keep-alive that never runs is
// a silent 30-day cull.
try {
  const yaml = await import("js-yaml");
  const load = yaml.load || yaml.default?.load;
  const doc = load(wf);
  ok(!!doc && typeof doc === "object", "the workflow is valid YAML (duplicate keys included)");
  const crons = (doc.on?.schedule || []).map((x) => x.cron);
  ok(crons.length >= 2, `both cadences are scheduled (${crons.join(" | ")})`);
  const env = doc.jobs?.sweep?.steps?.find((x) => x.name === "Refresh settlements")?.env || {};
  ok(String(env.UPSTREAM_FREE_ONLY || "").includes("37 5 * * *"), "the daily cron is the one that sweeps only zero-upstream routes");
  ok(String(env.SKIP_UPSTREAM_FREE || "").includes("17 4 * * 2"), "the Tuesday cron is the one that skips what daily already covered");
  ok(crons.every((c) => String(env.UPSTREAM_FREE_ONLY).includes(c) || String(env.SKIP_UPSTREAM_FREE).includes(c)),
     "every schedule selects a mode - a cron nobody keys on would sweep the whole priced catalog by accident");
} catch (e) {
  ok(false, `the workflow is valid YAML (${e.message})`);
}

// The deploy job that registers new routes must not cry wolf. It exited 1
// whenever ANY route was left over, and the spend cap, price cap and batch
// stride all exist to leave routes for a later pass - so it failed on almost
// every deploy that added routes, logging "5 ok, 0 failed" as it went. Measured
// 2026-08-31: 4 of the last 7 red "Deploy to Railway" runs were exactly that.
// A failure mail that is usually noise is a failure mail nobody reads.
{
  const src = await readFile(new URL("./refresh-bazaar.js", import.meta.url), "utf8");
  ok(/if \(failCount === 0\) \{[\s\S]{0,600}?exitCode: 0/.test(src),
     "leftover routes with no failed buy exit 0 - the caps working is not a failure");
  ok(/failCount/.test(src) && /exitCode: 1/.test(src) && /FAILED/.test(src),
     "a buy that actually FAILED still exits 1 - the alarm still works");
  ok(!/exitCode: 1,\n\s*message: `Work remaining/.test(src),
     "the old always-fails message is gone");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
