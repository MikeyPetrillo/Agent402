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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express from "express";
import { recoverMessageAddress, keccak256, concat, stringToHex, numberToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootPaidServer } from "./lib/paid-boot.js";

const tmp = mkdtempSync(join(tmpdir(), "a402-referral-"));
process.env.SALES_LEDGER_DB = join(tmp, "sales.db");
process.env.HANGUP_FORGIVE_FILE = join(tmp, "hangup.json");
// One forgiven hang-up of the stub tools' price fits a payer's budget; a second does not.
process.env.HANGUP_FORGIVE_KEY_USD = "0.05";
process.env.HANGUP_FORGIVE_GLOBAL_USD = "1";
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const ONLY_PART = process.env.REFERRAL_TEST_PART || "";

const gateMod = await import("../src/referral-gate.js");
const { referralConfig, referralConfigProblem, referralRoutes, referralIneligibility, referralSlugOfPath, isCanonicalReferralPath, createReferralGate, referralNet, baseUnitsOf, checkReferralPayment, parseCommissionBps, commissionBpsFor, isLocalReceiveSignature, createLineSampler, REFERRAL_ASSET, REFERRAL_NETWORK, REFERRAL_REASONS } = gateMod;
const { createReferralSettler, referralRequestDigest } = await import("../src/referral-settle.js");
const { createReferralChainReader } = await import("../src/referral-chain.js");
const { createReferralBook } = await import("../src/referral-book.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { createReplayGuard } = await import("../src/replay-guard.js");
const ledger = await import("../src/sales-ledger.js");
const { PAYING_RAILS, PRIVATE_RAILS } = await import("../src/paid-rails.js");
const { priceForNetwork } = await import("../src/payments.js");
const hangupMod = await import("../src/hangup-forgiveness.js");
const { presentRunWindow, evmCredentialSettleableMs } = await import("../src/evm-validity.js");
const { withBudgetCeiling, underBudget, currentBudget } = await import("../src/upstream-deadline.js");
const { settleBreakerOtherLane, gatewaySettleBreakerCheck } = await import("../src/gateway-settle-breaker.js");

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
const KEY_HEX = SIGNER_KEY.slice(2).toLowerCase();

// --- a stub facilitator and a stub chain ---------------------------------------
// /verify and /settle record every request with the exact bytes received and
// the address its signature recovers to; /rpc answers authorizationState and
// the AuthorizationUsed log from what the test says has landed.
function stubFacilitator() {
  const calls = [];
  let txSeq = 0;
  const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
  const defaults = () => ({ verify: () => ({ status: 200, body: { isValid: true } }), settle: () => ({ status: 200, body: { success: true, transaction: nextTx(), network: REFERRAL_NETWORK } }), settleDelayMs: 0, verifyDelayMs: 0, rpcDown: false });
  const mode = defaults();
  const landed = new Map(); // "from|nonce" -> tx (or null: used, log not found)
  const keyOf = (from, nonce) => `${String(from).toLowerCase()}|${String(nonce).toLowerCase()}`;
  const rpcCalls = [];
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
          result = `0x${(landed.has(keyOf(from, nonce)) ? "1" : "0").padStart(64, "0")}`;
        } else if (j.method === "eth_blockNumber") result = "0x100000";
        else if (j.method === "eth_getLogs") {
          const t = j.params?.[0]?.topics || [];
          const from = `0x${String(t[1] || "").slice(26)}`;
          const tx = landed.get(keyOf(from, t[2]));
          result = tx ? [{ address: REFERRAL_ASSET, transactionHash: tx, topics: t }] : [];
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
        } catch { call.recovered = null; }
      }
      calls.push(call);
      const pick = req.url === "/verify" ? mode.verify : req.url === "/settle" ? mode.settle : null;
      if (!pick) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.url === "/settle" && mode.settleDelayMs) await wait(mode.settleDelayMs);
      if (req.url === "/verify" && mode.verifyDelayMs) await wait(mode.verifyDelayMs);
      const out = await pick(call);
      if (out.hang) return; // never answers
      res.writeHead(out.status, { "content-type": out.type || "application/json" });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, mode, landed, rpcCalls, nextTx,
    of: (path) => calls.filter((c) => c.path === path),
    land: (auth, tx) => landed.set(keyOf(auth.from, auth.nonce), tx),
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

const fac = await stubFacilitator();

