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
import { decodePaymentHeader, canonicalizePaymentHeaders, dropUnsignedAuthorization, isEvmNetworkName, canonicalNonce } from "../src/payment-header.js";
import { paymentReplayKey } from "../src/replay-guard.js";
import { payerFromRequest, paymentNonceIdentityOf } from "../src/payer.js";
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
ok(!isEvmNetworkName("solana:eip155:8453") && !isEvmNetworkName("xeip155:8453") && !isEvmNetworkName("EIP155:8453") && !isEvmNetworkName(" eip155:8453"), "a CAIP id is EVM only when its namespace is exactly eip155");
ok(!isEvmNetworkName("Solana") && !isEvmNetworkName("SOLANA-devnet") && !isEvmNetworkName("Algorand") && !isEvmNetworkName("STELLAR"), "a v1 name of a transaction-signed family is read whatever its case");

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

// --- a Permit2 block is as unsigned as an EIP-3009 one off the EVM networks -------
{
  const p2block = (from, nonce) => ({ permit2Authorization: { from, nonce, deadline: "1", spender: B, permitted: { token: B, amount: "1000" } }, signature: "0xsig" });
  const id = (k) => k.split(":").slice(0, 2).join(":");
  const plain = paymentReplayKey(req(svm()));
  const k1 = paymentReplayKey(req(svm(p2block(A, "1")))), k2 = paymentReplayKey(req(svm(p2block(B, "2"))));
  ok(plain.startsWith("t2:") && id(k1) === id(plain) && id(k2) === id(plain), `a Solana payment keys on its transaction whatever Permit2 block rides beside it (${id(plain).slice(0, 12)}, ${id(k1).slice(0, 12)}, ${id(k2).slice(0, 12)})`);
  ok(!("permit2Authorization" in decodePaymentHeader(svm(p2block(A, "1"))).payload), "the decoder removes a Permit2 block from a Solana payment");
  ok(!("permit2Authorization" in decodePaymentHeader(b64({ x402Version: 1, accepted: { network: BASE }, network: "solana", payload: { transaction: tx, ...p2block(A, "1") } })).payload), "...and from a header naming an EVM network in one place and another family elsewhere");
  ok(payerFromRequest(req(svm(p2block(A, "1")))) === null && x402ScreenedAddressesOf(req(svm(p2block(A, "1")))).length === 0, "no payer and no screened EVM address is taken from it (the screen reads the transaction's signer)");
  {
    const r = req(svm(p2block(A, "1")));
    canonicalizePaymentHeaders(r);
    ok(!("permit2Authorization" in JSON.parse(Buffer.from(r.headers["payment-signature"], "base64").toString("utf8")).payload), "intake sends the header on without it");
  }
  const evmP2 = (nonce) => b64({ x402Version: 2, accepted: { scheme: "exact", network: BASE }, payload: p2block(A, nonce) });
  ok(decodePaymentHeader(evmP2("7")).payload.permit2Authorization.from === A && payerFromRequest(req(evmP2("7"))) === A, "control: on an EVM network a Permit2 block stays and names the payer");
  const keys = ["7", "07", "0007", "0x7", " 7 ", "0X7", "+7", "+007", "0b111", "0o7", "0".repeat(90) + "7", "0x" + "0".repeat(70) + "7"].map((n) => id(paymentReplayKey(req(evmP2(n)))));
  ok(new Set(keys).size === 1, `one Permit2 nonce in twelve spellings, padded past a uint256's width included, is one payment to the replay guard (${new Set(keys).size} keys)`);
  ok(id(paymentReplayKey(req(evmP2("8")))) !== keys[0] && id(paymentReplayKey(req(evmP2("70")))) !== keys[0], "control: a different nonce value is a different payment");
  // The idempotency identity is a cache key for a re-sent header and keeps the
  // nonce as sent, as before: a different spelling is a different header, and
  // the replay guard above is what holds one permit to one run.
  ok(paymentNonceIdentityOf(req(evmP2("07")))?.nonce === "07", "the idempotency identity keeps the nonce as sent");
  ok(canonicalNonce("0xAB") === "171" && canonicalNonce("0x" + "ab".repeat(32)) === BigInt("0x" + "ab".repeat(32)).toString() && canonicalNonce("not-a-number") === "not-a-number" && canonicalNonce("-7") === "-7" && canonicalNonce("") === "" && canonicalNonce("9".repeat(601)) === "9".repeat(601), "canonicalNonce reads integers by value and leaves other text as sent");
}

