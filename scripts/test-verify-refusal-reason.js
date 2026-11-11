#!/usr/bin/env node
// A payment refused at verify for lack of funds: what the buyer's 402 says on
// each rail, and what the log line says about who and where.
//
//   - the log line (src/verify-failure-log.js) carries the route's slug and a
//     shortened payer on one bounded line, keeps a base58 payer's case, and
//     never throws on a field that is missing or cannot be coerced;
//   - the hint (src/verify-hint.js) names the class in `reason`, says it in a
//     sentence with the price, and carries `needs` (network, asset, amount)
//     for each facilitator failure shape: EVM, Solana, Stellar, Algorand.
// The wire (a paid boot against a stub facilitator answering these shapes) is
// in scripts/test-svm-funding-refusal.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { verifyFailureLine, shortPayer, safeLogToken, safeLogText, payerNamedBy } from "../src/verify-failure-log.js";
import { hintFor, noteVerifyFailure, needsOf, assetDecimalsFor, verifyHintMiddleware, _testResetForTest } from "../src/verify-hint.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const noThrow = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: e }; } };

// Values that throw when a template literal or String() coerces them.
const HOSTILE = [{ toString: 1 }, { toString: 1, valueOf: 1 }, Object.create(null), Symbol("s"), { get network() { throw new Error("getter"); } }, [], [{ toString: 1 }], null, undefined, 12n, NaN, () => {}];

