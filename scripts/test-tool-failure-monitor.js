// The per-tool and per-upstream failure monitor (src/tool-failure-monitor.js),
// the Celo settle demotion (src/settle-demotion.js) and their surfaces.
//
// Offline: counting by class and origin, the thresholds behind each word, the
// replica merge through a shared snapshot store, fetch outcome classes
// through the egress meter's observer, the demotion order and its safety
// rule. Booted (FREE_MODE, port 0): the public words carry only `status`, the
// operator endpoint answers 404 without the token and the rows with it, and a
// bespoke route's error answer is logged as a "[tool-error]" line.
import "./lib/file-mode.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { createToolFailureMonitor, toolClassOf, upstreamKindOfError, upstreamKindOfStatus, BUCKET_MS } from "../src/tool-failure-monitor.js";
import { withSettleDemotion, isDemoted, demotedList, isFundsRefusal, _resetSettleDemotion } from "../src/settle-demotion.js";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}
const T0 = 1_800_000_000_000;
const clock = (t = T0) => { const c = { t, now: () => c.t }; return c; };

await check("classes: ok / buyer / fail / timeout / payment / gone / shed", () => {
  assert.equal(toolClassOf(200), "ok");
  assert.equal(toolClassOf(302), "ok");
  assert.equal(toolClassOf(400), "buyer");
  assert.equal(toolClassOf(402), "payment");
  assert.equal(toolClassOf(499), "gone");
  assert.equal(toolClassOf(500), "fail");
  assert.equal(toolClassOf(503), "fail");
  assert.equal(toolClassOf(504), "timeout");
  assert.equal(toolClassOf(503, { shed: true }), "shed");
  assert.equal(upstreamKindOfStatus(200), "ok");
  assert.equal(upstreamKindOfStatus(404), "ok", "an upstream 404 is an answer, not an outage");
  assert.equal(upstreamKindOfStatus(429), "throttled");
  assert.equal(upstreamKindOfStatus(502), "s5xx");
  assert.equal(upstreamKindOfError(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(upstreamKindOfError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), "timeout");
  const ac = new AbortController(); ac.abort(new DOMException("t", "TimeoutError"));
  assert.equal(upstreamKindOfError(Object.assign(new Error("aborted"), { name: "AbortError" }), { signal: ac.signal }), "timeout", "a signal whose reason is a TimeoutError is a timeout");
  assert.equal(upstreamKindOfError(Object.assign(new Error("aborted"), { name: "AbortError" })), "aborted", "a caller's cancel is not the upstream's failure");
  assert.equal(upstreamKindOfError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "network");
});

await check("tool words: 2 outside 5xx ok, 3 degraded, a >25% share over 8 calls failing; synthetic never counts", async () => {
  const c = clock();
  const m = createToolFailureMonitor({ now: c.now, env: {} });
  m.noteTool("stock-quote", 500); m.noteTool("stock-quote", 502);
  for (let i = 0; i < 20; i++) m.noteTool("stock-quote", 500, { synthetic: true });
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "ok", "two outside 5xx and any number of synthetic ones");
  m.noteTool("stock-quote", 504);
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "degraded", "the third outside 5xx (504 counts)");
  for (let i = 0; i < 50; i++) m.noteTool("stock-quote", 200);
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "degraded", "3 of 53 is degraded, not failing");
  const m2 = createToolFailureMonitor({ now: c.now, env: {} });
  for (let i = 0; i < 6; i++) m2.noteTool("render", 200);
  m2.noteTool("render", 503); m2.noteTool("render", 503); m2.noteTool("render", 503);
  assert.equal((await m2.status({ fresh: true })).toolFailures.status, "failing", "3 of 9 is over 25% across at least 8 calls");
  const m3 = createToolFailureMonitor({ now: c.now, env: {} });
  for (let i = 0; i < 10; i++) { m3.noteTool("dns", 400); m3.noteTool("dns", 402); m3.noteTool("dns", 499); m3.noteTool("dns", 503, { shed: true }); }
  assert.equal((await m3.status({ fresh: true })).toolFailures.status, "ok", "buyer errors, settle refusals, hang-ups and shed answers are not tool failures");
  const full = await m2.status({ full: true, fresh: true });
  assert.deepEqual(full.toolFailures.tools.map((r) => r.slug), ["render"]);
});

