// Self-funding SOR burner economics — offline unit tests.
//   node scripts/test-self-funding.js
import { acceptsForItem, SELF_FUNDING_SLUGS } from "../src/payments.js";
import { buyerPaymentNetwork } from "../src/tools/route-execute.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const BURNER = "0x77065d81e18ad403BCD6e9A0616b288e16744121";
const rails = {
  evmCaip2: ["eip155:8453", "eip155:137", "eip155:42161"],
  svmCaip2: ["solana:x"], stellarCaip2: [], avmCaip2: [],
  walletAddress: TREASURY, solanaWallet: "SoLwallet", stellarWallet: "", algorandWallet: "",
  upstreamBuyerAddress: BURNER,
};

ok(SELF_FUNDING_SLUGS.has("route-execute") && SELF_FUNDING_SLUGS.has("route-execute-plus") && SELF_FUNDING_SLUGS.has("route-execute-max"), "all three route-execute tiers are self-funding slugs");
// House rule (2026-07-29): everything that SPENDS from the burner SETTLES to
// the burner. The Blockscout kit pays ~$0.002/call upstream from the same
// wallet - if any of these five drops out of the set, its revenue goes to the
// treasury while its costs drain the burner, a one-way leak.
{
  const { BLOCKSCOUT_TOOLS } = await import("../src/tools/blockscout-kit.js");
  for (const t of BLOCKSCOUT_TOOLS) {
    ok(SELF_FUNDING_SLUGS.has(t.slug), `burner-spending tool ${t.slug} is self-funding (settles to the burner)`);
  }
}

// route-execute: Base leg -> burner, other EVM + Solana -> treasury
const re = acceptsForItem({ slug: "route-execute", price: "$0.01" }, rails);
const baseAccept = re.find((a) => a.network === "eip155:8453");
const polyAccept = re.find((a) => a.network === "eip155:137");
const solAccept = re.find((a) => a.network === "solana:x");
ok(baseAccept.payTo === BURNER, "route-execute Base leg pays the BURNER (self-funding)");
ok(polyAccept.payTo === TREASURY, "route-execute Polygon leg still pays the treasury");
ok(solAccept.payTo === "SoLwallet", "route-execute Solana leg unchanged (its own wallet)");

// a normal tool: every leg -> treasury (unchanged)
const hash = acceptsForItem({ slug: "hash", price: "$0.001" }, rails);
ok(hash.every((a) => a.network.startsWith("eip155:") ? a.payTo === TREASURY : true), "a normal tool's EVM legs all pay the treasury");

// no burner configured -> route-execute falls back to treasury (safe default)
const noBurner = acceptsForItem({ slug: "route-execute", price: "$0.01" }, { ...rails, upstreamBuyerAddress: "" });
ok(noBurner.find((a) => a.network === "eip155:8453").payTo === TREASURY, "no burner address -> route-execute Base falls back to treasury");

