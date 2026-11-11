#!/usr/bin/env node
// A rail dropped at boot because its facilitator's /supported read failed
// rejoins the offer without a restart (src/rail-recheck.js, src/payments.js).
//
// Part 1, the re-read loop on its own: backoff, who is read, when it ends.
// Part 2, the wire: a paid server against two stub facilitators (Base on one,
// Celo on the other), each leg a fresh boot:
//   A. the Celo facilitator fails /supported at boot, then answers: Celo is
//      missing from the first 402 and present on a later one, with no
//      restart; /api/rails, /.well-known/x402, /api/pricing and /openapi.json
//      follow, and a Celo payment is verified by the Celo facilitator;
//   B. its first /supported read is slow (answers after the boot read gave
//      up): the same, through the answer the server's own init then holds;
//   C. it fails at boot, then answers WITHOUT Celo: Celo never joins, and the
//      re-read ends;
//   D. it answers at boot without Celo: Celo is dropped, nothing is re-read,
//      and a later listing does not add it (a restart reads it).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { createRailRecheck, railRecheckSettings, RAIL_RECHECK_FIRST_MS, RAIL_RECHECK_MAX_MS } from "../src/rail-recheck.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll `read` until `test(value)` or the deadline; returns the last value. */
async function until(read, test, ms = 30_000, every = 100) {
  let v;
  for (const end = Date.now() + ms; ;) {
    try { v = await read(); } catch { v = undefined; }
    if (test(v) || Date.now() > end) return v;
    await sleep(every);
  }
}

const BASE = "eip155:8453", CELO = "eip155:42220", OPT = "eip155:10";
const exact = (...nets) => ({ kinds: nets.map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} });

