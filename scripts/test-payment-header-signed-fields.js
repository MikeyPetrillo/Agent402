// A payment header's `payload.authorization` is read only where a signature
// covers it: a plain EIP-3009 payment on an EVM network. Beside a Permit2
// authorization, or on a network that settles a signed transaction (Solana,
// Algorand, Stellar), the facilitator ignores that block, so its from, nonce
// and value are whatever the sender typed. src/payment-header.js removes it
// at the one decoder every reader uses, and the intake rewrite sends the
// header on without it. This suite holds that for each reader: the replay
// key, payer attribution, the payer screen's address list and the signed
// amount.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { decodePaymentHeader, canonicalizePaymentHeaders, dropUnsignedAuthorization, isEvmNetworkName } from "../src/payment-header.js";
import { paymentReplayKey } from "../src/replay-guard.js";
import { payerFromRequest } from "../src/payer.js";
import { x402ScreenedAddressesOf } from "../src/x402-payer-screen.js";
import { signedEvmAmountUsd } from "../src/paid-price.js";
import { NETWORKS } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const req = (header) => { const headers = { "payment-signature": header }; return { headers, header: (k) => headers[String(k).toLowerCase()] ?? null }; };

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const tx = Buffer.from("one signed transaction").toString("base64");
const svm = (extra = {}) => b64({ x402Version: 2, accepted: { scheme: "exact", network: SOLANA }, payload: { transaction: tx, ...extra } });
const evm = (auth, more = {}) => b64({ x402Version: 2, accepted: { scheme: "exact", network: BASE }, payload: { signature: "0x", authorization: auth, ...more } });

// --- the network table: every name this server maps is read the same way ------
for (const [name, caip2] of Object.entries(NETWORKS)) {
  const wantEvm = String(caip2).startsWith("eip155:");
  ok(isEvmNetworkName(name) === wantEvm && isEvmNetworkName(caip2) === wantEvm, `${name} (${caip2}) reads as ${wantEvm ? "an EVM" : "a transaction-signed"} network by name and by id`);
}
ok(!isEvmNetworkName("") && !isEvmNetworkName(null) && !isEvmNetworkName(8453), "a missing or non-string network is not an EVM one");

// --- the decoder ---------------------------------------------------------------
ok(decodePaymentHeader(evm({ from: A, nonce: "0x01", value: "1000" })).payload.authorization.from === A, "control: a plain EIP-3009 payment on an EVM network keeps its authorization");
ok(decodePaymentHeader(b64({ x402Version: 1, network: "base", payload: { authorization: { from: A } } })).payload.authorization.from === A, "control: a v1 EVM name keeps it too");
ok(!("authorization" in decodePaymentHeader(svm({ authorization: { from: A, nonce: "0x01" } })).payload), "a Solana payment's authorization block is removed");
ok(!("authorization" in decodePaymentHeader(b64({ x402Version: 1, network: "solana", payload: { transaction: tx, authorization: { from: A } } })).payload), "...under the v1 network name as well");
for (const shape of [
  { x402Version: 1, accepted: { network: BASE }, network: "solana", payload: { transaction: tx, authorization: { from: A } } },
  { x402Version: 2, accepted: { network: SOLANA }, network: "base", payload: { transaction: tx, authorization: { from: A } } },
  { x402Version: 2, accepted: { network: BASE }, payload: { network: SOLANA, transaction: tx, authorization: { from: A } } },
]) ok(!("authorization" in decodePaymentHeader(b64(shape)).payload), `a header naming an EVM network in one place and another family elsewhere loses the block (${JSON.stringify(Object.keys(shape))}, v${shape.x402Version})`);
ok(!("authorization" in decodePaymentHeader(evm({ from: A }, { permit2Authorization: { from: B, nonce: "1" } })).payload), "beside a Permit2 authorization the block is removed");
ok(dropUnsignedAuthorization({ payload: "text" }).payload === "text" && dropUnsignedAuthorization({}) && dropUnsignedAuthorization(null) === null, "a header with no payload object passes through");

// --- intake: the header itself is rewritten without the block -------------------
{
  const r = req(svm({ authorization: { from: A, nonce: "0x01" } }));
  canonicalizePaymentHeaders(r);
  const sent = JSON.parse(Buffer.from(r.headers["payment-signature"], "base64").toString("utf8"));
  ok(!("authorization" in sent.payload) && sent.payload.transaction === tx, "intake sends the header on with the signed transaction and without the block");
}

// --- the replay key: one signed payment, one identity ---------------------------
{
  const plain = paymentReplayKey(req(svm()));
  const k1 = paymentReplayKey(req(svm({ authorization: { from: A, nonce: "0x01" } })));
  const k2 = paymentReplayKey(req(svm({ authorization: { from: B, nonce: "0x02" } })));
  const id = (k) => k.split(":").slice(0, 2).join(":");
  ok(plain.startsWith("t2:") && id(k1) === id(plain) && id(k2) === id(plain), `a Solana payment keys on its transaction whatever block rides beside it (${id(plain).slice(0, 14)}, ${id(k1).slice(0, 14)}, ${id(k2).slice(0, 14)})`);
  ok(paymentReplayKey(req(evm({ from: A, nonce: "0x01" }))).split(":")[1] !== paymentReplayKey(req(evm({ from: A, nonce: "0x02" }))).split(":")[1], "control: two EIP-3009 nonces are two payments");

  const p2 = (nonce, more = {}) => b64({ x402Version: 2, accepted: { scheme: "exact", network: BASE }, payload: { signature: "0xsig", permit2Authorization: { from: A, nonce, deadline: "1", spender: B, permitted: { token: B, amount: "1000" } }, ...more } });
  const base = paymentReplayKey(req(p2("7")));
  ok(base.startsWith("p2:") && id(paymentReplayKey(req(p2("7", { note: "x" })))) === id(base) && id(paymentReplayKey(req(p2("7", { authorization: { from: B, nonce: "0x09" } })))) === id(base), "a Permit2 payment keys on its signed owner and nonce: an added payload key or block is the same payment");
  ok(id(paymentReplayKey(req(p2("8")))) !== id(base), "control: another Permit2 nonce is another payment");
}

// --- attribution, the screen's address list, the signed amount ------------------
ok(payerFromRequest(req(svm({ authorization: { from: A } }))) === null, "a Solana payment names no EVM payer");
ok(x402ScreenedAddressesOf(req(svm({ authorization: { from: A } }))).length === 0, "the payer screen takes no EVM address from a Solana payment (it reads the transaction's signer)");
ok(payerFromRequest(req(evm({ from: A, nonce: "0x01" }))) === A, "control: an EIP-3009 payer is still attributed");
ok(signedEvmAmountUsd(evm({ from: A, value: "1000000" }), BASE) === 1, "control: an EIP-3009 payment's signed value is read");
ok(signedEvmAmountUsd(evm({ from: A, value: "1000000" }, { permit2Authorization: { from: A, nonce: "1" } }), BASE) === null, "a value typed beside a Permit2 authorization is not a signed amount");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