// ---- the log line ---------------------------------------------------------------------
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const B58 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // mixed case
{
  const line = verifyFailureLine({ verb: "failed", network: SOL, scheme: "exact", reason: "transaction_simulation_failed: InstructionError:[2 map[Custom:1]]", slug: "hash", payer: B58 });
  ok(line === `[payments] facilitator VERIFY failed on ${SOL} exact route=hash payer=7xKX: transaction_simulation_failed: InstructionError:[2 map[Custom:1]]`, `the line names network, scheme, slug and short payer (${line})`);
  ok(!line.includes(B58) && !line.includes(B58.slice(0, 8)), "the full address is never printed");
  ok(shortPayer(B58) === "7xKX" && shortPayer(B58) !== B58.slice(0, 4).toLowerCase() && shortPayer(B58.toLowerCase()) === "7xkx", "a base58 payer keeps its case in the short form");
  ok(shortPayer("GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37") === "GDQP", "a Stellar payer keeps its case");
  ok(shortPayer("0xAbCd000000000000000000000000000000000001") === "0xAbCd", "an EVM payer prints 0x and four hex digits, as written");
  {
    // The facilitator's text repeating the payer: cut to the short form. An
    // EVM address in any letter case; any other address only as written.
    const EVM = "0xAbCdEf0000000000000000000000000000c0FFee";
    for (const said of [EVM, EVM.toLowerCase(), "0x" + EVM.slice(2).toUpperCase()]) {
      const l = verifyFailureLine({ verb: "rejected", network: "eip155:8453", scheme: "exact", reason: `insufficient balance for ${said} (payer ${said})`, slug: "uuid", payer: EVM });
      ok(!l.toLowerCase().includes(EVM.toLowerCase().slice(6)) && l.includes("for 0xAbCd... (payer 0xAbCd...)"), `an EVM payer the facilitator writes as ${said.slice(0, 8)} is cut to the short form (${l.slice(-60)})`);
    }
    const b = verifyFailureLine({ network: SOL, scheme: "exact", reason: `account ${B58} has no token account`, slug: "hash", payer: B58 });
    ok(!b.includes(B58) && b.includes("account 7xKX... has no token account"), `a base58 payer in the facilitator's text is cut (${b.slice(-50)})`);
    const other = verifyFailureLine({ network: SOL, scheme: "exact", reason: `account ${B58.toLowerCase()} differs`, slug: "hash", payer: B58 });
    ok(other.includes(B58.toLowerCase()), "a base58 address that differs from the payer by case is another wallet and is not cut");
  }
  ok(verifyFailureLine({ verb: "rejected", network: "eip155:8453", scheme: "exact", reason: "insufficient_funds", slug: "uuid", payer: "0xAbCd000000000000000000000000000000000001" }).startsWith("[payments] facilitator VERIFY rejected on eip155:8453 exact route=uuid payer=0xAbCd: insufficient_funds"), "the graceful shape prints the same fields");
}
{
  // Missing fields: a line, with "?" where nothing was read.
  const r = noThrow(() => verifyFailureLine());
  ok(!r.threw && r.v === "[payments] facilitator VERIFY failed on ? ? route=? payer=?: ?", `no field at all still prints one line (${r.threw || r.v})`);
  let threw = 0, bad = 0;
  for (const h of HOSTILE) {
    for (const field of ["network", "scheme", "reason", "slug", "payer"]) {
      const r2 = noThrow(() => verifyFailureLine({ network: SOL, scheme: "exact", reason: "x", slug: "hash", payer: B58, [field]: h }));
      if (r2.threw) threw++;
      else if (typeof r2.v !== "string" || r2.v.length > 480 || /[\r\n]/.test(r2.v) || !r2.v.startsWith("[payments] facilitator VERIFY failed on ")) bad++;
    }
    const all = noThrow(() => verifyFailureLine({ verb: h, network: h, scheme: h, reason: h, slug: h, payer: h }));
    if (all.threw) threw++;
  }
  ok(threw === 0 && bad === 0, `a value that cannot be coerced in any field neither throws nor breaks the line (${threw} threw, ${bad} malformed)`);
  ok(verifyFailureLine({ network: { toString: 1 }, scheme: "exact", reason: "r", slug: "hash", payer: B58 }) === "[payments] facilitator VERIFY failed on ? exact route=hash payer=7xKX: r", "a hostile network prints ? and the rest of the line stands");
  ok(shortPayer({ toString: 1 }) === "?" && shortPayer("short") === "?" && shortPayer("has space in it, long enough to pass a length check") === "?" && shortPayer("x".repeat(500)) === "?", "a payer that is not address-shaped prints ?");
}
{
  // Bounded, one line, whatever the facilitator's text holds.
  const long = verifyFailureLine({ network: "n".repeat(5000), scheme: "s".repeat(5000), reason: `line one\nline two\r\n\tthree\u2028four ${"z".repeat(20_000)}`, slug: "g".repeat(5000), payer: B58 });
  ok(long.length <= 480 && !/[\r\n\u2028\u2029\t]/.test(long), `a long, multi-line reason is one line of at most 480 characters (${long.length})`);
  ok(/route=g{64} payer=7xKX: line one line two three\?four z+$/.test(long), "the slug and payer come before the reason, so a cut never drops them");
  ok(safeLogToken("a b\nc") === "a?b?c" && safeLogToken(12) === "12" && safeLogToken("") === "?" && safeLogText("  a \n b  ") === "a b", "tokens and text are flattened");
  // Linear on a hostile string.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) verifyFailureLine({ network: " ".repeat(100_000), scheme: "\n".repeat(100_000), reason: " \n".repeat(100_000), slug: "a ".repeat(50_000), payer: "A".repeat(100_000) });
  ok(Number(process.hrtime.bigint() - t0) / 1e6 < 5_000, "200 lines over 100,000-character hostile fields finish well inside a bound no quadratic scan would");
}
{
  // The payer a refused payment names, read without coercing anything.
  ok(payerNamedBy({ paymentPayload: { payload: { authorization: { from: "0xAbCd000000000000000000000000000000000001" } } } }) === "0xAbCd000000000000000000000000000000000001", "EVM: the authorization's from, as written");
  ok(payerNamedBy({ paymentPayload: { payload: { permit2Authorization: { from: "0xEf01000000000000000000000000000000000002" } } } }) === "0xEf01000000000000000000000000000000000002", "upto: the Permit2 authorization's from");
  ok(payerNamedBy({ paymentPayload: { payload: { transaction: "x" } }, result: { payer: B58 } }) === B58 && payerNamedBy({ paymentPayload: {}, error: { payer: B58 } }) === B58, "the facilitator's answer or error names the payer on the other rails");
  ok(payerNamedBy({ paymentPayload: { payload: { transaction: "x" } } }, { svm: () => B58 }) === B58, "Solana: the transaction's own payer");
  ok(payerNamedBy({ paymentPayload: { payload: { authorization: { from: { toString: 1 } } } } }) === null && payerNamedBy(null) === null && payerNamedBy({ get paymentPayload() { throw new Error("x"); } }) === null && payerNamedBy({}, { svm: () => { throw new Error("x"); } }) === null, "a hostile or missing payer reads as none, never a throw");
}

