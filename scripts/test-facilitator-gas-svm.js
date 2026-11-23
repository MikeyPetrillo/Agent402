// Solana fee payer gas (src/facilitator-gas.js createSvmFeePayerGasCheck) and
// the EVM fallback log rule (evmGasLogLines). Offline: a stub facilitator
// answers /supported with its Solana fee payer, a stub Solana RPC answers
// getBalance (or fails), and the readings go through the failure monitor to
// the public words and the status Worker's verdicts.
//
// Checks: ok / low / empty and the runway arithmetic; unread after repeated
// RPC failures (the word reads unknown); a facilitator with share 0 reported
// but not paging; the word reaching /api/gateway-status's words and the
// pager's facilitator gas title; no figure on the public words; one log line
// per state change (Solana rows, and an EVM fallback that is not first in the
// settle order, while the first one logs every check); the split's fee payer
// list and the payments.js tick wiring.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { createServer } from "node:http";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const {
  createSvmFeePayerGasCheck, svmGasCheckSettings, svmRunwayOf, svmFeePayerTargets, evmGasLogLines, SOL_RENT_RESERVE_LAMPORTS,
} = await import("../src/facilitator-gas.js");
const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
const { createSvmFacilitatorSplit, SOLANA_MAINNET } = await import("../src/svm-facilitator-split.js");
const { judge } = await import("../workers/status-probe/src/index.js");
const GAS_TITLE = "Scheduled check needs review: facilitator-funds (b)";

// Two valid Solana addresses (32 bytes each): the listed and the boot-order fee payers.
const LISTED_FP = "FAC42xNoVBZctsRJqwNcRZnXCwmGZvfHcZLD7hQPXuwu";
const BOOT_FP = "11111111111111111111111111111112";

const listen = (handler) => new Promise((r) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const chain = { balances: new Map(), down: false, calls: [] };
const rpc = await listen(async (req, res) => {
  const m = JSON.parse((await body(req)) || "{}");
  chain.calls.push({ method: m.method, params: m.params });
  if (chain.down) { res.writeHead(502); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" });
  const v = chain.balances.get(m.params?.[0]);
  res.end(JSON.stringify(m.method === "getBalance" && v !== undefined ? { jsonrpc: "2.0", id: m.id, result: { context: { slot: 1 }, value: v } } : { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown account" } }));
});
const fac = await listen((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET, extra: { feePayer: LISTED_FP } }], extensions: [], signers: { [SOLANA_MAINNET]: [LISTED_FP] } }));
});
const RPC = `http://127.0.0.1:${rpc.address().port}`;
const FAC = `http://127.0.0.1:${fac.address().port}`;
const settings = { ...svmGasCheckSettings({}), failAfter: 3 };
const PER = settings.lamportsPerSettlement;
const lamportsFor = (runway) => SOL_RENT_RESERVE_LAMPORTS + runway * PER;
const clock = (t0 = Date.UTC(2026, 10, 22, 12)) => { const c = { t: t0, now: () => c.t }; return c; };
const NUMERIC = /\d/;

