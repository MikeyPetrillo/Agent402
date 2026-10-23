#!/usr/bin/env node
// The Robinhood settle order follows the listed facilitator's relayer gas
// (src/robinhood-order.js): a dry reading puts our own relayer first and the
// facilitator is not asked; a funded reading puts the facilitator first again;
// an unread, unknown or stale reading never moves the order. Offline: stub
// facilitator, stub relayer, the real settle-failure hook.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  facilitatorIsDry, createRobinhoodOrder, withRobinhoodGasOrder, ownFirstAttemptOf, skipDryThreshold,
  ownRelayerIsLow, ownRefusedOf, withOwnRefusalMemo,
} from "../src/robinhood-order.js";
import { registerFacilitatorFailureHooks } from "../src/payments.js";

let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => console.log(`  ok   ${name}`))
  .catch((e) => { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); });

const RH = "eip155:4663";
const HOST = "facilitator.example";
const NOW = 1_800_000_000_000;
const row = (over = {}) => ({ network: RH, facilitator: HOST, signer: "0x" + "11".repeat(20), balanceEth: 0.001, runway: 600, status: "ok", at: NOW - 60_000, ...over });
const dry = () => [row({ runway: 3, status: "low", balanceEth: 0.000005 })];
const funded = () => [row({ runway: 2000, status: "ok", balanceEth: 0.004 })];
const REVERTED = 'The contract function "transferWithAuthorization" reverted.';

await check("the default dry threshold is 50 settlements; the env tunes it", () => {
  assert.equal(skipDryThreshold({}), 50);
  assert.equal(skipDryThreshold({ ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS: "10" }), 10);
  assert.equal(skipDryThreshold({ ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS: "junk" }), 50);
});

await check("a read row below the threshold is dry; at or above it, or a balance for one settlement short of it, is judged by runway", () => {
  assert.equal(facilitatorIsDry(dry(), { host: HOST, now: NOW }), true);
  assert.equal(facilitatorIsDry([row({ runway: 0, status: "low", balanceEth: 0 })], { host: HOST, now: NOW }), true, "a balance that cannot pay one settlement is dry");
  assert.equal(facilitatorIsDry([row({ runway: 50 })], { host: HOST, now: NOW }), false);
  assert.equal(facilitatorIsDry(funded(), { host: HOST, now: NOW }), false);
});

await check("unread, unknown, stale, other-host, own and other-network rows never make it dry", () => {
  for (const r of [
    row({ status: "unread", runway: 2 }),
    row({ status: "unknown", runway: null }),
    row({ runway: 2, status: "low", at: NOW - 46 * 60_000 }),
    row({ runway: 2, status: "low", facilitator: "other.example" }),
    row({ runway: 2, status: "low", own: true }),
    row({ runway: 2, status: "low", network: "eip155:8453" }),
  ]) assert.equal(facilitatorIsDry([r], { host: HOST, now: NOW }), false, JSON.stringify(r));
  assert.equal(facilitatorIsDry([], { host: HOST, now: NOW }), false);
});

await check("with two signers, the facilitator is dry only when every read one is", () => {
  assert.equal(facilitatorIsDry([...dry(), row({ signer: "0x" + "22".repeat(20), runway: 900 })], { host: HOST, now: NOW }), false);
  assert.equal(facilitatorIsDry([...dry(), row({ signer: "0x" + "22".repeat(20), runway: 1, status: "low" })], { host: HOST, now: NOW }), true);
});

