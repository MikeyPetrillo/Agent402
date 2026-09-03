// Local EIP-712 domain diagnosis for inbound MPP `evm`/`charge` credentials.
//
// WHY THIS EXISTS. An MPP evm credential is an EIP-3009
// `TransferWithAuthorization` signed under the TOKEN's own EIP-712 domain, and
// that domain's `name` is NOT uniform across Circle's own deployments: Base
// USDC is `"USD Coin"`, while Celo / Monad / Sei USDC report `"USDC"` (all
// verified on-chain - see the money-parser overrides in src/payments.js). A
// client that hardcodes one name signs a digest no facilitator and no contract
// will ever accept on the chains that use the other.
//
// Measured 2026-08-28: AWS Bedrock AgentCore Payments (Stripe/Privy instrument)
// signs Base USDC authorizations under `{name:"USDC"}`, so CDP answers
// `invalid_exact_evm_payload_signature` and the buy dies - while the SAME
// instrument settles our plain x402 path fine (Base tx 0x9b48b7fe...). Their
// manager prefers MPP and falls back to x402 only on challenge SELECTION
// errors, never on a failed verify, so a dual-stack seller's route is
// unpayable from AgentCore even though its x402 option works. Reported
// upstream as awslabs/agentcore-samples#2002.
//
// We cannot fix their signer, and the mppx evm challenge schema carries no
// domain fields to tell them which name to use. What we CAN do is recognise
// the failure exactly, from the credential alone, before spending a facilitator
// round trip - which is what this module does. The recognition has to be
// evidence-based rather than a User-Agent guess, because the remedy (stop
// offering that client an MPP challenge so it takes the x402 path) must never
// fire on a healthy client.
//
// The test is a signature RECOVERY, so it cannot false-positive: we only report
// a mismatch when the credential's own signature recovers to the payload's own
// `from` under a DIFFERENT known token-domain name than the one this route
// advertised. Anyone can claim to be AgentCore; only the holder of that wallet's
// key can produce a signature that recovers to it.
import { recoverTypedDataAddress } from "viem";

/** EIP-3009, verbatim from the standard (and from what @x402/evm signs). */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// The two names Circle's USDC deployments actually carry on chain. A token
// whose advertised name is outside this set (USDG's "Global Dollar") has no
// alternative to test and is simply reported `unknown` - we never guess.
export const USDC_FAMILY_DOMAIN_NAMES = Object.freeze(["USD Coin", "USDC"]);

const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Recover the signer, or null for anything unrecoverable. Never throws. */
async function recoverUnder(name, { version, chainId, verifyingContract, message, signature }) {
  try {
    return await recoverTypedDataAddress({
      domain: { name, version, chainId, verifyingContract },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });
  } catch {
    return null;
  }
}

/**
 * Decide whether an inbound evm/charge credential was signed under the domain
 * name this route advertised, under a different known one, or neither.
 *
 * @param {object} args
 * @param {object} args.accepted - The verbatim x402 accepts entry the challenge was bound to.
 * @param {object} args.authorization - {from,to,value,validAfter,validBefore,nonce}.
 * @param {string} args.signature - The 65-byte signature, 0x-hex.
 * @returns {Promise<{verdict:"matches"|"domain-mismatch"|"unknown", expectedName?:string, signedName?:string, chainId?:number, asset?:string}>}
 */
export async function diagnoseEvmAuthorizationDomain({ accepted, authorization, signature }) {
  const unknown = { verdict: "unknown" };
  try {
    const network = String(accepted?.network || "");
    if (!network.startsWith("eip155:")) return unknown;
    const chainId = Number(network.slice("eip155:".length));
    if (!Number.isInteger(chainId)) return unknown;
    const verifyingContract = accepted?.asset;
    const expectedName = accepted?.extra?.name;
    const version = String(accepted?.extra?.version ?? "2");
    if (typeof verifyingContract !== "string" || typeof expectedName !== "string") return unknown;

    const message = {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    };
    const base = { version, chainId, verifyingContract, message, signature };

    // The advertised name first: a healthy credential costs exactly one
    // recovery and never touches the alternatives.
    if (eq(await recoverUnder(expectedName, base), authorization.from)) return { verdict: "matches" };

    // Only a token whose advertised name is itself one of the known variants
    // has a plausible alternative to test. Anything else gets no guessing.
    if (!USDC_FAMILY_DOMAIN_NAMES.some((n) => eq(n, expectedName))) return unknown;
    for (const name of USDC_FAMILY_DOMAIN_NAMES) {
      if (eq(name, expectedName)) continue;
      if (eq(await recoverUnder(name, base), authorization.from)) {
        return { verdict: "domain-mismatch", expectedName, signedName: name, chainId, asset: verifyingContract };
      }
    }
    // Signed under neither: an ordinary bad signature. Let the facilitator be
    // the one to say so - it is the settlement authority, not us.
    return unknown;
  } catch {
    return unknown;
  }
}

/** Buyer-facing explanation. Names the working path, since that is the whole
 *  point of detecting this: the same wallet settles over x402 today. */
export function domainMismatchDetail({ expectedName, signedName, chainId, asset }) {
  return (
    `The EIP-3009 authorization was signed under EIP-712 domain name ${JSON.stringify(signedName)}, ` +
    `but the token at ${asset} on eip155:${chainId} uses ${JSON.stringify(expectedName)}, ` +
    `so this signature cannot verify here or on chain. ` +
    `Sign with the token's own domain name, or pay this route over x402 instead: ` +
    `the PAYMENT-REQUIRED header on this same 402 carries the equivalent exact offer, ` +
    `and MPP challenges are withheld from this client for a short while so an x402-capable ` +
    `wallet can fall through to it.`
  );
}
