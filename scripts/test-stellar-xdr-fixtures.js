// The Stellar payment readers on XDR the previous SDK wrote.
//
// scripts/fixtures/stellar-xdr-v16.json holds envelopes that
// @stellar/stellar-sdk 16.4.1 encoded from fixed test seeds, and what the
// 16.4.1 build of every reader answered for each one: the payer key
// (src/non-evm-payer.js), the screen list, the signed payment and its
// authorization entries (src/stellar-confirm.js), the expiry ledger
// (src/payments.js paymentExpiryOf), and the confirmation of a landed
// transaction by hash. stellar-sdk 17 rebuilt its XDR layer (unions read by
// `.type`, properties instead of getters, Uint8Array instead of Buffer) while
// the wire format stayed the same, so every answer must stay the same, the
// re-encoded host function and authorization entries byte for byte.
//
// One deliberate difference: an authorization entry under the CAP-71
// `sorobanCredentialsAddressV2` arm (the same address credentials, which
// @x402/stellar's verifier already accepted and stellar-sdk 17 builds by
// default) is now read like the legacy arm. 16.4.1's readers skipped it, so
// such a payment named no authorization, no expiry and could not be confirmed.
//
//   node scripts/test-stellar-xdr-fixtures.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import * as sdk from "@stellar/stellar-sdk";
import { nonEvmPayerFromRequest, nonEvmScreenAddressesFromRequest } from "../src/non-evm-payer.js";
import { stellarSignedPaymentOf, stellarAuthorizationsOf, confirmStellarPayment } from "../src/stellar-confirm.js";
import { paymentExpiryOf } from "../src/payments.js";
import { __resetSettlementClaims } from "../src/settlement-claims.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const F = JSON.parse(readFileSync(new URL("./fixtures/stellar-xdr-v16.json", import.meta.url), "utf8"));
const REQ = F.req;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reqWith = (payload) => {
  const v = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { header: (n) => (n === "x-payment" ? v : undefined), headers: { "x-payment": v } };
};
const payloadOf = (envelope) => ({ x402Version: 2, accepted: { ...REQ }, payload: { transaction: envelope } });
const readAll = async (envelope) => {
  const payload = payloadOf(envelope);
  const signed = await stellarSignedPaymentOf(payload, REQ);
  return {
    payerKey: await nonEvmPayerFromRequest(reqWith(payload)),
    screen: await nonEvmScreenAddressesFromRequest(reqWith(payload)),
    signed: signed ? { ...signed, amount: String(signed.amount) } : null,
    authorizations: await stellarAuthorizationsOf(payload),
    expiry: await paymentExpiryOf({ paymentPayload: payload, requirements: REQ }),
  };
};

ok(F.sdk === "16.4.1" && Object.keys(F.cases).length >= 12, `the fixture was written by stellar-sdk ${F.sdk} (${Object.keys(F.cases).length} envelopes)`);
const { version: installed } = JSON.parse(readFileSync(new URL("../node_modules/@stellar/stellar-sdk/package.json", import.meta.url), "utf8"));
ok(Number(installed.split(".")[0]) >= 17, `the installed SDK is the rebuilt XDR line (${installed})`);

// The CAP-71 V2 arm: what this build reads where 16.4.1 read nothing (above).
const V2_NOW = {
  v2Entry: { authorizations: [{ nonce: "555" }], expiry: { expirationLedger: "123456" }, signedAuth: 1 },
  mixedEntries: { authorizations: [{ nonce: "556" }, { nonce: "557" }], expiry: { expirationLedger: "300000" }, signedAuth: 2 },
};