// ---- Part 1: the loop --------------------------------------------------------------
{
  const s = railRecheckSettings({});
  ok(s.enabled && s.firstMs === RAIL_RECHECK_FIRST_MS && s.maxMs === RAIL_RECHECK_MAX_MS, "defaults: on, first read after 30 s, ceiling 10 minutes");
  ok(!railRecheckSettings({ X402_RAIL_RECHECK_MS: "off" }).enabled && !railRecheckSettings({ X402_RAIL_RECHECK_MS: "0" }).enabled, "X402_RAIL_RECHECK_MS=off (or 0) disables it");
  const t = railRecheckSettings({ X402_RAIL_RECHECK_MS: "200", X402_RAIL_RECHECK_MAX_MS: "100" });
  ok(t.firstMs === 200 && t.maxMs === 200 && railRecheckSettings({ X402_RAIL_RECHECK_MS: "junk" }).firstMs === RAIL_RECHECK_FIRST_MS, "the ceiling is never under the first delay, and junk reads as the default");
}
// A hand-driven timer: delays are recorded, never slept.
function fakeTimers() {
  const due = [];
  return {
    due,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; due.push(t); return t; },
    clearTimer: (t) => { const i = due.indexOf(t); if (i >= 0) due.splice(i, 1); },
    /** Run the scheduled tick (the timer that is not a read timeout). */
    async fire(tickMsSet) { const i = due.findIndex((t) => tickMsSet.has(t.ms)); const [t] = due.splice(i, 1); await t.fn(); await new Promise((r) => setImmediate(r)); return t.ms; },
  };
}
{
  // Fails three times, then lists the network: restored once, with the answering facilitator, on a doubling backoff.
  const tm = fakeTimers();
  let reads = 0, mode = "fail";
  const client = { getSupported: async () => { reads++; if (mode === "fail") throw new Error("down"); return exact(CELO); } };
  const restored = [], lines = [];
  const rc = createRailRecheck({ failed: [{ client, label: "Celo" }], dropped: [CELO], restore: (c, by) => { restored.push([c, by.label, by.client === client, by.supported.kinds.length]); return true; }, firstMs: 100, maxMs: 350, timeoutMs: 5000, log: (l) => lines.push(l), warn: (l) => lines.push(l), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  rc.start();
  ok(reads === 0 && tm.due.length === 1 && tm.due[0].ms === 100 && rc.pendingNetworks().join() === CELO, "nothing is read at start; the first read is one delay away");
  const waits = [];
  const TICKS = new Set([100, 200, 350]);
  waits.push(await tm.fire(TICKS)); waits.push(await tm.fire(TICKS)); waits.push(await tm.fire(TICKS));
  ok(reads === 3 && restored.length === 0 && rc.pendingNetworks().join() === CELO, `three failed reads restore nothing (${reads} reads)`);
  mode = "ok";
  waits.push(await tm.fire(TICKS));
  ok(JSON.stringify(waits) === JSON.stringify([100, 200, 350, 350]), `the delay doubles to its ceiling (${waits.join(", ")} ms)`);
  ok(JSON.stringify(restored) === JSON.stringify([[CELO, "Celo", true, 1]]), `the network is restored once, with the facilitator that listed it (${JSON.stringify(restored)})`);
  ok(rc.pendingNetworks().length === 0 && tm.due.length === 0 && reads === 4, "then nothing is pending and no timer is left");
  ok(lines.some((l) => l.includes(`${CELO} is offered again`) && l.includes("Celo")), "the restore is logged with the network and the facilitator");
  await rc.tick();
  ok(reads === 4, "a finished loop reads nothing more");
}
{
  // Lists the network under another scheme only: never handed to restore.
  const tm = fakeTimers();
  let restores = 0;
  const upto = { kinds: [{ x402Version: 2, scheme: "upto", network: CELO }], extensions: [], signers: {} };
  const rc = createRailRecheck({ failed: [{ client: { getSupported: async () => upto }, label: "F" }], dropped: [CELO], restore: () => { restores++; return true; }, firstMs: 100, maxMs: 100, log: () => {}, warn: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  rc.start();
  await tm.fire(new Set([100]));
  ok(restores === 0 && rc.pendingNetworks().length === 0, `a listing of the network under a scheme other than exact restores nothing (${restores} restores)`);
}
{
  // Answers without the network: never restored, and the loop ends.
  const tm = fakeTimers();
  let reads = 0, restores = 0;
  const lines = [];
  const rc = createRailRecheck({ failed: [{ client: { getSupported: async () => { reads++; return exact(BASE, OPT); } }, label: "F" }], dropped: [CELO], restore: () => { restores++; return true; }, firstMs: 100, maxMs: 100, log: (l) => lines.push(l), warn: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  rc.start();
  await tm.fire(new Set([100]));
  ok(reads === 1 && restores === 0 && rc.pendingNetworks().length === 0 && tm.due.length === 0, "a facilitator that answers without the network ends the re-read; nothing is restored");
  ok(lines.some((l) => /every facilitator has answered and none lists eip155:42220 - it stays dropped/.test(l)), "and the log says it stays dropped");
}
{
  // Two failed facilitators, two networks: each answer is applied on its own; a hung read is bounded; a deferred restore is asked again.
  const tm = fakeTimers();
  const state = { a: "hang", b: "ok" };
  const a = { getSupported: () => (state.a === "hang" ? new Promise(() => {}) : Promise.resolve(exact(CELO))) };
  const b = { getSupported: async () => exact(OPT) };
  let defer = true;
  const restored = [];
  const rc = createRailRecheck({ failed: [{ client: a, label: "A" }, { client: b, label: "B" }], dropped: [CELO, OPT], restore: (c, by) => { if (c === OPT && defer) { defer = false; return "defer"; } restored.push(`${c}:${by.label}`); return true; }, firstMs: 100, maxMs: 100, timeoutMs: 7777, log: () => {}, warn: () => {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  rc.start();
  const tick1 = tm.fire(new Set([100]));
  // The hung read's own timeout is the only thing that ends it.
  const hung = await until(async () => tm.due.find((t) => t.ms === 7777), (t) => !!t, 5000, 5);
  ok(!!hung, "a read that never answers is held to the read timeout");
  await hung.fn(); await tick1;
  ok(restored.length === 0 && rc.pendingNetworks().sort().join() === [OPT, CELO].sort().join() && rc.failedLabels().join() === "A,B", "a deferred restore keeps its facilitator and its network waiting");
  state.a = "ok";
  await tm.fire(new Set([100]));
  ok(restored.sort().join() === [`${CELO}:A`, `${OPT}:B`].sort().join() && rc.pendingNetworks().length === 0, `both are restored on the next read, each by the facilitator that lists it (${restored.join(", ")})`);
}
{
  // A restore that cannot be done here (false), or throws: not retried, said once, never fatal.
  const tm = fakeTimers();
  const lines = [];
  let calls = 0;
  const rc = createRailRecheck({ failed: [{ client: { getSupported: async () => exact(CELO, OPT) }, label: "F" }], dropped: [CELO, OPT], restore: (c) => { calls++; if (c === OPT) throw new Error("boom"); return false; }, firstMs: 100, maxMs: 100, log: (l) => lines.push(l), warn: (l) => lines.push(l), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  rc.start();
  await tm.fire(new Set([100]));
  ok(calls === 2 && rc.pendingNetworks().length === 0 && tm.due.length === 0 && lines.some((l) => /can only rejoin the offer at the next restart/.test(l)), "a network that cannot be restored in this process is left for the next restart, and the loop ends");
  const none = createRailRecheck({ failed: [], dropped: [CELO], restore: () => true, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  none.start();
  ok(tm.due.length === 0 && none.pendingNetworks().length === 0, "no failed facilitator: nothing is scheduled and nothing reads as pending");
}

// ---- Part 1b: the boot read itself (src/boot-supported-read.js) ---------------------
{
  const { bootReadSettings, readSupportedAtBoot, BOOT_TRY_MS } = await import("../src/boot-supported-read.js");
  const d0 = bootReadSettings({}), d1 = bootReadSettings({}, { extraReads: 1 }), d2 = bootReadSettings({}, { extraReads: 2 });
  ok(d0.tryMs === BOOT_TRY_MS && d0.tries === 3 && d0.budgetMs === 14_000 && d1.budgetMs === 22_000 && d2.budgetMs === 30_000,
    `the bound is what the boot held before: 14 s, plus 8 s per read that followed the guard (${d0.budgetMs}, ${d1.budgetMs}, ${d2.budgetMs})`);
  ok(JSON.stringify(d0.gapsMs) === "[2000,8000]", `tries start at 0, 8 and 22 s (${d0.gapsMs})`);
  const t = bootReadSettings({ X402_SUPPORTED_TRY_MS: "600" }, { extraReads: 2 });
  ok(t.tryMs === 600 && t.budgetMs === 3000 && bootReadSettings({ X402_SUPPORTED_TRY_MS: "600", X402_SUPPORTED_BOOT_MS: "5000" }).budgetMs === 5000, "the try and the bound can be set; the bound scales with the try");
  const opts = (extra) => ({ tryMs: 200, gapsMs: [50, 100], tries: 3, minTryMs: 50, deadline: Date.now() + 2_000, ...extra });
  const hang = () => new Promise(() => {});
  // A hung first read: the second try is a request of its own, and it answers.
  let fresh = 0;
  let r = await readSupportedAtBoot(opts({ read: hang, readFresh: async () => { fresh++; return exact(CELO); } }));
  ok(r.supported?.kinds?.[0]?.network === CELO && r.tries === 2 && fresh === 1, `a hung first read does not decide: the second try's own request answers (tries ${r.tries})`);
  // A slow first answer that lands during the second try is used.
  r = await readSupportedAtBoot(opts({ read: () => new Promise((res) => setTimeout(() => res(exact(BASE)), 300)), readFresh: hang }));
  ok(r.supported?.kinds?.[0]?.network === BASE, "an earlier request that answers late, inside the bound, is the answer");
  // No answer at all inside the bound: probe-timeout, with every try made.
  const t0 = Date.now();
  let made = 0;
  r = await readSupportedAtBoot(opts({ read: () => { made++; return hang(); }, readFresh: () => { made++; return hang(); }, deadline: Date.now() + 1_000 }));
  ok(r.supported === null && r.reason === "probe-timeout" && made === 3 && Date.now() - t0 < 1_500, `no answer: probe-timeout after three tries, inside the bound (${r.reason}, ${made} tries, ${Date.now() - t0} ms)`);
  // An error answer every time: read-failed.
  r = await readSupportedAtBoot(opts({ read: async () => { throw new Error("Facilitator getSupported failed (500)"); } }));
  ok(r.supported === null && r.reason === "read-failed" && r.tries === 3, `an error answer every time reads read-failed (${r.reason}, ${r.tries})`);
  // A client's own timeout error is ours too.
  r = await readSupportedAtBoot(opts({ read: async () => { throw Object.assign(new Error("timeout"), { reason: "timeout" }); } }));
  ok(r.reason === "probe-timeout", `a client timeout of ours reads probe-timeout (${r.reason})`);
  // A bound too short for a second try stops after one.
  made = 0;
  r = await readSupportedAtBoot(opts({ read: () => { made++; return hang(); }, readFresh: () => { made++; return hang(); }, deadline: Date.now() + 260 }));
  ok(made === 1 && r.reason === "probe-timeout", `a try that cannot run its minimum inside the bound is not started (${made} tries)`);
}

// Arc is never restored live: its contract-wallet route gate is registered
// only when Arc is in the boot offer. Its facilitator has no stub here (the
// client reads Circle's own host), so the two places that keep it out are
// read from the source: it is not a re-read candidate, and the restore
// refuses it before anything else.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const body = (/const restoreRail = \(caip2, \{ client, label, supported \}\) => \{\n([^\n]*)\n/.exec(src) || [])[1] || "";
  ok(body.trim() === "if (caip2 === ARC_CAIP2) return false;", `restoreRail refuses Arc first (${body.trim().slice(0, 60)})`);
  ok(/const candidates = droppedOnFailedRead\.filter\(\(c\) => c !== ARC_CAIP2\);/.test(src) && /createRailRecheck\(\{ failed: failedReads, dropped: candidates,/.test(src), "and Arc is left out of the networks the re-read waits on");
}

// ---- Part 2: the wire ----------------------------------------------------------------
const stubs = [];
// mode: an object -> 200 with it; "die" -> 500; { slowMs, then, slowReads } -> the first
// slowReads reads (default 1) answer `then` after slowMs, later reads at once;
// { hangReads, then } -> the first hangReads reads never answer, later reads answer `then`.
function stubFacilitator() {
  const state = { mode: "die", supported: 0, verifies: 0 };
  const srv = createServer((req, res) => {
    req.resume();
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(body)); };
    if (req.url === "/supported") {
      state.supported++;
      const m = state.mode;
      if (m === "die") { res.writeHead(500, { Connection: "close" }); return res.end("Internal Server Error"); }
      if (m && typeof m.hangReads === "number") {
        if (m.hangReads <= 0) return json(200, m.then);
        m.hangReads--;
        return undefined; // never answers
      }
      if (m && typeof m.slowMs === "number") {
        const left = (m.slowReads ?? 1) - 1;
        state.mode = left > 0 ? { ...m, slowReads: left } : m.then;
        const t = setTimeout(() => json(200, m.then), m.slowMs); res.on("close", () => clearTimeout(t)); return undefined;
      }
      return json(200, m);
    }
    if (req.url === "/verify") { state.verifies++; return json(200, { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }); }
    res.writeHead(404, { Connection: "close" }); return res.end();
  });
  stubs.push(srv);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(Object.assign(state, { url: `http://127.0.0.1:${srv.address().port}` }))));
}
const payai = await stubFacilitator();
const celo = await stubFacilitator();

const RECHECK_MS = 300;
const boot = (label, extra = {}) => bootServer({
  stores: `rail-restore-${label}`,
  env: {
    FREE_MODE: "", NODE_ENV: "test",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,celo",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
    PAYAI_FACILITATOR_URL: payai.url, CELO_FACILITATOR_URL: celo.url, CELO_FACILITATOR_KEY: "test-key",
    PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", MPP_SECRET_KEY: "",
    PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "", REDIS_URL: "",
    // A premium on Celo: /api/pricing and /openapi.json quote a chain's premium only while it is offered.
    NETWORK_PRICE_PREMIUMS: `${CELO}=0.001`, NETWORK_PRICE_FLOORS: "",
    X402_RAIL_RECHECK_MS: String(RECHECK_MS), X402_RAIL_RECHECK_MAX_MS: String(RECHECK_MS * 2),
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    ...extra,
  },
});
const offerOf = async (url) => {
  const r = await fetch(`${url}/api/uuid`);
  const h = r.headers.get("payment-required");
  await r.arrayBuffer();
  const offer = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null;
  return { status: r.status, offer, nets: new Set((offer?.accepts || []).map((a) => a.network)) };
};
const railsOf = async (url) => (await (await fetch(`${url}/api/rails`)).json()).rails || [];
const celoRail = async (url) => (await railsOf(url)).find((r) => r.caip2 === CELO);
const getJson = async (url, path) => (await fetch(`${url}${path}`)).json();
const microOf = (baseUnits) => Number(baseUnits);
const servers = [];

try {
  // ---- A. fails at boot, then answers ----
  payai.mode = exact(BASE); celo.mode = "die";
  {
    const srv = await boot("a"); servers.push(srv);
    const first = await offerOf(srv.url);
    ok(first.status === 402 && first.nets.has(BASE) && !first.nets.has(CELO), `boot with the Celo facilitator failing: 402 with Base and without Celo (${first.status}: ${[...first.nets].join(", ")})`);
    ok(/failed \/supported at boot/.test(srv.log()) && /dropping eip155:42220/.test(srv.log()) && /rail re-read: eip155:42220 dropped on a failed \/supported read/.test(srv.log()), "the boot log names the failed read, the drop and the re-read");
    const waiting = await celoRail(srv.url);
    ok(waiting && waiting.offered === false && /read again in the background/.test(waiting.reason || ""), `/api/rails says the rail waits on a re-read (${waiting?.reason})`);
    ok(waiting?.reasonWord === "read-failed", `a facilitator answering 500 reads read-failed, not probe-timeout or not-advertised (${waiting?.reasonWord})`);
    const openapiPremiums = async () => { const m = /"premiumUsdByNetwork":(\{[^{}]{0,400}\})/.exec(JSON.stringify(await getJson(srv.url, "/openapi.json"))); return m ? JSON.parse(m[1]) : {}; };
    const before = {
      wellKnown: JSON.stringify(await getJson(srv.url, "/.well-known/x402")),
      pricing: (await getJson(srv.url, "/api/pricing")).payment || {},
      openapi: await openapiPremiums(),
    };
    ok(!(before.pricing.networks || []).includes("celo") && !("celo" in (before.pricing.premiumUsdByNetwork || {})) && !before.wellKnown.includes(CELO) && !("celo" in before.openapi), `control: before the restore no derived surface names Celo (pricing ${(before.pricing.networks || []).join(", ")})`);
    // The facilitator keeps failing for a few reads: still dropped, still being read.
    const readsAtBoot = celo.supported;
    await until(async () => celo.supported, (n) => n >= readsAtBoot + 2, 20_000, 50);
    ok(celo.supported >= readsAtBoot + 2 && (await celoRail(srv.url))?.offered === false, `it is read again while it fails (${celo.supported - readsAtBoot} more reads) and stays dropped`);

    celo.mode = exact(CELO);
    const back = await until(() => celoRail(srv.url), (r) => r?.offered === true, 30_000);
    ok(back?.offered === true && back.reason === null, "once the facilitator lists Celo, /api/rails offers it");
    const after = await offerOf(srv.url);
    ok(after.status === 402 && after.nets.has(CELO) && after.nets.has(BASE), `the 402 carries Celo without a restart (${after.status}: ${[...after.nets].join(", ")})`);
    ok(srv.exited() === null && /rail re-read: eip155:42220 is offered again/.test(srv.log()), "same process, and the log says so");
    const order = (after.offer.accepts || []).map((a) => a.network);
    ok(order.indexOf(BASE) < order.indexOf(CELO), `Celo rejoins in its configured place (${order.join(", ")})`);
    const celoAccept = after.offer.accepts.find((a) => a.network === CELO);
    ok(celoAccept && /^0x[0-9a-fA-F]{40}$/.test(celoAccept.asset) && celoAccept.scheme === "exact" && /^\d+$/.test(celoAccept.amount), `its accept is the Celo scheme's own (${celoAccept?.asset}, ${celoAccept?.amount})`);

    // Every derived surface follows.
    const baseAccept0 = after.offer.accepts.find((a) => a.network === BASE);
    const wellKnown = JSON.stringify(await getJson(srv.url, "/.well-known/x402"));
    const pricing = (await getJson(srv.url, "/api/pricing")).payment || {};
    const openapi = await openapiPremiums();
    ok(wellKnown.includes(CELO), "/.well-known/x402 names Celo");
    const wkNets = JSON.parse(wellKnown).payment?.x402?.networks || [];
    const wkNetsBefore = JSON.parse(before.wellKnown).payment?.x402?.networks || [];
    ok(!wkNetsBefore.includes("celo") && wkNets.includes("celo"), `its manifest is built again: payment.x402.networks lists Celo (${wkNets.join(", ")})`);
    ok((pricing.networks || []).includes("celo") && pricing.premiumUsdByNetwork?.celo === 0.001, `/api/pricing lists it with its premium (${(pricing.networks || []).join(", ")}; ${JSON.stringify(pricing.premiumUsdByNetwork)})`);
    ok(openapi.celo === 0.001, `/openapi.json, built once and cached, is built again and quotes its premium (${JSON.stringify(openapi)})`);
    ok(microOf(celoAccept.amount) === microOf(baseAccept0.amount) + 1000, `and the Celo accept carries that premium over the Base price (${celoAccept.amount} vs ${baseAccept0.amount})`);
    const health = await fetch(`${srv.url}/health`);
    ok(health.ok, "/health answers");

    // A Celo payment is verified by the Celo facilitator (the lookup the restore wrote), and refused as a 402.
    const now = Math.floor(Date.now() / 1000);
    const payload = { x402Version: 2, resource: after.offer.resource, accepted: celoAccept, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000aa", to: celoAccept.payTo, value: celoAccept.amount, validAfter: String(now - 60), validBefore: String(now + 600), nonce: "0x" + "22".repeat(32) } } };
    const v0 = { celo: celo.verifies, payai: payai.verifies };
    const paid = await fetch(`${srv.url}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
    await paid.arrayBuffer();
    ok(paid.status === 402 && celo.verifies === v0.celo + 1 && payai.verifies === v0.payai, `a Celo payment reaches the Celo facilitator's verify and its refusal is a 402 (${paid.status}; celo ${celo.verifies - v0.celo}, payai ${payai.verifies - v0.payai})`);
    // Base is untouched.
    const baseAccept = after.offer.accepts.find((a) => a.network === BASE);
    const paidBase = await fetch(`${srv.url}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ ...payload, accepted: baseAccept, payload: { ...payload.payload, authorization: { ...payload.payload.authorization, to: baseAccept.payTo, value: baseAccept.amount, nonce: "0x" + "33".repeat(32) } } })).toString("base64") } });
    await paidBase.arrayBuffer();
    ok(paidBase.status === 402 && payai.verifies === v0.payai + 1, "a Base payment still goes to its own facilitator");
    // The re-read has ended: no further /supported reads.
    const settled = celo.supported;
    await until(async () => celo.supported, (n) => n > settled, RECHECK_MS * 6, 50);
    ok(celo.supported === settled, "after the restore the facilitator is not read again");
    await srv.stop();
  }

  // ---- B. the boot reads are slow ----
  // Both boot tries (a deployment without Arc or the batched option has two
  // inside its 14 s bound) answer after 17 s, past the bound.
  payai.mode = exact(BASE); celo.mode = { slowMs: 17_000, then: exact(CELO), slowReads: 2 };
  {
    const srv = await boot("b"); servers.push(srv);
    ok(/gave no \/supported answer within our 6 s limit at boot after 2 tries \(probe-timeout/.test(srv.log()) && /dropping eip155:42220 from the offered networks \(probe-timeout\)/.test(srv.log()), "reads slower than the boot bound are our probe timing out: Celo is dropped at boot, and the log says probe-timeout");
    const waiting = await celoRail(srv.url);
    ok(waiting?.offered === false && waiting.reasonWord === "probe-timeout" && /our timeout/.test(waiting.reason || "") && /read again in the background/.test(waiting.reason || ""), `/api/rails says probe-timeout, not that the facilitator does not advertise it (${waiting?.reasonWord}: ${waiting?.reason})`);
    const back = await until(() => celoRail(srv.url), (r) => r?.offered === true, 60_000);
    const after = await offerOf(srv.url);
    ok(back?.offered === true && after.status === 402 && after.nets.has(CELO) && after.nets.has(BASE), `the slow facilitator's answer restores Celo without a restart (${after.status}: ${[...after.nets].join(", ")})`);
    ok(srv.exited() === null && /rail re-read: eip155:42220 is offered again/.test(srv.log()), "same process, and the log says so");
    await srv.stop();
  }

  // ---- C. fails at boot, then answers without the network ----
  payai.mode = exact(BASE); celo.mode = "die";
  {
    const srv = await boot("c"); servers.push(srv);
    ok(!(await offerOf(srv.url)).nets.has(CELO), "boot with the Celo facilitator failing: no Celo");
    celo.mode = exact(OPT);
    const said = await until(async () => srv.log(), (l) => /every facilitator has answered and none lists eip155:42220 - it stays dropped/.test(l), 30_000);
    ok(/it stays dropped/.test(said), "the facilitator answers without Celo: the log says it stays dropped");
    const rail = await celoRail(srv.url);
    const after = await offerOf(srv.url);
    ok(after.status === 402 && !after.nets.has(CELO) && rail?.offered === false && !/read again/.test(rail.reason || ""), `Celo is not offered and no longer waits on a re-read (${rail?.reason})`);
    ok(rail?.reasonWord === "not-advertised", `once the facilitator answers without Celo, /api/rails says not-advertised (${rail?.reasonWord})`);
    // It lists Celo later: this process has stopped reading, so only a restart adds it.
    const reads = celo.supported;
    celo.mode = exact(CELO);
    await until(async () => celo.supported, (n) => n > reads, RECHECK_MS * 8, 50);
    ok(celo.supported === reads && !(await offerOf(srv.url)).nets.has(CELO), "a facilitator that answered without the network is not read again and never gains it");
    await srv.stop();
  }

  // ---- E. the re-read switched off ----
  payai.mode = exact(BASE); celo.mode = "die";
  {
    const srv = await boot("e", { X402_RAIL_RECHECK_MS: "off" });
    servers.push(srv);
    ok(!(await offerOf(srv.url)).nets.has(CELO) && /dropping eip155:42220/.test(srv.log()), "X402_RAIL_RECHECK_MS=off, the Celo facilitator failing at boot: Celo is dropped");
    celo.mode = exact(CELO);
    const reads = celo.supported;
    await until(async () => celo.supported, (n) => n > reads, RECHECK_MS * 8, 50);
    ok(celo.supported === reads && !/rail re-read/.test(srv.log()) && !(await offerOf(srv.url)).nets.has(CELO), `with the re-read off nothing is read again and Celo does not rejoin (${celo.supported - reads} reads)`);
    await srv.stop();
  }

  // ---- F. it answers with Celo at a protocol version the routes do not take ----
  payai.mode = exact(BASE); celo.mode = "die";
  {
    const srv = await boot("f"); servers.push(srv);
    celo.mode = { kinds: [{ x402Version: 1, scheme: "exact", network: CELO }], extensions: [], signers: {} };
    const said = await until(async () => srv.log(), (l) => /rail re-read: eip155:42220 (was not restored|is offered again)|lists eip155:42220 but not in a form/.test(l), 30_000);
    const after = await offerOf(srv.url);
    ok(!/is offered again/.test(said) && after.status === 402 && after.nets.has(BASE) && !after.nets.has(CELO), `a listing the routes cannot be built on leaves Celo out of the offer and every paid route answering 402 (${after.status}: ${[...after.nets].join(", ")})`);
    ok((await celoRail(srv.url))?.offered === false, "and /api/rails does not offer it");
    await srv.stop();
  }

  // ---- D. answers at boot without the network ----
  payai.mode = exact(BASE); celo.mode = exact(OPT);
  {
    const srv = await boot("d"); servers.push(srv);
    const first = await offerOf(srv.url);
    ok(first.status === 402 && !first.nets.has(CELO) && /dropping eip155:42220/.test(srv.log()), "a facilitator that answers without Celo: dropped at boot");
    ok(!/rail re-read/.test(srv.log()) && !/read again in the background/.test((await celoRail(srv.url))?.reason || ""), "nothing is scheduled to re-read it");
    ok((await celoRail(srv.url))?.reasonWord === "not-advertised", "and /api/rails says not-advertised: the facilitator answered without it");
    const reads = celo.supported;
    celo.mode = exact(CELO);
    await until(async () => celo.supported, (n) => n > reads, RECHECK_MS * 8, 50);
    ok(celo.supported === reads && !(await offerOf(srv.url)).nets.has(CELO), "it is never read again, and never gains the network without a restart");
    await srv.stop();
  }

  // ---- G. one read of ours times out, the next is answered: never dropped ----
  // The first /supported request never answers; the boot's second try is a
  // request of its own (not the hung one again), and its answer keeps Celo.
  payai.mode = exact(BASE); celo.mode = { hangReads: 1, then: exact(CELO) };
  {
    const t0 = Date.now();
    const srv = await boot("g"); servers.push(srv);
    const bootMs = Date.now() - t0;
    const first = await offerOf(srv.url);
    ok(first.status === 402 && first.nets.has(CELO) && first.nets.has(BASE) && !/dropping eip155:42220/.test(srv.log()), `one timed-out read of ours does not drop the rail: Celo is in the first 402 (${[...first.nets].join(", ")})`);
    ok((await celoRail(srv.url))?.offered === true, "and /api/rails offers it");
    ok(bootMs < 60_000, `boot stays bounded (${bootMs} ms)`);
    await srv.stop();
  }

  // ---- H. three tries when the bound holds them ----
  payai.mode = exact(BASE); celo.mode = { hangReads: 2, then: exact(CELO) };
  {
    const srv = await boot("h", { X402_SUPPORTED_TRY_MS: "1500", X402_SUPPORTED_BOOT_MS: "8000" });
    servers.push(srv);
    const first = await offerOf(srv.url);
    ok(first.nets.has(CELO) && !/dropping eip155:42220/.test(srv.log()) && celo.supported >= 3, `two timed-out reads, the third answered inside the bound: Celo is offered at boot (${celo.supported} reads)`);
    await srv.stop();
  }

  // ---- I. every boot read of ours times out: probe-timeout, never not-advertised ----
  payai.mode = exact(BASE); celo.mode = { hangReads: 1e9, then: exact(CELO) };
  {
    const srv = await boot("i", { X402_SUPPORTED_TRY_MS: "1500", X402_RAIL_RECHECK_MS: "off" });
    servers.push(srv);
    const rail = await celoRail(srv.url);
    ok(rail?.offered === false && rail.reasonWord === "probe-timeout" && /our timeout, not the facilitator's answer/.test(rail.reason || "") && /next restart/.test(rail.reason || ""), `no answer within our limit reads probe-timeout on /api/rails (${rail?.reasonWord}: ${rail?.reason})`);
    ok(/dropping eip155:42220 from the offered networks \(probe-timeout\)/.test(srv.log()), "and the boot log names probe-timeout");
    await srv.stop();
  }
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || e);
  for (const s of servers) if (s.exited() === null) console.error(s.log().slice(-3000));
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  for (const s of stubs) s.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
