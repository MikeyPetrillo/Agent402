#!/usr/bin/env node
// A failed paywall verdict expires. The per-origin `paywall` reading is taken
// on a rotation that reaches each seller days apart across the index, and a
// stored failure was otherwise carried forward on every crawl, so a seller
// that fixed its paywall (or re-registered) kept the old failure until its
// rotation slot came round. Offline: documents go through the crawl seam and
// probes through the probe seam, against one loopback listener, so the REAL
// crawl pipeline (crawlSeller -> probePaywall) runs with no network.
//
// What is pinned:
//   * a failed verdict younger than the window is carried forward with its own
//     `at` (no probe); past the window the next crawl re-probes it and a seller
//     that now answers 402 reads ok with a new `at`;
//   * a seller that keeps failing is re-probed at most once per window;
//   * a re-registration (and a first registration) probes the paywall at once;
//   * the re-check budget per cycle holds, and the next cycle's budget reaches
//     the seller the last one could not;
//   * a documentation template route is never the probed URL, and a stored
//     failure measured on one is expired.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("paywall-recheck"));
process.env.X402_INDEX_CRAWL = "off";
// One rotation probe per cycle over a padded cache: the rotation never fires
// in this suite, so every probe seen is the re-check, the force, or nothing.
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "1";
process.env.X402_PAYWALL_RECHECKS_PER_CYCLE = "2";
delete process.env.X402_PAYWALL_FAILED_RECHECK_HOURS;
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "paywall-recheck-")), "removed-origins.json");
}
const { createServer } = await import("node:http");
const {
  paywallVerdictExpired, registerOrigin, sellerDetail,
  __setCrawlFetchForTest, __setProbeFetchForTest, __crawlSellerForTest, __testResetSubmitted, __resetRobotsCacheForTest,
  __resetForcedCrawlForTest, __resetPaywallProbeForTest, _cacheForTests,
} = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const DAY = 86_400_000;

// ---------------------------------------------------------------- pure rule
{
  const now = Date.now();
  ok(paywallVerdictExpired(null, now) === false, "no verdict is the rotation's business, not expired");
  ok(paywallVerdictExpired({ ok: true, status: 402, at: now - 30 * DAY, url: "https://a.example.test/v1/quote" }, now) === false, "a passing verdict is never expired here");
  ok(paywallVerdictExpired({ ok: false, status: 400, at: now - 23 * 3_600_000, url: "https://a.example.test/v1/quote" }, now) === false, "a failure younger than 24 hours stands");
  ok(paywallVerdictExpired({ ok: false, status: 400, at: now - 25 * 3_600_000, url: "https://a.example.test/v1/quote" }, now) === true, "a failure older than 24 hours is expired");
  ok(paywallVerdictExpired({ ok: false, status: 400, url: "https://a.example.test/v1/quote" }, now) === true, "a failure with no age is expired");
  ok(paywallVerdictExpired({ ok: false, status: 400, at: now, url: "https://a.example.test/v1/token/:param" }, now) === true, "a fresh failure measured on a :param template is expired");
  ok(paywallVerdictExpired({ ok: false, status: 400, at: now, url: "https://a.example.test/v1/token/%7Bsymbol%7D" }, now) === true, "a fresh failure measured on a {param} template is expired");
  ok(paywallVerdictExpired({ ok: false, status: 400, at: now - 2 * 3_600_000 }, now, 3_600_000) === true, "the window is a parameter");
}