await check("the order flips on a dry reading and back on the next funded one, one log line each", () => {
  const lines = [];
  const o = createRobinhoodOrder({ host: HOST, now: () => NOW, log: (l) => lines.push(l) });
  assert.equal(o.ownFirst(), false);
  assert.equal(o.update(dry()), true);
  assert.equal(o.ownFirst(), true);
  assert.equal(o.update(dry()), false, "no change, no line");
  assert.equal(o.view().first, "own relayer");
  assert.equal(o.update([row({ status: "unread", runway: 1 })]), true, "an unread reading puts the facilitator first again (never skips on unread)");
  assert.equal(o.ownFirst(), false);
  o.update(dry());
  assert.equal(o.update(funded()), true);
  assert.equal(o.ownFirst(), false);
  assert.equal(o.view().first, HOST);
  assert.deepEqual(lines, [
    `Robinhood: ${HOST} dry, own relayer first`,
    `Robinhood: ${HOST} funded again, facilitator first`,
    `Robinhood: ${HOST} dry, own relayer first`,
    `Robinhood: ${HOST} funded again, facilitator first`,
  ]);
});

const makeClients = () => {
  const asked = [];
  const facilitator = { settle: async () => { asked.push("facilitator"); return { success: true, transaction: "0x" + "aa".repeat(32), network: RH }; } };
  const relayer = { settle: async () => { asked.push("own"); return { success: true, transaction: "0x" + "bb".repeat(32), network: RH }; } };
  return { asked, facilitator, relayer };
};

await check("dry: our relayer settles first and the facilitator is not asked", async () => {
  const { asked, facilitator, relayer } = makeClients();
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
  withRobinhoodGasOrder(facilitator, { order, relayer });
  order.update(dry());
  const payload = { p: 1 };
  const r = await facilitator.settle(payload, { network: RH, scheme: "exact" });
  assert.equal(r.success, true);
  assert.deepEqual(asked, ["own"]);
  assert.equal(ownFirstAttemptOf(payload, RH), true);
});

await check("funded or unread: the facilitator settles first, as before", async () => {
  for (const readings of [funded(), [row({ status: "unread", runway: 1 })], []]) {
    const { asked, facilitator, relayer } = makeClients();
    const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
    withRobinhoodGasOrder(facilitator, { order, relayer });
    order.update(readings);
    const payload = { p: 1 };
    await facilitator.settle(payload, { network: RH, scheme: "exact" });
    assert.deepEqual(asked, ["facilitator"]);
    assert.equal(ownFirstAttemptOf(payload, RH), false);
  }
});

await check("a refill flips the next payment back to the facilitator within one reading", async () => {
  const { asked, facilitator, relayer } = makeClients();
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
  withRobinhoodGasOrder(facilitator, { order, relayer });
  order.update(dry());
  await facilitator.settle({}, { network: RH });
  order.update(funded());
  await facilitator.settle({}, { network: RH });
  assert.deepEqual(asked, ["own", "facilitator"]);
});

await check("another network is untouched even while dry", async () => {
  const { asked, facilitator, relayer } = makeClients();
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
  withRobinhoodGasOrder(facilitator, { order, relayer });
  order.update(dry());
  await facilitator.settle({}, { network: "eip155:8453" });
  assert.deepEqual(asked, ["facilitator"]);
});

await check("no relayer (key unset): the client is not wrapped", () => {
  const { facilitator } = makeClients();
  const before = facilitator.settle;
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
  order.update(dry());
  withRobinhoodGasOrder(facilitator, { order, relayer: null });
  assert.equal(facilitator.settle, before);
});

const fakeServer = () => {
  const hooks = {};
  return { hooks, onVerifyFailure(fn) { hooks.verifyFailure = fn; return this; }, onAfterSettle(fn) { hooks.afterSettle = fn; return this; }, onSettleFailure(fn) { hooks.settleFailure = fn; return this; } };
};