for (const [name, c] of Object.entries(F.cases)) {
  const got = await readAll(c.envelope);
  ok(Buffer.from(sdk.TransactionBuilder.fromXdr(c.envelope, sdk.Networks.PUBLIC).hash()).toString("hex") === c.hash, `${name}: the envelope hashes as 16.4.1 hashed it`);
  ok(got.payerKey === c.expect.payerKey, `${name}: payer key as 16.4.1 read it (${got.payerKey}), case kept`);
  ok(same(got.screen, c.expect.screen), `${name}: screen list as 16.4.1 read it`);
  const v2 = V2_NOW[name];
  if (!v2) {
    ok(same(got.signed, c.expect.signed), `${name}: signed payment (payer, payTo, asset, amount, host function and auth bytes) as 16.4.1 read it`);
    ok(same(got.authorizations, c.expect.authorizations), `${name}: authorization entries (signer, nonce) as 16.4.1 read them (${JSON.stringify(got.authorizations)})`);
    ok(same(got.expiry, c.expect.expiry), `${name}: expiry ledger as 16.4.1 read it (${JSON.stringify(got.expiry)})`);
  } else {
    const payer = got.payerKey.slice("stellar:".length);
    ok(same(got.authorizations, v2.authorizations.map((a) => ({ signer: payer, nonce: a.nonce }))), `${name}: a V2 authorization entry is read like the legacy arm (${JSON.stringify(got.authorizations)})`);
    ok(same(got.expiry, v2.expiry), `${name}: the expiry counts the V2 entry (${JSON.stringify(got.expiry)})`);
    ok(got.signed && got.signed.payer === payer && got.signed.auth.length === v2.signedAuth, `${name}: the signed payment carries the V2 entry`);
  }
}

// Confirmation by hash: a landed transaction (the facilitator's rebuild,
// plain or fee-bumped) confirms the payment it carries and no other.
const horizonOne = (t) => async (url) => url.endsWith(`/transactions/${t.hash}`)
  ? { ok: true, json: async () => ({ hash: t.hash, successful: true, envelope_xdr: t.envelope_xdr }) }
  : { ok: false, status: 404, json: async () => ({}) };
for (const [key, want] of Object.entries(F.confirm)) {
  const [lname, cname] = key.split("|");
  const t = F.landed[lname];
  __resetSettlementClaims();
  const r = await confirmStellarPayment({
    signed: await stellarSignedPaymentOf(payloadOf(F.cases[cname].envelope), REQ),
    txHash: t.hash, sinceMs: Date.now() - 60_000, waitMs: 0, stepMs: 1, claimTx: async () => true, fetchImpl: horizonOne(t),
  });
  const got = r ? { transaction: r.transaction, amount: r.amount } : null;
  const expect = key === "v2Entry|v2Entry" ? { transaction: t.hash, amount: "0.0010000" } : want;
  ok(same(got, expect), `confirm ${lname} landing for the ${cname} payment: ${JSON.stringify(expect)}${key === "v2Entry|v2Entry" ? " (V2 entry, unread by 16.4.1)" : " as 16.4.1"}`);
}

// Characters outside the base64 alphabet: 16.4.1 decoded the string with
// Node's reader, which skips them; 17's own reader refuses it. Our readers
// decode with Node's reader first, so such a spelling of the plain envelope
// reads exactly as 16.4.1 read it.
const junk = F.cases.plain.envelope.slice(0, 40) + "!!" + F.cases.plain.envelope.slice(40);
const j = await readAll(junk);
ok(same({ ...j }, F.cases.plain.expect), `characters outside the alphabet: every reader answers as 16.4.1 did (${JSON.stringify(j.expiry)})`);

// The verifier these readers stand beside is pinned exactly, at the version
// the self-hosted facilitator pins, and that version is the one installed.
{
  const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@x402/stellar"];
  const fac = JSON.parse(readFileSync(new URL("../facilitator/package.json", import.meta.url), "utf8")).dependencies["@x402/stellar"];
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")).packages;
  ok(/^\d+\.\d+\.\d+$/.test(root) && root === fac, `@x402/stellar is pinned exactly, as the facilitator pins it (${root}, facilitator ${fac})`);
  ok(lock[""].dependencies["@x402/stellar"] === root && lock["node_modules/@x402/stellar"].version === root, `the lockfile records the pin and installs it (${lock["node_modules/@x402/stellar"].version})`);
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
