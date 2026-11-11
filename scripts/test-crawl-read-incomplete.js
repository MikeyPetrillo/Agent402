#!/usr/bin/env node
// A crawl read of OURS that did not complete is not a verdict on the seller.
//
//   node scripts/test-crawl-read-incomplete.js
//
// One timed-out crawl (our time limit, a connection that never finished) used
// to roll a failure into the seller's history, so the seller read unroutable
// (`crawl_failed`) for a cycle, the failure counted toward the path backoff,
// and the record said the crawl failed. Pinned here, offline, through the
// real crawl pipeline (__setCrawlFetchForTest):
//   * a recent good seller whose every read times out stays routable with its
//     catalog, `lastReadIncomplete` says our read did not finish, the history
//     is untouched and no backoff is counted, however many cycles in a row;
//   * the seller's own answer (404 on every document) still makes it
//     unroutable and still backs the path off;
//   * a last good entry older than the hold reads as before (unroutable), with
//     errorKind "our-read-incomplete"; a cycle where most crawls ended on our
//     side holds it anyway;
//   * the cycle's ok fraction does not count a held entry as a read that worked;
//   * the dossier says "our last read did not complete", never "failed to parse".
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
process.env.X402_INDEX_CRAWL = "off";
delete process.env.INDEX_CRAWL_HOLD_HOURS;
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "crawl-read-incomplete-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const idx = await import("../src/x402-index.js");
const {
  registerOrigin, sellerDetail, __setCrawlFetchForTest, __testResetSubmitted, __resetRobotsCacheForTest, __crawlSellerForTest,
  crawlBackoffState, cycleOkFraction, _cacheForTests,
} = idx;
// Read through a guard so a build without the classifier fails on behavior, not on a missing export.
const crawlReadFailureIsOurs = (e) => typeof idx.crawlReadFailureIsOurs === "function" && idx.crawlReadFailureIsOurs(e);
const { composeSellerDossier } = await import("../src/tools/seller-dossier.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "c3".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifestFor = (o) => ({ x402Version: 2, name: "Read seller", resources: [{ resource: `${o}/v1/read`, method: "GET", description: "One read.", price: "$0.005", accepts }] });

// What safeFetch throws (src/tools/fetch-guard.js): our deadline, a connection
// the seller's host refused or reset, and the seller's own HTTP answer.
const ourTimeout = () => Object.assign(new Error("Source URL did not respond within 15s - host may be slow or unreachable"), { statusCode: 504, attribution: "upstream", hint: "source-timeout" });
const ourConnect = () => Object.assign(new Error("Could not connect to source URL: fetch failed (ECONNRESET)"), { statusCode: 504, attribution: "upstream", hint: "source-unreachable" });
const their404 = () => Object.assign(new Error("Source URL returned HTTP 404 - check the URL is correct and publicly reachable"), { statusCode: 422, upstreamStatus: 404, attribution: "caller" });

const mode = new Map(); // host -> "ok" | "timeout" | "connect" | "404"
const served = new Map();
let fetchCount = 0;
__setCrawlFetchForTest(async (url) => {
  const u = new URL(url);
  if (u.pathname === "/robots.txt") return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
  fetchCount++;
  const m = mode.get(u.hostname) || "ok";
  if (m === "timeout") throw ourTimeout();
  if (m === "connect") throw ourConnect();
  const hit = served.get(url);
  if (m === "404" || !hit) throw their404();
  return { html: JSON.stringify(hit), finalUrl: url, validators: null };
});
// Unpaid route probes (quotes, paywall) never leave the process: every route answers 402.
idx.__setProbeFetchForTest(async () => new Response(JSON.stringify({ x402Version: 2, accepts }), { status: 402, headers: { "content-type": "application/json" } }));
const seller = (name) => { const o = `https://${name}.example.test`; served.set(`${o}/.well-known/x402`, manifestFor(o)); return o; };
const host = (o) => new URL(o).hostname;
const crawl = async (o) => { __resetRobotsCacheForTest(); await __crawlSellerForTest(o); return _cacheForTests().get(o); };
// The document paths' failure counts (the quote probes keep their own).
const backedOff = (o) => crawlBackoffState().filter((b) => b.origin === o && !b.path.startsWith("quote:")).map((b) => `${b.path}:${b.fails}`).sort().join(",");

__testResetSubmitted();

// ---- the classifier
ok(crawlReadFailureIsOurs(ourTimeout()), "our time limit is ours");
ok(!crawlReadFailureIsOurs(ourConnect()), "a connection the seller's host refused or reset (source-unreachable) is the seller's host answering");
ok(!crawlReadFailureIsOurs(their404()) && !crawlReadFailureIsOurs(Object.assign(new Error("x"), { robotsBlocked: true })), "the seller's HTTP answer and its robots.txt are the seller's");
ok(crawlReadFailureIsOurs(Object.assign(new Error("Resource exceeds 4MB limit"), { statusCode: 413 })) && !crawlReadFailureIsOurs(Object.assign(new Error("HTTP 413"), { statusCode: 422, upstreamStatus: 413 })), "our byte cap is ours; a 413 the seller sent is the seller's");
ok(crawlReadFailureIsOurs(Object.assign(new Error("lookup"), { code: "EDNSUNAVAILABLE" })), "our resolver failing is ours");
// Our own network path failing to connect (no local address) is ours; the
// host refusing or resetting, or no route to the host or its network (an
// ICMP answer near the host can carry that), is the host's. Driven through the real safeFetch (a public IP literal, so
// no lookup, and a stubbed transport), so the code it carries is the one the
// classifier reads.
{
  const { safeFetch } = await import("../src/tools/fetch-guard.js");
  const thrownFor = async (code) => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) }); };
    try { await safeFetch("http://93.184.216.34/.well-known/x402", { timeoutMs: 2_000 }); return null; } catch (e) { return e; } finally { globalThis.fetch = prev; }
  };
  for (const code of ["EADDRNOTAVAIL"]) {
    const e = await thrownFor(code);
    ok(e?.hint === "source-unreachable" && e.transportCode === code && crawlReadFailureIsOurs(e), `a connect that failed with ${code} on our side is ours (${e?.hint} ${e?.transportCode})`);
  }
  for (const code of ["ECONNREFUSED", "ECONNRESET", "CERT_HAS_EXPIRED", "EHOSTUNREACH", "ENETUNREACH"]) {
    const e = await thrownFor(code);
    ok(e?.hint === "source-unreachable" && e.transportCode === code && !crawlReadFailureIsOurs(e), `a connect the host answered with ${code} is the host's (${e?.hint} ${e?.transportCode})`);
  }
  ok(!crawlReadFailureIsOurs(Object.assign(new Error("x"), { statusCode: 504, hint: "source-timeout-not", transportCode: "EADDRNOTAVAIL" })), "the code counts only on a source-unreachable answer");
}
ok(!crawlReadFailureIsOurs(new SyntaxError("Unexpected token < in JSON")), "a document that is not JSON is the seller's answer");

