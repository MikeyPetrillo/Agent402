// attest-kit — `POST /api/attest`: an on-chain attestation of a settled sale.
//
// An agent that acts on money needs to prove what data it acted on. Every
// settled call already carries a payment receipt (the settlement tx), and the
// dispatcher records sha256 of the JSON body it served on the sale row. This
// tool binds the two on chain: given a settlement tx, it writes an Ethereum
// Attestation Service (EAS) attestation on Base, from our own spending wallet,
// carrying the slug served, the response digest, the settlement chain + tx,
// the payer, the time served and the price. The UID is returned and the record
// is public on base.easscan.org. Anyone holding the response can hash it and
// compare; anyone can follow the settlement tx to the payment.
//
// What this is NOT: it does not re-serve the data, it does not claim the data
// is correct, and it is not an oracle. It attests that WE served THESE bytes
// for THAT payment at THAT time - provenance, signed by the seller.
//
// Money: the attestation costs Base gas from X402_UPSTREAM_BUYER_KEY (the same
// wallet route-execute pays external sellers from). The cost is bounded three ways: a
// per-attestation gas ceiling (ATTEST_MAX_GAS_USD, refused 503 before signing
// when the estimate exceeds it, nobody charged), the Base wallet's daily
// spend ceiling (external-spend-guard, booked before the send and corrected
// to the estimate after), and one attestation per sale (a repeat returns the
// existing UID and sends nothing). Settlement of THIS call runs after the
// handler, so a failed settlement can cost one attestation's gas - the same
// bounded exposure every paid upstream call carries.
//
// Schema: registered lazily on first use (one-time gas, bounded separately),
// its UID derived exactly as EAS derives it (keccak256 of the packed schema
// string, resolver and revocable flag - pinned against a live Base schema in
// scripts/test-attest-kit.js). Non-revocable, no resolver, no expiry.
import { createHash } from "node:crypto";
import { assertSigningAllowed } from "../signing-halt.js";
import { saleByTx, setAttestation } from "../sales-ledger.js";
import { maySpend, noteSpend, adjustSpend } from "../external-spend-guard.js";
import { payerFromRequest } from "../payer.js";

// Slugs whose sales are never attestable (memory reads, the usage report):
// set by server.js from the catalog's own identity-bound predicate.
let identityBoundSlugs = new Set();
export function setIdentityBoundSlugs(set) { identityBoundSlugs = new Set(set || []); }

export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";
export const SCHEMA_REGISTRY_ADDRESS = "0x4200000000000000000000000000000000000020";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
// `payer` is a STRING, not an address: Solana, Stellar and Algorand payers do
// not fit an EVM address, and the settlement tx is a string for the same
// reason. The EAS `recipient` is the EVM payer when there is one (wallet-keyed
// lookups on easscan / OnchainKit), else zero.
export const ATTEST_SCHEMA = "string slug,bytes32 responseSha256,string settlementNetwork,string settlementTx,string payer,uint64 servedAt,uint64 priceMicroUsd";
export const EASSCAN_BASE = "https://base.easscan.org";

const CHAIN_ID = 8453;
const BASE_RPCS = [process.env.AGENT402_BASE_RPC, "https://mainnet.base.org", "https://base.publicnode.com", "https://base-rpc.publicnode.com"].filter(Boolean);
// Gas ceilings in USD. ATTEST_ETH_USD is a deliberately HIGH ETH price so the
// bound is honest when ETH moves up between deploys (a lower real price only
// makes the estimate more conservative). MEASURED on the first live run
// (2026-09-03, canary 33782355596): an attest of this schema is 616,058 gas -
// EAS stores the encoded data, and seven fields with four strings are ~25
// storage slots - which at 0.006 gwei is 0.0000037 ETH, about $0.009 at the
// day's ETH price and $0.028 under the 5000 x 1.5 bound. The first cut
// assumed ~150k and priced the tool at $0.010; the ceiling refused every call.
const MAX_GAS_USD = () => envNum("ATTEST_MAX_GAS_USD", 0.035);
const SCHEMA_MAX_GAS_USD = () => envNum("ATTEST_SCHEMA_MAX_GAS_USD", 0.05);
const ETH_USD = () => envNum("ATTEST_ETH_USD", 5000);
// Base charges an L1 data fee beside the L2 gas that estimateGas reports; the
// factor keeps the bound above the whole bill for a ~1 KB transaction.
const L1_FEE_FACTOR = 1.5;

