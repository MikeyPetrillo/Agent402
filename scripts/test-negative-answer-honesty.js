// A NEGATIVE ANSWER MUST BE A FACT ABOUT ITS SUBJECT, NOT ABOUT US.
//
// Three live instances taught the shape, all in one week of 2026-09:
//   - GET /api/index returned 250 sellers of 4,473 and a seller's own checker
//     read "not in the index" off page 0; they were on page 15.
//   - GET /api/index?seller= cut the tool list at 500 with nothing saying so,
//     next to a toolCount that was right, which is what made it convincing.
//   - retired routes answered a generic 404 and an outside census graded us a
//     broken seller until they became 410 Gone naming the replacement.
//
// The tell is always the same: the DATA is right and the CONTRACT is quiet. A
// miss, an empty list, a null or an error reaches a machine with nothing on it
// to say whose fact it is. This file pins the answers to that, and every
// assertion here is either a pure function or a real HTTP response.
//
// Deliberately pure where the branch is unreachable from a booted test: a CI
// boot is ALWAYS one readiness state (crawler off, cache empty), so the two
// states that answer "ask again" can only be exercised through readinessOf().
// Same reasoning as src/index-paging.js, written for the same defect.
//
//   node scripts/test-negative-answer-honesty.js
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readinessOf } from "../src/x402-index.js";
import { upstreamFailure, retryAfterSeconds, retryTransient } from "../src/tools/fetch-guard.js";
import { getFreePort } from "./lib/free-port.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// ---------------------------------------------------------------- readiness
// "We hold no row for that seller" has four causes and only one of them is a
// fact about the seller.
{
  const warm = readinessOf({ warmStarting: true, sellers: 12, crawlsCompleted: 0, crawlerRunning: true });
  ok(warm.ready === false && warm.state === "warm-start" && warm.retryAfterSeconds > 0,
    "mid warm-start: not ready, and it names a retry (the ~2 s after EVERY boot, and every deploy is a boot)");

  const first = readinessOf({ warmStarting: false, sellers: 0, crawlsCompleted: 0, crawlerRunning: true });
  ok(first.ready === false && first.state === "first-crawl" && first.retryAfterSeconds >= 30,
    "empty cache with the crawler running: not ready (a volume with no cache waits minutes for its first crawl)");

  const off = readinessOf({ warmStarting: false, sellers: 0, crawlsCompleted: 0, crawlerRunning: false });
  ok(off.ready === true && off.state === "disabled",
    "crawler switched off: READY, because waiting changes nothing - a caller must be told that, not told to retry forever");

  const loaded = readinessOf({ warmStarting: false, sellers: 4473, crawlsCompleted: 0, crawlerRunning: true });
  ok(loaded.ready === true && loaded.state === "ready" && loaded.sellers === 4473,
    "a warm-started cache is ready before any crawl completes (the rows are real)");

  const crawledEmpty = readinessOf({ warmStarting: false, sellers: 0, crawlsCompleted: 1, crawlerRunning: true });
  ok(crawledEmpty.ready === true,
    "a completed crawl that found nothing is an ANSWER, not a loading state");

  ok(readinessOf().ready === true && readinessOf({}).state === "disabled",
    "no arguments never throws and never claims to be mid-load");
}