// ---- the hint, per rail and failure shape -----------------------------------------------
const STELLAR = "stellar:pubnet";
const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const ALGO_PAYER = "A".repeat(58), ALGO_PAYTO = "B".repeat(58);
{
  // Solana, both simulation failures (thrown and graceful shapes read the same text).
  const s = hintFor({ reason: "transaction_simulation_failed: InstructionError:[2 map[Custom:1]]", balanceUsd: null, priceUsd: 0.08, network: SOL, svmPayer: B58 });
  ok(s.reason === "insufficient-funds" && s.retry === "fund-wallet" && /holds less USDC on Solana than this call costs \(\$0\.08\)/.test(s.hint), `Solana, too little USDC: reason, retry and a sentence with asset and amount (${s.hint})`);
  const n = hintFor({ reason: "transaction_simulation_failed", detail: "InstructionError:[2 InvalidAccountData]", balanceUsd: null, priceUsd: 0.08, network: SOL, svmPayer: B58 });
  ok(n.reason === "no-token-account" && n.retry === "fund-wallet" && /has no USDC token account on Solana, so the transfer \(\$0\.08\) cannot run/.test(n.hint), `Solana, no token account: the sentence names the asset and the amount (${n.hint})`);
  ok(n.hint.includes("7xKX...") && !n.hint.includes(B58), "the hint shortens the paying wallet, case kept");
}
{
  // EVM off Base: the balance is not read, so the refusal never says the wallet covers the price.
  const REVERT = "invalid_payload: contract call failed: unable to call contract: execution reverted";
  const h = hintFor({ reason: REVERT, balanceUsd: null, priceUsd: 0.005, network: "eip155:10", payer: "0x00000000000000000000000000000000000000a1" });
  ok(h.retry === "fresh-authorization" && !/covers/.test(h.hint) && /holds less of the asset than this call costs/.test(h.hint) && /\$0\.0050/.test(h.hint) && /Nothing was charged\./.test(h.hint), `EVM, balance unread: both readings, the amount, never "covers" (${h.hint})`);
  ok(/covers \$0\.0050/.test(hintFor({ reason: REVERT, balanceUsd: 1, priceUsd: 0.005, network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1" }).hint), "EVM on Base with a balance read that covers the price keeps its wording");
  const f = hintFor({ reason: "invalid_exact_evm_insufficient_balance", balanceUsd: null, priceUsd: 0.005, network: "eip155:10", payer: "0x00000000000000000000000000000000000000a1" });
  ok(f.reason === "insufficient-funds" && f.retry === "fund-wallet" && /holds less of the asset than this call costs \(\$0\.0050\) on Optimism\./.test(f.hint), `EVM, the facilitator's own balance code: insufficient-funds with the amount (${f.hint})`);
  // A message about the submitter's gas is not the buyer's balance.
  const g = hintFor({ reason: "invalid_exact_evm_transaction_simulation_failed", detail: "insufficient funds for gas * price + value", balanceUsd: null, priceUsd: 0.005, network: "eip155:10" });
  ok(g.reason !== "insufficient-funds", "an EVM message is not read for balance words (it can be the submitter's gas)");
}
{
  // Stellar: one reason code, the words in the message.
  const short = hintFor({ reason: "invalid_exact_stellar_payload_simulation_failed", detail: "HostError: Error(Contract, #10) balance is not sufficient to spend", balanceUsd: null, priceUsd: 0.005, network: STELLAR });
  ok(short.reason === "insufficient-funds" && short.retry === "fund-wallet" && /holds less of the asset than this call costs \(\$0\.0050\) on Stellar\./.test(short.hint) && /^The paying wallet /.test(short.hint), `Stellar, balance short: insufficient-funds (${short.hint})`);
  const none = hintFor({ reason: "invalid_exact_stellar_payload_simulation_failed", detail: "HostError: Error(Contract, #13) trustline entry is missing for account", balanceUsd: null, priceUsd: 0.005, network: STELLAR });
  ok(none.reason === "no-token-account" && none.retry === "fund-wallet" && /has no trustline for the asset on Stellar/.test(none.hint) && /\$0\.0050/.test(none.hint) && /Nothing was charged\./.test(none.hint), `Stellar, no trustline: no-token-account (${none.hint})`);
  const other = hintFor({ reason: "invalid_exact_stellar_payload_simulation_failed", detail: "HostError: Error(Auth, InvalidInput)", balanceUsd: null, priceUsd: 0.005, network: STELLAR });
  ok(other.reason === undefined && other.retry === "fresh-authorization", "Stellar, another simulation failure is not called a funding refusal");
  ok(assetDecimalsFor(STELLAR) === 7 && assetDecimalsFor(SOL) === 6 && assetDecimalsFor("eip155:8453") === 6 && assetDecimalsFor({ toString: 1 }) === 6, "Stellar amounts are read at 7 decimals, the rest at 6");
}
{
  // Algorand: the simulation's words, in the reason (thrown) or the message (graceful).
  const thrown = hintFor({ reason: "invalid_exact_avm_simulation_failed: underflow on subtracting 5000 from sender amount 100", balanceUsd: null, priceUsd: 0.005, network: ALGO });
  const graceful = hintFor({ reason: "invalid_exact_avm_simulation_failed", detail: "transaction X: underflow on subtracting 5000 from sender amount 100", balanceUsd: null, priceUsd: 0.005, network: ALGO });
  ok(thrown.reason === "insufficient-funds" && graceful.reason === "insufficient-funds" && graceful.retry === "fund-wallet" && /\(\$0\.0050\) on Algorand\./.test(graceful.hint), `Algorand, balance short in either shape: insufficient-funds (${graceful.hint})`);
  ok(!/underflow|5000|sender amount/.test(graceful.hint), "the facilitator's own text is not echoed");
  const optIn = hintFor({ reason: "invalid_exact_avm_simulation_failed", detail: `asset 31566704 missing from ${ALGO_PAYER}`, balanceUsd: null, priceUsd: 0.005, network: ALGO, payTo: ALGO_PAYTO });
  ok(optIn.reason === "no-token-account" && /has not opted in to the asset on Algorand/.test(optIn.hint) && !optIn.hint.includes(ALGO_PAYER), `Algorand, payer not opted in: no-token-account (${optIn.hint})`);
  const ours = hintFor({ reason: "invalid_exact_avm_simulation_failed", detail: `asset 31566704 missing from ${ALGO_PAYTO}`, balanceUsd: null, priceUsd: 0.005, network: ALGO, payTo: ALGO_PAYTO });
  ok(ours.reason !== "no-token-account", "Algorand, a refusal naming the receiving address is never worded as the buyer's");
  ok(hintFor({ reason: "invalid_exact_avm_simulation_failed", detail: `asset 31566704 missing from ${ALGO_PAYER}`, balanceUsd: null, priceUsd: 0.005, network: ALGO }).reason !== "no-token-account", "nor one whose receiving address is unknown");
}
{
  // Hostile fields never throw out of the hint.
  let threw = 0;
  for (const h of HOSTILE) {
    for (const field of ["reason", "network", "detail", "payTo"]) {
      if (noThrow(() => hintFor({ reason: "insufficient_funds", balanceUsd: null, priceUsd: 0.005, network: STELLAR, detail: "", [field]: h })).threw) threw++;
    }
  }
  ok(threw === 0, `hintFor reads a value that cannot be coerced as absent (${threw} threw)`);
  // Linear on long hostile text.
  const t0 = process.hrtime.bigint();
  for (const text of ["trustline ".repeat(200_000), "asset 1 missing from ".repeat(100_000), "Error(Contract, ".repeat(100_000), "insufficient ".repeat(150_000)]) {
    hintFor({ reason: "invalid_exact_stellar_payload_simulation_failed", detail: text, balanceUsd: null, priceUsd: 0.005, network: STELLAR });
    hintFor({ reason: text, detail: text, balanceUsd: null, priceUsd: 0.005, network: ALGO, payTo: ALGO_PAYTO });
  }
  ok(Number(process.hrtime.bigint() - t0) / 1e6 < 5_000, "megabyte refusal texts are classified inside a bound no quadratic scan would meet");
}

// ---- needs: what the call asked for, from our own requirements ---------------------------
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
{
  ok(JSON.stringify(needsOf({ network: SOL, asset: USDC_SOL, amount: "80000", payTo: "x" })) === JSON.stringify({ network: SOL, asset: USDC_SOL, amount: "80000", usd: 0.08 }), "needs: network, asset, base units and dollars");
  ok(needsOf({ network: STELLAR, asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", amount: "50000" }).usd === 0.005, "needs: a Stellar amount is read at 7 decimals");
  ok(needsOf({ network: ALGO, asset: "31566704", amount: "5000" }).usd === 0.005, "needs: an Algorand network id and numeric asset are kept");
  let threw = 0, leaked = 0;
  for (const h of HOSTILE) {
    for (const field of ["network", "asset", "amount"]) {
      const r = noThrow(() => needsOf({ network: SOL, asset: USDC_SOL, amount: "80000", [field]: h }));
      if (r.threw) threw++; else if (r.v !== null) leaked++;
    }
    if (noThrow(() => needsOf(h)).threw) threw++;
  }
  ok(threw === 0 && leaked === 0, `needs is absent, not thrown, when a field is not the shape an accept carries (${threw} threw, ${leaked} leaked)`);
  ok(needsOf({ network: SOL, asset: "<script>", amount: "80000" }) === null && needsOf({ network: SOL, asset: USDC_SOL, amount: "8e4" }) === null && needsOf({ network: "x".repeat(200), asset: USDC_SOL, amount: "1" }) === null, "needs carries no free text");
}

// ---- noted and merged into the 402 ---------------------------------------------------------
{
  _testResetForTest();
  const payload = { x402Version: 2, payload: { transaction: "AQID" } };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const requirements = { scheme: "exact", network: STELLAR, asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", amount: "50000", payTo: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" };
  const noted = await noteVerifyFailure({ paymentPayload: payload, network: STELLAR, reason: "invalid_exact_stellar_payload_simulation_failed", detail: "Error(Contract, #10)", priceUsd: 0.005, requirements, balanceReader: async () => { throw new Error("never read off Base"); } });
  ok(noted?.reasonClass === "insufficient-funds" && noted.needs?.amount === "50000" && noted.needs.asset === requirements.asset, `a noted Stellar refusal carries its class and needs (${JSON.stringify(noted?.needs)})`);
  const mw = verifyHintMiddleware();
  const res = { statusCode: 402, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, getHeader() { return undefined; }, json(b) { this.out = b; return this; } };
  const req = { headers: { "payment-signature": header } };
  mw(req, res, () => {});
  res.json({ accepts: [] });
  ok(res.out.reason === "insufficient-funds" && res.out.retry === "fund-wallet" && typeof res.out.hint === "string" && res.out.needs?.network === STELLAR && res.out.needs.amount === "50000" && res.out.needs.usd === 0.005, `the 402 carries reason, sentence, retry and needs (${JSON.stringify({ reason: res.out.reason, needs: res.out.needs })})`);
  ok(res.headers["Retry-After"] === "60" && req.__paymentRejectReason === "insufficient-funds", "with the funding Retry-After, and the class in the paywall rollup");

  // A hostile payer or network on the noted failure: no throw, and no change to what is answered.
  _testResetForTest();
  let threw = 0;
  for (const h of HOSTILE) {
    for (const mk of [
      () => ({ paymentPayload: { x402Version: 2, payload: { signature: "0x11", authorization: { from: h, nonce: "0x01" } } }, network: "eip155:8453" }),
      () => ({ paymentPayload: payload, network: h }),
      () => ({ paymentPayload: payload, network: STELLAR, requirements: { network: h, asset: h, amount: h, payTo: h } }),
      () => ({ paymentPayload: payload, network: STELLAR, payer: h }),
    ]) {
      try { await noteVerifyFailure({ reason: "insufficient_funds", priceUsd: 0.005, balanceReader: async () => null, ...mk() }); } catch { threw++; }
    }
  }
  ok(threw === 0, `noteVerifyFailure never throws on a payer, network or requirement that cannot be coerced (${threw} threw)`);
  _testResetForTest();
}
{
  // The caller path: the payment hooks read the price from the accept's base
  // units at the rail's decimals, so a Stellar 50000 is $0.005, not $0.05.
  _testResetForTest();
  const { registerFacilitatorFailureHooks } = await import("../src/payments.js");
  const hooks = {};
  const server = { onVerifyFailure(fn) { hooks.fail = fn; return this; }, onAfterVerify(fn) { hooks.after = fn; return this; }, onAfterSettle() { return this; }, onSettleFailure() { return this; } };
  registerFacilitatorFailureHooks(server, null, null, {});
  const payload = { x402Version: 2, payload: { transaction: "AQIDBA" } };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const requirements = { scheme: "exact", network: STELLAR, asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", amount: "50000", payTo: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" };
  const warn = console.warn; console.warn = () => {};
  try {
    await hooks.after({ paymentPayload: payload, requirements, result: { isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed", invalidMessage: "HostError: Error(Contract, #10) balance is not sufficient to spend" } });
  } finally { console.warn = warn; }
  const mw = verifyHintMiddleware();
  const res = { statusCode: 402, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, getHeader() { return undefined; }, json(b) { this.out = b; return this; } };
  mw({ headers: { "payment-signature": header } }, res, () => {});
  res.json({ accepts: [] });
  const hint = typeof res.out?.hint === "string" ? res.out.hint : "";
  ok(res.out?.reason === "insufficient-funds" && /\(\$0\.0050\) on Stellar\./.test(hint) && !/\$0\.05\b|\$0\.0500/.test(hint), `a Stellar refusal through the payment hooks prices the call at 7 decimals (${hint})`);
  _testResetForTest();
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
