#!/usr/bin/env node
// x402 `batch-settlement` (payment channels) and the work meter.
//
//   node scripts/test-batch-settlement.js
//
// Part 1 runs @x402/core's resource server in process with the scheme exactly
// as src/payments.js registers it (src/batch-settlement.js), a facilitator
// that models the escrow, and a buyer that signs real deposits and vouchers
// (scripts/lib/batch-channel-rig.js). It proves the money rules: draw-down
// math, a replayed voucher refused, a failed call and a hung-up call never
// charged, concurrent draws on one channel charged once, metered settles
// under the signed cap, batch claim and settle, the idle refund of the
// remainder and a credit back. Part 2 boots the real server against a stub
// facilitator: the switch off offers nothing new, the switch on offers the
// channel accept last and serves paid calls over it end to end, and the boot
// gate refuses what it must.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { x402ResourceServer } from "@x402/core/server";
import { bootServer } from "./lib/boot-server.js";
import { makeEscrowFacilitator, makeChannelBuyer, encodePayment, BASE, RECEIVER_AUTHORIZER } from "./lib/batch-channel-rig.js";
import { newBatchScheme, makeBatchStores, selectBatchNetworks, runBatchPass, creditBatchChannel, batchNetworksWanted, batchStoreMode, batchAcceptEligible, isBatchSettlementRequest, batchChannelIdOf } from "../src/batch-settlement.js";
import { isMeterable, mediaMeterEnabled } from "../src/gateway-meter.js";
import { BATCH_ACCEPT_JSON_BYTES, acceptsForItem } from "../src/payments.js";
import { setBatchOffer, creditHungUpBatchCall } from "../src/batch-settlement.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

// ---------------------------------------------------------------------------
// Part 0: pure helpers.
{
  ok(batchNetworksWanted({}, [BASE]).length === 0, "switch unset: no network wanted");
  ok(JSON.stringify(batchNetworksWanted({ X402_BATCH_SETTLEMENT_NETWORKS: `${BASE}, eip155:10` }, [BASE])) === JSON.stringify([BASE]), "switch keeps only networks in the plain EVM offer");
  ok(batchStoreMode({}) === null, "no REDIS_URL and no named store: no durable store, nothing offered");
  ok(batchStoreMode({ REDIS_URL: "redis://x" }) === "redis", "REDIS_URL present: the shared Redis store");
  ok(batchStoreMode({ X402_BATCH_SETTLEMENT_STORE: "memory" }) === "memory", "memory store only when named");
  ok(batchStoreMode({ X402_BATCH_SETTLEMENT_STORE: "file", REDIS_URL: "redis://x" }) === null, "an unknown store name offers nothing");
  const deps = { hasLastingEffect: (i) => i.lasting === true, evmOnly: (i) => i.longRunning === true };
  ok(!batchAcceptEligible({ identityBound: true }, deps), "identity-bound routes never offer a channel");
  ok(!batchAcceptEligible({ lasting: true }, deps), "a route whose effect outlives the answer never offers a channel");
  ok(!batchAcceptEligible({ longRunning: true }, deps), "long-running reports never offer a channel");
  ok(batchAcceptEligible({ slug: "uuid" }, deps), "a plain route may offer a channel");
  ok(!mediaMeterEnabled({}) && mediaMeterEnabled({ METERED_MEDIA: "on" }) && !mediaMeterEnabled({ METERED_MEDIA: "true" }), "METERED_MEDIA reads on only");
  const hdr = (scheme) => ({ header: (n) => (n === "payment-signature" ? encodePayment({ x402Version: 2, accepted: { scheme, network: BASE }, payload: { voucher: { channelId: `0x${"ab".repeat(32)}` } } }) : null) });
  ok(isMeterable(hdr("batch-settlement")) && isMeterable(hdr("upto")) && !isMeterable(hdr("exact")), "the meter names the amount for upto and channel payments, never exact");
  ok(isBatchSettlementRequest(hdr("batch-settlement")) && !isBatchSettlementRequest(hdr("exact")), "a channel payment is recognized from its own header");
  ok(batchChannelIdOf(hdr("batch-settlement")) === `0x${"ab".repeat(32)}` && batchChannelIdOf(hdr("upto")) === null, "the channel id is read from a channel payment only");
}