await check("the hour rolls: failures older than an hour leave the word but stay in the 24 h rows", async () => {
  const c = clock();
  const m = createToolFailureMonitor({ now: c.now, env: {} });
  for (let i = 0; i < 4; i++) m.noteTool("pdf", 500);
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "degraded");
  c.t += 3_600_000 + BUCKET_MS;
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "ok");
  const r = await m.report();
  assert.equal(r.tools[0].slug, "pdf");
  assert.equal(r.tools[0].day.outside.fail, 4);
  assert.equal(r.tools[0].hour.outside.fail, 0);
  c.t += 24 * 3_600_000;
  assert.equal((await m.report()).tools.length, 0, "a day later the rows are gone");
});

await check("thresholds are env-tunable", async () => {
  const m = createToolFailureMonitor({ now: clock().now, env: { TOOL_FAIL_DEGRADED_5XX: "1" } });
  m.noteTool("meta", 500);
  assert.equal((await m.status({ fresh: true })).toolFailures.status, "degraded");
});

await check("upstream words: named hosts only; 5 timeouts degraded, a >25% share failing; synthetic excluded, background counted", async () => {
  const m = createToolFailureMonitor({ now: clock().now, env: {} });
  assert.equal(m.noteUpstream("some-seller.example", "timeout"), null, "an unnamed host is not counted");
  for (let i = 0; i < 4; i++) m.noteUpstream("hist.databento.com", "timeout", { origin: "outside" });
  for (let i = 0; i < 10; i++) m.noteUpstream("hist.databento.com", "timeout", { origin: "synthetic" });
  for (let i = 0; i < 40; i++) m.noteUpstream("hist.databento.com", "ok", { origin: "background" });
  assert.equal((await m.status({ fresh: true })).upstreamHealth.status, "ok", "four counted failures");
  m.noteUpstream("hist.databento.com", "s5xx", { origin: "background" });
  assert.equal((await m.status({ fresh: true })).upstreamHealth.status, "degraded", "the fifth (background counts)");
  for (let i = 0; i < 5; i++) m.noteUpstream("api.exa.ai", "network", { origin: "outside" });
  for (let i = 0; i < 5; i++) m.noteUpstream("api.exa.ai", "ok", { origin: "outside" });
  assert.equal((await m.status({ fresh: true })).upstreamHealth.status, "failing", "5 of 10 failing");
  for (let i = 0; i < 20; i++) m.noteUpstream("api.rugcheck.xyz", "aborted"); for (let i = 0; i < 20; i++) m.noteUpstream("api.rugcheck.xyz", "throttled");
  const full = await m.status({ full: true, fresh: true });
  assert.deepEqual(full.upstreamHealth.upstreams.map((u) => u.upstream), ["exa", "databento"], "a cancel or a 429 is not an outage");
  assert.equal(m.upstreamNameOf("data.sec.gov"), "edgar");
  assert.equal(m.upstreamNameOf("api.stlouisfed.org"), "fred");
  assert.ok(m.registerUpstreamHost("https://worker.internal:8080/x", "render-worker"));
  assert.equal(m.upstreamNameOf("worker.internal"), "render-worker");
});

await check("the egress meter's observer feeds the monitor (5xx, timeout, network; the caller's promise untouched)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input);
    if (u.includes("/five")) return new Response("x", { status: 503 });
    if (u.includes("/slow")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (u.includes("/refused")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response("{}", { status: 200 });
  };
  try {
    const { installEgressMeter, setEgressOutcomeObserver } = await import("../src/egress-meter.js");
    installEgressMeter();
    const m = createToolFailureMonitor({ now: clock().now, env: {} });
    setEgressOutcomeObserver((h, p, init) => m.observeFetch(h, p, init, "outside"));
    assert.equal((await fetch("https://api.hyperliquid.xyz/five")).status, 503);
    await assert.rejects(fetch("https://api.hyperliquid.xyz/slow"), /timed out/);
    await assert.rejects(fetch("https://api.hyperliquid.xyz/refused"), /fetch failed/);
    await fetch("https://api.hyperliquid.xyz/ok");
    await fetch("https://not-named.example/five");
    await new Promise((r) => setTimeout(r, 10));
    const r = await m.report();
    assert.equal(r.upstreams.length, 1);
    assert.deepEqual(r.upstreams[0].hour.outside, { ok: 1, s5xx: 1, timeout: 1, network: 1, throttled: 0, aborted: 0 });
    setEgressOutcomeObserver(null);
  } finally { globalThis.fetch = realFetch; }
});

