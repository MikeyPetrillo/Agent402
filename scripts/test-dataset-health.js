#!/usr/bin/env node
// The health check must FAIL on the two things it exists for, and pass on a
// healthy day. A guard that has never been shown to catch its own target is
// not a guard - it is a green light with no bulb in it.
//
// Drives scripts/dataset-health.mjs as a child process against a local stub of
// the two endpoints it reads, so the assertions are about the check's
// judgement rather than about prod being healthy today.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const HEALTHY_SELLERS = Array.from({ length: 100 }, (_, i) => ({
  origin: `https://s${i}.example`, network: i % 2 ? "eip155:8453" : null, discoveryPath: i % 3 ? "/.well-known/x402" : null,
}));
const HEALTHY_RECORDED = {
  configured: true,
  days: ["2026-09-12"],
  newest: {
    day: "2026-09-12", writtenAt: new Date().toISOString(),
    rows: { sellers: 3560, routes: 101733, settlement_base: 1015, settlement_solana: 345, settlement_mpp: 145 },
    emptyColumns: { sellers: ["crawl_error"] }, // an honest absence, must NOT fail
    partial: null,
  },
};

/** Boot a stub of the two endpoints, run the check against it, return {code, out}. */
async function run({ sellers = HEALTHY_SELLERS, recorded = HEALTHY_RECORDED } = {}) {
  const port = await getFreePort();
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/index")) return res.end(JSON.stringify({ sellers }));
    if (req.url.startsWith("/__operator/dataset.json")) return res.end(JSON.stringify({ status: {}, recorded }));
    res.statusCode = 404; res.end("{}");
  });
  srv.listen(port, "127.0.0.1");
  await once(srv, "listening");
  try {
    const child = spawn(process.execPath, ["scripts/dataset-health.mjs", "--target", `http://127.0.0.1:${port}`], {
      env: { ...process.env, AGENT402_OPERATOR_TOKEN: "t" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const [code] = await once(child, "close");
    return { code, out };
  } finally { srv.close(); }
}

// --- the healthy control runs FIRST ------------------------------------------
// Nothing below is believed until the check has been shown to pass a good day;
// a check that fails everything catches everything and means nothing.
{
  const { code, out } = await run();
  ok(code === 0, `a healthy day passes (exit ${code})\n${out}`);
  ok(/OK:/.test(out), "and says so");
  ok(!/crawl_error/.test(out.split("FAILED")[1] || ""), "an honestly-empty column does not fail the run");
}

// --- failure 1: the column that is present and empty -------------------------
{
  const { code, out } = await run({
    recorded: { ...HEALTHY_RECORDED, newest: { ...HEALTHY_RECORDED.newest, emptyColumns: { routes: ["price_usd"] } } },
  });
  ok(code === 1, "a headline column empty on every row FAILS");
  ok(/price_usd is EMPTY/.test(out), "and names the column");
  ok(/101733/.test(out), "and says how many rows it was empty across, so the row count cannot be mistaken for health");
}

// --- failure 2: the public field that stopped being populated ----------------
{
  const { code, out } = await run({ sellers: HEALTHY_SELLERS.map((s) => ({ ...s, network: null })) });
  ok(code === 1, "/api/index publishing a field as null for every seller FAILS");
  ok(/publishes network as null for EVERY sampled seller/.test(out), "and names the field and the file to look in");
}
{
  // ... but a field that is merely SPARSE must not fail, or the guard cries
  // daily and gets ignored. Half the sample carrying it is normal.
  const { code } = await run({ sellers: HEALTHY_SELLERS.map((s, i) => ({ ...s, network: i < 5 ? "eip155:8453" : null })) });
  ok(code === 0, "a sparse-but-present field does not fail");
}

// --- the writer stopped, vs the bucket is unreadable: different answers -------
{
  const { code, out } = await run({ recorded: { configured: true, days: [], newest: null } });
  ok(code === 1, "no recorded day FAILS");
  ok(/no day is recorded/.test(out), "and says the writer stopped");
}
{
  const { code, out } = await run({ recorded: { configured: true, days: [], newest: null, error: "HTTP 403" } });
  ok(code === 1, "an unreadable bucket FAILS");
  ok(/could not read the recorded days/.test(out), "and is NOT reported as 'the writer stopped' - a credentials fault and a dead writer need opposite responses");
}

// --- a stale day is a scheduler that is not firing ----------------------------
{
  const old = new Date(Date.now() - 50 * 3600_000).toISOString();
  const { code, out } = await run({
    recorded: { ...HEALTHY_RECORDED, newest: { ...HEALTHY_RECORDED.newest, writtenAt: old } },
  });
  ok(code === 1, "a day older than the max age FAILS");
  ok(/scheduler is not firing/.test(out), "and says the scheduler is the suspect");
}

// --- a partial day is reported, not failed -----------------------------------
{
  const { code, out } = await run({
    recorded: { ...HEALTHY_RECORDED, newest: { ...HEALTHY_RECORDED.newest, partial: { settlement_mpp: "board unreadable" } } },
  });
  ok(code === 0, "a partial day still passes - one dead source is not a dead record");
  ok(/PARTIAL/.test(out), "but it is called out");
}

// --- the watch list replaces a one-shot human reminder ----------------------
// The 0%-empty list catches a column that is wholly absent. The shape that
// actually hid from us was PARTIAL: routes.price_source at 16% while we
// described the table as carrying "provenance on every price". Nothing
// automated could see that - it needed someone to download the NDJSON and
// count. So the daily check now reports fill for the columns we expect to
// grow, and names one that is ready to assert.
{
  const src = readFileSync(new URL("./dataset-health.mjs", import.meta.url), "utf8");
  ok(/const WATCHED = \[/.test(src), "the daily check carries a watch list, so a partially-filled column is reported every day rather than remembered");
  for (const c of ["primary_network", "discovery_path", "price_source", "networks"])
    ok(new RegExp(`column: "${c}"`).test(src), `${c} is watched (it was measurably short on the first recorded day)`);
  // price_outlier cleared its bar (84% filled against 70%), so a human promoted it: it is asserted now, not watched.
  ok(/routes: \[[^\]]*"price_outlier"[^\]]*\]/.test(src), "price_outlier is asserted in MUST_BE_POPULATED once it passed its watch bar");
  ok(!/column: "price_outlier"/.test(src), "and it is no longer on the watch list (a column is asserted or watched, not both)");
  ok(/READY TO ASSERT/.test(src), "and it says plainly when one has earned a place in MUST_BE_POPULATED");
  ok(!/MUST_BE_POPULATED\[w\.table\]\.push|MUST_BE_POPULATED\[.*\] =/.test(src),
     "promotion is a HUMAN edit: the check names the candidate and never widens its own contract, because a guard that grants itself new assertions can also grant itself none");
  // The fill fractions have to reach the script at all, or the watch is inert.
  const snap = readFileSync(new URL("../src/dataset-snapshot.js", import.meta.url), "utf8");
  ok(/columnFill: Object\.fromEntries/.test(snap) && /Math\.round\(\(v \/ t\.rows\) \* 1000\)/.test(snap),
     "datasetRecorded publishes fill as a FRACTION per column, which is the input the watch list reads");
}

console.log(`test-dataset-health: ${n} assertions OK`);