// ===============================================================================
// Part 1: the modules, in this process
// ===============================================================================
// Synthetic slugs and round placeholder figures: no real schedule is typed here.
const ENV = {
  REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY,
  REFERRAL_SLUGS: "echo, slow,boom,bytes,list,owntx,chat,busy,budgeted,breaker", REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
  REFERRAL_COMMISSION_BPS: "default:2000,busy:5000", REFERRAL_FEE_BPS: "0",
  REFERRAL_DEADLINE_MS: "1000", REFERRAL_SETTLE_RESERVE_MS: "1000", REFERRAL_SETTLE_MS: "2000", REFERRAL_VERIFY_MS: "1000",
  REFERRAL_UNSETTLED_MAX: "3",
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
  const m = referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta,gamma", REFERRAL_COMMISSION_BPS: "default:2000, alpha:5000,Beta:2500" });
  ok(m && commissionBpsFor(m, "alpha") === 5000 && commissionBpsFor(m, "beta") === 2500 && commissionBpsFor(m, "gamma") === 2000, "the commission map is read per slug, and a slug it does not name reads its default");
  ok(commissionBpsFor(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "4000" }), "alpha") === 4000 && commissionBpsFor(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "default:0" }), "alpha") === 0, "a bare number or default: sets the default");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta", REFERRAL_COMMISSION_BPS: "alpha:5000" }) === null && referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha,beta", REFERRAL_COMMISSION_BPS: "alpha:5000,beta:2500" }) !== null, "a slug the map neither names nor covers with a default leaves the gate off (no built-in rate)");
  ok(parseCommissionBps("") === null && parseCommissionBps(undefined) === null, "an empty commission map is no map");
  for (const bad of ["-5", "default:abc", "alpha:10001", "alpha", "alpha:5,alpha:6", "Bad Slug:5", "default:1000;alpha:5"]) {
    if (referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: bad }) !== null || parseCommissionBps(bad) !== null) ok(false, `a malformed commission map (${bad}) should leave the gate off`);
  }
  ok(true, "a malformed commission map leaves the gate off (never a guessed rate)");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "alpha", REFERRAL_COMMISSION_BPS: "default:2000,alpha:9000", REFERRAL_FEE_BPS: "2000" }) === null, "one slug's commission plus the fee past 10000 bps: off");
}