await check("replica merge: each replica publishes its buckets and a read sums every replica's", async () => {
  const kv = new Map();
  const store = {
    async publish(id, json) { kv.set(id, json); return { ok: true }; },
    async readAll() { return { ok: true, snapshots: [...kv].map(([id, v]) => ({ id, ...JSON.parse(v) })) }; },
  };
  const c = clock();
  const a = createToolFailureMonitor({ now: c.now, env: {}, store, replicaId: "a" });
  const b = createToolFailureMonitor({ now: c.now, env: {}, store, replicaId: "b" });
  a.noteTool("screenshot", 500); a.noteTool("screenshot", 500);
  b.noteTool("screenshot", 500);
  b.noteToolMessage("screenshot", 500, "render worker unreachable: timeout");
  assert.equal((await a.status({ fresh: true })).toolFailures.status, "ok", "two on this replica alone, nothing published yet");
  await a.publish(); await b.publish();
  c.t += 31_000; // past the read cache
  const sa = await a.status({ fresh: true }), sb = await b.status({ fresh: true });
  assert.equal(sa.toolFailures.status, "degraded", "2 + 1 across replicas");
  assert.equal(sb.toolFailures.status, "degraded");
  const r = await a.report();
  assert.equal(r.scope, "shared");
  assert.equal(r.replicasRead, 2);
  assert.equal(r.tools[0].hour.outside.fail, 3, "this replica's live counts are not doubled by its own snapshot");
  assert.match(r.tools[0].lastError.message, /render worker/);
  const solo = createToolFailureMonitor({ now: c.now, env: {} });
  assert.equal((await solo.report()).scope, "instance", "without a store the report says the counts are this process's");
});

await check("the words are cached for 30 s; a stale cache is served while one recompute runs after the response", async () => {
  const c = clock();
  const m = createToolFailureMonitor({ now: c.now, env: {} });
  assert.equal((await m.status()).toolFailures.status, "ok", "first read computes");
  for (let i = 0; i < 3; i++) m.noteTool("t", 500);
  assert.equal((await m.status()).toolFailures.status, "ok", "inside 30 s the cached words are served");
  c.t += 30_001;
  assert.equal((await m.status()).toolFailures.status, "ok", "the first read past 30 s still answers from the cache");
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 5));
  assert.equal((await m.status()).toolFailures.status, "degraded", "the recompute it started has landed");
});

await check("a replica not seen for 10 minutes is left out of the merge", async () => {
  const c = clock();
  const kv = new Map();
  const store = {
    async publish(id, json) { kv.set(id, json); return { ok: true }; },
    async readAll() { return { ok: true, snapshots: [...kv].map(([id, v]) => ({ id, ...JSON.parse(v) })) }; },
  };
  const dead = createToolFailureMonitor({ now: c.now, env: {}, store, replicaId: "dead" });
  const live = createToolFailureMonitor({ now: c.now, env: {}, store, replicaId: "live" });
  const me = createToolFailureMonitor({ now: c.now, env: {}, store, replicaId: "me" });
  for (let i = 0; i < 3; i++) dead.noteTool("x", 500);
  await dead.publish();
  c.t += 11 * 60_000;
  live.noteTool("y", 500);
  await live.publish();
  const r = await me.report();
  assert.equal(r.replicasRead, 2, "this process and the live replica");
  assert.deepEqual(r.tools.map((t) => t.slug), ["y"], "the dead replica's rows are gone");
});