function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
function bad(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

const EAS_ABI = [
  { type: "function", name: "attest", stateMutability: "payable",
    inputs: [{ name: "request", type: "tuple", components: [
      { name: "schema", type: "bytes32" },
      { name: "data", type: "tuple", components: [
        { name: "recipient", type: "address" }, { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" },
        { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" },
      ] },
    ] }],
    outputs: [{ type: "bytes32" }] },
  { type: "event", name: "Attested", inputs: [
    { name: "recipient", type: "address", indexed: true }, { name: "attester", type: "address", indexed: true },
    { name: "uid", type: "bytes32", indexed: false }, { name: "schemaUID", type: "bytes32", indexed: true },
  ] },
];
const REGISTRY_ABI = [
  { type: "function", name: "getSchema", stateMutability: "view", inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "uid", type: "bytes32" }, { name: "resolver", type: "address" }, { name: "revocable", type: "bool" }, { name: "schema", type: "string" },
    ] }] },
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "schema", type: "string" }, { name: "resolver", type: "address" }, { name: "revocable", type: "bool" }],
    outputs: [{ type: "bytes32" }] },
];

/** EAS's own schema UID derivation: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export async function schemaUid(schema = ATTEST_SCHEMA, resolver = ZERO_ADDRESS, revocable = false) {
  const { keccak256, encodePacked } = await import("viem");
  return keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

/** The attestation fields for a sale row, exactly as encoded on chain. */
export function attestationFields(sale) {
  const payer = typeof sale.payer === "string" ? sale.payer : "";
  return {
    slug: String(sale.slug || ""),
    responseSha256: `0x${String(sale.responseSha256).toLowerCase()}`,
    settlementNetwork: String(sale.network || ""),
    settlementTx: String(sale.tx || ""),
    payer,
    // The EAS recipient: the payer when it is an EVM address, else nobody.
    recipient: /^0x[0-9a-f]{40}$/i.test(payer) ? payer : ZERO_ADDRESS,
    servedAt: BigInt(Math.floor(Number(sale.ts) / 1000)),
    priceMicroUsd: BigInt(Math.round(Number(sale.priceUsd || 0) * 1e6)),
  };
}

export async function encodeAttestationData(fields) {
  const { encodeAbiParameters, parseAbiParameters } = await import("viem");
  return encodeAbiParameters(parseAbiParameters(ATTEST_SCHEMA), [
    fields.slug, fields.responseSha256, fields.settlementNetwork, fields.settlementTx, fields.payer, fields.servedAt, fields.priceMicroUsd,
  ]);
}

/** Accepts the tx shapes our receipts carry: EVM hashes, Solana / Stellar
 *  signatures, Algorand ids. Anything else is refused before any lookup. */
export function normalizeTx(input) {
  const t = String(input ?? "").trim();
  if (!t || t.length < 10 || t.length > 130 || !/^[0-9A-Za-z]+$/.test(t)) return null;
  return /^0x[0-9a-f]{64}$/i.test(t) ? t.toLowerCase() : t;
}

