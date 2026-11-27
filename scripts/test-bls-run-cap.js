#!/usr/bin/env node
// The CI sweep's per-run BLS read cap, driven through the real tool.
//
// The sweep server boots with the CI key as BLS_API_KEY and BLS_DAILY_MAX set
// to BLS_RUN_READ_CAP (scripts/test-non-metered-examples.js; a fresh server's
// day is the run). This drives us-macro-series (UNRATE, a BLS series) on a stubbed BLS
// past that cap and proves: no query past the cap reaches BLS; the refusal is
// the tool's own spent-allowance sentence (a 503, the blsDay cap mark), read
// from the handler rather than typed here; the sweep's grader excuses that
// answer only when BLS refuses the runner's direct read too, and FAILS it when
// BLS answers the runner, so a capped run never counts as a pass. The deploy
// step hands the sweep server the cap and the CI key, never the production key.
// Offline.
//
//   node scripts/test-bls-run-cap.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";
import { _resetUsMacroForTest, blsDailyBudget } from "../src/tools/us-macro-series.js";
import { CAP_NAMES } from "../src/upstream-cap-refusals.js";
import { SOURCE_ALLOWANCES } from "./lib/upstream-outage.js";
import { BLS_RUN_READ_CAP, sourceRefusalGrade } from "./test-non-metered-examples.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
let blsQueries = 0;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== "api.bls.gov") throw new Error(`unexpected host ${u.hostname}`);
  blsQueries++;
  const b = JSON.parse(opts.body);
  const data = [];
  for (let y = Number(b.startyear); y <= Math.min(Number(b.endyear), 2026); y++) for (let m = 1; m <= 12; m++) data.push({ year: String(y), period: `M${String(m).padStart(2, "0")}`, value: "4.1" });
  return json({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: b.seriesid[0], data: data.reverse() }] } });
};

const tool = MACRO_TOOLS.find((t) => t.slug === "us-macro-series");
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
try {
  ok(tool && (tool.upstreamHosts || []).includes("api.bls.gov"), "us-macro-series declares api.bls.gov, the host the grader reads");
  process.env.BLS_API_KEY = "ci-test-key";
  process.env.BLS_DAILY_MAX = String(BLS_RUN_READ_CAP);
  _resetUsMacroForTest();
  ok(blsDailyBudget() === BLS_RUN_READ_CAP, `the sweep server's day is the per-run cap (${blsDailyBudget()})`);
  // A fresh server's run: each call asks one series decade nobody has read yet.
  const { SERIES } = await import("../src/tools/us-macro-series.js");
  const ids = Object.entries(SERIES).filter(([, v]) => v.source === "bls").map(([k]) => k).slice(0, BLS_RUN_READ_CAP + 3);
  ok(ids.length === BLS_RUN_READ_CAP + 3, `enough BLS series to pass the cap (${ids.length})`);
  const ask = (id) => tool.handler({ seriesId: id, startDate: "2010-01-01", endDate: "2019-12-31" });
  const answers = [];
  for (const id of ids) answers.push(await caught(ask(id)));
  ok(blsQueries === BLS_RUN_READ_CAP, `no BLS query past the cap leaves the server (${blsQueries} sent, cap ${BLS_RUN_READ_CAP})`);
  const served = answers.slice(0, BLS_RUN_READ_CAP), refused = answers.slice(BLS_RUN_READ_CAP);
  ok(served.every((e) => e === null), "the reads under the cap are served");
  ok(refused.length === 3 && refused.every((e) => e?.statusCode === 503 && e.capRefusal === CAP_NAMES.blsDay), "every read past the cap is a 503 marked with the BLS day cap");
  const said = refused[0]?.message || "";
  ok(SOURCE_ALLOWANCES[0].message.test(said), `the refusal is the spent-allowance sentence the outage rule reads ("${said.slice(0, 70)}...")`);
  // Already-read decades stay served from the cache, so the cap only refuses new reads.
  const again = await caught(ask(ids[0]));
  ok(again === null && blsQueries === BLS_RUN_READ_CAP, "a decade the run already read is served without a query");

  // The sweep's grade of that exact answer.
  const t = { slug: "us-macro-series", method: "get", path: "/api/us-macro-series" };
  const r = { status: 503, body: { error: said } };
  const blsAnswers = async () => ({ status: 200, text: JSON.stringify({ status: "REQUEST_SUCCEEDED", Results: {} }) });
  const blsRefuses = async () => ({ status: 200, text: JSON.stringify({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold"] }) });
  const fails = await sourceRefusalGrade(t, r, blsAnswers);
  ok(Boolean(fails?.fail) && !fails?.skip, `with BLS answering the runner, the capped answer FAILS the sweep, never a pass (${(fails?.fail || "").slice(0, 90)})`);
  const excused = await sourceRefusalGrade(t, r, blsRefuses);
  ok(Boolean(excused?.skip) && !excused?.fail, "with BLS refusing the runner's direct read too, it is excused as the upstream's");
} finally {
  globalThis.fetch = realFetch;
  undoDns();
  delete process.env.BLS_API_KEY;
  delete process.env.BLS_DAILY_MAX;
}

// The deploy step: the sweep server takes the CI key and the cap; no workflow
// reads the production key's Actions secret.
{
  const { readFileSync: rf, readdirSync } = await import("node:fs");
  const wf = new URL("../.github/workflows/", import.meta.url);
  const deploy = readFileSync(new URL("deploy.yml", wf), "utf8");
  ok(/BLS_API_KEY: \$\{\{ secrets\.BLS_CI_API_KEY \}\}/.test(deploy) && new RegExp(`BLS_DAILY_MAX: "${BLS_RUN_READ_CAP}"`).test(deploy), "the sweep server gets the CI BLS key and BLS_DAILY_MAX equal to the per-run cap");
  const readers = readdirSync(wf).filter((f) => /\.ya?ml$/.test(f) && /secrets\.BLS_API_KEY\b/.test(rf(new URL(f, wf), "utf8")));
  ok(readers.length === 0, `no workflow reads the Actions secret BLS_API_KEY (${readers.join(", ") || "none"})`);
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
