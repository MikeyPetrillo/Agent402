#!/usr/bin/env node
// A Solana payment refused because the paying wallet has no USDC token
// account, or too little USDC, says so and asks for funding (retry
// fund-wallet, Retry-After), and a wallet that keeps re-signing is answered
// from the funding hold without asking the facilitator until the hold
// passes (src/svm-funding-refusal.js, src/verify-hint.js).
//
// Unit half: the classifier on the facilitator's own spellings, the hint, the
// transfer-account walk on transactions @solana/kit builds, the failure
// monitor's rows, the canary's paid-amount text, the EVM hints unchanged.
// Wire half: a paid server (port from the OS) against a stub facilitator that
// answers the two simulation failures in both shapes @x402/core has (a thrown
// non-2xx verify and a graceful isValid:false).
//   node scripts/test-svm-funding-refusal.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePort } from "./lib/free-port.js";
import { classifySvmFundingRefusal, fundingHint, fundingKeyOf, noteFundingRefusal, fundingHoldOf, clearFundingState, RETRY_AFTER_S, HOLD_AFTER, POW_SENTENCE, _resetFundingForTest, _setFundingStoreForTest } from "../src/svm-funding-refusal.js";
import { createMemoryLimits } from "../src/shared-limits.js";
import { svmTransferAccounts } from "../src/svm-payer.js";
import { hintFor } from "../src/verify-hint.js";
import { createToolFailureMonitor } from "../src/tool-failure-monitor.js";
import { paidAmountText } from "./paid-canary.js";
import { REJECTION_REASONS } from "../src/payment-reject.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// ---- the classifier ---------------------------------------------------------
const NO_ACCT = "invalid_exact_svm_payload_transaction_simulation_failed: simulation failed: InstructionError:[2 InvalidAccountData]";
const SHORT = "invalid_exact_svm_payload_transaction_simulation_failed: simulation failed: InstructionError:[2 map[Custom:1]]";
ok(classifySvmFundingRefusal({ network: SOL, reason: NO_ACCT }) === "no-token-account", "InvalidAccountData on the transfer reads as no USDC token account");
ok(classifySvmFundingRefusal({ network: SOL, reason: SHORT }) === "insufficient-funds", "Custom:1 on the transfer reads as too little USDC");
ok(classifySvmFundingRefusal({ network: SOL, reason: 'transaction_simulation_failed Simulation failed: {"InstructionError":[2,{"Custom":1}]}' }) === "insufficient-funds", "the JSON spelling of Custom:1 reads the same");
ok(classifySvmFundingRefusal({ network: SOL, reason: "transaction simulation failed: InstructionError(2, InvalidAccountData)" }) === "no-token-account", "the Rust spelling reads the same");
ok(classifySvmFundingRefusal({ network: SOL, reason: "simulation_failed InstructionError:[1 map[Custom:1]]" }) === null, "an error on another instruction is not a funding refusal");
ok(classifySvmFundingRefusal({ network: SOL, reason: "simulation_failed InstructionError:[2 map[Custom:4]]" }) === null, "another token error code is not a funding refusal");
ok(classifySvmFundingRefusal({ network: SOL, reason: "InstructionError:[2 InvalidAccountData]" }) === null, "words outside a simulation failure are not read");
ok(classifySvmFundingRefusal({ network: "eip155:8453", reason: SHORT }) === null, "an EVM network is never classified here");