await check("cost: at 300 slugs x 288 buckets x 10 replicas a gateway-status read is a cache read", async () => {
  const t0 = T0;
  const SLUGS = 300, BUCKETS = 288, REPLICAS = 10;
  const others = [];
  for (let r = 0; r < REPLICAS; r++) {
    const m = createToolFailureMonitor({ replicaId: `r${r}`, now: () => t0, env: {} });
    for (let sl = 0; sl < SLUGS; sl++) for (let b = 0; b < BUCKETS; b++) m.noteTool(`slug-${sl}`, b % 17 ? 200 : 503, { at: t0 - b * BUCKET_MS });
    others.push(JSON.stringify(m.snapshot(t0)));
  }
  let reads = 0;
  const store = { async publish() { return { ok: true }; }, async readAll() { reads++; return { ok: true, snapshots: others.map((j, i) => ({ id: `r${i}`, ...JSON.parse(j) })) }; } };
  const c = clock(t0);
  const me = createToolFailureMonitor({ replicaId: "me", now: c.now, env: {}, store });
  await me.status();
  const N = 200;
  let a = performance.now();
  for (let i = 0; i < N; i++) await me.status();
  const perCall = (performance.now() - a) / N;
  assert.ok(perCall < 1, `a cached read costs ${perCall.toFixed(3)} ms`);
  assert.equal(reads, 1, "the replicas are read once per window, not per request");
  c.t += 30_001;
  a = performance.now();
  await me.status();
  const staleRead = performance.now() - a;
  assert.ok(staleRead < 5, `the first read past the window answers from the cache (${staleRead.toFixed(2)} ms); the merge runs after it`);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads, 2, "and the recompute read the replicas once more");
  console.log(`# cached read ${perCall.toFixed(3)} ms, stale read ${staleRead.toFixed(2)} ms`);
});

await check("facilitator refusals: the word reads refused inside the hour, demoted while a facilitator is in cool-down", async () => {
  const c = clock();
  let demoted = [];
  const m = createToolFailureMonitor({ now: c.now, env: {}, isDemoted: () => demoted });
  assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "ok");
  m.noteFacilitatorRefusal({ network: "eip155:42220", facilitator: "Celo", reason: "Out of mainnet settlement funds" });
  assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "refused");
  demoted = [{ network: "eip155:42220", facilitator: "Celo" }];
  assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "demoted");
  demoted = [];
  c.t += 3_600_001;
  assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "ok");
  assert.ok(isFundsRefusal("Out of mainnet settlement funds"));
  assert.ok(isFundsRefusal({ errorReason: "free_tier_exhausted" }));
  assert.ok(!isFundsRefusal("subcent_quota_exceeded"), "the sub-cent quota has its own gate");
  assert.ok(!isFundsRefusal("insufficient_funds"), "the buyer's own balance is not the facilitator's");
});

await check("settle demotion: three consecutive out-of-funds refusals demote; alternates then settle first; a success clears", async () => {
  _resetSettleDemotion();
  process.env.SETTLE_DEMOTE_AFTER = "3";
  const NET = "eip155:42220";
  const calls = [];
  let primaryRefuses = true;
  const primary = { settle: async (_p, req) => { calls.push(`primary:${req.network}`); if (primaryRefuses) throw Object.assign(new Error("Facilitator settle failed (500): Out of mainnet settlement funds"), { errorReason: "unexpected_settle_error" }); return { success: true, transaction: "0xp" }; } };
  const alt = { settle: async () => { calls.push("alt"); return { success: true, transaction: "0xa" }; } };
  const refusals = [];
  const preBroadcast = (e) => isFundsRefusal(e) || /\(402\)/.test(String(e?.message));
  withSettleDemotion(primary, { network: NET, label: "Celo", alternates: () => [{ name: "Solvador", client: alt }], isPreBroadcast: preBroadcast, onRefusal: (r) => refusals.push(r) });
  for (let i = 0; i < 3; i++) await assert.rejects(primary.settle({}, { network: NET }));
  assert.equal(refusals.length, 3);
  assert.ok(isDemoted(NET, "Celo"));
  assert.equal(demotedList()[0].facilitator, "Celo");
  calls.length = 0;
  assert.equal((await primary.settle({}, { network: NET })).transaction, "0xa");
  assert.deepEqual(calls, ["alt"], "while demoted the alternate settles and the demoted facilitator is not asked");
  calls.length = 0;
  await primary.settle({}, { network: "eip155:8453" }).catch(() => {});
  assert.deepEqual(calls, ["primary:eip155:8453"], "another network is untouched");
  _resetSettleDemotion();
  primaryRefuses = false;
  assert.equal((await primary.settle({}, { network: NET })).transaction, "0xp");
  assert.ok(!isDemoted(NET, "Celo"));
});

