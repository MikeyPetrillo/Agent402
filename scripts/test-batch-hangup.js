#!/usr/bin/env node
// A hung-up x402 payment-channel (batch-settlement) call keeps its charge
// unless the hang-up forgiveness rule had already decided not to charge it.
//
//   node scripts/test-batch-hangup.js
//
// The channel credit is the channel's form of "not settled": it may stand in
// for a forgiven hang-up and for nothing else. Every other rail leaves a
// hang-up uncharged only on a GRANTED forgiveness ticket
// (src/hangup-forgiveness.js) and books every other undelivered charge as
// owed; a channel credit taken on any hang-up would let one deposit buy
// unlimited abandoned runs. So:
//   - a granted ticket, a close before the first byte (the close landed
//     inside the settle call) and a route whose effect does not outlive the
//     answer: the charge goes back to the channel, once;
//   - a ticket denied on a spent budget, for a lasting effect, switched off,
//     no ticket at all, or a connector that stopped waiting for an answer
//     written in full: the channel keeps the charge and the call is booked as
//     owed under evidence unique to the request;
//   - a second hang-up booking of the same request credits nothing and books
//     nothing new.
// Part 1 drives src/batch-settlement.js hungUpBatchCall with real tickets
// and a real channel store, and pins its one caller in src/server.js. Part 2
// boots the real server with channels on (and one with them off) against a
// stub escrow facilitator and closes the socket at chosen moments: a close
// mid-run once the IP's budget is spent (the charge stays and is owed), and
// a close during the deposit's settle call on a granted ticket (credited
// once, nothing owed). Nothing leaves the machine.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";
import { makeEscrowFacilitator, makeChannelBuyer, encodePayment, BASE } from "./lib/batch-channel-rig.js";

process.env.SHARED_LIMITS = "off";
process.env.HANGUP_FORGIVE_FILE = "off";
for (const k of ["HANGUP_FORGIVE", "HANGUP_FORGIVE_KEY_USD", "HANGUP_FORGIVE_GLOBAL_USD", "HANGUP_FORGIVE_WINDOW_MS"]) delete process.env[k];

