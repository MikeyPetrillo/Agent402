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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
  function land(auth, tx = null, kind = "paid", { block = chainState.head, payTo = auth.to } = {}) {
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
    const net = gross - (gross * 1234n) / 10000n;
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
    settle: (call) => ({ status: 200, body: { success: true, transaction: land(call.json.paymentPayload.payload.authorization, nextTx()), network: REFERRAL_NETWORK } }),
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
  REFERRAL_SLUGS: "echo, slow,boom,bytes,list,owntx,chat,busy,budgeted,breaker,exa,chatx,scopes,big", REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
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
    payerHasPaid: (payer) => paidPayers.has(payer),
    oweRefund: async (row) => { owed.push(row); return true; },
    settler: createReferralSettler({ facilitatorUrl: config.facilitatorUrl, signerKey: config.signerKey, verifyTimeoutMs: config.verifyMs, settleTimeoutMs: config.settleMs, signVerify: config.verifySigned }),
    chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, publicLanes: [], merchantId: MERCHANT_ID, payoutAddress: PAYOUT, headMaxAgeMs: 0, tries: 2, budgetMs: 1200, pauseMs: 100, timeoutMs: 500 }),
    priceUsdOf, priceForNetwork,
    preValidate: (def, req) => (def.slug === "echo" && req.body && req.body.require ? { status: 400, body: { error: "Missing required parameter: text", tool: def.slug, howToCall: { method: "POST", url: "https://shop.example/api/echo" }, example: { see: "POST /api/echo" } } } : null),
    prePaymentRefusal: (def, input) => (def.slug === "chat" && input && input.model === "no-such-model" ? { status: 400, body: { error: { message: `unknown model${routeHint("; GET /v1/models lists them")}`, code: "unknown_model" }, tool: def.slug } } : null),
    sendToolError: (res, err, slug) => res.status(err?.statusCode || 502).json({ error: String(err?.message || "request failed"), tool: slug }),
    recordSale: (row) => { sales.push(row); return ledger.recordSale(row); },
    saleBooked: (tx) => !!ledger.privateRailSaleByTx(tx, "referral"),
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
    ok(prove(pair("paid"), { merchantId: "7" }) === "unpaid" && prove(pair("paid"), { payoutAddress: OUR_WALLET }) === "unknown" && prove(pair("paid"), { merchantId: null }) === "unknown" && prove(pair("paid"), { minNet: "26299" }) === "unknown" && prove(pair("paid"), { minNet: null }) === "unknown" && prove(pair("paid"), { minNet: "26298" }) === "paid", "another merchant id configured reads not ours; another payout wallet, no merchant id, a merchant amount under the expected net or no expected net at all reads unknown");
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
      ok(prove(whole) === "paid" && prove(whole, { minNet: null }) === "unknown", "the hand-built whole receipt is paid, and only with the expected net to check its payout against");
      ok(prove(payoutFromElsewhere, noFloor) === "unknown", `a transfer to our payout wallet that does not come FROM the split contract is not its payout (${prove(payoutFromElsewhere, noFloor)})`);
      ok(prove(payoutOfAnotherAmount, noFloor) === "unknown", `a payout that is not exactly the merchant amount the event states is not its payout (${prove(payoutOfAnotherAmount, noFloor)})`);
      ok(prove(eventFromElsewhere, noFloor) === "unknown", `a routed event emitted by another address than the split contract is not read (${prove(eventFromElsewhere, noFloor)})`);
      // Two authorizations of one buyer for one amount in one transaction: only the second is routed.
      const a2 = { from: a1.from, to: PAY_TO, value: "30000", nonce: freshNonce() };
      const two = rc([...pairOf(a1), ...pairOf(a2), fac.transferLog(PAY_TO, PAYOUT, net, 0, 1), evOurs()]);
      ok(prove(two, noFloor) === "unknown" && prove(two, { ...noFloor, nonce: a2.nonce }) === "paid", `what the contract did with an authorization is read only up to the NEXT authorization: the routing after a later one does not prove an earlier one (${prove(two, noFloor)}, ${prove(two, { ...noFloor, nonce: a2.nonce })})`);
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
    const p1 = await signPayment(accept, { account: newAccount() });
    const k1 = gateMod.referralReplayKey(p1.authorization);
    const u = await send(R("echo"), { body: { text: "unconfirmed" }, headers: { "payment-signature": p1.header, "x-test-ip": ip } });
    await wait(50);
    ok(u.status === 200 && u.json?.transaction === "0x" + "f1".repeat(32) && sales.length === 1 && app1.book.get(k1)?.state === "unconfirmed" && app1.gate.stats().unconfirmed >= 1, `a success whose receipt cannot be read yet is delivered and booked, and kept as unconfirmed (${u.status}, ${app1.book.get(k1)?.state})`);
    // The sweep reads it later: a receipt for another transaction CONTRADICTS it.
    fac.receipts.set("0x" + "f1".repeat(32), { transactionHash: "0x" + "f2".repeat(32), status: "0x1", to: PAY_TO, logs: [] });
    await app1.gate.sweepOnce();
    ok(app1.book.get(k1)?.state === "contradicted" && app1.gate.statusWord().status === "attention" && logLines.some((l) => /CONTRADICTS/.test(l)), `the sweep flags it as contradicted and the word reads attention (${app1.book.get(k1)?.state})`);
    // THE HOLD (route): that answer went out on a success the chain denies, so no
    // settle can be trusted: a NEW payment by anyone is refused before anything runs.
    const settlesFine = (call) => ({ status: 200, body: { success: true, transaction: fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx()), network: REFERRAL_NETWORK } });
    const keyOfPayment = (p) => gateMod.referralReplayKey(p.authorization);
    {
      fac.mode.settle = settlesFine;
      const at = { runs: runs.echo, verifies: verifies(), settles: settles(), sales: sales.length, held: app1.gate.stats().bookFaultHeld };
      const stranger = await signPayment(accept, { account: newAccount() });
      const refused = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": stranger.header, "x-test-ip": freshIp() } });
      const probe = await send(R("echo"), { body: { text: "probe" } });
      ok(app1.book.get(k1)?.scope === "route" && refused.status === 503 && refused.json?.errorReason === "settlement_under_review" && refused.json.retryable === true && refused.headers.get("retry-after") === "300" && /Nothing ran and nothing was charged/.test(refused.json.errorMessage || ""), `while a contradicted entry says an answer went out against the chain, a new payment is answered 503 (${refused.status} ${refused.json?.errorReason}, scope ${app1.book.get(k1)?.scope})`);
      ok(runs.echo === at.runs && verifies() === at.verifies && settles() === at.settles && sales.length === at.sales && app1.book.get(keyOfPayment(stranger)) === null && app1.gate.stats().bookFaultHeld === at.held + 1, `and nothing ran, nothing was sent to the facilitator, nothing was booked or recorded for it (${runs.echo - at.runs} runs, ${verifies() - at.verifies} verifies, ${settles() - at.settles} settles)`);
      ok(probe.status === 402 && Array.isArray(probe.json?.accepts) && app1.gate.statusWord().status === "attention", `the unpaid 402 is still quoted, and the word reads attention (${probe.status})`);
      const cleared = await app1.gate.resolveByHand(k1, { note: "the answer went out; the receipt named is another transaction's", outcome: "dismissed" });
      const served = await send(R("echo"), { body: { text: "held" }, headers: { "payment-signature": stranger.header, "x-test-ip": freshIp() } });
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
      // THE HOLD (route): the buyer's transfer reached the split contract and was routed to ANOTHER merchant.
      fac.mode.settle = (call) => ({ status: 200, body: { success: true, transaction: fac.land(call.json.paymentPayload.payload.authorization, fac.nextTx(), "othermerchant") } });
      const p4 = await signPayment(accept, { account: newAccount() });
      const k4 = keyOfPayment(p4);
      const misrouted = await send(R("echo"), { body: { text: "misrouted" }, headers: { "payment-signature": p4.header, "x-test-ip": freshIp() } });
      fac.mode.settle = settlesFine;
      const ranBefore = runs.echo;
      const next = await signPayment(accept, { account: newAccount() });
      const refused = await send(R("echo"), { body: { text: "next" }, headers: { "payment-signature": next.header, "x-test-ip": freshIp() } });
      ok(misrouted.status === 402 && !("echo" in (misrouted.json || {})) && app1.book.get(k4)?.state === "contradicted" && app1.book.get(k4).scope === "route" && refused.status === 503 && refused.json?.errorReason === "settlement_under_review" && runs.echo === ranBefore, `a success whose transaction moved the buyer's money and routed it to another merchant holds the whole route: the next buyer would be charged the same way (${misrouted.status} ${misrouted.json?.errorReason}; scope ${app1.book.get(k4)?.scope}; next ${refused.status})`);
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
    ok(r2.status === 402 && r2.json?.errorReason === "settle_outcome_unknown" && app1.book.get(ku)?.state === "in-doubt" && sales.length === 0 && owed.length === 0 && word.status === "attention", `a payment into the split contract with no routing this server recognizes is UNKNOWN: held in the book past its expiry, not delivered, not booked, not closed, the word at attention (${r2.status}, ${app1.book.get(ku)?.state}, ${word.status})`);
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
    ok(gateMod.refundRowCovers({ evidence: txg2, payer: g2.authorization.from.toUpperCase().replace("0X", "0x"), wire: "referral" }, rows[0]) === true && gateMod.refundRowCovers({ evidence: txg2, payer: "0x" + "9".repeat(40), wire: "referral" }, rows[0]) === false && gateMod.refundRowCovers({ evidence: txg2, payer: g2.authorization.from, wire: "evm" }, rows[0]) === false && gateMod.refundRowCovers(null, rows[0]) === false, "a refund row already on the books covers this debt only for the same transaction AND payer on this wire");
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
      ok(r.status === 409 && r.json?.errorReason === "answer_unavailable_refund_owed" && /owed back/.test(r.json.errorMessage) && runs.echo === ran, `an authorization whose answer was lost and is owed back runs no second time, and says so (${r.status} ${r.json?.errorReason})`);
    } finally { await app4.close(); }
  }
  fac.reset(); sales.length = 0;

  // --- a bounded number of paid calls in flight ------------------------------------------
  {
    const app5 = await mount({ REFERRAL_MAX_INFLIGHT: "2" });
    try {
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
    for (let i = 0; i < 30; i++) await send(R("echo"), { body: { text: "f" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    const printed = logLines.filter((l) => /verify refused/.test(l)).length - before;
    ok(printed > 0 && printed <= 20, `30 refused payments print at most 20 refusal lines a minute (${printed})`);
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
      "a higher minimum net": [tampered(() => {}, { minNet: "901" }), "unknown"],
      "no minimum net": [tampered(() => {}, { minNet: null }), "unknown"],
      "a lower net in the event and the payout": [tampered((r) => { setWord(r.logs[6], 8, w32(899)); r.logs[5].data = `0x${w32(899)}`; }), "unknown"],
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
    ok(wrong.length === 0 && Object.keys(cases).length === 23, `every single-field tamper of the real receipt is refused: never paid (${wrong.map(([k, [got, want]]) => `${k}: ${got}, want ${want}`).join("; ") || "23 tampers"})`);
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
  // A spent authorization whose transaction is found and is NOT a payment of ours: an end
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
        return { key, tx: fac.land(p.authorization, null, kind) };
      };
      const stuck = await open(-600, "noevent");   // expired; the money sits in the contract, no event
      const live = await open(600, "noevent");     // the same, still sendable
      const dark = await open(-600, "noevent");    // the same, its receipt unreadable
      const ours = await open(-600, "paid");       // a receipt that IS ours
      fac.receipts.delete(dark.tx);
      ok(appU.config.unrecognizedReads === 3 && referralConfig(ENV).unrecognizedReads === 5 && referralConfig({ ...ENV, REFERRAL_UNRECOGNIZED_READS: "0" }).unrecognizedReads === 5, "REFERRAL_UNRECOGNIZED_READS is read (default 5; a malformed one reads as the default)");
      const passes = [];
      for (let i = 0; i < 2; i++) { passes.push(await appU.gate.sweepOnce()); }
      const mid = { stuck: bookU.get(stuck.key), closed: closedU().length };
      ok(mid.stuck?.state === "in-doubt" && mid.stuck.unrecognizedReads === 2 && mid.stuck.seenTx === stuck.tx && mid.closed === 0, `a spent authorization whose transaction was found, with a receipt read in full that the rule does not recognize, stays open while it has been read fewer than the bound (${mid.stuck?.state}, ${mid.stuck?.unrecognizedReads} readings)`);
      passes.push(await appU.gate.sweepOnce());
      await quietLedger();
      const record = closedU().find((r) => r.key === stuck.key);
      ok(bookU.get(stuck.key) === null && record && record.tx === stuck.tx && record.reads === 3 && /no routed event/.test(record.why) && record.slug === "echo" && passes[2].unrecognized === 1 && appU.gate.stats().unrecognizedClosed === 1 && logLines.some((l) => l.includes(stuck.tx) && /closed to the operator record, nothing booked, no refund written/.test(l)), `at the bound, with the authorization no longer sendable, it is closed to the operator record with its transaction and an error line (${JSON.stringify(record)})`);
      ok(!sales.some((x) => x.tx === stuck.tx) && !owed.some((o) => o.tx === stuck.tx), "no sale is booked and no refund is written for it");
      ok(bookU.get(live.key)?.state === "in-doubt" && bookU.get(live.key).unrecognizedReads === 3 && bookU.get(dark.key)?.state === "in-doubt" && !bookU.get(dark.key).unrecognizedReads && closedU().length === 1, `one whose authorization can still be sent is not closed whatever the count, and a receipt that cannot be READ is never counted (${bookU.get(live.key)?.unrecognizedReads} readings live, ${bookU.get(dark.key)?.unrecognizedReads ?? 0} dark)`);
      ok(sales.filter((x) => x.tx === ours.tx).length === 1 && !closedU().some((r) => r.key === ours.key) && owed.filter((o) => o.tx === ours.tx).length === 1, `a receipt that IS ours is booked the first time it is read and never closed this way: it took the paid path (its answer was never stored, so the gross is owed back) (${sales.filter((x) => x.tx === ours.tx).length} sale, ${owed.filter((o) => o.tx === ours.tx).length} debt)`);
      const word = appU.gate.statusWord();
      skew.ms = 25 * 3600_000;
      const nextDay = appU.gate.statusWord();
      skew.ms = 0;
      ok(word.status === "attention" && word.reasons.some((x) => /not recognized was closed/.test(x)) && !nextDay.reasons.some((x) => /not recognized was closed/.test(x)), `the word reads attention for it for a day (${word.reasons.join("; ")})`);
      // Once the live one can no longer be sent, it ends the same way.
      skew.ms = 20 * 60_000;
      await appU.gate.sweepOnce();
      skew.ms = 0;
      ok(bookU.get(live.key) === null && closedU().some((r) => r.key === live.key && r.tx === live.tx) && !sales.some((x) => x.tx === live.tx) && !owed.some((o) => o.tx === live.tx), "and the still-sendable one is closed the same way once its authorization has expired");
    } finally { skew.ms = 0; await appU.close(); }
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
  // ===========================================================================
  fac.reset(); sales.length = 0; owed.length = 0;
  {
    const store = createReferralAnswerStore({ now: () => Date.now() + skew.ms });
    const appD = await mount({}, { answers: store });
    const { isRepeatHangup } = await import("./refund-run.js");
    const BIG = 7_500_000;
    // The counts and the three endings, on a scripted response: pieces 1 and 2 are taken, piece 3 fails.
    {
      const { sendCounted, sentOutcome } = gateMod;
      const fake = (failAt) => { const r = { destroyed: false, parts: [], ended: 0, write(part, cb) { this.parts.push(part.length); if (this.parts.length === failAt) { this.destroyed = true; cb(new Error("reset")); } else cb(); return true; }, end() { this.ended++; } }; return r; };
      const body = Buffer.alloc(2500, 0x61);
      const all = fake(0), cut = fake(3), dead = fake(0);
      dead.destroyed = true;
      const [sAll, sCut, sDead] = [sendCounted(all, body, 1000), sendCounted(cut, body, 1000), sendCounted(dead, body, 1000)];
      ok(JSON.stringify(all.parts) === "[1000,1000,500]" && all.ended === 1 && sAll.taken === 2500 && sAll.dispatched === 2500 && sentOutcome(sAll) === "delivered", `every piece confirmed: the pieces add up to the body, the response is ended once, and the send reads delivered (${JSON.stringify(sAll)})`);
      ok(JSON.stringify(cut.parts) === "[1000,1000,500]" && cut.ended === 0 && sCut.taken === 2000 && sCut.dispatched === 2500 && sentOutcome(sCut) === "partial", `a piece whose write fails is handed over but never counted as taken, nothing follows it, and the send reads partial (${JSON.stringify(sCut)})`);
      ok(dead.parts.length === 0 && sDead.dispatched === 0 && sentOutcome(sDead) === "not-served" && sentOutcome({ total: 10, dispatched: 10, taken: 0 }) === "partial" && sentOutcome({ total: 10, dispatched: 0, taken: 0 }) === "not-served" && sentOutcome({ total: 10, dispatched: 10, taken: 10 }) === "delivered", "nothing handed to a closed connection reads not served; a first piece in flight and unconfirmed reads partial, never not served");
    }
    try {
      const pay = async () => { const p = await signPayment(accept, { account: newAccount(), validBefore: String(Math.floor(Date.now() / 1000) + 600) }); return { p, key: gateMod.referralReplayKey(p.authorization) }; };
      const sending = (key) => async () => { for (let i = 0; i < 200 && appD.book.get(key)?.delivered !== true; i++) await wait(25); await wait(400); };
      // Several chunks, read to the end: delivered whole, and the entry closes.
      const whole = await pay();
      const full = await send(`${appD.url}/ref/big`, { body: { n: 300_000 }, headers: { "payment-signature": whole.p.header, "x-test-ip": freshIp() } });
      await wait(50);
      ok(gateMod.REFERRAL_SEND_CHUNK_BYTES === 16384 && full.status === 200 && full.json?.blob?.length === 300_000 && /^0x[0-9a-f]{64}$/.test(full.json.transaction || "") && Number(full.headers.get("content-length")) === Buffer.byteLength(full.text) && /^application\/json/.test(full.headers.get("content-type") || "") && appD.book.get(whole.key) === null && appD.gate.stats().partlyServed === 0, `an answer of several chunks read to the end arrives whole (its length stated), and is delivered (${full.status}, ${full.json?.blob?.length} characters)`);
      // A client that reads NOTHING of a large answer and resets: some bytes left this process, none were read.
      const none = await pay();
      const r0 = await rawPaid(`${appD.url}/ref/big`, { n: BIG }, { "payment-signature": none.p.header, "x-test-ip": freshIp() }, { readBytes: 0, when: sending(none.key) });
      await wait(300);
      const e0 = appD.book.get(none.key);
      ok(r0.got === 0 && e0?.state === "charged-undelivered" && e0.delivered === false && e0.partial === true && e0.partialSent > 0 && e0.partialSent < e0.partialOf && e0.partialOf > BIG && e0.hangup === gateMod.REFERRAL_PARTIAL_HOLD_REASON && appD.gate.stats().partlyServed === 1 && sales.length === 2, `a large answer cut off after some bytes left this process is PARTLY SERVED: not delivered, not closed, marked partial with the byte counts (${e0?.state}, delivered ${e0?.delivered}, ${e0?.partialSent} of ${e0?.partialOf} bytes out, the client read ${r0.got})`);
      // A client that reads a megabyte and resets: the same, and its re-send then gets the whole answer.
      const some = await pay();
      const r1 = await rawPaid(`${appD.url}/ref/big`, { n: BIG }, { "payment-signature": some.p.header, "x-test-ip": freshIp() }, { readBytes: 1_000_000 });
      await wait(300);
      const e1 = appD.book.get(some.key);
      ok(r1.got >= 900_000 && e1?.state === "charged-undelivered" && e1.partial === true && e1.partialSent >= r1.got && e1.partialSent < e1.partialOf && e1.delivered === false, `a buyer who read a megabyte of the answer and reset is partly served, never "not served", and the bytes recorded are no fewer than it read (at most ${e1?.partialSent} of ${e1?.partialOf} bytes out, the client read ${r1.got})`);
      const runsBig = settles();
      const fetched = await send(`${appD.url}/ref/big`, { body: { n: BIG }, headers: { "payment-signature": some.p.header, "x-test-ip": freshIp() } });
      await wait(100);
      ok(fetched.status === 200 && fetched.json?.blob?.length === BIG && settles() === runsBig && appD.book.get(some.key) === null, `the kept answer is still there for a re-send of the same payment, which delivers it whole and closes the entry (${fetched.status}, ${fetched.json?.blob?.length})`);
      // Never re-sent: the debt is written at the gross, and HELD for review.
      skew.ms = 11 * 60_000;
      await appD.gate.sweepOnce();
      await appD.gate.sweepOnce();
      skew.ms = 0;
      const rows = owed.filter((o) => o.tx === e0?.tx);
      ok(rows.length === 1 && rows[0].priceUsd === 0.03 && rows[0].httpStatus === 499 && rows[0].hangupReason === "payer budget" && isRepeatHangup(rows[0]) === true && /partly sent \(at most \d+ of \d+ bytes\)/.test(rows[0].note) && !owed.some((o) => o.tx === e1?.tx), `a partly served answer that is never collected is owed once at the gross with the reason the refund run HOLDS (never repaid on its own), its byte counts in the note; the one collected by a re-send is owed nothing (${rows.length} row: ${rows[0]?.httpStatus} ${rows[0]?.hangupReason}; ${rows[0]?.note})`);
    } finally { skew.ms = 0; await appD.close(); }
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
    ok(last.json?.hint && !/published at/.test(last.json.hint) && !/openapi|well-known|api\/pricing/.test(last.json.hint) && /settled a paid call in the last \d+ minutes reads against/.test(last.json.hint), `and its text claims no discovery listing and states the allowance a settled call earns (${String(last.json?.hint).slice(0, 200)})`);
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
        res.end(JSON.stringify({ id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: parsed.model || "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.000001 } }));
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
const srv = await bootPaidServer({
  label: "referral-on",
  args: ["--import", "./scripts/lib/openrouter-stub-preload.js", "--import", "./scripts/lib/hang-fetch-preload.js"],
  env: {
    ...REF_ENV, ...COSTS,
    WALLET_ADDRESS: OUR_WALLET, TRUST_PROXY_HOPS: "1",
    FACILITATOR_URL: `http://127.0.0.1:${directFac.address().port}`, AGENT402_BASE_RPC: `${fac.url}/rpc`,
    REFERRAL_SLUGS: "hash,mime,v1-chat-metered,v1-chat,v1-chat-auto,v1-chat-pro,v1-chat-premium,onchain-sql,perp-funding,perp-basis,stablecoin-peg,edgar-company-facts,image-gen,image-gen-premium,attest,qr,no-such-tool",
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
  const SERVED = ["hash", "mime", "onchain-sql", "perp-funding", "perp-basis", "stablecoin-peg", "edgar-company-facts", "v1-chat-auto", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-chat"];
  ok(servedLine && SERVED.every((x) => served.includes(x)) && served.length === SERVED.length, `the boot serves the eligible slugs (${servedLine ? servedLine[2] : "no line"})`);
  const whyServed = Object.fromEntries([...bootLog.matchAll(/\[referral\] (\S+) is served under \/ref: ([^\n]*)/g)].map((m) => [m[1], m[2]]));
  console.log(`# boot verdicts: ${JSON.stringify(whyServed)}`);
  ok(/no upstream work/.test(whyServed.hash || "") && ["v1-chat-auto", "v1-chat-pro", "v1-chat-premium"].every((x) => /ends at the deadline \(own timeout 90 s\)/.test(whyServed[x] || "")) && ["onchain-sql", "perp-funding", "perp-basis", "stablecoin-peg", "edgar-company-facts"].every((x) => /ends at the deadline \(own timeout 290 s\)/.test(whyServed[x] || "")), "each served slug says why its handler deadline can be kept: no upstream work, or upstream work the deadline ends (with the tool's own timeout named)");
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
    const mimeGet = await call(`${srv.url}/ref/mime`, { method: "GET", headers: xff() });
    const mimePaid = await call(`${srv.url}/ref/mime`, { method: "GET", headers: { ...xff(), "payment-signature": (await signPayment(mimeGet.json.accepts[0])).header } });
    const mimeOwn = await call(`${srv.url}/ref/mime?ext=png`, { method: "GET", headers: { ...xff(), "payment-signature": (await signPayment(mimeGet.json.accepts[0])).header } });
    ok(mimeGet.status === 402 && mimePaid.status === 200 && mimePaid.json?.mime === "image/webp" && mimeOwn.status === 200 && mimeOwn.json?.mime === "image/png", `a GET tool: a paid GET with no query runs the published example (${mimePaid.json?.mime}); one with a query is served as sent (${mimeOwn.json?.mime})`);
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