// ---- the hint -------------------------------------------------------------------
{
  const a = fundingHint({ kind: "no-token-account", payer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
  ok(a.retry === "fund-wallet" && a.reason === "no-token-account" && a.retryAfterSeconds === 300, `no account: retry fund-wallet, Retry-After 300 by default (${a.retryAfterSeconds})`);
  ok(/no USDC token account on Solana/.test(a.hint) && /Nothing was charged\./.test(a.hint) && /9xQe\.\.\.VFin/.test(a.hint), `no account: says what is missing, that nothing was charged, and names the wallet (${a.hint})`);
  ok(!/fresh authorization|Sign a fresh/i.test(a.hint), "no account: never asks for a fresh signature");
  const b = fundingHint({ kind: "insufficient-funds", priceUsd: 0.05 });
  ok(/less USDC on Solana than this call costs \(\$0\.050\)/.test(b.hint) && /another network listed in accepts/.test(b.hint), `too little: names the price and the other networks (${b.hint})`);
  ok(REJECTION_REASONS.some((r) => r.reason === "no-token-account") && REJECTION_REASONS.some((r) => r.reason === "insufficient-funds"), "both classes are published refusal classes");
  ok(!/—/.test(a.hint + b.hint + POW_SENTENCE), "no em dash in the hint text");
}

// ---- EVM hints unchanged --------------------------------------------------------
{
  const empty = hintFor({ reason: "invalid_payload: contract call failed: execution reverted", balanceUsd: 0, priceUsd: 0.01, network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1" });
  ok(empty.retry === "fund-wallet" && empty.retryAfterSeconds === undefined && /holds \$0\.0000 USDC on Base/.test(empty.hint), "Base empty wallet: the measured hint, no Solana Retry-After");
  const stale = hintFor({ reason: "invalid_payload: contract call failed: execution reverted", balanceUsd: 5, priceUsd: 0.01, network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1" });
  ok(stale.retry === "fresh-authorization", "Base funded wallet: still a fresh authorization");
  const solOther = hintFor({ reason: "invalid_exact_svm_payload_memo_mismatch", network: SOL });
  ok(solOther.retry === "fresh-authorization" && !solOther.svmFunding, "a Solana refusal that is not about funding keeps its generic hint");
}

// ---- transfer accounts on real transactions --------------------------------------
const kit = await import("@solana/kit");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CB = "ComputeBudget111111111111111111111111111111";
const feePayer = await kit.generateKeyPairSigner();
const payTo = await kit.generateKeyPairSigner();
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
let priceSeq = 1;
async function paymentTx(buyer, { source, amount = 1000, version = 0 } = {}) {
  const src = source || (await kit.generateKeyPairSigner()).address;
  const ixs = [
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, ...u32(20000)]) },
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(priceSeq++)]) },
    { programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(MINT), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ], data: new Uint8Array([12, ...u64(amount), 6]) },
  ];
  const msg = kit.pipe(
    kit.createTransactionMessage({ version }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
    (m) => kit.appendTransactionMessageInstructions(ixs, m),
  );
  return { tx: kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg)), source: src };
}
{
  const buyer = await kit.generateKeyPairSigner();
  for (const version of [0, "legacy"]) {
    const { tx, source } = await paymentTx(buyer, { version });
    const t = svmTransferAccounts(tx);
    ok(t && t.authority === buyer.address && t.source === source && t.mint === MINT && t.destination === payTo.address, `${version} message: the TransferChecked accounts are read (${JSON.stringify(t)})`);
  }
  const { tx } = await paymentTx(buyer);
  ok(svmTransferAccounts(tx, { index: 1 }) === null, "a compute-budget instruction is not read as a transfer");
  ok(svmTransferAccounts("AAAA") === null && svmTransferAccounts(null) === null, "junk reads as null");
  const k1 = fundingKeyOf({ payload: { transaction: tx } }, SOL);
  const k2 = fundingKeyOf({ payload: { transaction: (await paymentTx(buyer)).tx } }, SOL);
  const sameSrc = (await paymentTx(buyer, { source: svmTransferAccounts(tx).source })).tx;
  ok(k1 && k1 !== k2 && fundingKeyOf({ payload: { transaction: sameSrc } }, SOL) === k1, "the key is the authority AND its source account: another source is another key, a re-signed payment from the same one is the same");
  ok(fundingKeyOf({ payload: { transaction: tx } }, "eip155:8453") === null, "no key off Solana");
}

