#!/usr/bin/env node
// The refund job's Tempo and Solana senders, and the order every send obeys.
//
//   node scripts/test-refund-run-chains.js      (offline: stubs and a local RPC stub only)
//
// No key is real, no RPC is public, no money can move. Pins:
//   - a Tempo debt (booked under "tempo") and a Solana debt plan as sends when
//     their keys are set, and hold with the reason named when they are not,
//     under the same per-refund, per-run and per-payer caps as every chain;
//   - a dry run prints the plan and touches nothing: no proof, no claim, no send;
//   - a live run proves the inbound payment, reads what the send needs, CLAIMS
//     the row, sends once per debt, proves the refund on chain (Tempo, Solana)
//     and only then marks it paid;
//   - a crash between the send and its proof leaves the row `sending`, and a
//     rerun never sends it again; an unproven send is never marked paid;
//   - a void debt, or one whose evidence carries a void mark, is never sent;
//   - the Tempo verifier (src/payment-verify.js) proves the payer, our payTo,
//     an offered currency and the amount, counting a Transfer and its
//     TransferWithMemo twin once;
//   - the job reads our Tempo payTo and currencies from the live challenge.
import http from "node:http";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

process.env.AGENT402_OPERATOR_TOKEN ||= "test-operator-token";
const rr = await import("./refund-run.js");
const { planRefunds, familyOf, normalizeNetwork, executeRefunds, refundRun, proveRefundSent, parseTempoOffer, tempoRefundMemo, TEMPO_NETWORK, SOLANA_NETWORK, OUTBOUND_PROOF_FAMILIES } = rr;
const { verifyInboundPayment, TIP20_TRANSFER_WITH_MEMO_TOPIC } = await import("../src/payment-verify.js");
const { TRANSFER_WITH_MEMO_TOPIC } = await import("../src/tempo-confirm.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const nopause = async () => {};

const hex64 = (c) => `0x${c.repeat(64)}`;
const TEMPO_BUYER = "0x" + "ab".repeat(20);
const SOL_BUYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ROWS = () => [
  { id: 1, slug: "hash", network: "tempo", payer: TEMPO_BUYER, priceUsd: 0.01, evidence: hex64("1"), status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 502 },
  { id: 2, slug: "hash", network: "solana", payer: SOL_BUYER, priceUsd: 0.02, evidence: "5".repeat(88), status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 500 },
  { id: 3, slug: "hash", network: "eip155:8453", payer: "0x" + "cd".repeat(20), priceUsd: 0.01, evidence: hex64("3"), status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 500 },
];
const ALL_SENDERS = { evm: true, stellar: true, algorand: true, tempo: true, solana: true };

// ---- planning ----------------------------------------------------------------
{
  ok(normalizeNetwork("tempo") === TEMPO_NETWORK && familyOf(TEMPO_NETWORK) === "tempo", "a debt booked under \"tempo\" is eip155:4217, its own family (never the generic EVM sender)");
  ok(familyOf("eip155:8453") === "evm" && familyOf(normalizeNetwork("solana")) === "solana" && normalizeNetwork("solana") === SOLANA_NETWORK, "control: Base stays evm, solana normalizes to its CAIP-2");
  const p = planRefunds(ROWS(), { senders: ALL_SENDERS, maxEachUsd: 0.25, maxTotalUsd: 2, maxPerPayerUsd: 0.5 });
  ok(p.send.length === 3 && p.send.some((r) => r.network === TEMPO_NETWORK) && p.send.some((r) => r.network === SOLANA_NETWORK), "with keys set, Tempo and Solana debts plan as sends");
  const noKeys = planRefunds(ROWS(), { senders: { evm: true }, maxEachUsd: 0.25, maxTotalUsd: 2, maxPerPayerUsd: 0.5 });
  ok(noKeys.send.length === 1 && Object.keys(noKeys.held).some((k) => /no sender\/key for tempo/.test(k)) && Object.keys(noKeys.held).some((k) => /no sender\/key for solana/.test(k)), "without their keys they hold, the debt kept, the reason named");
  const caps = planRefunds([
    { ...ROWS()[0], id: 10, priceUsd: 0.3 },
    { ...ROWS()[0], id: 11, priceUsd: 0.2 }, { ...ROWS()[0], id: 12, priceUsd: 0.2 }, { ...ROWS()[0], id: 13, priceUsd: 0.2 },
    { ...ROWS()[1], id: 14, priceUsd: 0.2 },
  ], { senders: ALL_SENDERS, maxEachUsd: 0.25, maxTotalUsd: 0.5, maxPerPayerUsd: 0.4 });
  const reasons = Object.keys(caps.held).join(" | ");
  ok(caps.send.map((r) => r.id).join(",") === "11,12" && /over per-refund cap/.test(reasons) && /per-payer cap/.test(reasons) && /run total would exceed/.test(reasons), `the per-refund, per-payer and per-run caps bind Tempo and Solana rows too (${reasons})`);
  const statuses = planRefunds([{ ...ROWS()[0], status: "void" }, { ...ROWS()[1], status: "sending" }, { ...ROWS()[0], id: 9, status: "paid" }], { senders: ALL_SENDERS });
  ok(statuses.send.length === 0, "a void, sending or paid row is never planned");
}

// ---- a fake ledger with the server's claim rules ------------------------------
function fakeLedger(rows, { voidMarks = [] } = {}) {
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const marks = new Set(voidMarks);
  const evidence = new Map(rows.map((r) => [r.id, r.evidence]));
  return {
    status,
    claim: async (id) => { if (status.get(id) !== "owed" || marks.has(evidence.get(id))) return false; status.set(id, "sending"); return true; },
    markPaid: async (id, tx) => { if (status.get(id) !== "sending" || !tx) throw new Error("mark-paid refused"); status.set(id, "paid"); },
    owedRows: () => rows.filter((r) => status.get(r.id) === "owed").map((r) => ({ ...r, status: "owed" })),
  };
}
function stubDeps(ledger, { prove = async () => ({ verified: true }), prepare = async (row) => ({ from: "ours", asset: "token", rpcUrl: "x", row: row.id }) } = {}) {
  const calls = { verify: [], prepare: [], send: [], prove: [], order: [] };
  return {
    calls,
    deps: {
      verifyInbound: async (row) => { calls.verify.push(row.id); calls.order.push(`verify:${row.id}`); return { verified: true, token: "0x20c000000000000000000000b9537d11c60e8b50", decimals: 6 }; },
      prepare: async (row, proof) => { calls.prepare.push(row.id); calls.order.push(`prepare:${row.id}`); return prepare(row, proof); },
      claim: async (id) => { calls.order.push(`claim:${id}`); return ledger.claim(id); },
      send: async (row) => { calls.send.push(row.id); calls.order.push(`send:${row.id}`); return `tx-${row.id}-${calls.send.length}`; },
      prove: async (row, tx, prep) => { calls.prove.push(row.id); calls.order.push(`prove:${row.id}`); return prove(row, tx, prep); },
      markPaid: async (id, tx) => { calls.order.push(`paid:${id}`); return ledger.markPaid(id, tx); },
      pause: nopause,
    },
  };
}
const planOptions = { senders: ALL_SENDERS, maxEachUsd: 0.25, maxTotalUsd: 2, maxPerPayerUsd: 0.5 };

// ---- dry run -------------------------------------------------------------------
{
  const ledger = fakeLedger(ROWS());
  const { calls, deps } = stubDeps(ledger);
  let built = 0;
  const out = await refundRun({ rows: ROWS(), live: false, planOptions, deps: async () => { built++; return deps; }, log: quiet });
  ok(out.executed === false && out.plan.send.length === 3, "a dry run plans the three sends");
  ok(built === 0 && !calls.verify.length && !calls.send.length && [...ledger.status.values()].every((s) => s === "owed"), "and touches nothing: no chain read, no claim, no send");
}

// ---- live run: once per debt, in order ------------------------------------------
{
  const ledger = fakeLedger(ROWS());
  const { calls, deps } = stubDeps(ledger);
  const out = await refundRun({ rows: ROWS(), live: true, planOptions, deps, log: quiet });
  ok(out.result.ok === 3 && calls.send.join(",") === "1,2,3", `a confirmed run calls the sender once per debt (${calls.send.join(",")})`);
  ok([...ledger.status.values()].every((s) => s === "paid"), "every row ends paid");
  const tempoOrder = calls.order.filter((x) => x.endsWith(":1")).join(" ");
  ok(tempoOrder === "verify:1 prepare:1 claim:1 send:1 prove:1 paid:1", `Tempo: inbound proof, prepare, CLAIM, send, outbound proof, paid (${tempoOrder})`);
  ok(calls.order.filter((x) => x.endsWith(":2")).join(" ") === "verify:2 prepare:2 claim:2 send:2 prove:2 paid:2", "Solana: the same order");
  ok(!calls.prove.includes(3) && calls.order.filter((x) => x.endsWith(":3")).join(" ") === "verify:3 prepare:3 claim:3 send:3 paid:3", "the EVM path is unchanged (no outbound proof step)");
  ok(OUTBOUND_PROOF_FAMILIES.join(",") === "tempo,solana", "the families proven outbound are Tempo and Solana");
  // A second run over what the ledger now lists sends nothing.
  const again = await refundRun({ rows: ledger.owedRows(), live: true, planOptions, deps, log: quiet });
  ok(again.executed === false && calls.send.length === 3, "a rerun after a clean run sends nothing");
}

// ---- crash between send and proof ---------------------------------------------------
{
  const ledger = fakeLedger(ROWS());
  let crash = true;
  const { calls, deps } = stubDeps(ledger, { prove: async () => { if (crash) throw new Error("process died before the proof"); return { verified: true }; } });
  const first = await executeRefunds(planRefunds(ROWS(), planOptions).send, { ...deps, log: quiet });
  ok(first.failed === 2 && calls.send.join(",") === "1,2,3", "setup: the Tempo and Solana sends happened, then the run died before their proof");
  ok(ledger.status.get(1) === "sending" && ledger.status.get(2) === "sending", "the crashed rows stay 'sending' (claimed before the send)");
  crash = false;
  // A rerun from the ledger: the rows are no longer owed, so they are not planned.
  await refundRun({ rows: ledger.owedRows(), live: true, planOptions, deps, log: quiet });
  // A rerun handed the same rows anyway (a stale listing): the claim refuses them.
  const stale = await executeRefunds(planRefunds(ROWS(), planOptions).send, { ...deps, log: quiet });
  ok(calls.send.filter((id) => id === 1).length === 1 && calls.send.filter((id) => id === 2).length === 1, `a rerun never sends a crashed row again (sends: ${calls.send.join(",")})`);
  ok(stale.unverified === 3 && stale.ok === 0, "a stale rerun holds every row it cannot claim");
}

// ---- an unproven send is never marked paid ----------------------------------------------
{
  const ledger = fakeLedger(ROWS().slice(0, 2));
  const { calls, deps } = stubDeps(ledger, { prove: async () => ({ verified: false, reason: "transaction not found on chain" }) });
  const out = await executeRefunds(planRefunds(ROWS().slice(0, 2), planOptions).send, { ...deps, log: quiet });
  ok(out.stuck === 2 && out.ok === 0 && ledger.status.get(1) === "sending" && ledger.status.get(2) === "sending", "a refund that cannot be proven on chain stays 'sending', never marked paid");
  await executeRefunds(planRefunds(ROWS().slice(0, 2), planOptions).send, { ...deps, log: quiet });
  ok(calls.send.length === 2, "and is never sent again");
}

// ---- void debts are never sent ---------------------------------------------------------
{
  const rows = ROWS();
  const ledger = fakeLedger(rows, { voidMarks: [rows[0].evidence] });
  const { calls, deps } = stubDeps(ledger);
  const out = await executeRefunds(planRefunds(rows, planOptions).send, { ...deps, log: quiet });
  ok(!calls.send.includes(1) && ledger.status.get(1) === "owed" && out.unverified === 1, "a Tempo debt whose evidence carries a void mark is refused at the claim and never sent");
  ok(calls.send.includes(2) && calls.send.includes(3), "control: the unmarked debts are sent");
  const voided = fakeLedger([{ ...rows[0], status: "void" }]);
  const v = stubDeps(voided);
  await refundRun({ rows: [{ ...rows[0], status: "void" }], live: true, planOptions, deps: v.deps, log: quiet });
  await executeRefunds([{ ...rows[0], status: "owed" }], { ...v.deps, log: quiet }); // a stale listing that still says owed
  ok(v.calls.send.length === 0 && voided.status.get(1) === "void", "a void row is not planned, and a stale listing of it cannot claim it");
}

// ---- a refusal while preparing leaves the row owed ----------------------------------
{
  const ledger = fakeLedger(ROWS().slice(0, 1));
  const { calls, deps } = stubDeps(ledger, { prepare: async () => { throw new Error("the payer holds no USDC account"); } });
  const out = await executeRefunds(planRefunds(ROWS().slice(0, 1), planOptions).send, { ...deps, log: quiet });
  ok(out.failed === 1 && ledger.status.get(1) === "owed" && !calls.send.length && !calls.order.some((x) => x.startsWith("claim")), "a send that cannot be prepared claims nothing and sends nothing (the row stays owed)");
}

// ---- an unverified inbound payment is never claimed -------------------------------------
{
  const ledger = fakeLedger(ROWS().slice(0, 1));
  const { calls, deps } = stubDeps(ledger);
  const out = await executeRefunds(planRefunds(ROWS().slice(0, 1), planOptions).send, { ...deps, verifyInbound: async () => ({ verified: false, reason: "no transfer" }), log: quiet });
  ok(out.unverified === 1 && ledger.status.get(1) === "owed" && !calls.send.length, "an unproven inbound payment is held, unclaimed and unsent");
}

// ---- proveRefundSent: the inbound check reversed, polled ---------------------------------
{
  const seen = [];
  let n = 0;
  const verify = async (o) => { seen.push(o); n++; return n < 3 ? { verified: false, reason: "not yet" } : { verified: true }; };
  const r = await proveRefundSent({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, priceUsd: 0.01 }, hex64("e"), { from: "0x" + "ee".repeat(20), asset: "0xtoken", rpcUrl: "http://rpc" }, { verify, attempts: 5, pause: nopause });
  const o = seen[0];
  ok(r.verified && n === 3, "the outbound proof is polled until the transfer is visible");
  ok(o.payer === "0x" + "ee".repeat(20) && [...o.payToSetFor()].join() === TEMPO_BUYER && o.acceptsFor().payTo === TEMPO_BUYER && o.tx === hex64("e") && o.amountUsd === 0.01, "it proves a transfer FROM our wallet TO the payer, for the debt, in the refund tx");
  const never = await proveRefundSent({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, priceUsd: 0.01 }, hex64("e"), { from: "0x1" }, { verify: async () => ({ verified: false, reason: "x" }), attempts: 3, pause: nopause });
  ok(!never.verified, "and reports unproven after its attempts");
}

// ---- the Tempo verifier against a local RPC stub ----------------------------------------
{
  ok(TIP20_TRANSFER_WITH_MEMO_TOPIC === TRANSFER_WITH_MEMO_TOPIC, "the verifier's TransferWithMemo topic is the one tempo-confirm derives");
  const USDCE = "0x20C000000000000000000000b9537d11c60E8b50";
  const PATHUSD = "0x20c0000000000000000000000000000000000000";
  const OTHER = "0x20c0000000000000000000000000000000000099";
  const PAYTO = "0x" + "11".repeat(20);
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
  const amt = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
  const memo = hex64("9");
  const both = (token, from, to, v) => [
    { address: token, topics: [TRANSFER, topic(from), topic(to)], data: amt(v) },
    { address: token, topics: [TRANSFER_WITH_MEMO_TOPIC, topic(from), topic(to), memo], data: amt(v) },
  ];
  const receipts = {
    [hex64("a")]: { status: "0x1", logs: both(USDCE, TEMPO_BUYER, PAYTO, 10_000) },
    [hex64("b")]: { status: "0x1", logs: both(USDCE, TEMPO_BUYER, PAYTO, 6_000) },
    [hex64("c")]: { status: "0x1", logs: both(OTHER, TEMPO_BUYER, PAYTO, 10_000) },
    [hex64("d")]: { status: "0x0", logs: both(USDCE, TEMPO_BUYER, PAYTO, 10_000) },
    [hex64("f")]: { status: "0x1", logs: both(USDCE, TEMPO_BUYER, "0x" + "22".repeat(20), 10_000) },
    [hex64("7")]: { status: "0x1", logs: both(PATHUSD, TEMPO_BUYER, PAYTO, 10_000) },
    [hex64("6")]: { status: "0x1", logs: both(USDCE, "0x" + "33".repeat(20), PAYTO, 10_000) },
  };
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
      const { method, params, id } = JSON.parse(b || "{}");
      const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
      if (method === "eth_getTransactionReceipt") return reply(receipts[params[0]] || null);
      if (method === "eth_call") return reply(amt(6));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "not in stub" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const offer = { payTo: PAYTO, asset: USDCE, assets: [USDCE, PATHUSD] };
  const v = (tx, amountUsd = 0.01) => verifyInboundPayment({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, amountUsd, tx, acceptsFor: () => offer, rpcFor: () => rpcUrl });
  try {
    const good = await v(hex64("a"));
    ok(good.verified && good.movedAtomic === "10000" && good.token === USDCE.toLowerCase() && good.decimals === 6, `a USDC.e payment of the debt verifies and names its token (${JSON.stringify(good)})`);
    ok((await v(hex64("a"), 0.015)).verified === false, "a Transfer and its TransferWithMemo twin count once (10000 does not cover 15000)");
    ok(/short/.test((await v(hex64("b"))).reason), "a short payment is refused");
    ok(/no transfer/.test((await v(hex64("c"))).reason), "a token our challenge does not offer is refused");
    ok(/did not succeed/.test((await v(hex64("d"))).reason), "a reverted transaction is refused");
    ok(/no transfer/.test((await v(hex64("f"))).reason), "a payment to someone else is refused");
    ok(/no transfer/.test((await v(hex64("6"))).reason), "a payment to us from another wallet is refused (it is not this payer's)");
    const path = await v(hex64("7"));
    ok(path.verified && path.token === PATHUSD, "a PathUSD payment verifies and names PathUSD (the refund goes back in it)");
    ok(/not found/.test((await v(hex64("8"))).reason), "a transaction the chain does not have is refused");
    ok(/no RPC/.test((await verifyInboundPayment({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, amountUsd: 0.01, tx: hex64("a"), acceptsFor: () => offer, rpcFor: () => null })).reason), "no RPC: held, never assumed");
    ok(/no live payTo/.test((await verifyInboundPayment({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, amountUsd: 0.01, tx: hex64("a"), acceptsFor: () => null, rpcFor: () => rpcUrl })).reason), "no live Tempo offer: held");
    // The same verifier proves a refund (reversed direction), as proveRefundSent runs it.
    receipts[hex64("e")] = { status: "0x1", logs: both(USDCE, "0x" + "ee".repeat(20), TEMPO_BUYER, 10_000) };
    const out = await proveRefundSent({ network: TEMPO_NETWORK, payer: TEMPO_BUYER, priceUsd: 0.01 }, hex64("e"), { from: "0x" + "ee".repeat(20), asset: USDCE, rpcUrl }, { verify: verifyInboundPayment, attempts: 1, pause: nopause });
    ok(out.verified, "a sent Tempo refund is proven on chain by the same verifier");
  } finally { server.close(); }
}

// ---- our Tempo offer, read from the live challenge ---------------------------------------
{
  const { Challenge } = await import("mppx");
  const mk = (id, currency, recipient, chainId = 4217) => Challenge.serialize(Challenge.from({ id, realm: "agent402.tools", method: "tempo", intent: "charge", request: { amount: "1000", currency, recipient, methodDetails: { chainId } } }));
  const R = "0x" + "11".repeat(20);
  const evm = Challenge.serialize(Challenge.from({ id: "e", realm: "agent402.tools", method: "evm", intent: "charge", request: { amount: "1" } }));
  const offer = await parseTempoOffer([mk("a", "0x20C000000000000000000000b9537d11c60E8b50", R), evm, mk("b", "0x20c0000000000000000000000000000000000000", R)].join(", "));
  ok(offer && offer.payTo === R && offer.network === TEMPO_NETWORK && offer.assets.length === 2, `the tempo challenges give our payTo and both currencies (${JSON.stringify(offer)})`);
  ok((await parseTempoOffer([mk("a", "0x20C000000000000000000000b9537d11c60E8b50", R), mk("b", "0x20c0000000000000000000000000000000000000", "0x" + "22".repeat(20))].join(", "))) === null, "two different recipients: no offer (fail closed)");
  ok((await parseTempoOffer(mk("a", "0x20C000000000000000000000b9537d11c60E8b50", R, 42431))) === null, "a challenge for another chain: no offer");
  ok((await parseTempoOffer(evm)) === null && (await parseTempoOffer("")) === null, "no tempo challenge: no offer");
  ok(Buffer.from(tempoRefundMemo().slice(2), "hex").toString("utf8").replace(/\0+$/, "") === "agent402 refund" && tempoRefundMemo().length === 66, "the Tempo refund memo is bytes32 \"agent402 refund\"");
}

// ---- wiring: the keys the job reads, and the workflow that passes them -------------------
{
  const src = readFileSync(new URL("./refund-run.js", import.meta.url), "utf8");
  ok(/^\s{4}tempo: !!\(process\.env\.REFUND_TEMPO_KEY \|\| ""\)\.trim\(\),$/m.test(src) && /^\s{4}solana: !!\(process\.env\.REFUND_SOLANA_KEY \|\| ""\)\.trim\(\),$/m.test(src), "the job enables Tempo and Solana from REFUND_TEMPO_KEY and REFUND_SOLANA_KEY");
  ok(/const out = await refundRun\(\{/.test(src) && /claim: claimForSend,/.test(src) && /markPaid,\n/.test(src), "main runs the tested executor with the real claim and mark-paid");
  ok(/prove: \(row, tx, prep\) => proveRefundSent\(row, tx, [^\n]*\{ verify: verifyInboundPayment \}\),/.test(src), "main proves a sent refund with the real on-chain verifier");
  const logLines = src.split("\n").filter((l) => /\b(console|log)\.(log|warn|error)\(/.test(l));
  ok(!logLines.some((l) => /\$\{(r|row)\.payer\}|\$\{(r|row)\.evidence\}|\$\{tx\}|\$\{sig\}|proof\.tx/.test(l)), "no log line prints a raw payer, evidence or tx");
  const wf = load(readFileSync(new URL("../.github/workflows/refund.yml", import.meta.url), "utf8"));
  const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((s) => s.name === "Run refunds");
  ok(/secrets\.REFUND_TEMPO_KEY/.test(String(step?.env?.REFUND_TEMPO_KEY || "")) && /secrets\.REFUND_SOLANA_KEY/.test(String(step?.env?.REFUND_SOLANA_KEY || "")), "refund.yml passes REFUND_TEMPO_KEY and REFUND_SOLANA_KEY from secrets");
  ok(/default: false/.test(readFileSync(new URL("../.github/workflows/refund.yml", import.meta.url), "utf8")) && /REFUND_LIVE: \$\{\{ inputs\.live && 'true' \|\| 'false' \}\}/.test(readFileSync(new URL("../.github/workflows/refund.yml", import.meta.url), "utf8")), "the workflow is still a dry run unless live is set at dispatch");
}

// ---- the job itself: without REFUND_LIVE it reads the listing and nothing else -------------
{
  const { spawn } = await import("node:child_process");
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    if (req.method === "GET" && req.url.startsWith("/__operator/refunds.json")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ refunds: ROWS(), totals: { owed: 3 } }));
    }
    res.statusCode = 500; res.end("{}");
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  for (const live of [undefined, "false"]) {
    seen.length = 0;
    const env = { ...process.env, TARGET_URL: `http://127.0.0.1:${stub.address().port}`, AGENT402_OPERATOR_TOKEN: "t", REFUND_TEMPO_KEY: "0x" + "11".repeat(32), REFUND_SOLANA_KEY: "x", REFUND_EVM_KEY: "0x" + "22".repeat(32) };
    if (live === undefined) delete env.REFUND_LIVE; else env.REFUND_LIVE = live;
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [new URL("./refund-run.js", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
      let s = ""; c.stdout.on("data", (d) => { s += d; }); c.stderr.on("data", (d) => { s += d; });
      c.on("exit", (code) => resolve({ code, s }));
    });
    ok(out.code === 0 && /DRY RUN - no money moved/.test(out.s) && seen.join(",") === "GET /__operator/refunds.json",
      `REFUND_LIVE=${live ?? "(unset)"}: the job is a dry run that reads only the listing (requests: ${seen.join(", ") || "none"}; exit ${out.code})`);
  }
  stub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
