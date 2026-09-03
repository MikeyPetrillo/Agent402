// Offline proof for src/stellar-confirm.js — the module that decides whether a
// Stellar payment really landed after the facilitator said it did not.
//
// The failure this guards against is asymmetric and worth stating plainly:
// confirming a payment that did NOT happen hands out a paid tool for free, so
// every "yes" must be backed by a payer debit AND a credit to our payTo in the
// SAME successful transaction. Missing a real payment only costs us the sale,
// which is already the status quo, so null is always the safe answer.
import { confirmStellarTransfer, settlePayerOf, settleWithStellarFallback } from "../src/stellar-confirm.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PAYER = "GBA2DDJ4KQXQCGNB7RUU5I2BK5SXROJFUNZV7EZ4XUS7RXFOXEPNY6O4";
const PAYTO = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
const OTHER = "GCXKG6RN4ONIEPCMNFB732A436Z5PPNCLKINVBYFCLXQ2VCM7YKN2VCM";
const T0 = Date.parse("2026-08-03T17:10:40Z");

/** Build a Horizon stub. `plan` maps a URL fragment to a JSON body (or throws). */
function horizon({ debits = [], tx = {}, txEffects = {}, failOn = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (failOn && url.includes(failOn)) throw new Error("horizon down");
    if (url.includes("/effects?order=desc")) {
      return { ok: true, json: async () => ({ _embedded: { records: debits } }) };
    }
    // The effect -> OPERATION -> transaction_hash hop. Horizon effects carry no
    // transaction hash; the operation does. The old stub injected
    // `transaction_hash` straight onto the effect, a field Horizon never
    // returns, so 18 assertions passed against a module that confirmed nothing
    // on live data.
    const opm = url.match(/\/operations\/(\d+)$/);
    if (opm) {
      const hash = OP_TO_TX[opm[1]];
      return { ok: true, json: async () => (hash ? { transaction_hash: hash, transaction_successful: true } : {}) };
    }
    const m = url.match(/\/transactions\/([A-Za-z0-9]+)\/effects/);
    if (m) return { ok: true, json: async () => ({ _embedded: { records: txEffects[m[1]] || [] } }) };
    const t = url.match(/\/transactions\/([A-Za-z0-9]+)$/);
    if (t) return { ok: true, json: async () => (tx[t[1]] || { successful: false }) };
    return { ok: false, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

// VERBATIM HORIZON SHAPE. Fields present on a real effect and nothing else -
// note there is NO transaction_hash and NO _links.transaction. The hash is
// reached through _links.operation, and the operation id is the effect id up to
// the dash. Keeping the fixture honest is what makes this suite mean anything.
const OP_TO_TX = {};
let opSeq = 1000;
const debit = (hash, at, assetType = "credit_alphanum4") => {
  const opId = String(++opSeq);
  OP_TO_TX[opId] = hash;
  return {
    type: "account_debited", asset_type: assetType, asset_code: "USDC",
    amount: "0.0010000", created_at: at,
    id: `${opId}-0000000001`,
    _links: { operation: { href: `https://horizon.stellar.org/operations/${opId}` } },
  };
};
const credit = (acct) => ({ type: "account_credited", account: acct, amount: "0.0010000", asset_code: "USDC" });

const run = (opts, extra = {}) => confirmStellarTransfer({
  payer: PAYER, payTo: PAYTO, sinceMs: T0, waitMs: 0, stepMs: 1, fetchImpl: horizon(opts), ...extra,
});

// 1. The real case: payer debited, our payTo credited, transaction successful.
{
  const r = await run({
    debits: [debit("TX1", "2026-08-03T17:10:52Z")],
    tx: { TX1: { successful: true } },
    txEffects: { TX1: [debit("TX1", "2026-08-03T17:10:52Z"), credit(PAYTO)] },
  });
  ok(r && r.transaction === "TX1", `confirms a real late transfer (${r && r.transaction})`);
  ok(r && r.amount === "0.0010000", "reports the amount that actually moved");
}

// 2. THE DANGEROUS ONE. The payer did send money, but to someone else. Paying a
//    third party must never unlock our tool.
{
  const r = await run({
    debits: [debit("TX2", "2026-08-03T17:10:52Z")],
    tx: { TX2: { successful: true } },
    txEffects: { TX2: [debit("TX2", "2026-08-03T17:10:52Z"), credit(OTHER)] },
  });
  ok(r === null, "a debit that credited SOMEONE ELSE is not our payment");
}

// 3. A transaction that failed on-chain is not a payment.
{
  const r = await run({
    debits: [debit("TX3", "2026-08-03T17:10:52Z")],
    tx: { TX3: { successful: false } },
    txEffects: { TX3: [credit(PAYTO)] },
  });
  ok(r === null, "an unsuccessful transaction is never confirmed");
}

// 4. An older payment must not be credited to THIS attempt, or one purchase
//    would unlock every later 402 from the same buyer.
{
  const r = await run({
    debits: [debit("TX4", "2026-08-02T09:00:00Z")],
    tx: { TX4: { successful: true } },
    txEffects: { TX4: [credit(PAYTO)] },
  });
  ok(r === null, "a debit from before this attempt does not count");
}

// 5. XLM leaves the account for fees on every transaction. That is not the
//    payment, and treating it as one would confirm on fee activity alone.
{
  const r = await run({
    debits: [debit("TX5", "2026-08-03T17:10:52Z", "native")],
    tx: { TX5: { successful: true } },
    txEffects: { TX5: [credit(PAYTO)] },
  });
  ok(r === null, "a native XLM (fee) debit is not the USDC payment");
}

// 6. Fail safe. Horizon being unreachable must leave the original failure
//    standing, never be read as "probably paid".
{
  const r = await run({ failOn: "/accounts/" });
  ok(r === null, "an unreachable Horizon returns null, never an assumed payment");
}

// 7. No debit at all — the genuine non-settlement case.
{
  ok((await run({ debits: [] })) === null, "no debit means no confirmation");
}

// 8. It must POLL, because landing late is the entire point. First look is
//    empty, the transfer appears on the second.
{
  let n = 0;
  const late = debit("TX8", "2026-08-03T17:10:52Z");   // registers its op id
  const impl = async (url) => {
    if (url.includes("/effects?order=desc")) {
      n++;
      return { ok: true, json: async () => ({ _embedded: { records: n === 1 ? [] : [late] } }) };
    }
    const opm = url.match(/\/operations\/(\d+)$/);
    if (opm) return { ok: true, json: async () => ({ transaction_hash: OP_TO_TX[opm[1]], transaction_successful: true }) };
    if (/\/transactions\/TX8\/effects/.test(url)) return { ok: true, json: async () => ({ _embedded: { records: [credit(PAYTO)] } }) };
    if (/\/transactions\/TX8$/.test(url)) return { ok: true, json: async () => ({ successful: true }) };
    return { ok: false, json: async () => ({}) };
  };
  const r = await confirmStellarTransfer({
    payer: PAYER, payTo: PAYTO, sinceMs: T0, waitMs: 300, stepMs: 10, fetchImpl: impl,
  });
  ok(r && r.transaction === "TX8", `finds a transfer that arrives on a later poll (polls: ${n})`);
  ok(n >= 2, "it actually polled more than once");
}

// 9. Guard rails on inputs — a missing payer or payTo must not fall through to
//    "confirmed" on some vacuous match.
{
  ok((await confirmStellarTransfer({ payer: null, payTo: PAYTO, sinceMs: T0 })) === null, "no payer -> null");
  ok((await confirmStellarTransfer({ payer: PAYER, payTo: null, sinceMs: T0 })) === null, "no payTo -> null");
  ok((await confirmStellarTransfer({ payer: PAYER, payTo: PAYTO, sinceMs: NaN })) === null, "no time anchor -> null");
}


// 10. WHERE THE PAYER COMES FROM. This is the assertion whose absence let the
//     production fix ship dead: every test above supplied a payer directly, so
//     nothing checked that the caller could actually obtain one. In production
//     it read paymentPayload.payload.payer, which does not exist on a Stellar
//     payload (that carries `transaction`, a base64 XDR envelope), so the payer
//     was always undefined and confirmStellarTransfer returned instantly.
//
//     Parsing the XDR would not save it either: the transaction source is the
//     facilitator's channel account, not the buyer (measured — buyer GBA2DD…,
//     source GDR2UY…). The facilitator's own settle result/error carries the
//     payer, and that is the only reliable source.
{
  ok(settlePayerOf({ payer: PAYER }) === PAYER, "reads the payer off a failed settle RESULT");
  const err = Object.assign(new Error("settle_channel_service_failed"), { payer: PAYER });
  ok(settlePayerOf(err) === PAYER, "reads the payer off a thrown SettleError");
  ok(settlePayerOf({ payload: { payer: PAYER } }) === null,
    "does NOT read the payer from a payload — that shape is the bug that shipped");
  ok(settlePayerOf({ payload: { transaction: "AAAAAgAAA..." } }) === null,
    "an XDR-carrying payload yields no payer");
  ok(settlePayerOf(null) === null && settlePayerOf({}) === null && settlePayerOf({ payer: "  " }) === null,
    "missing or blank payer is null, never a truthy near-miss");
}


// 10. THE SHAPE ITSELF. This suite passed 18/18 against a module that could not
//     confirm a single real payment, because the fixture invented a
//     `transaction_hash` field on the effect. Assert the fixture matches
//     Horizon: effects carry _links.operation and an id, never a transaction
//     hash. If someone reintroduces the shortcut, this fails.
{
  const e = debit("TXSHAPE", "2026-08-03T17:10:52Z");
  ok(!("transaction_hash" in e), "the effect fixture has NO transaction_hash (Horizon does not send one)");
  ok(!(e._links || {}).transaction, "and no _links.transaction either");
  ok(typeof e._links.operation.href === "string" && /\/operations\/\d+$/.test(e._links.operation.href),
    "the hash is reachable only through _links.operation");
  ok(/^\d+-\d+$/.test(e.id), "the effect id is <opId>-<index>, which is the operation-id fallback");
}


// ---- settleWithStellarFallback: same signed payload, second facilitator ----
{
  const FAIL = { success: false, errorReason: "settle_exact_stellar_transaction_submission_failed", payer: "GPAYER" };
  const OKP = { success: true, transaction: "txPRIMARY", network: "stellar:pubnet" };
  const OKF = { success: true, transaction: "txFALLBACK", network: "stellar:pubnet" };
  const logs = []; const log = (m) => logs.push(m);
  const calls = () => ({ p: 0, f: 0, c: 0 });
  // primary succeeds: fallback and chain never consulted
  { const n = calls(); const r = await settleWithStellarFallback({ primary: async () => { n.p++; return OKP; }, fallback: async () => { n.f++; return OKF; }, confirm: async () => { n.c++; return null; }, log });
    ok(r.transaction === "txPRIMARY" && n.f === 0 && n.c === 0, "primary success: fallback and Horizon never consulted"); }
  // primary fails, not on chain, fallback settles the SAME payload
  { const n = calls(); const r = await settleWithStellarFallback({ primary: async () => { n.p++; return FAIL; }, fallback: async () => { n.f++; return OKF; }, confirm: async () => { n.c++; return null; }, log });
    ok(r.success === true && r.transaction === "txFALLBACK" && r.viaFallback === true && n.f === 1 && n.c === 1, "primary pre-broadcast failure + nothing on chain -> the fallback settles (Horizon checked first)"); }
  // primary fails but the transfer landed: honoured, fallback NOT tried (never re-broadcast a landed tx)
  { const n = calls(); const r = await settleWithStellarFallback({ primary: async () => { n.p++; return FAIL; }, fallback: async () => { n.f++; return OKF; }, confirm: async () => { n.c++; return { transaction: "txLATE", amount: "0.001" }; }, log });
    ok(r.success === true && r.transaction === "txLATE" && n.f === 0, "settle-late race: the landed transfer is honoured and the fallback is never called"); }
  // both fail, then the chain shows it (primary landed late after all): honoured
  { let checks = 0; const r = await settleWithStellarFallback({ primary: async () => FAIL, fallback: async () => ({ success: false, errorReason: "tx_bad_seq" }), confirm: async () => (++checks === 2 ? { transaction: "txLATE2" } : null), log });
    ok(r.success === true && r.transaction === "txLATE2" && checks === 2, "both facilitators refuse but Horizon shows the transfer on the second look -> honoured"); }
  // both fail, nothing on chain: the ORIGINAL failure is returned, flagged
  { const r = await settleWithStellarFallback({ primary: async () => FAIL, fallback: async () => ({ success: false, errorReason: "oz_down" }), confirm: async () => null, log });
    ok(r.success === false && r.errorReason === FAIL.errorReason && r.fallbackTried === true, "both fail, nothing on chain -> the primary's own failure comes back (never a claimed payment)"); }
  // primary throws: same rules; a thrown primary with no fallback re-throws
  { let threw = null; try { await settleWithStellarFallback({ primary: async () => { throw new Error("boom"); }, fallback: null, confirm: async () => null, log }); } catch (e) { threw = e; }
    ok(threw?.message === "boom", "no fallback configured + primary throws + nothing on chain -> the throw propagates unchanged"); }
  { const r = await settleWithStellarFallback({ primary: async () => { throw Object.assign(new Error("settle failed (502)"), { payer: "GPAYER" }); }, fallback: async () => OKF, confirm: async () => null, log });
    ok(r.success === true && r.viaFallback === true, "primary throws (facilitator 5xx) + nothing on chain -> fallback settles"); }
  // fallback throws: treated as a failure, original failure returned
  { const r = await settleWithStellarFallback({ primary: async () => FAIL, fallback: async () => { throw new Error("oz 500"); }, confirm: async () => null, log });
    ok(r.success === false && r.fallbackTried === true, "a throwing fallback is a failed fallback, not a crash"); }
  // no fallback configured: exact pre-existing behaviour
  { const r = await settleWithStellarFallback({ primary: async () => FAIL, fallback: null, confirm: async () => null, log });
    ok(r.success === false && r.fallbackTried === undefined, "without a fallback the result is the primary's, untouched"); }
  ok(logs.some((l) => /re-submitting the same payload via the fallback/.test(l)) && logs.some((l) => /fallback facilitator settled/.test(l)), "every fallback use is logged loudly, both the attempt and the outcome");
}

// ---- confirm by the hash the facilitator named (2026-08-28) ----
{
  const { settleTxOf } = await import("../src/stellar-confirm.js");
  const H = "f72ec04b04da87d05f45c1090100c918f44402ceeb5b4b262409b9c2ff3f76a6";
  ok(settleTxOf({ success: false, errorReason: "settle_timed_out", transaction: H }) === H && settleTxOf({ transaction: "nope" }) === null && settleTxOf(null) === null, "settleTxOf reads a 64-hex transaction from a failed settle body, nothing else");
  const PAYTO = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
  const hits = [];
  const fetchByHash = async (url) => {
    hits.push(String(url));
    if (url.endsWith(`/transactions/${H}`)) return { ok: true, json: async () => ({ hash: H, successful: true }) };
    if (url.endsWith(`/transactions/${H}/effects?limit=50`)) return { ok: true, json: async () => ({ _embedded: { records: [{ type: "account_debited", account: "GPAYER", asset_code: "USDC", amount: "0.0010000" }, { type: "account_credited", account: PAYTO, asset_code: "USDC", amount: "0.0010000" }] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const byHash = await confirmStellarTransfer({ payer: null, payTo: PAYTO, sinceMs: Date.now(), txHash: H, fetchImpl: fetchByHash, waitMs: 10, stepMs: 1 });
  ok(byHash?.transaction === H && byHash.amount === "0.0010000" && hits.every((u) => u.includes(`/transactions/${H}`)), "a named hash is confirmed directly - no payer scan, no window");
  const wrongPayTo = await confirmStellarTransfer({ payer: null, payTo: "GSOMEONEELSE", sinceMs: Date.now(), txHash: H, fetchImpl: fetchByHash, waitMs: 10, stepMs: 1 });
  ok(wrongPayTo === null, "a named hash that credited someone else is not ours");
  const failedTx = await confirmStellarTransfer({ payer: null, payTo: PAYTO, sinceMs: Date.now(), txHash: H, fetchImpl: async (url) => ({ ok: true, json: async () => (url.endsWith(`/transactions/${H}`) ? { hash: H, successful: false } : {}) }), waitMs: 10, stepMs: 1 });
  ok(failedTx === null, "a named hash whose transaction failed on-chain moves nothing");
  // The orchestrator hands the hash from the failure body to confirm().
  let seen = null;
  const r = await settleWithStellarFallback({ primary: async () => ({ success: false, errorReason: "settle_timed_out", payer: "GPAYER", transaction: H }), confirm: async (a) => { seen = a; return { transaction: H, amount: "0.0010000" }; }, log: () => {} });
  ok(seen?.txHash === H && seen?.payer === "GPAYER" && r.success === true && r.transaction === H, "settleWithStellarFallback confirms by the facilitator's named hash and honours the settlement");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
