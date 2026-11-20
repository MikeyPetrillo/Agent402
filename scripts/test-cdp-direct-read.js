#!/usr/bin/env node
// The live CDP check excuses a failure as the service's own only when the
// runner's direct read fails too (scripts/lib/cdp-direct-read.js). Offline:
// stub reads and a stub fetch; no request leaves the process.
import "./lib/offline-stores.js";
import { readFileSync } from "node:fs";
import { cdpDirectStatus, cdpFailureVerdict, observatoryVerdict, OBSERVATORY_QUERIES } from "./lib/cdp-direct-read.js";

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} - ${msg}`); if (!cond) failed++; };
const reads = (status) => { const seen = []; const read = async (c) => { seen.push(c); return status; }; read.seen = seen; return read; };
const control = { method: "POST", path: "/platform/v2/data/query/run", body: { sql: "SELECT 1" } };

// ---- a kit call that threw
{
  const down = reads(502);
  const v = await cdpFailureVerdict({ status: 502, control, read: down });
  ok(v.verdict === "upstream" && /HTTP 502/.test(v.evidence) && down.seen.length === 1 && down.seen[0] === control, "a 502 from the kit with the direct read failing too (502) is the service's: one direct read, of the control given");
  ok((await cdpFailureVerdict({ status: 504, control, read: reads(0) })).verdict === "upstream", "a 504 with no answer to the direct read is the service's");
  const up = await cdpFailureVerdict({ status: 502, control, read: reads(200) });
  ok(up.verdict === "fail" && /answers the runner's direct read/.test(up.reason), "a 502 from the kit while the service answers the direct read (200) FAILS: the failure is ours");
  for (const st of [401, 422, 429]) ok((await cdpFailureVerdict({ status: 502, control, read: reads(st) })).verdict === "fail", `a direct read answered ${st} is an answer: the kit's 502 fails`);
  for (const st of [400, 422, 429, 500, 503, undefined]) {
    const r = reads(502);
    ok((await cdpFailureVerdict({ status: st, control, read: r })).verdict === "fail" && r.seen.length === 0, `a kit failure of ${st} is never excused, and no direct read is sent`);
  }
  const none = reads(502);
  ok((await cdpFailureVerdict({ status: 502, control: undefined, read: none })).verdict === "fail" && none.seen.length === 0, "a call with no direct read (one with an effect) is never excused");
}