const bs = await import("../src/batch-settlement.js");
const { makeBatchStores, setBatchOffer, BATCH_WIRE } = bs;
const hungUpBatchCall = bs.hungUpBatchCall;
const { reserveHangupForgiveness, settleHangupTicket, hangupForgiven, hangupTicketDenial, defHasLastingEffect, _resetHangupForgiveness } = await import("../src/hangup-forgiveness.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); } return Boolean(await cond()); };

// ---------------------------------------------------------------------------
// Part 1: the decision, with real tickets and a real channel store.
{
  ok(typeof hungUpBatchCall === "function", "src/batch-settlement.js decides a channel hang-up in one place (hungUpBatchCall)");
  if (typeof hungUpBatchCall === "function") try {
    const stores = await makeBatchStores("memory");
    setBatchOffer({ stores });
    let seq = 0;
    const channel = async ({ charged = "6000", claimed = "0" } = {}) => {
      const cid = `0x${(++seq).toString(16).padStart(64, "0")}`;
      await stores.storage.updateChannel(cid, () => ({ channelId: cid, channelConfig: {}, chargedCumulativeAmount: charged, signedMaxClaimable: charged, signature: "0x", balance: "90000", totalClaimed: claimed, withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: Date.now() }));
      return cid;
    };
    const reqOn = (cid) => ({ header: (n) => (n === "payment-signature" ? encodePayment({ x402Version: 2, accepted: { scheme: "batch-settlement", network: BASE }, payload: { voucher: { channelId: cid } } }) : null) });
    const chargedOf = async (cid) => (await stores.storage.get(cid))?.chargedCumulativeAmount;
    const receipt = { success: true, extra: { chargedAmount: "2000" } };
    const ROW = { network: BASE, payer: "0xabc", priceUsd: 0.002 };
    const refusedLog = [];
    const decide = (req, o = {}) => hungUpBatchCall(req, receipt, { row: ROW, onCreditRefused: (row, how) => refusedLog.push({ row, how }), ...o });
    const ticket = (req, { ip, priceUsd = 0.002, slug = "uuid", spendsOwnWallet = false } = {}) => reserveHangupForgiveness(req, { keys: [`ip:${ip}`], priceUsd, slug, spendsOwnWallet });

    // A granted ticket on an ordinary route, the close before the first byte:
    // credited back to the channel, exactly once.
    _resetHangupForgiveness();
    process.env.HANGUP_FORGIVE_KEY_USD = "0.003"; process.env.HANGUP_FORGIVE_GLOBAL_USD = "1";
    {
      const cid = await channel();
      const req = reqOn(cid);
      ticket(req, { ip: "10.1.0.1" });
      ok(hangupForgiven(req), "CONTROL: an ordinary route inside the IP's budget holds a granted ticket");
      const a = decide(req, { forgiven: hangupForgiven(req), lastingEffect: false, reason: null });
      ok(a.credited === true && !a.row, "a granted ticket, a close before the first byte, an ordinary route: the charge goes back to the channel");
      ok(await a.outcome === "credited" && await chargedOf(cid) === "4000", `by exactly the call's charge (6000 -> ${await chargedOf(cid)})`);
      const b = decide(req, { forgiven: true, lastingEffect: false, reason: null });
      await b.outcome;
      await sleep(20);
      ok(b === a && await chargedOf(cid) === "4000" && refusedLog.length === 0, `a second hang-up booking of the same request credits nothing more (${await chargedOf(cid)})`);
      const c = decide(req, { forgiven: false, lastingEffect: false, reason: "connector stopped waiting" });
      ok(c === a && !c.row && await chargedOf(cid) === "4000", "nor turns the credited request into an owed row");
    }

    // The IP's budget is spent by an abandoned run: the next hang-up from the
    // same IP is denied, and its channel keeps the charge, booked as owed.
    {
      const first = reqOn(await channel());
      ticket(first, { ip: "10.1.0.2" });
      ok(hangupForgiven(first), "CONTROL: the IP's first hang-up is granted");
      settleHangupTicket(first, { abandoned: true });
      const cid = await channel();
      const req = reqOn(cid);
      ticket(req, { ip: "10.1.0.2" });
      ok(!hangupForgiven(req) && hangupTicketDenial(req) === "ip budget", `the next run from that IP is denied (${hangupTicketDenial(req)})`);
      const a = decide(req, { forgiven: hangupForgiven(req), lastingEffect: false, reason: null });
      await sleep(20);
      ok(!a.credited && a.row && await chargedOf(cid) === "6000", `an out-of-budget hang-up keeps the charge on the channel (${await chargedOf(cid)})`);
      ok(a.row?.wire === BATCH_WIRE && /^batch-hangup:[0-9a-f-]{36}$/.test(a.row?.tx) && a.row?.network === BASE && a.row?.payer === "0xabc" && a.row?.priceUsd === 0.002, `and is handed back as an owed row on the channel wire with evidence unique to the request (${a.row?.tx})`);
      const again = decide(req, { forgiven: hangupForgiven(req), lastingEffect: false, reason: null });
      ok(again === a && !!a.row && again.row?.tx === a.row?.tx, "a second booking of the same request answers the same row (one ledger row by its evidence)");
      const other = decide(reqOn(cid), { forgiven: false, lastingEffect: false, reason: null });
      ok(!!other.row?.tx && other.row?.tx !== a.row?.tx, "another request on the same channel gets evidence of its own");
    }

    // A route whose effect outlives the answer: denied by slug, and kept even
    // where a ticket was granted (a def that pays an outside seller).
    {
      const cid = await channel();
      const req = reqOn(cid);
      ticket(req, { ip: "10.1.0.3", slug: "attest" });
      ok(hangupTicketDenial(req) === "lasting effect", `CONTROL: a lasting-effect slug's ticket is denied (${hangupTicketDenial(req)})`);
      const a = decide(req, { forgiven: hangupForgiven(req), lastingEffect: defHasLastingEffect({ slug: "attest" }), reason: null });
      await sleep(20);
      ok(!a.credited && a.row && await chargedOf(cid) === "6000", "a lasting-effect route keeps the charge on the channel");
      const cid2 = await channel();
      const req2 = reqOn(cid2);
      ticket(req2, { ip: "10.1.0.4", slug: "some-seller-route" });
      ok(hangupForgiven(req2) && defHasLastingEffect({ slug: "some-seller-route", paysThirdPartySeller: true }), "CONTROL: a route paying an outside seller can hold a granted ticket");
      const b = decide(req2, { forgiven: true, lastingEffect: defHasLastingEffect({ slug: "some-seller-route", paysThirdPartySeller: true }), reason: null });
      await sleep(20);
      ok(!b.credited && b.row && await chargedOf(cid2) === "6000", "a granted ticket on a route whose effect outlives the answer still keeps the charge");
    }

    // No ticket, forgiveness switched off, a connector that stopped waiting.
    {
      const cid = await channel();
      const a = decide(reqOn(cid), { forgiven: hangupForgiven(reqOn(cid)), lastingEffect: false, reason: null });
      process.env.HANGUP_FORGIVE = "off";
      const cid2 = await channel();
      const req2 = reqOn(cid2);
      ticket(req2, { ip: "10.1.0.5" });
      delete process.env.HANGUP_FORGIVE;
      const b = decide(req2, { forgiven: hangupForgiven(req2), lastingEffect: false, reason: null });
      const cid3 = await channel();
      const req3 = reqOn(cid3);
      ticket(req3, { ip: "10.1.0.6" });
      const c = decide(req3, { forgiven: hangupForgiven(req3), lastingEffect: false, reason: "connector stopped waiting" });
      await sleep(20);
      ok(!a.credited && a.row && await chargedOf(cid) === "6000", "a request that never took a ticket keeps the charge");
      ok(hangupTicketDenial(req2) === "disabled" && !b.credited && b.row && await chargedOf(cid2) === "6000", "forgiveness switched off keeps the charge");
      ok(hangupForgiven(req3) && !c.credited && c.row && await chargedOf(cid3) === "6000", "a granted ticket whose answer was written in full to a connector that stopped waiting keeps the charge (its stored answer is restated as charged instead)");
    }

    // A credit the channel cannot take (already claimed on chain) is handed
    // to the caller once, to be booked as owed.
    {
      const cid = await channel({ charged: "5000", claimed: "4000" });
      const req = reqOn(cid);
      ticket(req, { ip: "10.1.0.7" });
      const a = decide(req, { forgiven: hangupForgiven(req), lastingEffect: false, reason: null });
      ok(await a.outcome === "already-claimed" && refusedLog.length === 1 && refusedLog[0]?.how === "already-claimed" && /^batch-hangup:/.test(refusedLog[0]?.row?.tx) && refusedLog[0]?.row?.wire === BATCH_WIRE, `a credit below the claimed total is refused and handed back once to be booked as owed (${refusedLog.map((r) => r.how)})`);
      decide(req, { forgiven: true, lastingEffect: false, reason: null });
      await sleep(20);
      ok(refusedLog.length === 1 && await chargedOf(cid) === "5000", "and a second booking hands nothing more back");
    }
  } catch (e) {
    fail++;
    console.error(`FAIL - Part 1 threw: ${e?.stack || e}`);
  } finally {
    setBatchOffer({ stores: null });
    _resetHangupForgiveness();
    delete process.env.HANGUP_FORGIVE_KEY_USD; delete process.env.HANGUP_FORGIVE_GLOBAL_USD;
  }
}

// The one caller: src/server.js books a channel hang-up only through
// hungUpBatchCall, with the request's ticket, the route's lasting effect and
// the booking's reason, and credits a channel nowhere else.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = server.indexOf("function recordHangupDebt(");
  const branch = server.slice(server.indexOf("isBatchSettlementRequest(req)) {", start), server.indexOf("} else if (settleReceipt) {", start));
  ok(/hungUpBatchCall\(req, channelReceipt, \{[\s\S]*forgiven: hangupForgiven\(req\),[\s\S]*lastingEffect: defHasLastingEffect\(def\),[\s\S]*reason,/.test(branch), "recordHangupDebt's channel branch decides with the request's ticket, the route's lasting effect and the booking's reason");
  ok(/if \(hung\.credited\) return hung;\s*row = hung\.row;/.test(branch), "and books every hang-up it does not credit through the common owed path");
  ok(!/creditHungUpBatchCall|creditBatchChannel/.test(server), "src/server.js credits a channel nowhere else");
}

// ---------------------------------------------------------------------------
// Part 2: the real server.
const kitSrc = readFileSync(new URL("../src/tools/kit.js", import.meta.url), "utf8");
const priceUsd = Number(/route: "GET \/api\/uuid",[\s\S]{0,600}?price: "\$([0-9.]+)"/.exec(kitSrc)?.[1]);
ok(priceUsd > 0, `read the uuid route's price from its kit ($${priceUsd})`);
const PRICE = BigInt(Math.round(priceUsd * 1e6));

// The escrow stub, served over HTTP. A deposit's settle can be held, so a test
// can close the buyer's socket while the settle call is in flight.
const fac = makeEscrowFacilitator();
let holdDepositSettle = null; // { arrived: resolve, release: Promise }
const facSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* empty */ }
    let out;
    if (req.url.startsWith("/supported")) out = fac.supported();
    else if (req.url.startsWith("/verify")) out = await fac.client.verify(parsed.paymentPayload, parsed.paymentRequirements);
    else if (req.url.startsWith("/settle")) {
      if (parsed.paymentPayload?.payload?.type === "deposit" && holdDepositSettle) {
        const h = holdDepositSettle;
        holdDepositSettle = null;
        h.arrived();
        await h.release;
      }
      out = await fac.client.settle(parsed.paymentPayload, parsed.paymentRequirements);
    } else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => facSrv.listen(0, "127.0.0.1", r));