// ---- the hold, on a memory store ---------------------------------------------------
{
  _setFundingStoreForTest(createMemoryLimits()); _resetFundingForTest();
  const t0 = 1_700_000_000_000;
  const k = "k1";
  for (let i = 1; i < HOLD_AFTER(); i++) ok(!(await noteFundingRefusal({ key: k, kind: "insufficient-funds", now: t0 + i })).held, `refusal ${i}: no hold yet`);
  ok((await noteFundingRefusal({ key: k, kind: "insufficient-funds", now: t0 + 10 })).held, `refusal ${HOLD_AFTER()}: the hold is set`);
  const h = await fundingHoldOf({ key: k, now: t0 + 20 });
  ok(h?.kind === "insufficient-funds" && h.untilMs === t0 + 10 + RETRY_AFTER_S() * 1000, "the hold lasts exactly the Retry-After the buyer was given");
  ok((await fundingHoldOf({ key: k, now: t0 + 10 + RETRY_AFTER_S() * 1000 })) === null, "at the Retry-After the hold is gone");
  ok((await fundingHoldOf({ key: "k2", now: t0 + 20 })) === null, "another wallet is not held");
  ok(!(await noteFundingRefusal({ key: "k3", kind: "no-token-account", now: t0 })).held && !(await noteFundingRefusal({ key: "k3", kind: "insufficient-funds", now: t0 + 1 })).held, "different reasons count apart");
  await clearFundingState({ key: k });
  ok((await fundingHoldOf({ key: k, now: t0 + 20 })) === null && !(await noteFundingRefusal({ key: k, kind: "insufficient-funds", now: t0 + 30 })).held, "a valid verify clears the hold and the window");
  _setFundingStoreForTest(null);
}

// ---- the failure monitor -------------------------------------------------------------
{
  let t = 1_700_000_000_000;
  const mon = createToolFailureMonitor({ now: () => t, env: {} });
  mon.noteFundingRefusal({ network: SOL, reason: "insufficient-funds" });
  mon.noteFundingRefusal({ network: SOL, reason: "insufficient-funds", held: true });
  mon.noteFundingRefusal({ network: SOL, reason: "no-token-account" });
  const rows = mon.evaluate().fundingRefusals;
  const s = rows.find((r) => r.reason === "insufficient-funds");
  ok(s && s.network === SOL && s.hour.refused === 1 && s.hour.held === 1 && s.day.refused === 1, `funding refusals by network and reason (${JSON.stringify(rows)})`);
  ok(JSON.stringify(mon.snapshot()).includes("fundingRefusals"), "the counts ride the replica snapshot");
}

// ---- the canary prints what was paid -------------------------------------------------
{
  const rcpt = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  ok(paidAmountText({ signedAmount: "50000" }) === "$0.05", "the signed accept's amount (50000 base units) prints $0.05");
  ok(paidAmountText({ receiptHeader: rcpt({ success: true, transaction: "x", amount: "1234" }), signedAmount: "50000" }) === "$0.001234", "a receipt amount wins over the signed one");
  ok(paidAmountText({ signedAmount: "2000000" }) === "$2.00", "whole dollars keep two decimals");
  ok(paidAmountText({}) === null, "nothing readable prints no figure");
}

