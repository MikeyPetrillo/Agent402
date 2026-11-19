#!/usr/bin/env node
// A crawl cycle is read as failing broadly on OUR side (its UTC day is then
// left out of every seller's reputation record) only on evidence no seller
// the crawl reads can supply:
//   * one vote per operator (registrable domain), never per origin: one
//     seller's 24 origins that never answer do not flag the day;
//   * at least CRAWL_OURS_MIN_OPERATORS distinct operators' reads ending on
//     our side, and at least half of the operators read;
//   * and a control read of our own (a host no seller runs) failing too: many
//     operators whose reads time out while our control answers is their side;
//   * CONTROL: every operator's read failing AND the control failing flags
//     the day, with the evidence handed to the reputation record.
// Driven through the real cycle (src/x402-index.js runCrawl) with stub reads.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-our-side-verdict"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "0";
const healthy = Array.from({ length: 2 }, (_, i) => `https://ok${i}.example`);
// One seller: six registrable domains, four origins on each.
const evil = Array.from({ length: 24 }, (_, i) => `https://h${i % 4}.evil${Math.floor(i / 4)}.example`);
// Twelve more one-origin domains (healthy until `bigHangs`).
const big = Array.from({ length: 12 }, (_, i) => `https://big${i}.example`);
process.env.X402_INDEX_SEEDS = [...healthy, ...evil, ...big].join(",");
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-our-side-verdict-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
const { hostOf } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
let clock = Date.now();
sellerLoad.setClock(() => clock);
const realNow = Date.now;
Date.now = () => clock;

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
let evilHangs = false, bigHangs = false, egressCut = false, ver = 0;
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
idx.__setCrawlFetchForTest(async (url) => {
  const host = hostOf(url);
  if (egressCut || (evilHangs && /\.evil\d+\.example$/.test(host)) || (bigHangs && host.startsWith("big"))) throw timeout();
  const u = new URL(url);
  if (u.pathname !== "/.well-known/x402") throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  const body = JSON.stringify({ x402Version: 2, name: host, resources: [{ resource: `${u.origin}/api/thing`, method: "GET", description: `A thing, version ${ver}.`, price: "$0.005", accepts }] });
  return { html: body, finalUrl: url, validators: {} };
});
idx.__setProbeFetchForTest(async () => { throw timeout(); });

// The day hook, as the server wires it, and the control read of our own.
const flagged = [];
idx.setOurSideIssueHook(async (at, evidence) => { flagged.push({ at, evidence }); });
let controlFails = false, controlCalls = 0;
idx.setOurSideControl?.(async () => { controlCalls++; return { checked: 1, failed: controlFails ? 1 : 0 }; });

const cycle = async (label) => {
  ver++;
  clock += 48 * 3_600_000; // every back-off and path wait has ended: the whole list is due
  flagged.length = 0;
  const sum = await idx.__runCrawlCycleForTest();
  console.log(`# ${label}: crawled ${sum.crawled} of ${sum.due}, our side ${sum.oursShare}, verdict ${JSON.stringify(sum.ourSide ?? null)}`);
  return sum;
};

// ---- every origin answers ------------------------------------------------------------
// The index's own default seeds are read too (and answer, through the stub).
let ALL = 0, OPERATORS = 0;
{
  const sum = await cycle("all healthy");
  const origins = [...idx._cacheForTests().keys()];
  ALL = origins.length;
  OPERATORS = new Set(origins.map((o) => idx.operatorKey(o))).size;
  ok(ALL >= 38 && sum.crawled === ALL && sum.oursShare === 0 && flagged.length === 0, `control: ${ALL} origins of ${OPERATORS} operators read, none on our side, no day flagged (${sum.crawled}, ${sum.oursShare})`);
}

// ---- one seller, 24 origins that never answer ----------------------------------------
{
  evilHangs = true;
  const sum = await cycle("one seller hangs");
  ok(sum.crawled === ALL && sum.oursShare >= 0.5, `control: its 24 reads are over half of the cycle's ${sum.crawled} (share ${sum.oursShare})`);
  ok(flagged.length === 0, `one seller's 24 origins that never answer do not flag the day (${flagged.length} flagged)`);
  ok(sum.ourSide?.broad === false && sum.ourSide?.operatorsOurs === 6, `the cycle counts them as 6 operators, under the floor (${JSON.stringify(sum.ourSide ?? null)})`);
  // The same failures with our control read failing too: still six operators.
  controlFails = true;
  await cycle("one seller hangs, control fails");
  ok(flagged.length === 0, "six operators never flag a day, whatever the control reads");
  controlFails = false;
}

// ---- 18 operators never answer, our control read answers -----------------------------
{
  bigHangs = true;
  const before = controlCalls;
  const sum = await cycle("18 operators hang, control answers");
  ok(sum.ourSide?.operatorsOurs === 18 && sum.ourSide?.operatorsRead === OPERATORS && 18 >= OPERATORS / 2, `control: 18 of ${OPERATORS} operators' reads ended on our side (${JSON.stringify(sum.ourSide ?? null)})`);
  ok(controlCalls > before, "the control was read");
  ok(flagged.length === 0 && sum.ourSide?.broad === false, `many operators failing while our control answers is not our side (${flagged.length} flagged)`);
  evilHangs = false; bigHangs = false;
}