await check("the failure hook: after our relayer settled first, it is not asked again and its ambiguous answer is not handed back to it", async () => {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  try {
    const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
    order.update(dry());
    const asked = [];
    let outageCalls = 0;
    const outage = { settleAfterAmbiguous: async () => { outageCalls++; return null; }, handle: async () => { outageCalls++; return null; } };
    const ownCandidate = { name: "own relayer", revertRetry: true, confirmed: true, own: true, client: { settle: async () => { asked.push("own-again"); return { success: true, transaction: "0x" + "cc".repeat(32), network: RH }; } } };
    // The listed fallback reverts too (retryable), so the chain would reach
    // our relayer's own candidate next: it must not be asked a second time.
    const listed = { name: "listed", revertRetry: true, client: { settle: async () => { asked.push("listed"); return { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: RH }; } } };
    const s = fakeServer();
    registerFacilitatorFailureHooks(s, null, null, { [RH]: () => [listed, ownCandidate] }, { outageFor: () => outage });

    // A reverted transfer from our relayer (retryable, no tx): the listed
    // fallback is asked, our relayer is not asked a second time.
    const facilitator = { settle: async () => { asked.push("facilitator"); return { success: true }; } };
    const relayerRevert = { settle: async () => ({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: RH }) };
    withRobinhoodGasOrder(facilitator, { order, relayer: relayerRevert });
    const payload = { p: 2 };
    const res = await facilitator.settle(payload, { network: RH, scheme: "exact" });
    const err = Object.assign(new Error(REVERTED), { errorReason: res.errorReason, errorMessage: res.errorMessage, transaction: "" });
    const out = await s.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: payload, error: err });
    assert.notEqual(out?.recovered, true);
    assert.deepEqual(asked, ["listed"], "the facilitator was skipped and our relayer not asked twice");

    // An ambiguous answer from our relayer (a timeout): the outage path,
    // which would hand it back to our relayer, does not run.
    const timeoutErr = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const payload2 = { p: 3 };
    const facilitator2 = { settle: async () => ({ success: true }) };
    withRobinhoodGasOrder(facilitator2, { order, relayer: { settle: async () => { throw timeoutErr; } } });
    await facilitator2.settle(payload2, { network: RH, scheme: "exact" }).catch(() => {});
    asked.length = 0;
    assert.equal(await s.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: payload2, error: timeoutErr }), undefined);
    assert.equal(outageCalls, 0, "no outage read for our relayer's own answer");
    assert.deepEqual(asked, []);

    // Control: the facilitator asked first (not our-relayer-first) and timing
    // out still reaches the outage path.
    await s.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: { p: 4 }, error: timeoutErr });
    assert.ok(outageCalls >= 1, "the facilitator's own ambiguous answer is read on chain as before");
  } finally {
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
});

await check("our relayer's own low reading keeps the facilitator first; unread or stale does not", () => {
  const own = (over = {}) => ({ network: RH, facilitator: "own relayer", signer: "0x" + "22".repeat(20), own: true, balanceEth: 0.01, runway: 5000, status: "ok", at: NOW - 60_000, ...over });
  assert.equal(ownRelayerIsLow([own({ status: "low", runway: 10 })], { now: NOW }), true);
  assert.equal(ownRelayerIsLow([own({ runway: 49 })], { now: NOW }), true, "a runway under the threshold is low");
  assert.equal(ownRelayerIsLow([own()], { now: NOW }), false);
  assert.equal(ownRelayerIsLow([own({ status: "unread", runway: null })], { now: NOW }), false);
  assert.equal(ownRelayerIsLow([own({ status: "low", runway: 1, at: NOW - 2 * 3600_000 })], { now: NOW }), false, "stale");
  assert.equal(ownRelayerIsLow([own({ status: "low", runway: 1, network: "eip155:8453" })], { now: NOW }), false);
  assert.equal(ownRelayerIsLow(dry(), { now: NOW }), false, "the facilitator's own rows are not ours");

  const lines = [];
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: (l) => lines.push(l) });
  order.update([...dry(), own({ status: "low", runway: 2, balanceEth: 0.00001 })]);
  assert.equal(order.ownFirst(), false, "both low: the facilitator stays first");
  order.update([...dry(), own()]);
  assert.equal(order.ownFirst(), true, "ours funded: ours first");
  order.update([...dry(), own({ status: "low", runway: 2 })]);
  assert.equal(order.ownFirst(), false, "ours runs low: the facilitator first again");
  assert.match(lines.at(-1), /own relayer low, facilitator first/);
  order.update([...dry(), own({ status: "unread", runway: null })]);
  assert.equal(order.ownFirst(), true, "an unread reading of ours does not block (its refusal falls through to the facilitator)");
});

