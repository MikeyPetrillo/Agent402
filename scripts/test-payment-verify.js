// Offline proof for src/payment-verify.js — the gate that must confirm we were
// actually paid before any refund leaves.
//
// The asymmetry that shapes every case: withholding a real refund costs a
// delay and stays visible in the ledger; paying an unreal one costs money and
// is invisible. So every uncertainty must resolve to verified:false.
//
// The scenario this exists for is not a hostile buyer (the settle receipt is
// unforgeable) but a WRONG FACILITATOR. We proved one can misreport this week:
// Stellar reported settle_channel_service_failed for transfers that confirmed.
// The mirror — success reported for a transfer that reverted or never landed —
// would refund money we never received.
import { verifyInboundPayment } from "../src/payment-verify.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYTO = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX = "0x" + "ab".repeat(32);
const NET = "eip155:8453";
const topic = (addr) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
const ACCEPTS = { [NET]: { payTo: PAYTO, asset: TOKEN } };

/** Stub EVM RPC: a receipt with the given logs, and decimals() = 6. */
const evmRpc = ({ status = "0x1", logs = null, noReceipt = false, throwOn = null } = {}) => async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  if (throwOn === method) throw new Error("rpc down");
  if (method === "eth_getTransactionReceipt") {
    return { ok: true, json: async () => ({ result: noReceipt ? null : { status, logs: logs ?? [defaultLog()] } }) };
  }
  if (method === "eth_call") return { ok: true, json: async () => ({ result: "0x06" }) }; // 6 decimals
  return { ok: true, json: async () => ({ result: null }) };
};
const defaultLog = (over = {}) => ({
  address: TOKEN,
  topics: [TRANSFER, topic(PAYER), topic(PAYTO)],
  data: "0x" + (1000n).toString(16).padStart(64, "0"),   // 0.001 at 6dp
  ...over,
});

const run = (over = {}, rpcOpts = {}) => verifyInboundPayment({
  network: NET, payer: PAYER, amountUsd: 0.001, tx: TX, createdAt: Date.now(),
  acceptsFor: (n) => ACCEPTS[n], rpcFor: () => "stub://rpc",
  fetchImpl: evmRpc(rpcOpts), timeoutMs: 500, ...over,
});

// 1. The honest case: right token, right payer, right recipient, enough value.
{
  const r = await run();
  ok(r.verified === true, `a real inbound payment verifies (${r.reason || "ok"})`);
  ok(r.movedAtomic === "1000", "reports what actually moved");
}

// 2. THE ONE THAT COSTS MONEY: the facilitator said success, the transaction
//    reverted. No tokens moved; refunding would be a pure loss.
{
  const r = await run({}, { status: "0x0" });
  ok(r.verified === false && /did not succeed/.test(r.reason), "a REVERTED transaction never verifies");
}

// 3. Transaction not on chain at all (broadcast claimed, nothing landed).
{
  const r = await run({}, { noReceipt: true });
  ok(r.verified === false && /not found/.test(r.reason), "a missing transaction never verifies");
}

// 4. Money moved, but NOT to us. Paying a third party must not unlock a refund
//    from our wallet.
{
  const r = await run({}, { logs: [defaultLog({ topics: [TRANSFER, topic(PAYER), topic(OTHER)] })] });
  ok(r.verified === false && /no transfer from this payer to our payTo/.test(r.reason),
    "a transfer to someone else is not our payment");
}

// 5. Money moved to us, but from a DIFFERENT wallet than the one we would
//    repay - refunding the wrong party is still a loss.
{
  const r = await run({}, { logs: [defaultLog({ topics: [TRANSFER, topic(OTHER), topic(PAYTO)] })] });
  ok(r.verified === false, "a transfer from a different payer does not justify repaying this one");
}

// 6. Right parties, WRONG TOKEN - a worthless token to our address must not
//    unlock a USDC refund.
{
  const r = await run({}, { logs: [defaultLog({ address: OTHER })] });
  ok(r.verified === false, "a transfer of a different token is ignored");
}

// 7. Short payment: they sent less than the debt claims.
{
  const r = await run({}, { logs: [defaultLog({ data: "0x" + (999n).toString(16).padStart(64, "0") })] });
  ok(r.verified === false && /short/.test(r.reason), "an underpayment does not verify");
}