// ---- our egress cut: every read fails, the control too -------------------------------
{
  egressCut = true; controlFails = true;
  const sum = await cycle("egress cut");
  ok(flagged.length === 1 && sum.ourSide?.broad === true, `CONTROL: every operator's read and the control failing flags the day (${flagged.length} flagged)`);
  const ev = flagged[0]?.evidence;
  ok(ev && ev.operatorsOurs === OPERATORS && ev.operatorsRead === OPERATORS && ev.control?.checked === 1 && ev.control?.failed === 1, `the evidence goes with it (${JSON.stringify(ev ?? null)})`);
  // The same cycle with no control wired: not confirmed, not flagged.
  idx.setOurSideControl?.(null);
  const none = await cycle("egress cut, no control wired");
  ok(flagged.length === 0 && none.ourSide?.broad === false && none.ourSide?.control === null, "with no control read wired a day is never flagged");
  egressCut = false; controlFails = false;
}

// ---- the rule itself -----------------------------------------------------------------
{
  const v = idx.ourSideVerdict;
  const ops = (n, row) => new Map(Array.from({ length: n }, (_, i) => [`op${i}.example`, { ...row }]));
  const failed = { checked: 2, failed: 2 };
  ok(typeof v === "function" && v({ operators: ops(9, { read: 4, ours: 4 }), share: 1, control: failed }).broad === false, "nine operators, every read on our side, the control failing: under the floor");
  ok(typeof v === "function" && v({ operators: ops(10, { read: 1, ours: 1 }), share: 1, control: failed }).broad === true, "CONTROL: ten operators and the control failing");
  ok(typeof v === "function" && v({ operators: ops(10, { read: 1, ours: 1 }), share: 1, control: { checked: 2, failed: 1 } }).broad === false, "one control read answering: not our side");
  ok(typeof v === "function" && v({ operators: ops(10, { read: 1, ours: 1 }), share: 1, control: { checked: 0, failed: 0 } }).broad === false, "a control that read nothing confirms nothing");
  const mixed = new Map([...ops(10, { read: 1, ours: 1 }), ...Array.from({ length: 11 }, (_, i) => [`fine${i}.example`, { read: 1, ours: 0 }])]);
  ok(typeof v === "function" && v({ operators: mixed, share: 1, control: failed }).broad === false, "ten of 21 operators: under half of those read");
  const heavy = new Map([["one.example", { read: 400, ours: 400 }], ...Array.from({ length: 9 }, (_, i) => [`s${i}.example`, { read: 1, ours: 1 }]), ...Array.from({ length: 12 }, (_, i) => [`fine${i}.example`, { read: 1, ours: 0 }])]);
  ok(typeof v === "function" && v({ operators: heavy, share: 1, control: failed }).broad === false, "an operator with 400 failing reads is one vote");
  ok(typeof v === "function" && v({ operators: ops(10, { read: 1, ours: 1 }), share: 0.4, control: failed }).broad === false, "the cycle's own share under half: not broad");
}

// ---- the control read (src/our-side-control.js) ---------------------------------------
{
  Date.now = realNow;
  const C = await import("../src/our-side-control.js");
  const urls = C.ourSideControlUrls({ baseUrl: "https://shop.example", env: { CRAWL_OUR_SIDE_CONTROL_URLS: "https://one.example/ping, http://plain.example/, https://127.0.0.1/, https://localhost/x, https://shop.example/other, not a url, https://two.example" } });
  ok(urls.join() === "https://shop.example/health,https://one.example/ping,https://two.example/", `the control URLs: our own /health and the listed https hosts, one per host (${urls.join(" ")})`);
  ok(C.ourSideControlUrls({ baseUrl: "http://127.0.0.1:3000", env: {} }).length === 0 && C.ourSideControlUrls({ baseUrl: "https://10.0.0.1", env: {} }).length === 0, "a loopback or address BASE_URL is never a control");
  const seen = [];
  const answered = await C.readOurSideControl(urls, { request: async (url, init) => { seen.push([url, init.redirect, !!init.signal]); return { status: url.includes("one") ? 503 : 200 }; } });
  ok(answered.checked === 3 && answered.failed === 0 && seen.every(([, redirect, signal]) => redirect === "manual" && signal), `any status is an answer, each read with a time limit and no redirect followed (${JSON.stringify(answered)})`);
  const cut = await C.readOurSideControl(urls, { request: async () => { throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }); } });
  ok(cut.checked === 3 && cut.failed === 3, `CONTROL: no answer from any host reads as failed (${JSON.stringify(cut)})`);
  const keep = setTimeout(() => {}, 10_000); // the read's own timer does not hold the process open
  const slow = await C.readOurSideControl(urls.slice(0, 1), { timeoutMs: 50, request: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))) });
  clearTimeout(keep);
  ok(slow.checked === 1 && slow.failed === 1, "a read past its limit failed");
  const none = await C.readOurSideControl([]);
  ok(none.checked === 0 && idx.ourSideVerdict({ operators: new Map(Array.from({ length: 12 }, (_, i) => [`o${i}.example`, { read: 1, ours: 1 }])), share: 1, control: none }).broad === false, "no control URL: nothing checked, and the verdict never confirms");
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