await check("settle demotion safety: an alternate's ambiguous failure stops the chain; its pre-broadcast refusal falls through to the primary", async () => {
  _resetSettleDemotion();
  const NET = "eip155:42220";
  const seq = [];
  let altMode = "timeout";
  const primary = { settle: async () => { seq.push("primary"); throw Object.assign(new Error("Out of mainnet settlement funds"), {}); } };
  const alt = { settle: async () => { seq.push("alt"); if (altMode === "timeout") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" }); return { success: false, errorReason: "free_tier_exhausted" }; } };
  const preBroadcast = (e) => isFundsRefusal(e);
  withSettleDemotion(primary, { network: NET, label: "Celo", alternates: () => [{ name: "Alt", client: alt }], isPreBroadcast: preBroadcast });
  for (let i = 0; i < 3; i++) await assert.rejects(primary.settle({}, { network: NET }));
  seq.length = 0;
  await assert.rejects(primary.settle({}, { network: NET }), /socket hang up/);
  assert.deepEqual(seq, ["alt"], "a timeout at the alternate may have broadcast: nobody else is asked");
  altMode = "refuse";
  seq.length = 0;
  await assert.rejects(primary.settle({}, { network: NET }), /settlement funds/);
  assert.deepEqual(seq, ["alt", "primary"], "a clean refusal at the alternate lets the demoted primary try");
  _resetSettleDemotion();
});

// ---- settlement-signer gas (src/facilitator-gas.js) -----------------------------
// A stub facilitator names its signer on /supported; a stub chain RPC answers
// eth_gasPrice and eth_getBalance. Runway under the minimum reads "low" on
// facilitatorFunds; enough failed reads read "low" too, never a silent ok.
{
  const { createServer } = await import("node:http");
  const { createRelayerGasCheck, signersFromSupported, runwayOf, gasCheckSettings } = await import("../src/facilitator-gas.js");
  const SIGNER = "0x" + "ab".repeat(20);
  const NET = "eip155:4663";
  const chain = { gasPrice: 20_000_000n, balance: 0n, down: false, supportedDown: false, calls: [] };
  const listen = (handler) => new Promise((r) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
  const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const fac = await listen(async (req, res) => {
    if (chain.supportedDown) { res.writeHead(503); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: { "eip155:*": [SIGNER] } }));
  });
  const rpc = await listen(async (req, res) => {
    const m = JSON.parse(await body(req) || "{}");
    chain.calls.push(m.method);
    if (chain.down) { res.writeHead(502); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" });
    const result = m.method === "eth_gasPrice" ? "0x" + chain.gasPrice.toString(16) : m.method === "eth_getBalance" ? "0x" + chain.balance.toString(16) : "0x";
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
  const FAC = `http://127.0.0.1:${fac.address().port}`, RPC = `http://127.0.0.1:${rpc.address().port}`;
  const settings = { ...gasCheckSettings({}), minRunway: 500, gasPerSettlement: 100_000, failAfter: 3 };
  // One settlement at 20,000,000 wei gas price x 100k gas = 2e12 wei.
  const PER = 2_000_000_000_000n;
  try {
    await check("gas: signers come from /supported (network key, then eip155:*), runway is balance / (price x gas)", () => {
      assert.deepEqual(signersFromSupported({ signers: { "eip155:*": [SIGNER, "nope", SIGNER.toUpperCase().replace("0X", "0x")] } }, NET), [SIGNER]);
      assert.deepEqual(signersFromSupported({ signers: { [NET]: ["0x" + "cd".repeat(20)], "eip155:*": [SIGNER] } }, NET), ["0x" + "cd".repeat(20), SIGNER]);
      assert.deepEqual(signersFromSupported({}, NET), []);
      assert.equal(runwayOf(PER * 499n, 20_000_000n, 100_000), 499);
      assert.equal(runwayOf(0n, 0n, 100_000), null, "no gas price, no runway figure");
    });
    await check("gas: a funded signer reads ok; under the minimum it reads low and facilitatorFunds says low", async () => {
      const c = clock();
      const m = createToolFailureMonitor({ now: c.now, env: {} });
      const g = createRelayerGasCheck({ urls: [FAC], network: NET, rpcUrl: RPC, settings, now: c.now });
      chain.balance = PER * 2_000n;
      let r = await g.check();
      assert.equal(r.length, 1);
      assert.equal(r[0].status, "ok");
      assert.equal(r[0].runway, 2000);
      assert.equal(r[0].signer, SIGNER);
      m.noteRelayerGas(r);
      assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "ok");
      chain.balance = PER * 120n;
      r = await g.check();
      assert.equal(r[0].status, "low");
      m.noteRelayerGas(r);
      assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "low");
      const full = await m.status({ fresh: true, full: true });
      assert.equal(full.facilitatorFunds.relayersLow, 1);
      const rep = await m.report({ t: c.t });
      assert.equal(rep.relayerGas[0].runway, 120);
      assert.equal(rep.relayerGas[0].facilitator, new URL(FAC).host);
      assert.ok(rep.issueSummary.facilitatorNetworks.includes(NET));
      const pub = await m.status({ fresh: true });
      assert.deepEqual(Object.keys(pub.facilitatorFunds), ["status"], "the public word carries no figure");
      // A refusal outranks low.
      m.noteFacilitatorRefusal({ network: NET, facilitator: "x", reason: "Out of mainnet settlement funds" });
      assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "refused");
    });
    await check("gas: one failed read keeps the last reading; repeated failures read unread (low), never a silent ok", async () => {
      const c = clock();
      const m = createToolFailureMonitor({ now: c.now, env: {} });
      const g = createRelayerGasCheck({ urls: [FAC], network: NET, rpcUrl: RPC, settings, now: c.now });
      chain.balance = PER * 2_000n; chain.down = false;
      await g.check();
      chain.down = true;
      let r = await g.check();
      assert.equal(r[0].status, "ok", "one failure keeps the last good reading");
      assert.equal(r[0].failures, 1);
      await g.check();
      r = await g.check();
      assert.equal(r[0].status, "unread");
      m.noteRelayerGas(r);
      assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "low");
      chain.down = false;
      r = await g.check();
      assert.equal(r[0].status, "ok", "a good read clears it");
      // A facilitator whose /supported never named a signer reads unread too.
      chain.supportedDown = true;
      const g2 = createRelayerGasCheck({ urls: [FAC], network: NET, rpcUrl: RPC, settings, now: c.now });
      for (let i = 0; i < 3; i++) r = await g2.check();
      assert.equal(r.length, 1);
      assert.equal(r[0].status, "unread");
      assert.equal(r[0].signer, null);
      chain.supportedDown = false;
    });
    await check("gas: readings merge across replicas (newest per signer) and age out", async () => {
      const store = (() => { const snaps = new Map(); return { async publish(id, json, t) { snaps.set(id, { id, at: t, ...JSON.parse(json) }); return { ok: true }; }, async readAll() { return { ok: true, snapshots: [...snaps.values()] }; } }; })();
      const c = clock();
      const a = createToolFailureMonitor({ now: c.now, env: {}, store });
      const b = createToolFailureMonitor({ now: c.now, env: {}, store });
      a.noteRelayerGas([{ network: NET, facilitator: "f.example", signer: SIGNER, balanceEth: 0.0002, runway: 100, status: "low", at: c.t }]);
      await a.publish(c.t);
      await b.refreshRemote(c.t, { maxAgeMs: 0 });
      assert.equal((await b.status({ fresh: true })).facilitatorFunds.status, "low", "the replica that did not check sees the low reading");
      c.t += 45 * 60_000 + 1;
      await b.refreshRemote(c.t, { maxAgeMs: 0 });
      assert.equal((await b.status({ fresh: true })).facilitatorFunds.status, "ok", "a reading older than the window counts for nothing");
    });
    await check("gas: the payments loop reads every listed facilitator and feeds the process monitor (caller path)", async () => {
      process.env.EVM_RPC_4663 = RPC;
      const { startFacilitatorGasCheck } = await import("../src/payments.js");
      const { toolFailureMonitor } = await import("../src/tool-failure-monitor.js");
      chain.balance = PER * 10n; chain.down = false; chain.calls.length = 0;
      const tick = await startFacilitatorGasCheck({ network: NET, urls: () => [FAC, FAC + "/"], schedule: false });
      const r = await tick();
      assert.ok(Array.isArray(r) && r.length >= 1 && r.every((x) => x.status === "low"), JSON.stringify(r));
      assert.ok(chain.calls.includes("eth_gasPrice") && chain.calls.includes("eth_getBalance"));
      assert.equal((await toolFailureMonitor().status({ fresh: true })).facilitatorFunds.status, "low");
      toolFailureMonitor()._reset();
      delete process.env.EVM_RPC_4663;
    });
  } finally {
    fac.close(); rpc.close();
  }
}