// ------------------------------------------------- upstream attribution
// Who does this failure belong to? The old rule said "the caller" for every
// upstream 4xx and told them to check a URL that was often perfectly correct.
{
  const throttled = upstreamFailure(429, { retryAfter: 30, host: "api.example.com" });
  ok(throttled.statusCode === 503 && throttled.attribution === "upstream" && throttled.retryAfter === 30,
    "429 is the host throttling THIS SERVER: 503 + attribution upstream + a retry, never a 4xx about the input");
  ok(/the URL is fine/.test(throttled.message) && !/check the URL/.test(throttled.message),
    "...and the message says the URL is fine instead of telling the caller to check it");
  ok(/api\.example\.com/.test(throttled.message) && !/\/secret/.test(upstreamFailure(429, { host: "api.example.com" }).message),
    "the message names the HOST only - a refused URL can carry a caller's token in its path or query");

  ok(upstreamFailure(408).statusCode === 503 && upstreamFailure(408).attribution === "upstream",
    "408 is the same class as 429: the host did not answer us in time");

  for (const s of [401, 403, 407, 451]) {
    const e = upstreamFailure(s);
    ok(e.statusCode === 422 && e.attribution === "upstream-access" && /access, not a bad URL/.test(e.message),
      `${s} is access, not addressing: attributed upstream-access, and the message says so (our egress is blocked by three documented hosts)`);
  }

  for (const s of [400, 404, 410, 414, 415]) {
    const e = upstreamFailure(s);
    ok(e.statusCode === 422 && e.attribution === "caller" && /check the URL/.test(e.message),
      `${s} really is the caller's URL: 422 attributed caller, message unchanged`);
  }

  for (const s of [500, 502, 503, 504]) {
    ok(upstreamFailure(s).statusCode === 502 && upstreamFailure(s).attribution === "upstream",
      `${s} stays a 502 attributed upstream`);
  }

  ok(upstreamFailure(404).upstreamStatus === 404 && upstreamFailure(429).upstreamStatus === 429,
    "every one carries upstreamStatus, so a machine never has to parse the sentence");
}

// Retry-After, both spellings the RFC allows.
{
  ok(retryAfterSeconds("30") === 30, "Retry-After delta-seconds");
  ok(retryAfterSeconds(new Date(Date.now() + 45_000).toUTCString()) === 45, "Retry-After HTTP-date");
  ok([null, "", "soon", "0", "-5", "999999"].every((v) => retryAfterSeconds(v) === null),
    "junk, zero, negative and absurd values read as 'it said nothing', never as 0 seconds");
}

// A rate limit must not be retried INTO the host that is rate-limiting us.
{
  let calls = 0;
  const throttling = async () => { calls++; throw upstreamFailure(429, { retryAfter: 1 }); };
  await retryTransient(throttling, { backoffMs: 1 }).catch(() => {});
  ok(calls === 1, "retryTransient does NOT retry a 429, even though it is now a 503 (retrying a rate limit makes the upstream's problem worse)");

  let gw = 0;
  const gateway = async () => { gw++; throw upstreamFailure(503); };
  await retryTransient(gateway, { backoffMs: 1 }).catch(() => {});
  ok(gw === 2, "...and the rest of the 503 family keeps its retry");
}