// The accept builder itself: where the channel accept goes, and where not.
{
  const rails = { evmCaip2: [BASE], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: PAY_TO, uptoCaip2: [], gatewayKinds: null };
  const kinds = (item, r = rails) => acceptsForItem(item, r).map((a) => a.scheme);
  ok(JSON.stringify(kinds({ slug: "uuid", price: "$0.001" })) === JSON.stringify(["exact"]), "no batchCaip2 on the rails: the accepts are exactly what they were");
  const on = { ...rails, batchCaip2: [BASE] };
  ok(JSON.stringify(kinds({ slug: "uuid", price: "$0.001" }, on)) === JSON.stringify(["exact", "batch-settlement"]), "a plain route gets the channel accept last");
  ok(!kinds({ slug: "seller-payability", price: "$0.10", spendsOwnWallet: true }, on).includes("batch-settlement"), "a lasting-effect route gets none");
  ok(!kinds({ slug: "flight-status", price: "$0.05" }, on).includes("batch-settlement"), "a listed lasting-effect slug gets none");
  ok(!kinds({ slug: "memory-read", price: "$0.001", identityBound: true }, on).includes("batch-settlement"), "an identity-bound route gets none");
  ok(!kinds({ slug: "report", price: "$1", longRunning: true }, on).includes("batch-settlement"), "a long-running report gets none");
  ok(!kinds({ slug: "x", price: "$0.001", onlyNetworks: ["eip155:10"] }, { ...on, evmCaip2: [BASE, "eip155:10"] }).includes("batch-settlement"), "a route limited to other networks gets none");
  ok(!kinds({ slug: "uuid", price: "$0.001" }, { ...on, walletAddress: null }).includes("batch-settlement"), "no EVM payTo, no channel accept");
  const ch = acceptsForItem({ slug: "uuid", price: "$0.001" }, on).find((a) => a.scheme === "batch-settlement");
  ok(ch.payTo === PAY_TO && ch.network === BASE, "the channel accept pays the treasury on its network");
}

// The work meter on media (METERED_MEDIA): embeddings report the tokens used
// through the non-enumerable sentinel only while the switch is on, and the
// meter settles that under the price. Placeholder rates from the example
// table; no upstream is reached (fetch is stubbed).
{
  process.env.UPSTREAM_COSTS_JSON = "";
  process.env.UPSTREAM_COSTS_FILE = new URL("../docs/example-upstream-costs.json", import.meta.url).pathname;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  const { EMBED_TOOLS } = await import("../src/tools/embed-kit.js");
  const { applyMeteredSettlement } = await import("../src/gateway-meter.js");
  const embed = EMBED_TOOLS.find((t) => t.slug === "embed");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 300, total_tokens: 300 } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    delete process.env.METERED_MEDIA;
    const offOut = await embed.handler({ text: "hello" });
    ok(offOut && !("__meterUpstreamUsd" in offOut), "METERED_MEDIA off: an embedding reports no usage to the meter (the buyer settles the price)");
    process.env.METERED_MEDIA = "on";
    const onOut = await embed.handler({ text: "hello" });
    ok(typeof onOut.__meterUpstreamUsd === "number" && !JSON.stringify(onOut).includes("__meter"), "METERED_MEDIA on: the usage rides the non-enumerable sentinel and never serializes");
    const headers = {};
    const res = { headersSent: false, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()] };
    let override = null;
    const upto = { header: (n) => (n === "payment-signature" ? encodePayment({ x402Version: 2, accepted: { scheme: "upto", network: BASE }, payload: {} }) : null) };
    const amount = applyMeteredSettlement({ result: onOut, req: upto, tool: embed, res, enabled: true, setOverrides: (_r, o) => { override = o; }, log: () => {} });
    const price = Number(embed.price.replace("$", ""));
    ok(Number.isFinite(amount) && amount < price && override?.amount === `$${amount.toFixed(6)}`, `an upto buyer settles the metered amount under the price ($${amount} of ${embed.price})`);
    ok(!("__meterUpstreamUsd" in onOut), "and the sentinel is gone before the body is sent");
    const exactReq = { header: (n) => (n === "payment-signature" ? encodePayment({ x402Version: 2, accepted: { scheme: "exact", network: BASE }, payload: {} }) : null) };
    const again = await embed.handler({ text: "hello" });
    override = null;
    ok(applyMeteredSettlement({ result: again, req: exactReq, tool: embed, res, enabled: true, setOverrides: (_r, o) => { override = o; }, log: () => {} }) === null && override === null, "an exact buyer is never metered: it pays the price it signed");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.METERED_MEDIA;
  }
}

