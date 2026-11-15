#!/usr/bin/env node
// The referral gate (src/referral-gate.js, src/referral-settle.js,
// src/referral-chain.js, src/referral-book.js): copies of paid routes under
// /ref/<slug> whose 402 pays a referral network's split contract and which
// settle through that network's facilitator.
//
//   node scripts/test-referral-gate.js
//   REFERRAL_TEST_PART=1 node scripts/test-referral-gate.js   (the in-process part only)
//
// Part 1 runs the gate in this process against stub tools, a stub
// facilitator and a stub chain: the 402's exact shape, the local money
// checks, one run per authorization (held once the handler has started), the
// deadline that ends upstream work, hang-up forgiveness, the unsettled-run
// lane, settlements in doubt read from the chain, the answer kept for a
// re-send, the durable book and its sweep, the signed facilitator request and
// the net booking no public ledger reader returns. Part 2 boots the real
// server in paid mode: the same amounts off the direct routes' own 402s, the
// real chat handler paid through the gate against a local stand-in for the
// model upstream (and cut off at the deadline), the wiring of every limiter
// twin, isolation from the direct routes' breaker, the payer screen, the
// public surfaces, and a kill in the middle of a settle. No payment leaves
// this machine: every key is made here and every upstream is local.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express from "express";
import { recoverMessageAddress, keccak256, concat, stringToHex, numberToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootPaidServer } from "./lib/paid-boot.js";
import { bootServer } from "./lib/boot-server.js";

const tmp = mkdtempSync(join(tmpdir(), "a402-referral-"));
process.env.SALES_LEDGER_DB = join(tmp, "sales.db");
process.env.HANGUP_FORGIVE_FILE = join(tmp, "hangup.json");
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const ONLY_PART = process.env.REFERRAL_TEST_PART || "";

const gateMod = await import("../src/referral-gate.js");
const { referralConfig, referralConfigProblem, referralRoutes, referralIneligibility, referralSlugOfPath, isCanonicalReferralPath, createReferralGate, referralNet, baseUnitsOf, checkReferralPayment, parseCommissionBps, commissionBpsFor, isLocalReceiveSignature, createLineSampler, REFERRAL_ASSET, REFERRAL_NETWORK, REFERRAL_REASONS } = gateMod;
const { createReferralSettler, referralRequestDigest } = await import("../src/referral-settle.js");
const { createReferralChainReader, chainVerdict, receiptProvesPayment, proveReceipt } = await import("../src/referral-chain.js");
const { createReferralBook } = await import("../src/referral-book.js");
const { createReferralAnswerStore } = await import("../src/referral-answers.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { createReplayGuard } = await import("../src/replay-guard.js");
const ledger = await import("../src/sales-ledger.js");
const { PAYING_RAILS, PRIVATE_RAILS } = await import("../src/paid-rails.js");
const { priceForNetwork } = await import("../src/payments.js");
const hangupMod = await import("../src/hangup-forgiveness.js");
const { presentRunWindow, evmCredentialSettleableMs } = await import("../src/evm-validity.js");
const { withBudgetCeiling, underBudget, currentBudget } = await import("../src/upstream-deadline.js");
const { settleBreakerOtherLane, gatewaySettleBreakerCheck } = await import("../src/gateway-settle-breaker.js");
const { runAsCallerOf, currentDispatchCaller } = await import("../src/dispatch-caller.js");
const { inReferralRun, routeHint, runAsReferral } = await import("../src/referral-run.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- keys made here, never funded ---------------------------------------------
const SIGNER_KEY = generatePrivateKey();
const signer = privateKeyToAccount(SIGNER_KEY);
const newAccount = () => privateKeyToAccount(generatePrivateKey());
const buyer = newAccount();
const PAY_TO = newAccount().address; // stands in for the split contract
const OUR_WALLET = "0x000000000000000000000000000000000000dEaD";
// This merchant on the split contract: a synthetic id, and the wallet its merchant amount is paid to.
const MERCHANT_ID = "4242";
const PAYOUT = newAccount().address;
const ROUTED_TOPIC = keccak256(stringToHex("PaymentRouted(uint256,uint256,uint256,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)"));
const KEY_HEX = SIGNER_KEY.slice(2).toLowerCase();

// --- a stub facilitator and a stub chain ---------------------------------------
// /verify and /settle record every request with the exact bytes received and
// the address its signature recovers to; /rpc answers authorizationState and
// the AuthorizationUsed log from what the test says has landed.
function stubFacilitator() {
  const calls = [];
  let txSeq = 0;
  const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
  // The chain, modelled on the token's real event order: a receive is
  // AuthorizationUsed(from, nonce) followed DIRECTLY by Transfer(from, to, value)
  // in the receipt of a transaction sent to the pay-to (split) contract.
  //   used:     "from|nonce" -> { tx, block, canceled }
  //   receipts: tx -> receipt { transactionHash, status, to, logs:[{address, topics, data, logIndex, blockNumber}] }
  const used = new Map();
  const receipts = new Map();
  const keyOf = (from, nonce) => `${String(from).toLowerCase()}|${String(nonce).toLowerCase()}`;
  const USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
  const CANCELED_TOPIC = keccak256(stringToHex("AuthorizationCanceled(address,bytes32)"));
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a) => `0x${"0".repeat(24)}${String(a).slice(2).toLowerCase()}`;
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const usedLog = (auth, i, block, token = REFERRAL_ASSET) => ({ address: token, topics: [USED_TOPIC, pad(auth.from), String(auth.nonce).toLowerCase()], data: "0x", logIndex: hex(i), blockNumber: hex(block) });
  const transferLog = (from, to, value, i, block, token = REFERRAL_ASSET) => ({ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: `0x${BigInt(value).toString(16).padStart(64, "0")}`, logIndex: hex(i), blockNumber: hex(block) });
  const w32 = (n) => BigInt(n).toString(16).padStart(64, "0");
  /** The split contract's routed-payment log, as documented: three indexed ids, nine data words. */
  const routedLog = ({ router, buyer, merchantId, gross, merchantAmt, words = 9 }, i, block) => ({
    address: router, topics: [ROUTED_TOPIC, `0x${w32(77)}`, `0x${w32(0)}`, `0x${w32(0)}`],
    data: `0x${[pad(buyer).slice(2), w32(merchantId), w32(0), w32(gross), w32(0), w32(0), w32(0), w32(0), w32(merchantAmt)].slice(0, words).join("")}`,
    logIndex: hex(i), blockNumber: hex(block),
  });
  const seenSigned = new Set();
  const chainState = { head: 0x100000 };
  const rpcCalls = [];
  // Receipt-shaped landings, one authorization each.
  //   paid        its own Transfer of the amount to the pay-to address
  //   elsewhere   its Transfer goes to another address
  //   short       its Transfer is one unit under the amount
  //   selftransfer its Transfer is a zero-value transfer to the payer itself
  //   othertoken  the Transfer beside it is of another token
  //   otherpayer  the Transfer is from another wallet
  //   reverted    the receipt's status is failure
  //   notpayto    the transaction was sent to the token, not the split contract
  //   wrongtx     the receipt answers for another transaction hash
  //   cancel      the buyer canceled the authorization (no transaction of ours)
  //   nolog       spent, and no log of either kind anywhere
  function land(auth, tx = null, kind = "paid", { block = chainState.head, payTo = auth.to, bps = 1234n } = {}) {
    const t = String(tx || "0x" + createHash("sha256").update(`${keyOf(auth.from, auth.nonce)}|${kind}|${Math.random()}`).digest("hex")).toLowerCase();
    used.set(keyOf(auth.from, auth.nonce), { tx: t, block, canceled: kind === "cancel", nolog: kind === "nolog" });
    if (kind === "cancel" || kind === "nolog") return t;
    const OTHER = "0x" + "7".repeat(40);
    const to = kind === "elsewhere" ? OTHER : kind === "selftransfer" ? auth.from : payTo;
    const from = kind === "otherpayer" ? "0x" + "6".repeat(40) : auth.from;
    const value = kind === "short" ? BigInt(auth.value) - 1n : kind === "selftransfer" ? 0n : BigInt(auth.value);
    const token = kind === "othertoken" ? "0x" + "5".repeat(40) : REFERRAL_ASSET;
    // What the split contract did with the payment (the logs after the pair):
    //   othermerchant  routed to another merchant id, paid out to another wallet
    //   noevent        nothing after the pair (the money sits in the contract)
    //   payoutonly     no routed event, a transfer of the net to our payout wallet
    //   viaforwarder   the whole paid shape, in a transaction sent to another contract
    //   nopayout       a routed event naming us, with no transfer to our payout wallet
    //   badevent       a routed event of another shape (8 data words), no payout
    //   otherbuyer     a routed event naming another buyer wallet
    //   wronggross     a routed event stating another gross amount
    const gross = BigInt(auth.value);
    const net = gross - (gross * BigInt(bps)) / 10000n;
    const routing = [];
    const ev = (o = {}) => routedLog({ router: payTo, buyer: auth.from, merchantId: MERCHANT_ID, gross, merchantAmt: net, ...o }, 6, block);
    if (kind === "othermerchant") routing.push(transferLog(payTo, OTHER, net, 5, block), ev({ merchantId: "7" }));
    else if (kind === "noevent") { /* nothing */ }
    else if (kind === "payoutonly") routing.push(transferLog(payTo, PAYOUT, net, 5, block));
    else if (kind === "nopayout") routing.push(ev());
    else if (kind === "badevent") routing.push(ev({ words: 8 }));
    else if (kind === "otherbuyer") routing.push(transferLog(payTo, PAYOUT, net, 5, block), ev({ buyer: OTHER }));
    else if (kind === "wronggross") routing.push(transferLog(payTo, PAYOUT, net, 5, block), ev({ gross: gross + 1n }));
    else routing.push(transferLog(payTo, PAYOUT, net, 5, block), ev());
    receipts.set(t, { transactionHash: kind === "wrongtx" ? "0x" + "9".repeat(64) : t, status: kind === "reverted" ? "0x0" : "0x1", to: kind === "viaforwarder" ? OTHER : payTo, logs: [usedLog(auth, 3, block), transferLog(from, to, value, 4, block, token), ...routing] });
    return t;
  }
  /** One transaction that spends several authorizations: each by a zero-value
   *  self-transfer, then ONE transfer of `value` to the pay-to address. */
  function landHelper(auths, value, payTo, tx = null) {
    const t = String(tx || nextTx()).toLowerCase();
    const logs = [];
    let i = 0;
    for (const a of auths) { used.set(keyOf(a.from, a.nonce), { tx: t, block: chainState.head }); logs.push(usedLog(a, i++, chainState.head), transferLog(a.from, a.from, 0, i++, chainState.head)); }
    logs.push(transferLog(auths[0].from, payTo, value, i++, chainState.head));
    receipts.set(t, { transactionHash: t, status: "0x1", to: payTo, logs });
    return t;
  }
  const defaults = () => ({
    verify: () => ({ status: 200, body: { isValid: true } }),
    // A facilitator that settles: the authorization lands, paid, in a real-shaped receipt.
    // The contract pays each slug's own share (the suite's `busy` slug has a commission of its own).
    settle: (call) => ({ status: 200, body: { success: true, transaction: land(call.json.paymentPayload.payload.authorization, nextTx(), "paid", { bps: call.json.paymentPayload.accepted?.extra?.endpoint === "/ref/busy" ? 4321n : 1234n }), network: REFERRAL_NETWORK } }),
    settleDelayMs: 0, verifyDelayMs: 0, rpcDown: false, receiptDown: false, acceptOnce: false, acceptOnceReason: null,
  });
  const mode = defaults();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/rpc") {
        let j = null; try { j = JSON.parse(raw); } catch { /* answered below */ }
        rpcCalls.push(j?.method);
        if (mode.rpcDown || !j) { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
        let result = null;
        if (j.method === "eth_call") {
          const data = String(j.params?.[0]?.data || "");
          const from = `0x${data.slice(34, 74)}`, nonce = `0x${data.slice(74, 138)}`;
          result = `0x${(used.has(keyOf(from, nonce)) ? "1" : "0").padStart(64, "0")}`;
        } else if (j.method === "eth_blockNumber") result = hex(chainState.head);
        else if (j.method === "eth_getLogs") {
          const f = j.params?.[0] || {};
          const t = f.topics || [];
          const lo = parseInt(f.fromBlock, 16), hi = parseInt(f.toBlock, 16);
          const from = `0x${String(t[1] || "").slice(26)}`;
          const d = used.get(keyOf(from, t[2]));
          const wantsUsed = String(t[0]).toLowerCase() === USED_TOPIC;
          const show = d && !d.nolog && d.block >= lo && d.block <= hi && (wantsUsed ? !d.canceled : d.canceled && String(t[0]).toLowerCase() === CANCELED_TOPIC.toLowerCase());
          result = show ? [{ address: REFERRAL_ASSET, transactionHash: d.tx, topics: t, blockNumber: hex(d.block) }] : [];
        } else if (j.method === "eth_getTransactionReceipt") {
          result = mode.receiptDown ? null : receipts.get(String(j.params?.[0] || "").toLowerCase()) || null;
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
      }
      const call = { path: req.url, raw, signature: req.headers["x-agent-signature"] || null, timestamp: req.headers["x-agent-timestamp"] || null, recovered: null, json: null };
      try { call.json = JSON.parse(raw); } catch { /* asserted by the caller */ }
      if (call.signature && call.timestamp) {
        try {
          const digest = keccak256(concat([stringToHex(raw), numberToHex(Number(call.timestamp), { size: 8 })]));
          call.recovered = await recoverMessageAddress({ message: { raw: digest }, signature: call.signature });
          call.digest = digest;
        } catch { call.recovered = null; }
      }
      calls.push(call);
      // A facilitator that accepts a signed request ONCE (keyed on the signer and the signed payload hash).
      if (mode.acceptOnce && (req.url === "/verify" || req.url === "/settle")) {
        const once = `${String(call.recovered).toLowerCase()}:${call.digest}`;
        if (!call.recovered || seenSigned.has(once)) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: mode.acceptOnceReason || "merchant_signature" })); }
        seenSigned.add(once);
      }
      const pick = req.url === "/verify" ? mode.verify : req.url === "/settle" ? mode.settle : null;
      if (!pick) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.url === "/settle" && mode.settleDelayMs) await wait(mode.settleDelayMs);
      if (req.url === "/verify" && mode.verifyDelayMs) await wait(mode.verifyDelayMs);
      const out = await pick(call);
      if (out.hang) return; // never answers
      res.writeHead(out.status, { "content-type": out.type || "application/json", ...(out.headers || {}) });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, mode, used, receipts, chainState, rpcCalls, nextTx, landHelper, routedLog, usedLog, transferLog,
    of: (path) => calls.filter((c) => c.path === path),
    land,
    reset: () => { calls.length = 0; rpcCalls.length = 0; Object.assign(mode, defaults()); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

// --- a buyer -------------------------------------------------------------------
const RECEIVE_TYPES = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const TRANSFER_TYPES = { TransferWithAuthorization: RECEIVE_TYPES.ReceiveWithAuthorization };
let nonceSeq = 0;
const freshNonce = () => keccak256(stringToHex(`referral-test-nonce-${process.pid}-${++nonceSeq}-${Math.random()}`));
async function signPayment(accept, { account = buyer, to = accept.payTo, value = accept.amount, validAfter = "0", validBefore = String(Math.floor(Date.now() / 1000) + 60), nonce = freshNonce(), primaryType = "ReceiveWithAuthorization", mutateSig = (s) => s } = {}) {
  const authorization = { from: account.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce };
  const signature = mutateSig(await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: REFERRAL_ASSET },
    types: primaryType === "ReceiveWithAuthorization" ? RECEIVE_TYPES : TRANSFER_TYPES,
    primaryType,
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
  }));
  const payload = { x402Version: 2, accepted: accept, payload: { signature, authorization } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64url"), authorization };
}
const call = async (url, { method = "POST", body, headers = {}, rawBody } = {}) => {
  const r = await fetch(url, { method, headers: { ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
  return { status: r.status, headers: r.headers, text, json };
};
// One POST whose client hangs up after `abortAfterMs`.
const rawPost = (url, body, headers, abortAfterMs) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve("answered")); });
  req.on("error", () => resolve("aborted"));
  req.end(data);
  setTimeout(() => req.destroy(), abortAfterMs);
});

// One paid POST over a raw socket whose client reads `readBytes` of the body
// and then RESETS the connection; with 0 it reads nothing and resets once
// `when()` says the server has started sending. Resolves `{ got }`.
const rawPaid = (url, body, headers, { readBytes = 0, when = async () => {} } = {}) => new Promise((resolve) => {
  const u = new URL(url);
  const data = JSON.stringify(body);
  const sock = netConnect({ port: Number(u.port), host: u.hostname });
  let got = 0, head = Buffer.alloc(0), inBody = false, done = false;
  sock.on("error", () => {});
  sock.on("close", () => { if (!done) { done = true; resolve({ got }); } });
  sock.on("connect", () => {
    if (readBytes === 0) sock.pause();
    sock.write(`POST ${u.pathname} HTTP/1.1\r\nhost: ${u.host}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(data)}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${data}`);
    if (readBytes === 0) Promise.resolve().then(when).then(() => sock.resetAndDestroy());
  });
  sock.on("data", (d) => {
    if (!inBody) {
      head = Buffer.concat([head, d]);
      const i = head.indexOf("\r\n\r\n");
      if (i < 0) return;
      inBody = true;
      got += head.length - (i + 4);
    } else got += d.length;
    if (got >= readBytes) sock.resetAndDestroy();
  });
});

// A deterministic stand-in for a connection that stops taking an answer: a
// middleware that sits between the gate's send and the socket.
//   x-test-cut: K     pieces are confirmed up to K body bytes; the next piece is
//                     swallowed (never written, never confirmed) and the response is destroyed
//   x-test-stall: K   the same, but the response is left open (rig.stalled) for the test to end
//   x-test-drop: 1    every piece is written and NO write callback is ever called
//                     (what a compressor between the send and the socket does)
const rig = { stalled: [] };
const sendRig = (req, res, next) => {
  const cut = req.headers["x-test-cut"], stall = req.headers["x-test-stall"], drop = req.headers["x-test-drop"];
  if (cut === undefined && stall === undefined && drop === undefined) return next();
  const limit = Number(cut ?? stall);
  const write = res.write.bind(res);
  let passed = 0;
  res.write = (part, cb) => {
    if (drop !== undefined) return write(part);
    if (passed + part.length <= limit) { passed += part.length; return write(part, cb); }
    if (cut !== undefined) setTimeout(() => res.destroy(), 20); else rig.stalled.push(res);
    return true;
  };
  return next();
};
// A call that may end with the connection cut: its status, or "cut".
const cutCall = (url, opts) => call(url, opts).then((r) => r, () => ({ status: "cut", json: null, text: "", headers: new Headers() }));

const fac = await stubFacilitator();

// ===============================================================================
// Part 1: the modules, in this process
// ===============================================================================
// Synthetic slugs and round placeholder figures: no real schedule is typed here.
const ENV = {
  REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY,
  REFERRAL_MERCHANT_ID: MERCHANT_ID, REFERRAL_PAYOUT_ADDRESS: PAYOUT,
  // The receipt of a settle success is read once in the suite (no waiting on a stub).
  REFERRAL_RECEIPT_WAIT_MS: "0",
  REFERRAL_SLUGS: "echo, slow,boom,bytes,list,owntx,chat,busy,budgeted,breaker,exa,chatx,scopes,big,mb,late", REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
  // Synthetic figures, chosen to be no real rate.
  REFERRAL_COMMISSION_BPS: "default:1234,busy:4321", REFERRAL_FEE_BPS: "0",
  REFERRAL_DEADLINE_MS: "1000", REFERRAL_SETTLE_RESERVE_MS: "1000", REFERRAL_SETTLE_MS: "2000", REFERRAL_VERIFY_MS: "1000",
  REFERRAL_UNSETTLED_MAX: "3",
  // A short cool-down after this server's own request is refused, so the suite does not wait out the default.
  REFERRAL_OWN_FAULT_COOLDOWN_MS: "1000",
  // One forgiven hang-up of the stub tools' price fits a payer's budget; a second does not.
  REFERRAL_HANGUP_KEY_USD: "0.05", REFERRAL_HANGUP_GLOBAL_USD: "1",
  // The service-wide bound has a test of its own (a mount with a small figure).
  REFERRAL_UNSETTLED_GLOBAL_MAX: "10000",
};

if (ONLY_PART !== "2") {
// --- configuration ---------------------------------------------------------------
{
  ok(referralConfig({}) === null && referralConfigProblem({}) === null, "no REFERRAL_* variable: off, and nothing to warn about");
  for (const name of ["REFERRAL_PAY_TO", "REFERRAL_FACILITATOR_URL", "REFERRAL_SIGNER_KEY", "REFERRAL_SLUGS", "REFERRAL_SETUP_URL", "REFERRAL_COMMISSION_BPS"]) {
    const e = { ...ENV }; delete e[name];
    const why = referralConfigProblem(e);
    ok(referralConfig(e) === null && typeof why === "string" && why.includes(name) && !why.includes(KEY_HEX), `without ${name} the gate is off and the warning names it (no value printed)`);
  }
  ok(referralConfig({ ...ENV, REFERRAL_PAY_TO: "0x1234" }) === null, "a malformed pay-to address: off");
  ok(referralConfig({ ...ENV, REFERRAL_FACILITATOR_URL: "http://facilitator.example" }) === null, "a plain-http facilitator on a public host: off");
  ok(referralConfig({ ...ENV, REFERRAL_FACILITATOR_URL: "https://user:pw@facilitator.example" }) === null, "a facilitator URL with credentials: off");
  ok(referralConfig({ ...ENV, REFERRAL_SIGNER_KEY: "0xabc" }) === null, "a signer key that is not 32 bytes: off");
  let threw = false, zero = "?";
  try { zero = referralConfig({ ...ENV, REFERRAL_SIGNER_KEY: "00".repeat(32) }); referralConfig({ ...ENV, REFERRAL_SIGNER_KEY: "ff".repeat(32) }); } catch { threw = true; }
  ok(!threw && zero === null && /not usable/.test(referralConfigProblem({ ...ENV, REFERRAL_SIGNER_KEY: "00".repeat(32) }) || ""), "an all-zero (or out-of-range) signer key leaves the gate off with a reason, and never throws");
  let settlerThrew = "";
  try { createReferralSettler({ facilitatorUrl: fac.url, signerKey: "00".repeat(32) }); } catch (e) { settlerThrew = String(e.message); }
  ok(/not a usable private key/.test(settlerThrew) && !settlerThrew.includes("0000"), "the settle client's own refusal of such a key names the setting, never the key");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "ok,Bad Slug!" }) === null, "a slug list with a malformed entry: off");
  const d = referralConfig({ ...ENV, REFERRAL_DEADLINE_MS: "", REFERRAL_SETTLE_RESERVE_MS: "", REFERRAL_SETTLE_MS: "", REFERRAL_VERIFY_MS: "", REFERRAL_UNSETTLED_MAX: "" });
  ok(d && d.deadlineMs === 25_000 && d.settleMs === 50_000 && d.verifyMs === 10_000 && d.settleReserveMs === 10_000 && d.maxValidityMs === 900_000 && d.verifySigned === true && d.unsettledMax === 3 && d.unsettledWindowMs === 900_000 && d.maxInflight === 24 && d.feeBps === 0, "defaults: 25 s handler, 50 s settle, 10 s verify, 10 s reserve, 15 min validity, verify signed, 3 unsettled runs per 15 min, 24 in flight, 0 fee");
  ok(d.deadlineMs + d.settleReserveMs + d.verifyMs <= 60_000, "the default deadline, settle reserve and verify wait fit the 60 s the 402 asks a buyer to sign for");
  ok(referralConfig({ ...ENV, REFERRAL_DEADLINE_MS: "45000", REFERRAL_SETTLE_RESERVE_MS: "10000", REFERRAL_VERIFY_MS: "10000" }) === null, "a deadline, reserve and verify wait past 60 s together: off");
  ok(!("verify" in d) && referralConfig({ ...ENV, REFERRAL_VERIFY: "off" }) !== null && referralConfig({ ...ENV, REFERRAL_VERIFY_SIGNED: "OFF" }).verifySigned === false, "there is no switch that skips /verify; REFERRAL_VERIFY_SIGNED=off is read");
  ok(referralConfig({ ...ENV, REFERRAL_DEADLINE_MS: "abc" }).deadlineMs === 25_000, "a malformed timing knob reads as its default");
  // The commission map: required, no built-in rate.
  const m = referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta,gamma", REFERRAL_COMMISSION_BPS: "default:1234, alpha:4321,Beta:2468" });
  ok(m && commissionBpsFor(m, "alpha") === 4321 && commissionBpsFor(m, "beta") === 2468 && commissionBpsFor(m, "gamma") === 1234, "the commission map is read per slug, and a slug it does not name reads its default");
  ok(commissionBpsFor(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "4000" }), "alpha") === 4000 && commissionBpsFor(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "default:0" }), "alpha") === 0, "a bare number or default: sets the default");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta", REFERRAL_COMMISSION_BPS: "alpha:4321" }) === null && referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta", REFERRAL_COMMISSION_BPS: "alpha:4321,beta:2468" }) !== null, "a slug the map neither names nor covers with a default leaves the gate off (no built-in rate)");
  ok(parseCommissionBps("") === null && parseCommissionBps(undefined) === null, "an empty commission map is no map");
  for (const bad of ["-5", "default:abc", "alpha:10001", "alpha", "alpha:5,alpha:6", "Bad Slug:5", "default:1000;alpha:5"]) {
    if (referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: bad }) !== null || parseCommissionBps(bad) !== null) ok(false, `a malformed commission map (${bad}) should leave the gate off`);
  }
  ok(true, "a malformed commission map leaves the gate off (never a guessed rate)");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "default:1234,alpha:9000", REFERRAL_FEE_BPS: "1111" }) === null, "one slug's commission plus the fee past 10000 bps: off");
}

// --- money arithmetic ----------------------------------------------------------
{
  ok(baseUnitsOf("$0.03") === 30000n && baseUnitsOf("$0.030") === 30000n && baseUnitsOf("$1") === 1000000n && baseUnitsOf("$0.000001") === 1n, "dollars to USDC base units, exact");
  ok(baseUnitsOf("$0.0000001") === null && baseUnitsOf("0.03") === null && baseUnitsOf("$0") === null && baseUnitsOf("$NaN") === null, "a price that is not a positive six-decimal dollar amount has no base units");
  const n = referralNet("30000", { commissionBps: 1234, feeBps: 0 });
  ok(n.grossUsd === 0.03 && n.netUsd === 0.026298, `net of a $0.03 sale at a synthetic 1234 bps is $0.026298 (${n.netUsd})`);
  ok(referralNet("30000", { commissionBps: 1234, feeBps: 567 }).netUnits === 24597n, "commission and fee both come off the gross");
  ok(referralNet("3", { commissionBps: 1234, feeBps: 567 }).netUnits === 3n, "a leg that rounds to zero is not taken: the remainder stays in net");
  ok(referralNet("30000", { commissionBps: 0, feeBps: 0 }).netUnits === 30000n && referralNet("30000", { commissionBps: 10_000, feeBps: 0 }).netUnits === 0n, "0 bps keeps the gross; 10000 bps leaves nothing");
}

// --- boot checks -----------------------------------------------------------------
{
  const h = async () => ({});
  const catalog = {
    "POST /a": { slug: "fine", price: "$0.03", handler: h },
    "POST /b": { slug: "ident", price: "$0.01", handler: h },
    "POST /c": { slug: "lasting", price: "$0.01", handler: h },
    "POST /d": { slug: "seller", price: "$0.01", handler: h },
    "POST /e": { slug: "long", price: "$0.01", handler: h },
    "POST /f": { slug: "binary", price: "$0.01", handler: h, mimeType: "image/png" },
    "POST /g": { slug: "slowimg", price: "$0.03", handler: h },
    "POST /h": { slug: "free", price: "$0", handler: h },
    "POST /i": { slug: "dust", price: "$0.0000001", handler: h },
    "POST /j": { slug: "nohandler", price: "$0.01" },
    "POST /k": { slug: "unbounded", price: "$0.01", handler: h },
    "POST /l": { slug: "chatlike", price: "$0.01", handler: h },
    "POST /m": { slug: "quick", price: "$0.01", handler: h },
  };
  const cfg = { slugs: Object.values(catalog).map((d) => d.slug).concat("missing"), deadlineMs: 25_000 };
  const flags = { fine: { compute: true }, ident: { compute: true, identityBound: true }, lasting: { compute: true, lastingEffect: true }, seller: { compute: true, paysThirdParty: true }, long: { compute: true, longRunning: true }, binary: { compute: true }, slowimg: { ownTimeoutMs: 60_000 }, free: { compute: true }, dust: { compute: true }, unbounded: {}, chatlike: { clamped: true, ownTimeoutMs: 90_000 }, quick: { ownTimeoutMs: 20_000 } };
  const { defs, refused } = referralRoutes(cfg, catalog, (def) => flags[def.slug] || {});
  ok(defs.size === 3 && defs.has("fine") && defs.has("chatlike") && defs.has("quick"), `only the eligible slugs are served: a pure-CPU tool, one whose upstream work the deadline ends, one whose own timeout fits (${[...defs.keys()].join(",")})`);
  const why = Object.fromEntries(refused.map((r) => [r.slug, r.reason]));
  ok(/identity/.test(why.ident) && /outlives/.test(why.lasting) && /outside seller/.test(why.seller) && /long-running/.test(why.long) && /bytes/.test(why.binary) && /upstream wait \(60 s\) is past the handler deadline \(25 s\)/.test(why.slowimg) && /no list price/.test(why.free) && /base units/.test(why.dust) && why.missing === "not in the catalog", "each refused slug carries its reason (identity-bound, lasting effect, outside seller, long-running, binary, upstream wait past the deadline, no price, sub-unit price, missing)");
  ok(why.nohandler === "in the catalog but has no handler", `a slug in the catalog with no handler says so (${why.nohandler})`);
  ok(/declares no upstream timeout/.test(why.unbounded), "a tool with upstream work the deadline cannot end, and no declared timeout, is not served");
  ok(referralIneligibility(catalog["POST /g"], { ownTimeoutMs: 60_000, deadlineMs: 60_000 }) === null, "an upstream wait that fits the deadline is eligible");
  {
    // No pointer to this server's own surfaces, and price parity with the public route's free paths.
    const base = { handler: async () => ({}), price: "$0.01" };
    const own = ["shop.example", "agent402.tools"];
    const inExample = { ...base, slug: "probe-a", discovery: { input: { url: "https://Shop.Example/api/pricing" } } };
    const inSchema = { ...base, slug: "probe-b", discovery: { input: { url: "https://example.com" }, inputSchema: { properties: { url: { description: "e.g. https://agent402.tools/robots.txt" } } } } };
    const clean = { ...base, slug: "probe-c", discovery: { input: { url: "https://example.com/shop.examples" } } };
    const whyA = referralIneligibility(inExample, { compute: true, ownHosts: own }), whyB = referralIneligibility(inSchema, { compute: true, ownHosts: own });
    ok(/own host/.test(whyA || "") && /own host/.test(whyB || "") && gateMod.namesOwnHost(inExample, own) && !gateMod.namesOwnHost(inExample, []) && referralIneligibility({ ...base, slug: "probe-c", discovery: { input: { url: "https://example.com" } } }, { compute: true, ownHosts: own }) === null && referralIneligibility(inExample, { compute: true }) === null, `a tool whose published example or input hints name this server's own host is refused at boot, with the reason (${whyA}); one that names another host is not`);
    void clean;
    const cheaper = referralIneligibility({ ...base, slug: "probe-d" }, { compute: true, cheaperDirect: "free by proof-of-work or the trial parameter" });
    const grand = referralIneligibility({ ...base, slug: gateMod.REFERRAL_PARITY_GRANDFATHERED[0] }, { compute: true, cheaperDirect: "free by proof-of-work or the trial parameter" });
    const routes = referralRoutes({ slugs: ["probe-d", gateMod.REFERRAL_PARITY_GRANDFATHERED[0]], deadlineMs: 60_000 }, { a: { ...base, slug: "probe-d" }, b: { ...base, slug: gateMod.REFERRAL_PARITY_GRANDFATHERED[0] } }, () => ({ compute: true, cheaperDirect: "free by proof-of-work or the trial parameter" }));
    ok(/can be had for less than the listed price \(free by proof-of-work/.test(cheaper || "") && grand === null && routes.refused.length === 1 && routes.refused[0].slug === "probe-d" && routes.defs.size === 1 && routes.noted.length === 1 && routes.noted[0].slug === gateMod.REFERRAL_PARITY_GRANDFATHERED[0] && /served before the price-parity rule/.test(routes.noted[0].note) && referralRoutes({ slugs: ["probe-d"], deadlineMs: 60_000 }, { a: { ...base, slug: "probe-d" } }, () => ({ compute: true })).noted.length === 0, `a tool the public route gives for less by a path /ref lacks is refused at boot (${cheaper}); a slug served before the rule is served still and named at every boot (${routes.noted[0]?.slug})`);
  }
  ok(referralSlugOfPath("/ref/hash") === "hash" && referralSlugOfPath("/REF/Hash/") === "hash" && referralSlugOfPath("/ref/%68ash") === "hash" && referralSlugOfPath("/ref/") === null && referralSlugOfPath("/ref/a/b") === null && referralSlugOfPath("/api/hash") === null && referralSlugOfPath("/ref/" + "a".repeat(500)) === null, "the wide reading of a /ref path (for the gates that count every spelling)");
  ok(isCanonicalReferralPath("/ref/hash", "hash") && !isCanonicalReferralPath("/ref/%68ash", "hash") && !isCanonicalReferralPath("/REF/hash", "hash") && !isCanonicalReferralPath("/ref/hash/", "hash"), "only /ref/<slug> exactly is canonical");
}

// --- the refusal-line sampler ------------------------------------------------------
{
  const out = [];
  let t = 60_000 * 5;
  const s = createLineSampler({ perMinute: 3, now: () => t, print: (l) => out.push(l) });
  for (let i = 0; i < 10; i++) s.line(`refused ${i}`);
  t += 60_000; s.line("next minute");
  ok(out.length === 5 && out[3] === "refusal lines summary: 7 more in that minute" && out[4] === "next minute", `the first lines of a minute are printed, then one summary (${JSON.stringify(out)})`);
}

// --- the chain reader, against the stub RPC ------------------------------------------
// "Used" is never "paid": only the receipt of the transaction that used the
// nonce, showing success and the transfer from the payer to the pay-to address
// of at least the amount, is a payment.
{
  const chain = createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 2, budgetMs: 1500, pauseMs: 50, timeoutMs: 500 });
  const mk = () => ({ from: newAccount().address, to: PAY_TO, value: "30000", nonce: freshNonce() });
  const ask = (a, over = {}) => chain.state({ from: a.from, nonce: a.nonce, payTo: PAY_TO, amount: "30000", minNet: "26298", ...over });
  const a = mk();
  const unused = await ask(a);
  fac.land(a, "0x" + "5a".repeat(32));
  const paid = await ask(a);
  ok(unused.used === false && chainVerdict(unused) === "unused" && paid.used === true && paid.paid === true && paid.transaction === "0x" + "5a".repeat(32) && chainVerdict(paid) === "paid", `an unused nonce reads unused; one used by a transaction whose receipt moves the amount from the payer to the pay-to address reads paid (${JSON.stringify(paid)})`);
  const verdicts = {};
  for (const kind of ["elsewhere", "short", "reverted", "otherpayer", "cancel"]) { const x = mk(); fac.land(x, null, kind); const r = await ask(x); verdicts[kind] = `${r.used}/${r.paid}/${chainVerdict(r)}`; }
  ok(Object.values(verdicts).every((v) => v === "true/false/unpaid"), `a nonce spent by a transfer to another address, a short transfer, a reverted transaction, another wallet's transfer or a cancel is USED and NOT PAID (${JSON.stringify(verdicts)})`);
  ok((await ask(a, { amount: "30001" })).paid === false && (await ask(a, { payTo: "0x" + "4".repeat(40) })).paid === false, "the same receipt does not pay a larger amount or another pay-to address");
  const n = mk(); fac.land(n, null, "nolog");
  const noLog = await ask(n);
  ok(noLog.used === true && noLog.paid === null && chainVerdict(noLog, { validBeforeMs: Date.now() + 60_000 }) === "unknown" && chainVerdict(noLog, { validBeforeMs: Date.now() - 600_000 }) === "unknown", "a spent nonce whose log is not found is UNKNOWN, before and after its expiry: absence is never proof of non-payment");
  fac.mode.receiptDown = true;
  const noReceipt = await ask(a);
  fac.mode.receiptDown = false;
  ok(noReceipt.used === true && noReceipt.paid === null && chainVerdict(noReceipt) === "unknown", "a receipt that cannot be read proves nothing yet");
  fac.mode.rpcDown = true;
  const down = await ask(a);
  fac.mode.rpcDown = false;
  ok(down.used === null && chainVerdict(down) === "unknown", "an unreadable chain is unknown (never unused, never paid)");
  ok(chainVerdict({ used: true, paid: true, transaction: null }) === "unknown" && chainVerdict({ used: false }, { validBeforeMs: Date.now() - 600_000 }) === "expired-unused", "paid needs the transaction; an unspent nonce past its expiry is expired unused");
  ok((await chain.state({ from: "nope", nonce: "0x1", payTo: PAY_TO, amount: "1" })).used === null, "an address that is not one reads as unknown");
  const t0 = Date.now();
  const waited = await chain.state({ from: newAccount().address, nonce: freshNonce(), payTo: PAY_TO, amount: "1" }, { wait: true });
  ok(waited.used === false && Date.now() - t0 < 1500, `a waiting read ends inside its budget (${Date.now() - t0} ms)`);
}

// --- the mechanisms a referral run presents its deadline through ---------------------
{
  const req = {};
  ok(evmCredentialSettleableMs(req) === null, "a request with no payment and no presented window has no settleable window");
  presentRunWindow(req, Date.now() + 4000);
  const left = evmCredentialSettleableMs(req);
  ok(left > 3000 && left <= 4000, `a presented run window is the request's settleable window (${left} ms)`);
  const farHeader = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 3600) } } })).toString("base64");
  const withHeader = { header: (n) => (n === "payment-signature" ? farHeader : undefined) };
  const before = evmCredentialSettleableMs(withHeader);
  presentRunWindow(withHeader, Date.now() + 2000);
  ok(before > 3_000_000 && evmCredentialSettleableMs(withHeader) <= 2000, "it shortens the window a payment header gives");
  const short = { header: (n) => (n === "payment-signature" ? farHeader : undefined) };
  presentRunWindow(short, Date.now() + 10_000_000);
  ok(evmCredentialSettleableMs(short) < 3_600_000, "and never extends it");
  const seenBudget = [];
  const budgeted = underBudget(async () => { seenBudget.push(currentBudget()?.remaining()); return 1; }, 290_000);
  await budgeted();
  await withBudgetCeiling(800, () => budgeted());
  ok(seenBudget[0] > 200_000 && seenBudget[1] > 0 && seenBudget[1] <= 800, `a budgeted handler started under a ceiling gets the ceiling, not its own budget (${seenBudget.map((x) => Math.round(x)).join(", ")} ms)`);
  // The direct routes' settle breaker ignores a request marked for another lane.
  const marked = { headers: {}, res: { once() {} } };
  settleBreakerOtherLane(marked);
  const r = gatewaySettleBreakerCheck(marked);
  ok(r === undefined && marked.__gatewaySettleBreakerArmed !== true, "a request marked for another lane is not consulted or armed by the direct routes' settle breaker");
}

// --- the gate, mounted on a small app --------------------------------------------
const runs = { echo: 0, slow: 0, boom: 0, busy: 0 };
const seen = { chat: null, budgeted: null, breaker: null, exa: null, chatx: null };
const TOOLS = {
  echo: { slug: "echo", name: "Echo", category: "test", price: "$0.03", route: "POST /api/echo", handler: async (i) => { runs.echo++; return { echo: i.text ?? null, run: runs.echo }; } },
  busy: { slug: "busy", name: "Busy", category: "test", price: "$0.03", handler: async (i) => { runs.busy++; await wait(300); return { echo: i.text ?? null }; } },
  slow: { slug: "slow", name: "Slow", category: "test", price: "$0.03", handler: async () => { runs.slow++; await wait(2500); return { late: true }; } },
  boom: { slug: "boom", name: "Boom", category: "test", price: "$0.03", route: "POST /api/boom", handler: async () => { runs.boom++; throw Object.assign(new Error(`that input cannot be served${routeHint("; see POST /api/boom")}`), { statusCode: 422 }); } },
  bytes: { slug: "bytes", name: "Bytes", category: "test", price: "$0.03", handler: async () => ({ __binary: Buffer.from("png"), contentType: "image/png" }) },
  list: { slug: "list", name: "List", category: "test", price: "$0.03", handler: async () => [1, 2, 3] },
  owntx: { slug: "owntx", name: "Own", category: "test", price: "$0.03", handler: async () => ({ transaction: "the tool's own field", rows: 1 }) },
  chat: { slug: "chat", name: "Chat", category: "llm", price: "$0.001", quote: (b) => 0.001 * (Number(b?.max_tokens) || 1), handler: async (i, req) => { seen.chat = { stream: i.stream, hasOptions: "stream_options" in i, stash: req.__meteredQuoteUsd }; return { id: "c1", choices: [] }; } },
  // Tools with a published example: an empty request runs it.
  exa: { slug: "exa", name: "Example", category: "test", price: "$0.03", discovery: { input: { text: "the published example", n: 2 } }, handler: async (i) => { seen.exa = { ...i }; return { got: i.text ?? null, n: i.n ?? null }; } },
  chatx: { slug: "chatx", name: "Chat example", category: "llm", price: "$0.001", quote: (b) => 0.001 * (Number(b?.max_tokens) || 1), discovery: { input: { max_tokens: 3, messages: [{ role: "user", content: "example" }], stream: true } }, handler: async (i, req) => { seen.chatx = { max_tokens: i.max_tokens, stream: i.stream, content: i.messages?.[0]?.content, stash: req.__meteredQuoteUsd }; return { id: "cx", choices: [] }; } },
  // A tool the catalog marks model-backed: each call has upstream cost.
  mb: { slug: "mb", name: "Model", category: "test", price: "$0.03", modelBacked: true, handler: async (i) => { await wait(Number(i.ms) || 0); if (i.fail) throw Object.assign(new Error("that input cannot be served"), { statusCode: 422 }); return { said: "ok" }; } },
  // Comes back with an answer after the run's ceiling (the deadline less 500 ms) and before the deadline itself.
  late: { slug: "late", name: "Late", category: "test", price: "$0.03", handler: async () => { await wait(750); return { finished: "after the ceiling" }; } },
  // An answer of the size asked (for the delivery checks).
  big: { slug: "big", name: "Big", category: "test", price: "$0.03", handler: async (i) => ({ blob: "a".repeat(Math.min(Number(i.n) || 0, 7_800_000)) }) },
  // Reports the scopes a run is served in: the caller key and the referral-run mark.
  scopes: { slug: "scopes", name: "Scopes", category: "test", price: "$0.03", handler: async () => ({ caller: currentDispatchCaller(), referral: inReferralRun(), hint: routeHint("call POST /api/scopes", "") }) },
  // Reads the two mechanisms the gate presents its deadline through.
  budgeted: { slug: "budgeted", name: "Budgeted", category: "test", price: "$0.03", handler: underBudget(async (_i, req) => { seen.budgeted = { budgetLeft: currentBudget()?.remaining(), windowLeft: evmCredentialSettleableMs(req) }; return { ok: true }; }, 290_000) },
  // Consults the direct routes' settle breaker the way a chat handler does.
  breaker: { slug: "breaker", name: "Breaker", category: "test", price: "$0.03", handler: async (_i, req) => { await gatewaySettleBreakerCheck(req); seen.breaker = { armed: req.__gatewaySettleBreakerArmed === true }; return { ok: true }; } },
};
const logLines = [];
const log = { log: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)) };
const sales = [];
const responses = [];
const trusted = [];
const skew = { ms: 0 };
const SCREENED = newAccount();
const limiter = { limitedFor: new Set(), notes: 0 };
const warmed = [];
const owed = [];
const paidPayers = new Set();
const knobs = { requireShared: false, draining: { active: false, leftMs: Infinity } };
// The server's own per-request price rule (quotedPriceUsd), restated for the stub tools.
const priceUsdOf = (def, req) => {
  const flat = Number(String(def.price).replace(/[^0-9.]/g, ""));
  if (typeof def.quote !== "function") return flat;
  const q = Number(def.quote(req.__handlerInput || req.body || {}));
  if (Number.isFinite(q) && q > 0) { req.__meteredQuoteUsd = q; return q; }
  return flat;
};
let docSeq = 0;
function mount(envOverride = {}, depOverride = {}) {
  const config = referralConfig({ ...ENV, ...envOverride });
  const { defs } = referralRoutes(config, Object.fromEntries(Object.values(TOOLS).map((d) => [`POST /${d.slug}`, d])), () => ({ compute: true }));
  const book = depOverride.book || createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-${++docSeq}`, log: () => {} }), log, now: () => Date.now() + skew.ms });
  const answers = depOverride.answers || createReferralAnswerStore();
  const gate = createReferralGate({
    config, defs, replayGuard: createReplayGuard(), baseUrl: "https://shop.example", book, answers,
    // As the server wires it: a paid sale on a paying rail (a set, here) or a real row on this gate's own rail.
    payerHasPaid: (payer) => paidPayers.has(payer) || ledger.payerHasPrivateRailSale(payer, "referral"),
    modelNetFloorBps: 7000,
    oweRefund: async (row) => { owed.push(row); return true; },
    settler: createReferralSettler({ facilitatorUrl: config.facilitatorUrl, signerKey: config.signerKey, verifyTimeoutMs: config.verifyMs, settleTimeoutMs: config.settleMs, signVerify: config.verifySigned }),
    chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 2, budgetMs: 1200, pauseMs: 100, timeoutMs: 500 }),
    priceUsdOf, priceForNetwork,
    preValidate: (def, req) => (def.slug === "echo" && req.body && req.body.require ? { status: 400, body: { error: "Missing required parameter: text", tool: def.slug, howToCall: { method: "POST", url: "https://shop.example/api/echo" }, example: { see: "POST /api/echo" } } } : null),
    prePaymentRefusal: (def, input) => (def.slug === "chat" && input && input.model === "no-such-model" ? { status: 400, body: { error: { message: `unknown model${routeHint("; GET /v1/models lists them")}`, code: "unknown_model" }, tool: def.slug } } : null),
    sendToolError: (res, err, slug) => res.status(err?.statusCode || 502).json({ error: String(err?.message || "request failed"), tool: slug }),
    recordSale: (row) => { sales.push(row); return ledger.recordSale(row); },
    saleBooked: (tx, payer, slug) => ledger.privateRailSaleCount(tx, "referral", payer, slug),
    amendSaleNet: ({ tx, netUsd, payer, slug, grossUsd }) => ledger.amendPrivateRailSaleNet(tx, "referral", netUsd, payer, slug, grossUsd),
    payerScreen: async (req, res) => {
      const from = JSON.parse(Buffer.from(req.headers["payment-signature"], "base64").toString("utf8")).payload.authorization.from;
      if (from !== SCREENED.address) return true;
      res.status(403).json({ error: "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request.", reason: "payer-not-accepted", charged: false });
      return false;
    },
    isolate: settleBreakerOtherLane,
    presentWindow: (req, at) => presentRunWindow(req, at),
    withCeiling: withBudgetCeiling,
    credentialLimiter: { limited: (req) => limiter.limitedFor.has(req.headers["x-test-ip"] || "local"), note: () => { limiter.notes++; } },
    clientKey: (req) => String(req.headers["x-test-ip"] || "local"),
    onSettledSale: (req) => trusted.push(req.headers["x-test-ip"] || "local"),
    warmQuote: async (def) => { warmed.push(def.slug); },
    runAsCaller: runAsCallerOf,
    isSynthetic: () => false,
    salePathOf: () => "http",
    requireShared: () => knobs.requireShared,
    draining: () => knobs.draining,
    log, now: () => Date.now() + skew.ms,
    ...depOverride,
  });
  const app = express();
  for (const mw of depOverride.appUse || []) app.use(mw);
  app.use(express.json({ limit: "100kb" }));
  app.get("/ref/:slug", (req, res) => gate.handler(req, res));
  app.post("/ref/:slug", (req, res) => gate.handler(req, res));
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve) => server.on("listening", () => resolve({ gate, config, book, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}
fac.reset();
const app1 = await mount();
const R = (slug) => `${app1.url}/ref/${slug}`;
const send = async (url, opts) => { const r = await call(url, opts); responses.push(r.text); return r; };
let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const settles = () => fac.of("/settle").length;
const verifies = () => fac.of("/verify").length;
const quietLedger = () => wait(40);

try {
  // --- the unpaid 402 ------------------------------------------------------------
  const TOKEN = '{"v":1,"ref":"r-77","sig":"AbC+/=="}  ;, ~';
  const bare = await send(R("echo"), { method: "GET", headers: { "x-referrer-token": TOKEN, "x-referrer-buyer-agent-id": "4711" } });
  const accept = bare.json?.accepts?.[0];
  ok(bare.status === 402, `an unpaid GET of a POST tool answers 402 (${bare.status})`);
  ok(JSON.stringify(Object.keys(bare.json || {})) === JSON.stringify(["x402Version", "resource", "accepts", "extensions"]) && bare.json.x402Version === 2, `the 402 body is x402Version, resource, accepts, extensions and nothing else (${Object.keys(bare.json || {}).join(",")})`);
  ok(JSON.stringify(bare.json?.resource) === JSON.stringify({ url: "https://shop.example/ref/echo", description: "Echo", mimeType: "application/json" }), "resource carries url, description and mimeType");
  ok(Array.isArray(bare.json?.accepts) && bare.json.accepts.length === 1 && JSON.stringify(accept) === JSON.stringify({
    scheme: "exact", network: "eip155:8453", asset: REFERRAL_ASSET, amount: "30000", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2", authorizationType: "ReceiveWithAuthorization", facilitatorUrl: fac.url, endpoint: "/ref/echo" },
  }), `the one accept is exact on Base USDC to the split contract, with the documented extra (${JSON.stringify(accept)})`);
  ok(bare.json?.extensions?.attributionToken === TOKEN && bare.json.extensions.buyerAgentId === "4711" && bare.json.extensions.setup_url === "https://setup.example/.well-known/referral", "extensions echo the attribution token byte for byte, the buyer agent id as a string, and the setup URL");
  ok(!bare.headers.get("payment-required") && !bare.json.payment && !bare.json.howToCall && !bare.text.includes("/api/"), "no PAYMENT-REQUIRED header, no payment guide and no pointer to the direct route");
  ok(bare.headers.get("x-robots-tag") === "noindex, nofollow" && /no-store/.test(bare.headers.get("cache-control") || ""), "the answer is noindex and never stored");
  const plain = await send(R("echo"), { method: "POST", body: { text: "a" } });
  ok(plain.json?.extensions?.attributionToken === "" && !("buyerAgentId" in (plain.json?.extensions || {})), "with no referrer headers the token is the empty string and the agent id is absent");
  const longToken = await send(R("echo"), { method: "GET", headers: { "x-referrer-token": "a".repeat(9000) } });
  ok(longToken.status === 402 && longToken.json.extensions.attributionToken === "", "a token past the bound is not echoed (a cut token would be another token)");
  ok((await send(R("nope"), { method: "GET" })).status === 404, "a slug outside the allowlist is a 404");
  for (const odd of ["/ref/%65cho", "/REF/echo", "/ref/Echo", "/ref/echo/", "/ref//echo"]) {
    const r = await send(`${app1.url}${odd}`, { method: "GET" });
    if (r.status !== 404) ok(false, `${odd} answered ${r.status}, expected 404`);
  }
  ok(true, "any spelling but the canonical /ref/<slug> (an escape, another case, an extra slash) is a 404: no price, no run");
  const quoted = await send(R("chat"), { method: "POST", body: { max_tokens: 7, messages: [] } });
  const unpriced = await send(R("chat"), { method: "GET" });
  ok(quoted.json?.accepts?.[0]?.amount === "7000" && unpriced.status === 402 && unpriced.json?.accepts?.[0]?.amount === "1000", `a per-request price reads the body (${quoted.json?.accepts?.[0]?.amount}); a probe with no body reads the list price (${unpriced.json?.accepts?.[0]?.amount})`);
  const badUnpaid = await send(R("chat"), { method: "POST", body: { max_tokens: 7, model: "no-such-model" } });
  ok(badUnpaid.status === 400 && badUnpaid.json?.error?.code === "unknown_model" && badUnpaid.json.error.message === "unknown model" && !/\/v1\/|\/api\//.test(badUnpaid.text), `an unpaid body the direct route refuses before payment is refused the same way, with no pointer to a direct route (${badUnpaid.status} ${badUnpaid.text.slice(0, 100)})`);
  ok(fac.calls.length === 0 && fac.rpcCalls.length === 0, "an unpaid request calls the facilitator and the chain for nothing");

  // --- an empty request runs the tool's published example --------------------------
  {
    const exGet = await send(R("exa"), { method: "GET" });
    const exEmpty = await send(R("exa"), { method: "POST", body: {} });
    const exNoBody = await send(R("exa"), { method: "POST" });
    ok(exGet.status === 402 && exEmpty.status === 402 && exNoBody.status === 402 && exGet.json.accepts[0].amount === "30000", "an empty request (a bare GET, a POST with no body, a POST of {}) to a fixed-price tool reads its price");
    {
      const withInput = await send(R("exa"), { method: "POST", body: { text: "mine" }, headers: { "x-referrer-token": "tok-9" } });
      const emptyTok = await send(R("exa"), { method: "POST", body: {}, headers: { "x-referrer-token": "tok-9" } });
      const noExample = await send(R("echo"), { method: "POST", body: {} });
      ok([exGet, exEmpty, exNoBody].every((r) => /no input runs this tool's published example/.test(r.json.emptyRequest?.note || "") && JSON.stringify(r.json.emptyRequest.input) === JSON.stringify({ text: "the published example", n: 2 })) && !("emptyRequest" in withInput.json) && !("emptyRequest" in noExample.json) && emptyTok.json.extensions.attributionToken === "tok-9" && Object.keys(emptyTok.json.extensions).sort().join() === "attributionToken,setup_url" && emptyTok.json.accepts.length === 1 && JSON.stringify(emptyTok.json.accepts[0]) === JSON.stringify(withInput.json.accepts[0]), `the 402 for an empty request says it runs the published example and shows that input, beside the fields the network reads (accepts and the echoed token unchanged); a request with input, or a tool with no example, carries no such field (${Object.keys(exGet.json).join()})`);
    }
    const acc = exGet.json.accepts[0];
    const viaPost = await send(R("exa"), { method: "POST", body: {}, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(viaPost.status === 200 && viaPost.json?.got === "the published example" && viaPost.json.n === 2 && /^0x/.test(viaPost.json.transaction || "") && seen.exa?.text === "the published example", `a paid POST of {} runs exactly the published example and settles (${viaPost.status} ${viaPost.text.slice(0, 90)})`);
    const viaGet = await send(R("exa"), { method: "GET", headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(viaGet.status === 200 && viaGet.json?.got === "the published example", `a paid GET with no query runs it too (${viaGet.status})`);
    // Any input at all is the buyer's own request: served as sent, never mixed with the example.
    const own = await send(`${R("exa")}?text=mine`, { method: "GET", headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(own.status === 200 && own.json?.got === "mine" && own.json.n === null, `a GET with a query is served as sent (${own.text.slice(0, 80)})`);
    const ownBody = await send(R("exa"), { method: "POST", body: { n: 9 }, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(ownBody.status === 200 && ownBody.json?.got === null && ownBody.json.n === 9, `a body with one field is served as sent: the example fills nothing in (${ownBody.text.slice(0, 80)})`);
    const wrapped = await send(R("exa"), { method: "POST", body: { params: {} }, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(wrapped.status === 200 && wrapped.json?.got === null, "an empty wrapper is still an input of the buyer's own");
    // A per-request priced chat tool: the empty request is quoted, and settled, at the example's price.
    const cGet = await send(R("chatx"), { method: "GET" });
    const cOwn = await send(R("chatx"), { method: "POST", body: { max_tokens: 8, messages: [] } });
    ok(cGet.json?.accepts?.[0]?.amount === "3000" && cOwn.json?.accepts?.[0]?.amount === "8000", `an empty request to a per-request priced tool quotes its published example (${cGet.json?.accepts?.[0]?.amount}); a request with a body quotes that body (${cOwn.json?.accepts?.[0]?.amount})`);
    const cPaid = await send(R("chatx"), { method: "POST", body: {}, headers: { "payment-signature": (await signPayment(cGet.json.accepts[0])).header } });
    ok(cPaid.status === 200 && seen.chatx && seen.chatx.max_tokens === 3 && seen.chatx.content === "example" && seen.chatx.stream === false && Math.abs(seen.chatx.stash - 0.003) < 1e-12 && fac.of("/settle").at(-1).json.paymentRequirements.amount === "3000", `the paid empty call runs the example, not streamed, and settles the example's amount (${JSON.stringify(seen.chatx)})`);
    const cWrong = await send(R("chatx"), { method: "POST", body: {}, headers: { "payment-signature": (await signPayment(cOwn.json.accepts[0])).header } });
    ok(cWrong.status === 402 && cWrong.json?.errorReason === "invalid_exact_evm_payload_authorization_value_mismatch", "an authorization signed for another request's amount does not pay the example");
    // A tool that publishes no example is unchanged: the list price, and its own validation.
    const none = await send(R("echo"), { method: "POST", body: {} });
    ok(none.status === 402 && none.json.accepts[0].amount === "30000", "a tool with no published example answers an empty request as before");
    ok(app1.gate.stats().exampleRuns === 3, `the example runs are counted (${app1.gate.stats().exampleRuns})`);
  }
  fac.reset(); sales.length = 0; trusted.length = 0;

  // --- local refusals: nothing claimed, nothing sent ------------------------------
  const refusedWith = async (name, opts, reason) => {
    const p = await signPayment(accept, opts);
    const before = fac.calls.length, ranBefore = runs.echo, notes = limiter.notes;
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === reason && typeof r.json.errorMessage === "string" && /Nothing was charged/.test(r.json.errorMessage) && fac.calls.length === before && runs.echo === ranBefore && limiter.notes === notes + 1, `${name}: 402 ${reason} with a sentence, no handler run, no facilitator call, counted as a refused credential (${r.status} ${r.json?.errorReason})`);
    return p;
  };
  const nowSec = () => Math.floor(Date.now() / 1000);
  await refusedWith("an authorization to another address", { to: OUR_WALLET }, "invalid_exact_evm_payload_recipient_mismatch");
  await refusedWith("a value one unit under the amount", { value: "29999" }, "invalid_exact_evm_payload_authorization_value_mismatch");
  await refusedWith("a value one unit over the amount", { value: "30001" }, "invalid_exact_evm_payload_authorization_value_mismatch");
  await refusedWith("an expired authorization", { validBefore: String(nowSec() - 5) }, "invalid_exact_evm_payload_authorization_valid_before");
  await refusedWith("an authorization shorter than the deadline, the settle reserve and the verify wait", { validBefore: String(nowSec() + 2) }, "invalid_exact_evm_payload_authorization_valid_before");
  await refusedWith("an authorization not valid yet", { validAfter: String(nowSec() + 600) }, "invalid_exact_evm_payload_authorization_valid_after");
  await refusedWith("an authorization that expires an hour ahead (past the validity bound)", { validBefore: String(nowSec() + 3600) }, "authorization_validity_too_long");
  await refusedWith("an authorization valid forever", { validBefore: "115792089237316195423570985008687907853269984665640564039457584007913129639935" }, "authorization_validity_too_long");
  {
    // A signature that is not the payer's is refused here: no /verify is spent on it.
    const forged = await signPayment(accept, { account: newAccount() });
    forged.payload.payload.authorization.from = buyer.address;
    const before = fac.calls.length, ran = runs.echo;
    const f = await send(R("echo"), { body: { text: "forged" }, headers: { "payment-signature": Buffer.from(JSON.stringify(forged.payload)).toString("base64url") } });
    ok(f.status === 402 && f.json?.errorReason === "invalid_exact_evm_payload_signature" && fac.calls.length === before && runs.echo === ran, `a signature that is not the payer's is refused locally, with no facilitator call (${f.status} ${f.json?.errorReason}, ${fac.calls.length - before} calls)`);
    const direct = await signPayment(accept, { primaryType: "TransferWithAuthorization" });
    const d = await send(R("echo"), { body: { text: "wrong type" }, headers: { "payment-signature": direct.header } });
    ok(d.status === 402 && d.json?.errorReason === "invalid_exact_evm_payload_signature" && fac.calls.length === before, `a TransferWithAuthorization signature is not a ReceiveWithAuthorization (${d.status} ${d.json?.errorReason})`);
    const contract = await signPayment(accept, { mutateSig: (s) => s + "00".repeat(40) });
    const c = await send(R("echo"), { body: { text: "long sig" }, headers: { "payment-signature": contract.header } });
    ok(c.status === 402 && c.json?.errorReason === "invalid_exact_evm_payload_signature" && fac.calls.length === before, `a signature that is not a 64 or 65 byte ECDSA one (a contract wallet's) is refused locally (${c.status})`);
    // v as 0/1 is the same signature as v 27/28.
    const v01 = await signPayment(accept, { mutateSig: (s) => s.slice(0, 130) + (parseInt(s.slice(130), 16) - 27).toString(16).padStart(2, "0") });
    ok(/^(00|01)$/.test(v01.payload.payload.signature.slice(130)) && (await isLocalReceiveSignature(v01.authorization, v01.payload.payload.signature)) === true, "a signature with v 0/1 verifies locally like v 27/28");
    const rv = await send(R("echo"), { body: { text: "v01" }, headers: { "payment-signature": v01.header } });
    ok(rv.status === 200 && fac.of("/settle").at(-1)?.json?.paymentPayload?.payload?.signature === v01.payload.payload.signature, `and is served, sent to the facilitator as signed (${rv.status})`);
  }
  {
    const p = await signPayment(accept);
    const other = { ...p.payload, accepted: { ...accept, network: "eip155:137" } };
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from(JSON.stringify(other)).toString("base64url") } });
    ok(r.status === 402 && r.json?.errorReason === "invalid_network", `a payment naming another network: 402 invalid_network (${r.json?.errorReason})`);
    const junk = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from("not json").toString("base64url") } });
    ok(junk.status === 402 && junk.json?.success === false && junk.json.errorReason === "invalid_request" && !/PAYMENT-SIGNATURE/.test(junk.text), `a header that does not decode: 402 invalid_request, in words that name no header (${junk.status} ${junk.json?.errorMessage})`);
    const empty = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: accept, payload: {} })).toString("base64url") } });
    ok(empty.status === 402 && empty.json?.errorReason === "invalid_payload", `a payment with no authorization: 402 invalid_payload (${empty.json?.errorReason})`);
    const head = await fetch(R("echo"), { method: "HEAD", headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(head.status === 405 && settles() === 1, `a payment on HEAD is refused 405 and never settled (${head.status})`);
  }
  {
    limiter.limitedFor.add("9.9.9.9");
    const before = fac.calls.length;
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept)).header, "x-test-ip": "9.9.9.9" } });
    limiter.limitedFor.clear();
    ok(r.status === 429 && /refused payment credentials/.test(r.json?.error || "") && fac.calls.length === before, `an address past the refused-credential limit is answered 429 before anything is checked (${r.status})`);
  }
  {
    const p = await signPayment(accept);
    const r = await send(R("echo"), { body: { require: true }, headers: { "payment-signature": p.header } });
    ok(r.status === 400 && r.json?.tool === "echo" && !("howToCall" in r.json) && !/shop\.example\/api\/echo/.test(r.text), `an input the pre-payment check refuses is the direct route's 400 without its ready-to-run call, and names no direct route (${r.status} ${r.text.slice(0, 120)})`);
    const again = await send(R("echo"), { body: { text: "now valid" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200, `nothing was claimed: the same authorization then buys a valid call (${again.status})`);
  }
  {
    // The payer screen runs before anything is claimed or sent.
    const before = fac.calls.length, ran = runs.echo;
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept, { account: SCREENED })).header } });
    ok(r.status === 403 && r.json?.reason === "payer-not-accepted" && r.json.charged === false && fac.calls.length === before && runs.echo === ran, `a payer the screen refuses gets the screen's own 403 before the handler, with no facilitator call (${r.status})`);
  }
  fac.reset(); sales.length = 0; trusted.length = 0;

  // --- a paid call ---------------------------------------------------------------
  const paid = await signPayment(accept);
  const paidKey = gateMod.referralReplayKey(paid.authorization);
  let intentSeen = null;
  fac.mode.settle = (c) => { intentSeen = app1.book.get(paidKey)?.state || null; return { status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()), network: REFERRAL_NETWORK, payer: buyer.address } }; };
  const good = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": paid.header, "x-test-ip": "7.7.7.7" } });
  const settleCall = fac.of("/settle")[0], verifyCall = fac.of("/verify")[0];
  ok(good.status === 200 && good.json?.echo === "hello" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid call returns the tool's answer with a top-level transaction (${good.status} ${good.text.slice(0, 120)})`);
  ok(verifies() === 1 && settles() === 1 && fac.calls.findIndex((c) => c.path === "/verify") < fac.calls.findIndex((c) => c.path === "/settle"), "the facilitator was asked to verify once, then to settle once");
  ok(intentSeen === "intent", `the intent to settle was in the durable book before /settle was called (${intentSeen})`);
  for (const [name, c] of [["/verify", verifyCall], ["/settle", settleCall]]) {
    ok(c && /^0x[0-9a-f]{130}$/i.test(c.signature || "") && /^\d{10}$/.test(c.timestamp || "") && Math.abs(Number(c.timestamp) - Date.now() / 1000) < 60, `${name}: X-Agent-Signature is a 65-byte signature and X-Agent-Timestamp is unix seconds`);
    ok(c && c.recovered && c.recovered.toLowerCase() === signer.address.toLowerCase(), `${name}: the signature recovers to the signer over keccak256(body || uint64_be(timestamp)) of the exact bytes sent`);
    ok(c && c.raw === JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, resource: { url: "https://shop.example/ref/echo" }, accepted: accept, payload: { signature: paid.payload.payload.signature, authorization: paid.authorization } }, paymentRequirements: accept }), `${name}: the body is { x402Version: 2, paymentPayload, paymentRequirements }, the payload REBUILT from the fields this server validated (the quoted requirement as accepted, the signature, the six authorization fields) and the requirement as quoted`);
    ok(c && referralRequestDigest(c.raw, Number(c.timestamp)) === keccak256(concat([stringToHex(c.raw), numberToHex(Number(c.timestamp), { size: 8 })])), `${name}: the module's digest is the documented one`);
  }
  await quietLedger();
  const row = ledger.privateRailSaleByTx(good.json.transaction, "referral");
  ok(sales.length === 1 && sales[0].rail === "referral" && sales[0].wire === "referral" && sales[0].network === "base" && sales[0].payer === buyer.address.toLowerCase() && sales[0].tx === good.json.transaction && sales[0].priceUsd === 0.026298 && sales[0].quoteUsd === 0.03, `one sale: rail referral, wire referral, network base, the signed payer, the settle transaction, net $0.026298 of gross $0.03 (${JSON.stringify(sales[0])})`);
  ok(row && row.rail === "referral" && row.netUsd === 0.026298 && row.grossUsd === 0.03 && row.payer === buyer.address.toLowerCase() && row.internal === false && row.responseSha256 === createHash("sha256").update(good.text, "utf8").digest("hex"), `the ledger row reads the same, with the digest of the bytes answered (${JSON.stringify(row)})`);
  ok(app1.book.get(paidKey) === null && app1.book.list().length === 0, "a settled and delivered call leaves nothing in the book");
  ok(trusted.length === 1 && trusted[0] === "7.7.7.7", "a settled call earns its client address the paid-client allowance");

  // --- a re-send of a settled payment: the kept answer, no second run ---------------
  {
    const ran = runs.echo;
    const again = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": paid.header } });
    ok(again.status === 200 && again.text === good.text && settles() === 1 && runs.echo === ran && sales.length === 1, `the same PAYMENT-SIGNATURE again returns the kept answer with its transaction: no second run, no second settle, no second sale (${again.status})`);
    // Another signature under the same payer and nonce is not that payment.
    const other = JSON.parse(JSON.stringify(paid.payload));
    other.payload.authorization.validBefore = String(Number(other.payload.authorization.validBefore) + 1);
    const resigned = await buyer.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: REFERRAL_ASSET }, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization", message: { ...other.payload.authorization, value: BigInt(other.payload.authorization.value), validAfter: 0n, validBefore: BigInt(other.payload.authorization.validBefore) } });
    other.payload.signature = resigned;
    const stranger = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": Buffer.from(JSON.stringify(other)).toString("base64url") } });
    ok(stranger.status === 409 && !stranger.text.includes("hello") && runs.echo === ran, `another signature on the same payer and nonce gets no kept answer and no run (${stranger.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    const p = await signPayment(accept);
    const before = runs.busy;
    const [a, b] = await Promise.all([0, 1].map(() => send(R("busy"), { body: { text: "twice" }, headers: { "payment-signature": p.header } })));
    const statuses = [a.status, b.status].sort();
    ok(statuses[0] === 200 && statuses[1] === 409 && settles() === 1 && runs.busy === before + 1 && sales.length === 1 && sales[0].quoteUsd === 0.03 && sales[0].priceUsd === 0.017037, `two identical requests at once: one 200, one 409, one handler run, exactly one settle (${statuses.join("/")}, ${settles()} settle, ${runs.busy - before} run); the slug's own commission (5000 bps) is what the sale is booked net of (${sales[0]?.priceUsd})`);
  }
  fac.reset(); sales.length = 0;

  // --- once the handler has started the authorization is spent --------------------
  {
    const p = await signPayment(accept);
    const r = await send(R("boom"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 422 && r.json?.tool === "boom" && settles() === 0 && sales.length === 0, `a handler 4xx is answered as the tool's own error and not settled (${r.status}, ${settles()} settle)`);
    ok(/that input cannot be served/.test(r.json?.error || "") && !("howToCall" in r.json), `a tool error is the tool's own, rendered as the direct route renders it (${r.json?.error})`);
    const again = await send(R("boom"), { body: {}, headers: { "payment-signature": p.header } });
    ok(again.status === 409 && runs.boom === 1, `its claim is HELD: the same authorization does not reach the handler again (${again.status}, ${runs.boom} run)`);
  }
  {
    const p = await signPayment(accept, { account: newAccount() });
    const ip = freshIp();
    const t0 = Date.now();
    const r = await send(R("slow"), { body: {}, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(r.status === 504 && Date.now() - t0 < 2400 && settles() === 0 && sales.length === 0 && /nothing was charged/.test(r.json?.error || ""), `a handler past the deadline answers 504 at the deadline and is not settled (${r.status} after ${Date.now() - t0} ms)`);
    const again = await send(R("echo"), { body: { text: "after" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(again.status === 409, `its claim is HELD: the same authorization buys no other call (${again.status})`);
    await wait(1700); // the slow handler ends
    ok(settles() === 0, "the handler that finished late settled nothing");
  }
  {
    // The deadline reaches the handler through the payment window and the budget ceiling.
    const r = await send(R("budgeted"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(r.status === 200 && seen.budgeted && seen.budgeted.budgetLeft > 0 && seen.budgeted.budgetLeft <= 1000 && seen.budgeted.windowLeft > 0 && seen.budgeted.windowLeft <= 1000, `a handler runs with its upstream budget capped at the gate's deadline and the deadline presented as its payment window (${JSON.stringify(seen.budgeted)})`);
    const b = await send(R("breaker"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(b.status === 200 && seen.breaker && seen.breaker.armed === false, "a handler that consults the direct routes' settle breaker arms nothing on a referral run");
  }
  fac.reset(); sales.length = 0;
  {
    const p = await signPayment(accept);
    const r = await send(R("bytes"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 500 && settles() === 0, `a binary answer is a 500, not settled (${r.status})`);
    const l = await send(R("list"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(l.status === 200 && JSON.stringify(l.json?.result) === "[1,2,3]" && /^0x/.test(l.json?.transaction || "") && Object.keys(l.json).length === 2, `an answer that is not a JSON object is served as { result, transaction } (${l.text})`);
    const o = await send(R("owntx"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(o.status === 200 && o.json?.result?.transaction === "the tool's own field" && /^0x[0-9a-f]{64}$/.test(o.json?.transaction || ""), `an answer with a transaction field of its own is wrapped the same way, so the settle transaction is never mistaken for it (${o.text})`);
  }
  fac.reset(); sales.length = 0;

  // --- chat bodies are never streamed, and are priced after that is decided ---------
  {
    const body = { max_tokens: 9, messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } };
    const q = await send(R("chat"), { body });
    const acc = q.json.accepts[0];
    const r = await send(R("chat"), { body, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(acc.amount === "9000" && r.status === 200 && seen.chat && seen.chat.stream === false && seen.chat.hasOptions === false && Math.abs(seen.chat.stash - 0.009) < 1e-12, `a chat body is served with stream false and no stream_options, at the quoted amount, with the quote stashed on the request (${JSON.stringify(seen.chat)})`);
    ok(sales.length === 1 && sales[0].quoteUsd === 0.009 && Math.abs(sales[0].priceUsd - 0.00789) < 1e-12, `its sale books the quote gross and net (${sales[0]?.quoteUsd}, ${sales[0]?.priceUsd})`);
    const under = await send(R("chat"), { body: { ...body, max_tokens: 50 }, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(under.status === 402 && under.json?.errorReason === "invalid_exact_evm_payload_authorization_value_mismatch", `an authorization signed for a smaller body does not pay a larger one (${under.status} ${under.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;

  // --- /verify refuses: nothing ran, the claim is given back -------------------------
  {
    fac.mode.verify = () => ({ status: 200, body: { isValid: false, invalidReason: "unattributed_not_accepted", invalidMessage: "free text that is never echoed" } });
    const p = await signPayment(accept);
    const before = runs.echo;
    const r = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === "unattributed_not_accepted" && typeof r.json.errorMessage === "string" && !/free text/.test(r.text) && runs.echo === before && settles() === 0 && sales.length === 0, `a verify refusal: 402 with the facilitator's reason code and a sentence, no handler run, no settle, no sale (${r.status} ${r.json?.errorReason})`);
    fac.mode.verify = () => ({ status: 200, body: { isValid: true } });
    const again = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200, `nothing ran, so its claim was released: the same authorization is served once verify passes (${again.status})`);
    fac.mode.verify = () => ({ status: 500, body: "upstream exploded", type: "text/plain" });
    const down = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(down.status === 503 && down.headers.get("retry-after") === "30" && down.json?.errorReason === "facilitator_unavailable" && runs.echo === before + 1, `a facilitator that gives no verdict: 503 with Retry-After, no handler run (${down.status})`);
    fac.mode.verify = () => ({ status: 200, body: { isValid: true, payer: "0x" + "9".repeat(40) } });
    const other = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(other.status === 402 && runs.echo === before + 1, `a verify that names another payer is refused (${other.status})`);
  }
  fac.reset(); sales.length = 0;

  // --- /settle refuses after the run: held, kept, counted in this route's lane ---------
  {
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment", errorMessage: "free text that is never echoed" } });
    const acct = newAccount();
    const ip = freshIp();
    const p = await signPayment(accept, { account: acct });
    const before = runs.echo;
    const r = await send(R("echo"), { body: { text: "s" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === "invalid_payment" && typeof r.json.errorMessage === "string" && !("transaction" in r.json) && !("echo" in r.json) && !/free text/.test(r.text) && runs.echo === before + 1 && sales.length === 0, `a settle refusal after the handler: 402 with the reason code and a sentence, no answer, no sale (${r.status} ${r.json?.errorReason})`);
    ok(logLines.some((l) => /settle refused after a successful handler \(echo .*reason=invalid_payment/.test(l)), "the settle refusal is logged in one line");
    ok(app1.book.list().length === 0, "a definite refusal leaves nothing open in the book");
    // The buyer funds the wallet and sends the SAME payment again: one more settle, the kept answer, no second run.
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, "0x" + "ab".repeat(32)) } });
    const again = await send(R("echo"), { body: { text: "s" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(again.status === 200 && again.json?.echo === "s" && again.json.run === before + 1 && again.json.transaction === "0x" + "ab".repeat(32) && runs.echo === before + 1 && sales.length === 1 && settles() === 2, `the same payment sent again settles once more and returns the kept answer: the handler did not run a second time (${again.status}, run ${again.json?.run}, ${runs.echo - before} run in all)`);
  }
  fac.reset(); sales.length = 0;
  {
    // Three runs whose settle the facilitator refused for the payment: the fourth is refused before the handler.
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
    const acct = newAccount();
    const ip = freshIp();
    const before = runs.echo;
    for (let i = 0; i < 3; i++) await send(R("echo"), { body: { text: `u${i}` }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } });
    const verifiesBefore = verifies();
    const fourth = await send(R("echo"), { body: { text: "u4" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } });
    ok(runs.echo === before + 3 && fourth.status === 429 && fourth.json?.errorReason === "too_many_unsettled_runs" && /Nothing was charged/.test(fourth.json.errorMessage) && fourth.headers.get("retry-after") && verifies() === verifiesBefore, `after 3 unsettled runs a payer is refused 429 before the handler and before any facilitator call (${fourth.status}, ${runs.echo - before} runs)`);
    const otherAddress = await send(R("echo"), { body: { text: "u5" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": freshIp() } });
    ok(otherAddress.status === 429, `the count is the payer's, whatever address it calls from (${otherAddress.status})`);
    const otherPayerSameAddress = await send(R("echo"), { body: { text: "u6" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": ip } });
    ok(otherPayerSameAddress.status !== 429, `another payer with no unsettled run of its own is never refused for this one's, even from the same address (${otherPayerSameAddress.status})`);
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    const stranger = await send(R("echo"), { body: { text: "ok" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(stranger.status === 200, `another payer on another address is served (${stranger.status})`);
    // A refusal that is about our own request is nobody's unsettled run.
    fac.mode.settle = () => ({ status: 503, body: { success: false, errorReason: "lookup_unavailable" } });
    const ours = newAccount(), oursIp = freshIp();
    for (let i = 0; i < 4; i++) await send(R("echo"), { body: { text: `o${i}` }, headers: { "payment-signature": (await signPayment(accept, { account: ours })).header, "x-test-ip": oursIp } });
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    await wait(1100); // the own-fault cool-down (this server's request kept being refused) ends; the next call probes
    const fifth = await send(R("echo"), { body: { text: "o5" }, headers: { "payment-signature": (await signPayment(accept, { account: ours })).header, "x-test-ip": oursIp } });
    ok(fifth.status === 200, `a refusal about this server's own request (a lookup it could not make) does not count against the buyer (${fifth.status})`);
    // Runs that timed out at our own deadline do not count against the payer.
    const late = newAccount(), lateIp = freshIp();
    const slowBefore = runs.slow;
    await Promise.all([0, 1, 2].map(async () => send(R("slow"), { body: {}, headers: { "payment-signature": (await signPayment(accept, { account: late })).header, "x-test-ip": lateIp } })));
    const next = await send(R("slow"), { body: {}, headers: { "payment-signature": (await signPayment(accept, { account: late })).header, "x-test-ip": lateIp } });
    ok(runs.slow === slowBefore + 4 && next.status === 504 && app1.gate.stats().timeouts >= 4, `a run that ended at the deadline THIS route imposed is not an unsettled run of the payer's: after three of them the fourth still runs (${next.status}, ${runs.slow - slowBefore} runs)`);
    await wait(1700);
  }
  fac.reset(); sales.length = 0;

  // --- a settle whose outcome is not known: the chain decides ---------------------------
  {
    const doubts = [
      ["a 500", { status: 500, body: { error: "x" } }],
      ["a success with no transaction", { status: 200, body: { success: true } }],
      ["a pending settlement", { status: 200, body: { success: false, errorReason: "settle_pending" } }],
      ["an answer that is not JSON", { status: 200, body: "<html>", type: "text/html" }],
      ["an intermediary's 403", { status: 403, body: {} }],
      ["an intermediary's 429", { status: 429, body: {} }],
      ["a settle that names another payer", { status: 200, body: { success: true, transaction: "0x" + "ee".repeat(32), payer: "0x" + "8".repeat(40) } }],
    ];
    for (const [name, answer] of doubts) {
      fac.mode.settle = () => answer;
      const acct = newAccount();
      const ip = freshIp();
      const p = await signPayment(accept, { account: acct });
      const key = gateMod.referralReplayKey(p.authorization);
      const ran = runs.echo;
      const r = await send(R("echo"), { body: { text: "d" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      const entry = app1.book.get(key);
      const unknown = r.status === 402 && r.json?.success === false && r.json.errorReason === "settle_outcome_unknown" && /Send the same PAYMENT-SIGNATURE again/.test(r.json.errorMessage) && !("echo" in r.json);
      // The payment lands after all: the chain says so on the re-send.
      const tx = "0x" + createHash("sha256").update(name).digest("hex");
      fac.land(p.authorization, tx);
      const again = await send(R("echo"), { body: { text: "d" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      const third = await send(R("echo"), { body: { text: "d" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      await quietLedger();
      const booked = sales.filter((s) => s.tx === tx);
      ok(unknown && entry?.state === "in-doubt" && sales.filter((s) => s.payer === acct.address.toLowerCase()).length === 1 && again.status === 200 && again.json?.echo === "d" && again.json.transaction === tx && runs.echo === ran + 1 && booked.length === 1 && third.status === 200 && app1.book.get(key) === null,
        `${name} from /settle: 402 settle_outcome_unknown with the answer withheld and the case in the book; once the chain shows the payment landed, the same payment returns the kept answer with the chain's transaction, one sale, no second run (${r.status} ${r.json?.errorReason}, then ${again.status}, ${booked.length} sale)`);
    }
    ok(logLines.filter((l) => /SETTLE-IN-DOUBT \(echo/.test(l)).length === doubts.length && logLines.filter((l) => /SETTLE-IN-DOUBT resolved by the chain/.test(l)).length === doubts.length, "each is logged as SETTLE-IN-DOUBT, and again when the chain resolves it");
  }
  fac.reset(); sales.length = 0;
  {
    // The sweep and a re-send both find the same landed payment: one sale between them.
    fac.mode.settle = () => ({ status: 500, body: {} });
    const p = await signPayment(accept, { account: newAccount() });
    const ip = freshIp();
    const r = await send(R("echo"), { body: { text: "both" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    const tx = "0x" + "7b".repeat(32);
    fac.land(p.authorization, tx);
    await app1.gate.sweepOnce();
    const again = await send(R("echo"), { body: { text: "both" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    await app1.gate.sweepOnce();
    await quietLedger();
    ok(r.status === 402 && again.status === 200 && again.json?.transaction === tx && sales.filter((x) => x.tx === tx).length === 1, `a landed payment found by the sweep and then by the buyer's re-send is booked once (${sales.filter((x) => x.tx === tx).length} sale)`);
  }
  fac.reset(); sales.length = 0;
  {
    // The answer was lost but the payment had already landed: read at once, delivered in the same response.
    const p = await signPayment(accept, { account: newAccount() });
    const tx = "0x" + "c1".repeat(32);
    fac.mode.settle = () => { fac.land(p.authorization, tx); return { status: 502, body: "bad gateway", type: "text/plain" }; };
    const r = await send(R("echo"), { body: { text: "landed" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
    ok(r.status === 200 && r.json?.echo === "landed" && r.json.transaction === tx && sales.length === 1 && sales[0].tx === tx && sales[0].priceUsd === 0.026298, `a settle answer lost after the payment landed is read from the chain and the answer is delivered with the chain's transaction (${r.status} ${r.text.slice(0, 90)})`);
    // The nonce is spent and nothing proves it paid us: no delivery, no sale.
    const q = await signPayment(accept, { account: newAccount() });
    fac.mode.settle = () => { fac.land(q.authorization, null, "nolog"); return { hang: true }; };
    const t0 = Date.now();
    const r2 = await send(R("echo"), { body: { text: "no log" }, headers: { "payment-signature": q.header, "x-test-ip": freshIp() } });
    ok(r2.status === 402 && r2.json?.errorReason === "settle_outcome_unknown" && !("echo" in r2.json) && !("settlement" in r2.json) && Date.now() - t0 < 5000 && sales.length === 1, `a /settle that never answers ends at the settle timeout; a spent nonce with no proof of payment delivers nothing and books nothing (${r2.status} ${r2.json?.errorReason} after ${Date.now() - t0} ms)`);
    // The chain cannot be read: unknown, never "not charged".
    const u = await signPayment(accept, { account: newAccount() });
    // With no chain head readable BEFORE /verify nothing runs at all.
    fac.mode.rpcDown = true;
    const ranDark = runs.echo, verifiesDark = verifies();
    const r0 = await send(R("echo"), { body: { text: "dark" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    fac.mode.rpcDown = false;
    ok(r0.status === 503 && r0.json?.errorReason === "chain_unavailable" && runs.echo === ranDark && verifies() === verifiesDark && r0.headers.get("retry-after"), `with no chain head readable before /verify the call is answered 503 before anything is sent or run (${r0.status} ${r0.json?.errorReason})`);
    // The chain goes dark during the settle call.
    fac.mode.settle = () => { fac.mode.rpcDown = true; return { status: 500, body: {} }; };
    const r3 = await send(R("echo"), { body: { text: "dark" }, headers: { "payment-signature": u.header, "x-test-ip": freshIp() } });
    fac.mode.rpcDown = false;
    ok(r3.status === 402 && r3.json?.errorReason === "settle_outcome_unknown" && r3.json.retryable === true && sales.length === 1, `with the chain unreadable the outcome stays unknown (${r3.status} ${r3.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;
  {
    // An authorization that expires unused: the re-send says nothing was charged, and nothing is left open.
    const acct = newAccount();
    const p = await signPayment(accept, { account: acct, validBefore: String(Math.floor(Date.now() / 1000) + 8) });
    const key = gateMod.referralReplayKey(p.authorization);
    fac.mode.settle = () => ({ status: 500, body: {} });
    const ip = freshIp();
    const r = await send(R("echo"), { body: { text: "exp" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    skew.ms = 120_000;
    const settlesBefore = settles();
    const again = await send(R("echo"), { body: { text: "exp" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    skew.ms = 0;
    ok(r.status === 402 && r.json?.errorReason === "settle_outcome_unknown" && again.status === 402 && again.json?.errorReason === "authorization_expired_unused" && /Nothing was charged/.test(again.json.errorMessage) && settles() === settlesBefore && app1.book.get(key) === null && sales.length === 0, `an authorization that expired unused: the re-send is told nothing was charged, with no further settle and nothing left in the book (${again.status} ${again.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;
  {
    // The buyer lets the tool run and then spends the nonce some other way: nothing is delivered, nothing is booked.
    for (const kind of ["cancel", "elsewhere", "short", "reverted", "otherpayer"]) {
      fac.mode.settle = () => ({ status: 500, body: {} });
      const acct = newAccount();
      const ip = freshIp();
      const p = await signPayment(accept, { account: acct });
      const key = gateMod.referralReplayKey(p.authorization);
      const ran = runs.echo, trustedBefore = trusted.length;
      const r = await send(R("echo"), { body: { text: "burn" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      fac.land(p.authorization, null, kind);
      const again = await send(R("echo"), { body: { text: "burn" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      const third = await send(R("echo"), { body: { text: "burn" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      await app1.gate.sweepOnce();
      await quietLedger();
      ok(r.status === 402 && again.status === 402 && again.json?.errorReason === "authorization_used_unpaid" && /was not paid/.test(again.json.errorMessage) && !("echo" in again.json) && !("transaction" in again.json) && third.status === 402 && third.json?.errorReason === "authorization_used_unpaid" && sales.filter((x) => x.payer === acct.address.toLowerCase()).length === 0 && app1.book.get(key) === null && runs.echo === ran + 1 && trusted.length === trustedBefore,
        `a nonce spent without paying us (${kind}): the answer is never delivered, no sale is booked by the request, the re-send or the sweep, no allowance is earned, and the book entry is closed as not paid (${again.status} ${again.json?.errorReason}, ${sales.filter((x) => x.payer === acct.address.toLowerCase()).length} sale)`);
    }
    ok(logLines.filter((l) => /spent on chain WITHOUT paying this merchant/.test(l)).length >= 5, "each is logged");
    // Three such runs are three unsettled runs in the payer's lane.
    {
      const acct = newAccount(), ip = freshIp();
      fac.mode.settle = () => ({ status: 500, body: {} });
      const ran = runs.echo;
      for (let i = 0; i < 3; i++) { const p = await signPayment(accept, { account: acct }); await send(R("echo"), { body: { text: "b" }, headers: { "payment-signature": p.header, "x-test-ip": ip } }); fac.land(p.authorization, null, "cancel"); await send(R("echo"), { body: { text: "b" }, headers: { "payment-signature": p.header, "x-test-ip": ip } }); }
      const fourth = await send(R("echo"), { body: { text: "b" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } });
      ok(runs.echo === ran + 3 && fourth.status === 429 && fourth.json?.errorReason === "too_many_unsettled_runs", `and they count against the payer: the fourth call is refused before it runs (${fourth.status})`);
    }
    // The sweep alone meets a spent nonce: closed as not paid, nothing booked.
    {
      const book = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-burn`, log: () => {} }), log });
      const burned = await signPayment(accept, { account: newAccount() });
      const k = gateMod.referralReplayKey(burned.authorization);
      await book.intent({ key: k, slug: "echo", payer: burned.authorization.from, nonce: burned.authorization.nonce, amount: "30000", validBefore: Number(burned.authorization.validBefore) });
      fac.land(burned.authorization, null, "elsewhere");
      const booked = [];
      const out = await book.sweep({ chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 1, budgetMs: 1000 }), payTo: PAY_TO, bookSale: async (e, t) => { booked.push(t); return true; }, graceMs: 0 });
      ok(out.unpaid === 1 && out.landed === 0 && booked.length === 0 && book.get(k) === null, `the sweep books nothing for a nonce spent elsewhere and closes the entry as not paid (${JSON.stringify(out)})`);
    }
  }
  fac.reset(); sales.length = 0;
  {
    // In doubt first, then a refusal that says "already used": the record is kept and the chain decides.
    const acct = newAccount(), ip = freshIp();
    const p = await signPayment(accept, { account: acct });
    const key = gateMod.referralReplayKey(p.authorization);
    fac.mode.settle = () => ({ status: 500, body: {} });
    const r1 = await send(R("echo"), { body: { text: "twice" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "authorization_already_used" } });
    const r2 = await send(R("echo"), { body: { text: "twice" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(r1.status === 402 && r2.status === 402 && r2.json?.errorReason === "settle_outcome_unknown" && !/Nothing was charged/.test(r2.json.errorMessage) && app1.book.get(key)?.state === "in-doubt", `a settle in doubt followed by an "already used" refusal: the buyer is not told nothing was charged, and the book entry stays (${r2.status} ${r2.json?.errorReason}, book ${app1.book.get(key)?.state})`);
    // A later refusal of any kind does not clear an entry that was ever in doubt.
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
    const r3 = await send(R("echo"), { body: { text: "twice" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(r3.status === 402 && r3.json?.errorReason === "settle_outcome_unknown" && app1.book.get(key)?.state === "in-doubt", `nor does any later refusal clear it (${r3.json?.errorReason}, book ${app1.book.get(key)?.state})`);
    // The first submission is mined after all: the sweep books it, and the buyer collects the answer.
    const tx = "0x" + "a9".repeat(32);
    fac.land(p.authorization, tx);
    await app1.gate.sweepOnce();
    await quietLedger();
    const r4 = await send(R("echo"), { body: { text: "twice" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(sales.filter((x) => x.tx === tx).length === 1 && r4.status === 200 && r4.json?.transaction === tx && r4.json.echo === "twice", `when the first transaction then lands the sale is booked, once, and the answer delivered (${sales.filter((x) => x.tx === tx).length} sale, ${r4.status})`);
    // A used-style refusal on a payment never in doubt is read on chain too.
    fac.mode.settle = () => ({ status: 409, body: { success: false, errorReason: "authorization_used" } });
    const u = await signPayment(accept, { account: newAccount() });
    const uKey = gateMod.referralReplayKey(u.authorization);
    const ru = await send(R("echo"), { body: { text: "used" }, headers: { "payment-signature": u.header, "x-test-ip": freshIp() } });
    ok(ru.status === 402 && ru.json?.errorReason === "settle_outcome_unknown" && app1.book.get(uKey)?.state === "in-doubt", `an authorization the facilitator says is already used is read on chain and kept open, never closed on its word (${ru.status} ${ru.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;
  {
    // A re-send that arrives while the first request is still settling sends no second /settle.
    fac.mode.settleDelayMs = 500;
    const p = await signPayment(accept, { account: newAccount() });
    const ip = freshIp();
    const first = send(R("echo"), { body: { text: "slot" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    await wait(200);
    const during = await send(R("echo"), { body: { text: "slot" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    const done = await first;
    fac.mode.settleDelayMs = 0;
    const after = await send(R("echo"), { body: { text: "slot" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    ok(during.status === 409 && during.json?.reason === "inflight" && during.headers.get("retry-after") && done.status === 200 && settles() === 1 && after.status === 200 && after.text === done.text && sales.length === 1, `a re-send during the original settle is told it is in flight: exactly one /settle for the authorization (${during.status}, ${settles()} settle), and the answer is there afterwards`);
  }
  fac.reset(); sales.length = 0;
  {
    // The lane counts runs in flight at admission: a burst cannot all start before the first one ends.
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
    const acct = newAccount(), ip = freshIp();
    const ran = runs.busy;
    const burst = await Promise.all(Array.from({ length: 10 }, async () => send(R("busy"), { body: { text: "burst" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } })));
    ok(runs.busy === ran + 8 && burst.filter((r) => r.status === 429 && r.json?.errorReason === "too_many_runs_in_flight" && r.headers.get("retry-after") === "5").length === 2, `10 concurrent calls from one payer: 8 run (the per-payer in-flight bound), 2 are refused before they start (${runs.busy - ran} ran; ${burst.map((r) => r.status).join(",")})`);
    const after = await send(R("busy"), { body: { text: "after" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } });
    const wait429 = Number(after.headers.get("retry-after"));
    ok(after.status === 429 && after.json?.errorReason === "too_many_unsettled_runs" && wait429 > 0 && wait429 <= 900, `with those 8 unsettled, the payer's next call is refused, Retry-After counted from its oldest unsettled run (${after.status}, ${wait429} s)`);
    // Eight honest wallets behind one address, all paying: every one is served.
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    const shared = await Promise.all(Array.from({ length: 8 }, async () => send(R("busy"), { body: { text: "honest" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": ip } })));
    ok(shared.every((r) => r.status === 200), `eight honest wallets behind the same address as that payer are all served (${shared.map((r) => r.status).join(",")})`);
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
    // A settle whose outcome is not known is an unsettled run until it is proven paid.
    fac.mode.settle = () => ({ status: 500, body: {} });
    const acct2 = newAccount(), ip2 = freshIp();
    const ran2 = runs.echo;
    const held = [];
    for (let i = 0; i < 3; i++) { const p = await signPayment(accept, { account: acct2 }); held.push(p); await send(R("echo"), { body: { text: `d${i}` }, headers: { "payment-signature": p.header, "x-test-ip": ip2 } }); }
    const fourth = await send(R("echo"), { body: { text: "d4" }, headers: { "payment-signature": (await signPayment(accept, { account: acct2 })).header, "x-test-ip": ip2 } });
    ok(runs.echo === ran2 + 3 && fourth.status === 429, `three runs whose settle is in doubt are three unsettled runs: the fourth is refused (${fourth.status}, ${runs.echo - ran2} ran)`);
    fac.land(held[0].authorization, "0x" + "b4".repeat(32));
    const collected = await send(R("echo"), { body: { text: "d0" }, headers: { "payment-signature": held[0].header, "x-test-ip": ip2 } });
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    const fifth = await send(R("echo"), { body: { text: "d5" }, headers: { "payment-signature": (await signPayment(accept, { account: acct2 })).header, "x-test-ip": ip2 } });
    ok(collected.status === 200 && fifth.status === 200, `once one of them is proven paid its note is taken back and the payer is admitted again (${collected.status}, ${fifth.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    // No durable intent, no settle.
    const real = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-nointent`, log: () => {} }), log });
    let down = true;
    const book = { ...real, sweep: real.sweep.bind(real), intent: async (...a) => (down ? false : real.intent(...a)) };
    const app7 = await mount({}, { book });
    try {
      const p = await signPayment(accept, { account: newAccount() });
      const ip = freshIp();
      const ran = runs.echo;
      const r = await send(`${app7.url}/ref/echo`, { body: { text: "nointent" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      ok(r.status === 503 && r.json?.errorReason === "settlement_store_unavailable" && r.headers.get("retry-after") === "30" && /Nothing was charged/.test(r.json.errorMessage) && settles() === 0 && sales.length === 0 && runs.echo === ran + 1, `with the intent not stored /settle is not called: 503 with Retry-After, nothing charged (${r.status} ${r.json?.errorReason}, ${settles()} settle)`);
      const thrower = await mount({}, { book: { ...real, sweep: real.sweep.bind(real), intent: async () => { throw new Error("store down"); } } });
      try {
        const t = await send(`${thrower.url}/ref/echo`, { body: { text: "throws" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
        ok(t.status === 503 && settles() === 0, `the same when the store throws (${t.status})`);
      } finally { await thrower.close(); }
      down = false;
      const beforeAgain = runs.echo;
      const again = await send(`${app7.url}/ref/echo`, { body: { text: "nointent" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      ok(again.status === 200 && again.json?.echo === "nointent" && again.json.run === ran + 1 && runs.echo === beforeAgain && settles() === 1 && sales.length === 1, `the answer was kept: once the store is back the same payment settles and collects it, with no second run (${again.status}, ${settles()} settle)`);
    } finally { await app7.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // Kept answers: the ones nothing is owed on go first; one still owed outlives 200 ordinary calls.
    fac.mode.settle = () => ({ status: 500, body: {} });
    const doubted = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const dip = freshIp();
    const ran = runs.echo;
    await send(R("echo"), { body: { text: "owed" }, headers: { "payment-signature": doubted.header, "x-test-ip": dip } });
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    for (let i = 0; i < 205; i++) await call(R("echo"), { body: { text: `fill${i}` }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(app1.gate.stats().keptAnswers <= 200, `the kept answers stay inside their bound (${app1.gate.stats().keptAnswers})`);
    fac.land(doubted.authorization, "0x" + "0d".repeat(32));
    const restoredBefore = app1.gate.stats().restoredAnswers;
    const got = await send(R("echo"), { body: { text: "owed" }, headers: { "payment-signature": doubted.header, "x-test-ip": dip } });
    ok(got.status === 200 && got.json?.echo === "owed" && got.json.run === ran + 1 && app1.gate.stats().restoredAnswers === restoredBefore, `an in-doubt answer is not pushed out by 205 settled calls: its buyer, once charged, collects it (${got.status})`);
  }
  fac.reset(); sales.length = 0;

  // --- the receipt rule: an authorization is paid only by ITS OWN transfer ------------
  {
    const a1 = { from: newAccount().address, to: PAY_TO, value: "30000", nonce: freshNonce() };
    const tx = "0x" + "ab".repeat(32);
    const pair = (kind) => { fac.used.clear?.(); const t = fac.land(a1, tx, kind); return fac.receipts.get(t); };
    const prove = (r, over = {}) => receiptProvesPayment(r, { tx, from: a1.from, nonce: a1.nonce, payTo: PAY_TO, amount: "30000", merchantId: MERCHANT_ID, payoutAddress: PAYOUT, minNet: "26298", ...over });
    // WHO the split contract paid: the same authorization and transfer, routed differently.
    const routed = {};
    for (const kind of ["paid", "viaforwarder", "payoutonly", "othermerchant", "noevent", "nopayout", "badevent", "otherbuyer", "wronggross"]) routed[kind] = prove(pair(kind));
    ok(routed.paid === "paid", `a payment is OURS when the split contract's routed event names this buyer, this gross and our merchant id and the merchant amount is transferred to our payout wallet, in a transaction sent to the contract (${JSON.stringify(routed)})`);
    ok(routed.payoutonly === "unknown" && routed.viaforwarder === "unknown", `nothing stands in for the routed event: a payout transfer alone is not a payment of ours, and neither is the paid shape in a transaction sent to another contract (${routed.payoutonly}, ${routed.viaforwarder})`);
    ok(routed.othermerchant === "unpaid", `the same authorization and transfer, routed to ANOTHER merchant, is not paid to us (${routed.othermerchant})`);
    ok(["noevent", "nopayout", "badevent", "otherbuyer", "wronggross"].every((k) => routed[k] === "unknown"), `a shape that is not recognized (no event and no payout, our event without its payout, an event of another shape, of another buyer, of another gross) is UNKNOWN: never paid, never unpaid (${JSON.stringify(routed)})`);
    ok(prove(pair("paid"), { merchantId: "7" }) === "unpaid" && prove(pair("paid"), { payoutAddress: OUR_WALLET }) === "unknown" && prove(pair("paid"), { merchantId: null }) === "unknown" && prove(pair("paid"), { minNet: "26299" }) === "paid" && prove(pair("paid"), { minNet: null }) === "paid" && prove(pair("paid"), { minNet: "26298" }) === "paid", "another merchant id configured reads not ours; another payout wallet or no merchant id reads unknown; the SIZE of the merchant amount does not decide it (a share under the expected net is still paid)");
    {
      // Built by hand: each differs from a paid receipt in ONE thing.
      const OTHER = "0x" + "7".repeat(40);
      const net = 26298n;
      const rc = (logs) => ({ transactionHash: tx, status: "0x1", to: PAY_TO, logs: logs.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}` })) });
      const pairOf = (a) => [fac.usedLog(a, 0, 1), fac.transferLog(a.from, PAY_TO, 30000n, 0, 1)];
      const evOurs = (o = {}) => fac.routedLog({ router: PAY_TO, buyer: a1.from, merchantId: MERCHANT_ID, gross: 30000n, merchantAmt: net, ...o }, 0, 1);
      const whole = rc([...pairOf(a1), fac.transferLog(PAY_TO, PAYOUT, net, 0, 1), evOurs()]);
      const payoutFromElsewhere = rc([...pairOf(a1), fac.transferLog(OTHER, PAYOUT, net, 0, 1), evOurs()]);
      const payoutOfAnotherAmount = rc([...pairOf(a1), fac.transferLog(PAY_TO, PAYOUT, net - 1n, 0, 1), evOurs()]);
      const eventFromElsewhere = rc([...pairOf(a1), fac.transferLog(PAY_TO, PAYOUT, net, 0, 1), evOurs({ router: OTHER })]);
      const noFloor = {};
      ok(prove(whole) === "paid" && prove(whole, { minNet: null }) === "paid", "the hand-built whole receipt is paid, with or without an expected net");
      ok(prove(payoutFromElsewhere, noFloor) === "unknown", `a transfer to our payout wallet that does not come FROM the split contract is not its payout (${prove(payoutFromElsewhere, noFloor)})`);
      ok(prove(payoutOfAnotherAmount, noFloor) === "unknown", `a payout that is not exactly the merchant amount the event states is not its payout (${prove(payoutOfAnotherAmount, noFloor)})`);
      ok(prove(eventFromElsewhere, noFloor) === "unknown", `a routed event emitted by another address than the split contract is not read (${prove(eventFromElsewhere, noFloor)})`);
      // Two authorizations of one buyer for one amount in one transaction: only the second is routed.
      const a2 = { from: a1.from, to: PAY_TO, value: "30000", nonce: freshNonce() };
      const two = rc([...pairOf(a1), ...pairOf(a2), fac.transferLog(PAY_TO, PAYOUT, net, 0, 1), evOurs()]);
      ok(prove(two, noFloor) === "unknown" && prove(two, { ...noFloor, nonce: a2.nonce }) === "paid", `what the contract did with an authorization is read only up to the NEXT authorization: the routing after a later one does not prove an earlier one (${prove(two, noFloor)}, ${prove(two, { ...noFloor, nonce: a2.nonce })})`);
    }
    {
      const detail = (kind) => proveReceipt(pair(kind), { tx, from: a1.from, nonce: a1.nonce, payTo: PAY_TO, amount: "30000", merchantId: MERCHANT_ID, payoutAddress: PAYOUT, minNet: "26298" });
      const toUs = Object.fromEntries(["paid", "nopayout", "otherbuyer", "wronggross", "othermerchant", "noevent", "badevent", "payoutonly", "elsewhere"].map((k) => [k, detail(k).routedToUs]));
      ok(toUs.paid === true && toUs.nopayout === true && toUs.otherbuyer === true && toUs.wronggross === true && toUs.othermerchant === false && toUs.noevent === false && toUs.badevent === false && toUs.payoutonly === false && toUs.elsewhere === false && detail("paid").net === "26298" && detail("nopayout").net === null, `the proof says whether the contract's routed event names OUR merchant id, whatever else fails: true with no payout, another buyer or another gross; false for another merchant, no event, an event of another shape, or no transfer into the contract (${JSON.stringify(toUs)})`);
    }
    const { ROUTED_EVENT_TOPIC, ROUTED_EVENT_SIGNATURE } = await import("../src/referral-proof.js");
    ok(ROUTED_EVENT_TOPIC === keccak256(stringToHex(ROUTED_EVENT_SIGNATURE)) && ROUTED_EVENT_TOPIC === ROUTED_TOPIC && prove(pair("othermerchant")) === "unpaid" && prove(pair("othermerchant"), { routedTopic: "0x" + "1".repeat(64) }) === "unknown", "the event topic is the keccak of the documented signature, and a configured topic replaces it (the documented event is then no longer read)");
    const verdicts = {};
    for (const kind of ["paid", "elsewhere", "short", "selftransfer", "othertoken", "otherpayer", "reverted", "wrongtx"]) verdicts[kind] = prove(pair(kind));
    ok(verdicts.paid === "paid" && Object.entries(verdicts).filter(([k]) => k !== "paid").every(([, v]) => v === "unpaid"), `a receipt proves this authorization only by its own Transfer of the amount to the pay-to address, right after its AuthorizationUsed log, in a successful transaction to the pay-to contract with the hash asked: self-transfer, other recipient, short, other token, other payer, reverted, sent to the token, wrong hash all fail (${JSON.stringify(verdicts)})`);
    ok(prove(pair("paid"), { amount: "30001" }) === "unpaid" && prove(pair("paid"), { nonce: freshNonce() }) === "unpaid" && prove(null) === "unknown", "nor a larger amount, nor another nonce; no receipt is unknown");
    // The real token's event order, pinned: AuthorizationUsed then Transfer, consecutive log indexes.
    const real = pair("paid");
    ok(real.logs[0].topics[0] === "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5" && real.logs[1].topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && parseInt(real.logs[1].logIndex, 16) === parseInt(real.logs[0].logIndex, 16) + 1, "the receipt shape the rule reads: the token's AuthorizationUsed log followed directly by its Transfer");
    const swapped = { ...real, logs: [real.logs[1], real.logs[0]].map((l, i) => ({ ...l, logIndex: `0x${i}` })) };
    ok(prove(swapped) === "unpaid", "a Transfer that is not directly after this authorization's log proves nothing");
    // A helper transaction: three authorizations, each followed by a zero self-transfer, then ONE transfer of the amount.
    const three = [0, 1, 2].map(() => ({ from: a1.from, to: PAY_TO, value: "30000", nonce: freshNonce() }));
    const htx = fac.landHelper(three, 30000n, PAY_TO);
    const hv = three.map((x) => receiptProvesPayment(fac.receipts.get(htx), { tx: htx, from: x.from, nonce: x.nonce, payTo: PAY_TO, amount: "30000" }));
    ok(hv.every((v) => v === "unpaid"), `one transfer after several authorizations proves none of them: each must be directly followed by its own (${hv.join(",")})`);
  }
  {
    // One transaction spends three authorizations (zero self-transfers) and moves the amount once: none is paid.
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "insufficient_funds" } });
    const acct = newAccount(), ip = freshIp();
    const ps = [];
    for (let i = 0; i < 3; i++) { const p = await signPayment(accept, { account: acct }); ps.push(p); await send(R("echo"), { body: { text: `h${i}` }, headers: { "payment-signature": p.header, "x-test-ip": ip } }); }
    const helperTx = fac.landHelper(ps.map((p) => p.authorization), 30000n, PAY_TO);
    const answers3 = [];
    for (const p of ps) answers3.push(await send(R("echo"), { body: { text: "h" }, headers: { "payment-signature": p.header, "x-test-ip": ip } }));
    await app1.gate.sweepOnce();
    await quietLedger();
    ok(answers3.every((r) => r.status !== 200 && !("echo" in (r.json || {}))) && sales.filter((x) => x.tx === helperTx).length === 0, `one helper transaction spending three authorizations with one transfer of the amount delivers NOTHING and books nothing (${answers3.map((r) => `${r.status} ${r.json?.errorReason}`).join(", ")})`);
  }
  fac.reset(); sales.length = 0;
  {
    // The facilitator's success is checked against the chain before anything is delivered or booked.
    const ip = freshIp();
    // A made-up hash with no receipt yet: delivered, booked, kept as unconfirmed for the sweep.
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "f1".repeat(32) } });
    const acct1 = newAccount();
    const p1 = await signPayment(accept, { account: acct1 });
    const k1 = gateMod.referralReplayKey(p1.authorization);
    const u = await send(R("echo"), { body: { text: "unconfirmed" }, headers: { "payment-signature": p1.header, "x-test-ip": ip } });
    await wait(50);
    ok(u.status === 200 && u.json?.transaction === "0x" + "f1".repeat(32) && sales.length === 1 && app1.book.get(k1)?.state === "unconfirmed" && app1.gate.stats().unconfirmed >= 1, `a success whose receipt cannot be read yet is delivered and booked, and kept as unconfirmed (${u.status}, ${app1.book.get(k1)?.state})`);
    // The sweep reads it later: a receipt for another transaction CONTRADICTS it.
    fac.receipts.set("0x" + "f1".repeat(32), { transactionHash: "0x" + "f2".repeat(32), status: "0x1", to: PAY_TO, logs: [] });
    await app1.gate.sweepOnce();
    ok(app1.book.get(k1)?.state === "contradicted" && app1.gate.statusWord().status === "attention" && logLines.some((l) => /CONTRADICTS/.test(l)), `the sweep flags it as contradicted and the word reads attention (${app1.book.get(k1)?.state})`);
    // THE HOLD (payer): that answer went out on a success the chain denies. A
    // payment can be made to produce this, so it holds its own payer only.
    const settlesFine = (call) => ({ status: 200, body: { success: true, transaction: fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx()), network: REFERRAL_NETWORK } });
    const keyOfPayment = (p) => gateMod.referralReplayKey(p.authorization);
    {
      fac.mode.settle = settlesFine;
      const neighbor = await send(R("echo"), { body: { text: "neighbor" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      const at = { runs: runs.echo, verifies: verifies(), settles: settles(), sales: sales.length, held: app1.gate.stats().bookFaultHeld };
      const sameAgain = await signPayment(accept, { account: acct1 });
      const refused = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": sameAgain.header, "x-test-ip": freshIp() } });
      const probe = await send(R("echo"), { body: { text: "probe" } });
      ok(app1.book.get(k1)?.scope === "payer" && neighbor.status === 200 && refused.status === 503 && refused.json?.errorReason === "settlement_under_review" && refused.json.retryable === true && refused.headers.get("retry-after") === "300" && /Nothing ran and nothing was charged/.test(refused.json.errorMessage || ""), `while a contradicted entry says an answer went out against the chain, a new payment by ITS payer is answered 503 and every other payer is served (${refused.status} ${refused.json?.errorReason}, neighbor ${neighbor.status}, scope ${app1.book.get(k1)?.scope})`);
      ok(runs.echo === at.runs && verifies() === at.verifies && settles() === at.settles && sales.length === at.sales && app1.book.get(keyOfPayment(sameAgain)) === null && app1.gate.stats().bookFaultHeld === at.held + 1, `and nothing ran, nothing was sent to the facilitator, nothing was booked or recorded for it (${runs.echo - at.runs} runs, ${verifies() - at.verifies} verifies, ${settles() - at.settles} settles)`);
      ok(probe.status === 402 && Array.isArray(probe.json?.accepts) && app1.gate.statusWord().status === "attention", `the unpaid 402 is still quoted, and the word reads attention (${probe.status})`);
      const cleared = await app1.gate.resolveByHand(k1, { note: "the answer went out; the receipt named is another transaction's", outcome: "dismissed" });
      const served = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": sameAgain.header, "x-test-ip": freshIp() } });
      ok(cleared.ok === true && served.status === 200 && served.json?.echo === "held" && runs.echo === at.runs + 1, `the hold ends when the entry resolves, and the refused payment (never claimed) is then served (${served.status})`);
    }
    // A made-up hash whose receipt pays ANOTHER authorization: not delivered, not booked.
    const other = { from: newAccount().address, to: PAY_TO, value: "30000", nonce: freshNonce() };
    const otherTx = fac.land(other);
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: otherTx } });
    const acct2 = newAccount();
    const p2 = await signPayment(accept, { account: acct2 });
    const before = sales.length;
    const c = await send(R("echo"), { body: { text: "contradicted" }, headers: { "payment-signature": p2.header, "x-test-ip": ip } });
    ok(c.status === 402 && !("echo" in (c.json || {})) && sales.length === before && app1.gate.stats().settleContradicted >= 2, `a success naming a transaction that did not pay this authorization: nothing delivered, nothing booked (${c.status} ${c.json?.errorReason})`);
    {
      const k2 = gateMod.referralReplayKey(p2.authorization);
      // THE HOLD (payer): the named transaction never moved this buyer's money
      // into the split contract, so only this payer is held; nobody can close
      // the route for others this way.
      fac.mode.settle = settlesFine;
      const neighbor = await send(R("echo"), { body: { text: "neighbor" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      const ranBefore = runs.echo;
      const sameAgain = await signPayment(accept, { account: acct2 });
      const own = await send(R("echo"), { body: { text: "same payer" }, headers: { "payment-signature": sameAgain.header, "x-test-ip": freshIp() } });
      ok(app1.book.get(k2)?.scope === "payer" && neighbor.status === 200 && own.status === 503 && own.json?.errorReason === "settlement_under_review" && runs.echo === ranBefore, `a contradicted success whose transaction never moved the buyer's money holds that payer only: another payer is served, the same payer is refused before anything runs (${neighbor.status}, ${own.status}; scope ${app1.book.get(k2)?.scope})`);
      skew.ms = 40 * 60_000;
      const laterWord = app1.gate.statusWord();
      skew.ms = 0;
      ok(app1.book.get(k2)?.state === "contradicted" && app1.book.get(k2).tx === otherTx && laterWord.status === "attention" && laterWord.reasons.some((x) => /contradicted is open/.test(x)), `a contradicted success is KEPT as an entry naming the transaction, and the word stays at attention for it (never clears by itself) (${app1.book.get(k2)?.state}; ${laterWord.reasons.join("; ")})`);
      const noNote = await app1.gate.resolveByHand(k2, { note: "" });
      const byHand = await app1.gate.resolveByHand(k2, { note: "checked the transaction by hand: not ours", outcome: "dismissed" });
      ok(noNote.ok === false && byHand.ok === true && byHand.debt === false && app1.book.get(k2) === null && app1.book.resolvedByHand().some((r) => r.key === k2 && /by hand/.test(r.note) && r.state === "contradicted" && r.outcome === "dismissed" && r.debt === false) && (await app1.gate.resolveByHand(k2, { note: "again please" })).ok === false, "an operator resolves it by hand: a note is required, the entry is recorded with the outcome and the note and removed, and a second resolve finds nothing");
      const ownAfter = await send(R("echo"), { body: { text: "same payer" }, headers: { "payment-signature": sameAgain.header, "x-test-ip": freshIp() } });
      ok(ownAfter.status === 200, `and that payer is served again once its entry is resolved (${ownAfter.status})`);
      for (const e of app1.book.list().filter((x) => x.state === "contradicted")) await app1.gate.resolveByHand(e.key, { note: "test cleanup" });
    }
    {
      // THE HOLD (payer): the buyer's transfer reached the split contract and was routed to ANOTHER merchant.
      // An authorization names no merchant, so its signer can present it elsewhere: never a route-wide hold.
      fac.mode.settle = (call) => ({ status: 200, body: { success: true, transaction: fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx(), "othermerchant") } });
      const acct4 = newAccount();
      const p4 = await signPayment(accept, { account: acct4 });
      const k4 = keyOfPayment(p4);
      const misrouted = await send(R("echo"), { body: { text: "misrouted" }, headers: { "payment-signature": p4.header, "x-test-ip": freshIp() } });
      fac.mode.settle = settlesFine;
      const next = await send(R("echo"), { body: { text: "next" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      const ranBefore = runs.echo;
      const own4 = await send(R("echo"), { body: { text: "same payer" }, headers: { "payment-signature": (await signPayment(accept, { account: acct4 })).header, "x-test-ip": freshIp() } });
      ok(misrouted.status === 409 && misrouted.json?.errorReason === "settled_to_another_merchant" && !("echo" in (misrouted.json || {})) && app1.book.get(k4)?.state === "contradicted" && app1.book.get(k4).scope === "payer" && next.status === 200 && own4.status === 503 && own4.json?.errorReason === "settlement_under_review" && runs.echo === ranBefore, `a success whose transaction routed the buyer's money to another merchant holds THAT payer only: the next buyer is served (${misrouted.status} ${misrouted.json?.errorReason}; scope ${app1.book.get(k4)?.scope}; next ${next.status}; same payer ${own4.status})`);
      ok(app1.book.faults().every((f) => f.scope === "payer") && createReferralBook({ doc: { loadSync: () => ({ entries: { a: { key: "a", payer: "0x1", state: "contradicted" }, b: { key: "b", payer: "0x2", state: "contradicted", scope: "route" }, c: { key: "c", payer: "0x3", state: "unconfirmed", flagged: true }, d: { key: "d", payer: "0x4", state: "unconfirmed" } } }), load: async () => null, update: async () => ({ ok: false }) }, log }).faults().map((f) => `${f.key}:${f.scope}`).join(",") === "a:payer,b:route,c:route", "a contradicted entry with no scope written on it holds its payer only; the route is held only by a scope written as route or by a flagged unconfirmed entry");
      await app1.gate.resolveByHand(k4, { note: "test cleanup: routed elsewhere" });
      // THE HOLD (route): an unconfirmed success flagged because its receipt still cannot be read.
      fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "f5".repeat(32) } });
      const p5 = await signPayment(accept, { account: newAccount() });
      const k5 = keyOfPayment(p5);
      const u5 = await send(R("echo"), { body: { text: "no receipt" }, headers: { "payment-signature": p5.header, "x-test-ip": freshIp() } });
      await wait(50);
      fac.mode.settle = settlesFine;
      const unflagged = await send(R("echo"), { body: { text: "before the flag" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      skew.ms = 4 * 60_000;
      await app1.gate.sweepOnce();
      skew.ms = 0;
      const ranFlag = runs.echo;
      const waiting = await signPayment(accept, { account: newAccount() });
      const flaggedRefusal = await send(R("echo"), { body: { text: "flagged" }, headers: { "payment-signature": waiting.header, "x-test-ip": freshIp() } });
      ok(u5.status === 200 && unflagged.status === 200 && app1.book.get(k5)?.state === "unconfirmed" && app1.book.get(k5).flagged === true && flaggedRefusal.status === 503 && flaggedRefusal.json?.errorReason === "settlement_under_review" && runs.echo === ranFlag && app1.gate.statusWord().status === "attention", `an unconfirmed success is served past while it is fresh; once it is flagged (no receipt after 3 minutes) a new payment is refused before anything runs (${unflagged.status} then ${flaggedRefusal.status}; flagged ${app1.book.get(k5)?.flagged})`);
      fac.land(p5.authorization, "0x" + "f5".repeat(32));
      await app1.gate.sweepOnce();
      const resumed = await send(R("echo"), { body: { text: "flagged" }, headers: { "payment-signature": waiting.header, "x-test-ip": freshIp() } });
      ok(app1.book.get(k5) === null && resumed.status === 200 && resumed.json?.echo === "flagged", `the hold clears by itself when the receipt proves the payment (${app1.book.get(k5)?.state ?? "closed"}, ${resumed.status})`);
    }
    // The sweep confirms an unconfirmed one whose receipt appears and proves it.
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "f3".repeat(32) } });
    const p3 = await signPayment(accept, { account: newAccount() });
    const k3 = gateMod.referralReplayKey(p3.authorization);
    const u3 = await send(R("echo"), { body: { text: "later" }, headers: { "payment-signature": p3.header, "x-test-ip": ip } });
    await wait(50);
    fac.land(p3.authorization, "0x" + "f3".repeat(32));
    await app1.gate.sweepOnce();
    ok(u3.status === 200 && app1.book.get(k3) === null, `an unconfirmed payment whose receipt then proves it is closed by the sweep (${app1.book.get(k3)?.state ?? "closed"})`);
  }
  fac.reset(); sales.length = 0;
  {
    // T1: the proof is searched from the head recorded with the intent, however late the read.
    fac.mode.settle = () => ({ status: 500, body: {} });
    const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const key = gateMod.referralReplayKey(p.authorization);
    const headAtIntent = fac.chainState.head;
    const r = await send(R("echo"), { body: { text: "late" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
    ok(r.status === 402 && app1.book.get(key)?.fromBlock === headAtIntent, `the intent records the chain head (${app1.book.get(key)?.fromBlock})`);
    // The payment lands 10 blocks later; the sweep first reads it 50,000 blocks after that (far past any fixed look-back).
    fac.land(p.authorization, "0x" + "7a".repeat(32), "paid", { block: headAtIntent + 10 });
    fac.chainState.head = headAtIntent + 50_000;
    await app1.gate.sweepOnce();
    await quietLedger();
    fac.chainState.head = headAtIntent;
    ok(sales.filter((x) => x.tx === "0x" + "7a".repeat(32)).length === 1 && app1.book.get(key)?.state === "charged-undelivered", `a payment read 50,000 blocks after it landed is still found and booked (${app1.book.get(key)?.state})`);
    // A spent nonce whose log cannot be found: unknown while it lives; closed once expired and fully searched.
    const q = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const kq = gateMod.referralReplayKey(q.authorization);
    await send(R("echo"), { body: { text: "nolog" }, headers: { "payment-signature": q.header, "x-test-ip": freshIp() } });
    fac.land(q.authorization, null, "nolog");
    const unpaidBefore = app1.gate.stats().usedUnpaid;
    await app1.gate.sweepOnce();
    const whileValid = app1.book.get(kq)?.state;
    ok(whileValid === "in-doubt" && app1.gate.stats().usedUnpaid === unpaidBefore, `while the authorization lives, a spent nonce with no log found stays in doubt (${whileValid})`);
    skew.ms = 3600_000;
    await app1.gate.sweepOnce();
    skew.ms = 0;
    ok(app1.book.get(kq) === null && app1.gate.stats().usedUnpaid === unpaidBefore + 1, `a nonce spent with no log of ours, read long past its expiry with a COMPLETE search from the head recorded before /verify, is closed as not paid (${app1.book.get(kq)?.state ?? "closed"}, ${app1.gate.stats().usedUnpaid - unpaidBefore} counted)`);
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // T2/T3: an owed answer is kept ten minutes, in memory and at rest; past that a charged buyer is owed back the gross.
    ok(gateMod.REFERRAL_ANSWER_RETENTION_MS === 10 * 60_000 && gateMod.REFERRAL_ANSWER_GRACE_MS === 15 * 60_000, "an answer is kept ten minutes after it is produced (the privacy page's bound for a paid answer kept against its payment), never past the authorization plus fifteen minutes");
    const store = createReferralAnswerStore({ now: () => Date.now() + skew.ms });
    const app9 = await mount({}, { answers: store });
    try {
      // A delivered call's answer is kept in memory for a re-send, ten minutes at most.
      const d = await send(`${app9.url}/ref/echo`, { body: { text: "delivered" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(d.status === 200 && app9.gate.stats().keptAnswers === 1, `a delivered answer is held for a re-send (${app9.gate.stats().keptAnswers})`);
      skew.ms = 11 * 60_000;
      await app9.gate.sweepOnce();
      skew.ms = 0;
      ok(app9.gate.stats().keptAnswers === 0, `and is dropped from memory by the next pass once ten minutes have passed (${app9.gate.stats().keptAnswers})`);
      fac.mode.settle = () => ({ status: 500, body: {} });
      const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
      const key = gateMod.referralReplayKey(p.authorization);
      await send(`${app9.url}/ref/echo`, { body: { text: "kept" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      const atRestNow = await store.get(key);
      fac.land(p.authorization, "0x" + "6b".repeat(32));
      skew.ms = 11 * 60_000;
      const atRestExpired = await store.get(key);
      // Before any sweep, a re-send past the retention is not served the answer.
      const late = await send(`${app9.url}/ref/echo`, { body: { text: "kept" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      ok(atRestExpired === null && late.status === 409 && late.json?.errorReason === "answer_unavailable_refund_owed" && !/kept/.test(late.json?.echo || ""), `past ten minutes the answer is not served from memory or rest, even before a sweep: the charged buyer is told it is owed back (${late.status} ${late.json?.errorReason})`);
      await app9.gate.sweepOnce();
      await quietLedger();
      const atRestAfter = await store.get(key);
      skew.ms = 0;
      const row = owed.find((o) => o.tx === "0x" + "6b".repeat(32));
      ok(atRestNow && atRestNow.text.includes("kept") && atRestAfter === null && app9.gate.stats().keptAnswers === 0, `the answer is at rest while owed and gone from memory and rest after ten minutes (${!!atRestNow} then ${atRestAfter})`);
      ok(row && row.httpStatus === 402 && row.hangupReason === null && row.priceUsd === 0.03 && row.payer === p.authorization.from.toLowerCase() && row.network === "eip155:8453" && row.wire === "referral" && app9.book.get(key)?.state === "refund-owed", `a payment proven landed whose answer has expired is recorded as owed back at the GROSS, with the paying transaction, and the case closed (${row?.priceUsd}, ${app9.book.get(key)?.state})`);
      const again = await send(`${app9.url}/ref/echo`, { body: { text: "kept" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      ok(again.status === 409 && again.json?.errorReason === "answer_unavailable_refund_owed" && owed.filter((o) => o.tx === row?.tx).length === 1, `the buyer's re-send is told it is owed back, and nothing is owed twice (${again.status})`);
    } finally { await app9.close(); }
  }
  {
    // One payer's open settlements are its own share; at capacity only an
    // in-doubt entry whose authorization has expired is retired, on record.
    const clock = { t: 1_800_000_000_000 };
    const lines = [];
    const bk = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-share`, log: () => {} }), log: { error: (m) => lines.push(m), log: () => {} }, now: () => clock.t, maxEntries: 4, maxPerPayer: 2 });
    const soon = Math.floor(clock.t / 1000) + 600;
    const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20), D = "0x" + "d4".repeat(20);
    const put = (key, payer) => bk.intent({ key, slug: "echo", payer, nonce: "0x" + key.padStart(64, "0"), amount: "30000", validBefore: soon });
    const a1 = await put("a1", A), a2 = await put("a2", A), a3 = await put("a3", A.toUpperCase().replace("0X", "0x"));
    ok(a1 && a2 && a3 === false && bk.roomFor(A) === false && bk.roomFor(B) === true && bk.full() === false && bk.size() === 2, `a payer at its own share is refused a new entry in any letter case while another payer has room (${a1} ${a2} ${a3})`);
    ok((await put("a1", A)) === true && bk.size() === 2, "a payer at its share still rewrites an entry it already holds (a retry of the same payment)");
    const b1 = await put("b1", B), c1 = await put("c1", C);
    await bk.resolve("a1", { state: "in-doubt" }); await bk.resolve("a2", { state: "charged-undelivered", tx: "0x" + "77".repeat(32) }); await bk.resolve("b1", { state: "in-doubt" });
    ok(b1 && c1 && bk.full() === true && bk.roomFor(D) === false && (await put("d1", D)) === false && bk.size() === 4 && bk.retiredAtCapacity().length === 0, "at capacity with every authorization still sendable nothing is retired and a new entry is refused");
    clock.t += 600_000 + 120_000 + 1;
    await bk.resolve("c1", { state: "refund-owed" });
    ok(bk.full() === false && bk.roomFor(D) === true, "once an in-doubt entry's authorization has expired the book reads as having room");
    const d1 = await bk.intent({ key: "d1", slug: "echo", payer: D, nonce: "0x" + "d1".padStart(64, "0"), amount: "30000", validBefore: Math.floor(clock.t / 1000) + 600 });
    const gone = bk.retiredAtCapacity();
    ok(d1 === true && bk.get("a1") === null && gone.length === 1 && gone[0].key === "a1" && gone[0].payer === A && gone[0].state === "in-doubt" && bk.size() === 4 && lines.some((m) => /retired to the operator record/.test(m)), `at capacity the OLDEST expired in-doubt entry is retired to the record with an error line (${gone.map((g) => g.key)})`);
    const e1 = await bk.intent({ key: "e1", slug: "echo", payer: "0x" + "e5".repeat(20), nonce: "0x" + "e1".padStart(64, "0"), amount: "30000", validBefore: Math.floor(clock.t / 1000) + 600 });
    ok(e1 === true && bk.get("b1") === null && bk.retiredAtCapacity().length === 2, "the next expired in-doubt entry is retired in turn");
    const f1 = await bk.intent({ key: "f1", slug: "echo", payer: "0x" + "f6".repeat(20), nonce: "0x" + "f1".padStart(64, "0"), amount: "30000", validBefore: Math.floor(clock.t / 1000) + 600 });
    ok(f1 === false && bk.get("a2")?.state === "charged-undelivered" && bk.get("c1")?.state === "refund-owed" && bk.retiredAtCapacity().length === 2 && bk.full() === true, "a charged or owed entry is never retired: with only those and live intents left the book refuses");
  }
  {
    // The gate refuses a payer whose own share is spent, and serves another payer.
    const shared = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-payershare`, log: () => {} }), log, maxEntries: 10, maxPerPayer: 1 });
    const appS = await mount({}, { book: shared });
    try {
      const heavy = newAccount();
      fac.mode.settle = () => ({ status: 500, body: {} });
      await send(`${appS.url}/ref/echo`, { body: { text: "first" }, headers: { "payment-signature": (await signPayment(accept, { account: heavy })).header, "x-test-ip": freshIp() } });
      const ranBefore = runs.echo, verifiesBefore = verifies();
      const again = await send(`${appS.url}/ref/echo`, { body: { text: "second" }, headers: { "payment-signature": (await signPayment(accept, { account: heavy })).header, "x-test-ip": freshIp() } });
      ok(again.status === 503 && again.json?.errorReason === "settlement_book_full" && runs.echo === ranBefore && verifies() === verifiesBefore && shared.size() === 1, `a payer holding its whole share is refused before /verify and the handler (${again.status} ${again.json?.errorReason})`);
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
      const other = await send(`${appS.url}/ref/echo`, { body: { text: "other" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(other.status === 200 && runs.echo === ranBefore + 1, `another payer is served while the first payer's share is spent (${other.status})`);
    } finally { await appS.close(); }
  }
  {
    // A full book refuses a new settlement before /settle; it never drops an owed one.
    const small = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-full`, log: () => {} }), log, maxEntries: 1 });
    const app10 = await mount({}, { book: small });
    try {
      fac.mode.settle = () => ({ status: 500, body: {} });
      const p1 = await signPayment(accept, { account: newAccount() });
      await send(`${app10.url}/ref/echo`, { body: { text: "first" }, headers: { "payment-signature": p1.header, "x-test-ip": freshIp() } });
      const settlesBefore = settles();
      const verifiesFull = verifies(), ranBeforeFull = runs.echo;
      const r = await send(`${app10.url}/ref/echo`, { body: { text: "second" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(runs.echo === ranBeforeFull && verifies() === verifiesFull && r.status === 503 && r.json?.errorReason === "settlement_book_full" && settles() === settlesBefore && small.get(gateMod.referralReplayKey(p1.authorization))?.state === "in-doubt" && app10.gate.statusWord().status === "attention", `a full book: the next paid call is refused 503 BEFORE /verify and the handler (nothing sent, nothing run, nothing charged), the open entry kept, the word reads attention (${r.status} ${r.json?.errorReason})`);
    } finally { await app10.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // M3: only a truly empty request runs the example.
    const typed = await fetch(R("chatx"), { method: "POST", headers: { "content-type": "text/plain" }, body: "a real question" });
    const typedJson = await typed.json();
    const form = await fetch(R("chatx"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "q=a+real+question" });
    const formJson = await form.json();
    const arr = await send(R("chatx"), { body: ["a", "real", "question"] });
    ok(typedJson.accepts?.[0]?.amount === "1000" && formJson.accepts?.[0]?.amount === "1000" && arr.json?.accepts?.[0]?.amount === "1000", `a text, form or JSON-array body is not an empty request: quoted at the route's own price, never the example's (${typedJson.accepts?.[0]?.amount}, ${formJson.accepts?.[0]?.amount}, ${arr.json?.accepts?.[0]?.amount})`);
    const acc = (await send(R("exa"), { method: "GET" })).json.accepts[0];
    const paidText = await fetch(R("exa"), { method: "POST", headers: { "content-type": "text/plain", "payment-signature": (await signPayment(acc)).header }, body: "a real question" });
    const paidTextJson = await paidText.json();
    ok(paidText.status === 200 && paidTextJson.got === null, `a paid call with a text body is served as the direct route serves it, never as the example (${paidText.status} ${JSON.stringify(paidTextJson).slice(0, 80)})`);
    const viaEmptyObject = await send(R("exa"), { method: "POST", body: {}, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(viaEmptyObject.json?.got === "the published example", "a JSON body of exactly {} still runs the example");
  }
  fac.reset(); sales.length = 0;
  {
    // M5: the service-wide bound tightens never-paid wallets only, and refuses nobody for others' failures alone.
    const app11 = await mount({ REFERRAL_UNSETTLED_GLOBAL_MAX: "2" });
    try {
      fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
      const call11 = async (acct, ip) => send(`${app11.url}/ref/echo`, { body: { text: "g" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } });
      const A = newAccount(), B = newAccount();
      await call11(A, freshIp()); await call11(B, freshIp());
      const fresh = newAccount(), freshAddr = freshIp();
      const firstFresh = await call11(fresh, freshAddr);
      const secondFresh = await call11(fresh, freshAddr);
      const paidOne = newAccount();
      paidPayers.add(paidOne.address.toLowerCase());
      await call11(paidOne, freshIp());
      const paidSecond = await call11(paidOne, freshIp());
      const clean = await call11(newAccount(), freshIp());
      ok(firstFresh.status === 402 && secondFresh.status === 429 && paidSecond.status === 402 && clean.status === 402, `with 2 distinct failing payers, a never-paid wallet is held after ONE unsettled run (${secondFresh.status}); one that has paid before keeps its three (${paidSecond.status}); a wallet with none is served (${clean.status})`);
    } finally { await app11.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // T4b: an intermediary's answer at /verify is no verdict on the payment.
    for (const [name, answer] of [["a 429", { status: 429, body: {} }], ["a 403 page", { status: 403, body: "<html>blocked</html>", type: "text/html" }], ["an undocumented 418", { status: 418, body: { errorReason: "teapot" } }]]) {
      fac.mode.verify = () => answer;
      const notes = limiter.notes, ran = runs.echo;
      const r = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(r.status === 503 && r.json?.errorReason === "facilitator_unavailable" && limiter.notes === notes && runs.echo === ran, `${name} at /verify: 503 facilitator_unavailable, nothing ran, nothing counted against the buyer (${r.status} ${r.json?.errorReason})`);
    }
    fac.reset();
    // T4c: a payer screen that throws refuses (fails closed).
    const app12 = await mount({}, { payerScreen: async () => { throw new Error("screen down"); } });
    try {
      const ran = runs.echo;
      const r = await send(`${app12.url}/ref/echo`, { body: { text: "s" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(r.status === 503 && r.json?.errorReason === "payer_screen_unavailable" && runs.echo === ran && verifies() === 0, `a payer screen that cannot answer refuses: 503, nothing ran, nothing sent (${r.status} ${r.json?.errorReason})`);
    } finally { await app12.close(); }
    // T4d: the word, on a fresh gate.
    const app13 = await mount();
    try {
      ok(app13.gate.statusWord().status === "ok", "a fresh gate's word reads ok");
      fac.mode.settle = () => ({ status: 500, body: {} });
      await send(`${app13.url}/ref/echo`, { body: { text: "w" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      const early = app13.gate.statusWord().status;
      skew.ms = 11 * 60_000;
      const oneCall = app13.gate.statusWord();
      skew.ms = 0;
      await send(`${app13.url}/ref/echo`, { body: { text: "w2" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      skew.ms = 11 * 60_000;
      const twoCalls = app13.gate.statusWord();
      ok(oneCall.status === "ok" && twoCalls.status === "attention" && twoCalls.reasons.some((x) => /not answered for 10 minutes/.test(x)), `ONE unanswered call and then no traffic does not read attention after ten minutes; a second unanswered call does (${oneCall.status}, then ${twoCalls.reasons.join("; ")})`);
      skew.ms = 16 * 60_000;
      const late = app13.gate.statusWord();
      skew.ms = 0;
      ok(early === "ok" && late.status === "attention" && late.reasons.some((x) => /open past 15 minutes/.test(x)), `an entry in doubt past fifteen minutes reads attention (${early}; ${late.reasons.join("; ")})`);
    } finally { await app13.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // T5: the settle client does not follow a redirect, keeps no raw text, and caps the answer it reads.
    fac.mode.settle = () => ({ status: 302, body: "", headers: { location: "/elsewhere" } });
    const r1 = await send(R("echo"), { body: { text: "r" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(r1.status === 402 && r1.json?.errorReason === "settle_outcome_unknown" && !fac.calls.some((c) => c.path === "/elsewhere"), `a redirect from /settle is not followed (the signed request and the buyer's authorization go nowhere else) and the outcome is in doubt (${r1.status} ${r1.json?.errorReason})`);
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "Refused <b>because</b> of THINGS" } });
    const r2 = await send(R("echo"), { body: { text: "r" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(r2.status === 402 && /^[a-z0-9_]+$/.test(r2.json?.errorReason || "") && !/THINGS|<b>/.test(r2.text) && !logLines.some((l) => /THINGS/.test(l)), `the facilitator's raw text is never the reason: the buyer and the log get a code (${r2.json?.errorReason})`);
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()), pad: "x".repeat(70 * 1024) } });
    const r3 = await send(R("echo"), { body: { text: "big" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(r3.status === 200 && r3.json?.echo === "big" && app1.gate.stats().landedAfterDoubt >= 1, `an answer from /settle past the 64 KB cap is not read: the outcome is decided by the chain instead (${r3.status})`);
    // The operator view never carries an answer or a signed payment.
    const listed = JSON.stringify(app1.book.list());
    ok(!/signature|"text"|paymentPayload|"payment"|"answer"/.test(listed), "the book's list (the operator view) holds no answer and no signed payment");
    // A non-ASCII referrer token is not altered: it is not echoed.
    const na = await fetch(R("echo"), { method: "GET", headers: { "x-referrer-token": Buffer.from([0x41, 0xff, 0x42]).toString("latin1") } });
    ok(na.status === 402 && (await na.json()).extensions.attributionToken === "", "a referrer token that is not printable ASCII is not echoed (it could not come back as the bytes sent)");
    // The router worker is never handed the signer key.
    const { _routerPoolForTest } = await import("../src/router-pool.js");
    process.env.REFERRAL_SIGNER_KEY = SIGNER_KEY;
    const wenv = _routerPoolForTest.workerEnv();
    delete process.env.REFERRAL_SIGNER_KEY;
    ok(!("REFERRAL_SIGNER_KEY" in wenv) && !JSON.stringify(wenv).includes(KEY_HEX), "the router worker's environment does not carry the referral signer key");
  }
  fac.reset(); sales.length = 0;

  {
    // The refund path's proof (src/payment-verify.js) for a referral row: a transfer from the payer to the split contract.
    const { verifyInboundPayment } = await import("../src/payment-verify.js");
    const payer = newAccount().address.toLowerCase();
    const pad = (x) => `0x${"0".repeat(24)}${x.slice(2).toLowerCase()}`;
    const txR = "0x" + "a".repeat(64);
    const authR = { from: payer, to: PAY_TO, value: "30000", nonce: freshNonce() };
    const receiptOf = (kind) => { fac.land(authR, txR, kind); return fac.receipts.get(txR); };
    const run = (receipt, over = {}) => verifyInboundPayment({ network: "eip155:8453", payer, amountUsd: 0.03, tx: txR, wire: "referral", referralPayTo: PAY_TO, referralMerchantId: MERCHANT_ID, referralPayout: PAYOUT, rpcFor: () => "http://rpc.invalid", fetchImpl: async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: j.method === "eth_getTransactionReceipt" ? receipt : "0x6" }), { status: 200 }); }, ...over });
    const good = await run(receiptOf("paid"));
    const otherMerchant = await run(receiptOf("othermerchant"));
    const unrouted = await run(receiptOf("noevent"));
    const self = await run(receiptOf("selftransfer"));
    const noMerchant = await run(receiptOf("paid"), { referralMerchantId: null });
    const noPayout = await run(receiptOf("paid"), { referralPayout: null });
    const noPayTo = await run(receiptOf("paid"), { referralPayTo: null });
    const otherNet = await run(receiptOf("paid"), { network: "eip155:137" });
    const short = await run(receiptOf("paid"), { amountUsd: 0.04 });
    ok(good.verified === true && [otherMerchant, unrouted, self, noMerchant, noPayout, noPayTo, otherNet, short].every((x) => x.verified === false), `a refund of a referral row is proven only by the gate's own rule: the payer's transfer into the split contract ROUTED to this merchant and paid out to its wallet, on Base (ours: ${good.verified}; routed to another merchant, not routed at all, a self-transfer, no merchant id, no payout wallet, no pay-to, another chain, a larger amount: ${[otherMerchant, unrouted, self, noMerchant, noPayout, noPayTo, otherNet, short].map((x) => x.verified).join("/")})`);
  }

  // ======== round 4 ====================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R1. The buyer settles the SAME authorization under another merchant while our handler runs.
    const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const key = gateMod.referralReplayKey(p.authorization);
    const theirs = "0x" + "c1".repeat(32);
    fac.mode.settle = (c) => { fac.land(c.json.paymentPayload.payload.authorization, theirs, "othermerchant"); return { status: 409, body: { errorReason: "authorization_used" } }; };
    const ip = freshIp();
    const r = await send(R("echo"), { body: { text: "stolen" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    const again = await send(R("echo"), { body: { text: "stolen" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    skew.ms = 11 * 60_000;
    await app1.gate.sweepOnce();
    skew.ms = 0;
    await quietLedger();
    ok(r.status === 402 && r.json?.errorReason === "authorization_used_unpaid" && !("echo" in r.json) && again.status === 402 && sales.length === 0 && owed.length === 0 && app1.book.get(key) === null, `an authorization the split contract routed to ANOTHER merchant (its transfer into the contract is on chain) delivers nothing, books nothing and owes nothing, on the call, the re-send and the sweep (${r.status} ${r.json?.errorReason}, ${sales.length} sale, ${owed.length} owed)`);
    // A shape that is not recognized is held: never delivered, never closed as unpaid.
    const u = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const ku = gateMod.referralReplayKey(u.authorization);
    fac.mode.settle = (c) => { fac.land(c.json.paymentPayload.payload.authorization, "0x" + "c2".repeat(32), "noevent"); return { status: 500, body: {} }; };
    const r2 = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": u.header, "x-test-ip": freshIp() } });
    await app1.gate.sweepOnce();
    skew.ms = 3600_000;
    await app1.gate.sweepOnce();
    const word = app1.gate.statusWord();
    skew.ms = 0;
    const heldU = app1.book.get(ku);
    ok(r2.status === 402 && r2.json?.errorReason === "settle_outcome_unknown" && heldU?.state === "in-doubt" && heldU.unproven === true && heldU.moved === true && sales.length === 0 && owed.length === 1 && owed[0].priceUsd === 0.03 && owed[0].wire === "referral-operator" && word.status === "attention", `a payment into the split contract with no routing this server recognizes is UNKNOWN: held in the book past its expiry, not delivered, not booked, not closed, the word at attention, and the buyer, whose transfer is on chain, is owed the gross back (${r2.status}, ${app1.book.get(ku)?.state}, ${word.status})`);
    const done = await app1.gate.resolveByHand(ku, { note: "read the transaction: funds not routed to us" });
    ok(done.ok && app1.book.get(ku) === null, "and an operator can close it by hand");
    // The settings are required: without the merchant id or the payout wallet the gate is off.
    ok(referralConfig({ ...ENV, REFERRAL_MERCHANT_ID: "" }) === null && referralConfig({ ...ENV, REFERRAL_PAYOUT_ADDRESS: "" }) === null && referralConfig({ ...ENV, REFERRAL_MERCHANT_ID: "0x2a" }) === null && referralConfig({ ...ENV, REFERRAL_PAYOUT_ADDRESS: PAY_TO }) === null && referralConfig({ ...ENV, REFERRAL_ROUTED_TOPIC: "0x12" }) === null && referralConfig(ENV)?.merchantId === MERCHANT_ID && referralConfig(ENV).payoutAddress === PAYOUT, "REFERRAL_MERCHANT_ID and REFERRAL_PAYOUT_ADDRESS are required (a number; an address that is not the pay-to contract), and a routed-event topic must be 32 bytes");
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R2. The head is read BEFORE /verify: a cancel that lands during the run is inside the search.
    const h0 = fac.chainState.head;
    const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const key = gateMod.referralReplayKey(p.authorization);
    fac.mode.verify = (c) => { fac.land(c.json.paymentPayload.payload.authorization, null, "cancel", { block: h0 + 1 }); fac.chainState.head = h0 + 10; return { status: 200, body: { isValid: true } }; };
    let fromBlockSeen = null;
    fac.mode.settle = () => { fromBlockSeen = app1.book.get(key)?.fromBlock ?? null; return { status: 409, body: { errorReason: "authorization_used" } }; };
    const r = await send(R("echo"), { body: { text: "canceled" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
    fac.chainState.head = h0;
    ok(fromBlockSeen === h0 && r.status === 402 && r.json?.errorReason === "authorization_used_unpaid" && app1.book.get(key) === null, `the search starts at the head read before /verify (${fromBlockSeen} of ${h0}), so an authorization canceled while the call ran is found and closed as not paid, never left unknown (${r.status} ${r.json?.errorReason}, ${app1.book.get(key)?.state ?? "closed"})`);
    // The complete-search flag, on the reader itself.
    const reader = createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 1, budgetMs: 1500, timeoutMs: 500 });
    const q = { from: newAccount().address, to: PAY_TO, value: "30000", nonce: freshNonce() };
    fac.land(q, null, "nolog");
    const anchored = await reader.state({ from: q.from, nonce: q.nonce, payTo: PAY_TO, amount: "30000", fromBlock: fac.chainState.head - 5 });
    const loose = await reader.state({ from: q.from, nonce: q.nonce, payTo: PAY_TO, amount: "30000" });
    const past = { validBeforeMs: Date.now() - 600_000 }, live = { validBeforeMs: Date.now() + 60_000 };
    ok(anchored.used === true && anchored.paid === null && anchored.complete === true && chainVerdict(anchored, past) === "unpaid" && chainVerdict(anchored, live) === "unknown" && loose.complete === false && chainVerdict(loose, past) === "unknown", `a spent nonce with no log is not paid only when expired AND a complete search from a recorded head found nothing; with no recorded head it stays unknown (${anchored.complete}/${loose.complete})`);
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R3a. A hang-up during settle while the receipt lags, then a re-send: the answer, and NO debt.
    fac.mode.settleDelayMs = 400;
    fac.mode.receiptDown = true;
    const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const key = gateMod.referralReplayKey(p.authorization);
    const ip = freshIp();
    const outcome = await rawPost(R("echo"), { text: "lagging" }, { "payment-signature": p.header, "x-test-ip": ip }, 150);
    await wait(700);
    const afterHangup = app1.book.get(key);
    fac.mode.settleDelayMs = 0;
    const fetched = await send(R("echo"), { body: { text: "lagging" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    await wait(60);
    const afterDelivery = app1.book.get(key);
    ok(outcome === "aborted" && afterHangup?.state === "unconfirmed" && afterHangup.delivered !== true && fetched.status === 200 && fetched.json?.echo === "lagging" && afterDelivery?.state === "unconfirmed" && afterDelivery.delivered === true, `a hang-up during settle with the receipt not readable keeps the entry UNCONFIRMED (never charged-undelivered on the facilitator's word); the re-send delivers and sets the delivered mark (${afterHangup?.state} -> ${afterDelivery?.state}, delivered ${afterDelivery?.delivered})`);
    fac.mode.receiptDown = false;
    skew.ms = 11 * 60_000;
    await app1.gate.sweepOnce();
    await app1.gate.sweepOnce();
    skew.ms = 0;
    ok(owed.length === 0 && app1.book.get(key) === null, `once the receipt proves it the sweep closes the delivered entry: the buyer has the answer and NO refund is owed (${owed.length} owed, ${app1.book.get(key)?.state ?? "closed"})`);
    // R3e. Unconfirmed and delivered, re-sent after the answer left memory: already delivered, no debt.
    fac.mode.receiptDown = true;
    const p2 = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 840) });
    const k2 = gateMod.referralReplayKey(p2.authorization);
    const first = await send(R("echo"), { body: { text: "once" }, headers: { "payment-signature": p2.header, "x-test-ip": ip } });
    await wait(60);
    fac.mode.receiptDown = false;
    skew.ms = 11 * 60_000;
    const resent = await send(R("echo"), { body: { text: "once" }, headers: { "payment-signature": p2.header, "x-test-ip": ip } });
    await app1.gate.sweepOnce();
    await app1.gate.sweepOnce();
    skew.ms = 0;
    ok(first.status === 200 && resent.status === 409 && resent.json?.errorReason === "answer_already_delivered" && owed.length === 0 && app1.book.get(k2) === null, `a delivered, unconfirmed payment re-sent after its answer left memory is told it was delivered; no debt is written for it by the re-send or the sweep (${resent.status} ${resent.json?.errorReason}, ${owed.length} owed)`);
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R3b. A debt is written only behind the proof, re-read when it is written.
    const g = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const kg = gateMod.referralReplayKey(g.authorization);
    const txg = "0x" + "d1".repeat(32);
    await app1.book.intent({ key: kg, slug: "echo", payer: g.authorization.from, nonce: g.authorization.nonce, amount: "30000", validBefore: Number(g.authorization.validBefore), fromBlock: fac.chainState.head });
    await app1.book.resolve(kg, { state: "charged-undelivered", tx: txg, saleBooked: true });
    await app1.gate.sweepOnce();
    const unread = { owed: owed.length, state: app1.book.get(kg)?.state };
    fac.land(g.authorization, txg, "othermerchant");
    await app1.gate.sweepOnce();
    const contradicted = { owed: owed.length, state: app1.book.get(kg)?.state };
    {
      // THE HOLD (route): a payment BOOKED on a receipt whose receipt no longer proves it. No payment can cause that.
      const ranFlip = runs.echo;
      const waitingFlip = await signPayment(accept, { account: newAccount() });
      const flipRefused = await send(R("echo"), { body: { text: "flip" }, headers: { "payment-signature": waitingFlip.header, "x-test-ip": freshIp() } });
      ok(app1.book.get(kg)?.scope === "route" && flipRefused.status === 503 && flipRefused.json?.errorReason === "settlement_under_review" && runs.echo === ranFlip, `a booked payment whose receipt stops proving it holds the whole route (${flipRefused.status}; scope ${app1.book.get(kg)?.scope})`);
    }
    ok(unread.owed === 0 && unread.state === "charged-undelivered" && contradicted.owed === 0 && contradicted.state === "contradicted", `a charged entry whose transaction has no readable receipt gets NO refund debt (it waits); one whose receipt shows the money went to another merchant gets none either and is kept as contradicted (${JSON.stringify(unread)} then ${JSON.stringify(contradicted)})`);
    await app1.gate.resolveByHand(kg, { note: "test cleanup" });
    // The proven one does get its debt, once, with the direct routes' fields.
    const g2 = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const kg2 = gateMod.referralReplayKey(g2.authorization);
    const txg2 = fac.land(g2.authorization, "0x" + "d2".repeat(32));
    await app1.book.intent({ key: kg2, slug: "echo", payer: g2.authorization.from, nonce: g2.authorization.nonce, amount: "30000", validBefore: Number(g2.authorization.validBefore), fromBlock: fac.chainState.head });
    await app1.book.resolve(kg2, { state: "charged-undelivered", tx: txg2, saleBooked: true, hangup: "payer budget" });
    await app1.gate.sweepOnce();
    await app1.gate.sweepOnce();
    const rows = owed.filter((o) => o.tx === txg2);
    const { isRepeatHangup } = await import("./refund-run.js");
    ok(rows.length === 1 && rows[0].priceUsd === 0.03 && rows[0].httpStatus === 499 && rows[0].hangupReason === "payer budget" && isRepeatHangup(rows[0]) === true && isRepeatHangup({ ...rows[0], hangupReason: "settle in flight" }) === false && app1.book.get(kg2)?.state === "refund-owed", `a proven, undelivered payment is owed once, at gross, with the fields a direct hang-up debt carries: a hang-up past a spent forgiveness budget is HELD by the refund run like a direct one (${rows.length} row, ${rows[0]?.httpStatus} ${rows[0]?.hangupReason})`);
    const evG = `${txg2}#${g2.authorization.nonce.toLowerCase()}`;
    ok(rows[0].evidenceKey === evG && gateMod.referralRefundEvidence(txg2, g2.authorization.nonce) === evG && gateMod.refundRowCovers({ evidence: evG, payer: g2.authorization.from.toUpperCase().replace("0X", "0x"), wire: "referral" }, rows[0]) === true && gateMod.refundRowCovers({ evidence: txg2, payer: g2.authorization.from, wire: "referral" }, rows[0]) === false && gateMod.refundRowCovers({ evidence: evG, payer: "0x" + "9".repeat(40), wire: "referral" }, rows[0]) === false && gateMod.refundRowCovers({ evidence: evG, payer: g2.authorization.from, wire: "evm" }, rows[0]) === false && gateMod.refundRowCovers(null, rows[0]) === false, "a refund row carries the PAYMENT's evidence (the transaction and the authorization's nonce), and a row on the books covers this debt only for that evidence AND payer on this wire");
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // The book's own sweep: a charged entry that carries the delivered mark is closed, never handed on as undelivered.
    {
      const bare = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-bare`, log: () => {} }), log });
      const mk = async (n, patch) => { const k = `referral:${String(n).repeat(64).slice(0, 64)}`; await bare.intent({ key: k, slug: "echo", payer: "0x" + "1".repeat(40), nonce: "0x" + String(n).repeat(64).slice(0, 64), amount: "30000", validBefore: Math.floor(Date.now() / 1000) + 600, fromBlock: 1 }); await bare.resolve(k, { state: "charged-undelivered", tx: "0x" + "e".repeat(64), ...patch }); return k; };
      const kDelivered = await mk("a", { delivered: true });
      const kOpen = await mk("b", {});
      const asked = [];
      const outSweep = await bare.sweep({ chain: { state: async () => ({ used: null }) }, payTo: PAY_TO, bookSale: async () => true, onCharged: async (e) => { asked.push(e.key); } });
      ok(asked.length === 1 && asked[0] === kOpen && bare.get(kDelivered) === null && bare.get(kOpen)?.state === "charged-undelivered" && outSweep.charged === 1, `the book's sweep closes a charged entry carrying the delivered mark and asks the gate only about the one without it (${asked.length} asked)`);
    }
    // R3c/d. The delivered mark is durable, written before the bytes, and a failed closing write is never read as undelivered.
    const fail = { close: 0, mark: 0 };
    const real = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-flaky`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const flaky = new Proxy(real, { get(t, k) {
      if (k === "resolve") return async (key, patch) => { if (patch === null && fail.close > 0) { fail.close--; return false; } if (patch && patch.delivered === true && fail.mark > 0) { fail.mark--; return false; } return t.resolve(key, patch); };
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    } });
    const app14 = await mount({}, { book: flaky });
    try {
      // The closing write fails every time the request tries it.
      fail.close = 99;
      const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
      const key = gateMod.referralReplayKey(p.authorization);
      const r = await send(`${app14.url}/ref/echo`, { body: { text: "closing" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      await wait(1200);
      const left = real.get(key);
      fail.close = 0;
      skew.ms = 11 * 60_000;
      await app14.gate.sweepOnce();
      skew.ms = 0;
      ok(r.status === 200 && left?.delivered === true && owed.length === 0 && real.get(key) === null, `a delivered call whose closing write keeps failing leaves an entry WITH the delivered mark; the sweep closes it and writes no refund for an answer that was delivered (left ${left?.state} delivered=${left?.delivered}, ${owed.length} owed)`);
      // The mark itself cannot be stored: the answer is not sent, and the re-send gets it.
      fail.mark = 1;
      const p2 = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
      const ip2 = freshIp();
      const held = await send(`${app14.url}/ref/echo`, { body: { text: "marked" }, headers: { "payment-signature": p2.header, "x-test-ip": ip2 } });
      const got = await send(`${app14.url}/ref/echo`, { body: { text: "marked" }, headers: { "payment-signature": p2.header, "x-test-ip": ip2 } });
      ok(held.status === 503 && held.json?.errorReason === "delivery_store_unavailable" && !("echo" in held.json) && got.status === 200 && got.json?.echo === "marked" && app14.gate.stats().deliveryMarkFailed === 1, `with no delivered mark stored the answer is NOT sent (503); the same payment sent again gets it (${held.status} then ${got.status})`);
    } finally { await app14.close(); }
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R4. Nothing a buyer sends counts toward the own-fault hold.
    const app15 = await mount();
    try {
      fac.mode.verify = () => ({ status: 400, body: { errorReason: "invalid_request" } });
      const notes = limiter.notes;
      const bad = [];
      for (let i = 0; i < 4; i++) bad.push(await send(`${app15.url}/ref/echo`, { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } }));
      fac.reset();
      const honest = await send(`${app15.url}/ref/echo`, { body: { text: "honest" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(bad.every((r) => r.status === 402 && r.json?.errorReason === "invalid_request") && limiter.notes === notes + 4 && app15.gate.stats().ownFaultStreak === 0 && app15.gate.stats().ownFaultHeld === 0 && honest.status === 200, `four payments the facilitator answers 400 for are the buyers' refused credentials (402, counted by the credential limiter) and never close the route: the next buyer is served (${bad.map((r) => r.status).join(",")} then ${honest.status})`);
      // The same at /settle: a 400 and a lookup the facilitator could not make do not count; a 401 does.
      fac.mode.settle = () => ({ status: 400, body: { errorReason: "invalid_request" } });
      for (let i = 0; i < 4; i++) await send(`${app15.url}/ref/echo`, { body: { text: "s" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      fac.mode.settle = () => ({ status: 503, body: { errorReason: "lookup_unavailable" } });
      for (let i = 0; i < 4; i++) await send(`${app15.url}/ref/echo`, { body: { text: "s" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(app15.gate.stats().ownFaultStreak === 0 && app15.gate.stats().ownFaultHeld === 0, `nor do four 400s and four lookup failures at /settle (${app15.gate.stats().ownFaultStreak})`);
      // At /verify too, only a refusal of our signature counts: a lookup the facilitator could not make is a 503 and no more.
      fac.reset();
      fac.mode.verify = () => ({ status: 503, body: { errorReason: "lookup_unavailable" } });
      const lookups = [];
      for (let i = 0; i < 4; i++) lookups.push(await send(`${app15.url}/ref/echo`, { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } }));
      fac.reset();
      ok(lookups.every((r) => r.status === 503 && r.json?.errorReason === "settlement_unavailable") && app15.gate.stats().ownFaultStreak === 0 && app15.gate.stats().ownFaultHeld === 0, `four lookup failures at /verify are answered 503 and do not count toward the hold (${app15.gate.stats().ownFaultStreak})`);
      // No hand resolution while the entry's settle call is in flight.
      fac.mode.settleDelayMs = 500;
      const pBusy = await signPayment(accept, { account: newAccount() });
      const kBusy = gateMod.referralReplayKey(pBusy.authorization);
      const inFlight = send(`${app15.url}/ref/echo`, { body: { text: "settling" }, headers: { "payment-signature": pBusy.header, "x-test-ip": freshIp() } });
      await wait(250);
      const during = await app15.gate.resolveByHand(kBusy, { note: "resolving mid-settle" });
      const settledCall = await inFlight;
      fac.reset();
      ok(app15.book.get(kBusy) === null && during.ok === false && /being settled/.test(during.error || "") && settledCall.status === 200, `an entry whose settle call is in flight cannot be resolved by hand (${during.error}); the call then settles as usual (${settledCall.status})`);
      // F1. A facilitator that accepts each signed request once: /verify and /settle carry one body, and must not be one signed request.
      fac.mode.acceptOnce = true;
      const instant = await send(`${app15.url}/ref/echo`, { body: { text: "instant" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      const vCall = fac.of("/verify")[0], sCall = fac.of("/settle")[0];
      ok(instant.status === 200 && vCall.raw === sCall.raw && (vCall.timestamp !== sCall.timestamp) && vCall.signature !== sCall.signature && Math.abs(Number(sCall.timestamp) - Date.now() / 1000) < 60, `an instant tool's /verify and /settle, the same body, are signed with different timestamps: a facilitator that accepts a signed request once takes both (${instant.status}; ${vCall.timestamp} then ${sCall.timestamp})`);
      // One locally valid, unfunded payment sent four times inside a second: four verifies of one body.
      fac.mode.verify = () => ({ status: 200, body: { isValid: false, invalidReason: "insufficient_funds" } });
      const same = await signPayment(accept, { account: newAccount() });
      const sameIp = freshIp();
      const four = [];
      for (let i = 0; i < 4; i++) four.push(await send(`${app15.url}/ref/echo`, { body: { text: "again" }, headers: { "payment-signature": same.header, "x-test-ip": sameIp } }));
      fac.mode.verify = () => ({ status: 200, body: { isValid: true } });
      const next = await send(`${app15.url}/ref/echo`, { body: { text: "next" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      ok(four.every((r) => r.status === 402 && r.json?.errorReason === "insufficient_funds") && app15.gate.stats().ownFaultStreak === 0 && app15.gate.stats().ownFaultHeld === 0 && next.status === 200, `one payment sent four times in a second is refused four times as the buyer's, never as a replay of our own signed request: the hold does not open and the next buyer is served (${four.map((r) => r.status).join(",")}; streak ${app15.gate.stats().ownFaultStreak}; ${next.status})`);
      fac.reset();
      // One probe at a time after the cool-down.
      fac.mode.settle = () => ({ status: 401, body: { error: "merchant_signature" } });
      for (let i = 0; i < 3; i++) await send(`${app15.url}/ref/echo`, { body: { text: "s" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      await wait(1100);
      fac.mode.settleDelayMs = 500;
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
      const ranBefore = runs.echo;
      const pair2 = await Promise.all([0, 1, 2].map(async () => send(`${app15.url}/ref/echo`, { body: { text: "probe" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } })));
      ok(pair2.filter((r) => r.status === 200).length === 1 && pair2.filter((r) => r.status === 503 && r.json?.errorReason === "settlement_unavailable").length === 2 && runs.echo === ranBefore + 1, `after the cool-down exactly ONE call probes while the others are still answered 503 before anything runs (${pair2.map((r) => r.status).join(",")}; ${runs.echo - ranBefore} ran)`);
    } finally { await app15.close(); }
    // The settle client's own reading.
    const mk = (status, body) => createReferralSettler({ facilitatorUrl: "https://facilitator.example", signerKey: SIGNER_KEY, fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });
    const s400 = await mk(400, { errorReason: "invalid_request" }).settle({}, {});
    const s401 = await mk(401, { error: "anything" }).settle({}, {});
    const sSig = await mk(200, { success: false, errorReason: "merchant_signature" }).settle({}, {});
    const s503 = await mk(503, { errorReason: "lookup_unavailable" }).settle({}, {});
    const v400 = await mk(400, { errorReason: "invalid_request" }).verify({}, {});
    const v401 = await mk(401, {}).verify({}, {});
    // A 401 that says the signed request was seen before is a replay, not a bad signature; and one body is never signed twice with one timestamp.
    const sReplay = await mk(401, { error: "request_already_used" }).settle({}, {});
    const vReplay = await mk(401, { error: "replayed_request" }).verify({}, {});
    const stamps = [];
    const frozen = createReferralSettler({ facilitatorUrl: "https://facilitator.example", signerKey: SIGNER_KEY, now: () => 1_800_000_000_000, fetchImpl: async (_u, init) => { stamps.push(`${init.headers["X-Agent-Timestamp"]}|${init.headers["X-Agent-Signature"]}`); return new Response(JSON.stringify({ isValid: true }), { status: 200 }); } });
    for (let i = 0; i < 5; i++) await frozen.verify({ a: 1 }, { b: 2 });
    await frozen.verify({ a: 2 }, { b: 2 });
    ok(sReplay.side === "ours" && sReplay.ownFault === false && vReplay.ownFault === false && new Set(stamps.slice(0, 5)).size === 5 && stamps.slice(0, 5).map((x) => x.split("|")[0]).join(",") === "1800000000,1800000001,1800000002,1800000003,1800000004" && stamps[5].startsWith("1800000000|"), `a 401 whose reason says the request was already used does not count as our own fault; five requests with one body inside one second carry five timestamps, one second apart, and another body keeps the clock's (${stamps.slice(0, 5).map((x) => x.split("|")[0]).join(",")})`);
    ok(s400.side === "buyer" && s400.ownFault === false && s401.side === "ours" && s401.ownFault === true && sSig.side === "ours" && sSig.ownFault === true && s503.side === "ours" && s503.ownFault === false && v400.side === "buyer" && v400.inDoubt === false && v400.ownFault === false && v401.side === "ours" && v401.ownFault === true, "the settle client: a 400 is the buyer's refused payment; only a 401 or the merchant-signature reason is this server's own fault; a lookup failure is neither the buyer's nor a hold");
    // The facilitator is sent a payment rebuilt from validated fields, whatever else the buyer's object carries.
    fac.reset();
    const p = await signPayment(accept, { account: newAccount() });
    const junk = { ...p.payload, top: "junk", accepted: { ...accept, evil: "x", amount: "1" }, payload: { ...p.payload.payload, extra: { a: 1 }, authorization: { ...p.authorization, more: "y" } }, extensions: { attributionToken: "tok-1", buyerAgentId: "77", other: "zz", nested: { a: 1 } } };
    const rj = await send(R("echo"), { body: { text: "junk" }, headers: { "payment-signature": Buffer.from(JSON.stringify(junk)).toString("base64url"), "x-test-ip": freshIp() } });
    const sentBody = fac.of("/settle")[0]?.json?.paymentPayload;
    ok(rj.status === 200 && JSON.stringify(sentBody) === JSON.stringify({ x402Version: 2, resource: { url: "https://shop.example/ref/echo" }, accepted: accept, payload: { signature: p.payload.payload.signature, authorization: p.authorization }, extensions: { attributionToken: "tok-1", buyerAgentId: "77" } }) && JSON.stringify(fac.of("/verify")[0]?.json?.paymentPayload) === JSON.stringify(sentBody), `the facilitator is sent the quoted requirement, the checked signature and authorization and the two attribution strings: nothing else of the buyer's object (${JSON.stringify(sentBody).slice(0, 120)})`);
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R5. A success whose receipt cannot be read: retried, then bounded.
    const app16 = await mount({ REFERRAL_RECEIPT_WAIT_MS: "2000", REFERRAL_UNCONFIRMED_MAX: "2" });
    try {
      // The receipt appears half a second after the facilitator answers: proven, not unconfirmed.
      fac.mode.settle = (c) => { const auth = c.json.paymentPayload.payload.authorization; const t = fac.nextTx(); setTimeout(() => fac.land(auth, t), 500); return { status: 200, body: { success: true, transaction: t } }; };
      const p = await signPayment(accept, { account: newAccount() });
      const lagged = await send(`${app16.url}/ref/echo`, { body: { text: "soon" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      await wait(60);
      ok(lagged.status === 200 && app16.gate.stats().unconfirmed === 0 && app16.book.get(gateMod.referralReplayKey(p.authorization)) === null, `a receipt that appears a moment after the facilitator's answer is waited for: the payment is proven, not left unconfirmed (${lagged.status}, ${app16.gate.stats().unconfirmed} unconfirmed)`);
    } finally { await app16.close(); }
    const app17 = await mount({ REFERRAL_UNCONFIRMED_MAX: "2" });
    try {
      await quietLedger();
      sales.length = 0;
      // A facilitator that names transactions with no receipt at all.
      let n = 0;
      fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: `0x${(0xfa000 + ++n).toString(16).padStart(64, "0")}` } });
      const out = [];
      const keys = [];
      for (let i = 0; i < 5; i++) { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 840) }); keys.push(gateMod.referralReplayKey(p.authorization)); out.push(await send(`${app17.url}/ref/echo`, { body: { text: `f${i}` }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } })); }
      await wait(60);
      await quietLedger();
      ok(out.slice(0, 2).every((r) => r.status === 200) && out.slice(2).every((r) => r.status === 402 && r.json?.errorReason === "settle_outcome_unknown" && !("echo" in r.json)) && sales.length === 2 && app17.gate.stats().unconfirmedHeld === 3 && keys.slice(2).every((k) => app17.book.get(k)?.state === "in-doubt"), `successes with no readable receipt: 2 are delivered and stay open as unconfirmed (the cap), the rest are HELD in doubt, undelivered and unbooked (${out.map((r) => r.status).join(",")}; ${sales.length} sales)`);
      skew.ms = 16 * 60_000;
      const aged = app17.gate.statusWord();
      skew.ms = 0;
      ok(app17.book.list().filter((e) => e.state === "unconfirmed").length === 2 && aged.status === "attention" && aged.reasons.some((x) => /^5 settlement\(s\) open past 15 minutes/.test(x)), `an unconfirmed entry open past fifteen minutes reads attention, counted with the ones in doubt: 2 unconfirmed and 3 held (${aged.reasons.join("; ")})`);
      // The sweep flags an unconfirmed entry with no receipt after a few minutes, and the flag stays.
      await app17.gate.sweepOnce();
      const young = app17.book.list().filter((e) => e.state === "unconfirmed" && e.flagged === true).length;
      skew.ms = gateMod.REFERRAL_UNCONFIRMED_FLAG_MS + 5_000;
      await app17.gate.sweepOnce();
      const flagged = app17.book.list().filter((e) => e.state === "unconfirmed" && e.flagged === true);
      const flaggedWord = app17.gate.statusWord();
      skew.ms = 0;
      ok(young === 0 && flagged.length === 2 && flaggedWord.status === "attention" && flaggedWord.reasons.some((x) => /receipt cannot be read/.test(x)) && app17.gate.statusWord().status === "attention" && app17.gate.stats().unconfirmedFlagged === 2 && logLines.some((l) => /NO readable receipt/.test(l)), `the sweep flags an unconfirmed settlement whose receipt is still unreadable after ${gateMod.REFERRAL_UNCONFIRMED_FLAG_MS / 60_000} minutes; the word reads attention and stays there (${flagged.length} flagged; ${flaggedWord.reasons.join("; ")})`);
    } finally { await app17.close(); }
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // R8. The three checks a mutation used to survive, and where the answers live.
    const a1 = { from: newAccount().address, to: PAY_TO, value: "30000", nonce: freshNonce() };
    const txA = fac.land(a1);
    const good = fac.receipts.get(txA);
    const gapped = { ...good, logs: good.logs.map((l, i) => (i === 0 ? l : { ...l, logIndex: `0x${(parseInt(l.logIndex, 16) + 1).toString(16)}` })) };
    const proofOf = (r) => receiptProvesPayment(r, { tx: txA, from: a1.from, nonce: a1.nonce, payTo: PAY_TO, amount: "30000", merchantId: MERCHANT_ID, payoutAddress: PAYOUT, minNet: "26298" });
    ok(proofOf(good) === "paid" && proofOf(gapped) === "unpaid", `a Transfer listed next to the authorization but NOT at the very next log index is not its own transfer (${proofOf(gapped)})`);
    const dir = join(tmp, "expiry-answers");
    let clock = Date.now();
    const files = createReferralAnswerStore({ dir, now: () => clock });
    const kf = `referral:${"ab".repeat(32)}`;
    await files.put(kf, { text: "{\"a\":1}", expiresAt: clock + 1000 });
    const fresh = await files.get(kf);
    clock += 2000;
    const stale = await files.get(kf);
    ok(files.backend === "file" && fresh?.text === "{\"a\":1}" && stale === null && readdirSync(dir).length === 1 && (await files.sweep()) === 1 && readdirSync(dir).length === 0, "the file store never returns an answer past its expiry, before any sweep has removed the file");
    const answersSrc = readFileSync(new URL("../src/referral-answers.js", import.meta.url), "utf8");
    const { ANSWER_DIR_NAME } = await import("../src/referral-answers.js");
    const backupSrc = readFileSync(new URL("../src/backup.js", import.meta.url), "utf8");
    ok(!/from "\.\/state-db\.js"/.test(answersSrc) && /cache/i.test(ANSWER_DIR_NAME) && /const EXCLUDE = \[\/cache\/i/.test(backupSrc) && gateMod.REFERRAL_ANSWER_RETENTION_MS === (await import("../src/idempotency-store.js")).IDEM_TTL_MS, "owed answers are never rows of the state database (the nightly backup copies those): files in a directory whose name the file backup leaves out, kept for the same time the privacy page states for a paid answer");
    const refundYml = readFileSync(new URL("../.github/workflows/refund.yml", import.meta.url), "utf8");
    const refundRun = readFileSync(new URL("./refund-run.js", import.meta.url), "utf8");
    ok(["REFERRAL_PAY_TO", "REFERRAL_MERCHANT_ID", "REFERRAL_PAYOUT_ADDRESS"].every((v) => refundYml.includes(`${v}: \${{ vars.${v} }}`) && refundRun.includes(`process.env.${v}`)), "the refund workflow passes the pay-to contract, the merchant id and the payout wallet (repository variables) that the refund run's proof reads");
  }
  fac.reset(); sales.length = 0; owed.length = 0;

  // --- a buyer who leaves ---------------------------------------------------------
  hangupMod._resetHangupForgiveness();
  const directBudgetBefore = JSON.stringify(hangupMod.hangupForgivenessStatus());
  const forgivenBefore = { usd: app1.gate.stats().forgivenUsd, records: app1.book.forgiven().length };
  {
    // With a forgiveness ticket: not settled, the authorization held.
    const acct = newAccount();
    const p = await signPayment(accept, { account: acct });
    const outcome = await rawPost(R("busy"), { text: "gone" }, { "payment-signature": p.header, "x-test-ip": "5.5.5.5" }, 120);
    await wait(500);
    ok(outcome === "aborted" && settles() === 0 && sales.length === 0 && logLines.some((l) => /client gone before settlement \(busy/.test(l)), `a connection closed before settlement starts, inside the forgiveness budget, is not settled (${settles()} settle, ${sales.length} sale)`);
    const again = await send(R("echo"), { body: { text: "back" }, headers: { "payment-signature": p.header, "x-test-ip": "5.5.5.5" } });
    ok(again.status === 409, `its claim is HELD: the same authorization buys nothing more (${again.status})`);
    ok(Math.abs(app1.gate.stats().forgivenUsd - forgivenBefore.usd - 0.03) < 1e-9 && JSON.stringify(hangupMod.hangupForgivenessStatus()) === directBudgetBefore && app1.book.forgiven().length === forgivenBefore.records + 1, `the forgiven run is spent from this route's own budget and recorded in the book; the direct routes' forgiveness budget is untouched (${app1.gate.stats().forgivenUsd} forgiven here)`);
    // The budget is spent: the next hang-up by this payer is settled, and its answer kept.
    const q = await signPayment(accept, { account: acct });
    const key = gateMod.referralReplayKey(q.authorization);
    const ran = runs.busy;
    const second = await rawPost(R("busy"), { text: "gone again" }, { "payment-signature": q.header, "x-test-ip": "5.5.5.5" }, 120);
    await wait(600);
    ok(second === "aborted" && settles() === 1 && sales.length === 1 && runs.busy === ran + 1 && app1.book.get(key)?.state === "charged-undelivered" && logLines.some((l) => /CHARGED-BUT-NOT-SERVED: the buyer's connection closed before the answer could be sent \(busy/.test(l)), `past the forgiveness budget a hang-up is settled as for any run: one sale, the case in the book, logged CHARGED-BUT-NOT-SERVED (${settles()} settle, ${sales.length} sale, book ${app1.book.get(key)?.state})`);
    const fetched = await send(R("busy"), { body: { text: "gone again" }, headers: { "payment-signature": q.header, "x-test-ip": "5.5.5.5" } });
    ok(fetched.status === 200 && fetched.json?.echo === "gone again" && /^0x[0-9a-f]{64}$/.test(fetched.json.transaction || "") && runs.busy === ran + 1 && sales.length === 1 && settles() === 1 && app1.book.get(key) === null, `the buyer's re-send of that payment returns the kept answer: no second run, settle or sale, and the book entry is closed (${fetched.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    fac.mode.settleDelayMs = 400;
    const p = await signPayment(accept, { account: newAccount() });
    const key = gateMod.referralReplayKey(p.authorization);
    const before = app1.gate.stats().chargedNotServed;
    const ran = runs.echo;
    const outcome = await rawPost(R("echo"), { text: "leaving" }, { "payment-signature": p.header, "x-test-ip": freshIp() }, 150);
    await wait(700);
    ok(outcome === "aborted" && settles() === 1 && sales.length === 1 && app1.gate.stats().chargedNotServed === before + 1 && app1.book.get(key)?.state === "charged-undelivered" && app1.book.get(key).saleBooked === true, `a connection closed during the settle call: the sale is booked, logged CHARGED-BUT-NOT-SERVED, counted, and kept in the book (${app1.gate.stats().chargedNotServed - before})`);
    fac.mode.settleDelayMs = 0;
    const fetched = await send(R("echo"), { body: { text: "leaving" }, headers: { "payment-signature": p.header } });
    ok(fetched.status === 200 && fetched.json?.echo === "leaving" && runs.echo === ran + 1 && sales.length === 1, `and the same payment sent again collects the answer (${fetched.status})`);
  }
  fac.reset(); sales.length = 0;

  {
    // Ten hang-ups in a row by one payer on one address: the per-payer and per-address budget binds after the first.
    const app8 = await mount();
    try {
      const acct = newAccount();
      const before = settles();
      for (let i = 0; i < 10; i++) { await rawPost(`${app8.url}/ref/busy`, { text: "gone" }, { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": "8.8.4.4" }, 120); await wait(450); }
      const st = app8.gate.stats();
      ok(st.forgivenHangups === 1 && settles() - before === 9 && st.forgivenUsd === 0.03, `10 hang-ups in a row by one payer and address: 1 forgiven, 9 settled (${st.forgivenHangups} forgiven, ${settles() - before} settled)`);
      // Another payer on the same address is bound by the address's budget; another payer elsewhere has its own.
      await rawPost(`${app8.url}/ref/busy`, { text: "gone" }, { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": "8.8.4.4" }, 120); await wait(450);
      await rawPost(`${app8.url}/ref/busy`, { text: "gone" }, { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": "8.8.4.5" }, 120); await wait(450);
      ok(app8.gate.stats().forgivenHangups === 2 && settles() - before === 10, `the address's budget binds whatever wallet signs, and another payer on another address has its own (${app8.gate.stats().forgivenHangups} forgiven, ${settles() - before} settled)`);
    } finally { await app8.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // A run is served inside the caller's scope and the referral-run scope.
    const r = await send(R("scopes"), { body: { x: 1 }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(r.status === 200 && r.json?.caller === `payer:${buyer.address.toLowerCase()}` && r.json.referral === true && r.json.hint === "", `the handler runs as its caller (${r.json?.caller?.slice(0, 16)}) and as a referral run, where a route hint is empty`);
    ok(routeHint("x", "y") === "x" && runAsReferral(() => routeHint("x", "y")) === "y" && inReferralRun() === false, "outside a referral run a route hint is the direct one");
    ok(warmed.length > 0, "the quote is warmed before it is read");
    // The shared claim is asked for when the server says it must be.
    const begun = [];
    const spy = await mount({}, { replayGuard: { begin: async (k, n, o) => { begun.push(o?.requireShared); return "unavailable"; }, settle: async () => {}, release: async () => {} } });
    try {
      knobs.requireShared = true;
      const vBefore = verifies();
      const u = await send(`${spy.url}/ref/echo`, { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      knobs.requireShared = false;
      ok(u.status === 503 && u.json?.reason === "replay-store-unavailable" && u.headers.get("retry-after") === "30" && begun[0] === true && verifies() === vBefore, `a claim the shared store must hold and cannot: 503 with Retry-After, nothing sent (${u.status})`);
    } finally { await spy.close(); }
    // A drain: no new run starts, and a settle call in flight ends inside what the drain has left.
    knobs.draining = { active: true, leftMs: 60_000 };
    const ran = runs.echo, vBeforeDrain = verifies();
    const d = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    knobs.draining = { active: false, leftMs: Infinity };
    ok(d.status === 503 && d.json?.errorReason === "draining" && runs.echo === ran && verifies() === vBeforeDrain, `during a drain no new run starts (${d.status} ${d.json?.errorReason})`);
    const slowSettle = await mount({ REFERRAL_SETTLE_MS: "20000" });
    try {
      fac.mode.settle = () => { knobs.draining = { active: true, leftMs: 7_000 }; return { hang: true }; };
      let first = true;
      const realDraining = knobs.draining;
      // The drain begins while the handler runs: the settle that follows gets what the drain has left, less 5 s.
      const t0 = Date.now();
      knobs.draining = { active: false, leftMs: Infinity };
      const p = await signPayment(accept, { account: newAccount() });
      const hook = setTimeout(() => { knobs.draining = { active: true, leftMs: 7_000 }; }, 150);
      const r2 = await send(`${slowSettle.url}/ref/busy`, { body: { text: "x" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      clearTimeout(hook); void first; void realDraining;
      knobs.draining = { active: false, leftMs: Infinity };
      ok(r2.status === 402 && r2.json?.errorReason === "settle_outcome_unknown" && Date.now() - t0 < 6000, `a settle call that would wait 20 s ends inside the drain (${Date.now() - t0} ms)`);
    } finally { await slowSettle.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // The facilitator refuses OUR signature: this server's fault, never the buyer's.
    const notes = limiter.notes;
    fac.mode.verify = () => ({ status: 401, body: { error: "merchant_signature" } });
    const acct = newAccount(), ip = freshIp();
    let ran = runs.echo;
    const v = [];
    for (let i = 0; i < 5; i++) v.push(await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": (await signPayment(accept, { account: acct })).header, "x-test-ip": ip } }));
    ok(v.every((r) => r.status === 503 && r.json?.errorReason === "settlement_unavailable" && r.headers.get("retry-after")) && runs.echo === ran && limiter.notes === notes && app1.gate.stats().signerRefused >= 5 && logLines.some((l) => /refused THIS SERVER's request at \/verify .*REFERRAL_SIGNER_KEY/.test(l)), `a /verify 401 about our signer: 503, an error line naming the setting, counted apart, and no refused credential counted against the buyer (${v[0].status} ${v[0].json?.errorReason})`);
    fac.mode.verify = () => ({ status: 200, body: { isValid: true } });
    // The verify refusals above started a cool-down: let it end, and let one accepted settle clear the streak.
    await wait(1100);
    const cleared = await send(R("echo"), { body: { text: "clear" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ran = runs.echo;
    ok(cleared.status === 200 && app1.gate.stats().ownFaultStreak === 0, `after the cool-down a call probes and its accepted settle clears the streak (${cleared.status})`);
    fac.mode.settle = () => ({ status: 401, body: { error: "merchant_signature" } });
    const s5 = [];
    const kept5 = [];
    for (let i = 0; i < 5; i++) { const p = await signPayment(accept, { account: acct }); kept5.push(p); s5.push(await send(R("echo"), { body: { text: `sig${i}` }, headers: { "payment-signature": p.header, "x-test-ip": ip } })); }
    const heldBefore = app1.gate.stats().ownFaultHeld;
    ok(s5.every((r) => r.status === 503 && r.json?.errorReason === "settlement_unavailable") && runs.echo === ran + 3 && app1.gate.stats().ownFaultHeld >= 2 && logLines.some((l) => /refused THIS SERVER's request at \/settle/.test(l)), `a /settle 401 about our signer: 503 each time; after 3 refusals of our own request in a row the next calls are answered 503 BEFORE the handler (${s5.map((r) => r.status).join(",")}; ${runs.echo - ran} ran)`);
    ok(app1.gate.statusWord().status === "attention" && /own request/.test(app1.gate.statusWord().reasons.join(" ")), "and the status word reads attention, naming our own request on the operator view");
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    const stillHeld = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(stillHeld.status === 503 && runs.echo === ran + 3 && app1.gate.stats().ownFaultHeld > heldBefore, `inside the cool-down any payer is answered 503 before anything runs (${stillHeld.status})`);
    await wait(1100);
    const fixed = await send(R("echo"), { body: { text: "sig0" }, headers: { "payment-signature": kept5[0].header, "x-test-ip": ip } });
    ok(fixed.status === 200 && fixed.json?.echo === "sig0" && runs.echo === ran + 3, `after the cool-down a call probes: the signer is accepted, and the same payment settles and returns the kept answer (${fixed.status})`);
    const flowing = await send(R("echo"), { body: { text: "flowing" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(flowing.status === 200 && app1.gate.stats().ownFaultStreak === 0, "and calls flow again: the streak is cleared by an accepted settle");
  }
  fac.reset(); sales.length = 0;
  {
    // An open entry carries its answer through a restart: a book on a FILE, no database.
    const file = join(tmp, "restart-book.json");
    const answerDir = join(tmp, "restart-answers");
    const a = await mount({}, { book: createReferralBook({ file, log }), answers: createReferralAnswerStore({ dir: answerDir }) });
    fac.mode.settle = () => ({ status: 500, body: {} });
    const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
    const ip = freshIp();
    const ran = runs.echo;
    const r1 = await send(`${a.url}/ref/echo`, { body: { text: "survives" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
    const delivered = await signPayment(accept, { account: newAccount() });
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()) } });
    await send(`${a.url}/ref/echo`, { body: { text: "done" }, headers: { "payment-signature": delivered.header, "x-test-ip": freshIp() } });
    await a.close();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    const stored = Object.values(onDisk.entries || {});
    const answerFiles = readdirSync(answerDir);
    ok(r1.status === 402 && stored.length === 1 && stored[0].state === "in-doubt" && !JSON.stringify(onDisk).includes("survives") && answerFiles.length === 1 && readFileSync(join(answerDir, answerFiles[0]), "utf8").includes("survives") && !readdirSync(answerDir).some((f) => readFileSync(join(answerDir, f), "utf8").includes('"done"')), `the book is a file without a database and holds no answer; the open entry's answer is a file of its own, and a delivered call's answer is kept at rest nowhere (${stored.length} entry, ${answerFiles.length} answer file)`);
    // A new process on the same file: the chain shows the payment landed, the buyer re-sends.
    const b = await mount({}, { book: createReferralBook({ file, log }), answers: createReferralAnswerStore({ dir: answerDir }) });
    try {
      const tx = "0x" + "5e".repeat(32);
      fac.land(p.authorization, tx);
      const r2 = await send(`${b.url}/ref/echo`, { body: { text: "survives" }, headers: { "payment-signature": p.header, "x-test-ip": ip } });
      await quietLedger();
      ok(r2.status === 200 && r2.json?.echo === "survives" && r2.json.run === ran + 1 && r2.json.transaction === tx && runs.echo === ran + 2 && sales.filter((x) => x.tx === tx).length === 1 && b.gate.stats().restoredAnswers === 1, `after a restart the charged buyer's re-send returns the stored answer with its transaction: no second run, one sale (${r2.status} ${r2.text.slice(0, 80)})`);
      await wait(50);
      ok(Object.keys(JSON.parse(readFileSync(file, "utf8")).entries || {}).length === 0 && readdirSync(answerDir).length === 0, "and the delivered entry is gone from the book, its answer from the answers store");
      // Another signature on the same payer and nonce does not get the stored answer.
    } finally { await b.close(); }
  }
  fac.reset(); sales.length = 0;
  {
    // The forgiveness budget is this route's own and outlives a restart: a new gate on the same book has it spent.
    const acct = newAccount();
    const first = await mount();
    const p1 = await signPayment(accept, { account: acct });
    await rawPost(`${first.url}/ref/busy`, { text: "gone" }, { "payment-signature": p1.header, "x-test-ip": "6.6.6.6" }, 120);
    await wait(500);
    const spent = first.gate.stats().forgivenUsd;
    await first.close();
    const second = await mount({}, { book: first.book });
    try {
      await wait(50);
      const p2 = await signPayment(accept, { account: acct });
      await rawPost(`${second.url}/ref/busy`, { text: "gone" }, { "payment-signature": p2.header, "x-test-ip": "6.6.6.6" }, 120);
      await wait(600);
      ok(spent === 0.03 && settles() === 1 && second.gate.stats().forgivenUsd === 0.03, `a restart does not refill the forgiveness budget: the same payer's next hang-up is settled (${settles()} settle; ${second.gate.stats().forgivenUsd} forgiven)`);
      ok(JSON.stringify(hangupMod.hangupForgivenessStatus()) === directBudgetBefore, "and none of it touched the budget a direct buyer's hang-up is judged against");
    } finally { await second.close(); }
  }
  fac.reset(); sales.length = 0;

  // --- a process that stopped in the middle of a settle ----------------------------------
  {
    const book = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-crash`, log: () => {} }), log });
    const gone = await signPayment(accept, { account: newAccount() });
    const never = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) - 600) });
    const open = await signPayment(accept, { account: newAccount() });
    const kGone = gateMod.referralReplayKey(gone.authorization), kNever = gateMod.referralReplayKey(never.authorization), kOpen = gateMod.referralReplayKey(open.authorization);
    // As the dead process left them: intents, written before /settle, never resolved.
    for (const [k, p] of [[kGone, gone], [kNever, never], [kOpen, open]]) await book.intent({ key: k, slug: "echo", payer: p.authorization.from, nonce: p.authorization.nonce, amount: "30000", validBefore: Number(p.authorization.validBefore) });
    const tx = "0x" + "d7".repeat(32);
    fac.land(gone.authorization, tx);
    const app4 = await mount({ REFERRAL_SETTLE_MS: "1000" }, { book });
    try {
      const early = await book.sweep({ chain: { state: async () => { throw new Error("must not be read"); } }, payTo: PAY_TO, bookSale: async () => true, graceMs: 60_000 });
      ok(early.read === 0, "the sweep leaves an intent alone while its own request may still be settling");
      const first = await book.sweep({ chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 1, budgetMs: 1000 }), payTo: PAY_TO, bookSale: (e, t) => app4.gate.sweepOnce && sales.push({ sweep: true, tx: t }) && true, minNetOf: () => "26298", graceMs: 0 });
      ok(first.landed === 1 && first.expired === 1 && first.unknown === 1, `the sweep reads every open intent against the chain: one landed, one expired unused, one still open (${JSON.stringify(first)})`);
      // The gate's own sweep books the sale, once.
      await book.resolve(kGone, { state: "intent", saleBooked: false, intentAt: Date.now() - 600_000 });
      sales.length = 0;
      await app4.gate.sweepOnce();
      await app4.gate.sweepOnce();
      await quietLedger();
      const rowAfter = ledger.privateRailSaleByTx(tx, "referral");
      const owedRow = owed.find((o) => o.tx === tx);
      ok(sales.length === 1 && sales[0].tx === tx && sales[0].priceUsd === 0.026298 && sales[0].quoteUsd === 0.03 && rowAfter?.netUsd === 0.026298 && book.get(kGone)?.state === "refund-owed" && owedRow && owedRow.priceUsd === 0.03 && owedRow.wire === "referral" && owedRow.network === "eip155:8453" && owedRow.payer === gone.authorization.from.toLowerCase() && owed.filter((o) => o.tx === tx).length === 1, `a payment that moved while its process died is booked by the sweep, once, at the net amount; its answer died with the process, so the GROSS is recorded as owed in the refund ledger, once, and the case is closed (${sales.length} sale, ${book.get(kGone)?.state}, owed ${owedRow?.priceUsd})`);
      ok(book.get(kNever) === null && book.get(kOpen)?.state === "in-doubt", "an intent that expired unused is closed; one the chain has not used yet stays open");
      // The dead process had booked the sale before it stopped: the ledger says so, and the sweep books no second one.
      const known = await signPayment(accept, { account: newAccount() });
      const kKnown = gateMod.referralReplayKey(known.authorization);
      const txKnown = "0x" + "e3".repeat(32);
      ledger.recordSale({ slug: "echo", priceUsd: 0.026298, quoteUsd: 0.03, rail: "referral", wire: "referral", network: "base", payer: known.authorization.from, tx: txKnown });
      await book.intent({ key: kKnown, slug: "echo", payer: known.authorization.from, nonce: known.authorization.nonce, amount: "30000", validBefore: Number(known.authorization.validBefore) });
      await book.resolve(kKnown, { intentAt: Date.now() - 600_000 });
      fac.land(known.authorization, txKnown);
      const salesBefore = sales.length;
      await quietLedger();
      await app4.gate.sweepOnce();
      ok(sales.length === salesBefore && book.get(kKnown)?.state === "refund-owed", `a settlement whose sale is already on the ledger is not booked again by the sweep (${sales.length - salesBefore} more)`);
      ok(logLines.some((l) => /CHARGED-BUT-NOT-SERVED: a settlement left open landed on chain \(echo .*sale booked/.test(l)), "and it is logged");
      // The same payment sent to the new process: it bought its run already.
      const ran = runs.echo;
      const r = await send(`${app4.url}/ref/echo`, { body: { text: "x" }, headers: { "payment-signature": gone.header } });
      ok(r.status === 409 && r.json?.errorReason === "answer_unavailable_refund_owed" && /recorded as owed to the paying wallet/.test(r.json.errorMessage) && runs.echo === ran, `an authorization whose answer was lost and is owed back runs no second time, and says so (${r.status} ${r.json?.errorReason})`);
    } finally { await app4.close(); }
  }
  fac.reset(); sales.length = 0;

  // --- a bounded number of paid calls in flight ------------------------------------------
  {
    const app5 = await mount({ REFERRAL_MAX_INFLIGHT: "2" });
    try {
      // One sale first: the slug's rate has proven, so the in-flight bound is the only bound here.
      await send(`${app5.url}/ref/echo`, { body: { text: "warm" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
      fac.reset();
      fac.mode.verifyDelayMs = 500;
      // The settle call holds each run's slot long enough for the other calls to meet the bound.
      fac.mode.settleDelayMs = 400;
      const before = runs.echo;
      const rs = await Promise.all([0, 1, 2, 3].map(async () => send(`${app5.url}/ref/echo`, { body: { text: "q" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } })));
      const busy = rs.filter((r) => r.status === 503 && r.json?.errorReason === "busy" && r.headers.get("retry-after"));
      ok(rs.filter((r) => r.status === 200).length === 2 && busy.length === 2 && runs.echo === before + 2 && verifies() === 4 && settles() === 2, `past the in-flight bound a VERIFIED paid call is answered 503 with Retry-After before anything runs (${rs.map((r) => r.status).join(",")}; ${runs.echo - before} ran)`);
      // Payments that will not verify, waiting on a slow /verify, take no run slot: an honest buyer still runs.
      fac.reset();
      fac.mode.verifyDelayMs = 400;
      const honest = newAccount();
      fac.mode.verify = (c) => (c.json.paymentPayload.payload.authorization.from.toLowerCase() === honest.address.toLowerCase() ? { status: 200, body: { isValid: true } } : { status: 200, body: { isValid: false, invalidReason: "insufficient_funds" } });
      const mixed = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(async (i) => send(`${app5.url}/ref/echo`, { body: { text: "m" }, headers: { "payment-signature": (await signPayment(accept, { account: i === 6 ? honest : newAccount() })).header, "x-test-ip": freshIp() } })));
      ok(mixed[6].status === 200 && mixed.slice(0, 6).every((r) => r.status === 402), `six unfunded payments waiting on a slow /verify do not take the two run slots: the honest buyer beside them is served (${mixed.map((r) => r.status).join(",")})`);
    } finally { await app5.close(); fac.mode.verifyDelayMs = 0; }
  }
  fac.reset(); sales.length = 0;
  {
    // Refusal lines are sampled: a flood of refused payments prints a bounded number of lines.
    fac.mode.verify = () => ({ status: 200, body: { isValid: false, invalidReason: "invalid_payment" } });
    const before = logLines.filter((l) => /verify refused/.test(l)).length;
    // The gate's clock is set to the first second of a minute, so the thirty
    // calls fall in one minute of ITS clock whatever the wall clock reads.
    skew.ms = 60_000 - (Date.now() % 60_000) + 1_000;
    try {
      for (let i = 0; i < 30; i++) await send(R("echo"), { body: { text: "f" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor((Date.now() + skew.ms) / 1000) + 60) })).header, "x-test-ip": freshIp() } });
    } finally { skew.ms = 0; }
    const printed = logLines.filter((l) => /verify refused/.test(l)).length - before;
    ok(printed === 20, `30 refused payments inside one minute of the gate's clock print exactly 20 refusal lines (${printed})`);
  }
  fac.reset(); sales.length = 0;
  {
    const app3 = await mount({ REFERRAL_VERIFY_SIGNED: "off" });
    try {
      const r = await send(`${app3.url}/ref/echo`, { body: { text: "unsigned verify" }, headers: { "payment-signature": (await signPayment(accept)).header } });
      ok(r.status === 200 && fac.of("/verify")[0].signature === null && fac.of("/settle")[0].recovered?.toLowerCase() === signer.address.toLowerCase(), "with REFERRAL_VERIFY_SIGNED=off /verify carries no signature and /settle still does");
    } finally { await app3.close(); }
    const app6 = await mount({ REFERRAL_VERIFY: "off" });
    try {
      fac.reset();
      const r = await send(`${app6.url}/ref/echo`, { body: { text: "still verified" }, headers: { "payment-signature": (await signPayment(accept)).header } });
      ok(r.status === 200 && verifies() === 1, "REFERRAL_VERIFY=off is not a switch: /verify is still called before the handler");
    } finally { await app6.close(); }
  }

  // --- the pure payment check -------------------------------------------------------
  {
    const p = await signPayment(accept);
    const okay = checkReferralPayment(p.payload, accept, { needMs: 3000 });
    ok(!okay.reason && !okay.timeReason && okay.auth.from === buyer.address && okay.validBeforeMs > Date.now(), "the pure check passes a payment for the quoted requirement");
    ok(checkReferralPayment({ ...p.payload, payload: { ...p.payload.payload, authorization: { ...p.authorization, to: PAY_TO.toLowerCase() } } }, accept, { needMs: 3000 }).reason === undefined, "the pay-to address is compared without case");
    ok(checkReferralPayment({ ...p.payload, payload: { ...p.payload.payload, authorization: { ...p.authorization, value: 30000 } } }, accept).reason === "invalid_payload", "a value that is not a string is refused");
    ok(checkReferralPayment(null, accept).reason === "invalid_request" && checkReferralPayment([], accept).reason === "invalid_request", "a payment that is not an object is refused");
    ok(checkReferralPayment(p.payload, accept, { needMs: 45_000, nowMs: Date.now() + 20_000 }).timeReason === "invalid_exact_evm_payload_authorization_valid_before" && checkReferralPayment(p.payload, accept, { needMs: 3000, maxValidityMs: 30_000 }).timeReason === "authorization_validity_too_long", "the clock checks: enough validity for the whole run and its settlement, and no more than the bound");
    ok(Object.values(REFERRAL_REASONS).every((t) => typeof t === "string" && t.length > 20 && !/reviewer|commission/i.test(t)), "every reason of the gate's own carries a sentence, in mechanism words");
  }

  // --- the ledger: a private rail no public reader returns ------------------------------
  {
    await quietLedger();
    const tx = good.json.transaction;
    const summary = ledger.salesSummary({ days: 30, detailed: true });
    const text = JSON.stringify(summary);
    ok(!/referral/.test(text) && summary.totals.external.sales === 0 && summary.totals.external.revenueUsd === 0 && Object.keys(summary.totals.byRail).length === 0, `the sales summary (/api/sales) counts and names nothing of it (${JSON.stringify(summary.totals)})`);
    ok(ledger.saleByTx(tx) === null && ledger.salesByTx(tx).length === 0, "a lookup by transaction (attest, feedback, the settlement books, the refund backfill) does not return a referral row");
    ok(ledger.externalSalesForSlugs(["echo", "busy", "chat"], 0, Date.now() + 1000).length === 0 && ledger.firstRecordedTs() === null && ledger.payerHasPaidSale(buyer.address.toLowerCase()) === false, "the refund backfill's read, the ledger's first-row date and the paid-sale test do not see it");
    ok(ledger.proofFeed({ slug: "echo" })?.rows?.length === undefined || !/referral/.test(JSON.stringify(ledger.proofFeed({ slug: "echo" }))), "the proof feed does not carry it");
    // The buyer's own history: what the buyer paid (the gross), never the net.
    const receipts = ledger.payerReceipts(buyer.address.toLowerCase());
    const mine = receipts.rows.find((r) => r.settlementTx === tx);
    ok(mine && mine.amountUsd === 0.03 && mine.quotedUsd === 0.03 && !JSON.stringify(receipts).includes("0.026298"), `the buyer's receipts show the gross the buyer paid, and no figure that gives the commission away (${JSON.stringify(mine)})`);
    const usage = ledger.payerUsage(buyer.address.toLowerCase());
    const echoRow = usage.bySlug.find((r) => r.slug === "echo");
    const grossSum = receipts.rows.reduce((a, r) => a + r.amountUsd, 0);
    ok(usage.totals.calls === receipts.rows.length && Math.abs(usage.totals.paidUsd - +grossSum.toFixed(4)) < 1e-9 && echoRow && Math.abs(echoRow.usd / echoRow.calls - 0.03) < 1e-9 && usage.recent.every((r) => r.priceUsd !== 0.026298), `the buyer's usage totals are the gross too (${usage.totals.calls} calls, $${usage.totals.paidUsd})`);
    // Every statement that reads the sales table states which rails it reads.
    const src = readFileSync(fileURLToPath(new URL("../src/sales-ledger.js", import.meta.url)), "utf8");
    const statements = [...src.matchAll(/(?:db\.prepare\(|const [A-Z_]+ = )\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]).filter((q) => /\bFROM sales\b/i.test(q) && /^SELECT\b/i.test(q.replace(/^[`"]\s*/, "")));
    const unmarked = statements.filter((q) => !/PAYING_RAILS_SQL|PUBLIC_RAIL_SQL|BUYER_RAILS_SQL|buyer-view|private-rail|\bwire (?:IN|=)|rail IN \('card'|rail = 'card'|WINDOW_PAGE|SCORECARD_ROWS|MIN\(id\)|MAX\(id\)/.test(q));
    ok(statements.length >= 40 && unmarked.length === 0, `every SELECT on the sales table reads paying rails, a wire of its own, the public rails, or is a marked buyer or private-rail view (${statements.length} statements${unmarked.length ? `; unmarked: ${unmarked.map((q) => q.replace(/\s+/g, " ").slice(0, 90)).join(" | ")}` : ""})`);
    const pages = [...src.matchAll(/\$\{(WINDOW_PAGE|SCORECARD_ROWS)\}([^`]*)`/g)].filter((m) => m[1] === "WINDOW_PAGE" && !/PAYING_RAILS_SQL|PUBLIC_RAIL_SQL/.test(m[2]));
    ok(pages.length === 0 && /SCORECARD_ROWS = `[^`]*PAYING_RAILS_SQL/.test(src), "and every paged window read names its rails too");
    ok(PRIVATE_RAILS.includes("referral") && !PAYING_RAILS.includes("referral"), "referral is a private rail, never a paying one");
  }

  // ===========================================================================
  // The proof rule, pinned to a real settlement (scripts/fixtures/referral-receipt-base.json)
  // ===========================================================================
  {
    const fx = JSON.parse(readFileSync(new URL("./fixtures/referral-receipt-base.json", import.meta.url), "utf8"));
    const { ROUTED_EVENT_TOPIC } = await import("../src/referral-proof.js");
    const args = { tx: fx.transaction.hash, from: fx.payer, nonce: fx.nonce, payTo: fx.splitContract, amount: fx.amount, merchantId: fx.merchantId, payoutAddress: fx.payoutAddress, minNet: fx.minNet };
    const real = proveReceipt(fx.receipt, args);
    ok(real.verdict === "paid" && real.moved === true && real.read === true, `the real receipt proves the payment with the real merchant id, payout wallet, amount and minimum net (${real.verdict}: ${real.why})`);
    const logs = fx.receipt.logs;
    const pad = (a) => `0x${"0".repeat(24)}${String(a).slice(2).toLowerCase()}`;
    const word = (l, i) => l.data.slice(2 + i * 64, 2 + (i + 1) * 64);
    const routedReal = logs[6];
    ok(logs.length === 7 && routedReal.topics[0] === ROUTED_EVENT_TOPIC && routedReal.topics.length === 4 && routedReal.address === fx.splitContract && routedReal.data.length === 2 + 9 * 64
      && `0x${word(routedReal, 0).slice(24)}` === fx.payer && BigInt(`0x${word(routedReal, 1)}`) === BigInt(fx.merchantId) && BigInt(`0x${word(routedReal, 3)}`) === 1000n && BigInt(`0x${word(routedReal, 8)}`) === 900n,
    "the real routed event is the documented topic from the split contract: three indexed ids, nine data words, word 0 the payer, word 1 the merchant id, word 3 the gross, word 8 the merchant amount");
    ok(logs[0].topics[1] === pad(fx.payer) && logs[0].topics[2] === fx.nonce && logs[1].topics[1] === pad(fx.payer) && logs[1].topics[2] === pad(fx.splitContract) && BigInt(logs[1].data) === 1000n && parseInt(logs[1].logIndex, 16) === parseInt(logs[0].logIndex, 16) + 1
      && logs[5].topics[1] === pad(fx.splitContract) && logs[5].topics[2] === pad(fx.payoutAddress) && BigInt(logs[5].data) === 900n && parseInt(logs[6].logIndex, 16) > parseInt(logs[5].logIndex, 16),
    "its order is the one the rule reads: AuthorizationUsed, directly the payer's transfer into the contract, the split legs, the payout to our wallet, then the routed event last");
    ok(fx.transaction.to === fx.splitContract && fx.receipt.to === fx.splitContract && fx.transaction.selector === "0xc3fbce30" && fx.transaction.from === fx.receipt.from && fx.transaction.from !== fx.payer, "the transaction is sent to the split contract itself, by a relayer that is not the payer");
    ok(referralNet(fx.amount, { commissionBps: 1000, feeBps: 0 }).netUnits === 900n && proveReceipt(fx.receipt, { ...args, nonce: null }).verdict === "paid" && proveReceipt(fx.receipt, { ...args, nonce: null, minNet: "1" }).verdict === "paid", "the net the gate books for that sale is the merchant amount the receipt shows, and the refund path's reading (the payer and the transaction, no nonce) proves it too");
    // Each tamper changes ONE thing; none is paid.
    const w32 = (n) => BigInt(n).toString(16).padStart(64, "0");
    const setWord = (l, i, hex64) => { l.data = `0x${Array.from({ length: 9 }, (_, k) => (k === i ? hex64 : word(l, k))).join("")}`; };
    const OTHER = "0x" + "7".repeat(40);
    const tampered = (fn, over = {}) => { const r = structuredClone(fx.receipt); fn(r); return proveReceipt(r, { ...args, ...over }).verdict; };
    const cases = {
      "another merchant id configured": [tampered(() => {}, { merchantId: "1180382" }), "unpaid"],
      "another merchant id in the event": [tampered((r) => setWord(r.logs[6], 1, w32(7))), "unpaid"],
      "another payer": [tampered(() => {}, { from: OTHER }), "unpaid"],
      "another nonce": [tampered(() => {}, { nonce: "0x" + "1".repeat(64) }), "unpaid"],
      "a larger amount asked": [tampered(() => {}, { amount: "1001" }), "unpaid"],



      "a lower payout transfer alone": [tampered((r) => { r.logs[5].data = `0x${w32(899)}`; }), "unknown"],
      "the routed event from another contract": [tampered((r) => { r.logs[6].address = OTHER; }), "unknown"],
      "the routed event under another topic": [tampered((r) => { r.logs[6].topics[0] = "0x" + "2".repeat(64); }), "unknown"],
      "the routed event removed (a payout transfer alone)": [tampered((r) => { r.logs.pop(); }), "unknown"],
      "the payout to another address": [tampered((r) => { r.logs[5].topics[2] = pad(OTHER); }), "unknown"],
      "the payout wallet configured as another": [tampered(() => {}, { payoutAddress: OTHER }), "unknown"],
      "the payer's transfer short by one": [tampered((r) => { r.logs[1].data = `0x${w32(999)}`; }), "unpaid"],
      "another gross in the event": [tampered((r) => setWord(r.logs[6], 3, w32(1001))), "unknown"],
      "another buyer in the event": [tampered((r) => setWord(r.logs[6], 0, pad(OTHER).slice(2))), "unknown"],
      "the routed event and payout before the payer's transfer": [tampered((r) => { r.logs[5].logIndex = "0x190"; r.logs[6].logIndex = "0x191"; }), "unknown"],
      "the payer's transfer not directly after the authorization": [tampered((r) => { r.logs[0].logIndex = "0x190"; }), "unpaid"],
      "sent to another contract": [tampered((r) => { r.to = OTHER; }), "unknown"],
      "a failed transaction": [tampered((r) => { r.status = "0x0"; }), "unpaid"],
      "another transaction hash asked": [tampered(() => {}, { tx: "0x" + "3".repeat(64) }), "unpaid"],
      "another split contract configured": [tampered(() => {}, { payTo: OTHER }), "unpaid"],
    };
    const wrong = Object.entries(cases).filter(([, [got, want]]) => got !== want || got === "paid");
    ok(wrong.length === 0 && Object.keys(cases).length === 20, `every single-field tamper of the real receipt is refused: never paid (${wrong.map(([k, [got, want]]) => `${k}: ${got}, want ${want}`).join("; ") || "20 tampers"})`);
    {
      // The net does not decide: the buyer paid the whole amount and the contract routed it to us.
      const under = proveReceipt(fx.receipt, { ...args, minNet: "901" });
      const lower = structuredClone(fx.receipt); setWord(lower.logs[6], 8, w32(750)); lower.logs[5].data = `0x${w32(750)}`;
      const low = proveReceipt(lower, args);
      const at = proveReceipt(fx.receipt, args), none = proveReceipt(fx.receipt, { ...args, minNet: null });
      ok(under.verdict === "paid" && under.underFloor === true && under.net === "900" && low.verdict === "paid" && low.underFloor === true && low.net === "750" && at.underFloor === false && none.verdict === "paid" && none.underFloor === false, `a merchant amount under the expected net is still PAID (the contract's rate above the one this server expects): reported as under the floor, with the amount received (${under.verdict}/${under.underFloor}, ${low.net})`);
    }
    const shuffled = structuredClone(fx.receipt);
    shuffled.logs.reverse();
    ok(proveReceipt(shuffled, args).verdict === "paid", "the order is read from the log indexes, not from the order of the list");
    // The refund path (src/payment-verify.js) reads the same receipt the same way.
    const { verifyInboundPayment } = await import("../src/payment-verify.js");
    const refundProof = (receipt, over = {}) => verifyInboundPayment({ network: "eip155:8453", payer: fx.payer, amountUsd: 0.001, tx: fx.transaction.hash, wire: "referral", referralPayTo: fx.splitContract, referralMerchantId: fx.merchantId, referralPayout: fx.payoutAddress, rpcFor: () => "http://rpc.invalid", fetchImpl: async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_getTransactionReceipt" ? receipt : null }), { status: 200, headers: { "content-type": "application/json" } }); }, ...over });
    const noEvent = structuredClone(fx.receipt); noEvent.logs.pop();
    const [rOk, rNoEvent, rOther] = [await refundProof(fx.receipt), await refundProof(noEvent), await refundProof(fx.receipt, { referralMerchantId: "7" })];
    ok(rOk.verified === true && rNoEvent.verified === false && rOther.verified === false, `the refund run proves a debt against the real receipt, and not against it without its routed event or under another merchant id (${rOk.verified}, ${rNoEvent.verified}: ${rNoEvent.reason || ""}, ${rOther.verified})`);
  }

  // ===========================================================================
  // A buyer who leaves DURING the settle call, whose payment then lands
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const store = createReferralAnswerStore({ now: () => Date.now() + skew.ms });
    // One hang-up of the stub price fits a payer's forgiveness budget; a second does not.
    const appH = await mount({ REFERRAL_HANGUP_KEY_USD: "0.03", REFERRAL_HANGUP_GLOBAL_USD: "1" }, { answers: store });
    const { isRepeatHangup, planRefunds } = await import("./refund-run.js");
    try {
      const leave = async (acct, ip, text) => {
        const p = await signPayment(accept, { account: acct, validBefore: String(Math.floor(Date.now() / 1000) + 600) });
        const outcome = await rawPost(`${appH.url}/ref/echo`, { text }, { "payment-signature": p.header, "x-test-ip": ip }, 150);
        return { p, key: gateMod.referralReplayKey(p.authorization), outcome };
      };
      // The answer expires unread; the sweep then owes the payment back.
      const expireAndSweep = async () => { skew.ms = 11 * 60_000; await appH.gate.sweepOnce(); await appH.gate.sweepOnce(); skew.ms = 0; await quietLedger(); };
      const acct = newAccount(), ip = freshIp();
      // 1. The first one, inside the budget: the settle (400 ms) is in flight when the buyer leaves, and lands.
      fac.mode.settleDelayMs = 400;
      const first = await leave(acct, ip, "first");
      await wait(800);
      const e1 = appH.book.get(first.key);
      ok(first.outcome === "aborted" && e1?.state === "charged-undelivered" && e1.hangup === "settle in flight" && sales.length === 1 && Math.abs(appH.gate.stats().forgivenUsd - 0.03) < 1e-9, `a buyer gone during the settle call whose payment lands: charged, undelivered, recorded as a hang-up, and its forgiveness ticket is SPENT (${e1?.state} ${e1?.hangup}; ${appH.gate.stats().forgivenUsd} forgiven)`);
      // 2. The same payer does it again: the budget is spent, so this one carries the reason the refund run holds.
      const second = await leave(acct, ip, "second");
      await wait(800);
      const e2 = appH.book.get(second.key);
      ok(second.outcome === "aborted" && e2?.state === "charged-undelivered" && e2.hangup === "payer budget", `a repeat hang-up during the settle call carries the spent-budget reason, not the first one's (${e2?.state} ${e2?.hangup})`);
      fac.mode.settleDelayMs = 0;
      await expireAndSweep();
      const row1 = owed.filter((o) => o.tx === e1?.tx), row2 = owed.filter((o) => o.tx === e2?.tx);
      ok(row1.length === 1 && row1[0].priceUsd === 0.03 && row1[0].httpStatus === 499 && row1[0].hangupReason === "settle in flight" && isRepeatHangup(row1[0]) === false && row1[0].wire === "referral" && row1[0].payer === acct.address.toLowerCase(), `the first is owed back once, at the GROSS, as an ordinary hang-up debt (${row1.length} row: ${row1[0]?.priceUsd} ${row1[0]?.httpStatus} ${row1[0]?.hangupReason})`);
      ok(row2.length === 1 && row2[0].priceUsd === 0.03 && row2[0].httpStatus === 499 && row2[0].hangupReason === "payer budget" && isRepeatHangup(row2[0]) === true, `the repeat is owed once at the gross with the reason the refund run HOLDS for review (${row2.length} row: ${row2[0]?.httpStatus} ${row2[0]?.hangupReason})`);
      const plan = planRefunds([{ ...row1[0], id: 1, evidence: row1[0]?.tx }, { ...row2[0], id: 2, evidence: row2[0]?.tx }].map((r) => ({ ...r, synthetic: 0 })), { senders: { evm: true }, maxEachUsd: 1, maxTotalUsd: 10, maxPerPayerUsd: 10 });
      const heldRows = Object.values(plan.held || {}).flat();
      ok(heldRows.some((r) => r.id === 2) && !heldRows.some((r) => r.id === 1), `the refund planner holds the repeat and not the first (${Object.keys(plan.held || {}).join("; ")})`);
      await expireAndSweep();
      ok(owed.filter((o) => o.tx === e1?.tx || o.tx === e2?.tx).length === 2 && appH.book.get(first.key)?.state !== "charged-undelivered", "a later pass writes neither debt again");
      // 3. Another payer leaves during a settle that ends in doubt; the payment lands LATER and the sweep finds it.
      sales.length = 0;
      fac.mode.settleDelayMs = 400;
      fac.mode.settle = () => ({ status: 500, body: {} });
      const third = await leave(newAccount(), freshIp(), "third");
      await wait(2200);
      const doubt = appH.book.get(third.key);
      const tx3 = fac.land(third.p.authorization, "0x" + "c3".repeat(32));
      fac.mode.settleDelayMs = 0;
      await appH.gate.sweepOnce();
      await quietLedger();
      const landed = appH.book.get(third.key);
      ok(third.outcome === "aborted" && doubt?.state === "in-doubt" && doubt.hangup === "settle in flight" && landed?.state === "charged-undelivered" && landed.hangup === "settle in flight" && sales.filter((x) => x.tx === tx3).length === 1, `a buyer gone during a settle whose outcome was not known yet is recorded as a hang-up on the open entry, and stays one when the payment lands later (${doubt?.state} ${doubt?.hangup} then ${landed?.state} ${landed?.hangup})`);
      await expireAndSweep();
      const row3 = owed.filter((o) => o.tx === tx3);
      ok(row3.length === 1 && row3[0].priceUsd === 0.03 && row3[0].httpStatus === 499 && row3[0].hangupReason === "settle in flight" && sales.filter((x) => x.tx === tx3).length === 1 && sales.find((x) => x.tx === tx3).priceUsd === 0.026298, `its debt is the gross, once, as a hang-up debt, and the sale stays booked once at the net (${row3.length} row: ${row3[0]?.priceUsd} ${row3[0]?.httpStatus} ${row3[0]?.hangupReason})`);
    } finally { fac.mode.settleDelayMs = 0; skew.ms = 0; await appH.close(); }
  }

  // ===========================================================================
  // A spent authorization whose transaction is found and is NOT a proof of our sale: owed back, never closed
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const bookU = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-unrecognized`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appU = await mount({ REFERRAL_UNRECOGNIZED_READS: "3" }, { book: bookU });
    const closedU = () => (typeof bookU.closedUnrecognized === "function" ? bookU.closedUnrecognized() : []);
    try {
      const open = async (validFor, kind) => {
        const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + validFor) });
        const key = gateMod.referralReplayKey(p.authorization);
        await bookU.intent({ key, slug: "echo", payer: p.authorization.from, nonce: p.authorization.nonce, amount: "30000", validBefore: Number(p.authorization.validBefore), fromBlock: fac.chainState.head });
        await bookU.resolve(key, { state: "in-doubt" });
        return { key, tx: fac.land(p.authorization, null, kind), nonce: p.authorization.nonce.toLowerCase(), payer: p.authorization.from.toLowerCase() };
      };
      const stuck = await open(-600, "noevent");   // expired; the money sits in the contract, no event
      const live = await open(600, "noevent");     // the same, still sendable
      const dark = await open(-600, "noevent");    // the same, its receipt unreadable
      const ours = await open(-600, "paid");       // a receipt that IS ours
      fac.receipts.delete(dark.tx);
      ok(appU.config.unrecognizedReads === 3 && referralConfig(ENV).unrecognizedReads === 5 && referralConfig({ ...ENV, REFERRAL_UNRECOGNIZED_READS: "0" }).unrecognizedReads === 5, "REFERRAL_UNRECOGNIZED_READS is read (default 5; a malformed one reads as the default)");
      for (let i = 0; i < 5; i++) await appU.gate.sweepOnce();
      await quietLedger();
      const eS = bookU.get(stuck.key), eL = bookU.get(live.key), eD = bookU.get(dark.key);
      const rowS = owed.filter((o) => o.tx === stuck.tx), rowL = owed.filter((o) => o.tx === live.tx);
      ok(eS?.state === "in-doubt" && eS.unproven === true && eS.moved === true && eS.debtAt > 0 && eL?.state === "in-doubt" && eL.unproven === true && closedU().length === 0, `a spent authorization whose receipt, read in full, shows the buyer's transfer into the split contract and is no proof of our sale is NEVER closed by itself, however often it is read and whether or not it can still be sent (${eS?.state}/${eS?.unproven}; ${closedU().length} closed)`);
      ok(rowS.length === 1 && rowS[0].priceUsd === 0.03 && rowS[0].wire === "referral-operator" && rowS[0].payer === stuck.payer && rowS[0].evidenceKey === `${stuck.tx}#${stuck.nonce}` && /buyer's transfer into the split contract is proven, no sale was booked/.test(rowS[0].note) && rowL.length === 1 && !sales.some((x) => x.tx === stuck.tx || x.tx === live.tx), `its buyer paid and got nothing: the gross is owed back, once, behind the buyer's own transfer, and no sale is booked (${rowS.length} row at ${rowS[0]?.priceUsd} on ${rowS[0]?.wire})`);
      ok(eD?.state === "in-doubt" && eD.unproven !== true && !owed.some((o) => o.tx === dark.tx), "a receipt that cannot be READ proves nothing either way: no debt, not marked unproven");
      ok(sales.filter((x) => x.tx === ours.tx).length === 1 && owed.filter((o) => o.tx === ours.tx).length === 1 && owed.find((o) => o.tx === ours.tx).wire === "referral", `a receipt that IS ours takes the paid path: booked once, and (its answer never stored) owed back on the ordinary wire (${sales.filter((x) => x.tx === ours.tx).length} sale)`);
      const word = appU.gate.statusWord();
      skew.ms = 25 * 3600_000;
      for (let i = 0; i < 4; i++) await appU.gate.sweepOnce();
      const nextDay = appU.gate.statusWord();
      skew.ms = 0;
      ok(word.status === "attention" && word.reasons.some((x) => /read in full, does not prove the sale/.test(x)) && nextDay.status === "attention" && bookU.get(stuck.key)?.state === "in-doubt" && bookU.get(live.key)?.state === "in-doubt" && closedU().length === 0 && owed.filter((o) => o.tx === stuck.tx || o.tx === live.tx).length === 2, `the word reads attention for it until an operator resolves it: a day later it is still open, still one debt each, nothing closed (${word.reasons.join("; ")})`);
      // The operator's outcomes work on it; a refund asked for by hand writes no second debt.
      const byHand = await appU.gate.resolveByHand(stuck.key, { note: "buyer wrote in; already owed", outcome: "refund" });
      const closedByHand = await appU.gate.resolveByHand(live.key, { note: "checked: refunded", outcome: "dismissed" });
      ok(byHand.ok === true && byHand.debt === true && owed.filter((o) => o.tx === stuck.tx).length === 1 && closedByHand.ok === true && bookU.get(live.key) === null, `the operator's refund on it records the note and writes no second debt; dismissed closes it (${owed.filter((o) => o.tx === stuck.tx).length} row)`);
      // The refund run proves such a row by the payer's own transfer, for this payment's nonce.
      const { verifyInboundPayment } = await import("../src/payment-verify.js");
      const verifyRow = (row, over = {}) => verifyInboundPayment({ network: "eip155:8453", payer: row.payer, amountUsd: row.priceUsd, tx: row.evidenceKey, wire: row.wire, referralPayTo: PAY_TO, referralMerchantId: MERCHANT_ID, referralPayout: PAYOUT, rpcFor: () => "http://rpc.invalid", fetchImpl: async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_getTransactionReceipt" ? fac.receipts.get(row.tx) : null }), { status: 200, headers: { "content-type": "application/json" } }); }, ...over });
      const vOk = await verifyRow(rowS[0]), vPlain = await verifyRow({ ...rowS[0], wire: "referral" }), vOther = await verifyRow({ ...rowS[0], payer: "0x" + "9".repeat(40) }), vMore = await verifyRow({ ...rowS[0], priceUsd: 0.04 }), vNonce = await verifyRow({ ...rowS[0], evidenceKey: `${stuck.tx}#0x${"7".repeat(64)}` }), vBad = await verifyRow({ ...rowS[0], evidenceKey: `${stuck.tx}#nope` });
      ok(vOk.verified === true && vPlain.verified === false && vOther.verified === false && vMore.verified === false && vNonce.verified === false && vBad.verified === false, `the refund run proves that row by the payer's own transfer of the amount under THIS payment's nonce (not as an ordinary referral row, another payer, a larger amount or another nonce) (${vOk.verified}, ${vPlain.verified}, ${vOther.verified}, ${vMore.verified}, ${vNonce.verified}, ${vBad.verified})`);
    } finally { skew.ms = 0; await appU.close(); }
    // A record closed by an earlier build can still be put back, and is then owed back like any other.
    {
      const docR = createJsonDocument({ name: `referral-test-${process.pid}-reopen`, log: () => {} });
      const pR = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) - 600) });
      const keyR = gateMod.referralReplayKey(pR.authorization);
      const txR = fac.land(pR.authorization, null, "noevent");
      await docR.update(() => ({ entries: {}, closed: [{ key: keyR, slug: "echo", payer: pR.authorization.from.toLowerCase(), nonce: pR.authorization.nonce.toLowerCase(), amount: "30000", validBefore: Number(pR.authorization.validBefore), fromBlock: fac.chainState.head, tx: txR, state: "in-doubt", reads: 5, why: "no routed event", at: Date.now() }] }), { fallback: {} });
      const bookR = createReferralBook({ doc: docR, log, now: () => Date.now() + skew.ms });
      await bookR.ready;
      const appRe = await mount({}, { book: bookR });
      try {
        const noNote = await appRe.gate.reopenByHand(keyR, { note: "" });
        const reopened = await appRe.gate.reopenByHand(keyR, { note: "closed too early: checking it by hand" });
        const back = bookR.get(keyR);
        ok(noNote.ok === false && reopened.ok === true && back?.state === "in-doubt" && back.noAutoClose === true && back.seenTx === txR && bookR.closedUnrecognized().length === 0 && bookR.resolvedByHand().some((r) => r.key === keyR && r.outcome === "reopened" && /closed too early/.test(r.note)) && (await appRe.gate.reopenByHand(keyR, { note: "twice over" })).ok === false && appRe.gate.stats().reopenedByHand === 1, `an operator can put a closed record back as an open entry (recorded with the note, removed from the record, once) (${JSON.stringify(back && { state: back.state, noAutoClose: back.noAutoClose })})`);
        for (let i = 0; i < 3; i++) await appRe.gate.sweepOnce();
        const afterR = bookR.get(keyR);
        ok(afterR?.state === "in-doubt" && afterR.unproven === true && afterR.debtAt > 0 && owed.filter((o) => o.tx === txR).length === 1 && owed.find((o) => o.tx === txR).wire === "referral-operator", `a reopened entry is read again, stays open, and its buyer is owed back once (${afterR?.state}; ${owed.filter((o) => o.tx === txR).length} row)`);
      } finally { await appRe.close(); }
    }
  }

  // ===========================================================================
  // An operator's outcome for an entry resolved by hand
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const charged = async (kind = "paid", extra = {}) => {
      const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) });
      const key = gateMod.referralReplayKey(p.authorization);
      const tx = fac.land(p.authorization, null, kind);
      await app1.book.intent({ key, slug: "echo", payer: p.authorization.from, nonce: p.authorization.nonce, amount: "30000", validBefore: Number(p.authorization.validBefore), fromBlock: fac.chainState.head });
      await app1.book.resolve(key, { state: "charged-undelivered", tx, saleBooked: true, ...extra });
      return { key, tx, payer: p.authorization.from.toLowerCase() };
    };
    const recordOf = (key) => app1.book.resolvedByHand().filter((r) => r.key === key);
    const a = await charged();
    const unnamed = await app1.gate.resolveByHand(a.key, { note: "buyer wrote in" });
    const oldWord = await app1.gate.resolveByHand(a.key, { note: "buyer wrote in", outcome: "refunded" });
    const notAWord = await app1.gate.resolveByHand(a.key, { note: "buyer wrote in", outcome: 5 });
    ok(unnamed.ok === false && /outcome/.test(unnamed.error) && oldWord.ok === false && notAWord.ok === false && app1.book.get(a.key)?.state === "charged-undelivered" && owed.length === 0 && recordOf(a.key).length === 0, `a charged, undelivered entry is never closed by hand without one of the three outcomes named (${unnamed.error})`);
    const refund = await app1.gate.resolveByHand(a.key, { note: "buyer wrote in: answer never arrived", outcome: "refund" });
    const rowsA = owed.filter((o) => o.tx === a.tx);
    ok(refund.ok === true && refund.debt === true && rowsA.length === 1 && rowsA[0].priceUsd === 0.03 && rowsA[0].wire === "referral" && rowsA[0].network === "eip155:8453" && rowsA[0].payer === a.payer && /resolved by an operator/.test(rowsA[0].note) && app1.book.get(a.key)?.state === "refund-owed", `the outcome refund writes the debt at the GROSS behind the receipt proof, and the entry stays as the refund-owed mark (${rowsA.length} row, ${rowsA[0]?.priceUsd}, ${app1.book.get(a.key)?.state})`);
    ok(recordOf(a.key).length === 1 && recordOf(a.key)[0].outcome === "refund" && recordOf(a.key)[0].debt === true && recordOf(a.key)[0].state === "charged-undelivered" && /never arrived/.test(recordOf(a.key)[0].note), "and it is recorded with the outcome, the note, the state it was resolved from and that a debt was written");
    const refundAgain = await app1.gate.resolveByHand(a.key, { note: "sent twice by mistake", outcome: "refund" });
    await app1.gate.sweepOnce();
    ok(refundAgain.ok === true && owed.filter((o) => o.tx === a.tx).length === 1, `a second refund for the same entry, and the sweep after it, write no second debt (${owed.filter((o) => o.tx === a.tx).length})`);
    // Behind the proof: a receipt that does not prove a payment to us writes nothing.
    const b = await charged("othermerchant");
    const unproven = await app1.gate.resolveByHand(b.key, { note: "asked for a refund", outcome: "refund" });
    ok(unproven.ok === false && /does not prove/.test(unproven.error) && !owed.some((o) => o.tx === b.tx) && app1.book.get(b.key)?.state === "contradicted" && recordOf(b.key).length === 0, `refund with a receipt that does not prove a payment routed to us writes NO debt and flags the entry (${unproven.error}; ${app1.book.get(b.key)?.state})`);
    await app1.gate.resolveByHand(b.key, { note: "test cleanup: routed elsewhere", outcome: "dismissed" });
    const c = await charged("paid", { delivered: true });
    const servedAlready = await app1.gate.resolveByHand(c.key, { note: "asked for a refund", outcome: "refund" });
    ok(servedAlready.ok === false && /delivered mark/.test(servedAlready.error) && !owed.some((o) => o.tx === c.tx), `refund is refused for an entry that carries the delivered mark (${servedAlready.error})`);
    await app1.gate.resolveByHand(c.key, { note: "test cleanup: delivered", outcome: "delivered" });
    const d = await charged();
    fac.mode.receiptDown = true;
    const unread = await app1.gate.resolveByHand(d.key, { note: "asked for a refund", outcome: "refund" });
    fac.mode.receiptDown = false;
    ok(unread.ok === false && /could not be read/.test(unread.error) && !owed.some((o) => o.tx === d.tx) && app1.book.get(d.key)?.state === "charged-undelivered", `refund with no readable receipt writes nothing and leaves the entry as it was (${unread.error})`);
    const delivered = await app1.gate.resolveByHand(d.key, { note: "the buyer confirmed the answer arrived", outcome: "delivered" });
    const e = await charged();
    const dismissed = await app1.gate.resolveByHand(e.key, { note: "our own test payment", outcome: "dismissed" });
    await app1.gate.sweepOnce();
    ok(delivered.ok === true && delivered.debt === false && dismissed.ok === true && dismissed.debt === false && app1.book.get(d.key) === null && app1.book.get(e.key) === null && !owed.some((o) => o.tx === d.tx || o.tx === e.tx) && recordOf(d.key)[0]?.outcome === "delivered" && recordOf(d.key)[0].debt === false && recordOf(e.key)[0]?.outcome === "dismissed" && /own test payment/.test(recordOf(e.key)[0].note), "delivered and dismissed write no debt: the entry is removed and recorded with the outcome and the note");
  }

  // ===========================================================================
  // How much of an answer went out: delivered, not served, partly served
  // (a deterministic rig between the send and the socket: no kernel buffer decides)
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // The counts and the three endings, on a scripted response: pieces 1 and 2 are taken, piece 3 fails.
    const { sendCounted, sentOutcome } = gateMod;
    {
      const fake = (failAt) => { const r = { destroyed: false, parts: [], ended: 0, write(part, cb) { this.parts.push(part.length); if (this.parts.length === failAt) { this.destroyed = true; cb(new Error("reset")); } else cb(); return true; }, end() { this.ended++; }, destroy() { this.destroyed = true; } }; return r; };
      const body = Buffer.alloc(2500, 0x61);
      const all = fake(0), cut = fake(3), dead = fake(0);
      dead.destroyed = true;
      const [sAll, sCut, sDead] = [sendCounted(all, body, { chunkBytes: 1000 }), sendCounted(cut, body, { chunkBytes: 1000 }), sendCounted(dead, body, { chunkBytes: 1000 })];
      ok(JSON.stringify(all.parts) === "[1000,1000,500]" && all.ended === 1 && sAll.taken === 2500 && sAll.dispatched === 2500 && sentOutcome(sAll).how === "delivered" && sentOutcome(sAll).atMost === 2500, `every piece confirmed: the pieces add up to the body, the response is ended once, and the send reads delivered (${JSON.stringify(sAll)})`);
      ok(JSON.stringify(cut.parts) === "[1000,1000,500]" && cut.ended === 0 && sCut.taken === 2000 && sCut.dispatched === 2500 && sentOutcome(sCut).how === "partial" && sentOutcome(sCut).atMost === 2500 && sentOutcome({ total: 5000, dispatched: 3000, taken: 2000 }).atMost === 3000, `a piece whose write fails is handed over but never counted as taken, nothing follows it, and the send reads partial, bounded by the bytes handed over, not the bytes confirmed (${JSON.stringify(sCut)})`);
      ok(dead.parts.length === 0 && sDead.dispatched === 0 && sentOutcome(sDead).how === "not-served" && sentOutcome(sDead).atMost === 0 && sentOutcome({ total: 10, dispatched: 10, taken: 0 }).how === "partial" && sentOutcome({ total: 10, dispatched: 0, taken: 0 }).how === "not-served" && sentOutcome({ total: 10, dispatched: 10, taken: 10 }).how === "delivered", "nothing handed to a closed connection reads not served; a first piece in flight and unconfirmed reads partial, never not served");
      // The bounds: a write that is never confirmed, and a send that keeps going too long.
      const silent = { destroyed: false, parts: 0, ended: 0, write() { this.parts++; return true; }, end() { this.ended++; }, destroy() { this.destroyed = true; } };
      const slow = { destroyed: false, parts: 0, ended: 0, write(part, cb) { this.parts++; setTimeout(cb, 40); return true; }, end() { this.ended++; }, destroy() { this.destroyed = true; } };
      const t0 = Date.now();
      const sSilent = sendCounted(silent, body, { chunkBytes: 1000, idleMs: 60, maxMs: 5000 });
      const sSlow = sendCounted(slow, Buffer.alloc(100_000, 0x61), { chunkBytes: 1000, idleMs: 5000, maxMs: 150 });
      for (let i = 0; i < 100 && !(silent.destroyed && slow.destroyed); i++) await wait(10);
      const took = Date.now() - t0;
      await wait(120);
      ok(silent.destroyed === true && sSilent.ended === "idle" && silent.parts === 1 && silent.ended === 0 && sSilent.taken === 0 && sentOutcome(sSilent).how === "partial" && took < 1000, `a piece that is never confirmed (a layer that drops the write callback, a reader that stopped) ends the send at the no-progress bound: the response is destroyed, nothing more is written, and the counts read partial (${JSON.stringify(sSilent)} after ${took} ms)`);
      ok(slow.destroyed === true && sSlow.ended === "max" && sSlow.taken > 0 && sSlow.taken < 100_000 && slow.parts <= sSlow.taken / 1000 + 1 && slow.ended === 0, `a send that keeps making progress is still ended at its longest-send bound, and writes nothing after it (${JSON.stringify(sSlow)})`);
      ok(gateMod.REFERRAL_SEND_IDLE_MS === 15_000 && gateMod.REFERRAL_SEND_MAX_MS === 120_000 && referralConfig(ENV).sendIdleMs === 15_000 && referralConfig(ENV).sendMaxMs === 120_000 && referralConfig({ ...ENV, REFERRAL_SEND_IDLE_MS: "400", REFERRAL_SEND_MAX_MS: "9000" }).sendIdleMs === 400 && referralConfig({ ...ENV, REFERRAL_SEND_MAX_MS: "9000" }).sendMaxMs === 9000, "REFERRAL_SEND_IDLE_MS (15 s) and REFERRAL_SEND_MAX_MS (120 s) are read");
    }
    const store = createReferralAnswerStore({ now: () => Date.now() + skew.ms });
    const appD = await mount({}, { answers: store, appUse: [sendRig] });
    const { isRepeatHangup } = await import("./refund-run.js");
    const N = 100_000;
    try {
      const pay = async () => { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) }); return { p, key: gateMod.referralReplayKey(p.authorization) }; };
      const big = (c, headers = {}, n = N) => cutCall(`${appD.url}/ref/big`, { body: { n }, headers: { "payment-signature": c.p.header, "x-test-ip": freshIp(), ...headers } });
      // Several chunks, read to the end: delivered whole, and the entry closes.
      const whole = await pay();
      const full = await big(whole, {}, 300_000);
      await wait(50);
      ok(gateMod.REFERRAL_SEND_CHUNK_BYTES === 16384 && full.status === 200 && full.json?.blob?.length === 300_000 && /^0x[0-9a-f]{64}$/.test(full.json.transaction || "") && Number(full.headers.get("content-length")) === Buffer.byteLength(full.text) && /^application\/json/.test(full.headers.get("content-type") || "") && appD.book.get(whole.key) === null && appD.gate.stats().partlyServed === 0, `an answer of several chunks read to the end arrives whole (its length stated), and is delivered (${full.status}, ${full.json?.blob?.length} characters)`);
      // Two pieces confirmed, the third never: partly served.
      const some = await pay();
      const r1 = await big(some, { "x-test-cut": "32768" });
      await wait(150);
      const e1 = appD.book.get(some.key);
      ok(r1.status === "cut" && e1?.state === "charged-undelivered" && e1.delivered === false && e1.partial === true && e1.partialSent === 49152 && e1.partialOf > N && e1.hangup === gateMod.REFERRAL_PARTIAL_HOLD_REASON && !(Number(e1.sendingUntil) > 0) && appD.gate.stats().partlyServed === 1, `an answer cut off after two pieces were taken and a third was handed over is PARTLY SERVED: not delivered, not closed, marked partial with the bytes handed over, the most the buyer can hold (${e1?.state}, delivered ${e1?.delivered}, at most ${e1?.partialSent} of ${e1?.partialOf})`);
      const settlesBefore = settles();
      const fetched = await big(some);
      await wait(100);
      ok(fetched.status === 200 && fetched.json?.blob?.length === N && settles() === settlesBefore && appD.book.get(some.key) === null, `the kept answer is still there for a re-send of the same payment, which delivers it whole and closes the entry (${fetched.status}, ${fetched.json?.blob?.length})`);
      // The FIRST piece handed over and never confirmed: still partly served, never "not served".
      const first = await pay();
      const r0 = await big(first, { "x-test-cut": "0" });
      await wait(150);
      const e0 = appD.book.get(first.key);
      ok(r0.status === "cut" && e0?.state === "charged-undelivered" && e0.delivered === false && e0.partial === true && e0.partialSent === 16384 && e0.hangup === "payer budget" && appD.gate.stats().partlyServed === 2, `a first piece handed to the socket and never confirmed is partly served too: a piece in flight may have reached the buyer (${e0?.state}, at most ${e0?.partialSent} of ${e0?.partialOf})`);
      // A SEND IN FLIGHT: the sweep leaves its entry alone, and a re-send meanwhile is told so.
      const slowOne = await pay();
      rig.stalled.length = 0;
      const stalledCall = big(slowOne, { "x-test-stall": "16384" });
      for (let i = 0; i < 200 && rig.stalled.length === 0; i++) await wait(10);
      const beforeSweep = appD.book.get(slowOne.key);
      const pass = await appD.gate.sweepOnce();
      const midSend = appD.book.get(slowOne.key);
      ok(rig.stalled.length === 1 && beforeSweep?.delivered === true && Number(beforeSweep.sendingUntil) > Date.now() && midSend?.state === "charged-undelivered" && midSend.delivered === true && !owed.some((o) => o.tx === midSend.tx), `a sweep pass during a send that has not ended leaves the entry and its delivered mark in place (${JSON.stringify(midSend && { state: midSend.state, delivered: midSend.delivered })}; pass ${JSON.stringify(pass)})`);
      const during = await big(slowOne);
      const byHandDuring = await appD.gate.resolveByHand(slowOne.key, { note: "resolving mid-send", outcome: "dismissed" });
      ok(during.status === 409 && during.json?.reason === "inflight" && during.headers.get("x-payment-replay") === "inflight" && appD.gate.stats().sendInflightRefused === 1 && byHandDuring.ok === false, `one send in flight per payment: a re-send while the answer is still going out is answered 409 inflight and holds no second copy; an operator cannot close the entry mid-send (${during.status} ${during.json?.reason})`);
      rig.stalled[0].destroy();
      const stalledEnd = await stalledCall;
      await wait(150);
      const afterReset = appD.book.get(slowOne.key);
      const collected = await big(slowOne);
      await wait(100);
      ok(stalledEnd.status === "cut" && afterReset?.state === "charged-undelivered" && afterReset.partial === true && afterReset.delivered === false && collected.status === 200 && collected.json?.blob?.length === N && appD.book.get(slowOne.key) === null, `when that send ends cut off the entry is still there, partly served, and the re-send collects the whole answer (${afterReset?.state} then ${collected.status})`);
      // The same for a success delivered before its receipt could be read: the receipt arriving mid-send does not close it.
      {
        fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "ab12".repeat(16) } });
        const un = await pay();
        rig.stalled.length = 0;
        const unCall = big(un, { "x-test-stall": "16384" });
        for (let i = 0; i < 200 && rig.stalled.length === 0; i++) await wait(10);
        fac.reset();
        const asSent = appD.book.get(un.key);
        fac.land(un.p.authorization, "0x" + "ab12".repeat(16));
        await appD.gate.sweepOnce();
        const confirmedMidSend = appD.book.get(un.key);
        rig.stalled[0].destroy();
        await unCall;
        await wait(150);
        const cutAfter = appD.book.get(un.key);
        const got = await big(un);
        await wait(100);
        ok(asSent?.state === "unconfirmed" && asSent.delivered === true && confirmedMidSend?.state === "charged-undelivered" && confirmedMidSend.delivered === true && cutAfter?.state === "charged-undelivered" && cutAfter.partial === true && got.status === 200 && got.json?.blob?.length === N && appD.book.get(un.key) === null, `an unconfirmed payment whose receipt proves it while its answer is still going out keeps its entry (now charged); the cut-off send is then partly served and the re-send collects the answer (${asSent?.state} -> ${confirmedMidSend?.state} -> ${cutAfter?.state}; re-send ${got.status})`);
      }
      // After the bound a delivered mark left by a process that died is closed as before.
      const dead = await pay();
      await appD.book.intent({ key: dead.key, slug: "big", payer: dead.p.authorization.from, nonce: dead.p.authorization.nonce, amount: "30000", validBefore: Number(dead.p.authorization.validBefore), fromBlock: fac.chainState.head });
      await appD.book.resolve(dead.key, { state: "charged-undelivered", tx: "0x" + "de".repeat(32), delivered: true, sendingUntil: Date.now() + 60_000 });
      await appD.gate.sweepOnce();
      const kept1 = appD.book.get(dead.key)?.delivered;
      skew.ms = 2 * 60_000;
      await appD.gate.sweepOnce();
      skew.ms = 0;
      ok(kept1 === true && appD.book.get(dead.key) === null && !owed.some((o) => o.tx === "0x" + "de".repeat(32)), "a delivered mark with no send behind it (the process that set it is gone) is kept until its bound has passed and then closed, never refunded");
      // Never collected: the debt is written at the gross, and HELD for review.
      skew.ms = 11 * 60_000;
      await appD.gate.sweepOnce();
      await appD.gate.sweepOnce();
      skew.ms = 0;
      const rows = owed.filter((o) => o.tx === e0?.tx);
      ok(rows.length === 1 && rows[0].priceUsd === 0.03 && rows[0].httpStatus === 499 && rows[0].hangupReason === "payer budget" && isRepeatHangup(rows[0]) === true && /partly sent \(at most 16384 of \d+ bytes\)/.test(rows[0].note) && !owed.some((o) => o.tx === e1?.tx), `a partly served answer that is never collected is owed once at the gross with the reason the refund run HOLDS (never repaid on its own), its byte counts in the note; the one collected by a re-send is owed nothing (${rows.length} row: ${rows[0]?.httpStatus} ${rows[0]?.hangupReason}; ${rows[0]?.note})`);
    } finally { skew.ms = 0; await appD.close(); }
    // The bounds on a mounted gate: a send that makes no progress ends by itself.
    const appI = await mount({ REFERRAL_SEND_IDLE_MS: "300" }, { appUse: [sendRig] });
    try {
      const pay = async () => { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) }); return { p, key: gateMod.referralReplayKey(p.authorization) }; };
      // The first piece is handed over and never confirmed. A reader that stopped taking it sees the
      // connection cut; behind a layer that drops the callback the bytes do go out (the client has the
      // answer), and this server, with no confirmation, cannot say so: it ends the send and reads partial.
      for (const [name, headers, clientSees] of [["a reader that stops taking the answer", { "x-test-stall": "0" }, "cut"], ["a layer that never calls the write callback back", { "x-test-drop": "1" }, 200]]) {
        const c = await pay();
        const t0 = Date.now();
        const r = await Promise.race([cutCall(`${appI.url}/ref/big`, { body: { n: 5000 }, headers: { "payment-signature": c.p.header, "x-test-ip": freshIp(), ...headers } }), wait(5000).then(() => ({ status: "hung" }))]);
        const took = Date.now() - t0;
        // Where the client already has its 200, the send is still open here until the bound: a re-send is told so.
        const early = clientSees === 200 ? await cutCall(`${appI.url}/ref/big`, { body: { n: 5000 }, headers: { "payment-signature": c.p.header, "x-test-ip": freshIp() } }) : { status: 409 };
        for (let i = 0; i < 100 && appI.book.get(c.key)?.delivered !== false; i++) await wait(20);
        const ended = Date.now() - t0;
        const e = appI.book.get(c.key);
        ok(r.status === clientSees && took < 3000 && ended < 3000 && e?.state === "charged-undelivered" && e.delivered === false && e.partial === true && !(Number(e.sendingUntil) > 0) && (clientSees === 200 ? early.status === 409 : true), `${name}: the send ends at the no-progress bound instead of waiting forever, the entry reads partly served and the answer is kept (the client saw ${r.status}; ended after ${ended} ms; ${e?.state}, partial ${e?.partial})`);
        const again = await cutCall(`${appI.url}/ref/big`, { body: { n: 5000 }, headers: { "payment-signature": c.p.header, "x-test-ip": freshIp() } });
        await wait(50);
        ok(again.status === 200 && again.json?.blob?.length === 5000 && appI.book.get(c.key) === null, `and a re-send on a clean connection collects it (${again.status})`);
      }
      ok(appI.gate.stats().sendsEndedIdle === 2 && logLines.some((l) => /send was ended at its no-progress bound/.test(l)), `each is counted and logged (${appI.gate.stats().sendsEndedIdle})`);
    } finally { await appI.close(); }
  }

  // ===========================================================================
  // The minimum net: tolerant of the contract's rounding, never of a short payout
  // ===========================================================================
  {
    const { referralMinNet } = gateMod;
    const ceil = (a, b) => (a + b - 1n) / b;
    const rows = [];
    let bad = 0;
    for (const gross of [1n, 7n, 999n, 1000n, 1234n, 30001n]) for (const c of [1000n, 1500n]) for (const f of [0n, 300n]) {
      const min = referralMinNet(gross, { commissionBps: Number(c), feeBps: Number(f) });
      // What a contract may pay: the merchant share floored; or the gross less each leg rounded up
      // (the commission in two legs of 65% and 35% of it, and the fee).
      const floored = (gross * (10_000n - c - f)) / 10_000n;
      const legsUp = gross - ceil(gross * c * 65n, 1_000_000n) - ceil(gross * c * 35n, 1_000_000n) - (f ? ceil(gross * f, 10_000n) : 0n);
      const exact = referralNet(gross, { commissionBps: Number(c), feeBps: Number(f) }).netUnits;
      rows.push(`${gross}@${c}+${f}: min ${min}, floored ${floored}, legs up ${legsUp}`);
      if (min > floored || (legsUp > 0n && min > legsUp) || min > exact || exact - min > 5n || min < 0n) bad++;
    }
    ok(bad === 0 && rows.length === 24, `at every amount, commission and fee the minimum net admits a merchant share rounded in the contract's favor (floored, or every leg rounded up) and stays within 5 units of the exact net (${rows.filter((_, i) => i % 5 === 0).join("; ")})`);
    ok(referralMinNet(1000n, { commissionBps: 1000 }) === 897n && referralMinNet(1234n, { commissionBps: 1000 }) === 1107n && referralMinNet(1234n, { commissionBps: 1500, feeBps: 300 }) === 1008n && referralMinNet(1n, { commissionBps: 1000 }) === 0n, "the figures: 1000 at 10% asks 897, 1234 at 10% asks 1107, 1234 at 15% plus 3% asks 1008, and it never goes below zero");
    // Through the proof and the gate: a sale of 1234 at 10% whose contract floored the merchant share (1110, where the exact net is 1111).
    const a = { from: newAccount().address, to: PAY_TO, value: "1234", nonce: freshNonce() };
    const txOdd = fac.land(a, null, "paid", { bps: 0n });
    const odd = structuredClone(fac.receipts.get(txOdd));
    const setNet = (r, net) => { r.logs[2].data = `0x${BigInt(net).toString(16).padStart(64, "0")}`; r.logs[3].data = r.logs[3].data.slice(0, 2 + 8 * 64) + BigInt(net).toString(16).padStart(64, "0"); return r; };
    const proveOdd = (net) => proveReceipt(setNet(structuredClone(odd), net), { tx: txOdd, from: a.from, nonce: a.nonce, payTo: PAY_TO, amount: "1234", merchantId: MERCHANT_ID, payoutAddress: PAYOUT, minNet: referralMinNet(1234n, { commissionBps: 1000 }).toString() });
    ok(proveOdd(1110n).verdict === "paid" && proveOdd(1110n).net === "1110" && proveOdd(1111n).verdict === "paid" && proveOdd(1107n).verdict === "paid" && proveOdd(1107n).underFloor === false && proveOdd(1106n).verdict === "paid" && proveOdd(1106n).underFloor === true && proveOdd(1106n).routedToUs === true, `a merchant share rounded down by the contract is paid inside the floor, and the proof states the amount received; one under the tolerance is paid and reported as under the floor (${proveOdd(1110n).underFloor}, ${proveOdd(1106n).underFloor})`);
  }
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // The sale is booked at the amount the receipt shows, not at a computed one.
    fac.mode.settle = (call) => {
      const t = fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx());
      const r = fac.receipts.get(t), w = (26296n).toString(16).padStart(64, "0");
      r.logs[2].data = `0x${w}`;
      r.logs[3].data = r.logs[3].data.slice(0, 2 + 8 * 64) + w;
      return { status: 200, body: { success: true, transaction: t, network: REFERRAL_NETWORK } };
    };
    const p = await signPayment(accept, { account: newAccount() });
    const r = await send(R("echo"), { body: { text: "received net" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
    await quietLedger();
    ok(r.status === 200 && sales.length === 1 && sales[0].priceUsd === 0.026296 && sales[0].quoteUsd === 0.03, `a payout that differs from the computed net inside the tolerance (26296 where 26298 was computed) is booked as received (${sales[0]?.priceUsd})`);
    // A success booked before its receipt can be read has only the computed net.
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "e7".repeat(32) } });
    const q = await signPayment(accept, { account: newAccount() });
    const u = await send(R("echo"), { body: { text: "no receipt yet" }, headers: { "payment-signature": q.header, "x-test-ip": freshIp() } });
    await quietLedger();
    ok(u.status === 200 && sales.length === 2 && sales[1].priceUsd === 0.026298, `an unconfirmed success, whose receipt is not there to read, is booked at the computed net (${sales[1]?.priceUsd})`);
    fac.land(q.authorization, "0x" + "e7".repeat(32));
    await app1.gate.sweepOnce();
  }

  // ===========================================================================
  // A receipt the split contract routed to OUR merchant, paid to a wallet this server does not hold
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    // This server's payout address is behind the chain: every receipt pays PAYOUT, the reader expects another wallet.
    const bookP = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-drift`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appP = await mount({ REFERRAL_UNRECOGNIZED_READS: "3" }, { book: bookP, chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: newAccount().address, headMaxAgeMs: 0, tries: 2, budgetMs: 1200, pauseMs: 100, timeoutMs: 500 }) });
    try {
      const open = async (kind) => {
        const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) - 600) });
        const key = gateMod.referralReplayKey(p.authorization);
        await bookP.intent({ key, slug: "echo", payer: p.authorization.from, nonce: p.authorization.nonce, amount: "30000", validBefore: Number(p.authorization.validBefore), fromBlock: fac.chainState.head });
        await bookP.resolve(key, { state: "in-doubt" });
        return { key, tx: fac.land(p.authorization, null, kind), payer: p.authorization.from.toLowerCase() };
      };
      const ours = [await open("paid"), await open("paid"), await open("paid")];
      const elsewhere = await open("othermerchant");
      for (let i = 0; i < 6; i++) await appP.gate.sweepOnce();
      await quietLedger();
      const keptP = ours.map((o) => bookP.get(o.key));
      ok(keptP.every((e) => e?.state === "in-doubt" && e.routedToUs === true && e.unproven === true && e.debtAt > 0) && keptP[0].seenTx === ours[0].tx && bookP.closedUnrecognized().length === 0, `an entry whose receipt carries the split contract's routed event naming OUR merchant id, and pays a wallet this server does not hold, is never closed, however often it is read (${keptP.map((e) => `${e?.state}/${e?.routedToUs}`).join(", ")})`);
      ok(ours.every((o) => owed.filter((r) => r.tx === o.tx).length === 1) && owed.every((r) => r.priceUsd === 0.03 && r.wire === "referral-operator") && sales.length === 0 && bookP.get(elsewhere.key) === null && !owed.some((r) => r.tx === elsewhere.tx), `each buyer is owed the gross back once, no sale is booked on that reading; a payment routed to another merchant is closed as not paid with no debt (${owed.length} rows)`);
      const word = appP.gate.statusWord();
      ok(word.status === "attention" && word.reasons.some((x) => /routed to this merchant/.test(x)) && word.reasons.some((x) => /came from 3 or more payers/.test(x)), `the word reads attention for them, and three such payers hold the route (${word.reasons.join("; ")})`);
      // A charged entry (proven once) whose receipt now fails on the payout: owed back by the same rule.
      const chargedDrift = await open("paid");
      await bookP.resolve(chargedDrift.key, { state: "charged-undelivered", tx: chargedDrift.tx, saleBooked: true });
      await appP.gate.sweepOnce();
      ok(owed.filter((r) => r.tx === chargedDrift.tx).length === 1 && bookP.get(chargedDrift.key)?.state === "refund-owed", `a charged, undelivered entry whose receipt reads that way is owed back too (${owed.filter((r) => r.tx === chargedDrift.tx).length} row, ${bookP.get(chargedDrift.key)?.state})`);
      // The operator's three outcomes work on them; a refund by hand adds no second debt.
      const refund = await appP.gate.resolveByHand(ours[0].key, { note: "the payout wallet was changed on chain; this buyer was not served", outcome: "refund" });
      const refundAgain = await appP.gate.resolveByHand(ours[0].key, { note: "asked twice", outcome: "refund" });
      const delivered = await appP.gate.resolveByHand(ours[1].key, { note: "the buyer confirmed the answer", outcome: "delivered" });
      const dismissed = await appP.gate.resolveByHand(ours[2].key, { note: "our own test payment", outcome: "dismissed" });
      ok(refund.ok === true && refund.debt === true && refundAgain.ok === true && owed.filter((r) => r.tx === ours[0].tx).length === 1 && bookP.resolvedByHand().filter((r) => r.key === ours[0].key && r.outcome === "refund").length === 1 && delivered.ok === true && dismissed.ok === true && bookP.get(ours[1].key) === null && bookP.get(ours[2].key) === null, `the operator's refund records the note with no second debt and no second hand record; delivered and dismissed close an entry (${owed.filter((r) => r.tx === ours[0].tx).length} row, ${bookP.resolvedByHand().filter((r) => r.key === ours[0].key).length} record)`);
      // Never for a receipt that cannot be read.
      const unreadable = await open("noevent");
      await bookP.resolve(unreadable.key, { seenTx: unreadable.tx });
      fac.mode.receiptDown = true;
      const noReceipt = await appP.gate.resolveByHand(unreadable.key, { note: "asked for a refund", outcome: "refund" });
      fac.mode.receiptDown = false;
      ok(noReceipt.ok === false && /could not be read/.test(noReceipt.error) && !owed.some((r) => r.tx === unreadable.tx), `the operator's refund is refused for a receipt that cannot be read (${noReceipt.error})`);
      for (const e of bookP.list()) await appP.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
    } finally { skew.ms = 0; await appP.close(); }
  }

  // ===========================================================================
  // The contract's rate above the commission map: paid, served, booked as received, raised at once
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const bookS = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-short`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appS = await mount({}, { book: bookS });
    const chainPays = (bps) => { fac.mode.settle = (call) => ({ status: 200, body: { success: true, transaction: fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: BigInt(bps) }), network: REFERRAL_NETWORK } }); };
    const paid = async (slug, account = newAccount()) => { const p = await signPayment(accept, { account }); const r = await send(`${appS.url}/ref/${slug}`, { body: { text: "rate" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); return { r, p, key: gateMod.referralReplayKey(p.authorization) }; };
    try {
      // The map says 1234 bps; the contract takes 2500: 22500 arrives where at least 26295 is expected.
      chainPays(2500);
      const before = { unconfirmed: appS.gate.stats().unconfirmed, held: appS.gate.stats().unconfirmedHeld };
      const same = newAccount();
      const calls = [];
      for (let i = 0; i < 8; i++) calls.push(await paid("echo", i >= 6 ? same : newAccount()));
      await quietLedger();
      await wait(60);
      ok(calls.every((c) => c.r.status === 200 && c.r.json?.echo === "rate") && settles() === 8 && bookS.size() === 0 && appS.gate.stats().unconfirmed === before.unconfirmed && appS.gate.stats().unconfirmedHeld === before.held && bookS.faults().length === 0, `a receipt that shows the buyer's transfer and the routed event naming our merchant is a PAID call whatever the net: 8 of 8 answered (a payer's second payment too), nothing left open, no unconfirmed slot used, no hold (${calls.map((c) => c.r.status).join(" ")}; book ${bookS.size()})`);
      ok(sales.length === 8 && sales.every((x) => x.priceUsd === 0.0225 && x.quoteUsd === 0.03) && ledger.privateRailSaleByTx(sales[0].tx, "referral")?.netUsd === 0.0225, `each sale is booked at the merchant amount its receipt shows, not at the computed net (${sales[0]?.priceUsd})`);
      const word = appS.gate.statusWord();
      const rec = bookS.shortSales().echo;
      ok(word.status === "attention" && word.reasons.some((x) => /^echo: .*expected at least 26295, received 22500, of a gross of 30000; 8 sale\(s\)\)$/.test(x)) && rec?.count === 8 && rec.deep === 0 && appS.gate.stats().shortNetSales === 8 && logLines.some((l) => /SHORT NET: .* for echo: expected at least 26295, received 22500/.test(l)), `the word reads attention from the first such sale, with a reason that names the slug and both amounts; a gap of this size never stops a buyer (${word.reasons.join("; ")})`);
      await bookS.noteShort("echo", { expected: "26295", received: "22500", gross: "30000", tx: sales[0].tx });
      ok(bookS.shortSales().echo.count === 8, `a transaction is counted once, however often it is noted (${bookS.shortSales().echo.count})`);
      // The reverse (the map above the contract's rate) raises nothing.
      chainPays(500);
      const generous = await paid("exa");
      await quietLedger();
      ok(generous.r.status === 200 && !bookS.shortSales().exa && sales[sales.length - 1].priceUsd === 0.0285, `a payout above the expected net is served, booked as received, and raises nothing (${generous.r.status}, ${sales[sales.length - 1]?.priceUsd})`);
      // FAR under the floor (under half of it): after three such sales the slug stops, before the handler.
      chainPays(6000);
      const deep = [];
      for (let i = 0; i < 3; i++) deep.push(await paid("list"));
      await wait(60);
      const at = { settles: settles(), verifies: verifies() };
      const stopped = await paid("list");
      const otherSlug = await paid("owntx");
      ok(appS.config.shortNetMax === 3 && deep.every((c) => c.r.status === 200) && bookS.shortSales().list?.deep === 3 && stopped.r.status === 503 && stopped.r.json?.errorReason === "rate_under_review" && stopped.r.headers.get("retry-after") === "300" && settles() === at.settles + 1 && bookS.get(stopped.key) === null && otherSlug.r.status === 200 && appS.gate.stats().shortNetHeld === 1 && appS.gate.statusWord().reasons.some((x) => /^list: .*new calls on it are held/.test(x)), `a slug whose sales arrive under half the expected net is stopped after three of them: the next call on it is answered 503 before anything is sent or run, nothing charged; another slug is served (${deep.map((c) => c.r.status).join(" ")} then ${stopped.r.status} ${stopped.r.json?.errorReason}; other slug ${otherSlug.r.status})`);
      ok(referralConfig({ ...ENV, REFERRAL_SHORT_NET_MAX: "0" }).shortNetMax === 0 && referralConfig({ ...ENV, REFERRAL_SHORT_NET_MAX: "7" }).shortNetMax === 7 && referralConfig(ENV).shortNetMax === 3, "REFERRAL_SHORT_NET_MAX is read (3; 0 never stops a slug)");
      // The operator clears it; the stop ends, and it is recorded.
      const noNote = await appS.gate.clearShortByHand("list", { note: "" });
      const cleared = await appS.gate.clearShortByHand("list", { note: "the rate is being corrected; serve meanwhile" });
      chainPays(1234);
      const resumed = await send(`${appS.url}/ref/list`, { body: { text: "rate" }, headers: { "payment-signature": stopped.p.header, "x-test-ip": freshIp() } });
      ok(noNote.ok === false && cleared.ok === true && !bookS.shortSales().list && resumed.status === 200 && bookS.resolvedByHand().some((r) => r.outcome === "short-net-cleared" && r.slug === "list" && /being corrected/.test(r.note)) && (await appS.gate.clearShortByHand("list", { note: "twice over" })).ok === false, `an operator clears the record with a note (recorded), and the refused payment, never claimed, is then served (${resumed.status})`);
    } finally { await appS.close(); }
    // A restart with the corrected map: the record no longer reads short, and the sweep drops it.
    const appS2 = await mount({ REFERRAL_COMMISSION_BPS: "default:2500,busy:4321" }, { book: bookS });
    try {
      const wordFixed = appS2.gate.statusWord();
      const hadRecord = !!bookS.shortSales().echo;
      await appS2.gate.sweepOnce();
      ok(hadRecord && !wordFixed.reasons.some((x) => /^echo:/.test(x)) && !bookS.shortSales().echo, `once the map admits the amount received the reason is gone, and the next sweep drops the record (${wordFixed.reasons.join("; ") || "no reasons"})`);
    } finally { await appS2.close(); }
  }

  // ===========================================================================
  // A success booked before its receipt could be read is corrected to the amount received
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const bookC = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-correct`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appC = await mount({}, { book: bookC });
    try {
      const txC = "0x" + "c9".repeat(32);
      fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: txC } });
      const acct = newAccount();
      const p = await signPayment(accept, { account: acct });
      const r = await send(`${appC.url}/ref/echo`, { body: { text: "early" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
      await quietLedger();
      const early = ledger.privateRailSaleByTx(txC, "referral");
      // The receipt arrives: the contract took 2500 bps, the sale was booked at the map's 1234.
      fac.land(p.authorization, txC, "paid", { bps: 2500n });
      await appC.gate.sweepOnce();
      await wait(80);
      const late = ledger.privateRailSaleByTx(txC, "referral");
      const mine = ledger.payerReceipts(acct.address.toLowerCase()).rows.filter((x) => x.settlementTx === txC);
      ok(r.status === 200 && early?.netUsd === 0.026298 && late?.netUsd === 0.0225 && late.id === early.id && late.grossUsd === 0.03 && mine.length === 1 && sales.length === 1 && appC.gate.stats().netsCorrected === 1 && bookC.shortSales().echo?.count === 1 && bookC.size() === 0, `at confirmation the ONE row is corrected in place to the receipt's merchant amount: no second row, the buyer's receipts list it once, and the short net is raised then (${early?.netUsd} -> ${late?.netUsd}; rows ${mine.length})`);
      await appC.gate.sweepOnce();
      await wait(40);
      ok(ledger.privateRailSaleByTx(txC, "referral")?.netUsd === 0.0225 && appC.gate.stats().netsCorrected === 1 && bookC.shortSales().echo?.count === 1, "and it is corrected, and counted, once");
    } finally { await appC.close(); }
  }

  // ===========================================================================
  // Contradicted successes from several payers hold the route; the hold probes and heals itself
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const routedElsewhere = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "othermerchant"), network: REFERRAL_NETWORK } });
    const routedToUs = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()), network: REFERRAL_NETWORK } });
    const heldReason = (app) => app.gate.statusWord().reasons.some((x) => /came from 3 or more payers/.test(x));
    // This server's merchant id setting is not the id the contract routes to: every success is contradicted.
    const bookM = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-many`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appM = await mount({ REFERRAL_OWN_FAULT_COOLDOWN_MS: "60000" }, { book: bookM, chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: "9999", payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 2, budgetMs: 1200, pauseMs: 100, timeoutMs: 500 }) });
    try {
      const pay = async (account = newAccount()) => { const p = await signPayment(accept, { account }); return { p, key: gateMod.referralReplayKey(p.authorization), r: await send(`${appM.url}/ref/echo`, { body: { text: "m" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }) }; };
      const runsBefore = runs.echo;
      const first = [await pay(), await pay(), await pay()];
      const probe = await pay();
      const at = { runs: runs.echo, settles: settles(), verifies: verifies() };
      const later = [];
      for (let i = 0; i < 6; i++) later.push(await pay());
      const word = appM.gate.statusWord();
      ok(gateMod.REFERRAL_CONTRADICTED_PAYERS === 3 && first.every((c) => c.r.status === 409 && bookM.get(c.key)?.state === "contradicted" && bookM.get(c.key).moved === true && bookM.get(c.key).scope === "payer") && probe.r.status === 409 && at.runs === runsBefore + 4 && later.every((c) => c.r.status === 503 && c.r.json?.errorReason === "settlement_under_review" && c.r.headers.get("retry-after") === "30") && runs.echo === at.runs && settles() === at.settles && verifies() === at.verifies && word.status === "attention" && heldReason(appM), `with a setting that is really wrong, three payers are contradicted, ONE more goes through as the probe and is contradicted too, and the next six are answered 503 before anything runs or is charged: one probe a cool-down, not every buyer (${first.map((c) => c.r.status).join(" ")} | probe ${probe.r.status} | ${later.map((c) => c.r.status).join(" ")}; ${runs.echo - runsBefore} runs)`);
      // It also ends when those entries resolve.
      for (const c of [...first, probe].slice(0, 2)) await appM.gate.resolveByHand(c.key, { note: "merchant id setting corrected", outcome: "dismissed" });
      ok(bookM.faults().filter((f) => f.moved).length === 2 && !heldReason(appM), "it ends when the entries resolve");
      for (const e of bookM.list()) await appM.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
    } finally { await appM.close(); }

    // An outside party: three wallets, one small payment each, routed to another merchant.
    fac.reset();
    const bookO = createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-one`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const appO = await mount({ REFERRAL_OWN_FAULT_COOLDOWN_MS: "60000" }, { book: bookO });
    try {
      const payO = async (slug = "echo", account = newAccount()) => { const p = await signPayment(accept, { account, validBefore: String(Math.floor((Date.now() + skew.ms) / 1000) + 60) }); return send(`${appO.url}/ref/${slug}`, { body: { text: "o" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); };
      const seed = async (payer, extra) => { const key = `referral:${createHash("sha256").update(`${payer}${Math.random()}`).digest("hex")}`; await bookO.intent({ key, slug: "echo", payer, nonce: freshNonce(), amount: "30000", validBefore: Math.floor(Date.now() / 1000) + 600, fromBlock: fac.chainState.head }); await bookO.resolve(key, { state: "contradicted", scope: "payer", tx: "0x" + "1".repeat(64), ...extra }); return key; };
      // What does NOT hold the route.
      const one = "0x" + "a1".repeat(20), t = Date.now();
      for (let i = 0; i < 5; i++) await seed(one, { moved: true, contradictedAt: t });
      const onePayer = heldReason(appO);
      await seed("0x" + "a2".repeat(20), { moved: true, contradictedAt: t });
      await seed("0x" + "a3".repeat(20), { moved: false, contradictedAt: t });
      await seed("0x" + "a4".repeat(20), { moved: true, contradictedAt: t - 20 * 60_000 });
      const twoPayers = heldReason(appO);
      ok(onePayer === false && twoPayers === false && (await payO()).status === 200, "one payer's five contradicted payments hold nobody else; nor do two payers, one that moved no money, or one outside the window");
      for (const e of bookO.list()) await appO.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
      // A contradiction that MOVED NOTHING (the named transaction reverted) never counts, from any number of payers.
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "reverted"), network: REFERRAL_NETWORK } });
      const unmoved = [];
      for (let i = 0; i < 4; i++) unmoved.push((await payO()).status);
      const unmovedEntries = bookO.list().filter((e) => e.state === "contradicted");
      fac.mode.settle = routedToUs;
      const afterUnmoved = await payO("exa");
      ok(unmovedEntries.length === 4 && unmovedEntries.every((e) => e.moved === false) && !heldReason(appO) && afterUnmoved.status === 200, `contradicted successes whose transaction moved no money stay out of the route hold, whatever their number (${unmoved.join(" ")}; moved ${unmovedEntries.map((e) => e.moved).join(",")}; next ${afterUnmoved.status})`);
      for (const e of bookO.list()) await appO.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
      // THE ATTACK: three wallets close the route...
      fac.mode.settle = routedElsewhere;
      const attack = [];
      for (let i = 0; i < 3; i++) attack.push((await payO()).status);
      const closed = heldReason(appO);
      // A probe answered success with NO readable receipt proves nothing: the hold stands.
      fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + createHash("sha256").update(`unproven-${Math.random()}`).digest("hex") } });
      const unproven = await payO("exa");
      const stillClosed = heldReason(appO);
      for (const e of bookO.list().filter((x) => x.state === "unconfirmed")) await appO.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
      ok(unproven.status === 200 && stillClosed === true, `a probe whose success has no readable receipt does not end the hold: only a receipt that proves the payment does (${unproven.status}, held ${stillClosed})`);
      // ...and the next honest payment is the probe: it proves fine, is served, and the hold is over.
      fac.mode.settle = routedToUs;
      fac.mode.settleDelayMs = 400;
      const [honest, meanwhile] = await Promise.all([payO("busy"), wait(150).then(() => payO("exa"))]);
      fac.mode.settleDelayMs = 0;
      const reopened = !heldReason(appO);
      const next = await payO("exa");
      ok(attack.every((x) => x === 409) && closed === true && honest.status === 200 && meanwhile.status === 503 && meanwhile.json?.errorReason === "settlement_under_review" && meanwhile.headers.get("retry-after") === "30" && reopened && next.status === 200 && bookO.counts().contradicted === 3, `three small payments hold the route only until the next honest payment: it goes through as the ONE probe (a second payer meanwhile waits), its receipt proves paid, and the hold ends with the three entries still open (${attack.join(" ")}; probe ${honest.status}, meanwhile ${meanwhile.status}, then ${next.status})`);
      // Contradictions among sales that prove fine never add up: only those since the last proven sale count.
      fac.mode.settle = routedElsewhere;
      const two = [(await payO()).status, (await payO()).status];
      fac.mode.settle = routedToUs;
      const fine = await payO("exa");
      fac.mode.settle = routedElsewhere;
      const third = (await payO()).status;
      ok(two.join() === "409,409" && fine.status === 200 && third === 409 && !heldReason(appO), "two contradicted payers, a sale that proves, then a third contradicted payer: no hold");
      const regular = newAccount();
      fac.mode.settle = routedToUs;
      const firstSale = await payO("exa", regular);
      fac.mode.settle = routedElsewhere;
      await quietLedger();
      ok(firstSale.status === 200 && ledger.payerHasPrivateRailSale(regular.address, "referral") === true && ledger.payerHasPaidSale(regular.address) === false && ledger.payerHasPrivateRailSale(newAccount().address, "referral") === false && ledger.payerHasPrivateRailSale(regular.address, "usdc") === false, "a sale on this gate's own rail makes its payer a returning buyer here, by a reader of that rail only: the paying-rail reader does not change");
      // To keep it closed the outside party must itself be every probe: a contradicted probe keeps the hold
      // and starts a cool-down for payers that never paid here; a payer with a paid sale probes at once.
      const more = [(await payO()).status, (await payO()).status, (await payO()).status];
      const heldAgain = heldReason(appO);
      const attackerProbe = await payO();
      fac.mode.settle = routedToUs;
      const stranger = await payO("exa");
      // A RETURNING /ref buyer: a real sale booked on this rail earlier (before the hold), not a mark set by hand.
      const returning = await payO("exa", regular);
      const afterReturning = await payO("exa");
      ok(more.join() === "409,409,409" && heldAgain && attackerProbe.status === 409 && stranger.status === 503 && returning.status === 200 && afterReturning.status === 200 && !heldReason(appO), `a contradicted probe keeps the hold and a never-paid payer waits out the cool-down, while a payer with a paid sale on the books probes at once and reopens the route (${attackerProbe.status}, stranger ${stranger.status}, returning ${returning.status}, then ${afterReturning.status})`);
      // And the cool-down ends by itself.
      fac.mode.settle = routedElsewhere;
      for (let i = 0; i < 3; i++) await payO();
      const probeAgain = await payO();
      fac.mode.settle = routedToUs;
      const duringCool = await payO("exa");
      skew.ms = 61_000;
      const afterCool = await payO("exa");
      skew.ms = 0;
      ok(probeAgain.status === 409 && duringCool.status === 503 && afterCool.status === 200 && !heldReason(appO), `after the cool-down the next payer, paid before or not, is the probe (${duringCool.status} then ${afterCool.status})`);
      for (const e of bookO.list()) await appO.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
    } finally { skew.ms = 0; fac.mode.settleDelayMs = 0; await appO.close(); }
  }

  // ===========================================================================
  // Round 6: the alarm does not wait on the ledger; floors, model-backed tools, a reservation; the product is bound
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const newBook = (tag) => createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-r6-${tag}`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const chainPays = (bps) => { fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: BigInt(bps) }), network: REFERRAL_NETWORK } }); };
    const payOn = async (app, slug, { body = { text: "r6" }, account = newAccount() } = {}) => { const p = await signPayment(accept, { account }); const r = await send(`${app.url}/ref/${slug}`, { body, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); return { status: r.status, reason: r.json?.errorReason || null, retry: r.headers.get("retry-after"), p }; };
    const tally = (rs) => `${rs.filter((r) => r.status === 200).length} served, ${rs.filter((r) => r.status === 503).length} refused`;

    // 2. The net becomes known late and the ledger correction does not land: the alarm is raised all the same.
    {
      const bookL = newBook("late");
      const appL = await mount({}, { book: bookL, amendSaleNet: () => false });
      try {
        const seen = [];
        for (let i = 0; i < 6; i++) {
          const txL = "0x" + createHash("sha256").update(`late-${i}-${Math.random()}`).digest("hex");
          fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: txL } });
          const c = await payOn(appL, "list");
          seen.push(c);
          if (c.status === 200) { fac.land(c.p.authorization, txL, "paid", { bps: 9000n }); await appL.gate.sweepOnce(); await wait(30); }
        }
        const rec = bookL.shortSales().list;
        ok(seen.slice(0, 3).every((c) => c.status === 200) && seen.slice(3).every((c) => c.status === 503 && c.reason === "rate_under_review") && rec?.count === 3 && rec.deep === 3 && appL.gate.stats().netsCorrected === 0 && appL.gate.statusWord().status === "attention" && appL.gate.statusWord().reasons.some((x) => /^list: .*received 3000.*new calls on it are held/.test(x)), `receipts read late at a rate far above the map, with a ledger correction that does not land: the short net is still recorded and raised, and the slug stops (${seen.map((c) => c.status).join(" ")}; record ${JSON.stringify(rec && { count: rec.count, deep: rec.deep })})`);
      } finally { await appL.close(); }
    }

    // 3a. The floor an operator sets as a share of the price.
    {
      const withFloor = referralConfig({ ...ENV, REFERRAL_MIN_NET_BPS: "default:8000, Echo:5000" });
      ok(withFloor?.minNetBps?.default === 8000 && withFloor.minNetBps.bySlug.echo === 5000 && referralConfig(ENV).minNetBps === null && referralConfig({ ...ENV, REFERRAL_MIN_NET_BPS: "echo:abc" }) === null && referralConfig({ ...ENV, REFERRAL_MIN_NET_BPS: "20000" }) === null && /minimum-net map/.test(referralConfigProblem({ ...ENV, REFERRAL_MIN_NET_BPS: "echo:abc" }) || ""), "REFERRAL_MIN_NET_BPS is read per slug with a default; absent it is no floor of its own; malformed it leaves the gate off with a reason");
      const bookF = newBook("floor");
      const appF = await mount({ REFERRAL_MIN_NET_BPS: "default:8000,exa:5000" }, { book: bookF });
      try {
        chainPays(2500);
        const under = []; for (let i = 0; i < 5; i++) under.push(await payOn(appF, "list"));
        const above = []; for (let i = 0; i < 5; i++) above.push(await payOn(appF, "exa"));
        ok(under.map((c) => c.status).join(" ") === "200 200 200 503 503" && under[3].reason === "rate_under_review" && bookF.shortSales().list?.deep === 3 && above.every((c) => c.status === 200) && bookF.shortSales().exa?.deep === 0 && bookF.shortSales().exa.count === 5, `with a floor of 80% of the price, sales that bring 75% count toward the stop (three, then 503); on a slug whose floor is 50% the same sales are raised and never stop it (${under.map((c) => c.status).join(" ")} | ${above.map((c) => c.status).join(" ")})`);
      } finally { await appF.close(); }
    }

    // 3b + 3c. A model-backed tool stops at ONE sale under the floor, and a burst cannot all be served short.
    {
      const bookB = newBook("burst");
      const appB = await mount({}, { book: bookB });
      try {
        chainPays(9000);
        fac.mode.settleDelayMs = 150;
        const settlesBefore = settles();
        const burstModel = await Promise.all(Array.from({ length: 20 }, () => payOn(appB, "mb")));
        const burstPlain = await Promise.all(Array.from({ length: 20 }, () => payOn(appB, "list")));
        fac.mode.settleDelayMs = 0;
        await wait(60);
        const nextModel = await payOn(appB, "mb");
        ok(burstModel.filter((c) => c.status === 200).length === 1 && burstModel.filter((c) => c.status === 503 && c.reason === "rate_under_review").length === 19 && nextModel.status === 503 && nextModel.retry === "300" && bookB.shortSales().mb?.deep === 1, `twenty buyers at once on a model-backed tool whose rate is far above the map: ONE is served under the floor, nineteen are refused before anything runs, and the slug is stopped (${tally(burstModel)})`);
        ok(burstPlain.filter((c) => c.status === 200).length === 3 && burstPlain.filter((c) => c.status === 503).length === 17 && settles() - settlesBefore === 4, `on a tool that is not model-backed the same burst serves three (its bound), not twenty; only the calls served were settled (${tally(burstPlain)}; ${settles() - settlesBefore} settles)`);
        // A slug whose rate has proven is not held to its bound: a burst is served.
        chainPays(1234);
        await payOn(appB, "exa");
        fac.mode.settleDelayMs = 150;
        const burstProven = await Promise.all(Array.from({ length: 6 }, () => payOn(appB, "exa")));
        fac.mode.settleDelayMs = 0;
        ok(burstProven.every((c) => c.status === 200), `once one sale on a slug has arrived at or above its floor, calls on it are not held to the bound (${tally(burstProven)})`);
        // A short sale seen while later calls are in flight: those complete, and none is admitted after it.
        chainPays(9000);
        fac.mode.settleDelayMs = 200;
        const inFlight = Promise.all(Array.from({ length: 5 }, () => payOn(appB, "exa", { account: newAccount() })));
        await wait(700);
        const afterFirst = await payOn(appB, "exa");
        const flown = await inFlight;
        fac.mode.settleDelayMs = 0;
        ok(flown.every((c) => c.status === 200) && afterFirst.status === 503 && afterFirst.reason === "rate_under_review", `calls already running when the first short sale is read are served (they cannot be recalled); a call that arrives after it is refused (${tally(flown)}; after: ${afterFirst.status})`);
      } finally { fac.mode.settleDelayMs = 0; await appB.close(); }
      // The stop does not wait on the book's write: with a book whose short-net write never lands, it still holds.
      {
        const inner = newBook("nowrite");
        const appN = await mount({}, { book: { ...inner, noteShort: async () => false } });
        try {
          chainPays(9000);
          const firstN = await payOn(appN, "mb"), secondN = await payOn(appN, "mb");
          ok(firstN.status === 200 && secondN.status === 503 && secondN.reason === "rate_under_review" && !inner.shortSales().mb, `a short sale stops its slug from the moment it is seen, ahead of the book's record (${firstN.status} then ${secondN.status})`);
        } finally { await appN.close(); }
      }
      // A map corrected IN PART: the floor is met again, so the stop ends, though the gap is still raised.
      const appB2 = await mount({ REFERRAL_COMMISSION_BPS: "default:8500,busy:4321" }, { book: bookB });
      try {
        chainPays(9000);
        const word = appB2.gate.statusWord();
        const resumed = await payOn(appB2, "list");
        ok(resumed.status === 200 && word.status === "attention" && word.reasons.some((x) => /^list: /.test(x) && !/held/.test(x)), `on-chain 9000 with the map raised from 1234 to 8500: the sale no longer falls under half the expected net, so the slug serves again, and the remaining gap still reads attention (${resumed.status}; ${word.reasons.filter((x) => /^list/.test(x)).join("; ")})`);
      } finally { await appB2.close(); }
      ok(referralConfig({ ...ENV, REFERRAL_SHORT_NET_MAX: "0" }).shortNetMax === 0, "REFERRAL_SHORT_NET_MAX=0 turns the stop and the reservation off for every slug");
    }

    // 4. The product is bound.
    {
      const fx = JSON.parse(readFileSync(new URL("./fixtures/referral-receipt-base.json", import.meta.url), "utf8"));
      const REAL_PRODUCT = "0x33027547537d35728a741470df1ccf65de10b454ca0def7c5c20b257b7b8d161";
      const args = { tx: fx.transaction.hash, from: fx.payer, nonce: fx.nonce, payTo: fx.splitContract, amount: fx.amount, merchantId: fx.merchantId, payoutAddress: fx.payoutAddress, minNet: fx.minNet };
      const bound = proveReceipt(fx.receipt, { ...args, productId: REAL_PRODUCT });
      const boundUpper = proveReceipt(fx.receipt, { ...args, productId: REAL_PRODUCT.toUpperCase().replace("0X", "0x") });
      const other = proveReceipt(fx.receipt, { ...args, productId: "0x" + "ab".repeat(32) });
      const tampered = structuredClone(fx.receipt);
      tampered.logs[6].data = tampered.logs[6].data.slice(0, 2 + 2 * 64) + "cd".repeat(32) + tampered.logs[6].data.slice(2 + 3 * 64);
      const tamperedBound = proveReceipt(tampered, { ...args, productId: REAL_PRODUCT }), tamperedUnbound = proveReceipt(tampered, args);
      ok(`0x${fx.receipt.logs[6].data.slice(2 + 2 * 64, 2 + 3 * 64)}` === REAL_PRODUCT && bound.verdict === "paid" && boundUpper.verdict === "paid" && other.verdict === "unknown" && other.routedToUs === true && /another product/.test(other.why) && tamperedBound.verdict === "unknown" && tamperedUnbound.verdict === "paid", `the real receipt's product id (data word 2) is the one bound for its slug: with it the receipt is paid; under another configured id, or with the product word changed, it reads unknown, routed to us; with no id configured the word is not read (${bound.verdict}, ${other.verdict}, ${tamperedBound.verdict}, ${tamperedUnbound.verdict})`);
      const ids = referralConfig({ ...ENV, REFERRAL_PRODUCT_IDS: `Echo:${REAL_PRODUCT.toUpperCase().replace("0X", "0x")}, list:0x${"0".repeat(64)}` });
      ok(ids?.productIds?.echo === REAL_PRODUCT && ids.productIds.list === `0x${"0".repeat(64)}` && Object.keys(referralConfig(ENV).productIds).length === 0 && referralConfig({ ...ENV, REFERRAL_PRODUCT_IDS: "echo:0x1234" }) === null && referralConfig({ ...ENV, REFERRAL_PRODUCT_IDS: `echo:${REAL_PRODUCT},echo:${REAL_PRODUCT}` }) === null && /product id map/.test(referralConfigProblem({ ...ENV, REFERRAL_PRODUCT_IDS: "echo" }) || ""), "REFERRAL_PRODUCT_IDS is read per slug (optional); a malformed map leaves the gate off with a reason");
      // On the gate: the stub contract's product word is zero. `echo` is bound to it, `list` to another id, `exa` to none.
      const bookP = newBook("product");
      const appP = await mount({ REFERRAL_PRODUCT_IDS: `echo:0x${"0".repeat(64)},list:0x${"1".repeat(64)}`, REFERRAL_UNRECOGNIZED_READS: "2" }, { book: bookP });
      try {
        chainPays(1234);
        const right = await payOn(appP, "echo"), unbound = await payOn(appP, "exa");
        const open = async (slug) => { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) - 600) }); const key = gateMod.referralReplayKey(p.authorization); await bookP.intent({ key, slug, payer: p.authorization.from, nonce: p.authorization.nonce, amount: "30000", validBefore: Number(p.authorization.validBefore), fromBlock: fac.chainState.head }); await bookP.resolve(key, { state: "in-doubt" }); return { key, tx: fac.land(p.authorization, null, "paid") }; };
        const wrongProduct = await open("list"), rightProduct = await open("echo");
        const salesBefore = sales.length;
        for (let i = 0; i < 4; i++) await appP.gate.sweepOnce();
        await quietLedger();
        const held = bookP.get(wrongProduct.key);
        const word = appP.gate.statusWord();
        ok(right.status === 200 && unbound.status === 200 && held?.state === "in-doubt" && held.routedToUs === true && /another product/.test(held.why || "") && !sales.some((x) => x.tx === wrongProduct.tx) && bookP.closedUnrecognized().length === 0 && sales.some((x) => x.tx === rightProduct.tx) && sales.length === salesBefore + 1 && word.status === "attention" && word.reasons.some((x) => /routed to this merchant/.test(x)), `a payment routed to our merchant for ANOTHER product than its slug's is never booked or delivered as that slug's sale: it stays open for the operator, attention, never closed by itself; the right product is booked (${held?.state}: ${held?.why})`);
        ok(JSON.stringify(word.noProductId) === JSON.stringify(appP.gate.slugs().filter((x) => x !== "echo" && x !== "list")) && word.noProductId.includes("exa") && !word.reasons.some((x) => /^exa:/.test(x)), `the operator's word lists the slugs with no product id configured, and that alone is no reason for attention (${word.noProductId.length} unbound)`);
        ok(word.reasons.some((x) => x === `list: product id differs: configured 0x${"1".repeat(64)}, receipt 0x${"0".repeat(64)}; new calls on it are held`) && bookP.faults().every((f) => f.scope !== "route"), `the sweep's reading of that receipt stops the slug and names both ids; it is never a route-wide fault (${word.reasons.filter((x) => /^list:/.test(x)).join("; ")})`);
        await appP.gate.clearShortByHand("list", { note: "test: start the live case clean" });
        await appP.gate.resolveByHand(wrongProduct.key, { note: "test cleanup", outcome: "dismissed" });
      } finally { await appP.close(); }
      // THROUGH A LIVE SETTLE, eight buyers in a row on a slug bound to an id its receipts do not carry.
      fac.reset(); sales.length = 0; owed.length = 0;
      const bookQ = newBook("product-live");
      const WRONG = `0x${"1".repeat(64)}`, CARRIED = `0x${"0".repeat(64)}`;
      const appQ = await mount({ REFERRAL_PRODUCT_IDS: `list:${WRONG},echo:${CARRIED}` }, { book: bookQ });
      try {
        chainPays(1234);
        const runsBefore = runs.echo;
        const eight = [];
        for (let i = 0; i < 8; i++) eight.push(await payOn(appQ, "list"));
        await quietLedger();
        const firstKey = gateMod.referralReplayKey(eight[0].p.authorization);
        const entryQ = bookQ.get(firstKey);
        const rowsQ = owed.filter((o) => o.payer === eight[0].p.authorization.from.toLowerCase());
        ok(eight[0].status === 409 && eight[0].reason === "settled_for_another_product" && eight.slice(1).every((c) => c.status === 503 && c.reason === "rate_under_review") && settles() === 1 && sales.length === 0, `a receipt READ IN FULL that names another product is never delivered or booked as this slug's sale: the first buyer is told so and no further buyer on that slug is charged (${eight.map((c) => c.status).join(" ")}; ${settles()} settle, ${sales.length} sales)`);
        ok(rowsQ.length === 1 && rowsQ[0].priceUsd === 0.03 && rowsQ[0].wire === "referral" && /product id differs: configured 0x1{64}, receipt 0x0{64}/.test(rowsQ[0].note) && entryQ?.state === "refund-owed" && entryQ.delivered !== true && entryQ.saleBooked !== true && bookQ.counts().unconfirmed === 0, `the buyer whose payment produced it is owed the gross back, once; the entry is the refund-owed mark, never unconfirmed or delivered (${rowsQ.length} row at ${rowsQ[0]?.priceUsd}; ${entryQ?.state})`);
        const wordQ = appQ.gate.statusWord();
        const elsewhere = await payOn(appQ, "echo"), unboundQ = await payOn(appQ, "exa");
        ok(wordQ.status === "attention" && wordQ.reasons.some((x) => x === `list: product id differs: configured ${WRONG}, receipt ${CARRIED}; new calls on it are held`) && bookQ.faults().length === 0 && elsewhere.status === 200 && unboundQ.status === 200, `the stop is per slug, with the reason naming both ids, and never a route-wide hold: a correctly bound slug and an unbound one are served (${wordQ.reasons.join("; ")}; ${elsewhere.status}, ${unboundQ.status})`);
        skew.ms = 5 * 60_000;
        await appQ.gate.sweepOnce();
        const later = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor((Date.now() + skew.ms) / 1000) + 60) });
        const laterEcho = await send(`${appQ.url}/ref/echo`, { body: { text: "later" }, headers: { "payment-signature": later.header, "x-test-ip": freshIp() } });
        skew.ms = 0;
        ok(laterEcho.status === 200 && bookQ.faults().length === 0, `minutes later every other slug still serves: nothing was flagged route-wide (${laterEcho.status})`);
        const refundVerifies = await (await import("../src/payment-verify.js")).verifyInboundPayment({ network: "eip155:8453", payer: rowsQ[0].payer, amountUsd: rowsQ[0].priceUsd, tx: rowsQ[0].tx, wire: rowsQ[0].wire, referralPayTo: PAY_TO, referralMerchantId: MERCHANT_ID, referralPayout: PAYOUT, rpcFor: () => "http://rpc.invalid", fetchImpl: async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_getTransactionReceipt" ? fac.receipts.get(rowsQ[0].tx) : null }), { status: 200, headers: { "content-type": "application/json" } }); } });
        ok(refundVerifies.verified === true, "and the refund run proves that debt against the receipt (the money did reach this merchant)");
      } finally { skew.ms = 0; await appQ.close(); }
      // The configured id corrected: the stop ends by itself.
      const appQ2 = await mount({ REFERRAL_PRODUCT_IDS: `list:${CARRIED}` }, { book: bookQ });
      try {
        chainPays(1234);
        const fixed = await payOn(appQ2, "list");
        ok(fixed.status === 200 && !appQ2.gate.statusWord().reasons.some((x) => /^list: product id/.test(x)), `once the configured id is the one the receipts carry, the slug serves again and the reason is gone (${fixed.status})`);
      } finally { await appQ2.close(); }

      // THE OTHER SHAPES read in full that do not prove the sale: never delivered, never booked, never "not readable".
      fac.reset(); sales.length = 0; owed.length = 0;
      const bookR = newBook("read-not-ours");
      const appR = await mount({}, { book: bookR });
      try {
        const shapes = {};
        for (const kind of ["nopayout", "otherbuyer", "wronggross", "noevent", "badevent", "viaforwarder"]) {
          fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), kind), network: REFERRAL_NETWORK } });
          const c = await payOn(appR, "exa");
          const e = bookR.get(gateMod.referralReplayKey(c.p.authorization));
          shapes[kind] = `${c.status}:${c.reason}/${e?.state}/${e?.unproven === true}/${e?.delivered === true}`;
          await appR.gate.resolveByHand(gateMod.referralReplayKey(c.p.authorization), { note: "test cleanup", outcome: "dismissed" });
        }
        ok(Object.values(shapes).every((v) => v === "409:settlement_unproven_refund_owed/in-doubt/true/false") && sales.length === 0 && owed.length === 6 && owed.every((o) => o.priceUsd === 0.03 && o.wire === "referral-operator") && appR.gate.stats().unconfirmed === 0 && appR.gate.stats().settleUnproven === 6 && logLines.some((l) => /SETTLE UNPROVEN: .*read in full, does not prove this sale/.test(l)), `a success whose receipt was read in full and is not a proof (no payout, another buyer or gross, no event or one of another shape, sent to another contract) is not delivered, not booked and not counted as unconfirmed: the buyer, whose transfer is on chain, is told the gross is owed back, and the entry is held for the operator (${JSON.stringify(shapes)})`);
        // A receipt that is NOT THERE yet is still the unconfirmed path, unchanged.
        fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "9a".repeat(32) } });
        const notYet = await payOn(appR, "exa");
        const eY = bookR.get(gateMod.referralReplayKey(notYet.p.authorization));
        ok(notYet.status === 200 && eY?.state === "unconfirmed" && eY.delivered === true && appR.gate.stats().unconfirmed === 1, `a success whose receipt cannot be read yet is delivered and kept as unconfirmed, as before (${notYet.status} ${eY?.state})`);
        // ...and when that receipt arrives and does not prove the sale, the entry is held as unproven: never flagged route-wide.
        fac.land(notYet.p.authorization, "0x" + "9a".repeat(32), "nopayout");
        skew.ms = 4 * 60_000;
        await appR.gate.sweepOnce();
        skew.ms = 0;
        const eY2 = bookR.get(gateMod.referralReplayKey(notYet.p.authorization));
        await appR.gate.sweepOnce();
        ok(!owed.some((o) => o.tx === "0x" + "9a".repeat(32)) && !bookR.get(gateMod.referralReplayKey(notYet.p.authorization))?.debtAt, "its answer was delivered, so nothing is owed back for it, however often the sweep reads it");
        ok(eY2?.state === "in-doubt" && eY2.unproven === true && eY2.flagged !== true && bookR.faults().every((f) => f.scope !== "route") && appR.gate.statusWord().reasons.some((x) => /read in full, does not prove the sale/.test(x)), `an unconfirmed entry whose receipt then reads as not a proof is held as unproven, with a reason of its own, and is never the route-wide flag (${eY2?.state}, flagged ${eY2?.flagged})`);
        await appR.gate.resolveByHand(gateMod.referralReplayKey(notYet.p.authorization), { note: "test cleanup", outcome: "dismissed" });
        // An unproven entry is this server's fault: it never holds its own payer.
        {
          const unlucky = newAccount();
          fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "nopayout"), network: REFERRAL_NETWORK } });
          const firstU = await payOn(appR, "exa", { account: unlucky });
          chainPays(1234);
          const secondU = await payOn(appR, "exa", { account: unlucky });
          ok(firstU.status === 409 && secondU.status === 200 && bookR.faults().some((f) => f.unproven && f.own === false), `a payer whose settle came back unproven is served on its next payment: the entry holds no payer (${firstU.status} then ${secondU.status})`);
          owed.length = 0;
          for (const e of bookR.list().filter((x) => x.unproven)) await appR.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
        }
        // A setting that makes EVERY success unproven: three payers are charged and owed back, then the route holds
        // and STAYS held; a payer that has never paid here is not a probe.
        const unprovenSettle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "nopayout"), network: REFERRAL_NETWORK } });
        chainPays(1234);
        const regularU = newAccount();
        const earlierU = await payOn(appR, "exa", { account: regularU });
        fac.mode.settle = unprovenSettle;
        const settles0 = settles();
        const many = [];
        for (let i = 0; i < 12; i++) many.push(await payOn(appR, "exa"));
        skew.ms = 5 * 60_000;
        for (let i = 0; i < 3; i++) await appR.gate.sweepOnce();
        const laterU = [];
        for (let i = 0; i < 4; i++) { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor((Date.now() + skew.ms) / 1000) + 60) }); laterU.push((await send(`${appR.url}/ref/exa`, { body: { text: "later" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } })).status); }
        skew.ms = 0;
        const openU = bookR.list().filter((e) => e.unproven === true);
        ok(earlierU.status === 200 && many.slice(0, 3).every((c) => c.status === 409 && c.reason === "settlement_unproven_refund_owed") && many.slice(3).every((c) => c.status === 503 && c.reason === "settlement_under_review") && settles() - settles0 === 3 && laterU.every((x) => x === 503) && openU.length === 3 && openU.every((e) => e.state === "in-doubt" && e.debtAt > 0) && owed.length === 3 && owed.every((o) => o.priceUsd === 0.03) && bookR.closedUnrecognized().length === 0 && bookR.faults().filter((f) => f.unproven).every((f) => f.own === false), `unproven successes that moved money from three payers hold the route, and it STAYS held: three buyers charged, each owed back, nobody charged after (not one probe by a never-paid payer, not minutes later), nothing closed by itself (${many.map((c) => c.status).join(" ")}; later ${laterU.join(" ")}; ${settles() - settles0} settles, ${owed.length} debts, ${openU.length} open)`);
        // A payer with a paid sale on the books is the probe: contradicted again, it is owed back and the hold stands...
        const probeBad = await payOn(appR, "exa", { account: regularU });
        const stillHeld = await payOn(appR, "exa");
        // ...and when a probe's receipt PROVES the sale, the hold is over.
        chainPays(1234);
        const regular2 = newAccount();
        paidPayers.add(regular2.address.toLowerCase());
        const probeGood = await payOn(appR, "exa", { account: regular2 });
        const reopenedU = await payOn(appR, "exa");
        ok(probeBad.status === 409 && owed.length === 4 && stillHeld.status === 503 && probeGood.status === 200 && reopenedU.status === 200, `only a payer with a paid sale probes: one whose settle is unproven again is owed back and the hold stands; one whose receipt proves the sale ends it (${probeBad.status}, ${stillHeld.status}, ${probeGood.status}, ${reopenedU.status})`);
        for (const e of bookR.list()) await appR.gate.resolveByHand(e.key, { note: "test cleanup", outcome: "dismissed" });
      } finally { skew.ms = 0; await appR.close(); }
    }
  }

  // ===========================================================================
  // A run's ceiling ends a read that carries a fixed timeout of its own (src/run-ceiling.js)
  // ===========================================================================
  {
    const { withRunCeiling, capByCeiling, ceilingLeftMs, ceilingPassed, atCeiling, markEndsAtCeiling } = await import("../src/run-ceiling.js");
    const { safeFetch, retryTransient } = await import("../src/tools/fetch-guard.js");
    const { KIT } = await import("../src/tools/kit.js");
    const kitTool = (slug) => KIT.find((t) => t.slug === slug);
    // An upstream that never answers: it ends only when its own signal aborts.
    const realFetch = globalThis.fetch;
    const hung = [];
    globalThis.fetch = (input, init) => new Promise((_res, rej) => {
      const started = Date.now();
      const signal = init?.signal;
      const end = () => { hung.push(Date.now() - started); rej(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })); };
      if (signal?.aborted) return end();
      signal?.addEventListener("abort", end, { once: true });
    });
    try {
      // A literal public address: no name lookup, so the read itself is what is timed.
      const URL_IP = "http://93.184.216.34/sitemap.xml";
      ok(capByCeiling(15_000) === 15_000 && ceilingLeftMs() === Infinity && ceilingPassed() === false && typeof atCeiling(() => {}) === "function", "with no ceiling a read keeps its own timeout: the direct routes are untouched");
      const t0 = Date.now();
      const own = await safeFetch(URL_IP, { timeoutMs: 150 }).then(() => null, (e) => e);
      const ownMs = Date.now() - t0;
      const t1 = Date.now();
      const capped = await withBudgetCeiling(300, () => safeFetch(URL_IP, { timeoutMs: 15_000 }).then(() => null, (e) => e));
      const cappedMs = Date.now() - t1;
      ok(own?.statusCode === 504 && ownMs < 1000 && capped?.statusCode === 504 && cappedMs >= 250 && cappedMs < 1500 && hung.length === 2 && hung[1] < 1500, `a guarded fetch with a 15 s timeout of its own is ended by a 300 ms ceiling: the upstream call is aborted then, not left running (${cappedMs} ms; aborted after ${hung.join(", ")} ms)`);
      // No retry starts once the ceiling has passed.
      let attempts = 0;
      const t2 = Date.now();
      const retried = await withRunCeiling(250, () => retryTransient(() => { attempts++; return safeFetch(URL_IP, { timeoutMs: 15_000 }); }, { retries: 3, backoffMs: 50 }).then(() => null, (e) => e));
      ok(retried?.statusCode === 504 && attempts === 1 && Date.now() - t2 < 1500 && withRunCeiling(5000, () => withRunCeiling(100, () => ceilingLeftMs())) <= 100 && withRunCeiling(100, () => withRunCeiling(5000, () => ceilingLeftMs())) <= 100, `a read's retries do not outlive the ceiling, and a nested ceiling only shortens (${attempts} attempt in ${Date.now() - t2} ms)`);
      // Real kit handlers, as the gate runs them: one that reads through the guarded fetch, one with a timer of its own.
      hung.length = 0;
      const t3 = Date.now();
      const sitemapErr = await withBudgetCeiling(300, () => kitTool("sitemap").handler({ url: URL_IP })).then(() => null, (e) => e);
      const sitemapMs = Date.now() - t3;
      const t4 = Date.now();
      const check = await withBudgetCeiling(300, () => kitTool("http-check").handler({ url: "http://93.184.216.34/" })).then((v) => v, (e) => e);
      const checkMs = Date.now() - t4;
      const robots = await withBudgetCeiling(300, () => kitTool("robots-check").handler({ url: "http://93.184.216.34/page" })).then((v) => v, (e) => e);
      ok(check instanceof Error && check.statusCode === 504 && check.ceilingCut === true && robots instanceof Error && robots.statusCode === 504, `a read the ceiling ended is a 504, never an answer: http-check does not say "down" and robots-check does not say "no robots.txt" (${check?.statusCode ?? JSON.stringify(check)}, ${robots?.statusCode ?? JSON.stringify(robots)})`);
      hung.splice(2);
      ok(kitTool("sitemap").endsAtCeiling === true && kitTool("http-check").endsAtCeiling === true && Number(sitemapErr?.statusCode) >= 500 && sitemapMs < 1500 && checkMs < 1500 && hung.length === 2 && hung.every((ms) => ms < 1500), `a kit handler whose upstream never answers is ended at the ceiling, where its own timeout is 15 s: its upstream call is aborted (sitemap ${sitemapMs} ms, http-check ${checkMs} ms; aborted after ${hung.join(", ")} ms)`);
      // A handler of several reads in a row (the registry list, then two lookups, 10 s and 12 s each of their own): all ended at the ceiling.
      hung.length = 0;
      const t5 = Date.now();
      const whoisErr = await withBudgetCeiling(300, () => kitTool("whois").handler({ domain: "example.com" })).then(() => null, (e) => e);
      const whoisMs = Date.now() - t5;
      ok(Number(whoisErr?.statusCode) >= 500 && whoisMs < 1500 && hung.length === 1 && hung[0] < 1500, `a handler of several reads in a row ends at the ceiling too: the read in flight is aborted, and the next one never starts (whois ${whoisMs} ms; ${hung.length} call, aborted after ${hung.join(", ")} ms)`);
      const marked = KIT.filter((t) => t.endsAtCeiling === true).map((t) => t.slug).sort();
      ok(JSON.stringify(marked) === JSON.stringify(["http-check", "ip-info", "robots-check", "sitemap", "tls-cert", "whois"]) && JSON.stringify(markEndsAtCeiling([{ slug: "a" }], ["a", "b"])) === "[\"b\"]", `the mark is set slug by slug, on the handlers audited and no other (${marked.join(", ")})`);
    } finally { globalThis.fetch = realFetch; }
    // The eligibility rule reads the mark.
    const marked = { slug: "m1", price: "$0.01", handler: async () => ({}), endsAtCeiling: true }, plain = { slug: "m2", price: "$0.01", handler: async () => ({}) };
    const cfgE = referralConfig({ ...ENV, REFERRAL_SLUGS: "m1,m2", REFERRAL_COMMISSION_BPS: "default:1000" });
    const flagsLikeServer = (def) => ({ clamped: def.endsAtCeiling === true, ownTimeoutMs: null });
    const routesE = referralRoutes(cfgE, { a: marked, b: plain }, flagsLikeServer);
    ok(routesE.served.some((x) => x.slug === "m1" && /upstream work ends at the deadline/.test(x.why)) && routesE.refused.some((x) => x.slug === "m2" && /declares no upstream timeout/.test(x.reason)), "a definition that declares its upstream work ends at the ceiling is served; one that declares nothing is refused");
  }

  // ===========================================================================
  // Round 7: a cold slug and credentials that do not verify; a stop that can be seen; a ceiling cut is no sale
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const newBook7 = (tag) => createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-r7-${tag}`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const pay7 = async (app, slug, { account = newAccount(), body = { text: "r7" } } = {}) => { const p = await signPayment(accept, { account }); const r = await send(`${app.url}/ref/${slug}`, { body, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); return { status: r.status, reason: r.json?.errorReason || null, p }; };
    const pays = (bps) => (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: BigInt(bps) }), network: REFERRAL_NETWORK } });
    // A wallet whose /verify is refused, looping on a COLD model-backed slug, takes no place on it.
    {
      const app = await mount({}, { book: newBook7("cold") });
      try {
        const unfunded = new Set();
        fac.mode.verifyDelayMs = 120;
        fac.mode.verify = (c) => (unfunded.has(c.json.paymentPayload.payload.authorization.from.toLowerCase()) ? { status: 200, body: { isValid: false, invalidReason: "insufficient_funds" } } : { status: 200, body: { isValid: true } });
        fac.mode.settle = pays(1234);
        let looping = true;
        const loop = async () => { while (looping) { const a = newAccount(); unfunded.add(a.address.toLowerCase()); await pay7(app, "mb", { account: a }); } };
        const loops = [loop(), loop(), loop()];
        await wait(200);
        const honest = [];
        for (let i = 0; i < 8; i++) honest.push(await pay7(app, "mb"));
        looping = false;
        await Promise.all(loops);
        ok(honest.every((c) => c.status === 200) && unfunded.size >= 6, `three wallets whose /verify is refused, looping on a cold model-backed slug, keep nobody out: a credential takes the slug's place only once it has verified (${honest.map((c) => c.status).join(" ")}; ${unfunded.size} refused credentials meanwhile)`);
      } finally { fac.mode.verifyDelayMs = 0; await app.close(); }
      fac.reset();
      // The cold bound holds verified NEW payers; a payer with a sale on the books is not held to it.
      const app2 = await mount({}, { book: newBook7("cold2") });
      try {
        fac.mode.settle = pays(1234);
        const regular = newAccount();
        const earlier = await pay7(app2, "echo", { account: regular });
        await quietLedger();
        fac.mode.settleDelayMs = 500;
        const first = pay7(app2, "mb");
        await wait(200);
        const stranger = await pay7(app2, "mb");
        const returning = await pay7(app2, "mb", { account: regular });
        const firstDone = await first;
        fac.mode.settleDelayMs = 0;
        ok(earlier.status === 200 && firstDone.status === 200 && stranger.status === 503 && stranger.reason === "rate_under_review" && returning.status === 200, `while a cold model-backed slug's one place is taken, a new payer waits and a payer with a sale on the books is served (${stranger.status}, returning ${returning.status})`);
      } finally { fac.mode.settleDelayMs = 0; await app2.close(); }
    }
    fac.reset();
    // A stop whose record could not be written is still seen, and can still be cleared.
    {
      const inner = newBook7("unwritten");
      const app = await mount({}, { book: { ...inner, noteShort: async () => false } });
      try {
        fac.mode.settle = pays(9000);
        const a = await pay7(app, "mb"), b = await pay7(app, "mb");
        const word = app.gate.statusWord();
        const cleared = await app.gate.clearShortByHand("mb", { note: "the rate map is being corrected" });
        fac.mode.settle = pays(1234);
        const after = await pay7(app, "mb");
        ok(a.status === 200 && b.status === 503 && !inner.shortSales().mb && word.status === "attention" && word.reasons.some((x) => /^mb: 1 sale\(s\) under its stop floor were seen and could not be recorded in the book; new calls on it are held$/.test(x)) && cleared.ok === true && after.status === 200 && inner.resolvedByHand().some((r) => r.outcome === "short-net-cleared" && r.slug === "mb") && !app.gate.statusWord().reasons.some((x) => /^mb:/.test(x)), `a slug held by this process's own count, where the book's write did not land, reads attention with a reason, and clear-short clears it and records the note (${word.reasons.join("; ")}; cleared ${cleared.ok}; then ${after.status})`);
      } finally { await app.close(); }
    }
    fac.reset();
    // The default floor of a model-backed tool: the share of its price its upstream cost is kept within.
    {
      const app = await mount({}, { book: newBook7("floor") });
      const noFloor = await mount({}, { book: newBook7("nofloor"), modelNetFloorBps: null });
      try {
        fac.mode.settle = pays(4000);
        const model = []; for (let i = 0; i < 4; i++) model.push(await pay7(app, "mb"));
        const plain = []; for (let i = 0; i < 4; i++) plain.push(await pay7(app, "list"));
        const without = []; for (let i = 0; i < 4; i++) without.push(await pay7(noFloor, "mb"));
        fac.mode.settle = pays(2500);
        const above = []; for (let i = 0; i < 3; i++) above.push(await pay7(app, "chat", { body: { max_tokens: 30, messages: [] } }));
        ok(model.map((c) => c.status).join(" ") === "200 503 503 503" && plain.every((c) => c.status === 200) && without.every((c) => c.status === 200), `with no REFERRAL_MIN_NET_BPS, a model-backed tool that brings 60% of its price (under the 70% its upstream cost is kept within) stops after ONE sale; a tool that is not model-backed keeps the half-of-expected rule and serves; without that default the model tool would never stop (${model.map((c) => c.status).join(" ")} | ${plain.map((c) => c.status).join(" ")} | ${without.map((c) => c.status).join(" ")})`);
        ok(above.every((c) => c.status === 200), `a sale that brings 75% is above that floor: raised, never stopped (${above.map((c) => c.status).join(" ")})`);
      } finally { await app.close(); await noFloor.close(); }
    }
    fac.reset();
    // A handler that comes back only after its ceiling was cut off by it: never a sale, whatever it returned.
    {
      const app = await mount({}, { book: newBook7("late") });
      try {
        fac.mode.settle = pays(1234);
        const before = { settles: settles(), sales: sales.length };
        const late = await pay7(app, "late");
        const onTime = await pay7(app, "busy");
        ok(late.status === 504 && settles() === before.settles + 1 && sales.length === before.sales + 1 && onTime.status === 200 && app.gate.stats().ceilingCuts === 1, `a handler that returns an answer after its ceiling (750 ms against 500) is answered 504 and is not settled: a ceiling cut never reads as a paid success; one that returns before it is served (${late.status}, ${onTime.status}; ${settles() - before.settles} settle)`);
      } finally { await app.close(); }
    }
    fac.reset(); sales.length = 0;
    // ONE PAYMENT, ONE ROW: two payments of one payer settled in ONE transaction.
    {
      const app = await mount({}, { book: newBook7("batch") });
      try {
        const payer = newAccount();
        const TXB = "0x" + "ba".repeat(32);
        const built = [];
        fac.mode.settle = (c) => {
          const auth = c.json.paymentPayload.payload.authorization;
          const t = fac.land(auth, fac.nextTx(), "paid", { bps: built.length === 0 ? 1234n : 2000n });
          built.push(...fac.receipts.get(t).logs);
          // Both payments in the one receipt, log indexes in order; each nonce reads as spent by that transaction.
          fac.receipts.set(TXB, { transactionHash: TXB, status: "0x1", to: PAY_TO, logs: built.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}` })) });
          fac.used.set(`${String(auth.from).toLowerCase()}|${String(auth.nonce).toLowerCase()}`, { tx: TXB, block: fac.chainState.head });
          return { status: 200, body: { success: true, transaction: TXB, network: REFERRAL_NETWORK } };
        };
        const one = await pay7(app, "exa", { account: payer }), two = await pay7(app, "exa", { account: payer });
        await quietLedger();
        const rowsB = sales.filter((x) => x.tx === TXB);
        ok(one.status === 200 && two.status === 200 && rowsB.length === 2 && rowsB[0].priceUsd === 0.026298 && rowsB[1].priceUsd === 0.024 && ledger.privateRailSaleCount(TXB, "referral", payer.address, "exa") === 2 && ledger.payerReceipts(payer.address.toLowerCase()).rows.filter((r) => r.settlementTx === TXB).length === 2, `two payments of one payer settled in one transaction are two answers and TWO rows, each at the amount its own payment brought (${rowsB.map((x) => x.priceUsd).join(", ")})`);
        // A re-send of either books nothing more.
        const again = await send(`${app.url}/ref/exa`, { body: { text: "r7" }, headers: { "payment-signature": one.p.header, "x-test-ip": freshIp() } });
        await quietLedger();
        ok(again.status === 200 && sales.filter((x) => x.tx === TXB).length === 2, "and a re-send of either payment books no third row");
      } finally { await app.close(); }
    }
  }

  // ===========================================================================
  // "Proven at its floor" survives a restart; a cold slug's place is given back on every exit
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const pays = (bps) => (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: BigInt(bps) }), network: REFERRAL_NETWORK } });
    const one = async (app, slug, { account = newAccount(), body = { text: "w" } } = {}) => { const p = await signPayment(accept, { account }); const r = await send(`${app.url}/ref/${slug}`, { body, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); return { status: r.status, reason: r.json?.errorReason || null }; };
    const burst = async (app, slug, n = 6) => { fac.mode.settleDelayMs = 200; try { return (await Promise.all(Array.from({ length: n }, () => one(app, slug)))).filter((c) => c.status === 200).length; } finally { fac.mode.settleDelayMs = 0; } };
    // A real book FILE, read by one process after another.
    const base = join(tmp, "proven-book.json");
    const bookAt = (file) => createReferralBook({ file, log, now: () => Date.now() + skew.ms });
    const variant = (name) => { const f = join(tmp, `proven-${name}.json`); copyFileSync(base, f); return f; };
    fac.mode.settle = pays(1234);
    {
      const b = bookAt(base);
      const app = await mount({}, { book: b });
      try {
        const coldBurst = await burst(app, "mb");
        await wait(80);
        const rec = b.provenSlugs().mb;
        ok(coldBurst === 1 && rec && /^[0-9a-f]{32}$/.test(rec.fp) && Object.keys(b.provenSlugs()).length === 1 && JSON.parse(readFileSync(base, "utf8")).proven?.mb?.fp === rec.fp, `a cold model-backed slug serves one of a burst; its first proven sale is recorded in the book file with a fingerprint of the settings it was judged against (${coldBurst} served; ${JSON.stringify(rec)})`);
      } finally { await app.close(); }
    }
    {
      // The next process, same settings: warm from its first call.
      const app = await mount({}, { book: bookAt(variant("same")) });
      try { const n = await burst(app, "mb"); ok(n === 6, `after a restart with the same settings the slug is warm: a burst is served whole (${n} of 6)`); } finally { await app.close(); }
    }
    const coldAfter = {};
    for (const [name, env] of [["rate", { REFERRAL_COMMISSION_BPS: "default:1300,busy:4321" }], ["floor", { REFERRAL_MIN_NET_BPS: "mb:6000" }], ["product", { REFERRAL_PRODUCT_IDS: `mb:0x${"0".repeat(64)}` }], ["merchant", { REFERRAL_MERCHANT_ID: "4243" }], ["payout", { REFERRAL_PAYOUT_ADDRESS: newAccount().address }]]) {
      const app = await mount(env, { book: bookAt(variant(name)) });
      // (The merchant id and payout wallet variants are judged cold at admission; their settles then read as not ours.)
      try { fac.mode.settleDelayMs = 200; const rs = await Promise.all(Array.from({ length: 6 }, () => one(app, "mb"))); coldAfter[name] = rs.filter((c) => c.status === 503 && c.reason === "rate_under_review").length; } finally { fac.mode.settleDelayMs = 0; await app.close(); }
    }
    ok(Object.values(coldAfter).every((n) => n === 5), `a changed commission rate, floor, product id, merchant id or payout wallet makes the slug cold again: one of a burst is admitted, five wait (${JSON.stringify(coldAfter)})`);
    {
      // Its own stop, and an operator's clear, make it cold again in the record itself.
      const f = variant("stop");
      const b = bookAt(f);
      const app = await mount({}, { book: b });
      try {
        fac.mode.settle = pays(9000);
        const short = await one(app, "mb");
        await wait(80);
        const afterStop = b.provenSlugs().mb;
        fac.mode.settle = pays(1234);
        const cleared = await app.gate.clearShortByHand("mb", { note: "the map is being corrected" });
        ok(short.status === 200 && afterStop === undefined && cleared.ok === true && JSON.parse(readFileSync(f, "utf8")).proven?.mb === undefined, `a sale under the floor stops the slug and removes its proven record (${JSON.stringify(afterStop)})`);
      } finally { await app.close(); }
      const g = variant("clear");
      const b2 = bookAt(g);
      const app2 = await mount({}, { book: b2 });
      try {
        await app2.gate.clearShortByHand("mb", { note: "start this slug cold again" });
        await wait(60);
        const n = await burst(app2, "mb");
        ok(n === 1, `an operator's clear-short makes a warm slug cold again (${n} of 6 served)`);
      } finally { await app2.close(); }
    }
    // A COLD slug's one place is given back on EVERY exit: nothing keeps it longer than its own run.
    fac.reset();
    {
      const app = await mount({}, { book: createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-place`, log: () => {} }), log }) });
      try {
        const held = () => app.gate.stats().coldInflight.mb || 0;
        const seen = {};
        fac.mode.verify = () => ({ status: 200, body: { isValid: false, invalidReason: "insufficient_funds" } });
        await one(app, "mb"); seen.verifyRefused = held();
        fac.mode.verify = () => ({ status: 200, body: { isValid: true } });
        fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "insufficient_funds" } });
        const during = one(app, "mb", { body: { ms: 300 } });
        await wait(150);
        seen.whileRunning = held();
        const waiting = await one(app, "mb");
        const refused = await during; seen.settleRefused = held();
        const failed = await one(app, "mb", { body: { fail: true } }); seen.handlerError = held();
        const timedOut = await one(app, "mb", { body: { ms: 1500 } }); seen.timeout = held();
        fac.mode.settle = () => ({ status: 500, body: {} });
        const doubt = await one(app, "mb"); seen.settleInDoubt = held();
        const pH = await signPayment(accept, { account: newAccount() });
        const hung = await rawPost(`${app.url}/ref/mb`, { ms: 400 }, { "payment-signature": pH.header, "x-test-ip": freshIp() }, 120);
        await wait(700); seen.hangUp = held();
        fac.mode.settle = pays(1234);
        const honest = await one(app, "mb");
        ok(seen.verifyRefused === 0 && seen.whileRunning === 1 && waiting.status === 503 && waiting.reason === "rate_under_review" && refused.status === 402 && seen.settleRefused === 0 && failed.status === 422 && seen.handlerError === 0 && timedOut.status === 504 && seen.timeout === 0 && doubt.status === 402 && seen.settleInDoubt === 0 && hung === "aborted" && seen.hangUp === 0 && honest.status === 200, `a cold slug's place is held only while a verified call runs (another payer waits then) and is given back when it ends: a settle refused or in doubt, a handler error, a timeout, a hang-up; the next buyer is served (${JSON.stringify(seen)}; then ${honest.status})`);
      } finally { await app.close(); }
    }
  }

  // ===========================================================================
  // Round 8: the service-wide rule on the run slots; one refund row and one sale row per payment
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const book8 = (tag) => createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-r8-${tag}`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const fine = (bps = 1234) => (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: BigInt(bps) }), network: REFERRAL_NETWORK } });
    const pay8 = async (app, slug, { account = newAccount(), body = { text: "r8" }, acc = accept } = {}) => { const p = await signPayment(acc, { account }); const r = await send(`${app.url}/ref/${slug}`, { body, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } }); return { status: r.status, reason: r.json?.errorReason || null, p, json: r.json }; };
    // 2. A stream of payments that run a tool and do not settle, from many payers.
    {
      const app = await mount({ REFERRAL_UNSETTLED_GLOBAL_MAX: "3", REFERRAL_MAX_INFLIGHT: "8" }, { book: book8("share") });
      try {
        fac.mode.settle = fine();
        await pay8(app, "busy"); // the slug's rate has proven: its own cold bound is out of the way
        const atOnce = async (accounts) => { fac.mode.settleDelayMs = 300; try { return await Promise.all(accounts.map((account) => pay8(app, "busy", { account }))); } finally { fac.mode.settleDelayMs = 0; } };
        const before = await atOnce(Array.from({ length: 6 }, () => newAccount()));
        const wordBefore = app.gate.statusWord();
        fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "insufficient_funds" } });
        for (let i = 0; i < 3; i++) await pay8(app, "busy");
        fac.mode.settle = fine();
        const word = app.gate.statusWord();
        // Six new payers and six payers with a paid sale, all at once, on eight run slots.
        const regulars = Array.from({ length: 6 }, () => { const a = newAccount(); paidPayers.add(a.address.toLowerCase()); return a; });
        const newcomers = Array.from({ length: 6 }, () => newAccount());
        const both = await atOnce([...newcomers, ...regulars]);
        const strangers = both.slice(0, 6), returning = both.slice(6);
        const served = (rs) => rs.filter((c) => c.status === 200).length;
        ok(served(before) === 6 && !wordBefore.reasons.some((x) => /unsettled runs came from/.test(x)) && word.status === "attention" && word.reasons.some((x) => x === "unsettled runs came from 3 payers in the window: payers with no paid sale share 2 of 8 run slots"), `while unsettled runs stand from REFERRAL_UNSETTLED_GLOBAL_MAX payers the word reads attention and names the rule (${word.reasons.join("; ")})`);
        ok(served(strangers) === 2 && strangers.filter((c) => c.status === 503 && c.reason === "busy").length === 4 && served(returning) === 6 && app.gate.stats().newPayerShareRefused === 4, `under it, payers with no paid sale share a quarter of the run slots (2 of 8: 2 of 6 at once run, 4 are answered busy with nothing run) and payers with a paid sale are never refused by it (${served(returning)} of 6) (${strangers.map((c) => c.status).join(" ")})`);
      } finally { fac.mode.settleDelayMs = 0; await app.close(); }
    }
    fac.reset();
    // 3. Two payments of one payer in ONE transaction, both owed back: two refund rows, in the REAL refund ledger.
    {
      process.env.REFUND_DB_DIR = join(tmp, "refunds-r8");
      (await import("node:fs")).mkdirSync(process.env.REFUND_DB_DIR, { recursive: true });
      const refunds = await import("../src/refund-ledger.js");
      const app = await mount({ REFERRAL_PRODUCT_IDS: `exa:0x${"1".repeat(64)},list:0x${"1".repeat(64)}` }, { book: book8("refunds"), oweRefund: gateMod.referralRefundWriter({ recordRefundOwed: refunds.recordRefundOwed, refundByEvidence: refunds.refundByEvidence }) });
      try {
        const payer = newAccount();
        const TXR = "0x" + "bb".repeat(32);
        const built = [];
        fac.mode.settle = (c) => {
          const auth = c.json.paymentPayload.payload.authorization;
          const t = fac.land(auth, fac.nextTx(), "paid");
          built.push(...fac.receipts.get(t).logs);
          fac.receipts.set(TXR, { transactionHash: TXR, status: "0x1", to: PAY_TO, logs: built.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}` })) });
          fac.used.set(`${String(auth.from).toLowerCase()}|${String(auth.nonce).toLowerCase()}`, { tx: TXR, block: fac.chainState.head });
          return { status: 200, body: { success: true, transaction: TXR, network: REFERRAL_NETWORK } };
        };
        // (Two slugs, so the first one's stop does not refuse the second payment before it settles.)
        const one = await pay8(app, "exa", { account: payer }), two = await pay8(app, "list", { account: payer });
        const ev = (c) => gateMod.referralRefundEvidence(TXR, c.p.authorization.nonce);
        const rows = [refunds.refundByEvidence(ev(one)), refunds.refundByEvidence(ev(two))];
        ok(one.status === 409 && two.status === 409 && rows.every((r) => r && Number(r.priceUsd) === 0.03 && String(r.payer).toLowerCase() === payer.address.toLowerCase() && r.wire === "referral") && rows[0].id !== rows[1].id && refunds.refundByEvidence(TXR) === null, `two payments of one payer settled in one transaction and both owed back are TWO rows in the refund ledger, each under its own payment's evidence (${rows.map((r) => r?.id).join(", ")})`);
        const { verifyInboundPayment } = await import("../src/payment-verify.js");
        const v = await Promise.all([one, two].map((c) => verifyInboundPayment({ network: "eip155:8453", payer: payer.address.toLowerCase(), amountUsd: 0.03, tx: ev(c), wire: "referral", referralPayTo: PAY_TO, referralMerchantId: MERCHANT_ID, referralPayout: PAYOUT, rpcFor: () => "http://rpc.invalid", fetchImpl: async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_getTransactionReceipt" ? fac.receipts.get(TXR) : null }), { status: 200, headers: { "content-type": "application/json" } }); } })));
        ok(v.every((x) => x.verified === true), "and the refund run proves each of them against the one receipt, by its own nonce");
        // What the buyer was told, and what the public lookup answers for the transaction it was given.
        const { refundLookup } = await import("../src/refund-lookup.js");
        const seen = refundLookup(TXR);
        ok([one, two].every((c) => c.json.transaction === TXR && c.json.refundStatusUrl === `https://shop.example/api/refunds?tx=${TXR}` && /recorded as owed to the paying wallet/.test(c.json.errorMessage) && !/will be repaid/.test(c.json.errorMessage)) && seen.status === "owed" && seen.found === true && seen.refunds.length === 2 && seen.refunds.every((r) => r.status === "owed" && r.priceUsd === 0.03), `a buyer told its payment is owed back is given the transaction and where to check it, and that lookup answers owed for each payment of the transaction (${one.json.transaction ? "tx given" : "no tx"}; lookup ${seen.status}, ${seen.refunds?.length} listed)`);
        const resent = await send(`${app.url}/ref/exa`, { body: { text: "r8" }, headers: { "payment-signature": one.p.header, "x-test-ip": freshIp() } });
        ok(resent.status === 409 && resent.json?.transaction === TXR && resent.json.refundStatusUrl === `https://shop.example/api/refunds?tx=${TXR}`, `the same payment sent again is told the same, with the transaction (${resent.status} ${resent.json?.errorReason})`);
      } finally { await app.close(); }
    }
    fac.reset(); sales.length = 0;
    // 4. Three payments of different amounts by one payer in one transaction, booked before the receipt, then corrected.
    {
      const app = await mount({}, { book: book8("amounts") });
      try {
        const payer = newAccount();
        const TXA = "0x" + "a7e3".repeat(16);
        fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: TXA } });
        const auths = [];
        for (const n of [10, 20, 30]) {
          const body = { max_tokens: n, messages: [] };
          const acc = (await send(`${app.url}/ref/chat`, { body })).json.accepts[0];
          const c = await pay8(app, "chat", { account: payer, body, acc });
          auths.push({ auth: c.p.authorization, status: c.status, amount: acc.amount });
        }
        await quietLedger();
        const net = () => sales.filter((x) => x.tx === TXA);
        const rowsOf = async () => ledger.privateRailSalesByTx(TXA, "referral").map((r) => ({ gross: r.grossUsd, net: r.netUsd })).sort((x, y) => x.gross - y.gross);
        const early = await rowsOf();
        // The receipt arrives: the contract took 2000 bps of each.
        const logs = [];
        for (const { auth } of auths) { const t = fac.land(auth, fac.nextTx(), "paid", { bps: 2000n }); logs.push(...fac.receipts.get(t).logs); fac.used.set(`${String(auth.from).toLowerCase()}|${String(auth.nonce).toLowerCase()}`, { tx: TXA, block: fac.chainState.head }); }
        fac.receipts.set(TXA, { transactionHash: TXA, status: "0x1", to: PAY_TO, logs: logs.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}` })) });
        await app.gate.sweepOnce();
        await wait(120);
        const late = await rowsOf();
        ok(auths.every((a) => a.status === 200) && net().length === 3 && JSON.stringify(early) === JSON.stringify([{ gross: 0.01, net: 0.008766 }, { gross: 0.02, net: 0.017532 }, { gross: 0.03, net: 0.026298 }]) && JSON.stringify(late) === JSON.stringify([{ gross: 0.01, net: 0.008 }, { gross: 0.02, net: 0.016 }, { gross: 0.03, net: 0.024 }]), `three payments of different amounts by one payer in one transaction, booked before the receipt: each row is corrected to ITS OWN payment's amount, none rewrites a sibling (${JSON.stringify(late)}; before ${JSON.stringify(early)}; answers ${auths.map((x) => `${x.status}/${x.amount}`).join(" ")}; ${net().length} booked)`);
      } finally { await app.close(); }
    }
    fac.reset(); sales.length = 0;
    // 5. A restart between two payments of one transaction: still one row each.
    {
      const file = join(tmp, "restart-book.json");
      const payer = newAccount();
      const TXS = "0x" + "cc".repeat(32);
      const built = [];
      fac.mode.settle = (c) => {
        const auth = c.json.paymentPayload.payload.authorization;
        const t = fac.land(auth, fac.nextTx(), "paid");
        built.push(...fac.receipts.get(t).logs);
        fac.receipts.set(TXS, { transactionHash: TXS, status: "0x1", to: PAY_TO, logs: built.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}` })) });
        fac.used.set(`${String(auth.from).toLowerCase()}|${String(auth.nonce).toLowerCase()}`, { tx: TXS, block: fac.chainState.head });
        return { status: 200, body: { success: true, transaction: TXS, network: REFERRAL_NETWORK } };
      };
      const first = await mount({}, { book: createReferralBook({ file, log }) });
      let one;
      try { one = await pay8(first, "exa", { account: payer }); await wait(80); } finally { await first.close(); }
      const marks = Object.values(JSON.parse(readFileSync(file, "utf8")).sold || {});
      const second = await mount({}, { book: createReferralBook({ file, log }) });
      try {
        const two = await pay8(second, "exa", { account: payer });
        await quietLedger();
        ok(one.status === 200 && two.status === 200 && marks.some((m) => m.tx === TXS && m.slug === "exa") && ledger.privateRailSaleCount(TXS, "referral", payer.address, "exa") === 2, `a restart between two payments of one payer in one transaction: the first payment's mark is in the book file, and the second is booked as a row of its own (${ledger.privateRailSaleCount(TXS, "referral", payer.address, "exa")} rows; marks ${JSON.stringify(marks)})`);
      } finally { await second.close(); }
    }
  }

  // ===========================================================================
  // Round 9: what a buyer is told matches what happened to the payment
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const book9 = (tag) => createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-r9-${tag}`, log: () => {} }), log, now: () => Date.now() + skew.ms });
    const pay9 = async (app, slug, { account = newAccount(), body = { text: "r9" }, header = null } = {}) => { const p = header ? null : await signPayment(accept, { account }); const r = await send(`${app.url}/ref/${slug}`, { body, headers: { "payment-signature": header || p.header, "x-test-ip": freshIp() } }); return { status: r.status, reason: r.json?.errorReason || null, p, json: r.json }; };
    // 1. A success the network settled to ANOTHER merchant: the buyer's money left its wallet through our settle call.
    {
      const b = book9("elsewhere");
      const app = await mount({}, { book: b });
      try {
        let tx = null;
        fac.mode.settle = (c) => { tx = fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "othermerchant"); return { status: 200, body: { success: true, transaction: tx, network: REFERRAL_NETWORK } }; };
        const c = await pay9(app, "echo");
        const key = gateMod.referralReplayKey(c.p.authorization);
        const again = await pay9(app, "echo", { header: c.p.header });
        const told = (x) => x.status === 409 && x.reason === "settled_to_another_merchant" && x.json.transaction === tx && /another merchant/.test(x.json.errorMessage) && /did not receive/.test(x.json.errorMessage) && /nothing was delivered/i.test(x.json.errorMessage) && !/sign a new authorization/i.test(x.json.errorMessage) && !("echo" in x.json);
        ok(told(c) && told(again) && owed.length === 0 && sales.length === 0 && b.get(key)?.state === "contradicted" && b.get(key).moved === true, `a payment the network settled to another merchant is answered 409 with what is known (settled elsewhere, not received here, nothing delivered) and its transaction, never "sign a new authorization" (${c.status} ${c.reason}; again ${again.status} ${again.reason})`);
        // The operator can record it as owed, with the reason; never a payment that moved no money.
        const noNote = await app.gate.resolveByHand(key, { note: "", outcome: "refund" });
        const rec = await app.gate.resolveByHand(key, { note: "buyer wrote in; network confirmed the misroute", outcome: "refund" });
        const row = owed.find((o) => o.tx === tx);
        ok(noNote.ok === false && rec.ok === true && rec.debt === true && owed.length === 1 && row.wire === "referral-operator" && row.priceUsd === 0.03 && row.evidenceKey === gateMod.referralRefundEvidence(tx, c.p.authorization.nonce) && /another merchant/.test(row.note) && /not received/.test(row.note) && /network confirmed/.test(row.note), `an operator can record that payment as owed, with the reason in the row (${rec.ok ? "recorded" : rec.error}; wire ${row?.wire})`);
        const { verifyInboundPayment } = await import("../src/payment-verify.js");
        const rpc = async (_u, init) => { const j = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_getTransactionReceipt" ? fac.receipts.get(String(j.params[0]).toLowerCase()) || null : "0x1" }), { headers: { "content-type": "application/json" } }); };
        const proven = await verifyInboundPayment({ network: "eip155:8453", payer: row.payer, amountUsd: 0.03, tx: row.evidenceKey, wire: row.wire, referralPayTo: PAY_TO, referralMerchantId: MERCHANT_ID, referralPayout: PAYOUT, rpcFor: () => "http://rpc.invalid", fetchImpl: rpc });
        ok(proven.verified === true, `and the refund run proves that row by the buyer's own transfer into the contract (${proven.verified}: ${proven.reason || ""})`);
        // A success naming a transaction that moved none of this buyer's money stays refused.
        const empty = "0x" + "e9".repeat(32);
        fac.receipts.set(empty, { transactionHash: empty, status: "0x1", to: PAY_TO, logs: [] });
        fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: empty, network: REFERRAL_NETWORK } });
        const d = await pay9(app, "echo");
        const keyD = gateMod.referralReplayKey(d.p.authorization);
        const refused = await app.gate.resolveByHand(keyD, { note: "asked for a refund", outcome: "refund" });
        ok(d.reason !== "settled_to_another_merchant" && !("transaction" in (d.json || {})) && b.get(keyD)?.state === "contradicted" && b.get(keyD).moved !== true && refused.ok === false && owed.length === 1, `a contradicted success whose transaction moved none of the buyer's money is not told it was settled elsewhere, and no debt can be recorded for it (${d.status} ${d.reason}; ${refused.error})`);
        await app.gate.resolveByHand(keyD, { note: "test cleanup", outcome: "dismissed" });
      } finally { await app.close(); }
    }
    fac.reset(); sales.length = 0; owed.length = 0;
    // 2. A refusal at settle is the facilitator's word: the entry closes on a chain read, not on that word.
    {
      const b = book9("refused");
      const app = await mount({}, { book: b });
      try {
        fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "insufficient_funds" } });
        const clear = await pay9(app, "echo");
        const kClear = gateMod.referralReplayKey(clear.p.authorization);
        ok(clear.status === 402 && clear.reason === "insufficient_funds" && b.get(kClear) === null && /no charge is recorded/i.test(clear.json.errorMessage) && /owed/.test(clear.json.errorMessage) && !/Nothing was charged/.test(clear.json.errorMessage), `a settle refused, with the chain reading the authorization unused: the entry is closed, and the buyer is told no charge is recorded and what follows if one lands (${clear.status}; entry ${b.get(kClear) ? "open" : "closed"}; "${clear.json?.errorMessage}")`);
        // The chain cannot be read: the refusal alone closes nothing.
        const refusedBlind = () => { fac.mode.rpcDown = true; return { status: 200, body: { success: false, errorReason: "insufficient_funds" } }; };
        fac.mode.settle = refusedBlind;
        const open = await pay9(app, "echo");
        fac.mode.rpcDown = false;
        const kOpen = gateMod.referralReplayKey(open.p.authorization);
        ok(open.status === 402 && b.get(kOpen)?.state === "in-doubt" && sales.length === 0, `a settle refused while the chain cannot be read keeps its entry, in doubt (${open.status}; ${b.get(kOpen)?.state || "closed"})`);
        // The payment lands after all (the facilitator sent it late).
        const late = fac.land(open.p.authorization, fac.nextTx());
        await app.gate.sweepOnce();
        await quietLedger();
        const eLate = b.get(kOpen);
        ok(eLate && ["charged-undelivered", "refund-owed"].includes(eLate.state) && eLate.tx === late && (owed.some((o) => o.tx === late) || eLate.state === "charged-undelivered"), `and a payment that lands late is found by the sweep: charged, undelivered, never lost (${eLate?.state})`);
        const got = await pay9(app, "echo", { header: open.p.header });
        ok((got.status === 200 && got.json.echo === "r9") || (got.status === 409 && got.json.transaction === late), `its buyer's re-send gets the answer or is told it is owed back, with the transaction (${got.status} ${got.reason || ""})`);
        // The chain reads unused and the authorization expired: closed by the sweep.
        fac.mode.settle = refusedBlind;
        const idle = await pay9(app, "echo");
        fac.mode.rpcDown = false;
        const kIdle = gateMod.referralReplayKey(idle.p.authorization);
        const wasOpen = b.get(kIdle)?.state;
        skew.ms += 20 * 60_000;
        await app.gate.sweepOnce();
        ok(wasOpen === "in-doubt" && b.get(kIdle) === null && !owed.some((o) => o.payer === idle.p.authorization.from.toLowerCase()), `one that never lands is closed once its authorization can no longer be sent (${wasOpen} -> ${b.get(kIdle) ? b.get(kIdle).state : "closed"})`);
        skew.ms -= 20 * 60_000;
      } finally { fac.mode.rpcDown = false; await app.close(); }
    }
  }

  // --- the key stays where it is ----------------------------------------------------
  const haystack = [...logLines, ...responses, ...fac.calls.map((c) => c.raw + JSON.stringify(c.signature))].join("\n").toLowerCase();
  ok(logLines.length > 30 && responses.length > 100 && !haystack.includes(KEY_HEX), `the signer key is in no log line, no response and no facilitator request (${logLines.length} lines, ${responses.length} responses)`);
  ok(logLines.every((l) => !l.toLowerCase().includes(buyer.address.toLowerCase())), "no log line carries a payer's full address");
  ok(responses.every((t) => !/reviewer|commission/i.test(t)), "no answer characterizes the counterparty or names a commission");
} catch (e) {
  failed++;
  console.error(`FAIL - part 1 threw: ${e?.stack || e}`);
} finally {
  await app1.close();
}
}

// ===============================================================================
// Part 2: the real server, paid mode
// ===============================================================================
if (ONLY_PART !== "1") {
const TOKEN_OP = "referral-gate-operator-token-0123456789";
const COSTS = { UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)) };
const baseAmountOf = (r) => {
  const header = r.headers.get("payment-required");
  const offer = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : r.json;
  const a = (offer?.accepts || []).find((x) => x.network === "eip155:8453" && x.scheme === "exact");
  return a ? { amount: String(a.amount ?? a.maxAmountRequired), accept: a } : null;
};
const REF_ENV = { AGENT402_BASE_RPC: `${fac.url}/rpc`, EVM_LOGS_PUBLIC_RPCS_BASE: "", REFERRAL_MERCHANT_ID: MERCHANT_ID, REFERRAL_PAYOUT_ADDRESS: PAYOUT, REFERRAL_RECEIPT_WAIT_MS: "0", REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY, REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral", REFERRAL_SLUGS: "hash", REFERRAL_COMMISSION_BPS: "default:1234" };
const BLANK = { REFERRAL_PAY_TO: "", REFERRAL_FACILITATOR_URL: "", REFERRAL_SIGNER_KEY: "", REFERRAL_SLUGS: "", REFERRAL_SETUP_URL: "", REFERRAL_COMMISSION_BPS: "" };

// Switches unset: nothing is mounted.
{
  const off = await bootPaidServer({ label: "referral-off", env: { ...BLANK, AGENT402_OPERATOR_TOKEN: TOKEN_OP } });
  try {
    const a = await call(`${off.url}/ref/hash`, { method: "GET" });
    const b = await call(`${off.url}/ref/hash`, { body: { text: "a" } });
    const direct = await call(`${off.url}/api/hash`, { body: { text: "a" } });
    ok(a.status === 404 && b.status === 404 && direct.status === 402, `with the REFERRAL_* variables unset /ref/* is a 404 and the direct route is unchanged (${a.status}, ${b.status}, ${direct.status})`);
    // Fully inert: /ref answers exactly what any unknown path answers (status, body, headers), on every method.
    const same = [];
    for (const [method, extra] of [["GET", {}], ["POST", { body: { text: "a" } }], ["OPTIONS", { headers: { origin: "https://client.example", "access-control-request-method": "POST" } }], ["HEAD", {}]]) {
      const ref = await call(`${off.url}/ref/hash`, { method, ...extra });
      const unknown = await call(`${off.url}/zzz/hash`, { method, ...extra });
      const pick = (r) => JSON.stringify([...r.headers.entries()].filter(([k]) => !["date", "etag", "x-request-id", "x-response-time", "server-timing"].includes(k)).sort());
      const norm = (t) => t.replaceAll("/ref/hash", "PATH").replaceAll("/zzz/hash", "PATH");
      same.push(`${method}:${ref.status === unknown.status && norm(ref.text) === norm(unknown.text) && pick(ref) === pick(unknown) ? "same" : `DIFF ${ref.status}/${unknown.status} ${pick(ref) === pick(unknown) ? "" : "headers"}`}`);
    }
    ok(same.every((x) => x.endsWith(":same")), `with the gate off /ref answers exactly what an unknown path answers: status, body and headers (${same.join(", ")})`);
    ok(!/referral/i.test(off.log()), "and the boot log says nothing about it");
    const op = await call(`${off.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } });
    const noToken = await call(`${off.url}/__operator/referral.json`, { method: "GET" });
    ok(op.status === 200 && op.json?.enabled === false && noToken.status === 404, `the operator view says the gate is off, and answers 404 without the token (${op.status}, ${noToken.status})`);
    const gsOff = await call(`${off.url}/api/gateway-status`, { method: "GET" });
    ok(gsOff.status === 200 && !("referralSettlement" in (gsOff.json || {})), "with the gate off /api/gateway-status carries no referral word");
  } finally { await off.stop(); }
}
{
  // A setting that is missing or not usable leaves the gate off with one line, and never fails the boot.
  const half = await bootPaidServer({ label: "referral-half", env: { ...REF_ENV, REFERRAL_COMMISSION_BPS: "" } });
  try {
    const a = await call(`${half.url}/ref/hash`, { method: "GET" });
    ok(a.status === 404 && /referral gate is off: missing REFERRAL_COMMISSION_BPS/.test(half.log()) && !half.log().toLowerCase().includes(KEY_HEX), `without the commission map the gate serves nothing and warns once, naming the variable (${a.status})`);
  } finally { await half.stop(); }
  const zero = await bootPaidServer({ label: "referral-zero-key", env: { ...REF_ENV, REFERRAL_SIGNER_KEY: "00".repeat(32) } });
  try {
    const a = await call(`${zero.url}/ref/hash`, { method: "GET" });
    const h = await call(`${zero.url}/health`, { method: "GET" });
    ok(h.status === 200 && a.status === 404 && (zero.log().match(/referral gate is off/g) || []).length === 1 && /not usable/.test(zero.log()), `an all-zero signer key: the server boots, the gate is off, one line says why (${h.status}, ${a.status})`);
  } finally { await zero.stop(); }
}

{
  // FREE_MODE never builds the gate, whatever is set.
  const free = await bootServer({ stores: "referral-free", env: { ...REF_ENV, FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", STATS_ALLOW_EPHEMERAL: "true", REDIS_URL: "" } });
  try {
    const ref = await call(`${free.url}/ref/hash`, { body: { text: "a" } });
    const unknown = await call(`${free.url}/zzz/hash`, { body: { text: "a" } });
    const directFree = await call(`${free.url}/api/hash`, { body: { text: "abc" } });
    ok(directFree.status === 200 && ref.status === unknown.status && ref.status === 404 && ref.headers.get("content-type") === unknown.headers.get("content-type") && !/referral/i.test(free.log()), `in FREE_MODE the gate is never built, even fully configured: /ref is an unknown path (${ref.status}) and the log says nothing`);
  } finally { await free.stop(); }
}

// --- the wiring of every limiter twin (a boot of its own: its ceilings are tiny) ----------
{
  const w = await bootPaidServer({
    label: "referral-wiring",
    env: { ...REF_ENV, ...COSTS, REFERRAL_SLUGS: "hash,v1-chat-metered,onchain-sql", TRUST_PROXY_HOPS: "1", UNPAID_QUOTE_BUDGET_PER_HOUR: "5", SHED_INFLIGHT: "1" },
  });
  const at = (ip, extra = {}) => ({ "x-forwarded-for": ip, ...extra });
  try {
    ok(/Referral gate enabled for 3 route\(s\): hash, v1-chat-metered, onchain-sql/.test(w.log()), "the wiring boot serves hash, the metered chat tier and onchain-sql");
    // Load shed: with the in-flight ceiling at 1 a free route is shed, a /ref copy is not.
    const free = await call(`${w.url}/api/find?q=hash`, { method: "GET", headers: at("198.51.100.1") });
    const ref = await call(`${w.url}/ref/hash`, { method: "GET", headers: at("198.51.100.1") });
    ok(free.status === 503 && ref.status === 402, `under load a free route is shed and a /ref copy still answers its 402 (${free.status}, ${ref.status})`);
    // The unpaid-quote budget counts a /ref copy like the route it copies, and its 429 says what is true here.
    let last = null;
    for (let i = 0; i < 7; i++) last = await call(`${w.url}/ref/hash`, { method: "GET", headers: at("198.51.100.2") });
    ok(last.status === 429 && last.json?.reason === "unpaid-quote-budget", `past the unpaid-quote budget a /ref price check is answered 429 (${last.status})`);
    ok(last.json?.hint && !/published at/.test(last.json.hint) && !/openapi|well-known|api\/pricing|crawler|https?:\/\//.test(last.json.hint) && /settled a paid call in the last \d+ minutes reads against/.test(last.json.hint), `and its text claims no discovery listing and states the allowance a settled call earns (${String(last.json?.hint).slice(0, 200)})`);
    const directHint = (await (async () => { let r = null; for (let i = 0; i < 7; i++) r = await call(`${w.url}/api/hash`, { body: { text: "a" }, headers: at("198.51.100.3") }); return r; })()).json?.hint || "";
    ok(/published at \/\.well-known\/x402/.test(directHint), "the direct route's 429 keeps its own text");
    // A settled referral call earns its address the paid-client allowance: its price checks read against the raised ceiling.
    {
      fac.reset();
      const payIp = "198.51.100.9";
      const acc = (await call(`${w.url}/ref/hash`, { method: "GET", headers: at(payIp) })).json.accepts[0];
      const paidCall = await call(`${w.url}/ref/hash`, { body: { text: "abc" }, headers: at(payIp, { "payment-signature": (await signPayment(acc, { account: newAccount() })).header }) });
      const checks = [];
      for (let i = 0; i < 9; i++) checks.push((await call(`${w.url}/ref/hash`, { method: "GET", headers: at(payIp) })).status);
      ok(paidCall.status === 200 && checks.every((c) => c === 402), `an address that settled a referral call is not held to the unpaid ceiling of 5 an hour (${paidCall.status}; ${[...new Set(checks)].join(",")})`);
    }
    // The metered quote limiter covers the metered copy: 60 a minute, then 429.
    const body = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
    const statuses = [];
    for (let i = 0; i < 70; i++) statuses.push((await call(`${w.url}/ref/v1-chat-metered`, { body, headers: at(`203.0.113.${1 + (i % 2)}`) })).status);
    // Two addresses share the 70 so the hourly budget above (5 each) is what answers first on neither... each address reads 35.
    const quoteLimited = await (async () => { const out = []; for (let i = 0; i < 70; i++) out.push(await call(`${w.url}/ref/v1-chat-metered`, { body, headers: at("203.0.113.77", { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} })).toString("base64") }) })); return out; })();
    ok(statuses.includes(429), `unpaid quotes on the metered copy are bounded (${[...new Set(statuses)].join(",")})`);
    const refusedCredential = quoteLimited.filter((r) => r.status === 429 && /refused payment credentials/.test(r.text)).length;
    ok(refusedCredential > 0 && quoteLimited[0].status === 402, `70 refused credentials on the metered copy: the first is its 402, and past the limiter's 60 a minute they are answered 429 (${refusedCredential} limited)`);
    const flatRefused = await (async () => { const out = []; for (let i = 0; i < 70; i++) out.push(await call(`${w.url}/ref/hash`, { body: { text: "a" }, headers: at("203.0.113.88", { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} })).toString("base64") }) })); return out; })();
    ok(flatRefused[0].status === 402 && flatRefused.filter((r) => r.status === 429 && /refused payment credentials/.test(r.text)).length > 0, "a copy of a flat route is under the same refused-credential limiter");
    // The metered copy's own 1 MB parser and the large-body twin of onchain-sql.
    const big = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "word ".repeat(30_000) }], max_tokens: 16 };
    const paidShape = { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} })).toString("base64") };
    const bigRef = await call(`${w.url}/ref/v1-chat-metered`, { body: big, headers: at("203.0.113.90", paidShape) });
    ok(bigRef.status === 402 && bigRef.json?.errorReason === "invalid_payload", `a 150 KB body reaches the metered copy through its own parser (${bigRef.status} ${bigRef.json?.errorReason || bigRef.text.slice(0, 60)})`);
    const sqlBody = { sql: `SELECT 1 /* ${"x".repeat(150_000)} */` };
    const bigSql = await call(`${w.url}/ref/onchain-sql`, { body: sqlBody, headers: at("203.0.113.91", paidShape) });
    const bigSqlDirect = await call(`${w.url}/api/onchain-sql`, { body: sqlBody, headers: at("203.0.113.92", paidShape) });
    ok(bigSql.status === 402 && bigSql.json?.errorReason === "invalid_payload" && bigSqlDirect.status !== 413, `a 150 KB body reaches the onchain-sql copy through the large-body twin, as it reaches the direct route (${bigSql.status} ${bigSql.json?.errorReason || bigSql.text.slice(0, 60)}; direct ${bigSqlDirect.status})`);
    // The large-body gate itself covers the copy: an unpaid oversized body is answered without being read (so
    // even one that is not JSON gets the 402), exactly as on the direct route.
    const unreadRef = await call(`${w.url}/ref/onchain-sql`, { rawBody: "{not json " + "x".repeat(150_000), headers: at("203.0.113.96") });
    const unreadDirect = await call(`${w.url}/api/onchain-sql`, { rawBody: "{not json " + "x".repeat(150_000), headers: at("203.0.113.97") });
    ok(unreadRef.status === 402 && unreadDirect.status === 402 && Array.isArray(unreadRef.json?.accepts), `an unpaid oversized body on the onchain-sql copy is answered its 402 without being read, as on the direct route (${unreadRef.status}, direct ${unreadDirect.status})`);
    const bigHash = await call(`${w.url}/ref/hash`, { body: { text: "x".repeat(150_000) }, headers: at("203.0.113.93", paidShape) });
    ok(bigHash.status === 413, `a copy of a route with no large-body allowance keeps the 100 KB limit (${bigHash.status})`);
    // A non-canonical spelling reaches none of the path-mounted limiters, so it is given nothing.
    const encoded = await call(`${w.url}/ref/v1%2Dchat%2Dmetered`, { body, headers: at("203.0.113.94") });
    const upper = await call(`${w.url}/REF/hash`, { method: "GET", headers: at("203.0.113.95") });
    const slash = await fetch(`${w.url}/ref/hash/`, { method: "GET", redirect: "manual", headers: at("203.0.113.96") });
    const slashBody = await slash.text();
    ok(slash.status === 404 && !slash.headers.get("location") && /application\/json/.test(slash.headers.get("content-type") || "") && /no-store/.test(slash.headers.get("cache-control") || ""), `a trailing slash on a /ref path is a JSON 404, never a redirect (${slash.status} ${slashBody.slice(0, 60)})`);
    ok(encoded.status === 404 && upper.status === 404, `a percent-encoded or re-cased spelling of a /ref path is a 404 (${encoded.status}, ${upper.status})`);
  } catch (e) {
    failed++;
    console.error(`FAIL - the wiring boot threw: ${e?.stack || e}`);
    console.error(w.log().slice(-1500));
  } finally { await w.stop(); }
}

// --- the main boot ---------------------------------------------------------------------
// A stand-in for the model upstream (counts requests and the ones cut off
// before it answered) and one for the direct routes' own facilitator.
const or = { chat: 0, delayMs: 0, closedEarly: 0, closedAfterMs: [], bodies: [] };
const orStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      or.chat++;
      const started = Date.now();
      let parsed = {}; try { parsed = JSON.parse(b); } catch { /* answered anyway */ }
      or.bodies.push(parsed);
      res.on("close", () => { if (!res.writableFinished) { or.closedEarly++; or.closedAfterMs.push(Date.now() - started); } });
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: parsed.model || "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(parsed.messages || "").includes("a long answer please") ? "OK ".repeat(1500) : "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.000001 } }));
      }, or.delayMs);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "not stubbed" } }));
  });
});
await new Promise((r) => orStub.listen(0, "127.0.0.1", r));
const direct = { verify: 0, settle: 0 };
const directFac = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    let payer = null; try { payer = JSON.parse(b).paymentPayload.payload.authorization.from; } catch { /* answered anyway */ }
    if (req.url === "/verify") { direct.verify++; return res.end(JSON.stringify({ isValid: true, payer })); }
    if (req.url === "/settle") { direct.settle++; return res.end(JSON.stringify({ success: true, transaction: "0x" + createHash("sha256").update(b).digest("hex"), network: "eip155:8453", payer })); }
    res.end("{}");
  });
});
await new Promise((r) => directFac.listen(0, "127.0.0.1", r));
const LISTED = newAccount();
const screenFile = join(tmp, "screen.json");
writeFileSync(screenFile, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: [LISTED.address.toLowerCase()] }));

fac.reset();
// Paid data tools whose reads carry fixed timeouts of their own, each ended by a run's ceiling (src/run-ceiling.js).
const DATA_SLUGS = "device-510k,device-adverse-events,device-recalls,drug-adverse-events,drug-label,drug-ndc,drug-recalls,earthquakes,fec-candidates,federal-awards,fema-disasters,food-recalls,fx-rate,geo-lookup,geocode,http-check,ip-info,public-holidays,robots-check,sitemap,tls-cert,treasury-avg-rates,treasury-debt,treasury-yield-curve,treasury-yield-history,vehicle-recalls,vin-decode,weather-air-quality,weather-alerts,weather-current,weather-daily,weather-forecast,weather-history,weather-hourly,whois,yield-curve-spread".split(",");
const srv = await bootPaidServer({
  label: "referral-on",
  args: ["--import", "./scripts/lib/openrouter-stub-preload.js", "--import", "./scripts/lib/hang-fetch-preload.js"],
  env: {
    ...REF_ENV, ...COSTS,
    WALLET_ADDRESS: OUR_WALLET, TRUST_PROXY_HOPS: "1",
    FACILITATOR_URL: `http://127.0.0.1:${directFac.address().port}`, AGENT402_BASE_RPC: `${fac.url}/rpc`,
    REFERRAL_SLUGS: "hash,mime,v1-chat-metered,v1-chat,v1-chat-auto,v1-chat-pro,v1-chat-premium,onchain-sql,perp-funding,perp-basis,stablecoin-peg,edgar-company-facts,image-gen,image-gen-premium,attest,qr,no-such-tool,dns," + DATA_SLUGS.join(","),
    // The price feed stablecoin-peg reads never answers: its run has to be cut off at the deadline.
    HANG_FETCH_HOSTS: "api.coingecko.com,pro-api.coingecko.com",
    // The handler deadline is short so a stalled upstream is cut off inside the test.
    REFERRAL_DEADLINE_MS: "4000", REFERRAL_SETTLE_RESERVE_MS: "1000", REFERRAL_VERIFY_MS: "1000", REFERRAL_SETTLE_MS: "3000",
    AGENT402_OPERATOR_TOKEN: TOKEN_OP,
    OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_STUB_URL: `http://127.0.0.1:${orStub.address().port}`, OPENROUTER_FLEX: "off",
    // The direct routes' breaker trips at 3, so a referral run that fed it would show.
    GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000",
    SANCTIONS_SCREEN_FILE: screenFile, SANCTIONS_LIST_URL: `${fac.url}/SDN.XML`,
    LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
  },
});
let ip2 = 0;
const xff = () => ({ "x-forwarded-for": `192.0.2.${1 + (++ip2 % 250)}` });
try {
  const bootLog = srv.log();
  const servedLine = /Referral gate enabled for (\d+) route\(s\): ([^\n]*)/.exec(bootLog);
  const served = servedLine ? servedLine[2].split(",").map((s) => s.trim()) : [];
  // Left out since they were listed: three whose published examples name this server's own host, and mime (free by proof-of-work on the public route).
  const OWN_HOST_SLUGS = ["http-check", "robots-check", "sitemap"];
  const SERVED = ["hash", "onchain-sql", "perp-funding", "perp-basis", "stablecoin-peg", "edgar-company-facts", "v1-chat-auto", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-chat"];
  ok(servedLine && SERVED.every((x) => served.includes(x)) && DATA_SLUGS.every((x) => served.includes(x) !== OWN_HOST_SLUGS.includes(x)) && served.length === SERVED.length + DATA_SLUGS.length - OWN_HOST_SLUGS.length, `the boot serves the eligible slugs (${servedLine ? servedLine[2] : "no line"})`);
  const whyServed = Object.fromEntries([...bootLog.matchAll(/\[referral\] (\S+) is served under \/ref: ([^\n]*)/g)].map((m) => [m[1], m[2]]));
  console.log(`# boot verdicts: ${JSON.stringify(whyServed)}`);
  ok(/no upstream work/.test(whyServed.hash || "") && ["v1-chat-auto", "v1-chat-pro", "v1-chat-premium"].every((x) => /ends at the deadline \(own timeout 90 s\)/.test(whyServed[x] || "")) && ["onchain-sql", "perp-funding", "perp-basis", "stablecoin-peg", "edgar-company-facts"].every((x) => /ends at the deadline \(own timeout 290 s\)/.test(whyServed[x] || "")), "each served slug says why its handler deadline can be kept: no upstream work, or upstream work the deadline ends (with the tool's own timeout named)");
  {
    // The data tools: served because the gate's deadline really ends their upstream reads, at the direct price.
    const notByCeiling = DATA_SLUGS.filter((x) => !OWN_HOST_SLUGS.includes(x) && !/^upstream work ends at the deadline$/.test(whyServed[x] || ""));
    const refusedData = DATA_SLUGS.filter((x) => new RegExp(`\\[referral\\] ${x} is not served`).test(bootLog));
    ok(OWN_HOST_SLUGS.every((x) => new RegExp(`\\[referral\\] ${x} is not served under /ref: its published example or input hints name this server's own host`).test(bootLog)) && /\[referral\] mime is not served under \/ref: the public route can be had for less than the listed price \(free by proof-of-work or the trial parameter\)/.test(bootLog) && /\[referral\] hash is served under \/ref although the public route can be had for less \(free by proof-of-work or the trial parameter\): it was served before the price-parity rule/.test(bootLog) && (await call(`${srv.url}/ref/mime`, { method: "GET", headers: xff() })).status === 404 && (await call(`${srv.url}/ref/robots-check`, { method: "GET", headers: xff() })).status === 404, `a slug whose published example names this server's own host, and one the public route gives free, are refused at boot with the reason; hash, served before the parity rule, is named at boot and served (${refusedData.join(",")})`);
    ok(DATA_SLUGS.length === 36 && notByCeiling.length === 0 && refusedData.join() === OWN_HOST_SLUGS.join() && /\[referral\] dns is not served under \/ref: in the catalog but has no handler/.test(bootLog), `each of the other 33 paid data tools is served under /ref because its upstream work ends at the deadline, and dns (a route with no handler of its own) stays out (${notByCeiling.join(",") || "all 36 by the ceiling"})`);
    const pricing = (await call(`${srv.url}/api/pricing`, { method: "GET", headers: xff() })).json;
    const rowsP = Array.isArray(pricing?.endpoints) ? pricing.endpoints : [];
    const priceOf = new Map(rowsP.filter((r) => r && r.slug).map((r) => [r.slug, r.price]));
    const wrongPrice = [];
    for (const slug of DATA_SLUGS.filter((x) => !OWN_HOST_SLUGS.includes(x))) {
      const q = await call(`${srv.url}/ref/${slug}`, { method: "GET", headers: xff() });
      const want = baseUnitsOf(priceOf.get(slug));
      if (q.status !== 402 || want === null || q.json?.accepts?.[0]?.amount !== want.toString() || q.json.accepts[0].payTo !== PAY_TO) wrongPrice.push(`${slug}: ${q.status} ${q.json?.accepts?.[0]?.amount} want ${want}`);
    }
    ok(priceOf.size > 400 && wrongPrice.length === 0, `each one's 402 pays the split contract the tool's direct list price (${wrongPrice.join("; ") || "33 of 33"})`);
    // NO POINTER to this server's own surfaces, on anything a /ref route of a served slug answers:
    // the 402 (with its example, for an empty request), an input the route refuses unpaid, and the same input paid.
    const hostOf = new URL(srv.url).host;
    const pointers = (text, slug) => {
      const found = [];
      for (const m of String(text).matchAll(new RegExp(`(?:agent402\\.tools|${hostOf.replace(/[.]/g, "\\.")})(\\/[^\\s"'\\\\<>)]*)?`, "gi"))) { const path = m[1] || "/"; if (!path.startsWith(`/ref/${slug}`) && !path.startsWith("/api/refunds?tx=")) found.push(m[0]); }
      for (const m of String(text).matchAll(/(?:^|[\s"'(])(\/(?:api\/(?!refunds\?tx=)[a-z0-9-]+|v1\/[a-z0-9/-]+|openapi\.json|llms[a-z-]*\.txt|\.well-known\/x402|docs|pricing|crawler|tools|catalog)\b[^\s"']*)/gi)) found.push(m[1]);
      return found;
    };
    ok(pointers(`see https://agent402.tools/api/pricing or /openapi.json, POST /api/hash, https://${hostOf}/docs`, "hash").length === 4 && pointers(`{"url":"https://${hostOf}/ref/hash","endpoint":"/ref/hash","refundStatusUrl":"https://agent402.tools/api/refunds?tx=0xab"}`, "hash").length === 0, "control: the walk's reading finds a pointer to pricing, the spec, a direct route or the docs, and passes the route's own URL and the refund lookup");
    const pointed = [];
    let walked = 0;
    for (const slug of served) {
      const empty = await call(`${srv.url}/ref/${slug}`, { method: "GET", headers: xff() });
      const emptyPost = await call(`${srv.url}/ref/${slug}`, { body: {}, headers: xff() });
      const badGet = await call(`${srv.url}/ref/${slug}?zz_not_a_field=1`, { method: "GET", headers: xff() });
      const bad = await call(`${srv.url}/ref/${slug}`, { body: { zz_not_a_field: 1 }, headers: xff() });
      const acc = [empty, emptyPost, bad, badGet].map((r) => r.json?.accepts?.[0]).find(Boolean);
      const paidBad = acc ? await call(`${srv.url}/ref/${slug}`, { body: { zz_not_a_field: 1 }, headers: { ...xff(), "payment-signature": (await signPayment(acc)).header } }) : null;
      for (const [what, r] of [["empty GET", empty], ["empty POST", emptyPost], ["invalid GET", badGet], ["invalid POST", bad], ["invalid, paid", paidBad]]) {
        if (!r) continue;
        walked++;
        const hit = pointers(r.text, slug);
        if (hit.length) pointed.push(`${slug} ${what} (${r.status}): ${hit.slice(0, 2).join(" ")}`);
        if (hit.length && process.env.WALK_DEBUG) console.log(`# WALK ${slug} ${what}: ${r.text.slice(0, 900)}`);
      }
    }
    ok(walked >= served.length * 4 && pointed.length === 0, `no answer of a served /ref route points a buyer at this server's catalog, pricing, docs or direct routes: ${walked} answers of ${served.length} slugs walked (${pointed.slice(0, 6).join("; ") || "none"})`);
  }
  ok(/\[referral\] image-gen is not served under \/ref: its own upstream wait \(60 s\) is past the handler deadline \(4 s\)/.test(bootLog), "image-gen is left out at boot: its own upstream wait is past the handler deadline");
  ok(/\[referral\] image-gen-premium is not served under \/ref: long-running/.test(bootLog) && /\[referral\] no-such-tool is not served under \/ref: not in the catalog/.test(bootLog) && /\[referral\] attest is not served/.test(bootLog) && /\[referral\] qr is not served under \/ref: answers bytes/.test(bootLog), "a long-running, an identity-bound, a binary and a missing slug are left out with a reason");
  for (const slug of ["image-gen", "image-gen-premium", "attest", "qr", "no-such-tool"]) {
    const r = await call(`${srv.url}/ref/${slug}`, { method: "GET", headers: xff() });
    if (r.status !== 404) ok(false, `/ref/${slug} answers ${r.status}, expected 404`);
  }
  ok(true, "every slug left out at boot answers 404");

  // The public surfaces before any referral sale.
  const SURFACES = ["/api/sales", "/api/stats", "/api/revenue", "/api/revenue/daily", "/api/calls/daily", "/api/revenue/mpp", "/api/revenue/tempo-daily", "/api/revenue/decide", "/api/proof", "/api/scorecard", "/api/leaderboard", "/api/index", "/api/analytics", "/api/gateway-status", "/api/reliability", "/api/pricing", "/openapi.json", "/llms.txt", "/llms-full.txt", "/.well-known/x402", "/sitemap.xml", "/robots.txt", "/api/rails", "/revenue", "/"];
  const snapshot = async () => Object.fromEntries(await Promise.all(SURFACES.map(async (p) => { const r = await call(`${srv.url}${p}`, { method: "GET", headers: { "x-forwarded-for": "192.0.2.254" } }); return [p, r]; })));
  const before = await snapshot();
  const statusBefore = await call(`${srv.url}/api/gateway-status`, { method: "GET" });

  // The 402 on the real server.
  const bare = await call(`${srv.url}/ref/hash`, { method: "GET", headers: { ...xff(), "x-referrer-token": "tok.en-1" } });
  const refAccept = bare.json?.accepts?.[0];
  ok(bare.status === 402 && bare.json?.x402Version === 2 && refAccept?.payTo === PAY_TO && refAccept.network === "eip155:8453" && refAccept.asset === REFERRAL_ASSET && refAccept.extra?.endpoint === "/ref/hash" && refAccept.extra.authorizationType === "ReceiveWithAuthorization" && bare.json.extensions?.attributionToken === "tok.en-1", `GET /ref/hash answers the referral 402 (${bare.status})`);
  ok(!bare.headers.get("payment-required") && !bare.headers.get("www-authenticate") && !bare.json.payment && !bare.json.howToCall && !bare.text.includes("/api/hash") && !bare.text.includes(OUR_WALLET), "it carries no PAYMENT-REQUIRED or WWW-Authenticate header, no payment guide, no pointer to the direct route and not this server's own wallet");
  ok(bare.headers.get("x-robots-tag") === "noindex, nofollow" && bare.headers.get("x-content-type-options") === "nosniff" && /max-age=/.test(bare.headers.get("strict-transport-security") || ""), "it is noindex and carries the always-on security headers");
  {
    // A machine path: a malformed body is a JSON 400, and a preflight is answered as on a direct route.
    const malformed = await call(`${srv.url}/ref/hash`, { rawBody: "{not json", headers: xff() });
    ok(malformed.status === 400 && /application\/json/.test(malformed.headers.get("content-type") || "") && malformed.json && typeof malformed.json === "object", `a malformed JSON body is a JSON 400 (${malformed.status} ${malformed.headers.get("content-type")})`);
    const pre = await fetch(`${srv.url}/ref/hash`, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST", ...xff() } });
    const preDirect = await fetch(`${srv.url}/api/hash`, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST", ...xff() } });
    await pre.text(); await preDirect.text();
    ok(pre.status === preDirect.status && pre.status !== 402 && pre.headers.get("access-control-allow-origin") === preDirect.headers.get("access-control-allow-origin"), `OPTIONS on /ref is answered as a direct route answers it (${pre.status} vs ${preDirect.status})`);
    const put = await call(`${srv.url}/ref/hash`, { method: "PUT", body: { text: "a" }, headers: xff() });
    ok(put.status === 404 || put.status === 405, `another method gets no price (${put.status})`);
  }

  // Amount parity with the direct route's own Base accept, per request.
  const parity = async (name, refPath, directPath, body) => {
    const d = baseAmountOf(await call(`${srv.url}${directPath}`, { body, headers: xff() }));
    const r = await call(`${srv.url}${refPath}`, { body, headers: xff() });
    const got = r.json?.accepts?.[0]?.amount;
    ok(!!d && r.status === 402 && got === d.amount && BigInt(got) > 0n, `${name}: the referral amount is the direct route's Base amount (${got} vs ${d?.amount})`);
    return { got, direct: d, accept: r.json?.accepts?.[0] };
  };
  const flat = await parity("a flat-price tool", "/ref/hash", "/api/hash", { text: "abc" });
  ok(flat.got === "1000", `hash asks its list price in base units (${flat.got})`);
  const meteredBody = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 };
  const small = await parity("a metered chat body", "/ref/v1-chat-metered", "/v1/metered/chat/completions", meteredBody);
  const large = await parity("a larger metered chat body", "/ref/v1-chat-metered", "/v1/metered/chat/completions", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Summarize the history of settlement systems. ".repeat(200) }], max_tokens: 4000 });
  ok(BigInt(large.got) > BigInt(small.got), `the metered quote follows the body (${small.got} then ${large.got})`);
  await parity("a metered chat body asking for a stream", "/ref/v1-chat-metered", "/v1/metered/chat/completions", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true, stream_options: { include_usage: true } });
  const chatBody = (model) => ({ ...(model ? { model } : {}), messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  const home = await parity("a flat chat tier at its own price", "/ref/v1-chat", "/v1/chat/completions", chatBody());
  const cross = await parity("a flat chat tier priced by another tier's model", "/ref/v1-chat", "/v1/chat/completions", chatBody("anthropic/claude-opus-5.5"));
  ok(BigInt(cross.got) > BigInt(home.got), `the price follows the model named (${home.got} then ${cross.got})`);
  // The model-priced tiers: the amount follows the model the request names.
  const proHome = await parity("the pro tier at its own price", "/ref/v1-chat-pro", "/v1/pro/chat/completions", chatBody());
  const proDear = await parity("the pro tier naming a dearer tier's model", "/ref/v1-chat-pro", "/v1/pro/chat/completions", chatBody("anthropic/claude-opus-5.5"));
  ok(BigInt(proDear.got) > BigInt(proHome.got), `on the pro tier a dearer model raises the amount (${proHome.got} then ${proDear.got})`);
  const premHome = await parity("the premium tier at its own price", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody());
  const premNamed = await parity("the premium tier naming its own model", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody("anthropic/claude-opus-5.5"));
  const premOther = await parity("the premium tier naming another tier's model", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody("openai/gpt-6.1-terra"));
  ok(premNamed.got === premHome.got && premNamed.got === proDear.got && premOther.got === proHome.got, `a model is priced at its own tier on either route (${premHome.got}, ${premOther.got})`);
  const autoFlat = await parity("the auto tier", "/ref/v1-chat-auto", "/v1/auto/chat/completions", chatBody());
  const probe = await call(`${srv.url}/ref/v1-chat-metered`, { method: "GET", headers: xff() });
  const floor = await call(`${srv.url}/ref/v1-chat-metered`, { body: { nonsense: true }, headers: xff() });
  ok(probe.status === 402 && floor.status === 402 && probe.json.accepts[0].amount === floor.json.accepts[0].amount && BigInt(probe.json.accepts[0].amount) > 0n, `a bare GET and an unpriceable body both answer 402 at the route's list price (${probe.json?.accepts?.[0]?.amount})`);

  {
    // The metered quote limiter covers the metered copy: past 60 unpaid quotes a minute from one address, 429.
    const texts = [];
    for (let i = 0; i < 66; i++) { const r = await call(`${srv.url}/ref/v1-chat-metered`, { body: meteredBody, headers: { "x-forwarded-for": "192.0.2.240" } }); texts.push(`${r.status}:${r.json?.error || ""}`); }
    const limited = texts.filter((t) => /^429:Too many unpaid quote requests/.test(t)).length;
    ok(texts[0].startsWith("402") && limited >= 1 && limited <= 10, `the metered quote limiter bounds unpaid quotes on the metered copy (${limited} of 66 answered 429 by it)`);
  }

  // A paid call end to end on a flat tool.
  const p = await signPayment(refAccept);
  const good = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": p.header } });
  ok(good.status === 200 && good.json?.hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid /ref/hash returns the tool's answer with the settle transaction (${good.status} ${good.text.slice(0, 140)})`);
  ok(fac.of("/settle").length === 1 && fac.of("/settle")[0].recovered?.toLowerCase() === signer.address.toLowerCase() && fac.of("/settle")[0].json?.paymentRequirements?.payTo === PAY_TO && fac.of("/settle")[0].json.paymentRequirements.amount === "1000", "the referral facilitator settled it once, on a request signed by the signer key, for the quoted requirement");
  const replay = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": p.header } });
  ok(replay.status === 200 && replay.text === good.text && fac.of("/settle").length === 1, `the same payment again returns the kept answer, with no second settle (${replay.status})`);
  const invalidPay = await signPayment(refAccept);
  const invalid = await call(`${srv.url}/ref/hash`, { body: { algo: "sha256" }, headers: { ...xff(), "payment-signature": invalidPay.header } });
  ok(invalid.status === 400 && invalid.json?.tool === "hash" && !("howToCall" in invalid.json) && !invalid.text.includes("/api/hash") && fac.of("/settle").length === 1, `a paid call with an invalid input is the direct route's 400, not settled, with no ready-to-run call and no pointer to the direct route (${invalid.status} ${invalid.text.slice(0, 120)})`);
  {
    // The pre-payment input check ran before the claim: the same authorization still buys a valid call.
    const reuse = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": invalidPay.header } });
    ok(reuse.status === 200 && reuse.json?.hex === good.json.hex, `an input refused before payment claimed nothing: the same authorization then buys a valid call (${reuse.status})`);
    // A metered body the direct route refuses before any payment is refused the same way, unpaid.
    const tooBig = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "word ".repeat(120_000) }], max_tokens: 16 };
    const dBig = await call(`${srv.url}/v1/metered/chat/completions`, { body: tooBig, headers: xff() });
    const rBig = await call(`${srv.url}/ref/v1-chat-metered`, { body: tooBig, headers: xff() });
    ok(dBig.status === 400 && rBig.status === 400 && rBig.json?.error?.code === dBig.json?.error?.code && !/\/v1\/|\/api\//.test(rBig.text) && !("howToCall" in rBig.json), `an unpaid metered body over the model's input cap is refused 400 before any payment, as on the direct route, with no route named (${rBig.status} ${rBig.json?.error?.code}; direct ${dBig.status}; ${rBig.text.slice(0, 300)})`);
    // An empty request runs the tool's published example (the standard buyer flow sends no input).
    const emptyPost = await call(`${srv.url}/ref/hash`, { body: {}, headers: xff() });
    const emptyPaid = await call(`${srv.url}/ref/hash`, { body: {}, headers: { ...xff(), "payment-signature": (await signPayment(emptyPost.json.accepts[0])).header } });
    const exampleHex = createHash("sha256").update("hello world").digest("hex");
    ok(emptyPost.status === 402 && emptyPaid.status === 200 && emptyPaid.json?.hex === exampleHex && /^0x/.test(emptyPaid.json.transaction || ""), `a paid POST of {} to a fixed-price tool runs its published example and settles (${emptyPaid.status} ${emptyPaid.text.slice(0, 90)})`);
    // (A GET tool with a published example is covered in the in-process part: every pure-CPU GET tool is free by proof-of-work on the public route, so none is served here.)
    const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
    const proExample = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-pro").discovery.input;
    const proDirect = baseAmountOf(await call(`${srv.url}/v1/pro/chat/completions`, { body: proExample, headers: xff() }));
    const proEmpty = await call(`${srv.url}/ref/v1-chat-pro`, { method: "GET", headers: xff() });
    const chatBefore = or.chat;
    const proPaid = await call(`${srv.url}/ref/v1-chat-pro`, { body: {}, headers: { ...xff(), "payment-signature": (await signPayment(proEmpty.json.accepts[0])).header } });
    const sentBody = or.bodies.at(-1) || {};
    ok(proEmpty.status === 402 && proEmpty.json.accepts[0].amount === proDirect.amount && proPaid.status === 200 && or.chat === chatBefore + 1 && JSON.stringify(sentBody.messages) === JSON.stringify(proExample.messages) && sentBody.stream !== true && fac.of("/settle").at(-1).json.paymentRequirements.amount === proDirect.amount, `a model-priced chat tier: an empty request is quoted at its published example's price (${proEmpty.json?.accepts?.[0]?.amount}), and the paid empty call runs that example upstream and settles that amount (${proPaid.status})`);
  }
  {
    // A tool under a handler budget whose upstream never answers: the budget ceiling cuts the call off at the deadline.
    const q = await call(`${srv.url}/ref/stablecoin-peg`, { method: "GET", headers: xff() });
    const settlesBefore = fac.of("/settle").length;
    const t0 = Date.now();
    const r = await call(`${srv.url}/ref/stablecoin-peg`, { method: "GET", headers: { ...xff(), "payment-signature": (await signPayment(q.json.accepts[0], { account: newAccount() })).header } });
    const took = Date.now() - t0;
    await wait(200);
    const cut = [...srv.log().matchAll(/\[hang-fetch\] \S+ aborted after (\d+) ms/g)].map((m) => Number(m[1]));
    ok(q.status === 402 && r.status >= 500 && took < 5500 && fac.of("/settle").length === settlesBefore && /\[hang-fetch\] \S+ called/.test(srv.log()) && cut.length >= 1 && Math.max(...cut) <= 4200, `a budgeted data tool whose upstream never answers is cut off at the deadline, not left running, and is not settled (${r.status} after ${took} ms; upstream aborted after ${cut.join(", ")} ms; ${r.text.slice(0, 200)})`);
  }
  const garbage = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": "!!!not-base64!!!" } });
  const garbageX = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "x-payment": "!!!not-base64!!!" } });
  ok(garbage.status === 402 && garbage.json?.errorReason === "invalid_request" && garbageX.status === 402 && garbageX.json?.errorReason === "invalid_request" && !/PAYMENT-SIGNATURE/.test(garbageX.text), `a payment header that does not decode (either header) is a 402 invalid_request whose words name no header (${garbage.status}, ${garbageX.status})`);

  // The payer screen of the direct route runs here too.
  {
    const settlesBefore = fac.of("/settle").length, verifiesBefore = fac.of("/verify").length;
    const refused = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": (await signPayment(refAccept, { account: LISTED })).header } });
    const directAccept = flat.direct.accept;
    const directRefused = await call(`${srv.url}/api/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": (await signPayment({ ...directAccept }, { account: LISTED, to: directAccept.payTo, value: directAccept.amount, primaryType: "TransferWithAuthorization", validBefore: String(Math.floor(Date.now() / 1000) + 300) })).header } });
    ok(refused.status === 403 && refused.json?.reason === "payer-not-accepted" && refused.json.charged === false && fac.of("/settle").length === settlesBefore && fac.of("/verify").length === verifiesBefore, `a listed payer is refused 403 before the handler and before any facilitator call (${refused.status} ${refused.json?.reason})`);
    ok(directRefused.status === 403 && JSON.stringify(directRefused.json) === JSON.stringify(refused.json), `with the same refusal the direct route sends (${directRefused.status})`);
  }

  // The two paywalls do not take each other's payments.
  {
    const settlesBefore = fac.of("/settle").length;
    const cross1 = await call(`${srv.url}/api/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": (await signPayment(refAccept)).header } });
    ok(cross1.status === 402 && !cross1.json?.hex, `a referral payment sent to the direct route is refused (${cross1.status})`);
    const directAccept = flat.direct.accept;
    const directPay = await signPayment({ ...directAccept }, { to: directAccept.payTo, value: directAccept.amount, primaryType: "TransferWithAuthorization" });
    const cross2 = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": directPay.header } });
    ok(cross2.status === 402 && cross2.json?.errorReason === "invalid_exact_evm_payload_recipient_mismatch" && fac.of("/settle").length === settlesBefore, `a direct-route payment sent to /ref is refused before any facilitator call (${cross2.status} ${cross2.json?.errorReason})`);
  }

  // The REAL chat handler, paid through the gate, against the stand-in upstream.
  const paidChat = async (name, slug, body) => {
    const q = await call(`${srv.url}/ref/${slug}`, { body, headers: xff() });
    const acc = q.json?.accepts?.[0];
    const chatBefore = or.chat, settlesBefore = fac.of("/settle").length;
    const r = await call(`${srv.url}/ref/${slug}`, { body, headers: { ...xff(), "payment-signature": (await signPayment(acc)).header } });
    const sent = or.bodies.at(-1) || {};
    if (/\/v1\/|\/api\//.test(r.text) || /\/v1\/|\/api\//.test(q.text)) ok(false, `${name}: an answer names a direct route (${(r.text.match(/.{0,40}\/(?:v1|api)\/.{0,40}/) || q.text.match(/.{0,40}\/(?:v1|api)\/.{0,40}/) || [""])[0]})`);
    ok(q.status === 402 && r.status === 200 && r.json?.choices?.[0]?.message?.content === "OK" && /^0x[0-9a-f]{64}$/.test(r.json?.transaction || "") && or.chat === chatBefore + 1 && sent.stream !== true && fac.of("/settle").length === settlesBefore + 1 && fac.of("/settle").at(-1).json.paymentRequirements.amount === acc.amount,
      `${name}: the real handler runs once against the upstream (not streamed), and the answer comes back with the settle transaction for the quoted amount (${r.status} ${r.text.slice(0, 100)})`);
    return { acc, r };
  };
  await paidChat("a fixed-price chat tier", "v1-chat-auto", { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, stream: true });
  const proRun = await paidChat("a model-priced chat tier naming a dearer model", "v1-chat-pro", chatBody("anthropic/claude-opus-5.5"));
  ok(proRun.acc.amount === proDear.got, `settled at the dearer model's amount (${proRun.acc.amount})`);
  await paidChat("the metered chat tier", "v1-chat-metered", meteredBody);
  await paidChat("the premium chat tier", "v1-chat-premium", chatBody());
  await paidChat("the base chat tier (a flat tier a metered call would undercut)", "v1-chat", { messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  {
    // No answer of an admitted chat tier, success or error, names a direct route or tells the buyer to call one.
    const NAMES_ROUTE = /\/v1\/|\/api\/|base URL|chat\/completions/i;
    const bad = [];
    const errorOf = async (slug, body) => {
      const q = await call(`${srv.url}/ref/${slug}`, { body, headers: xff() });
      const acc = q.json?.accepts?.[0];
      const r = acc ? await call(`${srv.url}/ref/${slug}`, { body, headers: { ...xff(), "payment-signature": (await signPayment(acc, { account: newAccount() })).header } }) : q;
      for (const x of [q, r]) if (NAMES_ROUTE.test(x.text)) bad.push(`${slug} ${x.status}: ${(x.text.match(/.{0,50}(?:\/v1\/|\/api\/|base URL|chat\/completions).{0,50}/i) || [""])[0]}`);
      return r;
    };
    const statuses = {};
    for (const slug of ["v1-chat-auto", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-chat"]) {
      const a = await errorOf(slug, { model: "not-a-vendor/not-a-model", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
      const b = await errorOf(slug, { model: "openai/gpt-6-luna:online", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
      const c = await errorOf(slug, { messages: [{ role: "user", content: "hi" }], max_tokens: 5, n: 99 });
      const d = await errorOf(slug, { messages: "not a list" });
      statuses[slug] = [a.status, b.status, c.status, d.status].join("/");
    }
    ok(bad.length === 0 && Object.values(statuses).every((s2) => /4\d\d/.test(s2)), `the real chat handler's refusals on every admitted tier name no direct route (${JSON.stringify(statuses)}${bad.length ? `; named: ${bad.slice(0, 4).join(" | ")}` : ""})`);
    const dearer = await call(`${srv.url}/ref/v1-chat-pro`, { body: chatBody("anthropic/claude-opus-5.5"), headers: xff() });
    const dearerPaid = await call(`${srv.url}/ref/v1-chat-pro`, { body: chatBody("anthropic/claude-opus-5.5"), headers: { ...xff(), "payment-signature": (await signPayment(dearer.json.accepts[0], { account: newAccount() })).header } });
    ok(dearerPaid.status === 200 && dearerPaid.json?.agent402_tier && !("route" in dearerPaid.json.agent402_tier) && !NAMES_ROUTE.test(dearerPaid.text) && !("agent402_metered" in dearerPaid.json), `a call served under another tier's price says so without naming a route, and carries no pointer to the metered route (${JSON.stringify(dearerPaid.json?.agent402_tier)})`);
  }
  {
    // The upstream stalls: the gate answers at its deadline AND the upstream call is cut off.
    or.delayMs = 9000;
    const q = await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: xff() });
    const stalled = await signPayment(q.json.accepts[0], { account: newAccount() });
    const closedBefore = or.closedEarly, chatBefore = or.chat, settlesBefore = fac.of("/settle").length;
    const t0 = Date.now();
    const r = await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: { "x-forwarded-for": "192.0.2.201", "payment-signature": stalled.header } });
    const took = Date.now() - t0;
    await wait(300);
    ok(r.status === 504 && took < 5500 && /not charged|nothing was charged/i.test(r.text) && fac.of("/settle").length === settlesBefore, `a stalled upstream: the gate answers 504 at its deadline, not settled (${r.status} after ${took} ms)`);
    ok(or.chat === chatBefore + 1 && or.closedEarly === closedBefore + 1 && or.closedAfterMs.at(-1) <= 4500, `and the upstream call itself was aborted at the deadline, not left running (${or.closedEarly - closedBefore} cut off after ${or.closedAfterMs.at(-1)} ms)`);
    const again = await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: { "x-forwarded-for": "192.0.2.201", "payment-signature": stalled.header } });
    ok(again.status === 409 && or.chat === chatBefore + 1, `the authorization is spent: the same payment starts no second upstream call (${again.status})`);
    or.delayMs = 0;
  }

  // Refused referral payers neither feed nor meet the direct routes' settle breaker.
  let laneAcc = null, lanePayer = null;
  {
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "invalid_payment" } });
    const q = await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: xff() });
    const acc = q.json.accepts[0];
    const payers = Array.from({ length: 13 }, () => newAccount());
    const statuses = [];
    for (const [i, acct] of payers.entries()) {
      // Three runs for the first payer, one for the rest, each from an address of its own.
      for (let k = 0; k < (i === 0 ? 3 : 1); k++) statuses.push((await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: { "x-forwarded-for": `198.18.${i}.${k + 1}`, "payment-signature": (await signPayment(acc, { account: acct })).header } })).status);
    }
    fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx()), network: REFERRAL_NETWORK } });
    const statusAfter = await call(`${srv.url}/api/gateway-status`, { method: "GET" });
    ok(statuses.every((s) => s === 402) && statuses.length === 15, `13 payers whose referral settle is refused are each answered 402 (${[...new Set(statuses)].join(",")})`);
    const word = (o, k) => JSON.stringify(o.json?.[k] ?? null);
    ok(word(statusAfter, "settleFailures") === word(statusBefore, "settleFailures") && !/burst/.test(word(statusAfter, "settleFailures")) && /ok/.test(word(statusBefore, "settleFailures")) && word(statusAfter, "buyerRefusals") === word(statusBefore, "buyerRefusals") && word(statusAfter, "toolFailures") === word(statusBefore, "toolFailures") && word(statusAfter, "unsettledReports") === word(statusBefore, "unsettledReports") && !/referral/i.test(JSON.stringify({ ...statusAfter.json, referralSettlement: undefined })), `the public status words did not move (settleFailures ${word(statusBefore, "settleFailures")} -> ${word(statusAfter, "settleFailures")}), and none names the gate`);
    laneAcc = acc; lanePayer = payers[0];
  }

  // No public surface changed or names the gate.
  {
    await wait(300);
    const after = await snapshot();
    // /api/gateway-status carries the gate's one word, referralSettlement {status}, and nothing else of it.
    const textOf = (p) => (p === "/api/gateway-status" ? JSON.stringify({ ...after[p].json, referralSettlement: undefined }) : after[p].text);
    const gw = after["/api/gateway-status"].json?.referralSettlement;
    ok(gw && JSON.stringify(Object.keys(gw)) === JSON.stringify(["status"]) && ["ok", "attention"].includes(gw.status), `/api/gateway-status publishes the gate's one word and nothing else of it (${JSON.stringify(gw)})`);
    const named = SURFACES.filter((s) => /\/ref\/|referral/i.test(textOf(s)) || textOf(s).toLowerCase().includes(PAY_TO.toLowerCase()));
    ok(named.length === 0, `no public surface mentions /ref, the gate or its pay-to address (${SURFACES.length} read${named.length ? `; named on ${named.join(", ")}` : ""})`);
    const unread = SURFACES.filter((s) => after[s].status !== 200 && after[s].status !== before[s].status);
    ok(unread.length === 0 && SURFACES.filter((s) => after[s].status === 200).length >= 20, `every surface answers as before (${SURFACES.filter((s) => after[s].status === 200).length} of ${SURFACES.length} answer 200)`);
    // The ledger- and counter-backed surfaces read exactly as before the referral sales (dates aside).
    const norm = (t) => String(t).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "T").replace(/\b1[6-9]\d{11}\b/g, "N").replace(/"processUptimeSeconds":\d+/g, '"processUptimeSeconds":0');
    const LEDGER = ["/api/sales", "/api/stats", "/api/revenue/daily", "/api/calls/daily", "/api/revenue/mpp", "/api/revenue/tempo-daily", "/api/revenue/decide", "/api/proof", "/api/scorecard"];
    const moved = LEDGER.filter((s2) => before[s2].status === 200 && norm(after[s2].text) !== norm(before[s2].text));
    ok(moved.length === 0 && LEDGER.filter((s2) => before[s2].status === 200).length >= 6, `after ${fac.of("/settle").length} referral settles (${fac.of("/settle").filter((c) => c.json).length} runs) the sales, stats, revenue, calls, proof and scorecard surfaces read exactly as before (${LEDGER.filter((s2) => before[s2].status === 200).length} compared${moved.length ? `; moved: ${moved.map((m) => { const x = norm(before[m].text), y = norm(after[m].text); let d = 0; while (d < x.length && x[d] === y[d]) d++; return `${m} at ${d}: ${x.slice(Math.max(0, d - 60), d + 60)} -> ${y.slice(Math.max(0, d - 60), d + 60)}`; }).join(" | ")}` : ""})`);
    const opSales = await call(`${srv.url}/__operator/sales.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } });
    ok(opSales.status === 200 && !/referral/.test(opSales.text), "the operator's sales summary does not count it as a sale either (the gate's own view does)");
  }
  {
    const acc = laneAcc, payers = [lanePayer];
    // The same wallet's direct call is served: the direct breaker holds nothing against it.
    const d = baseAmountOf(await call(`${srv.url}/v1/auto/chat/completions`, { body: chatBody(), headers: xff() }));
    const directPay = await signPayment({ ...d.accept }, { account: payers[0], to: d.accept.payTo, value: d.accept.amount, primaryType: "TransferWithAuthorization", validBefore: String(Math.floor(Date.now() / 1000) + 300) });
    const directCall = await call(`${srv.url}/v1/auto/chat/completions`, { body: chatBody(), headers: { "x-forwarded-for": "198.18.0.1", "payment-signature": directPay.header } });
    ok(directCall.status === 200 && direct.settle >= 1, `the wallet with three refused referral runs is served on the direct route (${directCall.status} ${directCall.text.slice(0, 80)})`);
    // In the referral lane that wallet is at its bound.
    const lane = await call(`${srv.url}/ref/v1-chat-auto`, { body: chatBody(), headers: { "x-forwarded-for": "198.18.99.1", "payment-signature": (await signPayment(acc, { account: payers[0] })).header } });
    ok(lane.status === 429 && lane.json?.errorReason === "too_many_unsettled_runs", `and is held by the referral route's own bound (${lane.status} ${lane.json?.errorReason})`);
  }
  {
    // An answer over 1 KB through the app's REAL middleware stack, under each
    // encoding a client may ask for: delivered whole, uncompressed, every time.
    const bodyL = { messages: [{ role: "user", content: "a long answer please" }], max_tokens: 5 };
    const accL = (await call(`${srv.url}/ref/v1-chat`, { body: bodyL, headers: xff() })).json?.accepts?.[0];
    const seenL = [];
    for (const enc of ["identity", "gzip", "br"]) {
      const payL = await signPayment(accL, { account: newAccount() });
      const t0 = Date.now();
      let out;
      try {
        const r = await fetch(`${srv.url}/ref/v1-chat`, { method: "POST", headers: { "content-type": "application/json", ...xff(), "payment-signature": payL.header, "accept-encoding": enc }, body: JSON.stringify(bodyL), signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        let j = null; try { j = JSON.parse(text); } catch { /* asserted below */ }
        out = { enc, status: r.status, bytes: text.length, encoding: r.headers.get("content-encoding"), whole: Number(r.headers.get("content-length")) === Buffer.byteLength(text) && /^0x[0-9a-f]{64}$/.test(j?.transaction || "") && String(j?.choices?.[0]?.message?.content || "").length >= 4000, ms: Date.now() - t0 };
      } catch (e) { out = { enc, status: `no answer (${e?.name})`, ms: Date.now() - t0 }; }
      seenL.push(out);
    }
    await wait(300);
    const opL = (await call(`${srv.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json;
    ok(seenL.every((o) => o.status === 200 && o.bytes > 4000 && o.encoding === null && o.whole === true) && opL.sinceBoot.partlyServed === 0 && opL.sinceBoot.sendsEndedIdle === 0 && !opL.open.some((e) => e.partial === true), `an answer over 1 KB is delivered whole through the real middleware stack whatever Accept-Encoding asks: nothing sits between the counted send and the socket (${seenL.map((o) => `${o.enc}: ${o.status} ${o.bytes ?? ""} bytes in ${o.ms} ms`).join("; ")}; partly served ${opL.sinceBoot.partlyServed})`);
    {
      // The contract's rate above the map, on the real server: paid, answered, booked as received, raised at once.
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: 2500n }), network: REFERRAL_NETWORK } });
      const viewOf = async () => (await call(`${srv.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json;
      const v0 = await viewOf();
      const seenR = [];
      for (let i = 0; i < 7; i++) {
        const payR = await signPayment(accL, { account: newAccount() });
        const rr = await call(`${srv.url}/ref/v1-chat`, { body: bodyL, headers: { ...xff(), "payment-signature": payR.header } });
        seenR.push(rr.status);
      }
      await wait(300);
      const v1 = await viewOf();
      const gsR = await call(`${srv.url}/api/gateway-status`, { method: "GET" });
      const recR = v1.shortNet?.find((x) => x.slug === "v1-chat");
      ok(seenR.every((x) => x === 200) && v1.sinceBoot.settled === v0.sinceBoot.settled + 7 && v1.sinceBoot.unconfirmed === v0.sinceBoot.unconfirmed && v1.sinceBoot.unconfirmedHeld === v0.sinceBoot.unconfirmedHeld && v1.sinceBoot.book["in-doubt"] === v0.sinceBoot.book["in-doubt"] && v1.sinceBoot.book.unconfirmed === v0.sinceBoot.book.unconfirmed && recR?.count === 7 && Number(recR.received) < Number(recR.expectedNow) && v1.status.status === "attention" && v1.status.reasons.some((x) => /^v1-chat: .*expected at least \d+, received \d+/.test(x)) && gsR.json?.referralSettlement?.status === "attention", `on the real server a rate raised on chain before the map knows it charges nobody without an answer: 7 of 7 paid calls answered, none unconfirmed or in doubt, and the public word reads attention at once with the slug and both amounts (${seenR.join(" ")}; ${v1.status.reasons.filter((x) => /^v1-chat/.test(x)).join("; ")})`);
      const clearedR = await call(`${srv.url}/__operator/referral.json`, { body: { action: "clear-short", slug: "v1-chat", note: "test: the map is being corrected" }, headers: { "x-operator-token": TOKEN_OP } });
      const clearNoToken = await call(`${srv.url}/__operator/referral.json`, { body: { action: "clear-short", slug: "v1-chat", note: "no token" } });
      const v2 = await viewOf();
      ok(clearedR.status === 200 && clearedR.json?.ok === true && clearNoToken.status === 404 && !v2.shortNet.some((x) => x.slug === "v1-chat") && v2.resolvedByHand.some((r) => r.outcome === "short-net-cleared"), `the operator route clears a slug's short-net record with a note (404 without the token) (${clearedR.status})`);
      // A model-backed tool of the real catalog stops at ONE sale far under the floor; a tool that is not takes three.
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: 9000n }), network: REFERRAL_NETWORK } });
      const chatM = [], hashM = [];
      const chat0 = or.chat;
      for (let i = 0; i < 3; i++) { const payM = await signPayment(accL, { account: newAccount() }); chatM.push((await call(`${srv.url}/ref/v1-chat`, { body: bodyL, headers: { ...xff(), "payment-signature": payM.header } })).status); }
      const accH2 = (await call(`${srv.url}/ref/hash`, { method: "GET", headers: xff() })).json.accepts[0];
      for (let i = 0; i < 5; i++) { const payM = await signPayment(accH2, { account: newAccount() }); hashM.push((await call(`${srv.url}/ref/hash`, { body: { text: "m" }, headers: { ...xff(), "payment-signature": payM.header } })).status); }
      const v3 = await viewOf();
      ok(chatM.join(" ") === "200 503 503" && or.chat === chat0 + 1 && hashM.join(" ") === "200 200 200 503 503" && v3.status.reasons.some((x) => /^v1-chat: .*new calls on it are held/.test(x)) && Array.isArray(v3.status.noProductId) && v3.status.noProductId.includes("v1-chat"), `on the real catalog a model-backed tool stops after ONE sale far under the floor (one model call run), a tool that is not after three; the operator's word lists the slugs with no product id (${chatM.join(" ")} | ${hashM.join(" ")})`);
      for (const slug of ["v1-chat", "hash"]) await call(`${srv.url}/__operator/referral.json`, { body: { action: "clear-short", slug, note: "test cleanup" }, headers: { "x-operator-token": TOKEN_OP } });
      fac.reset();
      // THE SERVER'S OWN WIRING of the model floor (the gateway's margin, src/tools/llm-gateway-kit.js): a model-backed
      // tool that brings 60% of its price stops after one sale; without that floor the half-of-expected rule would let it run.
      fac.mode.settle = (c) => ({ status: 200, body: { success: true, transaction: fac.land(c.json.paymentPayload.payload.authorization, fac.nextTx(), "paid", { bps: 4000n }), network: REFERRAL_NETWORK } });
      const accPro = (await call(`${srv.url}/ref/v1-chat-pro`, { body: bodyL, headers: xff() })).json.accepts[0];
      const proM = [];
      for (let i = 0; i < 3; i++) { const payM = await signPayment(accPro, { account: newAccount() }); proM.push((await call(`${srv.url}/ref/v1-chat-pro`, { body: bodyL, headers: { ...xff(), "payment-signature": payM.header } })).status); }
      ok(proM.join(" ") === "200 503 503", `the server passes the gateway's margin as the model floor: a model-backed tool at an on-chain rate of 40% stops after one sale (${proM.join(" ")})`);
      await call(`${srv.url}/__operator/referral.json`, { body: { action: "clear-short", slug: "v1-chat-pro", note: "test cleanup" }, headers: { "x-operator-token": TOKEN_OP } });
      fac.reset();
      // THE SERVER'S OWN WIRING of "a paid sale on the books": a sale on this gate's rail makes its payer a returning
      // buyer. A cold model-backed slug's one place is taken by a slow call; a new payer waits, the returning one is served.
      const returningR = newAccount();
      const firstR = await call(`${srv.url}/ref/hash`, { body: { text: "returning" }, headers: { ...xff(), "payment-signature": (await signPayment(accH2, { account: returningR })).header } });
      await wait(200);
      or.delayMs = 1500;
      const slowR = call(`${srv.url}/ref/v1-chat-pro`, { body: bodyL, headers: { ...xff(), "payment-signature": (await signPayment(accPro, { account: newAccount() })).header } });
      await wait(400);
      const strangerR = await call(`${srv.url}/ref/v1-chat-pro`, { body: bodyL, headers: { ...xff(), "payment-signature": (await signPayment(accPro, { account: newAccount() })).header } });
      const backR = await call(`${srv.url}/ref/v1-chat-pro`, { body: bodyL, headers: { ...xff(), "payment-signature": (await signPayment(accPro, { account: returningR })).header } });
      const slowDone = await slowR;
      or.delayMs = 0;
      ok(firstR.status === 200 && slowDone.status === 200 && strangerR.status === 503 && strangerR.json?.errorReason === "rate_under_review" && backR.status === 200, `the server counts a sale on this gate's own rail as a paid sale: on a cold model-backed slug whose place is taken, a new payer waits and the returning buyer is served (${strangerR.status}, returning ${backR.status})`);
    }
    const reopenNone = await call(`${srv.url}/__operator/referral.json`, { body: { action: "reopen", key: "referral:" + "0".repeat(64), note: "no such record" }, headers: { "x-operator-token": TOKEN_OP } });
    const reopenNoToken = await call(`${srv.url}/__operator/referral.json`, { body: { action: "reopen", key: "referral:" + "0".repeat(64), note: "no such record" } });
    ok(reopenNone.status === 400 && reopenNone.json?.ok === false && reopenNoToken.status === 404, `the operator route's reopen answers 400 for a record that is not there, and 404 without the token (${reopenNone.status}, ${reopenNoToken.status})`);
  }
  const op = await call(`${srv.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } });
  ok(op.status === 200 && op.json?.enabled === true && op.json.sinceBoot?.settled >= 4 && op.json.sinceBoot.timeouts >= 1 && op.json.sinceBoot.screened === 1 && op.json.routes.includes("hash") && Array.isArray(op.json.open) && Array.isArray(op.json.notServed), `the operator view carries the gate's counters, its open settlements and the slugs it does not serve (${JSON.stringify(op.json?.sinceBoot)})`);

  {
    // An operator closes an open settlement by hand (POST on the same route, token-authed, with a note).
    fac.reset();
    fac.mode.settle = () => ({ status: 500, body: {} });
    const accH = (await call(`${srv.url}/ref/hash`, { method: "GET", headers: { "x-forwarded-for": "198.18.77.1" } })).json.accepts[0];
    const pH = await signPayment(accH, { account: newAccount() });
    const stuck = await call(`${srv.url}/ref/hash`, { body: { text: "stuck" }, headers: { "x-forwarded-for": "198.18.77.1", "payment-signature": pH.header } });
    fac.reset();
    const keyH = gateMod.referralReplayKey(pH.authorization);
    const post = (body, headers = { "x-operator-token": TOKEN_OP }) => call(`${srv.url}/__operator/referral.json`, { body, headers });
    const noToken = await post({ action: "resolve", key: keyH, note: "checked by hand" }, {});
    const badAction = await post({ action: "delete-everything" });
    const noNote = await post({ action: "resolve", key: keyH });
    const badOutcome = await post({ action: "resolve", key: keyH, note: "checked on chain", outcome: "refunded" });
    const emptyOutcome = await post({ action: "resolve", key: keyH, note: "checked on chain", outcome: "" });
    const noProof = await post({ action: "resolve", key: keyH, note: "checked on chain", outcome: "refund" });
    const before = (await call(`${srv.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json;
    ok(badOutcome.status === 400 && /refund.*delivered.*dismissed/.test(badOutcome.json?.error || "") && emptyOutcome.status === 400 && noProof.status === 400 && noProof.json?.ok === false && before.open.some((e) => e.key === keyH) && Array.isArray(before.closedUnrecognized), `the operator route takes the three outcomes only, and refund for an entry with no transaction to prove writes nothing and leaves it open (${badOutcome.status}, ${noProof.status} ${noProof.json?.error})`);
    const done = await post({ action: "resolve", key: keyH, note: "checked on chain: never settled", outcome: "dismissed" });
    const after = (await call(`${srv.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json;
    ok(stuck.status === 402 && noToken.status === 404 && badAction.status === 400 && noNote.status === 400 && before.open.some((e) => e.key === keyH) && done.status === 200 && done.json?.ok === true && !after.open.some((e) => e.key === keyH) && after.resolvedByHand.some((r) => r.key === keyH && /never settled/.test(r.note)) && /no-store/.test(done.headers.get("cache-control") || ""), `an operator resolves an open settlement by hand: 404 without the token, a note required, the entry recorded with the note and removed (${noToken.status}, ${badAction.status}, ${noNote.status}, ${done.status})`);
  }

  const logText = srv.log();
  ok(/\[referral\] settled hash payer=0x[0-9a-fA-F]{4} tx=0x[0-9a-f]{64}/.test(logText) && !logText.toLowerCase().includes(KEY_HEX) && !logText.toLowerCase().includes(buyer.address.toLowerCase()), "the server log has the settle line with a shortened payer, and neither the signer key nor a full payer address");
  ok(srv.exited() === null, "the server is still up");
} catch (e) {
  failed++;
  console.error(`FAIL - part 2 threw: ${e?.stack || e}`);
  console.error(srv.log().slice(-2500));
} finally {
  await srv.stop();
  await new Promise((r) => { orStub.closeAllConnections?.(); orStub.close(() => r()); });
  await new Promise((r) => { directFac.closeAllConnections?.(); directFac.close(() => r()); });
}

// --- a kill in the middle of a settle ------------------------------------------------------
{
  fac.reset();
  const stores = { REFERRAL_BOOK_FILE: join(tmp, "kill-book.json"), REFERRAL_ANSWER_DIR: join(tmp, "kill-answers"), SALES_LEDGER_DB: join(tmp, "kill-sales.db") };
  const env = { ...REF_ENV, ...stores, AGENT402_BASE_RPC: `${fac.url}/rpc`, AGENT402_OPERATOR_TOKEN: TOKEN_OP, REFERRAL_DEADLINE_MS: "2000", REFERRAL_SETTLE_RESERVE_MS: "1000", REFERRAL_VERIFY_MS: "1000", REFERRAL_SETTLE_MS: "2000", REFERRAL_SWEEP_MS: "1000" };
  const a = await bootPaidServer({ label: "referral-kill-a", env });
  let b = null;
  try {
    const acc = (await call(`${a.url}/ref/hash`, { method: "GET" })).json.accepts[0];
    const p = await signPayment(acc, { account: newAccount() });
    const tx = "0x" + "9f".repeat(32);
    // The facilitator lands the payment and never answers; the process is killed in that wait.
    fac.mode.settle = () => { fac.land(p.authorization, tx); return { hang: true }; };
    const pending = rawPost(`${a.url}/ref/hash`, { text: "abc" }, { "payment-signature": p.header }, 60_000);
    for (let i = 0; i < 100 && fac.of("/settle").length === 0; i++) await wait(50);
    const intent = JSON.parse(readFileSync(stores.REFERRAL_BOOK_FILE, "utf8"));
    const entry = Object.values(intent.entries || {})[0];
    ok(fac.of("/settle").length === 1 && entry?.state === "intent" && entry.payer === p.authorization.from.toLowerCase() && entry.slug === "hash" && entry.amount === acc.amount && entry.nonce === p.authorization.nonce.toLowerCase() && entry.validBefore === Number(p.authorization.validBefore) && entry.intentAt > 0, `while /settle is in flight the intent is on disk: payer, slug, amount, nonce, validBefore and the time (${JSON.stringify(entry).slice(0, 200)})`);
    a.child.kill("SIGKILL");
    await pending;
    await wait(300);
    b = await bootPaidServer({ label: "referral-kill-b", env });
    let open = null;
    // The sweep leaves the intent to its own request for the settle timeout plus 15 s, then reads the chain.
    for (let i = 0; i < 60; i++) {
      open = (await call(`${b.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json?.open?.[0] || null;
      if (open?.state === "charged-undelivered") break;
      await wait(500);
    }
    ok(open?.state === "charged-undelivered" && open.tx === tx && open.saleBooked === true && /CHARGED-BUT-NOT-SERVED: a settlement left open landed on chain \(hash .*sale booked/.test(b.log()), `after the restart the sweep reads the open intent against the chain, books the sale and keeps the case (${JSON.stringify(open).slice(0, 220)})`);
    const again = await call(`${b.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200 && again.json?.hex === createHash("sha256").update("abc").digest("hex") && again.json.transaction === tx, `the charged buyer's re-send to the new process returns the answer stored with the open entry, with its transaction: nothing runs a second time (${again.status} ${again.text.slice(0, 90)})`);
    await wait(200);
    const closed = (await call(`${b.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } })).json;
    ok(closed?.open?.length === 0 && closed.sinceBoot?.restoredAnswers === 1, "and the delivered entry is closed");
    const sales2 = await call(`${b.url}/api/sales`, { method: "GET" });
    ok(sales2.status === 200 && !/referral/.test(sales2.text), "and the sale the sweep booked is on no public surface");
  } catch (e) {
    failed++;
    console.error(`FAIL - the kill test threw: ${e?.stack || e}`);
    console.error((b || a).log().slice(-1500));
  } finally {
    await a.stop().catch(() => {});
    if (b) await b.stop();
  }
}
}

await fac.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