// ---- 1. a recent good seller, our reads time out: kept as it was
{
  const o = seller("steady");
  const r = await registerOrigin(o, {});
  ok(r?.listed === true && sellerDetail(o)?.routable === true, "the seller registers and is routable");
  const before = _cacheForTests().get(o);
  const historyBefore = JSON.stringify(before.history);
  const backoffBefore = backedOff(o);
  for (let i = 0; i < 6; i++) {
    mode.set(host(o), "timeout");
    await crawl(o);
  }
  const d = sellerDetail(o);
  ok(d?.routable === true && !d.error, `six cycles of our reads not completing leave it routable with no error (${JSON.stringify({ routable: d?.routable, error: d?.error })})`);
  ok(d?.toolCount === 1, "with its catalog");
  ok(d?.lastReadIncomplete && /did not complete/.test(d.lastReadIncomplete.note) && d.lastReadIncomplete.at, `the record says our read did not complete (${JSON.stringify(d?.lastReadIncomplete)})`);
  ok(JSON.stringify(_cacheForTests().get(o).history) === historyBefore, "the history is untouched: no failure was rolled in");
  const steps = crawlBackoffState().filter((b) => b.origin === o && !b.path.startsWith("quote:"));
  ok(steps.some((b) => b.path === "/.well-known/x402" && b.fails === 2) && steps.every((b) => b.fails <= 3 && !(b.nextAt > Date.now())),
    `six crawls of our timeouts count only slower steps (one per three reads of a path) and back nothing off yet (${backoffBefore || "none"} before, ${backedOff(o)} after)`);
  ok(cycleOkFraction([o]) === 0, "the cycle's ok fraction does not count a held entry as a read that worked");
  const dossier = composeSellerDossier({ origin: o, detail: d, entry: _cacheForTests().get(o) });
  const flags = (dossier?.flags || []).join(" | ");
  ok(/our last read of this origin did not complete/.test(flags) && !/failed to parse|last crawl failed/.test(flags), `the dossier says our read did not complete (${flags.slice(0, 200)})`);
  mode.set(host(o), "ok");
  await crawl(o);
  ok(!_cacheForTests().get(o).readIncomplete && !sellerDetail(o)?.lastReadIncomplete, "a completed read clears the note");
}