const facPort = facSrv.address().port;

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OP_TOKEN = `op-${process.pid}-${Date.now()}`;
const env = (extra) => ({
  STATE_DATABASE_URL: "", REDIS_URL: "", SHARED_LIMITS: "off",
  FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base",
  WALLET_ADDRESS: PAY_TO, FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
  FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
  FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true", INFLIGHT_COVER: "off",
  LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
  TRUST_PROXY_HOPS: "1", AGENT402_OPERATOR_TOKEN: OP_TOKEN, HANGUP_TEST_HOLD_JSON: "1",
  // One call's price fits an IP's budget and two do not; the service's budget
  // stays far above anything this run spends.
  HANGUP_FORGIVE: "", HANGUP_FORGIVE_KEY_USD: String(priceUsd * 1.5), HANGUP_FORGIVE_GLOBAL_USD: String(priceUsd * 50),
  HANGUP_FORGIVE_WINDOW_MS: "86400000", HANGUP_FORGIVE_SALT: "batch-hangup-test-salt",
  // The claim and idle-refund timers stay out of this run.
  X402_BATCH_CLAIM_INTERVAL_SECONDS: "3600", X402_BATCH_REFUND_INTERVAL_SECONDS: "3600", X402_BATCH_IDLE_REFUND_SECONDS: "3600",
  ...extra,
});
const args = ["--import", "./scripts/lib/hold-json-preload.js"];
const [on, off] = await Promise.all([
  bootServer({ stores: "bh-on", args, env: env({ X402_BATCH_SETTLEMENT_NETWORKS: BASE, X402_BATCH_SETTLEMENT_STORE: "memory" }) }),
  bootServer({ stores: "bh-off", args, env: env({ X402_BATCH_SETTLEMENT_NETWORKS: "" }) }),
]);

