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