// ---- 2. the seller's own answer: unroutable and backed off, as before
{
  const o = seller("gone");
  await registerOrigin(o, {});
  mode.set(host(o), "404");
  for (let i = 0; i < 4; i++) await crawl(o);
  const d = sellerDetail(o);
  ok(d?.routable === false && d.error && d.errorKind === "seller-answer", `a 404 on every document is the seller's answer: unroutable (${JSON.stringify({ routable: d?.routable, errorKind: d?.errorKind })})`);
  ok(crawlBackoffState().some((b) => b.origin === o && b.path === "/.well-known/x402" && b.nextAt > Date.now()), "and the manifest path backs off after four of them");
}

// ---- 2b. a seller whose host refuses connections is its own answer: the
// path backs off and it reads unroutable (never held as our read)
{
  const o = seller("refusing");
  await registerOrigin(o, {});
  mode.set(host(o), "connect");
  let fetches = 0;
  const per = [];
  for (let i = 0; i < 10; i++) {
    const before = fetchCount;
    await crawl(o);
    per.push(fetchCount - before);
    fetches += fetchCount - before;
  }
  const d = sellerDetail(o);
  ok(d?.routable === false && d.errorKind === "seller-answer" && !d.lastReadIncomplete, `a refused connection is the seller's answer: unroutable, not held (${JSON.stringify({ routable: d?.routable, errorKind: d?.errorKind })})`);
  ok(per.slice(-1)[0] === 0 && fetches <= 20, `and its paths back off: fetches per crawl ${per.join(",")}`);
}

// ---- 3. past the hold: a last good entry older than 6 h reads as before
{
  const o = seller("stale");
  await registerOrigin(o, {});
  const v = _cacheForTests().get(o);
  _cacheForTests().set(o, { ...v, fetchedAt: Date.now() - 7 * 3600_000 });
  const backoffBefore = backedOff(o);
  mode.set(host(o), "timeout");
  await crawl(o);
  const d = sellerDetail(o);
  ok(d?.routable === false && d.errorKind === "our-read-incomplete", `seven hours after the last completed read it is unroutable, and says the read was ours (${JSON.stringify({ routable: d?.routable, errorKind: d?.errorKind })})`);
  ok(backedOff(o) === backoffBefore, "still no backoff counted for our own failures");
  const dossier = composeSellerDossier({ origin: o, detail: d, entry: _cacheForTests().get(o) });
  ok((dossier?.flags || []).some((f) => /our last read of this origin did not complete .*not an answer from the seller/.test(f)), "the dossier flag names it as our read");
}

// ---- 4. a cycle where most crawls ended on our side holds even an old entry
{
  const o = seller("egress");
  await registerOrigin(o, {});
  const v = _cacheForTests().get(o);
  _cacheForTests().set(o, { ...v, fetchedAt: Date.now() - 9 * 3600_000 });
  idx.__setLastCycleOursShareForTest?.(0.8);
  mode.set(host(o), "timeout");
  await crawl(o);
  ok(sellerDetail(o)?.routable === true && sellerDetail(o)?.lastReadIncomplete, "when most of the last cycle's crawls ended on our side, the hold does not age out");
  idx.__setLastCycleOursShareForTest?.(0);
}

// ---- 5. manifest 404 (theirs) but the OpenAPI read that listed it timed out (ours)
{
  const o = "https://openapi-only.example.test";
  served.set(`${o}/openapi.json`, { openapi: "3.0.0", info: { title: "OA seller" }, paths: { "/v1/x": { get: { summary: "One x.", "x-payment-info": { price: "$0.005", accepts } } } } });
  await registerOrigin(o, {});
  const d0 = sellerDetail(o);
  if (d0?.routable === true) {
    // The manifest answers 404 (definite); the OpenAPI read times out (ours).
    __setCrawlFetchForTest(async (url) => {
      const p = new URL(url).pathname;
      if (p === "/robots.txt") return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
      if (p === "/openapi.json") throw ourTimeout();
      throw their404();
    });
    await crawl(o);
    const d = sellerDetail(o);
    ok(d?.routable === true && d.lastReadIncomplete, `the document that decided its listing was ours to read and did not complete: held (${JSON.stringify({ routable: d?.routable })})`);
  } else {
    ok(true, `(the OpenAPI-only fixture did not list as routable here: ${JSON.stringify({ routable: d0?.routable, error: d0?.error })}; case skipped)`);
  }
}

__setCrawlFetchForTest(null);
idx.__setProbeFetchForTest(null);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