// 8. Overpayment verifies — premium-priced chains quote MORE than list, and
//    the debt is recorded at list.
{
  const r = await run({}, { logs: [defaultLog({ data: "0x" + (2000n).toString(16).padStart(64, "0") })] });
  ok(r.verified === true, "paying more than the recorded debt still verifies");
}

// 9. Decimals are READ, not assumed. With 18-decimal accounting the same
//    "1000" is a millionth of the expected value.
{
  const rpc18 = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === "eth_call") return { ok: true, json: async () => ({ result: "0x12" }) }; // 18
    return { ok: true, json: async () => ({ result: { status: "0x1", logs: [defaultLog()] } }) };
  };
  const r = await verifyInboundPayment({
    network: NET, payer: PAYER, amountUsd: 0.001, tx: TX, createdAt: Date.now(),
    acceptsFor: (n) => ACCEPTS[n], rpcFor: () => "stub://rpc", fetchImpl: rpc18, timeoutMs: 500,
  });
  ok(r.verified === false && /short/.test(r.reason), "an 18-decimal token is measured on its own scale, not assumed 6");
}

// 10. Fail closed on infrastructure trouble - never "probably fine".
{
  ok((await run({}, { throwOn: "eth_getTransactionReceipt" })).verified === false, "RPC failure -> unverified");
  ok((await run({}, { throwOn: "eth_call" })).verified === false, "decimals read failure -> unverified");
  ok((await run({ rpcFor: () => null })).verified === false, "no RPC configured -> unverified");
  ok((await run({ acceptsFor: () => null })).verified === false, "no live payTo -> unverified");
}

// 11. Malformed inputs never pass.
{
  ok((await run({ tx: "not-a-hash" })).verified === false, "a junk tx hash -> unverified");
  ok((await run({ tx: null })).verified === false, "a missing tx hash -> unverified");
  ok((await run({ payer: "GSTELLARADDR" })).verified === false, "a non-EVM payer on an EVM rail -> unverified");
  ok((await run({ amountUsd: 0 })).verified === false, "a zero expected amount -> unverified");
}

// 12. Stellar routes to the injected confirmer, and an unconfirmed one holds.
{
  const netS = "stellar:pubnet";
  const acc = { [netS]: { payTo: "GPAYTO" } };
  const yes = await verifyInboundPayment({
    network: netS, payer: "GBUYER", amountUsd: 0.001, createdAt: Date.now(),
    acceptsFor: (n) => acc[n], stellarConfirm: async () => ({ transaction: "STXHASH", amount: "0.001" }),
  });
  ok(yes.verified === true && yes.tx === "STXHASH", "stellar verifies through the shared confirmer");
  const no = await verifyInboundPayment({
    network: netS, payer: "GBUYER", amountUsd: 0.001, createdAt: Date.now(),
    acceptsFor: (n) => acc[n], stellarConfirm: async () => null,
  });
  ok(no.verified === false, "an unconfirmed stellar payment holds the debt");

  // The Stellar confirmer answers "did this payer pay us near this time",
  // which is weaker than resolving a specific hash. Unbound, ONE genuine
  // payment could vouch for a DIFFERENT debt from the same buyer in the same
  // window - counted twice, refunded twice.
  const A = "a".repeat(64), B = "b".repeat(64);
  const mismatch = await verifyInboundPayment({
    network: netS, payer: "GBUYER", amountUsd: 0.001, tx: A, createdAt: Date.now(),
    acceptsFor: (n) => acc[n], stellarConfirm: async () => ({ transaction: B, amount: "0.001" }),
  });
  ok(mismatch.verified === false && /different transaction/.test(mismatch.reason),
    "a confirmed payment that is NOT this debt's transaction cannot vouch for it");
  const match = await verifyInboundPayment({
    network: netS, payer: "GBUYER", amountUsd: 0.001, tx: A, createdAt: Date.now(),
    acceptsFor: (n) => acc[n], stellarConfirm: async () => ({ transaction: A, amount: "0.001" }),
  });
  ok(match.verified === true, "the debt's own transaction verifies it");
}