// A request whose socket is destroyed when `abortWhen` resolves, before any reply.
const hangUp = (url, headers, abortWhen) => new Promise((resolve) => {
  const req = httpRequest(url, { method: "GET", headers });
  let done = false;
  const finish = (how) => { if (!done) { done = true; resolve(how); } };
  req.on("error", () => finish("closed"));
  req.on("response", (r) => { r.resume(); finish(`answered ${r.statusCode}`); });
  req.end();
  abortWhen.then(() => { req.destroy(); finish("closed"); });
});
const holdLines = (srv) => (srv.log().match(/\[hold-json\] holding GET \/api\/uuid/g) || []).length;
const refunds = async () => (await (await fetch(`${on.url}/__operator/refunds.json?status=all`, { headers: { "x-operator-token": OP_TOKEN } })).json()).refunds || [];
const channelRows = async () => (await refunds()).filter((r) => r.wire === BATCH_WIRE);

try {
  const r402 = await fetch(`${on.url}/api/uuid`);
  const accepts = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString("utf8")).accepts;
  const ch = accepts.find((a) => a.scheme === "batch-settlement");
  ok(!!ch && BigInt(ch.amount) === PRICE, `the switch-on server offers the channel accept at the route's price (${ch?.amount})`);
  const call = async (payload, ip, extra = {}) => {
    const r = await fetch(`${on.url}/api/uuid`, { headers: { "payment-signature": encodePayment(payload), "x-forwarded-for": ip, ...extra } });
    await r.arrayBuffer().catch(() => null);
    return r.status;
  };
  // Close once the handler has run and its answer is held: before the first
  // byte, and before any settlement point.
  const hangUpMidRun = async (payload, ip) => {
    const n = holdLines(on);
    return hangUp(`${on.url}/api/uuid`, { "payment-signature": encodePayment(payload), "x-forwarded-for": ip, "x-test-hold-json-ms": "1500" }, until(() => holdLines(on) > n).then(() => sleep(50)));
  };

  // a. The IP's budget is spent by a forgiven hang-up; the next hang-up from
  //    it keeps its charge on the channel and is booked as owed.
  const IP_A = "10.77.0.1";
  const spender = makeChannelBuyer();
  ok(await call(await spender.deposit(ch, Number(PRICE) * 10), IP_A) === 200, "a. CONTROL: a connected deposit call is served");
  spender.charged = PRICE;
  const withheld0 = (on.log().match(/SETTLE WITHHELD/g) || []).length;
  await hangUpMidRun(await spender.voucher(ch), IP_A);
  ok(await until(() => (on.log().match(/SETTLE WITHHELD/g) || []).length > withheld0) && /within the hang-up forgiveness budget/.test(on.log()), "a. CONTROL: the IP's first hang-up is forgiven and not settled (its budget is now spent)");
  ok((await channelRows()).length === 0, "a. CONTROL: a forgiven hang-up books nothing");
  const buyer = makeChannelBuyer();
  ok(await call(await buyer.deposit(ch, Number(PRICE) * 10), IP_A) === 200, "a. a second channel buyer behind the same IP opens its channel");
  buyer.charged = PRICE;
  await hangUpMidRun(await buyer.voucher(ch), IP_A);
  ok(await until(async () => (await channelRows()).length >= 1), "a. its hang-up past the IP's budget is booked as owed");
  const rows = await channelRows();
  ok(rows.length === 1 && rows[0].slug === "uuid" && rows[0].hangupReason === "ip budget" && Number(rows[0].httpStatus) === 499 && /^batch-hangup:/.test(String(rows[0].evidence ?? rows[0].tx ?? "")), `a. one owed row on the channel wire, naming the spent IP budget (${JSON.stringify(rows.map((r) => ({ reason: r.hangupReason, status: r.status, ev: r.evidence ?? r.tx })))})`);
  buyer.charged += PRICE;
  ok(await call(await buyer.voucher(ch), "10.77.0.9") === 200, "a. the channel kept the charge: the buyer's next voucher on the higher total is served");
  buyer.charged += PRICE;
  await sleep(300);
  ok((await channelRows()).length === 1, "a. and nothing else was booked");

  // b. A close during the deposit's settle call on a granted ticket: the
  //    forgiveness rule had decided not to charge, so the channel is
  //    credited once and nothing is owed.
  const IP_B = "10.77.0.2";
  const late = makeChannelBuyer();
  let release;
  const arrived = new Promise((resolve) => { holdDepositSettle = { arrived: resolve, release: new Promise((r) => { release = r; }) }; });
  const creditLines0 = (on.log().match(/\[batch\] hang-up on uuid: the charge is given back to the channel/g) || []).length;
  const closed = hangUp(`${on.url}/api/uuid`, { "payment-signature": encodePayment(await late.deposit(ch, Number(PRICE) * 10)), "x-forwarded-for": IP_B }, arrived.then(() => sleep(50)));
  await closed;
  await sleep(100);
  release();
  ok(await until(() => (on.log().match(/\[batch\] hang-up on uuid: the charge is given back to the channel/g) || []).length > creditLines0), "b. a close inside the deposit's settle call on a granted ticket gives the charge back to the channel");
  ok(fac.channels.get(late.channelIdFor(ch))?.balance === PRICE * 10n, "b. CONTROL: the deposit itself landed in the escrow");
  await sleep(300);
  ok((await channelRows()).length === 1, "b. nothing is owed for it");
  late.charged = PRICE;
  const stale = await call(await late.voucher(ch), "10.77.0.9");
  ok(stale !== 200, `b. the credited channel refuses a voucher on the uncredited total (${stale})`);
  ok((on.log().match(/\[batch\] hang-up on uuid: the charge is given back to the channel/g) || []).length === creditLines0 + 1 && !/channel credit not taken/.test(on.log()), "b. credited exactly once");

  // c. Channels off: a channel payment is never accepted, so no hang-up can
  //    reach the channel branch; the 402 carries no channel accept.
  const a0 = JSON.parse(Buffer.from((await fetch(`${off.url}/api/uuid`)).headers.get("payment-required"), "base64").toString("utf8")).accepts;
  ok(!a0.some((a) => a.scheme === "batch-settlement") && JSON.stringify(a0) === JSON.stringify(accepts.filter((a) => a.scheme !== "batch-settlement")), "c. switch off: the 402 is the switch-on 402 without the channel accept");
  const settles0 = fac.calls.filter((c) => c.op === "settle").length;
  const offBuyer = makeChannelBuyer();
  const r = await fetch(`${off.url}/api/uuid`, { headers: { "payment-signature": encodePayment(await offBuyer.deposit(ch, Number(PRICE) * 10)), "x-forwarded-for": "10.77.0.3" } });
  await r.arrayBuffer().catch(() => null);
  ok(r.status === 402 && !r.headers.get("payment-response") && fac.calls.filter((c) => c.op === "settle").length === settles0, `c. switch off: a channel payment is refused unsettled (${r.status}), so the hang-up path never sees a channel charge`);
} catch (e) {
  fail++;
  console.error(`FAIL - ${e?.stack || e}`);
} finally {
  if (fail) console.error(on.log().split("\n").filter((l) => /\[hangup\]|\[batch\]|batch-settlement|hold-json/.test(l)).slice(-30).join("\n"));
  await Promise.all([on.stop(), off.stop()]);
  facSrv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
