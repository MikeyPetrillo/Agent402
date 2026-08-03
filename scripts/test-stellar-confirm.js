// Offline proof for src/stellar-confirm.js — the module that decides whether a
// Stellar payment really landed after the facilitator said it did not.
//
// The failure this guards against is asymmetric and worth stating plainly:
// confirming a payment that did NOT happen hands out a paid tool for free, so
// every "yes" must be backed by a payer debit AND a credit to our payTo in the
// SAME successful transaction. Missing a real payment only costs us the sale,
// which is already the status quo, so null is always the safe answer.
import { confirmStellarTransfer, settlePayerOf } from "../src/stellar-confirm.js";

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
    const m = url.match(/\/transactions\/([A-Za-z0-9]+)\/effects/);
    if (m) return { ok: true, json: async () => ({ _embedded: { records: txEffects[m[1]] || [] } }) };
    const t = url.match(/\/transactions\/([A-Za-z0-9]+)$/);
    if (t) return { ok: true, json: async () => (tx[t[1]] || { successful: false }) };
    return { ok: false, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const debit = (hash, at, assetType = "credit_alphanum4") => ({
  type: "account_debited", asset_type: assetType, asset_code: "USDC",
  amount: "0.0010000", created_at: at, transaction_hash: hash,
});
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
  const impl = async (url) => {
    if (url.includes("/effects?order=desc")) {
      n++;
      return { ok: true, json: async () => ({ _embedded: { records: n === 1 ? [] : [debit("TX8", "2026-08-03T17:10:52Z")] } }) };
    }
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

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