await check("own first, our relayer refuses with nothing sent: the listed fallback, then the facilitator; never our relayer again", async () => {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  try {
    const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
    order.update(dry());
    const msgs = ["own relayer balance cannot pay this settlement's gas", "relayer lock not available (db)", "gas price 9 wei is over the relayer cap (1 gwei)"];
    let n = 0;
    const tx = () => "0x" + (++n).toString(16).padStart(64, "0");
    for (const withListed of [true, false]) {
      for (const msg of msgs) {
        const asked = [];
        let ownCalls = 0;
        const relayer = withOwnRefusalMemo({ settle: async () => { ownCalls++; return { success: false, errorReason: msg, errorMessage: msg, transaction: "", network: RH, nothingSent: true }; } });
        const facilitator = { settle: async () => { asked.push("facilitator"); return { success: true, transaction: tx(), network: RH }; } };
        withRobinhoodGasOrder(facilitator, { order, relayer });
        const listed = { name: "listed", revertRetry: true, client: { settle: async () => { asked.push("listed"); return { success: true, transaction: tx(), network: RH }; } } };
        const ownCandidate = { name: "own relayer", revertRetry: true, own: true, client: relayer };
        const s = fakeServer();
        registerFacilitatorFailureHooks(s, null, null, { [RH]: () => [...(withListed ? [listed] : []), ownCandidate] }, { outageFor: () => null });
        const payload = { msg, withListed };
        const res = await facilitator.settle(payload, { network: RH, scheme: "exact" });
        assert.equal(ownRefusedOf(payload), true, msg);
        const err = Object.assign(new Error(msg), { errorReason: res.errorReason, errorMessage: res.errorMessage, transaction: "" });
        const out = await s.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: payload, error: err });
        assert.equal(out?.recovered, true, `${msg} (listed ${withListed})`);
        assert.deepEqual(asked, withListed ? ["listed"] : ["facilitator"], `${msg} (listed ${withListed})`);
        assert.equal(ownCalls, 1, "our relayer was asked once");
        // The memo: asked again for the same payment, ours refuses at once.
        const again = await relayer.settle(payload, { network: RH });
        assert.equal(again.nothingSent, true);
        assert.equal(ownCalls, 1, "no second attempt");
      }
    }

    // The facilitator, asked after our refusal, answers ambiguously: its
    // answer goes to the outage path, and our relayer is still not re-asked.
    let ownCalls = 0;
    let outageCalls = 0;
    const relayer = withOwnRefusalMemo({ settle: async () => { ownCalls++; return { success: false, errorReason: msgs[0], errorMessage: msgs[0], transaction: "", network: RH, nothingSent: true }; } });
    const timeoutErr = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const facilitator = { settle: async () => { throw timeoutErr; } };
    withRobinhoodGasOrder(facilitator, { order, relayer });
    const outage = { handle: async (ctx) => { outageCalls++; const r = await relayer.settle(ctx.paymentPayload, ctx.requirements); assert.equal(r.nothingSent, true); return { refused: true }; } };
    const s = fakeServer();
    registerFacilitatorFailureHooks(s, null, null, { [RH]: () => [{ name: "own relayer", revertRetry: true, own: true, client: relayer }] }, { outageFor: () => outage });
    const payload = { amb: 1 };
    const res = await facilitator.settle(payload, { network: RH, scheme: "exact" });
    const out = await s.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: payload, error: Object.assign(new Error(res.errorMessage), { errorReason: res.errorReason, transaction: "" }) });
    assert.notEqual(out?.recovered, true);
    assert.equal(outageCalls, 1, "the facilitator's ambiguous answer is read on chain");
    assert.equal(ownCalls, 1, "our relayer is not asked a second time");

    // Control: a refusal from our relayer WITHOUT the nothing-sent mark (it
    // may have sent) stops as before.
    const asked = [];
    const unmarked = withOwnRefusalMemo({ settle: async () => ({ success: false, errorReason: "settlement_pending", errorMessage: "pending", transaction: "", network: RH }) });
    const facilitator3 = { settle: async () => { asked.push("facilitator"); return { success: true, transaction: tx(), network: RH }; } };
    withRobinhoodGasOrder(facilitator3, { order, relayer: unmarked });
    const s3 = fakeServer();
    registerFacilitatorFailureHooks(s3, null, null, { [RH]: () => [{ name: "listed", revertRetry: true, client: { settle: async () => { asked.push("listed"); return { success: true, transaction: tx(), network: RH }; } } }] }, { outageFor: () => null });
    const p3 = { unmarked: 1 };
    const r3 = await facilitator3.settle(p3, { network: RH, scheme: "exact" });
    assert.equal(ownRefusedOf(p3), false);
    const out3 = await s3.hooks.settleFailure({ requirements: { network: RH, scheme: "exact" }, paymentPayload: p3, error: Object.assign(new Error("pending"), { errorReason: r3.errorReason, transaction: "" }) });
    assert.equal(out3, undefined);
    assert.deepEqual(asked, [], "nobody after an answer that is not certain nothing was sent");
  } finally {
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
});