// Speech and transcription report through the same switch (their upstreams
// are not reachable offline, so their wiring is read from source).
{
  const { readFileSync } = await import("node:fs");
  const tts = readFileSync(new URL("../src/tools/tts-kit.js", import.meta.url), "utf8");
  const stt = readFileSync(new URL("../src/tools/stt-kit.js", import.meta.url), "utf8");
  ok(/if \(mediaMeterEnabled\(\)\) setMeterSentinel\(out, upstreamUsd\);/.test(tts), "speech reports what was spoken to the meter only under METERED_MEDIA, through the non-enumerable sentinel");
  ok(/if \(mediaMeterEnabled\(\) && !out\?\.agent402_retried\) setMeterSentinel\(out, upstreamUsd\);/.test(stt), "transcription reports under METERED_MEDIA, never for a transcript billed twice upstream");
  // A channel sale is booked under its own wire, marked settled off chain.
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const wireFn = server.slice(server.indexOf("function x402WireOf(req) {"), server.indexOf("function recordHangupDebt("));
  ok(/if \(isBatchSettlementRequest\(req\)\) return BATCH_WIRE;/.test(wireFn), "a channel call is booked under the x402-batch wire");
  const { settlementKindOf } = await import("../src/gateway-wire.js");
  ok(settlementKindOf("x402-batch") === "offchain" && settlementKindOf("x402") === "onchain", "and that wire reads settled off chain (claimed on chain later, in a batch)");
  const hang = server.slice(server.indexOf("function recordHangupDebt("), server.indexOf("function recordHangupDebt(") + 6000);
  ok(/isBatchSettlementRequest\(req\)[\s\S]*creditHungUpBatchCall\(req, channelReceipt\)/.test(hang), "a hang-up after a channel charge credits the channel back before any owed row");
}

// ---------------------------------------------------------------------------
// Part 1: the scheme in @x402/core, as registered.
async function rig({ failSettleTypes } = {}) {
  const fac = makeEscrowFacilitator({ failSettleTypes });
  const stores = await makeBatchStores("memory");
  const scheme = newBatchScheme(PAY_TO, stores);
  const sel = await selectBatchNetworks({
    wanted: [BASE], clients: [fac.client], reads: [await fac.client.getSupported()],
    makeScheme: () => scheme, canPrice: (s, c) => s.parsePrice(0.001, c),
  });
  const server = new x402ResourceServer([fac.client]);
  for (const n of sel.networks) server.register(n.caip2, n.scheme);
  // The manual hooks src/payments.js registers before every scheme hook: a
  // buyer gone with a forgiveness ticket aborts settlement here.
  const gone = new Set();
  server.onBeforeSettle(async (ctx) => (gone.has(ctx?.paymentPayload?.payload?.voucher?.signature) ? { abort: true, reason: "client_disconnected", message: "gone" } : undefined));
  await server.initialize();
  const reqs = await server.buildPaymentRequirements({ scheme: "batch-settlement", network: BASE, payTo: PAY_TO, price: "$0.002" });
  const manager = scheme.createChannelManager(fac.client, BASE);
  return { fac, stores, scheme, sel, server, req: reqs[0], gone, manager };
}
const channelOf = (r, id) => r.stores.storage.get(id);