// ---- the chain, behind one seam so the handler can be tested with a stub ----
let chainPromise = null;
async function realChain() {
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) throw bad("Attestations need the Base spending wallet (X402_UPSTREAM_BUYER_KEY), which is not configured on this server. Nothing was charged.", 503);
  chainPromise ??= (async () => {
    const [{ createPublicClient, createWalletClient, http, fallback, decodeEventLog }, { privateKeyToAccount }, { base }] = await Promise.all([
      import("viem"), import("viem/accounts"), import("viem/chains"),
    ]);
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
    const transport = fallback(BASE_RPCS.map((u) => http(u, { timeout: 8000 })));
    const publicClient = createPublicClient({ chain: base, transport });
    const walletClient = createWalletClient({ account, chain: base, transport });
    let schemaChecked = false;
    // One attestation at a time: the wallet's nonce is the shared resource and
    // two concurrent sends from one account race it.
    let queue = Promise.resolve();
    const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
    const costUsd = async (gas) => {
      const gasPrice = await publicClient.getGasPrice();
      return (Number(gas * gasPrice) / 1e18) * ETH_USD() * L1_FEE_FACTOR;
    };
    return {
      address: account.address,
      async ensureSchema(uid) {
        assertSigningAllowed("a schema registration");
        if (schemaChecked) return;
        const s = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: "getSchema", args: [uid] });
        if (s && s.uid && s.uid !== ZERO_BYTES32) { schemaChecked = true; return; }
        await serial(async () => {
          // Re-read inside the lock: a concurrent call may have registered it.
          const again = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: "getSchema", args: [uid] });
          if (again && again.uid && again.uid !== ZERO_BYTES32) return;
          const gas = await publicClient.estimateGas({ account, to: SCHEMA_REGISTRY_ADDRESS, data: (await import("viem")).encodeFunctionData({ abi: REGISTRY_ABI, functionName: "register", args: [ATTEST_SCHEMA, ZERO_ADDRESS, false] }) });
          const usd = await costUsd(gas);
          if (usd > SCHEMA_MAX_GAS_USD()) throw bad(`Registering the attestation schema would cost about $${usd.toFixed(4)} in gas, over the $${SCHEMA_MAX_GAS_USD()} ceiling. Nothing was charged; retry when Base gas is lower.`, 503);
          const hash = await walletClient.writeContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: "register", args: [ATTEST_SCHEMA, ZERO_ADDRESS, false] });
          const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
          if (rcpt.status !== "success") throw bad("Registering the attestation schema failed on chain. Nothing was charged.", 503);
          console.log(`[attest] schema ${uid} registered on Base in ${hash}`);
          // The public RPC is load-balanced: the first live run estimated the
          // attest against a node that had not seen the registration block and
          // got "execution reverted". Wait until the registry reads back.
          for (let i = 0; i < 20; i++) {
            const seen = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: "getSchema", args: [uid] });
            if (seen && seen.uid && seen.uid !== ZERO_BYTES32) break;
            await new Promise((r) => setTimeout(r, 3000));
          }
        });
        schemaChecked = true;
      },
      async estimateUsd(uid, recipient, data) {
        const { encodeFunctionData } = await import("viem");
        const callData = encodeFunctionData({ abi: EAS_ABI, functionName: "attest", args: [{ schema: uid, data: { recipient, expirationTime: 0n, revocable: false, refUID: ZERO_BYTES32, data, value: 0n } }] });
        // One retry on a revert: a lagging node behind the schema's block.
        let gas;
        try { gas = await publicClient.estimateGas({ account, to: EAS_ADDRESS, data: callData }); }
        catch (e) {
          if (!/revert/i.test(String(e?.shortMessage || e?.message))) throw e;
          await new Promise((r) => setTimeout(r, 4000));
          gas = await publicClient.estimateGas({ account, to: EAS_ADDRESS, data: callData });
        }
        return costUsd(gas);
      },
      async attest(uid, recipient, data) {
        assertSigningAllowed("an attestation");
        return serial(async () => {
          const hash = await walletClient.writeContract({ address: EAS_ADDRESS, abi: EAS_ABI, functionName: "attest", args: [{ schema: uid, data: { recipient, expirationTime: 0n, revocable: false, refUID: ZERO_BYTES32, data, value: 0n } }] });
          const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
          if (rcpt.status !== "success") throw bad("The attestation transaction reverted on chain. Nothing was charged.", 503);
          let attestedUid = null;
          for (const log of rcpt.logs) {
            if (log.address.toLowerCase() !== EAS_ADDRESS) continue;
            try {
              const ev = decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics });
              if (ev.eventName === "Attested") { attestedUid = ev.args.uid; break; }
            } catch { /* not the Attested event */ }
          }
          if (!attestedUid) throw bad("The attestation transaction succeeded but carried no Attested event. Nothing was charged.", 502);
          return { uid: attestedUid, attestTx: hash, block: String(rcpt.blockNumber) };
        });
      },
    };
  })();
  return chainPromise;
}

/**
 * The handler, with injectable dependencies so the whole decision path runs
 * offline: `deps.chain` = { address, ensureSchema, estimateUsd, attest },
 * `deps.saleByTx`, `deps.setAttestation`, `deps.spend` = { maySpend, noteSpend, adjustSpend }.
 */
