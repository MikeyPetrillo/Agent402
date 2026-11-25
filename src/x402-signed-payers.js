// The addresses an x402 payment's own signature proves, read locally: no
// network call, no facilitator. The payer screen refuses on EVERY address a
// payment names (src/x402-payer-screen.js), signed or not, but the sanctions
// events store (src/sanctions-events.js) keeps a permanent record, so it
// records only an address this module proves signed the payment. An address
// a request merely states (a block no signature covers) is never recorded.
//
// PROVEN HERE:
//   - `authorization.from`, when `payload.signature` recovers to it over the
//     EIP-3009 TransferWithAuthorization or ReceiveWithAuthorization typed
//     data of the accepted asset (domain name and version from
//     `accepted.extra`, the chain from `accepted.network`), or over the Circle
//     Gateway batched domain (`accepted.extra.verifyingContract`);
//   - `permit2Authorization.from`, when `payload.signature` recovers to it
//     over Permit2's PermitWitnessTransferFrom (the exact witness, or the upto
//     witness that names a facilitator).
// NOT PROVEN (refused by the screen, never recorded): the payment channel
// fields (`channelConfig.payer`, `channelConfig.payerAuthorizer`, a channel
// deposit's funder), any address in a payload whose signature does not
// recover to it, and every address of a payload that names no EVM network.
import { recoverTypedDataAddress, serializeSignature, compactSignatureToSignature, parseCompactSignature } from "viem";
import { PERMIT2_ADDRESS, permit2WitnessTypes, uptoPermit2WitnessTypes } from "@x402/evm";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,78}$/;
const SIG = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const EIP155 = /^eip155:(\d{1,12})$/;

const AUTH_FIELDS = [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
];
const EIP3009_TYPES = [
  ["TransferWithAuthorization", { TransferWithAuthorization: AUTH_FIELDS }],
  ["ReceiveWithAuthorization", { ReceiveWithAuthorization: AUTH_FIELDS }],
];

const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

function fullSignature(sig) {
  if (!SIG.test(sig)) return null;
  try { return sig.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(sig))) : sig; } catch { return null; }
}

async function recovered(typed, signature) {
  try { return (await recoverTypedDataAddress({ ...typed, signature })).toLowerCase(); } catch { return null; }
}

async function eip3009Signer(auth, accepted, chainId, signature) {
  const { from, to, value, validAfter, validBefore, nonce } = auth;
  if (![from, to].every((a) => ADDR.test(str(a))) || !HEX32.test(str(nonce)) || ![value, validAfter, validBefore].every((v) => UINT.test(str(v)))) return null;
  const extra = obj(accepted.extra) ? accepted.extra : {};
  const name = str(extra.name), version = str(extra.version);
  if (!name || !version) return null;
  const contracts = [accepted.asset, extra.verifyingContract].map(str).filter((a) => ADDR.test(a));
  const message = { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
  const want = from.toLowerCase();
  for (const verifyingContract of [...new Set(contracts.map((a) => a.toLowerCase()))]) {
    for (const [primaryType, types] of EIP3009_TYPES) {
      if (await recovered({ domain: { name, version, chainId, verifyingContract }, types, primaryType, message }, signature) === want) return want;
    }
  }
  return null;
}

async function permit2Signer(p2, chainId, signature) {
  const permitted = obj(p2.permitted) ? p2.permitted : {};
  const witness = obj(p2.witness) ? p2.witness : {};
  if (!ADDR.test(str(p2.from)) || !ADDR.test(str(p2.spender)) || !ADDR.test(str(permitted.token)) || !ADDR.test(str(witness.to))) return null;
  if (![permitted.amount, p2.nonce, p2.deadline, witness.validAfter].every((v) => UINT.test(str(v)))) return null;
  const upto = ADDR.test(str(witness.facilitator));
  const message = {
    permitted: { token: permitted.token, amount: BigInt(permitted.amount) },
    spender: p2.spender, nonce: BigInt(p2.nonce), deadline: BigInt(p2.deadline),
    witness: upto ? { to: witness.to, facilitator: witness.facilitator, validAfter: BigInt(witness.validAfter) } : { to: witness.to, validAfter: BigInt(witness.validAfter) },
  };
  const want = p2.from.toLowerCase();
  const typed = { domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS }, types: upto ? uptoPermit2WitnessTypes : permit2WitnessTypes, primaryType: "PermitWitnessTransferFrom", message };
  return (await recovered(typed, signature)) === want ? want : null;
}

/** The lowercased EVM addresses `payment` (a decoded x402 payload) proves by
 *  its own signature. [] for anything else. Never throws. */
export async function x402SignedPayers(payment) {
  try {
    if (!obj(payment) || !obj(payment.payload)) return [];
    const accepted = obj(payment.accepted) ? payment.accepted : payment;
    const m = EIP155.exec(str(accepted.network));
    if (!m) return [];
    const chainId = Number(m[1]);
    const inner = payment.payload;
    const signature = fullSignature(str(inner.signature));
    if (!signature) return [];
    const out = new Set();
    if (obj(inner.authorization)) { const s = await eip3009Signer(inner.authorization, accepted, chainId, signature); if (s) out.add(s); }
    if (obj(inner.permit2Authorization)) { const s = await permit2Signer(inner.permit2Authorization, chainId, signature); if (s) out.add(s); }
    return [...out];
  } catch { return []; }
}
