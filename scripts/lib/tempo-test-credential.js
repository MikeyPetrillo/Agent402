// A real tempo/charge pull credential for a suite's stub seller, built offline:
// a sender-signed expiring-nonce Tempo transaction (0x76, no fee payer) whose
// one call is USDC.e transferWithMemo(recipient, amount, memo) taken from the
// challenge, the shape mppx's client signs. `override` changes what the
// transaction carries ({ amount, recipient, token, calls }), so a suite can
// mint a credential that disagrees with the challenge it answers.
import { Challenge, Credential } from "mppx";
import { TxEnvelopeTempo } from "ox/tempo";
import { Secp256k1 } from "ox";
import { encodeFunctionData } from "viem";
import { Abis } from "viem/tempo";

const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";

export function tempoTransferCall({ recipient, amount, token = USDC_E, memo = "0x" + "00".repeat(32) }) {
  return { to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [recipient, BigInt(amount), memo] }) };
}

export function mintTempoTestCredential(res402, { privateKey = Secp256k1.randomPrivateKey(), validBefore = Math.floor(Date.now() / 1000) + 25, override = {} } = {}) {
  const www = res402.headers.get("www-authenticate");
  const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www }));
  const req = ch.request || {};
  const calls = override.calls || [tempoTransferCall({
    recipient: override.recipient || req.recipient,
    amount: override.amount ?? req.amount,
    token: override.token || req.currency || USDC_E,
  })];
  const env = TxEnvelopeTempo.from({ chainId: 4217, calls, nonceKey: 2n ** 256n - 1n, nonce: 0n, validBefore, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  const sig = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey });
  const signature = TxEnvelopeTempo.serialize(env, { signature: { type: "secp256k1", signature: sig } });
  return Credential.serialize({ challenge: ch, payload: { type: "transaction", signature } });
}