{
  const r = await rig();
  ok(r.sel.networks.length === 1 && r.sel.refused.length === 0, "the boot gate keeps a network whose facilitator lists the kind with a receiver authorizer");
  const req = r.req;
  ok(req.scheme === "batch-settlement" && req.amount === "2000" && req.payTo === PAY_TO, `the requirement charges the route price per call (amount ${req.amount})`);
  ok(req.extra?.receiverAuthorizer?.toLowerCase() === RECEIVER_AUTHORIZER && typeof req.extra?.withdrawDelay === "number" && req.extra?.name && req.extra?.version, "the requirement carries the facilitator's receiver authorizer, the withdraw delay and the token domain");
  console.log(`  channel accept JSON bytes: ${JSON.stringify(req).length + 1}`);

  const buyer = makeChannelBuyer();
  const id = buyer.channelIdFor(req);
  const tc = {};
  const pay = async (payload, { handlerStatus = 200, overrides } = {}) => {
    const v = await r.server.verifyPayment(payload, req, {}, tc);
    if (!v.isValid) return { verified: false, reason: v.invalidReason };
    if (handlerStatus >= 400) {
      await r.server.dispatchVerifiedPaymentCanceled(payload, req, {}, { reason: "handler_failed", responseStatus: handlerStatus }, tc);
      return { verified: true, settled: false };
    }
    try { const s = await r.server.settlePayment(payload, req, {}, tc, overrides); return { verified: true, settled: s.success, s }; }
    catch (e) { return { verified: true, settled: false, error: e?.errorReason || e?.message }; }
  };

  // Deposit + first call.
  const d = await pay(await buyer.deposit(req, 20_000));
  ok(d.settled && d.s.transaction, "the first call deposits into the channel and is served");
  let ch = await channelOf(r, id);
  ok(ch && ch.chargedCumulativeAmount === "2000" && ch.balance === "20000", `after the deposit call the channel is charged one price (${ch?.chargedCumulativeAmount}) of a 20000 deposit`);
  buyer.charged = 2000n;
  ok(r.fac.calls.filter((c) => c.op === "settle" && c.type === "deposit").length === 1, "the deposit went to the facilitator once");

  // Draw-down: three voucher calls.
  for (let i = 0; i < 3; i++) {
    const res = await pay(await buyer.voucher(req));
    if (res.settled) buyer.charged += 2000n;
  }
  ch = await channelOf(r, id);
  ok(ch.chargedCumulativeAmount === "8000", `three voucher calls draw down 2000 each (charged ${ch.chargedCumulativeAmount})`);
  ok(r.fac.calls.filter((c) => c.op === "settle" && c.type === "voucher").length === 0, "a voucher call sends nothing to the facilitator: no transaction per call");

  // Replay: the previous voucher again.
  const stale = await buyer.voucher(req, { base: buyer.charged - 2000n });
  const replay = await pay(stale);
  ch = await channelOf(r, id);
  ok(!replay.settled && ch.chargedCumulativeAmount === "8000", `a replayed voucher (old running total) is refused and charges nothing (${replay.reason || replay.error})`);

  // A failed call (handler 4xx/5xx): canceled, never charged, the lock let go.
  const failed = await pay(await buyer.voucher(req), { handlerStatus: 500 });
  ch = await channelOf(r, id);
  ok(failed.verified && !failed.settled && ch.chargedCumulativeAmount === "8000", "a call whose handler failed is not charged");
  const after = await pay(await buyer.voucher(req));
  if (after.settled) buyer.charged += 2000n;
  ok(after.settled, "the next voucher on the same base is served: a failure leaves no lock or charge behind");

  // A hang-up: the manual abort runs before the scheme commits.
  const v = await buyer.voucher(req);
  r.gone.add(v.payload.voucher.signature);
  const hung = await pay(v);
  r.gone.delete(v.payload.voucher.signature); // the buyer is back and resends
  ch = await channelOf(r, id);
  ok(!hung.settled && ch.chargedCumulativeAmount === String(buyer.charged), `a buyer gone before the answer (forgiveness abort) is not charged (charged ${ch.chargedCumulativeAmount})`);
  const resumed = await pay(await buyer.voucher(req));
  if (resumed.settled) buyer.charged += 2000n;
  ok(resumed.settled, `and its channel serves the next call at the same base (${resumed.reason || resumed.error || ""})`);

  // Concurrent draws on one channel: one admission at a time, one charge.
  const [a, b] = [await buyer.voucher(req), await buyer.voucher(req)];
  const both = await Promise.all([pay(a), pay(b)]);
  const served = both.filter((x) => x.settled).length;
  ch = await channelOf(r, id);
  buyer.charged += BigInt(served) * 2000n;
  ok(served === 1 && ch.chargedCumulativeAmount === String(buyer.charged), `two calls at once on one channel with one voucher base: one served, one refused, charged once (${served} served, charged ${ch.chargedCumulativeAmount})`);

  // Metered: the meter names less than the voucher's cap.
  const m = await pay(await buyer.voucher(req), { overrides: { amount: "$0.0012" } });
  ch = await channelOf(r, id);
  ok(m.settled && BigInt(ch.chargedCumulativeAmount) === buyer.charged + 1200n, `a metered call charges the metered amount under the signed cap (+${BigInt(ch.chargedCumulativeAmount) - buyer.charged})`);
  ok(m.s?.extra?.channelState?.chargedCumulativeAmount === ch.chargedCumulativeAmount, "the answer tells the buyer the channel's new running total");
  buyer.charged = BigInt(ch.chargedCumulativeAmount);
  const over = await pay(await buyer.voucher(req), { overrides: { amount: "$0.0030" } });
  ch = await channelOf(r, id);
  ok(!over.settled && BigInt(ch.chargedCumulativeAmount) === buyer.charged, "a metered amount above the voucher's cap is refused, nothing charged");

  // Credit back (a hang-up after the charge committed).
  const before = BigInt(ch.chargedCumulativeAmount);
  ok(await creditBatchChannel(r.stores.storage, id, "2000") === "credited", "a committed charge can be credited back to the channel");
  ch = await channelOf(r, id);
  ok(BigInt(ch.chargedCumulativeAmount) === before - 2000n, "the credit lowers the running total by the call's price");
  buyer.charged = before - 2000n;
  const corrected = await pay(await buyer.voucher(req, { base: before }));
  ok(!corrected.settled, "the buyer's voucher on the old total is refused (the corrective 402 carries the new one)");
  const fixed = await pay(await buyer.voucher(req));
  if (fixed.settled) buyer.charged += 2000n;
  ok(fixed.settled, "a voucher on the credited total is served");

  // Batch claim and settle.
  const pass1 = await runBatchPass(r.manager, { doRefund: false, log: () => {} });
  const claims = r.fac.calls.filter((c) => c.op === "settle" && c.type === "claim");
  ok(pass1.claims.length === 1 && claims.length === 1 && claims[0].payload.claims.length === 1, "one claim batch carries every charged channel's voucher");
  ok(claims[0].payload.claims[0].totalClaimed === String(buyer.charged), `the claim is for exactly the charged total (${claims[0].payload.claims[0].totalClaimed}), not the voucher's cap`);
  ok(pass1.settle && r.fac.calls.some((c) => c.op === "settle" && c.type === "settle" && c.payload.receiver === PAY_TO), "the claimed funds are settled to payTo in the same pass");
  ok(r.fac.channels.get(id).totalClaimed === buyer.charged, "the escrow's claimed total equals the charged total");
  const pass2 = await runBatchPass(r.manager, { doRefund: false, log: () => {} });
  ok(pass2.claims.length === 0 && !pass2.settle, "a second pass with nothing new claims and settles nothing");

  // Idle refund of the remainder.
  await wait(1100);
  const pass3 = await runBatchPass(r.manager, { doClaim: false, idleRefundSecs: 1, log: () => {} });
  const refund = r.fac.calls.find((c) => c.op === "settle" && c.type === "refund");
  ok(pass3.refunds.length === 1 && refund && BigInt(refund.payload.amount) === 20_000n - buyer.charged, `the idle channel's unused remainder is refunded (${refund?.payload?.amount} of 20000)`);
  ok(r.fac.channels.get(id).balance === buyer.charged, "the escrow keeps exactly what was charged");
  ok(!(await channelOf(r, id)), "a refunded channel leaves the server's store");
  ok(await creditBatchChannel(r.stores.storage, id, "1") === "no-channel", "nothing to credit on a closed channel");
}