// ---------------------------------------------------------------- loopback seller
// One listener stands in for every seller host: the probe seam sends
// https://<host>/<path> to /<host>/<path> on it, and it answers 400 or 402 by
// the host's current mode. The live-quote enrichment asks the same routes, so
// paywall probes are counted at the seam by their caller.
const mode = new Map();   // host -> 400 | 402
const hits = new Map();   // host -> paywall probes
const server = createServer((req, res) => {
  const [, host] = req.url.split("/");
  const status = mode.get(host) || 402;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(status === 402 ? { error: "payment required" } : { error: "bad request" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const loop = `http://127.0.0.1:${server.address().port}`;
const asked = [];
__setProbeFetchForTest((url, opts) => {
  asked.push(url);
  const u = new URL(url);
  if (/\bprobePaywall\b/.test(String(new Error().stack))) hits.set(u.hostname, (hits.get(u.hostname) || 0) + 1);
  if (!u.hostname.endsWith(".example.test")) return Promise.reject(Object.assign(new Error(`left the test hosts: ${url}`), { code: "ENOTFOUND" }));
  // Fixed loopback origin; the stubbed host only picks a path on it.
  const target = new URL(loop);
  target.pathname = `/${u.hostname}${u.pathname}`;
  target.search = u.search;
  return fetch(target, { ...opts, redirect: "manual" });
});
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "b2".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifestFor = (origin, { template = false } = {}) => ({
  x402Version: 2, name: "Quote seller",
  resources: [
    // A template listed FIRST: the probe must not pick it.
    ...(template ? [{ resource: `${origin}/v1/token/{symbol}`, method: "GET", description: "One token.", price: "$0.005", accepts }] : []),
    { resource: `${origin}/v1/quote`, method: "GET", description: "One quote.", price: "$0.005", accepts },
  ],
});
const served = new Map();
__setCrawlFetchForTest(async (url) => {
  if (url.endsWith("/robots.txt")) return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: JSON.stringify(hit), finalUrl: url, validators: null };
});

__testResetSubmitted();
// Pad the cache so the rotation's turn (every cache.size-th call) never comes.
const pad = () => { for (let i = 0; i < 2000; i++) _cacheForTests().set(`https://pad${i}.pad.test`, { manifest: null, tools: [], fetchedAt: Date.now(), error: null, history: [1] }); };
pad();
__resetPaywallProbeForTest({ cursor: 1 });
const seller = (name, opts) => { const o = `https://${name}.example.test`; served.set(`${o}/.well-known/x402`, manifestFor(o, opts)); return o; };
const hostOf = (o) => new URL(o).hostname;
const crawl = async (origin, opts) => { __resetRobotsCacheForTest(); await __crawlSellerForTest(origin, opts); return _cacheForTests().get(origin); };
const age = (origin, ms) => { const v = _cacheForTests().get(origin); v.paywall = { ...v.paywall, at: v.paywall.at - ms }; return v.paywall.at; };

// 1. Answers 400, then 402. A fresh failure stands; an expired one flips.
{
  const o = seller("flip");
  mode.set(hostOf(o), 400);
  const first = await crawl(o, { forcePaywall: true });
  ok(first?.paywall?.ok === false && first.paywall.status === 400, `the first reading is the 400 (${JSON.stringify(first?.paywall)})`);
  mode.set(hostOf(o), 402);
  const at0 = first.paywall.at;
  hits.set(hostOf(o), 0);
  const second = await crawl(o);
  ok(second?.paywall?.ok === false && second.paywall.at === at0, "a failure inside the window is carried forward with its own at");
  ok((hits.get(hostOf(o)) || 0) === 0, "and no paywall probe was sent for it");
  const aged = age(o, 25 * 3_600_000);
  const third = await crawl(o);
  ok(third?.paywall?.ok === true && third.paywall.status === 402, `past the window the next crawl re-probes and reads the 402 (${JSON.stringify(third?.paywall)})`);
  ok(third.paywall.at > aged && Date.now() - third.paywall.at < 60_000, "with a new at");
  ok(sellerDetail(hostOf(o))?.paywall?.ok === true, "the seller detail reads the fresh verdict");
}

// 2. Keeps failing: re-probed once per window, not on every crawl.
{
  __resetPaywallProbeForTest({ cursor: 1 });
  const o = seller("stuck");
  mode.set(hostOf(o), 400);
  await crawl(o, { forcePaywall: true });
  const aged = age(o, 25 * 3_600_000);
  hits.set(hostOf(o), 0);
  const a = await crawl(o);
  ok(a?.paywall?.ok === false && a.paywall.at > aged, "an expired failure is re-probed and stamped again");
  ok(hits.get(hostOf(o)) === 1, `one paywall probe for it (${hits.get(hostOf(o))})`);
  const b = await crawl(o);
  const c = await crawl(o);
  ok(b.paywall.at === a.paywall.at && c.paywall.at === a.paywall.at, "the next crawls inside the window carry it forward");
  ok(hits.get(hostOf(o)) === 1, `no further paywall probe inside the window (${hits.get(hostOf(o))})`);
}

// 3. A re-registration re-probes at once, whatever the verdict's age.
{
  __resetPaywallProbeForTest({ cursor: 1 });
  __resetForcedCrawlForTest();
  const o = seller("reregister");
  mode.set(hostOf(o), 400);
  const r0 = await registerOrigin(o, {});
  ok(r0?.listed === true, `a first registration lists it (${JSON.stringify({ listed: r0?.listed, error: r0?.error })})`);
  const v0 = _cacheForTests().get(o);
  ok(v0?.paywall?.ok === false && v0.paywall.status === 400, `and probes the paywall on its first crawl (${JSON.stringify(v0?.paywall)})`);
  mode.set(hostOf(o), 402);
  __resetForcedCrawlForTest();
  const r1 = await registerOrigin(o, {});
  const v1 = _cacheForTests().get(o);
  ok(r1?.listed === true && v1?.paywall?.ok === true && v1.paywall.status === 402, `a re-registration re-probes a fresh failure at once (${JSON.stringify(v1?.paywall)})`);
  ok(v1.paywall.at >= v0.paywall.at, "with a new at");
}

// 4. The re-check budget holds per cycle; the next cycle reaches the rest.
{
  const names = ["budget-a", "budget-b", "budget-c"];
  const origins = names.map((n) => seller(n));
  for (const o of origins) { mode.set(hostOf(o), 400); await crawl(o, { forcePaywall: true }); }
  const before = origins.map((o) => age(o, 25 * 3_600_000));
  __resetPaywallProbeForTest({ cursor: 1, recheckBudget: 2 });
  for (const o of origins) await crawl(o);
  const reprobed = origins.filter((o, i) => _cacheForTests().get(o).paywall.at > before[i]);
  ok(reprobed.length === 2, `a budget of 2 re-probes 2 of 3 expired sellers in one cycle (${reprobed.length})`);
  const left = origins.find((o) => !reprobed.includes(o));
  __resetPaywallProbeForTest({ cursor: 1, recheckBudget: 2 });
  await crawl(left);
  ok(_cacheForTests().get(left).paywall.at > before[origins.indexOf(left)], "the next cycle's budget reaches the one left over");
  __resetPaywallProbeForTest({ cursor: 1, recheckBudget: 0 });
  const o = origins[0];
  const held = age(o, 25 * 3_600_000);
  await crawl(o);
  ok(_cacheForTests().get(o).paywall.at === held, "a spent budget leaves an expired failure for a later cycle");
}

// 5. A template route is never the probed URL; a failure taken on one expires.
{
  __resetPaywallProbeForTest({ cursor: 1 });
  const o = seller("template", { template: true });
  mode.set(hostOf(o), 402);
  const v = await crawl(o, { forcePaywall: true });
  ok(v?.paywall?.ok === true && v.paywall.url === `${o}/v1/quote`, `the concrete route is probed, not the template listed first (${v?.paywall?.url})`);
  v.paywall = { ok: false, status: 400, url: `${o}/v1/token/:param`, at: Date.now(), mpp: false };
  const w = await crawl(o);
  ok(w?.paywall?.ok === true && w.paywall.url === `${o}/v1/quote`, `a fresh failure measured on a template is re-probed at once (${JSON.stringify(w?.paywall)})`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
