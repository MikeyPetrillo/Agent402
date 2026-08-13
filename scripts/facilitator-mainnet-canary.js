// ONE-OFF verification script (not part of the regular canary suite): proves
// the newly-deployed agent402-facilitator settles a REAL mainnet Stellar
// payment correctly, using the existing paid-canary Stellar burner
// (STELLAR_BURNER_SECRET - already holds real USDC, already proven against
// the old OpenZeppelin facilitator).
//
// Talks to the facilitator's /verify and /settle DIRECTLY (not through
// agent402.tools's own paywall) - this is a proof of the FACILITATOR itself,
// not of our server's payment integration, which is a separate, later,
// explicitly-deferred decision (STELLAR_FACILITATOR_URL swap).
//
// Trivial amount ($0.001), payTo is our OWN existing revenue wallet
// (STELLAR_WALLET_ADDRESS) - the burner pays itself-adjacent infrastructure,
// nothing leaves our control.
//
//   FACILITATOR_URL=... FACILITATOR_TOKEN=... STELLAR_BURNER_SECRET=... \
//   PAYTO=... node scripts/facilitator-mainnet-canary.js
import { Keypair } from "@stellar/stellar-sdk";
import { createEd25519Signer, ExactStellarScheme, USDC_PUBNET_ADDRESS, getHorizonClient } from "@x402/stellar";

const FACILITATOR_URL = (process.env.FACILITATOR_URL || "").replace(/\/+$/, "");
const FACILITATOR_TOKEN = process.env.FACILITATOR_TOKEN || "";
const BURNER_SECRET = process.env.STELLAR_BURNER_SECRET || "";
const PAYTO = process.env.PAYTO || "";
const RPC_URL = process.env.STELLAR_MAINNET_RPC_URL || "https://rpc.lightsail.network/";
const NETWORK = "stellar:pubnet";

// Some providers (e.g. Alchemy) embed an API key directly in the RPC path -
// this repo is public, so never print RPC_URL verbatim (host only).
function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(unparseable URL)";
  }
}

function need(name, val) {
  if (!val) { console.error(`FAIL: ${name} is required`); process.exit(1); }
  return val;
}
need("FACILITATOR_URL", FACILITATOR_URL);
need("FACILITATOR_TOKEN", FACILITATOR_TOKEN);
need("STELLAR_BURNER_SECRET", BURNER_SECRET);
need("PAYTO", PAYTO);

const burnerKp = Keypair.fromSecret(BURNER_SECRET);
console.log(`payer (burner): ${burnerKp.publicKey()}`);
console.log(`payTo: ${PAYTO}`);
console.log(`facilitator: ${FACILITATOR_URL}`);

const requirements = {
  scheme: "exact",
  network: NETWORK,
  asset: USDC_PUBNET_ADDRESS,
  amount: "10000", // 0.001 USDC at 7 decimals
  payTo: PAYTO,
  // @x402/stellar anchors the transaction's ledgerbounds to THIS value at
  // client-side createPaymentPayload() time, then the facilitator copies
  // those same bounds onto its rebuilt tx and separately polls for
  // maxTimeoutSeconds MORE seconds starting from ITS OWN (later) submission
  // - so a short value here systematically expires the tx's real validity
  // window before the facilitator ever broadcasts, once you account for the
  // /verify + /settle round trips in between. Measured live 2026-08-13:
  // two different RPC providers (Lightsail, Alchemy) both showed "accepted
  // into the pending pool, then genuinely never landed on a ledger" with
  // maxTimeoutSeconds:60 - a short-window structural expiry, not a provider
  // fault. 120s leaves real margin while staying well under this job's
  // timeout-minutes.
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
};

const payerSigner = createEd25519Signer(BURNER_SECRET, NETWORK);
const clientScheme = new ExactStellarScheme(payerSigner, { url: RPC_URL });
const created = await clientScheme.createPaymentPayload(2, requirements);
const paymentPayload = { x402Version: created.x402Version, accepted: requirements, payload: created.payload };

async function post(path, body) {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FACILITATOR_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const verify = await post("/verify", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
console.log(`\n/verify -> HTTP ${verify.status}:`, JSON.stringify(verify.body));
if (verify.status !== 200 || verify.body.isValid !== true) {
  console.error("FAIL: verify did not return isValid:true - stopping before settle (no real money moved).");
  process.exit(1);
}

const settle = await post("/settle", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
console.log(`\n/settle -> HTTP ${settle.status}:`, JSON.stringify(settle.body));
if (settle.status !== 200 || settle.body.success !== true) {
  console.error("FAIL: settle did not return success:true.");
  // A non-empty transaction means something WAS broadcast (per shape.js's own
  // convention - "" means nothing was ever submitted). Check both independent
  // sources ourselves instead of leaving that for a human to do by hand
  // afterward - found live 2026-08-13 that a facilitator "pending" submission
  // can still never confirm (a provider-side node-consistency issue, not a
  // late-settle race - Horizon and the RPC both agreed NOT_FOUND, not "found
  // but pending").
  if (settle.body.transaction) {
    console.error(`\n${settle.body.transaction} WAS submitted (non-empty transaction) - checking independently...`);
    const horizon = getHorizonClient(NETWORK);
    try {
      const tx = await horizon.transactions().transaction(settle.body.transaction).call();
      console.error(`Horizon: successful=${tx.successful}`);
    } catch (e) {
      console.error(`Horizon: ${e?.response?.status === 404 ? "NOT_FOUND (never reached a ledger)" : (e?.message || String(e))}`);
    }
    try {
      const rpcRes = await fetch(RPC_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: settle.body.transaction } }),
      });
      const rpcBody = await rpcRes.json();
      console.error(`RPC (${redactRpcUrl(RPC_URL)}): status=${rpcBody?.result?.status}`);
    } catch (e) {
      console.error(`RPC check failed: ${e?.message || String(e)}`);
    }
  } else {
    console.error("\ntransaction is empty - nothing was ever broadcast (submission itself failed, not a confirmation race).");
  }
  process.exit(1);
}

const txHash = settle.body.transaction;
console.log(`\nsettled tx: ${txHash}`);
console.log(`explorer: https://stellar.expert/explorer/public/tx/${txHash}`);

// Independently confirm on Horizon mainnet - the whole point of this exercise.
const horizon = getHorizonClient(NETWORK);
const tx = await horizon.transactions().transaction(txHash).call();
if (tx.successful !== true) {
  console.error(`FAIL: Horizon reports successful=${tx.successful} for ${txHash}`);
  process.exit(1);
}
console.log(`\nOK - Horizon independently confirms the settlement succeeded on mainnet.`);