export function makeAttestHandler(deps = {}) {
  const lookup = deps.saleByTx || saleByTx;
  const persist = deps.setAttestation || setAttestation;
  const spend = deps.spend || { maySpend, noteSpend, adjustSpend };
  const getChain = deps.chain ? async () => deps.chain : realChain;
  const payerOf = deps.payerOf || payerFromRequest;
  return async (input, req) => {
    const tx = normalizeTx(input?.tx);
    if (!tx) throw bad('Provide "tx": the settlement transaction from the PAYMENT-RESPONSE (or Payment-Receipt) header of a call you paid for - an EVM hash, a Solana or Stellar signature, or an Algorand id.', 400);
    // Who is asking. The route is identity-bound (EVM exact only, like the
    // memory family), so the signed EIP-3009 payer is always derivable here
    // and a non-EVM buyer was never offered the route, never charged.
    const caller = payerOf(req);
    if (!caller) throw bad("Attestations are written for the buyer of a sale, so this call must be paid with a signed EVM authorization from the wallet that made the purchase. Nothing was charged.", 403);
    const sale = lookup(tx);
    // The three refusals below say the same thing on purpose: a wallet that did
    // not make a purchase learns nothing about whether the tx is ours, what it
    // bought, or whether it was digested. Only the buyer sees the detail.
    const notYours = () => bad(`No sale of yours settled in transaction ${tx}. Attestations cover calls this wallet paid for on this server; check the hash from your own receipt. Nothing was charged.`, 403);
    if (!sale) throw notYours();
    if (!sale.payer || String(sale.payer).toLowerCase() !== String(caller).toLowerCase()) throw notYours();
    if (identityBoundSlugs.has(sale.slug)) throw bad("This sale is of a wallet-scoped route (memory or usage) and is not attestable: an attestation is public and permanent. Nothing was charged.", 403);
    if (!/^[0-9a-f]{64}$/i.test(String(sale.responseSha256 || ""))) {
      throw bad(`Your sale in ${tx} has no recorded response digest - it was a streamed or binary response, or was served before digests were recorded (2026-09-03). There is nothing to bind the payment to, so no attestation is written. Nothing was charged.`, 422);
    }
    const uid = await schemaUid();
    const fields = attestationFields(sale);
    const view = (u) => `${EASSCAN_BASE}/attestation/view/${u}`;
    const publicFields = { ...fields, servedAt: new Date(Number(fields.servedAt) * 1000).toISOString(), priceUsd: Number(fields.priceMicroUsd) / 1e6 };
    delete publicFields.priceMicroUsd; delete publicFields.recipient;
    const verify = {
      responseDigest: "sha256 over the exact JSON bytes you received for that call; compare with responseSha256",
      payment: `follow settlementTx on ${fields.settlementNetwork || "the settlement chain"}: the payer paid this server's payTo`,
      attestation: `fetch the UID on ${EASSCAN_BASE} (or read EAS ${EAS_ADDRESS} on Base): attester must be this server's wallet, schema must match`,
    };
    if (sale.attestUid) {
      return { uid: sale.attestUid, attestationUrl: view(sale.attestUid), attestTx: sale.attestTx, existing: true, chain: `eip155:${CHAIN_ID}`, eas: EAS_ADDRESS, schemaUid: uid, schema: ATTEST_SCHEMA, data: publicFields, verify };
    }
    const chain = await getChain();
    // Bound the gas before anything is signed. The worst case is booked
    // against the Base wallet's daily ceiling first (a refusal there is a
    // pause, not a charge), then corrected to the estimate.
    const allowed = spend.maySpend(null, MAX_GAS_USD(), { chain: "base" });
    if (!allowed.ok) throw bad(`Attestations are briefly paused: ${allowed.reason} Nothing was charged; retry later.`, 503);
    const handle = spend.noteSpend(null, MAX_GAS_USD(), { chain: "base" });
    // Where the call failed decides the booking: before the attest send no
    // transaction of ours exists, so the booking is released. A schema step
    // may have sent its own registration, so it keeps the booking.
    let stage = "schema";
    try {
      await chain.ensureSchema(uid);
      stage = "estimate";
      const data = await encodeAttestationData(fields);
      const estimate = await chain.estimateUsd(uid, fields.recipient, data);
      if (!(estimate <= MAX_GAS_USD())) {
        throw bad(`Base gas is high right now: this attestation would cost about $${Number(estimate).toFixed(4)}, over the $${MAX_GAS_USD()} ceiling. Nothing was charged; retry later.`, 503);
      }
      spend.adjustSpend(handle, estimate);
      stage = "send";
      const written = await chain.attest(uid, fields.recipient, data);
      // Write-once on the row: if a concurrent call won, the chain now carries
      // two attestations of one sale and the ledger keeps the first. Harmless
      // (both true), and the serial queue above makes it rare.
      persist(sale.id, { uid: written.uid, attestTx: written.attestTx });
      return {
        uid: written.uid, attestationUrl: view(written.uid), attestTx: written.attestTx, block: written.block, existing: false,
        attester: chain.address, chain: `eip155:${CHAIN_ID}`, eas: EAS_ADDRESS, schemaUid: uid, schema: ATTEST_SCHEMA,
        data: publicFields, verify,
      };
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      // The node refuses an unfunded send before broadcast, so no hash exists.
      const noFunds = /insufficient funds/i.test(msg);
      if (stage === "estimate" || noFunds) spend.adjustSpend(handle, 0);
      if (e?.statusCode) throw e;
      if (noFunds) throw bad("Attestation is temporarily unavailable. Nothing was charged; retry later.", 503);
      throw bad(`Attestation failed before it could be confirmed (${msg.slice(0, 140)}). Nothing was charged.`, 502);
    }
  };
}