// A hang-up after the charge committed is credited back to the channel.
{
  const stores = await makeBatchStores("memory");
  setBatchOffer({ stores });
  const cid = `0x${"ef".repeat(32)}`;
  await stores.storage.updateChannel(cid, () => ({ channelId: cid, channelConfig: {}, chargedCumulativeAmount: "6000", signedMaxClaimable: "6000", signature: "0x", balance: "9000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: Date.now() }));
  const req = { header: (n) => (n === "payment-signature" ? encodePayment({ x402Version: 2, accepted: { scheme: "batch-settlement", network: BASE }, payload: { voucher: { channelId: cid } } }) : null) };
  ok(await creditHungUpBatchCall(req, { success: true, extra: { chargedAmount: "2000" } }) === "credited", "a hung-up channel call is credited back from its settle answer");
  ok((await stores.storage.get(cid)).chargedCumulativeAmount === "4000", "by exactly the amount that call added");
  ok(await creditHungUpBatchCall(req, { success: true, extra: {} }) === "unreadable", "a settle answer without the charged amount credits nothing (booked as owed instead)");
  setBatchOffer({ stores: null });
}

// Credit math bounds.
{
  const stores = await makeBatchStores("memory");
  const cid = `0x${"cd".repeat(32)}`;
  await stores.storage.updateChannel(cid, () => ({ channelId: cid, channelConfig: {}, chargedCumulativeAmount: "5000", signedMaxClaimable: "5000", signature: "0x", balance: "9000", totalClaimed: "4000", withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: Date.now() }));
  ok(await creditBatchChannel(stores.storage, cid, "2000") === "already-claimed", "a credit below what was claimed on chain is refused (the claim already moved it)");
  ok(await creditBatchChannel(stores.storage, cid, "1000") === "credited", "a credit down to the claimed total is taken");
  ok(await creditBatchChannel(stores.storage, cid, "0") === "bad-amount" && await creditBatchChannel(stores.storage, cid, "x") === "bad-amount", "a zero or unreadable credit is refused");
}

// A claim the facilitator refuses leaves the vouchers claimable.
{
  const r = await rig({ failSettleTypes: new Set(["claim"]) });
  const buyer = makeChannelBuyer();
  const dep = await buyer.deposit(r.req, 10_000);
  const v = await r.server.verifyPayment(dep, r.req, {}, {});
  await r.server.settlePayment(dep, r.req, {}, {}).catch(() => null);
  ok(v.isValid, "deposit verified on the refusing rig");
  const out = await runBatchPass(r.manager, { doRefund: false, log: () => {} });
  ok(out.claims.length === 0 && !out.settle, "a refused claim settles nothing");
  const left = await r.manager.getClaimableVouchers();
  ok(left.length === 1, "and the voucher stays claimable for the next pass");
}

// The boot gate's refusals.
{
  const fac = makeEscrowFacilitator();
  const stores = await makeBatchStores("memory");
  const mk = () => newBatchScheme(PAY_TO, stores);
  const price = (s, c) => s.parsePrice(0.001, c);
  const none = await selectBatchNetworks({ wanted: [BASE], clients: [fac.client], reads: [{ kinds: [{ x402Version: 2, scheme: "exact", network: BASE }] }], makeScheme: mk, canPrice: price });
  ok(none.networks.length === 0 && /lists the batch-settlement kind/.test(none.refused[0]?.why), "a facilitator that does not list the kind: refused");
  const noAuth = await selectBatchNetworks({ wanted: [BASE], clients: [fac.client], reads: [{ kinds: [{ x402Version: 2, scheme: "batch-settlement", network: BASE }] }], makeScheme: mk, canPrice: price });
  ok(noAuth.networks.length === 0 && /receiverAuthorizer/.test(noAuth.refused[0]?.why), "a kind with no receiver authorizer (we hold no authorizer key): refused before @x402/core could refuse every rail");
  const floored = await selectBatchNetworks({ wanted: [BASE], clients: [fac.client], reads: [await fac.client.getSupported()], floored: () => true, makeScheme: mk, canPrice: price });
  ok(floored.networks.length === 0 && /floor/.test(floored.refused[0]?.why), "a floored network: refused");
  const prem = await selectBatchNetworks({ wanted: [BASE], clients: [fac.client], reads: [await fac.client.getSupported()], premium: () => 0.001, makeScheme: mk, canPrice: price });
  ok(prem.networks.length === 0 && /premium/.test(prem.refused[0]?.why), "a network with a settlement premium: refused");
  const unreadable = await selectBatchNetworks({ wanted: [BASE], clients: [fac.client], reads: [null], makeScheme: mk, canPrice: price });
  ok(unreadable.networks.length === 0, "an unreadable /supported offers nothing");
}

// ---------------------------------------------------------------------------
// Part 2: the real server.
const fac = makeEscrowFacilitator();
const facSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* empty */ }
    let out;
    if (req.url.startsWith("/supported")) out = fac.supported();
    else if (req.url.startsWith("/verify")) out = await fac.client.verify(parsed.paymentPayload, parsed.paymentRequirements);
    else if (req.url.startsWith("/settle")) out = await fac.client.settle(parsed.paymentPayload, parsed.paymentRequirements);
    else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => facSrv.listen(0, "127.0.0.1", r));
const facPort = facSrv.address().port;

async function boot(extra, label) {
  const env = { ...process.env };
  const blank = { STATE_DATABASE_URL: "", REDIS_URL: "" };
  delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
  const srv = await bootServer({
    stores: label,
    env: {
      ...blank,
      FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base",
      WALLET_ADDRESS: PAY_TO, FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true", INFLIGHT_COVER: "off",
      ...extra,
    },
  }).catch((e) => ({ failed: e }));
  if (srv.failed) return { child: null, base: "http://127.0.0.1:9", up: false, log: () => String(srv.failed?.message || srv.failed), stop: async () => {} };
  return { child: srv.child, base: srv.url, up: true, log: srv.log, stop: srv.stop };
}
const acceptsOf = async (base, path) => {
  const r = await fetch(`${base}${path}`);
  const h = r.headers.get("payment-required");
  return { status: r.status, accepts: h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")).accepts : [] };
};

const OP_TOKEN = `op-${process.pid}-${Date.now()}`;
const ON = { AGENT402_OPERATOR_TOKEN: OP_TOKEN, X402_BATCH_SETTLEMENT_NETWORKS: BASE, X402_BATCH_SETTLEMENT_STORE: "memory", X402_BATCH_CLAIM_INTERVAL_SECONDS: "5", X402_BATCH_REFUND_INTERVAL_SECONDS: "5", X402_BATCH_IDLE_REFUND_SECONDS: "5" };
const [off, on, noStore, floored] = await Promise.all([
  boot({}, "bs-off"),
  boot(ON, "bs-on"),
  boot({ X402_BATCH_SETTLEMENT_NETWORKS: BASE }, "bs-nostore"),
  boot({ X402_BATCH_SETTLEMENT_NETWORKS: BASE, X402_BATCH_SETTLEMENT_STORE: "memory", NETWORK_PRICE_FLOORS: `${BASE}=0.001` }, "bs-floor"),
]);
try {
  ok(off.up && on.up && noStore.up && floored.up, "four servers booted (switch off, on, on without a durable store, on over a floored network)");
  const af = await acceptsOf(floored.base, "/api/uuid");
  ok(af.status === 402 && !af.accepts.some((a) => a.scheme === "batch-settlement") && /REFUSING eip155:8453, carries a price floor/.test(floored.log()), "a floored network is refused at boot with the reason");
  const a0 = await acceptsOf(off.base, "/api/uuid");
  ok(a0.status === 402 && !a0.accepts.some((a) => a.scheme === "batch-settlement"), "switch off: no channel accept, even though the facilitator lists the kind");
  const rails0 = await (await fetch(`${off.base}/api/rails`)).json();
  ok(!("batchSettlement" in rails0), "switch off: /api/rails carries no channel field");
  const [price0, llms0, full0] = await Promise.all([fetch(`${off.base}/api/pricing`).then((r) => r.json()), fetch(`${off.base}/llms.txt`).then((r) => r.text()), fetch(`${off.base}/llms-full.txt`).then((r) => r.text())]);
  ok(!("paymentChannels" in (price0.payment || {})) && !/batch-settlement/.test(JSON.stringify(price0.payment?.acceptKinds || {})), "switch off: /api/pricing offers no channel");
  ok(!/batch-settlement/.test(llms0) && !/batch-settlement/.test(full0), "switch off: llms.txt and llms-full.txt say nothing about channels");
  const a2 = await acceptsOf(noStore.base, "/api/uuid");
  ok(!a2.accepts.some((a) => a.scheme === "batch-settlement") && /no durable store/.test(noStore.log()), "switch on without Redis or a named store: refused with the reason");

  const a1 = await acceptsOf(on.base, "/api/uuid");
  const ch = a1.accepts.find((a) => a.scheme === "batch-settlement");
  ok(!!ch && a1.accepts[a1.accepts.length - 1] === ch, "switch on: the channel accept is offered, last in the list");
  const ex = a1.accepts.find((a) => a.scheme === "exact");
  ok(ch && ex && ch.amount === ex.amount && ch.payTo === ex.payTo && ch.asset === ex.asset, "at the exact accept's amount, payTo and asset");
  ok(JSON.stringify(a1.accepts.filter((a) => a.scheme !== "batch-settlement")) === JSON.stringify(a0.accepts), "every other accept is byte-identical to the switch-off 402");
  ok(JSON.stringify(ch).length + 1 <= BATCH_ACCEPT_JSON_BYTES, `the live channel accept (${JSON.stringify(ch).length + 1} bytes with its comma) fits the budget charged for it (${BATCH_ACCEPT_JSON_BYTES})`);
  const memAccepts = (await acceptsOf(on.base, "/api/memory/read")).accepts;
  ok(!memAccepts.some((a) => a.scheme === "batch-settlement"), "an identity-bound route offers no channel accept");
  const lasting = await (async () => { const r = await fetch(`${on.base}/api/seller-payability`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const h = r.headers.get("payment-required"); return { status: r.status, accepts: h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")).accepts : [] }; })();
  ok(lasting.status === 402 && lasting.accepts.length > 0 && !lasting.accepts.some((a) => a.scheme === "batch-settlement"), "a route whose effect outlives the answer offers no channel accept");
  const rails1 = await (await fetch(`${on.base}/api/rails`)).json();
  ok(rails1.batchSettlement?.status === "offered" && rails1.batchSettlement.networks.includes(BASE), "/api/rails reports the channel offer while on");

  const [price1, llms1] = await Promise.all([fetch(`${on.base}/api/pricing`).then((r) => r.json()), fetch(`${on.base}/llms.txt`).then((r) => r.text())]);
  ok(price1.payment?.paymentChannels?.networks?.includes(BASE) && price1.payment?.acceptKinds?.base?.includes("batch-settlement"), "switch on: /api/pricing names the channel offer and its accept kind");
  ok(/x402 `batch-settlement`/.test(llms1) && /charged to the channel only on its final 200/.test(llms1), "switch on: llms.txt describes channels from the live offer");
  const [price2, llms2] = await Promise.all([fetch(`${noStore.base}/api/pricing`).then((r) => r.json()), fetch(`${noStore.base}/llms.txt`).then((r) => r.text())]);
  ok(!("paymentChannels" in (price2.payment || {})) && !/batch-settlement/.test(llms2), "a refused offer says nothing about channels either");

  // Paid calls end to end.
  const buyer = makeChannelBuyer();
  const call = async (payload, path = "/api/uuid") => {
    const r = await fetch(`${on.base}${path}`, { headers: { "payment-signature": encodePayment(payload) } });
    const resp = r.headers.get("payment-response");
    let settle = null;
    try { settle = resp ? JSON.parse(Buffer.from(resp, "base64").toString("utf8")) : null; } catch { /* none */ }
    await r.arrayBuffer().catch(() => null);
    return { status: r.status, settle };
  };
  const first = await call(await buyer.deposit(ch, Number(ch.amount) * 10));
  ok(first.status === 200 && first.settle?.success === true, `deposit call served over the channel (${first.status})`);
  buyer.charged = BigInt(ch.amount);
  let last = first;
  for (let i = 0; i < 3; i++) {
    last = await call(await buyer.voucher(ch));
    if (last.status === 200) buyer.charged += BigInt(ch.amount);
  }
  ok(last.status === 200 && last.settle?.extra?.channelState?.chargedCumulativeAmount === String(buyer.charged), `three voucher calls served; the answer carries the running total (${last.settle?.extra?.channelState?.chargedCumulativeAmount})`);
  const replay = await call(await buyer.voucher(ch, { base: buyer.charged - BigInt(ch.amount) }));
  // A voucher is a deterministic signature, so the replay is the earlier
  // header byte for byte: the replay guard answers 409 before verify, or the
  // scheme answers 402 with the channel's total. Either way nothing runs.
  ok(replay.status === 402 || replay.status === 409, `a replayed voucher is refused (${replay.status})`);
  const bad = await call(await buyer.voucher(ch), "/api/uuid?version=9");
  ok(bad.status >= 400 && bad.status !== 402 ? true : bad.status >= 400, `a call the tool refuses is not served (${bad.status})`);
  const next = await call(await buyer.voucher(ch));
  ok(next.status === 200, "the next voucher on the same total is served: the refused call charged nothing");
  if (next.status === 200) buyer.charged += BigInt(ch.amount);
  ok(fac.calls.filter((c) => c.op === "settle" && c.type === "voucher").length === 0, "no voucher reached the facilitator: no transaction per call");

  // Each served call is booked once, as an off-chain channel sale.
  await wait(1500);
  const sales = await (await fetch(`${on.base}/__operator/sales.json`, { headers: { "x-operator-token": OP_TOKEN } })).json();
  const servedCalls = Number(buyer.charged / BigInt(ch.amount));
  ok(sales?.totals?.external?.sales === servedCalls && Math.abs(sales.totals.external.revenueUsd - servedCalls * Number(ch.amount) / 1e6) < 1e-9 && sales.distinctExternalBuyers === 1,
    `every served channel call is booked once at its price, the refused ones never (${sales?.totals?.external?.sales} sales for ${servedCalls} served)`);

  // The claim and the idle refund run on the server's own timers.
  let claimed = false, refunded = false;
  for (let i = 0; i < 60 && !(claimed && refunded); i++) {
    await wait(500);
    claimed = fac.calls.some((c) => c.op === "settle" && c.type === "claim");
    refunded = fac.calls.some((c) => c.op === "settle" && c.type === "refund");
  }
  const claim = fac.calls.find((c) => c.op === "settle" && c.type === "claim");
  ok(claimed && claim.payload.claims.some((c) => c.totalClaimed === String(buyer.charged)), `the server claims the charged total in a batch (${claim?.payload?.claims?.map((c) => c.totalClaimed)})`);
  ok(refunded, "and refunds the idle channel's remainder");
  const id = buyer.channelIdFor(ch);
  ok(fac.channels.get(id)?.balance === buyer.charged && fac.channels.get(id)?.totalClaimed === buyer.charged, "the escrow ends holding exactly what was charged, all of it claimed");
  ok(fac.calls.some((c) => c.op === "settle" && c.type === "settle"), "the claimed funds are settled to payTo");
} finally {
  await Promise.all([off, on, noStore, floored].map((s) => s.stop().catch(() => {})));
  facSrv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