// ---- booted: the surfaces ------------------------------------------------------
// The render worker is configured at a port nothing listens on yet, so the
// first render call meets a cold start: refused connections, then an answer.
const PORT = await getFreePort();
const WORKER_PORT = await getFreePort();
const { createServer } = await import("node:http");
let workerCalls = 0;
const worker = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => { workerCalls++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ url: "https://example.com/", title: "stub", markdown: "# stub", words: 1 })); });
});
const TOKEN = "tool-failure-test-operator-token-0123456789";
const log = [];
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN,
    RENDER_WORKER_URL: `http://127.0.0.1:${WORKER_PORT}`, RENDER_WORKER_TOKEN: "tfm-worker-token", RENDER_WORKER_TIMEOUT_MS: "9000", RENDER_WORKER_MIN_ATTEMPT_MS: "2000" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => log.push(...String(d).split("\n")));
child.stderr.on("data", (d) => log.push(...String(d).split("\n")));
const base = `http://127.0.0.1:${PORT}`;
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(up, "server booted");
  await check("public words carry only `status`", async () => {
    const b = await (await fetch(`${base}/api/gateway-status`)).json();
    for (const k of ["toolFailures", "upstreamHealth", "facilitatorFunds"]) assert.deepEqual(Object.keys(b[k]), ["status"], k);
  });
  await check("/__operator/tool-failures.json: 404 without the token, the rows with it", async () => {
    const anon = await fetch(`${base}/__operator/tool-failures.json`);
    assert.equal(anon.status, 404);
    const wrong = await fetch(`${base}/__operator/tool-failures.json`, { headers: { Authorization: "Bearer not-the-token-0123456789-abcdef" } });
    assert.equal(wrong.status, 404);
    const r = await fetch(`${base}/__operator/tool-failures.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") || "", /no-store/);
    const j = await r.json();
    assert.ok(["ok", "degraded", "failing"].includes(j.toolFailures));
    assert.ok(Array.isArray(j.tools) && Array.isArray(j.upstreams) && j.thresholds && j.issueSummary);
    assert.equal(j.scope, "instance");
  });
  await check("a worker cold start that ends in an answer counts as one success; a wake that fails counts once", async () => {
    const opRead = async () => {
      const j = await (await fetch(`${base}/__operator/tool-failures.json`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      const row = j.upstreams.find((u) => u.upstream === "render-worker");
      const sum = { ok: 0, network: 0, s5xx: 0, timeout: 0 };
      if (row) for (const lane of ["outside", "background", "synthetic"]) for (const k of Object.keys(sum)) sum[k] += row.hour[lane][k];
      return { sum, status: row?.status ?? "ok", word: j.upstreamHealth };
    };
    setTimeout(() => worker.listen(WORKER_PORT, "127.0.0.1"), 1800);
    const r = await fetch(`${base}/api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }) });
    assert.equal(r.status, 200, `the render answered once the worker listened (${r.status})`);
    assert.equal(workerCalls, 1, "the worker ran the job once");
    await new Promise((res) => setTimeout(res, 100));
    let o = await opRead();
    assert.deepEqual(o.sum, { ok: 1, network: 0, s5xx: 0, timeout: 0 }, `the refused connects of the wake are not failures (${JSON.stringify(o.sum)})`);
    assert.equal(o.word, "ok");
    await new Promise((res) => { worker.closeAllConnections?.(); worker.close(res); });
    const r2 = await fetch(`${base}/api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }) });
    assert.ok(r2.status >= 500, `a worker that never wakes fails the call (${r2.status})`);
    await new Promise((res) => setTimeout(res, 100));
    o = await opRead();
    assert.deepEqual(o.sum, { ok: 1, network: 1, s5xx: 0, timeout: 0 }, `a wake that still fails counts once (${JSON.stringify(o.sum)})`);
  });
  await check("a bespoke route's error answer is logged as a [tool-error] line", async () => {
    const before = log.filter((l) => l.includes("[tool-error]") && l.includes("slug=pdf")).length;
    const r = await fetch(`${base}/api/pdf`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:1/x.pdf" }) });
    assert.ok(r.status >= 400, `the call failed (${r.status})`);
    await new Promise((res) => setTimeout(res, 200));
    const after = log.filter((l) => l.includes("[tool-error]") && l.includes("slug=pdf")).length;
    assert.ok(after > before, "sendToolError logged the answer");
  });
} finally {
  child.kill("SIGTERM");
}

console.log(`\ntest-tool-failure-monitor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