// --- money arithmetic ----------------------------------------------------------
{
  ok(baseUnitsOf("$0.03") === 30000n && baseUnitsOf("$0.030") === 30000n && baseUnitsOf("$1") === 1000000n && baseUnitsOf("$0.000001") === 1n, "dollars to USDC base units, exact");
  ok(baseUnitsOf("$0.0000001") === null && baseUnitsOf("0.03") === null && baseUnitsOf("$0") === null && baseUnitsOf("$NaN") === null, "a price that is not a positive six-decimal dollar amount has no base units");
  const n = referralNet("30000", { commissionBps: 2000, feeBps: 0 });
  ok(n.grossUsd === 0.03 && n.netUsd === 0.024, `net of a $0.03 sale at 2000 bps is $0.024 (${n.netUsd})`);
  ok(referralNet("30000", { commissionBps: 2000, feeBps: 500 }).netUnits === 22500n, "commission and fee both come off the gross");
  ok(referralNet("3", { commissionBps: 2000, feeBps: 500 }).netUnits === 3n, "a leg that rounds to zero is not taken: the remainder stays in net");
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
{
  const chain = createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, tries: 2, budgetMs: 1500, pauseMs: 50, timeoutMs: 500 });
  const a = { from: newAccount().address, nonce: freshNonce() };
  const unused = await chain.state(a);
  fac.land(a, "0x" + "5a".repeat(32));
  const used = await chain.state(a);
  const b = { from: newAccount().address, nonce: freshNonce() };
  fac.land(b, null);
  const noLog = await chain.state(b);
  fac.mode.rpcDown = true;
  const down = await chain.state(a);
  fac.mode.rpcDown = false;
  ok(unused.used === false && used.used === true && used.transaction === "0x" + "5a".repeat(32) && noLog.used === true && noLog.transaction === null && down.used === null, `authorizationState: unused, used with the AuthorizationUsed transaction, used with no log found, and unreadable as unknown (never unused) (${JSON.stringify([unused, used, noLog, down])})`);
  ok((await chain.state({ from: "nope", nonce: "0x1" })).used === null, "an address that is not one reads as unknown");
  const t0 = Date.now();
  const waited = await chain.state({ from: newAccount().address, nonce: freshNonce() }, { wait: true });
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
const seen = { chat: null, budgeted: null, breaker: null };
const TOOLS = {
  echo: { slug: "echo", name: "Echo", category: "test", price: "$0.03", route: "POST /api/echo", handler: async (i) => { runs.echo++; return { echo: i.text ?? null, run: runs.echo }; } },
  busy: { slug: "busy", name: "Busy", category: "test", price: "$0.03", handler: async (i) => { runs.busy++; await wait(300); return { echo: i.text ?? null }; } },
  slow: { slug: "slow", name: "Slow", category: "test", price: "$0.03", handler: async () => { runs.slow++; await wait(2500); return { late: true }; } },
  boom: { slug: "boom", name: "Boom", category: "test", price: "$0.03", route: "POST /api/boom", handler: async () => { runs.boom++; throw Object.assign(new Error("that input cannot be served; see POST /api/boom and /api/echo"), { statusCode: 422 }); } },
  bytes: { slug: "bytes", name: "Bytes", category: "test", price: "$0.03", handler: async () => ({ __binary: Buffer.from("png"), contentType: "image/png" }) },
  list: { slug: "list", name: "List", category: "test", price: "$0.03", handler: async () => [1, 2, 3] },
  owntx: { slug: "owntx", name: "Own", category: "test", price: "$0.03", handler: async () => ({ transaction: "the tool's own field", rows: 1 }) },
  chat: { slug: "chat", name: "Chat", category: "llm", price: "$0.001", quote: (b) => 0.001 * (Number(b?.max_tokens) || 1), handler: async (i, req) => { seen.chat = { stream: i.stream, hasOptions: "stream_options" in i, stash: req.__meteredQuoteUsd }; return { id: "c1", choices: [] }; } },
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
  const book = depOverride.book || createReferralBook({ doc: createJsonDocument({ name: `referral-test-${process.pid}-${++docSeq}`, log: () => {} }), log });
  const gate = createReferralGate({
    config, defs, replayGuard: createReplayGuard(), baseUrl: "https://shop.example", book,
    settler: createReferralSettler({ facilitatorUrl: config.facilitatorUrl, signerKey: config.signerKey, verifyTimeoutMs: config.verifyMs, settleTimeoutMs: config.settleMs, signVerify: config.verifySigned }),
    chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, tries: 2, budgetMs: 1200, pauseMs: 100, timeoutMs: 500 }),
    priceUsdOf, priceForNetwork,
    preValidate: (def, req) => (def.slug === "echo" && req.body && req.body.require ? { status: 400, body: { error: "Missing required parameter: text", tool: def.slug, howToCall: { method: "POST", url: "https://shop.example/api/echo" }, example: { see: "POST /api/echo" } } } : null),
    prePaymentRefusal: (def, input) => (def.slug === "chat" && input && input.model === "no-such-model" ? { status: 400, body: { error: { message: "unknown model; see /api/echo", code: "unknown_model" }, tool: def.slug } } : null),
    sendToolError: (res, err, slug) => res.status(err?.statusCode || 502).json({ error: String(err?.message || "request failed"), tool: slug }),
    recordSale: (row) => { sales.push(row); return ledger.recordSale(row); },
    saleBooked: (tx) => !!ledger.privateRailSaleByTx(tx, "referral"),
    payerScreen: async (req, res) => {
      const from = JSON.parse(Buffer.from(req.headers["payment-signature"], "base64").toString("utf8")).payload.authorization.from;
      if (from !== SCREENED.address) return true;
      res.status(403).json({ error: "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request.", reason: "payer-not-accepted", charged: false });
      return false;
    },
    hangup: {
      reserve: (req, { priceUsd, slug }) => hangupMod.reserveHangupForgiveness(req, { keys: [JSON.parse(Buffer.from(req.headers["payment-signature"], "base64").toString("utf8")).payload.authorization.from.toLowerCase(), `ip:${req.headers["x-test-ip"] || "local"}`], priceUsd, slug }),
      forgiven: (req) => hangupMod.hangupForgiven(req),
      finish: (req, abandoned) => hangupMod.settleHangupTicket(req, { abandoned }),
    },
    isolate: settleBreakerOtherLane,
    presentWindow: (req, at) => presentRunWindow(req, at),
    withCeiling: withBudgetCeiling,
    credentialLimiter: { limited: (req) => limiter.limitedFor.has(req.headers["x-test-ip"] || "local"), note: () => { limiter.notes++; } },
    clientKey: (req) => String(req.headers["x-test-ip"] || "local"),
    onSettledSale: (req) => trusted.push(req.headers["x-test-ip"] || "local"),
    directPaths: new Map([["/api/echo", "/ref/echo"], ["/api/boom", "/ref/boom"]]),
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
  const TOKEN = '{"v":1,"ref":"r-77","sig":"AbC+/=="}  ;, é';
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
  ok(badUnpaid.status === 400 && badUnpaid.json?.error?.code === "unknown_model" && !badUnpaid.text.includes("/api/echo") && badUnpaid.text.includes("/ref/echo"), `an unpaid body the direct route refuses before payment is refused the same way, with no pointer to a direct route (${badUnpaid.status} ${badUnpaid.text.slice(0, 100)})`);
  ok(fac.calls.length === 0 && fac.rpcCalls.length === 0, "an unpaid request calls the facilitator and the chain for nothing");

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
    ok(r.status === 400 && r.json?.tool === "echo" && !("howToCall" in r.json) && !r.text.includes("/api/echo") && r.text.includes("/ref/echo"), `an input the pre-payment check refuses is the direct route's 400 without its ready-to-run call, and names no direct route (${r.status} ${r.text.slice(0, 120)})`);
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
  fac.mode.settle = () => { intentSeen = app1.book.get(paidKey)?.state || null; return { status: 200, body: { success: true, transaction: fac.nextTx(), network: REFERRAL_NETWORK, payer: buyer.address } }; };
  const good = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": paid.header, "x-test-ip": "7.7.7.7" } });
  const settleCall = fac.of("/settle")[0], verifyCall = fac.of("/verify")[0];
  ok(good.status === 200 && good.json?.echo === "hello" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid call returns the tool's answer with a top-level transaction (${good.status} ${good.text.slice(0, 120)})`);
  ok(verifies() === 1 && settles() === 1 && fac.calls.findIndex((c) => c.path === "/verify") < fac.calls.findIndex((c) => c.path === "/settle"), "the facilitator was asked to verify once, then to settle once");
  ok(intentSeen === "intent", `the intent to settle was in the durable book before /settle was called (${intentSeen})`);
  for (const [name, c] of [["/verify", verifyCall], ["/settle", settleCall]]) {
    ok(c && /^0x[0-9a-f]{130}$/i.test(c.signature || "") && /^\d{10}$/.test(c.timestamp || "") && Math.abs(Number(c.timestamp) - Date.now() / 1000) < 60, `${name}: X-Agent-Signature is a 65-byte signature and X-Agent-Timestamp is unix seconds`);
    ok(c && c.recovered && c.recovered.toLowerCase() === signer.address.toLowerCase(), `${name}: the signature recovers to the signer over keccak256(body || uint64_be(timestamp)) of the exact bytes sent`);
    ok(c && c.raw === JSON.stringify({ x402Version: 2, paymentPayload: paid.payload, paymentRequirements: accept }), `${name}: the body is { x402Version: 2, paymentPayload, paymentRequirements } with the payload as decoded and the requirement as quoted`);
    ok(c && referralRequestDigest(c.raw, Number(c.timestamp)) === keccak256(concat([stringToHex(c.raw), numberToHex(Number(c.timestamp), { size: 8 })])), `${name}: the module's digest is the documented one`);
  }
  await quietLedger();
  const row = ledger.privateRailSaleByTx(good.json.transaction, "referral");
  ok(sales.length === 1 && sales[0].rail === "referral" && sales[0].wire === "referral" && sales[0].network === "base" && sales[0].payer === buyer.address.toLowerCase() && sales[0].tx === good.json.transaction && sales[0].priceUsd === 0.024 && sales[0].quoteUsd === 0.03, `one sale: rail referral, wire referral, network base, the signed payer, the settle transaction, net $0.024 of gross $0.03 (${JSON.stringify(sales[0])})`);
  ok(row && row.rail === "referral" && row.netUsd === 0.024 && row.grossUsd === 0.03 && row.payer === buyer.address.toLowerCase() && row.internal === false && row.responseSha256 === createHash("sha256").update(good.text, "utf8").digest("hex"), `the ledger row reads the same, with the digest of the bytes answered (${JSON.stringify(row)})`);
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
    ok(statuses[0] === 200 && statuses[1] === 409 && settles() === 1 && runs.busy === before + 1 && sales.length === 1 && sales[0].quoteUsd === 0.03 && sales[0].priceUsd === 0.015, `two identical requests at once: one 200, one 409, one handler run, exactly one settle (${statuses.join("/")}, ${settles()} settle, ${runs.busy - before} run); the slug's own commission (5000 bps) is what the sale is booked net of (${sales[0]?.priceUsd})`);
  }
  fac.reset(); sales.length = 0;

  // --- once the handler has started the authorization is spent --------------------
  {
    const p = await signPayment(accept);
    const r = await send(R("boom"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 422 && r.json?.tool === "boom" && settles() === 0 && sales.length === 0, `a handler 4xx is answered as the tool's own error and not settled (${r.status}, ${settles()} settle)`);
    ok(/that input cannot be served/.test(r.json?.error || "") && !r.text.includes("/api/boom") && !r.text.includes("/api/echo") && r.text.includes("/ref/boom") && r.text.includes("/ref/echo"), `a tool error names no direct route: a served tool's direct path reads as its /ref path (${r.json?.error})`);
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
    ok(sales.length === 1 && sales[0].quoteUsd === 0.009 && Math.abs(sales[0].priceUsd - 0.0072) < 1e-12, `its sale books the quote gross and net (${sales[0]?.quoteUsd}, ${sales[0]?.priceUsd})`);
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
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "ab".repeat(32) } });
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
    ok(otherPayerSameAddress.status === 429, `and the address's, whatever payer signs (${otherPayerSameAddress.status})`);
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: fac.nextTx() } });
    const stranger = await send(R("echo"), { body: { text: "ok" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } });
    ok(stranger.status === 200, `another payer on another address is served (${stranger.status})`);
    // A refusal that is about our own request is nobody's unsettled run.
    fac.mode.settle = () => ({ status: 503, body: { success: false, errorReason: "lookup_unavailable" } });
    const ours = newAccount(), oursIp = freshIp();
    for (let i = 0; i < 4; i++) await send(R("echo"), { body: { text: `o${i}` }, headers: { "payment-signature": (await signPayment(accept, { account: ours })).header, "x-test-ip": oursIp } });
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: fac.nextTx() } });
    const fifth = await send(R("echo"), { body: { text: "o5" }, headers: { "payment-signature": (await signPayment(accept, { account: ours })).header, "x-test-ip": oursIp } });
    ok(fifth.status === 200, `a refusal about this server's own request (a lookup it could not make) does not count against the buyer (${fifth.status})`);
    // Runs that timed out count too.
    const late = newAccount(), lateIp = freshIp();
    const slowBefore = runs.slow;
    await Promise.all([0, 1, 2].map(async () => send(R("slow"), { body: {}, headers: { "payment-signature": (await signPayment(accept, { account: late })).header, "x-test-ip": lateIp } })));
    const next = await send(R("slow"), { body: {}, headers: { "payment-signature": (await signPayment(accept, { account: late })).header, "x-test-ip": lateIp } });
    ok(runs.slow === slowBefore + 3 && next.status === 429, `three runs that timed out are three unsettled runs: the fourth is refused before it starts (${next.status}, ${runs.slow - slowBefore} runs)`);
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
    ok(r.status === 200 && r.json?.echo === "landed" && r.json.transaction === tx && sales.length === 1 && sales[0].tx === tx && sales[0].priceUsd === 0.024, `a settle answer lost after the payment landed is read from the chain and the answer is delivered with the chain's transaction (${r.status} ${r.text.slice(0, 90)})`);
    // Landed, but the log is not in the range read: delivered, and said so.
    const q = await signPayment(accept, { account: newAccount() });
    fac.mode.settle = () => { fac.land(q.authorization, null); return { hang: true }; };
    const t0 = Date.now();
    const r2 = await send(R("echo"), { body: { text: "no log" }, headers: { "payment-signature": q.header, "x-test-ip": freshIp() } });
    ok(r2.status === 200 && r2.json?.echo === "no log" && r2.json.transaction === null && r2.json.settlement === "charged-transaction-not-found" && Date.now() - t0 < 5000 && sales.length === 2 && sales[1].tx === null, `a /settle that never answers ends at the settle timeout; the chain says the payment landed and its log is not found: the answer is delivered with a marker field and the sale is booked (${r2.status} after ${Date.now() - t0} ms, ${r2.text.slice(0, 110)})`);
    // The chain cannot be read: unknown, never "not charged".
    const u = await signPayment(accept, { account: newAccount() });
    fac.mode.settle = () => ({ status: 500, body: {} });
    fac.mode.rpcDown = true;
    const r3 = await send(R("echo"), { body: { text: "dark" }, headers: { "payment-signature": u.header, "x-test-ip": freshIp() } });
    fac.mode.rpcDown = false;
    ok(r3.status === 402 && r3.json?.errorReason === "settle_outcome_unknown" && r3.json.retryable === true && sales.length === 2, `with the chain unreadable the outcome stays unknown (${r3.status} ${r3.json?.errorReason})`);
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
    // A refusal the facilitator documents is definite; an authorization already used is read on chain.
    fac.mode.settle = () => ({ status: 409, body: { success: false, errorReason: "authorization_used" } });
    const p = await signPayment(accept, { account: newAccount() });
    const r = await send(R("echo"), { body: { text: "used" }, headers: { "payment-signature": p.header, "x-test-ip": freshIp() } });
    ok(r.status === 402 && r.json?.errorReason === "authorization_used", `an authorization the facilitator says is already used: 402 with that reason (${r.status} ${r.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;

  // --- a buyer who leaves ---------------------------------------------------------
  hangupMod._resetHangupForgiveness();
  {
    // With a forgiveness ticket: not settled, the authorization held.
    const acct = newAccount();
    const p = await signPayment(accept, { account: acct });
    const outcome = await rawPost(R("busy"), { text: "gone" }, { "payment-signature": p.header, "x-test-ip": "5.5.5.5" }, 120);
    await wait(500);
    ok(outcome === "aborted" && settles() === 0 && sales.length === 0 && logLines.some((l) => /client gone before settlement \(busy/.test(l)), `a connection closed before settlement starts, inside the forgiveness budget, is not settled (${settles()} settle, ${sales.length} sale)`);
    const again = await send(R("echo"), { body: { text: "back" }, headers: { "payment-signature": p.header, "x-test-ip": "5.5.5.5" } });
    ok(again.status === 409, `its claim is HELD: the same authorization buys nothing more (${again.status})`);
    ok(hangupMod.hangupForgivenessStatus().abandonedUsd >= 0.03 || JSON.stringify(hangupMod.hangupForgivenessStatus()).includes("0.03"), `the forgiven run is spent from the direct routes' own forgiveness budget (${JSON.stringify(hangupMod.hangupForgivenessStatus()).slice(0, 160)})`);
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
      const early = await book.sweep({ chain: { state: async () => { throw new Error("must not be read"); } }, bookSale: async () => true, graceMs: 60_000 });
      ok(early.read === 0, "the sweep leaves an intent alone while its own request may still be settling");
      const first = await book.sweep({ chain: createReferralChainReader({ rpcUrl: `${fac.url}/rpc`, tries: 1, budgetMs: 1000 }), bookSale: (e, t) => app4.gate.sweepOnce && sales.push({ sweep: true, tx: t }) && true, graceMs: 0 });
      ok(first.landed === 1 && first.expired === 1 && first.unknown === 1, `the sweep reads every open intent against the chain: one landed, one expired unused, one still open (${JSON.stringify(first)})`);
      // The gate's own sweep books the sale, once.
      await book.resolve(kGone, { state: "intent", saleBooked: false, intentAt: Date.now() - 600_000 });
      sales.length = 0;
      await app4.gate.sweepOnce();
      await app4.gate.sweepOnce();
      await quietLedger();
      const rowAfter = ledger.privateRailSaleByTx(tx, "referral");
      ok(sales.length === 1 && sales[0].tx === tx && sales[0].priceUsd === 0.024 && sales[0].quoteUsd === 0.03 && rowAfter?.netUsd === 0.024 && book.get(kGone)?.state === "charged-undelivered" && book.get(kGone).saleBooked === true && book.get(kGone).tx === tx, `a payment that moved while its process died is booked by the sweep, once, at the net amount, and kept as charged-undelivered (${sales.length} sale, ${book.get(kGone)?.state})`);
      ok(book.get(kNever) === null && book.get(kOpen)?.state === "in-doubt", "an intent that expired unused is closed; one the chain has not used yet stays open");
      // The dead process had booked the sale before it stopped: the ledger says so, and the sweep books no second one.
      const known = await signPayment(accept, { account: newAccount() });
      const kKnown = gateMod.referralReplayKey(known.authorization);
      const txKnown = "0x" + "e3".repeat(32);
      ledger.recordSale({ slug: "echo", priceUsd: 0.024, quoteUsd: 0.03, rail: "referral", wire: "referral", network: "base", payer: known.authorization.from, tx: txKnown });
      await book.intent({ key: kKnown, slug: "echo", payer: known.authorization.from, nonce: known.authorization.nonce, amount: "30000", validBefore: Number(known.authorization.validBefore) });
      await book.resolve(kKnown, { intentAt: Date.now() - 600_000 });
      fac.land(known.authorization, txKnown);
      const salesBefore = sales.length;
      await quietLedger();
      await app4.gate.sweepOnce();
      ok(sales.length === salesBefore && book.get(kKnown)?.state === "charged-undelivered" && book.get(kKnown).saleBooked === true, `a settlement whose sale is already on the ledger is not booked again by the sweep (${sales.length - salesBefore} more)`);
      ok(logLines.some((l) => /CHARGED-BUT-NOT-SERVED: a settlement left open landed on chain \(echo .*sale booked/.test(l)), "and it is logged");
      // The same payment sent to the new process: it bought its run already.
      const ran = runs.echo;
      const r = await send(`${app4.url}/ref/echo`, { body: { text: "x" }, headers: { "payment-signature": gone.header } });
      ok(r.status === 409 && r.json?.reason === "answer_unavailable" && runs.echo === ran, `an authorization the book holds, with no answer kept here, runs no second time (${r.status} ${r.json?.reason})`);
    } finally { await app4.close(); }
  }
  fac.reset(); sales.length = 0;

  // --- a bounded number of paid calls in flight ------------------------------------------
  {
    const app5 = await mount({ REFERRAL_MAX_INFLIGHT: "2" });
    try {
      fac.mode.verifyDelayMs = 500;
      const before = runs.echo;
      const rs = await Promise.all([0, 1, 2, 3].map(async () => send(`${app5.url}/ref/echo`, { body: { text: "q" }, headers: { "payment-signature": (await signPayment(accept, { account: newAccount() })).header, "x-test-ip": freshIp() } })));
      const busy = rs.filter((r) => r.status === 503 && r.json?.errorReason === "busy" && r.headers.get("retry-after"));
      ok(rs.filter((r) => r.status === 200).length === 2 && busy.length === 2 && runs.echo === before + 2 && verifies() === 2, `past the in-flight bound a paid call is answered 503 with Retry-After before anything runs or is sent (${rs.map((r) => r.status).join(",")}; ${verifies()} verify calls)`);
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
    ok(mine && mine.amountUsd === 0.03 && mine.quotedUsd === 0.03 && !JSON.stringify(receipts).includes("0.024"), `the buyer's receipts show the gross the buyer paid, and no figure that gives the commission away (${JSON.stringify(mine)})`);
    const usage = ledger.payerUsage(buyer.address.toLowerCase());
    const echoRow = usage.bySlug.find((r) => r.slug === "echo");
    const grossSum = receipts.rows.reduce((a, r) => a + r.amountUsd, 0);
    ok(usage.totals.calls === receipts.rows.length && Math.abs(usage.totals.paidUsd - +grossSum.toFixed(4)) < 1e-9 && echoRow && Math.abs(echoRow.usd / echoRow.calls - 0.03) < 1e-9 && usage.recent.every((r) => r.priceUsd !== 0.024), `the buyer's usage totals are the gross too (${usage.totals.calls} calls, $${usage.totals.paidUsd})`);
    // Every statement that reads the sales table states which rails it reads.
    const src = readFileSync(fileURLToPath(new URL("../src/sales-ledger.js", import.meta.url)), "utf8");
    const statements = [...src.matchAll(/(?:db\.prepare\(|const [A-Z_]+ = )\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]).filter((q) => /\bFROM sales\b/i.test(q) && /^SELECT\b/i.test(q.replace(/^[`"]\s*/, "")));
    const unmarked = statements.filter((q) => !/PAYING_RAILS_SQL|PUBLIC_RAIL_SQL|BUYER_RAILS_SQL|buyer-view|private-rail|\bwire (?:IN|=)|rail IN \('card'|rail = 'card'|WINDOW_PAGE|SCORECARD_ROWS|MIN\(id\)|MAX\(id\)/.test(q));
    ok(statements.length >= 40 && unmarked.length === 0, `every SELECT on the sales table reads paying rails, a wire of its own, the public rails, or is a marked buyer or private-rail view (${statements.length} statements${unmarked.length ? `; unmarked: ${unmarked.map((q) => q.replace(/\s+/g, " ").slice(0, 90)).join(" | ")}` : ""})`);
    const pages = [...src.matchAll(/\$\{(WINDOW_PAGE|SCORECARD_ROWS)\}([^`]*)`/g)].filter((m) => m[1] === "WINDOW_PAGE" && !/PAYING_RAILS_SQL|PUBLIC_RAIL_SQL/.test(m[2]));
    ok(pages.length === 0 && /SCORECARD_ROWS = `[^`]*PAYING_RAILS_SQL/.test(src), "and every paged window read names its rails too");
    ok(PRIVATE_RAILS.includes("referral") && !PAYING_RAILS.includes("referral"), "referral is a private rail, never a paying one");
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
const REF_ENV = { REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY, REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral", REFERRAL_SLUGS: "hash", REFERRAL_COMMISSION_BPS: "default:2000" };
const BLANK = { REFERRAL_PAY_TO: "", REFERRAL_FACILITATOR_URL: "", REFERRAL_SIGNER_KEY: "", REFERRAL_SLUGS: "", REFERRAL_SETUP_URL: "", REFERRAL_COMMISSION_BPS: "" };

// Switches unset: nothing is mounted.
{
  const off = await bootPaidServer({ label: "referral-off", env: { ...BLANK, AGENT402_OPERATOR_TOKEN: TOKEN_OP } });
  try {
    const a = await call(`${off.url}/ref/hash`, { method: "GET" });
    const b = await call(`${off.url}/ref/hash`, { body: { text: "a" } });
    const direct = await call(`${off.url}/api/hash`, { body: { text: "a" } });
    ok(a.status === 404 && b.status === 404 && direct.status === 402, `with the REFERRAL_* variables unset /ref/* is a 404 and the direct route is unchanged (${a.status}, ${b.status}, ${direct.status})`);
    ok(/application\/json/.test(a.headers.get("content-type") || ""), "and that 404 is JSON: /ref is a machine path");
    ok(!/referral/i.test(off.log()), "and the boot log says nothing about it");
    const op = await call(`${off.url}/__operator/referral.json`, { method: "GET", headers: { "x-operator-token": TOKEN_OP } });
    const noToken = await call(`${off.url}/__operator/referral.json`, { method: "GET" });
    ok(op.status === 200 && op.json?.enabled === false && noToken.status === 404, `the operator view says the gate is off, and answers 404 without the token (${op.status}, ${noToken.status})`);
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
    const bigHash = await call(`${w.url}/ref/hash`, { body: { text: "x".repeat(150_000) }, headers: at("203.0.113.93", paidShape) });
    ok(bigHash.status === 413, `a copy of a route with no large-body allowance keeps the 100 KB limit (${bigHash.status})`);
    // A non-canonical spelling reaches none of the path-mounted limiters, so it is given nothing.
    const encoded = await call(`${w.url}/ref/v1%2Dchat%2Dmetered`, { body, headers: at("203.0.113.94") });
    const upper = await call(`${w.url}/REF/hash`, { method: "GET", headers: at("203.0.113.95") });
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
  args: ["--import", "./scripts/lib/openrouter-stub-preload.js"],
  env: {
    ...REF_ENV, ...COSTS,
    WALLET_ADDRESS: OUR_WALLET, TRUST_PROXY_HOPS: "1",
    FACILITATOR_URL: `http://127.0.0.1:${directFac.address().port}`, AGENT402_BASE_RPC: `${fac.url}/rpc`,
    REFERRAL_SLUGS: "hash,v1-chat-metered,v1-chat,v1-chat-auto,v1-chat-pro,v1-chat-premium,onchain-sql,image-gen,image-gen-premium,attest,qr,answer,no-such-tool",
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
  ok(servedLine && ["hash", "onchain-sql", "answer", "v1-chat-auto", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-chat"].every((x) => served.includes(x)) && served.length === 8, `the boot serves the eligible slugs: the chat tiers (cut off at the deadline through their payment window), onchain-sql and answer (their handler budget capped), hash (${servedLine ? servedLine[2] : "no line"})`);
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

  // A paid call end to end on a flat tool.
  const p = await signPayment(refAccept);
  const good = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": p.header } });
  ok(good.status === 200 && good.json?.hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid /ref/hash returns the tool's answer with the settle transaction (${good.status} ${good.text.slice(0, 140)})`);
  ok(fac.of("/settle").length === 1 && fac.of("/settle")[0].recovered?.toLowerCase() === signer.address.toLowerCase() && fac.of("/settle")[0].json?.paymentRequirements?.payTo === PAY_TO && fac.of("/settle")[0].json.paymentRequirements.amount === "1000", "the referral facilitator settled it once, on a request signed by the signer key, for the quoted requirement");
  const replay = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { ...xff(), "payment-signature": p.header } });
  ok(replay.status === 200 && replay.text === good.text && fac.of("/settle").length === 1, `the same payment again returns the kept answer, with no second settle (${replay.status})`);
  const invalid = await call(`${srv.url}/ref/hash`, { body: {}, headers: { ...xff(), "payment-signature": (await signPayment(refAccept)).header } });
  ok(invalid.status === 400 && invalid.json?.tool === "hash" && !("howToCall" in invalid.json) && !invalid.text.includes("/api/hash") && fac.of("/settle").length === 1, `a paid call with an invalid input is the direct route's 400, not settled, with no ready-to-run call and no pointer to the direct route (${invalid.status} ${invalid.text.slice(0, 120)})`);
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
    ok(q.status === 402 && r.status === 200 && r.json?.choices?.[0]?.message?.content === "OK" && /^0x[0-9a-f]{64}$/.test(r.json?.transaction || "") && or.chat === chatBefore + 1 && sent.stream !== true && fac.of("/settle").length === settlesBefore + 1 && fac.of("/settle").at(-1).json.paymentRequirements.amount === acc.amount,
      `${name}: the real handler runs once against the upstream (not streamed), and the answer comes back with the settle transaction for the quoted amount (${r.status} ${r.text.slice(0, 100)})`);
    return { acc, r };
  };
  await paidChat("a fixed-price chat tier", "v1-chat-auto", { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, stream: true });
  const proRun = await paidChat("a model-priced chat tier naming a dearer model", "v1-chat-pro", chatBody("anthropic/claude-opus-5.5"));
  ok(proRun.acc.amount === proDear.got, `settled at the dearer model's amount (${proRun.acc.amount})`);
  await paidChat("the metered chat tier", "v1-chat-metered", meteredBody);
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
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: fac.nextTx(), network: REFERRAL_NETWORK } });
    const statusAfter = await call(`${srv.url}/api/gateway-status`, { method: "GET" });
    ok(statuses.every((s) => s === 402) && statuses.length === 15, `13 payers whose referral settle is refused are each answered 402 (${[...new Set(statuses)].join(",")})`);
    const word = (o, k) => JSON.stringify(o.json?.[k] ?? null);
    ok(word(statusAfter, "settleFailures") === word(statusBefore, "settleFailures") && !/burst/.test(word(statusAfter, "settleFailures")) && /ok/.test(word(statusBefore, "settleFailures")) && word(statusAfter, "buyerRefusals") === word(statusBefore, "buyerRefusals") && word(statusAfter, "toolFailures") === word(statusBefore, "toolFailures") && word(statusAfter, "unsettledReports") === word(statusBefore, "unsettledReports") && !/referral/i.test(statusAfter.text), `the public status words did not move (settleFailures ${word(statusBefore, "settleFailures")} -> ${word(statusAfter, "settleFailures")}), and none names the gate`);
    laneAcc = acc; lanePayer = payers[0];
  }

  // No public surface changed or names the gate.
  {
    await wait(300);
    const after = await snapshot();
    const named = SURFACES.filter((s) => /\/ref\/|referral/i.test(after[s].text) || after[s].text.toLowerCase().includes(PAY_TO.toLowerCase()));
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
  ok(op.status === 200 && op.json?.enabled === true && op.json.sinceBoot?.settled >= 4 && op.json.sinceBoot.timeouts === 1 && op.json.sinceBoot.screened === 1 && op.json.routes.includes("hash") && Array.isArray(op.json.open) && Array.isArray(op.json.notServed), `the operator view carries the gate's counters, its open settlements and the slugs it does not serve (${JSON.stringify(op.json?.sinceBoot)})`);

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
  const stores = { REFERRAL_BOOK_FILE: join(tmp, "kill-book.json"), SALES_LEDGER_DB: join(tmp, "kill-sales.db") };
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
    ok(again.status === 409 && again.json?.reason === "answer_unavailable", `the same payment sent to the new process runs nothing a second time (${again.status} ${again.json?.reason})`);
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
