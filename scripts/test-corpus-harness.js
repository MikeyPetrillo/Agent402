#!/usr/bin/env node
// The corpus runner's two pure pieces: expectation checking and outcome
// classification. Offline. Mutation-sensitive by design: every rule the corpus
// relies on is asserted here, so a change that quietly weakens an assertion
// (a `populated` that accepts [], a 500 read as upstream) fails this file
// before it can turn the corpus green.
import { checkExpect, classify, getPath, paceWaitMs, targetHostOf } from "./test-corpus.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// getPath
ok(getPath({ a: { b: [10, { c: "x" }] } }, "a.b[1].c") === "x", "getPath walks dots and brackets");
ok(getPath({ a: null }, "a.b") === undefined, "getPath on null is undefined, never a throw");

// populated: the whole point - an empty answer is not populated
const body = { n: 0, s: "", arr: [], obj: {}, nul: null, nan: NaN, list: [1], text: "t" };
ok(checkExpect({ populated: ["n"] }, 200, body).length === 0, "0 is populated (a number is a value)");
for (const p of ["s", "arr", "obj", "nul", "nan", "missing"]) ok(checkExpect({ populated: [p] }, 200, body).length === 1, `${p} is NOT populated`);
ok(checkExpect({ populated: ["list", "text"] }, 200, body).length === 0, "non-empty array + string are populated");
// empty: the honest-empty case
ok(checkExpect({ empty: ["arr"] }, 200, body).length === 0 && checkExpect({ empty: ["list"] }, 200, body).length === 1 && checkExpect({ empty: ["nul"] }, 200, body).length === 1, "empty demands an actual []");
// equals / count / matches / numeric
ok(checkExpect({ equals: { "list[0]": 1, obj: {} } }, 200, body).length === 0, "equals is deep");
ok(checkExpect({ equals: { n: "0" } }, 200, body).length === 1, "equals is typed (0 != \"0\")");
ok(checkExpect({ count: { list: 1 }, minCount: { text: 1 }, maxCount: { list: 1 } }, 200, body).length === 0, "count on arrays and strings");
ok(checkExpect({ count: { n: 1 } }, 200, body).length === 1, "count on a number fails, never passes by accident");
ok(checkExpect({ matches: { text: "^T$" } }, 200, body).length === 0, "matches is case-insensitive");
ok(checkExpect({ gt: { n: -1 }, gte: { n: 0 }, lt: { n: 1 } }, 200, body).length === 0 && checkExpect({ gt: { text: 0 } }, 200, body).length === 1, "numeric comparisons; a non-number never satisfies gt");
// status
ok(checkExpect({}, 500, body).length === 1 && checkExpect({}, 200, body).length === 0, "default status is 200");
ok(checkExpect({ status: 400 }, 400, { error: "x" }).length === 0, "a 4xx case passes with a self-explaining error");
ok(checkExpect({ status: 400 }, 400, { message: "x" }).length === 1, "a 4xx with no `error` field fails");
ok(checkExpect({ status: 400, matches: { error: "currency" } }, 400, { error: "unknown currency" }).length === 0, "4xx matches run against the error text");
ok(checkExpect({ status: 400 }, 200, { error: "x" }).length === 1, "a 200 where a 400 was expected fails");

// classify
const T = (o) => classify({ expectFails: [], ...o }).kind;
ok(T({ status: 200, body: {}, tier: 1 }) === "ok", "clean is ok");
ok(T({ status: 200, body: {}, tier: 1, expectFails: ["x"] }) === "fatal", "an expectation miss is fatal");
ok(T({ status: 500, body: { error: "boom" }, tier: 1 }) === "fatal", "a 500 is fatal");
ok(T({ status: 502, body: { error: "upstream" }, tier: 1 }) === "upstream" && T({ status: 429, body: {}, tier: 1 }) === "upstream", "502/429 on a networked tool is upstream");
ok(T({ status: 503, body: { error: "x" }, tier: 0 }) === "fatal", "a 503 from a pure-CPU tool is fatal (nothing upstream to blame)");
ok(T({ status: 503, body: { error: "search is not configured (BRAVE_API_KEY)" }, tier: 2 }) === "skipped", "a not-configured 503 is skipped");
ok(T({ status: 0, body: null, netError: "ECONNRESET", tier: 1 }) === "upstream", "a network error is upstream");
ok(T({ status: 400, body: { error: "\"x\" is required" }, tier: 1, expectFails: ["status 400, expected 200"] }) === "fatal", "our own 400 on a valid input is fatal");
ok(T({ status: 422, body: { error: "Source URL timed out" }, tier: 1, expectFails: ["status 422, expected 200"] }) === "upstream", "fetch-guard's own relabelled upstream timeout (422 'Source URL timed out') is upstream on a networked tool");
ok(T({ status: 400, body: { error: '"timeout" must be a number' }, tier: 1, expectFails: ["status 400, expected 200"] }) === "fatal", "our own 400 that merely contains the word timeout is fatal (review, 2026-09-06)");
ok(T({ status: 404, body: { error: "Price feed upstream: not found (check ids)" }, tier: 1, expectFails: ["status 404, expected 200"] }) === "fatal", "our own 404 that contains the word upstream is fatal");