// ---- the observatory's collected errors
{
  const failing = "daily: CDP's query service is failing (HTTP 502 after 10.3 s, and a known-good query failed too); retry later. Nothing was charged.";
  const noResult = "volume: CDP's query service could not return this result (HTTP 502 after 0.1 s). It answers this way when a query runs past its answer window";
  const relayed = "merchants: CDP upstream error (HTTP 503): the query service is unavailable; retry shortly. Nothing was charged.";
  const clean = reads(502);
  const c = await observatoryVerdict({ errors: [], control, read: clean });
  ok(c.verdict === "clean" && clean.seen.length === 0, "no errors is clean, and no direct read is sent");

  const down = reads(502);
  const v = await observatoryVerdict({ errors: [failing, noResult, relayed], control, read: down });
  ok(v.verdict === "upstream" && down.seen.length === 1 && down.seen[0] === control, "three query 5xx errors with the direct known-good query failing too are the service's: one direct read");
  ok(JSON.stringify(v.failed) === JSON.stringify(["daily", "volume", "merchants"]) && v.failed.every((q) => OBSERVATORY_QUERIES.includes(q)), "the verdict names the queries that failed");
  const one = await observatoryVerdict({ errors: [noResult], control, read: reads(0) });
  ok(one.verdict === "upstream" && JSON.stringify(one.failed) === '["volume"]', "one failed query with no answer to the direct read: only that query is named, so the other sections are still asserted");

  const up = await observatoryVerdict({ errors: [failing, noResult, relayed], control, read: reads(200) });
  ok(up.verdict === "fail" && up.failed.length === 0 && /answers the runner's direct known-good query HTTP 200/.test(up.reason), "the same errors while the service answers the direct known-good query FAIL: the failure is ours");
  ok((await observatoryVerdict({ errors: [failing], control, read: reads(429) })).verdict === "fail", "a direct read answered 429 is an answer: fails");

  for (const ours of [
    "history: SQLITE_BUSY",
    "weekly: bad row",
    "daily: The query service is taking this server's queries as fast as its rate limit allows; retry in a few seconds. Nothing was charged.",
    "volume: CDP rejected the query (HTTP 400): unknown column",
    "merchants: Cannot read properties of undefined (reading 'rows')",
    "other: CDP's query service is failing (HTTP 502 after 1.0 s)",
  ]) {
    const r = reads(502);
    const o = await observatoryVerdict({ errors: [failing, ours], control, read: r });
    ok(o.verdict === "fail" && r.seen.length === 0, `an error that is not a query-service 5xx fails whatever the service does, with no direct read: ${ours.slice(0, 44)}`);
  }
  ok((await observatoryVerdict({ errors: [failing], control: undefined, read: reads(502) })).verdict === "fail", "no control given: fails");
}

// ---- the direct read itself: one plain request, signed, no retry
{
  const calls = [];
  const mint = async ({ method, path }) => { calls.push(["mint", method, path]); return "jwt-stub"; };
  const fetchImpl = (status) => async (url, init) => { calls.push(["fetch", url, init.method, init.headers.Authorization, init.body]); return { status, arrayBuffer: async () => new ArrayBuffer(0) }; };
  ok(await cdpDirectStatus(control, { mint, fetchImpl: fetchImpl(502) }) === 502, "the direct read returns the status the service gave");
  ok(calls.length === 2 && calls[0].join(" ") === "mint POST /platform/v2/data/query/run" && calls[1][1] === "https://api.cdp.coinbase.com/platform/v2/data/query/run" && calls[1][2] === "POST" && calls[1][3] === "Bearer jwt-stub" && calls[1][4] === '{"sql":"SELECT 1"}', "it is ONE signed request to the CDP host with the control's method, path and body");
  ok(await cdpDirectStatus({ path: "/platform/v2/data/query/schema" }, { mint, fetchImpl: fetchImpl(200) }) === 200 && calls[3][2] === "GET" && calls[3][4] === undefined, "a control with a path only is a GET with no body");
  ok(await cdpDirectStatus(control, { mint, fetchImpl: async () => { throw new TypeError("fetch failed"); } }) === 0, "a request that gets no answer reads 0");
  let aborted = false;
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { aborted = true; rej(init.signal.reason); }));
  const alive = setTimeout(() => {}, 5_000); // the deadline's own timer does not hold the process open; a real socket would
  ok(await cdpDirectStatus(control, { mint, fetchImpl: hang, timeoutMs: 50 }) === 0 && aborted, "a request past its deadline is ended and reads 0");
  clearTimeout(alive);
  ok(await cdpDirectStatus(control, { mint: async () => { throw new Error("no key"); }, fetchImpl: fetchImpl(200) }) === 0, "a token that cannot be minted reads 0 (and the kit's own call fails on the same key first)");
}

// ---- the live check reads every excuse through the verdicts
{
  const src = readFileSync(new URL("./test-cdp-live.js", import.meta.url), "utf8");
  ok(/cdpFailureVerdict\(\{ status: e\?\.statusCode, control \}\)/.test(src) && /observatoryVerdict\(\{ errors: snap\.errors, control: QUERY_CONTROL \}\)/.test(src), "test-cdp-live.js excuses a thrown failure and the observatory's errors only through the verdicts");
  ok(!/statusCode === 50[24]\) \{\s*console\.warn/.test(src) && !/okOrUpstream\(e, "[^"]+"\);\s*$/m.test(src.replace(/testnet-fund live call"\);/, "")), "no excuse on the kit's status alone remains, and every excused call but the faucet's names its direct read");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${failed} failed`);
process.exit(failed ? 1 : 0);
