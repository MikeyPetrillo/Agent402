#!/usr/bin/env node
// The MPP index's requests to a seller (src/mpp-index.js: the /openapi.json
// read and the challenge probe) obey the same load controls as the x402 crawl
// (src/seller-load.js):
//   * a crawl's request is counted against the host's day and, past the
//     budget, not sent; the entry stays as the last probe left it;
//   * a 429 or 503 from the seller holds the host until its Retry-After, and
//     a crawl sends nothing to a held host;
//   * a seller's own registration is counted and never held;
//   * an origin in CRAWL_SLOW_ORIGINS is probed on the slow cycle only.
// Offline: stub probe and document reads, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("mpp-seller-load"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "4";
process.env.CRAWL_SLOW_ORIGINS = "https://slow.example";
const mpp = await import("../src/mpp-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
const { CRAWL_INTERVAL_MS } = await import("../src/crawl-cadence.js");
const { isHost } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
let clock = Date.parse("2026-11-16T01:00:00Z");
sellerLoad.setClock(() => clock);

const sent = [];
const challenge = 'Payment id="x", realm="r", method="tempo", intent="charge", request="e30"';
let answer = { status: 402, headers: { "www-authenticate": challenge } };
const probe = async ({ url }) => {
  sent.push(url);
  const h = new Headers(answer.headers);
  return { ok: answer.status === 402 && h.has("www-authenticate"), status: answer.status, url, at: Date.now(), offers: [], retryAfter: h.get("retry-after"), error: null };
};
const fetchDoc = async (url) => {
  sent.push(url);
  return { html: JSON.stringify({ openapi: "3.1.0", paths: { "/paid": { get: { "x-payment-info": { amount: "0.01" } } } } }) };
};
const fetchText = async () => ({ html: "" });
const sentTo = (host) => sent.filter((u) => isHost(u, host)).length;

// ---- the day's budget -------------------------------------------------------------
{
  mpp.__testReset();
  const O = "https://busy.example";
  let entry = await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  ok(entry?.verified && sentTo("busy.example") === 2, `a crawl reads the seller's /openapi.json and probes its paid route (${sentTo("busy.example")} requests)`);
  for (let i = 0; i < 3; i++) await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  const before = sentTo("busy.example");
  // One document read and two probes: the probes take at most half the day
  // (PROBE_SHARE), so the document reads keep the rest.
  ok(before === 3, `the probes stop at their half of the day's budget (${before} requests: one document read, two probes)`);
  entry = await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  ok(sentTo("busy.example") === before && entry?.verified === true, "past the budget a crawl sends nothing and the listing stands as it was");
  await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText });
  ok(sentTo("busy.example") === before + 1, "a registration the seller asked for is still sent");
  // A registration anyone asks for is counted apart: it never spends the day
  // the crawl reads.
  const R = "https://registered.example";
  await mpp.verifyMppSeller(R, { probe, fetchDoc, fetchText });
  ok(sentTo("registered.example") === 2 && (await sellerLoad.budgetSpent(R)).used === 0, "a registration's reads are sent and not counted on the site's day");
  await mpp.verifyMppSeller(R, { probe, fetchDoc, fetchText, gate: true });
  ok((await sellerLoad.budgetSpent(R)).used === 1, "control: the crawl's own probe is counted on it");
  clock += 24 * 3_600_000;
  await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  ok(sentTo("busy.example") === before + 2, "the next UTC day the crawl probes again");
}

// ---- Retry-After ------------------------------------------------------------------
{
  mpp.__testReset();
  const O = "https://held.example";
  answer = { status: 429, headers: { "retry-after": "600" } };
  await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  await sellerLoad.flush();
  ok((await sellerLoad.throttledUntil(O)) === clock + 600_000, "a 429 from the probe holds the host for its Retry-After");
  answer = { status: 402, headers: { "www-authenticate": challenge } };
  const n = sentTo("held.example");
  await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  ok(sentTo("held.example") === n, "a crawl sends nothing to a held host");
  clock += 601_000;
  await mpp.verifyMppSeller(O, { probe, fetchDoc, fetchText, gate: true });
  ok(sentTo("held.example") === n + 1, "and probes it again once the hold ends");
  // A 503 on the discovery document holds the host too.
  mpp.__testReset();
  const D = "https://doc503.example";
  const fetch503 = async (url) => { sent.push(url); throw Object.assign(new Error("Upstream returned HTTP 503"), { statusCode: 422, upstreamStatus: 503 }); };
  await mpp.verifyMppSeller(D, { probe, fetchDoc: fetch503, fetchText, gate: true });
  await sellerLoad.flush();
  ok((await sellerLoad.throttledUntil(D)) > clock, "a 503 on /openapi.json holds the host");
}

// ---- CRAWL_SLOW_ORIGINS ---------------------------------------------------------------
{
  mpp.__testReset();
  const S = "https://slow.example", N = "https://normal.example";
  const t0 = Date.now();
  ok(mpp.mppCrawlDue([S, N], t0).length === 2, "a slow origin never probed is due");
  await mpp.verifyMppSeller(S, { probe, fetchDoc, fetchText });
  await mpp.verifyMppSeller(N, { probe, fetchDoc, fetchText });
  const due = (dt) => mpp.mppCrawlDue([S, N], Date.now() + dt).join(",");
  ok(due(CRAWL_INTERVAL_MS) === N, "one cycle later only the normal origin is due");
  ok(due(5 * 3_600_000) === N, "five hours later the slow origin still waits");
  ok(due(6 * 3_600_000) === `${S},${N}`, "six hours later it is due again");
  // A boot whose stored listing has not loaded yet (no lastProbeAt) still
  // waits out the last scheduled read any container recorded in the store.
  mpp.__testReset();
  ok(mpp.mppCrawlDue([S, N], clock).length === 2, "control: with no read recorded anywhere the slow origin is due");
  sellerLoad.noteSlowRead(S, "mpp");
  ok(mpp.mppCrawlDue([S, N], clock + CRAWL_INTERVAL_MS).join(",") === N, "a scheduled read recorded in the shared store holds the slow origin with no cached probe");
  ok(mpp.mppCrawlDue([S, N], clock + 6 * 3_600_000).join(",") === `${S},${N}`, "until six hours have passed");
  ok(!sellerLoad.slowWaiting(S, "x402"), "the x402 crawl's slow cycle is its own");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