// Outside target hosts: a case whose input points the tool at another host
// depends on that host for its expected value. Its 5xx or silence is upstream,
// named; the same body with no target host is our hollow 200 (2026-10-12:
// httpbin.org answered 503 to a 404 probe and http-check was paged as broken).
{
  ok(targetHostOf({ url: "https://httpbin.org/status/404" }) === "httpbin.org", "targetHostOf reads the input url's host");
  ok(targetHostOf({ url: "https://agent402.tools/api/no-such-route" }) === null, "a url on our own host is not an outside target");
  ok(targetHostOf({ url: "https://www.agent402.tools/x" }) === null, "nor is a subdomain of ours");
  ok(targetHostOf({ feed: { url: "HTTPS://Example.COM/rss" } }) === "example.com", "nested inputs are walked; the host is lower-cased");
  ok(targetHostOf({ symbol: "MSFT", note: "see https://" }) === null, "no parseable url: no target");
  ok(targetHostOf(null) === null && targetHostOf("x") === null, "non-object inputs: no target");
  const probe503 = { up: true, status: 503, latencyMs: 96, finalUrl: "https://httpbin.org/status/404", headers: {} };
  const miss = ["status = 503, expected 404"];
  const c = classify({ status: 200, body: probe503, tier: 1, expectFails: miss, targetHost: "httpbin.org" });
  ok(c.kind === "upstream" && /httpbin\.org/.test(c.note) && /503/.test(c.note), `http-check reading an outside host's 503 is upstream and names the host (${c.note})`);
  ok(T({ status: 200, body: probe503, tier: 1, expectFails: miss }) === "fatal", "the same body with no target host is our hollow 200: fatal");
  ok(T({ status: 200, body: probe503, tier: 0, expectFails: miss, targetHost: "httpbin.org" }) === "fatal", "a pure-CPU tool has no outside host to blame: fatal");
  ok(T({ status: 200, body: { up: true, status: 404 }, tier: 1, expectFails: ["status = 404, expected 200"], targetHost: "example.com" }) === "fatal", "an outside host's 4xx is a reading, not an outage: the miss stays fatal");
  ok(T({ status: 200, body: { up: false, error: "Timed out after 15s", latencyMs: 15001 }, tier: 1, expectFails: ["up = false, expected true"], targetHost: "example.com" }) === "upstream", "up:false with the target's error is the target's silence");
  ok(T({ status: 200, body: { up: false, error: "Timed out after 15s" }, tier: 1, expectFails: ["up = false, expected true"] }) === "fatal", "up:false with no target host stays ours");
  ok(T({ status: 200, body: { items: [], count: 0 }, tier: 1, expectFails: ["items not populated"], targetHost: "example.com" }) === "fatal", "a hollow 200 that reports no target failure is ours even with a target host");
  ok(T({ status: 200, body: { error: "Source URL returned HTTP 502" }, tier: 1, expectFails: ["x"], targetHost: "example.com" }) === "upstream", "a 200 whose error text is the network vocabulary names the target");
  const u = classify({ status: 504, body: { error: "Source URL did not respond within 15s" }, tier: 1, expectFails: ["status 504, expected 200"], targetHost: "example.com" });
  ok(u.kind === "upstream" && /outside host example\.com/.test(u.note), `a 5xx on a case with a target host names the host (${u.note})`);
  ok(!/outside host/.test(classify({ status: 504, body: { error: "Price feed upstream timed out" }, tier: 1, expectFails: ["x"] }).note), "a tool on a fixed upstream carries its own message, no invented host");
}
// A keyless boot: a pack whose every step says "not configured" answers 502,
// and that is configuration, not an outside host (three packs read as upstream
// 21 nights running after the equities feed went key-gated on 2026-09-20).
ok(T({ status: 502, body: { error: 'No step in the "trend-analysis" pack succeeded, so there is nothing to return (not charged). stock-history: Market data is not configured on this server (DATABENTO_API_KEY unset).; stats-summary: "values" must be a non-empty array' }, tier: 1 }) === "skipped", "a pack 502 whose steps are not configured is skipped");
ok(T({ status: 502, body: { error: 'No step in the "x" pack succeeded, so there is nothing to return (not charged). edgar-search: EDGAR upstream HTTP 500' }, tier: 1 }) === "upstream", "a pack 502 whose steps hit an upstream stays upstream");

// pace: cases sharing a paceKey share ONE clock across files. Three per-file
// clocks at 3 s each started the CoinGecko cases 60/min against a 25/min
// bucket (nightly 2026-09-06: 13 cases rate-limited, never verified).
{
  const clocks = new Map();
  const a = { file: "chain.json", paceKey: "coingecko", pace: 5000 };
  const b = { file: "crypto-defi.json", paceKey: "coingecko", pace: 5000 };
  ok(paceWaitMs(a, clocks, 1000) === 0, "the first case on a clock starts at once");
  ok(paceWaitMs(b, clocks, 1000) === 5000, "a case in ANOTHER file on the same paceKey waits the full pace");
  ok(paceWaitMs({ file: "other.json", paceKey: "other.json", pace: 3000 }, clocks, 1000) === 0, "a different key is a different clock");
  ok(paceWaitMs({ file: "x.json", pace: 0 }, clocks, 1000) === 0 && !clocks.has("x.json"), "no pace: never waits, never reserves a slot");
  ok(paceWaitMs({ file: "chain.json", pace: 3000 }, clocks, 1000) === 0 && clocks.get("chain.json") === 4000, "no paceKey falls back to the file as the clock");
  ok(paceWaitMs(a, clocks, 20_000) === 0 && clocks.get("coingecko") === 25_000, "a clock in the past restarts from now");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