try {
  await check("defaults: 20,000 lamports per settlement, low under 500 settlements, empty under 1, the rent reserve kept", () => {
    const d = svmGasCheckSettings({});
    assert.deepEqual([d.lamportsPerSettlement, d.minRunway, d.emptyRunway, d.failAfter, d.intervalMs], [20_000, 500, 1, 3, 600_000]);
    assert.equal(SOL_RENT_RESERVE_LAMPORTS, 890_880);
    assert.equal(svmRunwayOf(578_000_000, 20_000), Math.floor((578_000_000 - 890_880) / 20_000), "0.578 SOL");
    assert.equal(svmRunwayOf(500_000, 20_000), 0, "under the rent reserve pays nothing");
    const e = svmGasCheckSettings({ FACILITATOR_SVM_GAS_MIN_SETTLEMENTS: "50", FACILITATOR_SVM_GAS_EMPTY_SETTLEMENTS: "5", FACILITATOR_SVM_LAMPORTS_PER_SETTLEMENT: "15000" });
    assert.deepEqual([e.minRunway, e.emptyRunway, e.lamportsPerSettlement], [50, 5, 15_000]);
  });

  await check("ok, low and empty from the fee payer's SOL balance; facilitatorFunds and solanaFeePayer follow", async () => {
    const c = clock();
    const m = createToolFailureMonitor({ now: c.now, env: {} });
    const lines = [];
    const g = createSvmFeePayerGasCheck({ targets: () => [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: (l) => lines.push(l) });
    const step = async (runway) => { chain.balances.set(LISTED_FP, lamportsFor(runway)); const r = await g.check(); m.noteRelayerGas(r, { network: SOLANA_MAINNET }); c.t += 600_000; return { r, pub: await m.status({ fresh: true }) }; };
    let { r, pub } = await step(28_000);
    assert.deepEqual([r[0].status, r[0].runway, r[0].signer, r[0].share], ["ok", 28_000, LISTED_FP, 100]);
    assert.equal(r[0].balanceSol, lamportsFor(28_000) / 1e9);
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["ok", "ok"]);
    ({ r, pub } = await step(499));
    assert.equal(r[0].status, "low");
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["low", "low"]);
    ({ r, pub } = await step(0));
    assert.equal(r[0].status, "empty");
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["low", "empty"], "empty pages as facilitatorFunds=low");
    const full = await m.status({ fresh: true, full: true });
    assert.equal(full.facilitatorFunds.relayersLow, 1);
    assert.equal(full.solanaFeePayer.feePayers[0].runway, 0, "the operator view carries the runway");
    assert.equal(full.solanaFeePayer.feePayers[0].feePayer, LISTED_FP);
    assert.equal(typeof full.solanaFeePayer.feePayers[0].balanceSol, "number", "...and the balance");
    assert.ok(chain.calls.every((x) => x.method === "getBalance"), "one getBalance per fee payer per check, nothing else");
  });

  await check("the alarm reaches the status words and the pager's gas title; the public words carry no figure", async () => {
    const c = clock();
    const m = createToolFailureMonitor({ now: c.now, env: {} });
    const g = createSvmFeePayerGasCheck({ targets: [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: () => {} });
    chain.balances.set(LISTED_FP, lamportsFor(10));
    m.noteRelayerGas(await g.check(), { network: SOLANA_MAINNET });
    const pub = await m.status({ fresh: true });
    assert.deepEqual(Object.keys(pub.solanaFeePayer), ["status"]);
    assert.deepEqual(Object.keys(pub.facilitatorFunds), ["status", "alert"]);
    for (const k of ["solanaFeePayer", "facilitatorFunds"]) assert.doesNotMatch(JSON.stringify(pub[k]), NUMERIC, `${k} public: words only`);
    assert.doesNotMatch(JSON.stringify(pub), new RegExp(LISTED_FP), "no fee payer address publicly");
    assert.equal(judge({ gateway: pub })[GAS_TITLE], "bad", "the status Worker pages the gas title");
    chain.balances.set(LISTED_FP, lamportsFor(5_000));
    m.noteRelayerGas(await g.check(), { network: SOLANA_MAINNET });
    assert.equal(judge({ gateway: await m.status({ fresh: true }) })[GAS_TITLE], "good", "a refilled fee payer closes it");
    assert.equal(judge({ gateway: { facilitatorFunds: { status: "refused", alert: "ok" }, solanaFeePayer: { status: "empty" } } })[GAS_TITLE], "bad", "a dry Solana fee payer pages even while a refusal outranks low");
  });

  await check("RPC down: one failure keeps the last reading; repeated failures read unread and the word reads unknown", async () => {
    const c = clock();
    const m = createToolFailureMonitor({ now: c.now, env: {} });
    const lines = [];
    const g = createSvmFeePayerGasCheck({ targets: [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: (l) => lines.push(l) });
    chain.balances.set(LISTED_FP, lamportsFor(9_000));
    await g.check();
    chain.down = true;
    let r = await g.check();
    assert.deepEqual([r[0].status, r[0].failures], ["ok", 1]);
    await g.check();
    r = await g.check();
    assert.equal(r[0].status, "unread");
    assert.doesNotMatch(r[0].error, /127\.0\.0\.1|http/, "the error never carries the RPC URL");
    m.noteRelayerGas(r, { network: SOLANA_MAINNET });
    const pub = await m.status({ fresh: true });
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["unknown", "unknown"]);
    assert.notEqual(judge({ gateway: pub })[GAS_TITLE], "bad", "unread is not a low balance");
    // No RPC answers at all before any good reading: nothing to report yet,
    // then unread after the same count.
    const g2 = createSvmFeePayerGasCheck({ targets: [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: () => {} });
    assert.equal((await g2.check()).length, 0);
    await g2.check();
    assert.equal((await g2.check())[0].status, "unread");
    chain.down = false;
    r = await g.check();
    assert.equal(r[0].status, "ok", "a good read clears it");
  });

  await check("a facilitator with share 0 is reported but never pages; the one taking quotes does", async () => {
    const c = clock();
    const m = createToolFailureMonitor({ now: c.now, env: {} });
    const g = createSvmFeePayerGasCheck({ targets: [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }, { facilitator: "boot.example", feePayer: BOOT_FP, share: 0 }], rpcUrls: [RPC], settings, now: c.now, log: () => {} });
    chain.balances.set(LISTED_FP, lamportsFor(20_000));
    chain.balances.set(BOOT_FP, lamportsFor(0));
    const r = await g.check();
    assert.deepEqual(r.map((x) => [x.facilitator, x.status, x.standby === true]), [["listed.example", "ok", false], ["boot.example", "empty", true]]);
    m.noteRelayerGas(r, { network: SOLANA_MAINNET });
    const pub = await m.status({ fresh: true });
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["ok", "ok"], "standby does not page");
    assert.notEqual(judge({ gateway: pub })[GAS_TITLE], "bad");
    const full = await m.status({ fresh: true, full: true });
    const sb = full.solanaFeePayer.feePayers.find((x) => x.facilitator === "boot.example");
    assert.deepEqual([sb.status, sb.standby, sb.share], ["empty", true, 0], "the operator view reports the standby fee payer");
    assert.equal(full.facilitatorFunds.relayersLow, 0);
    // Unread on standby pages nothing either.
    m.noteRelayerGas([{ ...r[1], status: "unread", failures: 3 }, r[0]], { network: SOLANA_MAINNET });
    assert.equal((await m.status({ fresh: true })).facilitatorFunds.status, "ok");
  });

  await check("a facilitator that names no fee payer reads unknown and never pages", async () => {
    const c = clock();
    const m = createToolFailureMonitor({ now: c.now, env: {} });
    const g = createSvmFeePayerGasCheck({ targets: [{ facilitator: "boot.example", feePayer: null, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: () => {} });
    const r = await g.check();
    assert.equal(r[0].status, "unknown");
    m.noteRelayerGas(r, { network: SOLANA_MAINNET });
    const pub = await m.status({ fresh: true });
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["ok", "unknown"]);
  });

  await check("Solana rows log once per state change", async () => {
    const c = clock();
    const lines = [];
    const g = createSvmFeePayerGasCheck({ targets: [{ facilitator: "listed.example", feePayer: LISTED_FP, share: 100 }], rpcUrls: [RPC], settings, now: c.now, log: (l) => lines.push(l) });
    chain.balances.set(LISTED_FP, lamportsFor(9_000));
    await g.check(); await g.check();
    assert.equal(lines.length, 0, "a fee payer that starts ok logs nothing");
    chain.balances.set(LISTED_FP, lamportsFor(100));
    await g.check(); await g.check(); await g.check();
    assert.equal(lines.length, 1, "low logs once");
    assert.match(lines[0], /low \(runway 100 settlements\)/);
    chain.balances.set(LISTED_FP, lamportsFor(9_000));
    await g.check(); await g.check();
    assert.equal(lines.length, 2, "back to ok logs once");
  });

  await check("EVM: a fallback that is not first in the settle order logs once per state change; the first logs every check", () => {
    const seen = new Map();
    const NET = "eip155:4663";
    const row = (facilitator, status, extra = {}) => ({ network: NET, facilitator, signer: "0x" + "ab".repeat(20), status, runway: status === "ok" ? 5000 : 0, ...extra });
    const lines = [];
    for (let i = 0; i < 6; i++) lines.push(...evmGasLogLines([row("first.example", "ok"), row("spare.example", "low")], { network: NET, primary: "first.example", seen }));
    assert.equal(lines.length, 1, `the dry spare logs once across six checks: ${lines.join(" | ")}`);
    assert.match(lines[0], /spare\.example signer .* low \(runway 0 settlements\)/);
    lines.push(...evmGasLogLines([row("spare.example", "unread", { error: "rpc down" })], { network: NET, primary: "first.example", seen }));
    lines.push(...evmGasLogLines([row("spare.example", "ok")], { network: NET, primary: "first.example", seen }));
    lines.push(...evmGasLogLines([row("spare.example", "ok")], { network: NET, primary: "first.example", seen }));
    assert.equal(lines.length, 3, "unread and back to ok log once each");
    const firstLines = [];
    for (let i = 0; i < 3; i++) firstLines.push(...evmGasLogLines([row("first.example", "low")], { network: NET, primary: "first.example", seen }));
    assert.equal(firstLines.length, 3, "the first in order logs every low check");
    const own = evmGasLogLines([row("own relayer", "low", { own: true }), { network: NET, facilitator: "price floor", status: "low" }], { network: NET, primary: "first.example", seen });
    assert.equal(own.length, 1, "our own relayer logs every low check; the price floor row is not a signer line");
  });

  await check("fee payer targets: the split's active entry takes its share, the boot-order one the rest, others none", async () => {
    const client = { getSupported: async () => (await fetch(`${FAC}/supported`)).json() };
    const quiet = { log() {}, warn() {} };
    const split = createSvmFacilitatorSplit({ entries: [{ url: FAC, label: `Solana listed (${FAC})`, client }], share: 100, log: quiet });
    const boot = { kind: { x402Version: 2, scheme: "exact", network: SOLANA_MAINNET, extra: { feePayer: BOOT_FP } } };
    split.install({ getSupportedKind: () => boot.kind, getFacilitatorExtensions: () => [], getFacilitatorClient: () => null });
    await split.check();
    let t = svmFeePayerTargets({ split: split.feePayers(), bootFeePayer: BOOT_FP, bootLabel: "boot label" });
    assert.deepEqual(t, [{ facilitator: new URL(FAC).host, feePayer: LISTED_FP, share: 100 }, { facilitator: "boot label", feePayer: BOOT_FP, share: 0 }]);
    const half = createSvmFacilitatorSplit({ entries: [{ url: FAC, label: "x", client }], share: 30, log: quiet });
    half.install({ getSupportedKind: () => boot.kind, getFacilitatorExtensions: () => [], getFacilitatorClient: () => null });
    await half.check();
    t = svmFeePayerTargets({ split: half.feePayers(), bootFeePayer: BOOT_FP, bootLabel: "boot label" });
    assert.deepEqual(t.map((x) => x.share), [30, 70]);
    assert.deepEqual(svmFeePayerTargets({ split: null, bootFeePayer: BOOT_FP, bootLabel: "boot label" }), [{ facilitator: "boot label", feePayer: BOOT_FP, share: 100 }], "no split: the boot-order one takes every quote");
  });

  await check("payments.js tick: reads the split and the boot-order fee payer, notes the Solana rows on the shared monitor", async () => {
    const { startSvmFeePayerGasCheck } = await import("../src/payments.js");
    const { toolFailureMonitor } = await import("../src/tool-failure-monitor.js");
    chain.balances.set(LISTED_FP, lamportsFor(50));
    chain.balances.set(BOOT_FP, lamportsFor(50));
    const split = { feePayers: () => [{ label: "x", url: "https://listed.example", feePayer: LISTED_FP, share: 100 }, { label: "boot-order", url: null, feePayer: BOOT_FP, share: 0 }] };
    const tick = await startSvmFeePayerGasCheck({ split: () => split, bootFeePayer: () => BOOT_FP, bootLabel: () => "boot label", rpcUrls: [RPC], schedule: false });
    await tick();
    const rows = (toolFailureMonitor().snapshot().gas || []).filter((r) => r.network === SOLANA_MAINNET);
    assert.deepEqual(rows.map((r) => [r.facilitator, r.status, r.standby === true]).sort(), [["boot label", "low", true], ["listed.example", "low", false]]);
    const pub = await toolFailureMonitor().status({ fresh: true });
    assert.deepEqual([pub.facilitatorFunds.status, pub.solanaFeePayer.status], ["low", "low"]);
  });
} finally {
  rpc.close(); fac.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