// --- chain-matched Algorand self-funding (2026-07-29, same rule as Base) -----
// An Algorand buyer's route-execute payment settles to the AVM spending wallet
// that pays Algorand sellers. ROUTER TIERS ONLY: the Blockscout kit spends
// from the BASE wallet regardless of the buyer's rail, so its Algorand
// revenue must keep the treasury payTo - routing it to the AVM wallet would
// fund the wrong wallet.
{
  const ALGO_TREASURY = "ALGOTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const AVM_BUYER = "W4GZHN36X35LGSJTTLNZNFPGSSBLMJKFLCMZK4NBLQGUS6PYPPCDB67UOE";
  const avmRails = {
    ...rails,
    avmCaip2: ["algorand:mainnet"],
    algorandWallet: ALGO_TREASURY,
    avmUpstreamBuyerAddress: AVM_BUYER,
  };
  for (const slug of ["route-execute", "route-execute-plus", "route-execute-max"]) {
    const a = acceptsForItem({ slug, price: "$0.01" }, avmRails).find((x) => x.network === "algorand:mainnet");
    ok(a?.payTo === AVM_BUYER, `${slug} Algorand leg pays the AVM spending wallet (chain-matched self-funding)`);
  }
  const bs = acceptsForItem({ slug: "contract-inspect", price: "$0.005" }, avmRails).find((x) => x.network === "algorand:mainnet");
  ok(bs?.payTo === ALGO_TREASURY, "Blockscout Algorand leg keeps the treasury (its spend is Base-pinned)");
  const plain = acceptsForItem({ slug: "hash", price: "$0.001" }, avmRails).find((x) => x.network === "algorand:mainnet");
  ok(plain?.payTo === ALGO_TREASURY, "a normal tool's Algorand leg pays the treasury");
  const unset = acceptsForItem({ slug: "route-execute", price: "$0.01" }, { ...avmRails, avmUpstreamBuyerAddress: "" })
    .find((x) => x.network === "algorand:mainnet");
  ok(unset?.payTo === ALGO_TREASURY, "no AVM buyer address -> Algorand leg falls back to treasury (safe default)");
  const challengeTag = acceptsForItem({ slug: "route-execute", price: "$0.01" }, avmRails).find((x) => x.network === "algorand:mainnet");
  ok(challengeTag?.extra?.tag === "x402-global-challenge", "the challenge tag survives the payTo override");
}

// buyerPaymentNetwork decodes the CAIP-2 from X-PAYMENT — in BOTH real wire
// shapes. v1 carries `network` top-level; v2 carries the chosen accept under
// `accepted` with the network inside it. The old test here encoded a payload
// labeled x402Version:2 with a TOP-LEVEL network — a shape no real client
// sends — which is how the v2 parsing gap passed CI while prod 409'd every
// real Base buyer out of external routing.
const mkHdr = (obj) => ({ header: (n) => n === "x-payment" ? Buffer.from(JSON.stringify(obj)).toString("base64") : null });
const mkV1 = (net) => mkHdr({ x402Version: 1, scheme: "exact", network: net, payload: {} });
const mkV2 = (net) => mkHdr({ x402Version: 2, accepted: { scheme: "exact", network: net, amount: "10000" }, payload: {} });
ok(buyerPaymentNetwork(mkV1("eip155:8453")) === "eip155:8453", "v1 payload: reads Base from top-level network");
ok(buyerPaymentNetwork(mkV1("eip155:137")) === "eip155:137", "v1 payload: reads a non-Base chain");
ok(buyerPaymentNetwork(mkV2("eip155:8453")) === "eip155:8453", "v2 payload: reads Base from accepted.network");
ok(buyerPaymentNetwork(mkV2("eip155:137")) === "eip155:137", "v2 payload: reads a non-Base chain from accepted.network");
ok(buyerPaymentNetwork(mkHdr({ x402Version: 2, payload: {} })) === null, "v2 payload with no accepted -> null (fail-closed upstream)");
ok(buyerPaymentNetwork({ header: () => null }) === null, "no X-PAYMENT -> null (fail-open)");
ok(buyerPaymentNetwork({ header: () => "not-base64-json!!" }) === null, "malformed X-PAYMENT -> null, no throw");


// BOTH HEADERS, DISAGREEING. buyerPaymentNetwork decodes the payment header to
// pick which chain we spend FROM (route-execute -> payX402 -> getUpstreamBuyer
// vs getUpstreamBuyerAvm). It used to read x-payment first while settlement
// reads payment-signature, so a buyer could pay on one chain with a valid
// signature and add an unsigned x-payment naming another - funding their
// external purchase from a hot wallet that never received their money, and
// defeating the fail-closed chain-matching rule outright.
{
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const both = {
    header: (n) => ({
      "payment-signature": enc({ network: "eip155:8453" }),
      "x-payment": enc({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }),
    })[String(n).toLowerCase()],
  };
  const net = buyerPaymentNetwork(both);
  ok(net === "eip155:8453",
    `the SETTLED header decides the spending chain, not an unsigned one (got ${net})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
