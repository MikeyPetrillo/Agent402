// Offline proof for src/svm-clarify.js — the module that turns PayAI's
// misleading "confirmation timed out" into "insufficient funds" when, and only
// when, the chain says the payer cannot afford the call.
//
// The asymmetry to protect: relabelling a failure the buyer COULD afford (or
// one with a specific cause) invents a diagnosis and points the operator at
// the wrong fix. Keeping a vague reason merely stays vague — that is the safe
// direction, so null is always the answer under any doubt.
import { clarifySvmSettleFailure } from "../src/svm-clarify.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PAYER = "TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TIMEOUT_REASON = "settle_exact_svm_transaction_confirmation_timed_out";
const REQ = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "2000", asset: MINT };

/** Stub RPC returning the given atomic balances (one token account each). */
const rpcWith = (amounts, { httpFail = false, reject = false } = {}) => async () => {
  if (reject) throw new Error("rpc down");
  if (httpFail) return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => ({
    result: { value: amounts.map((a) => ({ account: { data: { parsed: { info: { tokenAmount: { amount: a } } } } } })) },
  }) };
};

const run = (over = {}) => clarifySvmSettleFailure({
  network: REQ.network, reason: TIMEOUT_REASON, payer: PAYER, requirements: REQ,
  rpcs: ["stub://rpc"], timeoutMs: 500, fetchImpl: rpcWith(["0"]), ...over,
});

// 1. The real case: timeout reason, wallet at zero, price $0.002.
{
  const r = await run();
  ok(r && r.reason === "insufficient_funds", `zero balance + timeout reason -> insufficient_funds (${r && r.reason})`);
  ok(r && /0 USDC/.test(r.message) && /0\.002/.test(r.message),
    "message names the measured balance and the price");
  ok(r && r.message.includes(TIMEOUT_REASON),
    "the facilitator's original reason is preserved in the message, not erased");
}

// 2. Balance below price but not zero — still a measured insufficiency.
{
  const r = await run({ fetchImpl: rpcWith(["1999"]) });
  ok(r && r.reason === "insufficient_funds", "1999 atomic vs 2000 required -> clarified");
}

// 3. Balance EXACTLY covers the price: the failure was not about funds.
{
  ok((await run({ fetchImpl: rpcWith(["2000"]) })) === null,
    "balance == price -> null (never claim what the chain does not show)");
  ok((await run({ fetchImpl: rpcWith(["5000000"]) })) === null,
    "a funded wallet keeps the original reason");
}

// 4. Balances sum across multiple token accounts — splitting funds must not
//    trigger a false insufficiency.
{
  ok((await run({ fetchImpl: rpcWith(["1000", "1500"]) })) === null,
    "two accounts totalling 2500 >= 2000 -> null");
}

// 5. SPECIFIC reasons are never overwritten, however broke the wallet is.
{
  for (const reason of ["invalid_signature", "wallet_blocked", "expired_authorization"]) {
    ok((await run({ reason })) === null, `specific reason "${reason}" is left alone`);
  }
}

// 6. Fail safe: an unreadable balance changes nothing.
{
  ok((await run({ fetchImpl: rpcWith([], { reject: true }) })) === null, "RPC throwing -> null");
  ok((await run({ fetchImpl: rpcWith([], { httpFail: true }) })) === null, "RPC non-200 -> null");
}

// 7. Zero token accounts IS a real answer: no account = no funds.
{
  const r = await run({ fetchImpl: rpcWith([]) });
  ok(r && r.reason === "insufficient_funds", "no token accounts at all -> insufficient_funds");
}

// 8. Scope guards — wrong network, missing payer, unpriceable requirements.
{
  ok((await run({ network: "eip155:8453" })) === null, "non-solana network -> null");
  ok((await run({ payer: null })) === null, "no payer -> null");
  ok((await run({ requirements: { asset: MINT } })) === null, "no amount -> null");
  ok((await run({ requirements: { amount: "2000" } })) === null, "no mint -> null");
  ok((await run({ requirements: { ...REQ, amount: "0.002" } })) === null,
    "a non-atomic amount string is refused rather than misparsed");
}

// 9. First RPC dead, second alive — the fallback chain works.
{
  let calls = 0;
  const impl = async (url, init) => {
    calls++;
    if (calls === 1) throw new Error("first rpc down");
    return rpcWith(["0"])(url, init);
  };
  const r = await clarifySvmSettleFailure({
    network: REQ.network, reason: TIMEOUT_REASON, payer: PAYER, requirements: REQ,
    rpcs: ["stub://one", "stub://two"], timeoutMs: 500, fetchImpl: impl,
  });
  ok(r && r.reason === "insufficient_funds" && calls === 2,
    `walks to the second RPC when the first fails (calls: ${calls})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