export const ATTEST_TOOLS = [
  {
    route: "POST /api/attest",
    name: "Attest a settled call on Base",
    slug: "attest",
    category: "agent",
    price: "$0.050",
    // Spends Base gas from this server's wallet inside the handler, before the
    // buyer's payment settles. Read by spendsBeforeSettlement.
    spendsOwnWallet: true,
    description:
      "Write an on-chain attestation (Ethereum Attestation Service on Base) that binds a call you paid for to the bytes you received: the tool slug, sha256 of the JSON response, the settlement chain and transaction, the payer, the time served and the price, signed by this server's wallet. Give it the settlement transaction from the PAYMENT-RESPONSE (or Payment-Receipt) header of any settled call; the attestation UID and its public page on base.easscan.org come back. Use it when an agent has to prove afterwards what data it acted on. Only the buyer can attest a sale: this call must be paid with a signed EVM authorization from the same wallet, and sales of wallet-scoped routes (memory, usage) are never attestable. The record is public and permanent: it names the payer and the tool. One attestation per sale (a repeat returns the existing UID); refused, uncharged, when the transaction is not a sale of this server, when the response was streamed or binary, or when Base gas would exceed the tool's own ceiling.",
    tags: ["attestation", "eas", "provenance", "receipt", "audit", "base", "x402"],
    discovery: {
      bodyType: "json",
      input: { tx: "0x2f1fecade9bd945e7817c11e5a34cafe6b349dd8c92a7587efed1de476bddfeb" },
      inputSchema: {
        properties: {
          tx: { type: "string", description: "Settlement transaction of a call you paid for, as carried in that response's PAYMENT-RESPONSE (x402) or Payment-Receipt (MPP) header: EVM hash, Solana or Stellar signature, or Algorand id." },
        },
        required: ["tx"],
      },
      output: {
        example: {
          uid: "0x5b4d0c1e8f7a4c2d9e0b6a3f1c8d7e6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
          attestationUrl: "https://base.easscan.org/attestation/view/0x5b4d0c1e8f7a4c2d9e0b6a3f1c8d7e6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
          attestTx: "0x9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b",
          block: "50829611",
          existing: false,
          attester: "0x77065d81e18ad403BCD6e9A0616b288e16744121",
          chain: "eip155:8453",
          eas: "0x4200000000000000000000000000000000000021",
          schemaUid: "0x2a4e6c8d0f1b3a5c7e9d1f3b5a7c9e1d3f5b7a9c1e3d5f7b9a1c3e5d7f9b1a3c",
          schema: "string slug,bytes32 responseSha256,string settlementNetwork,string settlementTx,string payer,uint64 servedAt,uint64 priceMicroUsd",
          data: {
            slug: "crypto-price",
            responseSha256: "0x7d2a9b1c4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b",
            settlementNetwork: "eip155:8453",
            settlementTx: "0x2f1fecade9bd945e7817c11e5a34cafe6b349dd8c92a7587efed1de476bddfeb",
            payer: "0x902dcf34e53695bdea2ffb354b1a2e58bd598256",
            servedAt: "2026-09-03T15:16:06.000Z",
            priceUsd: 0.01,
          },
          verify: {
            responseDigest: "sha256 over the exact JSON bytes you received for that call; compare with responseSha256",
            payment: "follow settlementTx on eip155:8453: the payer paid this server's payTo",
            attestation: "fetch the UID on https://base.easscan.org (or read EAS 0x4200000000000000000000000000000000000021 on Base): attester must be this server's wallet, schema must match",
          },
        },
      },
    },
    handler: makeAttestHandler(),
  },
];

/** sha256 hex of a JSON body's bytes, the digest the dispatcher records. */
export function responseDigest(body) {
  return createHash("sha256").update(typeof body === "string" ? body : JSON.stringify(body), "utf8").digest("hex");
}