// 13. SOLANA. Balances are compared per OWNER pre/post, because a payer may
//     use a non-default token account and matching on derived addresses would
//     miss it.
{
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SPAYER = "TeStKWyNPayer", SPAYTO = "J7aNOurWallet";
  const bal = (owner, amount) => ({ owner, mint: MINT, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const solRpc = (meta) => async () => ({ ok: true, json: async () => ({ result: meta === null ? null : { meta } }) });
  const good = { err: null, preTokenBalances: [bal(SPAYTO, 0), bal(SPAYER, 5000)], postTokenBalances: [bal(SPAYTO, 1000), bal(SPAYER, 4000)] };
  const solRun = (meta, over = {}) => verifyInboundPayment({
    network: "solana:5eykt4", payer: SPAYER, amountUsd: 0.001, tx: "S".repeat(80),
    acceptsFor: () => ({ payTo: SPAYTO, asset: MINT }), solanaRpcs: ["stub://sol"],
    fetchImpl: solRpc(meta), timeoutMs: 500, ...over,
  });

  ok((await solRun(good)).verified === true, "a real Solana payment verifies");
  ok((await solRun({ ...good, err: { InstructionError: [2, { Custom: 1 }] } })).verified === false,
    "a FAILED Solana txn never verifies (this is the insufficient-funds shape we saw live)");
  ok((await solRun({ ...good, postTokenBalances: [bal(SPAYTO, 0), bal(SPAYER, 4000)] })).verified === false,
    "our payTo not credited -> unverified");
  ok((await solRun({ ...good, preTokenBalances: [bal(SPAYTO, 0), bal(SPAYER, 4000)] })).verified === false,
    "this payer not debited -> unverified");
  ok((await solRun({ ...good, postTokenBalances: [bal(SPAYTO, 999), bal(SPAYER, 4001)] })).verified === false,
    "a short Solana transfer -> unverified");
  ok((await solRun(null)).verified === false, "a missing Solana transaction -> unverified");
  ok((await solRun(good, { tx: "short" })).verified === false, "a junk signature -> unverified");
}

// 14. ALGORAND. The indexer stores only confirmed transactions, but sender,
//     receiver, ASA and amount are all still checked against the debt.
{
  const APAYER = "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE";
  const APAYTO = "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE";
  const txn = (over = {}) => ({ transaction: {
    "confirmed-round": 63718052, sender: APAYER,
    "asset-transfer-transaction": { "asset-id": 31566704, amount: 1000, receiver: APAYTO },
    ...over } });
  const idx = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
  const algoRun = (body, over = {}) => verifyInboundPayment({
    network: "algorand:wGHE2Pw", payer: APAYER, amountUsd: 0.001, tx: "A".repeat(52),
    acceptsFor: () => ({ payTo: APAYTO, asset: "31566704" }), algorandIndexers: ["stub://idx"],
    fetchImpl: idx(body), timeoutMs: 500, ...over,
  });

  ok((await algoRun(txn())).verified === true, "a real Algorand payment verifies");
  ok((await algoRun(txn({ sender: "SOMEONEELSE" }))).verified === false, "a different sender -> unverified");
  ok((await algoRun(txn({ "asset-transfer-transaction": { "asset-id": 31566704, amount: 1000, receiver: "NOTUS" } }))).verified === false,
    "a receiver that is not our payTo -> unverified");
  ok((await algoRun(txn({ "asset-transfer-transaction": { "asset-id": 999, amount: 1000, receiver: APAYTO } }))).verified === false,
    "the WRONG ASA (any token can be minted on Algorand) -> unverified");
  ok((await algoRun(txn({ "asset-transfer-transaction": { "asset-id": 31566704, amount: 999, receiver: APAYTO } }))).verified === false,
    "a short Algorand transfer -> unverified");
  ok((await algoRun(txn({ "confirmed-round": 0 }))).verified === false, "an unconfirmed transaction -> unverified");
  ok((await algoRun({})).verified === false, "an empty indexer response -> unverified");
  ok((await algoRun(txn({ "asset-transfer-transaction": undefined }))).verified === false,
    "a non-asset-transfer (e.g. a plain ALGO payment) -> unverified");
}

// 15. A FUTURE family with no verifier still HOLDS - unverifiable is not
//     unpaid, and the row must not be silently written off.
{
  const r = await verifyInboundPayment({
    network: "cosmos:hub-4", payer: "cosmos1abc", amountUsd: 0.001,
    acceptsFor: () => ({ payTo: "cosmos1ours", asset: "uusdc" }),
  });
  ok(r.verified === false && /no on-chain verifier/.test(r.reason) && /held, not written off/.test(r.reason),
    "an unsupported family holds the debt and says why");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