await check("the facilitator refilled while our relayer settles a payment: that payment finishes there once, the next goes to the facilitator once", async () => {
  const order = createRobinhoodOrder({ host: HOST, now: () => NOW, log: () => {} });
  order.update(dry());
  const calls = [];
  let release;
  const relayer = { settle: (p) => { calls.push(["relayer", p.id]); return new Promise((r) => { release = () => r({ success: true, transaction: `0xown${p.id}`, network: RH }); }); } };
  const client = { settle: async (p) => { calls.push(["facilitator", p.id]); return { success: true, transaction: `0xfac${p.id}`, network: RH }; } };
  withRobinhoodGasOrder(client, { order, relayer });
  const first = { id: 1 };
  const inFlight = client.settle(first, { network: RH });
  order.update([row({ runway: 5000 })]);
  assert.equal(order.ownFirst(), false, "the refill puts the facilitator first");
  const next = await client.settle({ id: 2 }, { network: RH });
  release();
  const settled = await inFlight;
  assert.equal(settled.transaction, "0xown1", "the in-flight payment keeps its settler");
  assert.equal(ownFirstAttemptOf(first, RH), true, "its failure path still knows our relayer was asked first");
  assert.equal(next.transaction, "0xfac2");
  assert.deepEqual(calls, [["relayer", 1], ["facilitator", 2]], "each payment is sent to exactly one settler");
});

await check("the payment middleware wires it: the primary is wrapped, the gas check feeds the order, the refresh runs", () => {
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const live = (re) => re.test(src);
  assert.ok(live(/^\s*withRobinhoodGasOrder\(robinhoodPrimary, \{ order: robinhoodOrder, relayer: client \}\);/m));
  assert.ok(live(/^\s*addFacilitator\(`Robinhood \(\$\{ROBINHOOD_FACILITATOR_URL\}\)`, robinhoodPrimary\);/m));
  assert.ok(live(/^\s*onReadings: robinhoodOrder \? \(readings\) => robinhoodOrder\.update\(readings\) : null,/m));
  assert.ok(live(/^\s*if \(typeof onReadings === "function"\) \{ try \{ onReadings\(readings\); \}/m));
  assert.ok(live(/^\s*startRobinhoodOrderRefresh\(robinhoodOrder\);/m));
  assert.ok(live(/^\s*const client = withOwnRefusalMemo\(createOwnRelayerClient\(/m), "one memo-wrapped relayer for the order, the fallback list and the outage path");
});

console.log(failures ? `\ntest-robinhood-order: FAILED (${failures})` : "\ntest-robinhood-order: all passed");
process.exit(failures ? 1 : 0);