// ---- the wire ------------------------------------------------------------------------
const [PORT, FAC_PORT] = [await getFreePort(), await getFreePort()];
const B = `http://127.0.0.1:${PORT}`;
const OP = "svm-funding-test-operator-token-0123456789";
const modes = new Map(); // authority -> "short" | "noacct-throw" | "ok"
const st = { verifies: 0, verifiesBy: new Map(), settles: 0, evmVerifies: 0 };
const EVM_PAYER = "0x00000000000000000000000000000000000000a1";
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const [path] = req.url.split("?");
    if (path === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    let j = {}; try { j = JSON.parse(body); } catch { /* empty */ }
    const net = j?.paymentRequirements?.network;
    if (path === "/verify" && net === "eip155:8453") { st.evmVerifies++; return reply(200, { isValid: false, invalidReason: "insufficient_funds", payer: EVM_PAYER }); }
    const auth = svmTransferAccounts(j?.paymentPayload?.payload?.transaction)?.authority || "";
    if (path === "/verify") {
      st.verifies++; st.verifiesBy.set(auth, (st.verifiesBy.get(auth) || 0) + 1);
      const mode = modes.get(auth) || "short";
      if (mode === "ok") return reply(200, { isValid: true, payer: auth });
      if (mode === "noacct-throw") return reply(400, { isValid: false, invalidReason: NO_ACCT, payer: auth });
      return reply(200, { isValid: false, invalidReason: "transaction_simulation_failed", invalidMessage: 'Simulation failed: {"InstructionError":[2,{"Custom":1}]}', payer: auth });
    }
    if (path === "/settle") { st.settles++; return reply(200, { success: true, transaction: "5".repeat(64), network: SOL, payer: auth }); }
    if (path === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub" } });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const HOLD_S = 4;
const env = { ...process.env };
delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...env, PORT: String(PORT), FREE_MODE: "", NODE_ENV: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
    FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
    PAYMENT_SETTLE_FALLBACK: "", SOLVADOR_KEY: "", AGENT402_OPERATOR_TOKEN: OP,
    SVM_FUNDING_RETRY_AFTER_S: String(HOLD_S),
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = [];
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) log.push(l.slice(0, 400)); if (log.length > 120) log.splice(0, log.length - 120); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const PATH = "/api/hash";
const BODY = JSON.stringify({ text: "x", algo: "sha256" });
const decode = (h) => JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
let solAccept = null, evmAccept = null;
async function pay(buyer, { source } = {}) {
  const { tx } = await paymentTx(buyer, { source, amount: Number(solAccept.amount) });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: solAccept.__resource, accepted: (({ __resource, ...a }) => a)(solAccept), payload: { transaction: tx } })).toString("base64");
  const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: BODY });
  return { status: r.status, retryAfter: r.headers.get("retry-after"), receipt: r.headers.get("payment-response"), required: r.headers.get("payment-required"), body: await r.json().catch(() => ({})) };
}

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
  ok(up, "the paid server boots against the stub facilitator");
  const bare = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
  const offer = decode(bare.headers.get("payment-required"));
  solAccept = (offer.accepts || []).find((a) => a.network === SOL);
  evmAccept = (offer.accepts || []).find((a) => a.network === "eip155:8453");
  ok(solAccept && evmAccept, `the offer lists Solana and Base (${(offer.accepts || []).map((a) => a.network).join(", ")})`);
  solAccept.__resource = offer.resource;

  // Too little USDC (graceful shape): HOLD_AFTER refusals reach verify, each with the funding hint.
  const short = await kit.generateKeyPairSigner();
  const shortSrc = (await kit.generateKeyPairSigner()).address;
  const firsts = [];
  for (let i = 0; i < HOLD_AFTER(); i++) firsts.push(await pay(short, { source: shortSrc }));
  const f = firsts[0];
  ok(firsts.every((r) => r.status === 402), `each refusal is a 402 (${firsts.map((r) => r.status)})`);
  ok(f.body.reason === "insufficient-funds" && f.body.retry === "fund-wallet", `reason insufficient-funds, retry fund-wallet (${f.body.reason}, ${f.body.retry})`);
  ok(f.retryAfter === String(HOLD_S), `Retry-After is the funding wait (${f.retryAfter})`);
  ok(/holds less USDC on Solana than this call costs/.test(f.body.hint) && /Nothing was charged\./.test(f.body.hint) && !/fresh authorization/i.test(f.body.hint), `the hint asks for funding, not a fresh signature: ${f.body.hint}`);
  ok(f.body.hint.endsWith(POW_SENTENCE) && f.body.altPayment, "a proof-of-work tool's hint points at altPayment");
  ok(!f.receipt && st.settles === 0, "nothing settled, nothing charged");
  ok(Array.isArray(f.body.accepts) && JSON.stringify(f.body.accepts) === JSON.stringify(decode(f.required).accepts) && !("error" in f.body), "the body still mirrors the offer, without the header's error line");
  {
    const { x402Version: _v, resource: _r, accepts: _a, extensions: _e, ...own } = f.body;
    ok(Buffer.byteLength(JSON.stringify(own)) <= 2048, `our own body fields stay under the 2,048-byte cap test-bazaar-contracts holds (${Buffer.byteLength(JSON.stringify(own))})`);
  }
  ok(st.verifiesBy.get(short.address) === HOLD_AFTER(), `the first ${HOLD_AFTER()} attempts reached verify (${st.verifiesBy.get(short.address)})`);

  // The next attempt is answered from the hold, without a verify.
  const held = await pay(short, { source: shortSrc });
  ok(held.status === 402 && held.body.retry === "fund-wallet" && held.body.reason === "insufficient-funds", `held: the same funding 402 (${held.status} ${held.body.reason})`);
  ok(st.verifiesBy.get(short.address) === HOLD_AFTER(), "held: the facilitator was not asked");
  ok(Number(held.retryAfter) >= 1 && Number(held.retryAfter) <= HOLD_S, `held: Retry-After is what is left of the hold (${held.retryAfter})`);
  ok(/checked again after/.test(held.body.hint) && /Nothing was charged\./.test(held.body.hint), `held: the hint says it repeats the last check (${held.body.hint})`);
  ok(decode(held.required).error === "wallet_not_funded", `held: the PAYMENT-REQUIRED error names it (${decode(held.required).error})`);
  ok(!held.receipt && st.settles === 0, "held: nothing charged");

  // Another wallet, no token account (thrown shape): reaches verify, its own hint.
  const noacct = await kit.generateKeyPairSigner();
  modes.set(noacct.address, "noacct-throw");
  const n = await pay(noacct);
  ok(st.verifiesBy.get(noacct.address) === 1, "a different wallet is not held: it reached verify");
  ok(n.status === 402 && n.body.reason === "no-token-account" && n.body.retry === "fund-wallet" && n.retryAfter === String(HOLD_S), `no account: reason, retry and Retry-After (${n.body.reason}, ${n.body.retry}, ${n.retryAfter})`);
  ok(/has no USDC token account on Solana/.test(n.body.hint), `no account: the hint says so (${n.body.hint})`);

  // The same wallet paying from another source account is another key.
  await pay(short);
  ok(st.verifiesBy.get(short.address) === HOLD_AFTER() + 1, "the held wallet's other source account is not held");

  // After the Retry-After, a funded wallet reaches verify and is served.
  await sleep(HOLD_S * 1000 + 300);
  modes.set(short.address, "ok");
  const funded = await pay(short, { source: shortSrc });
  ok(funded.status === 200 && st.verifiesBy.get(short.address) === HOLD_AFTER() + 2, `after the Retry-After the funded wallet reaches verify and is served (${funded.status})`);
  // The success cleared the window: two more refusals both reach verify.
  modes.set(short.address, "short");
  await pay(short, { source: shortSrc }); await pay(short, { source: shortSrc });
  ok(st.verifiesBy.get(short.address) === HOLD_AFTER() + 4, `a valid verify cleared the count: the next refusals reach verify (${st.verifiesBy.get(short.address)})`);

  // EVM unchanged: every attempt reaches verify, the Base hint and its 60 s.
  const evmBefore = st.evmVerifies;
  let last = null;
  for (let i = 0; i < HOLD_AFTER() + 2; i++) {
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted: evmAccept,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: EVM_PAYER, to: evmAccept.payTo, value: evmAccept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (i + 1).toString(16).padStart(64, "0") } } })).toString("base64");
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: BODY });
    last = { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.json().catch(() => ({})) };
  }
  ok(st.evmVerifies - evmBefore === HOLD_AFTER() + 2, `EVM: every attempt reached verify (${st.evmVerifies - evmBefore})`);
  ok(last.status === 402 && last.body.retry === "fund-wallet" && last.retryAfter === "60" && /on Base|another network/.test(last.body.hint) && !/Solana/.test(last.body.hint), `EVM: the same Base funding hint and Retry-After 60 (${last.retryAfter}: ${last.body.hint})`);

  // The operator view counts refusals and held answers by network and reason.
  const op = await (await fetch(`${B}/__operator/tool-failures.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
  const rowS = (op.fundingRefusals || []).find((r) => r.network === SOL && r.reason === "insufficient-funds");
  const rowN = (op.fundingRefusals || []).find((r) => r.network === SOL && r.reason === "no-token-account");
  ok(rowS && rowS.day.refused === HOLD_AFTER() + 3 && rowS.day.held === 1 && rowN && rowN.day.refused === 1 && rowN.day.held === 0, `operator: refused and held by network and reason (${JSON.stringify(op.fundingRefusals)})`);
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || e);
} finally {
  proc.kill("SIGKILL"); facilitator.close();
}
if (failed) { console.error("--- server output (last lines) ---"); for (const l of log.slice(-60)) console.error(l); }
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