// --- attribution, the screen's address list, the signed amount ------------------
ok(payerFromRequest(req(svm({ authorization: { from: A } }))) === null, "a Solana payment names no EVM payer");
ok(x402ScreenedAddressesOf(req(svm({ authorization: { from: A } }))).length === 0, "the payer screen takes no EVM address from a Solana payment (it reads the transaction's signer)");
ok(payerFromRequest(req(evm({ from: A, nonce: "0x01" }))) === A, "control: an EIP-3009 payer is still attributed");
ok(signedEvmAmountUsd(evm({ from: A, value: "1000000" }), BASE) === 1, "control: an EIP-3009 payment's signed value is read");
ok(signedEvmAmountUsd(evm({ from: A, value: "1000000" }, { permit2Authorization: { from: A, nonce: "1" } }), BASE) === null, "a value typed beside a Permit2 authorization is not a signed amount");

// --- the operator can see what intake removes (family and block name only) ------
{
  const { __noteRemovedBlocksForTest: note } = await import("../src/payment-header.js");
  const lines = [];
  // Earlier blocks ran the real intake, so start past its last log time.
  const T0 = Date.now() + 600_000;
  note({ payload: { authorization: {} }, network: "solana" }, T0 - 120_000, () => {});
  const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  note(dec(svm({ authorization: { from: A } })), T0, (l) => lines.push(l));
  note(dec(evm({ from: A, nonce: "0x01" })), T0 + 1, (l) => lines.push(l));
  note(dec(evm({ from: A }, { permit2Authorization: { from: B, nonce: "1" } })), T0 + 2, (l) => lines.push(l));
  note(dec(svm()), T0 + 61_000, (l) => lines.push(l));
  note(dec(svm({ authorization: { from: A } })), T0 + 62_000, (l) => lines.push(l));
  ok(lines.length === 2 && /^\[payment-header\] unsigned blocks removed at intake: solana\/authorization=1$/.test(lines[0]) && /eip155\/authorization=1/.test(lines[1]) && /solana\/authorization=1/.test(lines[1]), `one line a minute names family and block with counts (got ${JSON.stringify(lines)})`);
  ok(!lines.join(" ").includes(A) && !lines.join(" ").includes(B), "the line carries no address");
  ok(!/eip155\/authorization/.test(lines[0]), "a plain EIP-3009 payment, which keeps its block, is not counted");
  // The network text is the caller's: it can be any JSON value and any length.
  const odd = [{ toString: 1 }, 7, ["solana"], null, "sol\nana:x", "X".repeat(5000) + ":1", "solana:" + "y".repeat(5000)];
  let threw = null;
  for (const [n, net] of odd.entries()) {
    try { note({ accepted: { network: net }, payload: { transaction: tx, authorization: { from: A } } }, T0 + 63_000 + n, (l) => lines.push(l)); canonicalizePaymentHeaders(req(b64({ x402Version: 2, accepted: { network: net }, payload: { transaction: tx, authorization: { from: A } } }))); }
    catch (e) { threw = e; }
  }
  ok(threw === null, `a network of any JSON type or length is counted without throwing (${threw ? threw.message : "none thrown"})`);
  for (let k = 0; k < 500; k++) note({ accepted: { network: `fam${k}:1` }, payload: { transaction: tx, authorization: { from: A } } }, T0 + 64_000, () => {});
  const late = [];
  note(dec(svm({ authorization: { from: A } })), T0 + 200_000, (l) => late.push(l));
  const keys = (late[0] || "").split(": ")[1]?.split(" ") || [];
  ok(late.length === 1 && keys.length <= 33 && keys.some((k) => k.startsWith("other/authorization=")) && late[0].length < 1200 && !/[\n\r]/.test(late[0]) && keys.every((k) => /^[a-z0-9-]{1,16}\/(authorization|permit2Authorization)=\d+$/.test(k)),
    `500 different families print as at most 33 short keys on one line (got ${keys.length} keys, ${(late[0] || "").length} characters)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