// ------------------------------------------------------- wiring, from source
// These branches need a loading index or a blocked upstream, neither of which a
// booted CI server can produce, so they are pinned where they are written.
{
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  ok(/const r = indexReadiness\(\);[\s\S]{0,600}?res\.status\(503\)/.test(server),
    "the ?seller= miss consults indexReadiness and answers 503 while loading, instead of 404-ing a seller we simply have not read yet");
  ok(/complete: wholeIndex/.test(server) && /const wholeIndex = complete && ready\.ready/.test(server),
    "a page of a still-loading index never calls itself complete");
  ok(/!result\.error && !result\.indexing/.test(server),
    "a discovery answer computed while the index is loading is not written to the 60 s cache (it would outlive the window that produced it)");
  ok(/const fromUpstream = attribution === "upstream" \|\| attribution === "upstream-access"/.test(server)
    && /status >= 400 && status < 500 && !fromUpstream/.test(server),
    "the route binder suppresses the input-schema envelope when the failure was attributed upstream: re-reading a schema cannot fix a host that is refusing us");
  ok(/if \(Number\.isInteger\(err\?\.retryAfter\)\) res\.set\("Retry-After"/.test(server),
    "...and an upstream that named a Retry-After has it relayed as the header, not only as prose");

  const dossier = readFileSync(join(ROOT, "src/tools/seller-dossier.js"), "utf8");
  ok(/getIndexReadiness/.test(dossier) && /e\.statusCode = 503/.test(dossier),
    "the $0.05 seller dossier refuses rather than selling 'never crawled' about a seller our index has not finished loading");

  ok(/function sendToolError\(res, err, slug\)/.test(server) && (server.match(/sendToolError\(res, err, "/g) || []).length >= 6,
    "the six URL-taking routes outside the generic binder relay through ONE helper: each had its own copy of the old relay, so teaching the binder alone would have left them answering the old way");
  // Line-based, skipping comments: the helper's own docstring QUOTES the relay
  // it replaced, and a naive scan of the whole file reads that as a survivor.
  const bareRelay = server.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .filter((l) => /res\.status\(err\.statusCode \|\| 502\)\.json\(\{ error: err\.message \}\)/.test(l));
  ok(bareRelay.length === 0,
    `no CODE copy of the bare relay survives to drift from the helper (found ${bareRelay.length})`);

  const mcp = readFileSync(join(ROOT, "src/mcp-http.js"), "utf8");
  ok(/whoseFault: "not your input/.test(mcp) && /fromUpstream \|\| status >= 500/.test(mcp),
    "the hosted connector stops telling an agent to reshape its input when a third party refused us - same envelope, same defect, one surface over from the HTTP binder");
  ok(/retry the SAME call later; changing the input will not help/.test(mcp),
    "...and names the next step, because an agent reading a schema hint retries into the host that is throttling us");

  const kit = readFileSync(join(ROOT, "src/tools/x402-kit.js"), "utf8");
  ok(/freshness: \{/.test(kit) && /staleFromDisk: !!snap\?\.staleFromDisk/.test(kit) && /refreshFailing: !!snap\?\.cache\?\.lastError/.test(kit),
    "the paid momentum radar publishes whether its board is a current scan, a boot restore, or a stale one whose refresh is failing - all three fields existed on the snapshot and were dropped here");
  ok(/the demand board reports \$\{Number\(agg\.distinctClusters\)\} clusters but returned no rows/.test(kit),
    "the demand radar refuses a board it cannot see rather than selling the hollow 200 that ran for six weeks");

  const cache = readFileSync(join(ROOT, "src/cache.js"), "utf8");
  ok(/"\/api\/route": \{ ttl: 60, keyFields: \[[^\]]*"network"\]/.test(cache),
    "/api/route's cache key includes `network`: without it a Solana-filtered query served the Base answer for 60 s");
}

// ------------------------------------------------------------- live server
{
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`,
      X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
  }
  try {
    ok(up, "server booted");

    const miss = await fetch(`${base}/api/index?seller=nobody.example`);
    const missBody = await miss.json();
    ok(miss.status === 404, "an unknown seller still 404s when the index is settled");
    ok(missBody.indexing === false && typeof missBody.indexState === "string" && Number.isInteger(missBody.indexedOrigins),
      "...and the 404 says how many origins this server actually holds, which turns 'not found' from a verdict into a reading");

    const tools = await fetch(`${base}/api/index/tools?limit=2`);
    const t = await tools.json();
    ok(t.complete === false && t.hasMore === true && t.nextOffset === 2,
      `the machine-readable tool index says it is one window (complete:false, hasMore, nextOffset), not the whole listing (matched ${t.matched})`);
    ok(tools.headers.get("x-total-count") === String(t.matched),
      "...and publishes the total in a header a crawler reads before the body");
    // ?limit=1000 is CLAMPED to 500 rows. That clamp was silent until these
    // fields existed - a caller asking for everything got 500 of 587 and no
    // hasMore, which is the same "quiet contract" shape one endpoint over.
    const clamped = await (await fetch(`${base}/api/index/tools?limit=1000`)).json();
    ok(clamped.limit === 500 && clamped.hasMore === true && clamped.nextOffset === 500,
      `a clamped limit is visible: asked 1000, served ${clamped.limit}, and hasMore/nextOffset say the rest exists`);
    const last = await (await fetch(`${base}/api/index/tools?limit=500&offset=${clamped.nextOffset}`)).json();
    ok(last.complete === true && last.hasMore === false && last.nextOffset === undefined,
      "the final window says complete:true and offers no next offset");

    const idx = await (await fetch(`${base}/api/index?limit=5`)).json();
    ok(idx.indexing === false && typeof idx.indexState === "string",
      "/api/index states its loading state as a field, beside the paging fields");
  } finally {
    proc.kill("SIGKILL");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
