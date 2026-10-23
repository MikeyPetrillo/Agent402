// Our own settler for Robinhood Chain (eip155:4663), the last settle fallback
// after the facilitators ROBINHOOD_FACILITATOR_URL lists.
//
// A buyer's payment on 4663 is a signed EIP-3009 transferWithAuthorization for
// USDG: anyone may submit it, and the submitter pays the gas. The listed
// facilitators submit it for free from their own gas wallets; when they cannot
// (a wallet run dry answers a revert for every payment), this client submits
// the same authorization from our relayer wallet (ROBINHOOD_RELAYER_KEY; key
// present = on). It settles our own sales only: the network, the token and the
// recipient (our treasury for 4663) are fixed at boot and anything else is
// refused before any read or write.
//
// Verify and settle are the package's own exact EVM facilitator scheme
// (@x402/evm/exact/facilitator): signature against the token's EIP-712 domain,
// recipient, amount, time window, and an on-chain simulation (simulateInSettle)
// that refuses a used nonce or a short balance. This module supplies the
// signer it runs on, which adds what a shared relayer key needs:
//   - one submission at a time per relayer key across every replica (an
//     in-process queue plus a state-database lease), the nonce read from the
//     chain under it, and the lock held until the transaction is mined (or the
//     wait runs out), so two replicas never sign the same nonce;
//   - EIP-1559 fees with a cap, a gas limit cap, and a refusal before signing
//     when the relayer's balance cannot pay the worst case;
//   - the transaction hash computed before it is sent, so a send that may have
//     reached the node (a transport failure) still answers with the hash. The
//     package then reports a missing receipt as settlement_pending WITH that
//     hash, which the fallback chain treats as possibly on-chain and stops.
//     The EIP-3009 nonce also means at most one transfer can ever land.
// Success is only a mined receipt with status 1 and the USDG Transfer the
// authorization names (the package checks the event).

import { createPublicClient, http, keccak256, encodeFunctionData, getAddress, isAddressEqual, parseAbi, verifyTypedData as verifyTypedDataLocal } from "viem";
const AUTH_STATE_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

export const OWN_RELAYER_NAME = "own relayer";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Caps, env-tunable: the fee per gas (gwei), the gas limit, the receipt wait,
 *  and how long a submission waits for the relayer lock. */
export function relayerSettings(env = process.env) {
  return {
    maxFeeGwei: num(env.ROBINHOOD_RELAYER_MAX_GWEI, 5),
    gasLimitCap: Math.round(num(env.ROBINHOOD_RELAYER_GAS_CAP, 200_000)),
    receiptTimeoutMs: num(env.ROBINHOOD_RELAYER_RECEIPT_MS, 30_000),
    lockWaitMs: num(env.ROBINHOOD_RELAYER_LOCK_WAIT_MS, 15_000),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GWEI = 1_000_000_000n;

// One submission at a time per relayer address in this process; the lease
// serializes the replicas. withLease answers "held" while another container
// has the row, so the acquire is retried until it is ours or the wait ends.
const localQueues = new Map();
async function withRelayerLock(address, { lockWaitMs, leaseImpl }, fn) {
  const key = String(address).toLowerCase();
  const prev = localQueues.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  localQueues.set(key, tail);
  try {
    await prev;
    const withLease = leaseImpl || (await import("./state-db.js")).withLease;
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      const r = await withLease(`rh-relayer-${key}`, { ttlMs: 120_000, failOpen: false, log: () => {} }, async (ctx) => fn(ctx));
      if (r.ran) return r.result;
      if (r.reason !== "held" || Date.now() >= deadline) throw Object.assign(new Error(`relayer lock not available (${r.reason})`), { relayerRefusal: true });
      await sleep(150);
    }
  } finally {
    release();
    if (localQueues.get(key) === tail) localQueues.delete(key);
  }
}

// Only a refusal the node states about THIS transaction proves it was not
// taken. A JSON-RPC error code alone does not: a proxy can forward the raw
// transaction and then answer an internal error (-32603 "upstream timeout"),
// so any other error may have reached the chain and answers the hash.
const DEFINITE_REFUSAL = /nonce too low|nonce has already been used|replacement (transaction )?underpriced|transaction underpriced|insufficient funds|intrinsic gas too low|gas limit reached|exceeds block gas limit|gas limit exceeded|invalid sender|invalid signature|transaction type not supported|tx type not supported|invalid chain ?id|chain ?id mismatch|wrong chain ?id|max fee per gas less than block base fee|fee cap less than block base fee/i;
export function sendRefusedByNode(e) {
  for (let c = e; c; c = c.cause) {
    const text = `${c.message || ""} ${c.details || ""} ${c.shortMessage || ""}`;
    if (/already known|known transaction|already imported/i.test(text)) return false;
    if (DEFINITE_REFUSAL.test(text)) return true;
  }
  return false;
}
const alreadyKnown = (e) => /already known|known transaction|already imported/i.test(String(e?.details || e?.shortMessage || e?.message || ""));

/**
 * The settle client for our relayer, in the shape the fallback chain calls:
 * `settle(paymentPayload, requirements) -> SettleResponse`.
 * @param {object} o
 * @param {string} o.key - the relayer private key
 * @param {string} o.network - must be eip155:4663
 * @param {string} o.asset - the USDG contract
 * @param {string} o.payTo - our treasury for this network
 * @param {string} o.rpcUrl - the chain's JSON-RPC endpoint
 */
export function createOwnRelayerClient({ key, network, asset, payTo, rpcUrl, settings = relayerSettings(), leaseImpl = null, log = console.warn } = {}) {
  if (network !== "eip155:4663") throw new Error("the own relayer settles eip155:4663 only");
  if (!rpcUrl) throw new Error("no RPC for eip155:4663");
  const account = privateKeyToAccount(key);
  const chainId = Number(network.split(":")[1]);
  const token = getAddress(asset);
  const treasury = getAddress(payTo);
  const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const receipts = new Map(); // hash -> receipt mined under the lock

  async function waitReceipt(hash, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        if (r) return r;
      } catch (e) {
        if (!/could not be found|not found/i.test(String(e?.shortMessage || e?.message || ""))) { /* a read error: keep polling until the deadline */ }
      }
      if (Date.now() >= until) throw new Error(`no receipt for ${hash} within ${Math.round(timeoutMs / 1000)} s`);
      await sleep(250);
    }
  }

  const signer = {
    getAddresses: () => [account.address],
    readContract: (args) => pub.readContract(args),
    getCode: (args) => pub.getCode(args),
    // An EOA's signature is recovered locally; a contract wallet goes to the
    // chain (EIP-1271), as the package's own signer would.
    async verifyTypedData(args) {
      try { if (await verifyTypedDataLocal(args)) return true; } catch { /* not an EOA signature */ }
      const code = await pub.getCode({ address: args.address }).catch(() => undefined);
      if (!code || code === "0x") return false;
      return pub.verifyTypedData(args);
    },
    async writeContract({ address, abi, functionName, args, dataSuffix }) {
      // Our sales only: the token, the call and the recipient are fixed.
      if (!isAddressEqual(address, token) || functionName !== "transferWithAuthorization") throw Object.assign(new Error("own relayer refuses any call but USDG transferWithAuthorization"), { relayerRefusal: true });
      if (!isAddressEqual(String(args?.[1] || "0x0000000000000000000000000000000000000000"), treasury)) throw Object.assign(new Error("own relayer refuses a transfer to any recipient but our treasury"), { relayerRefusal: true });
      let data = encodeFunctionData({ abi, functionName, args });
      if (dataSuffix && /^0x[0-9a-fA-F]*$/.test(dataSuffix)) data = `${data}${dataSuffix.slice(2)}`;
      return withRelayerLock(account.address, { lockWaitMs: settings.lockWaitMs, leaseImpl }, async (ctx) => {
        // A used authorization is refused here, not broadcast: the token may
        // treat a replayed nonce as a successful no-op (no revert in the
        // simulation), which would spend our gas for nothing. Read under the
        // lock, so a submission this relayer just mined is seen.
        const used = await pub.readContract({ address: token, abi: AUTH_STATE_ABI, functionName: "authorizationState", args: [args[0], args[5]] });
        if (used === true) throw Object.assign(new Error("authorization already used on chain; nothing sent"), { relayerRefusal: true, authorizationUsed: true });
        const [nonce, gasPrice, balance, estimate] = await Promise.all([
          pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
          pub.getGasPrice(),
          pub.getBalance({ address: account.address }),
          pub.estimateGas({ account: account.address, to: token, data }),
        ]);
        const cap = BigInt(Math.round(settings.maxFeeGwei * 1e9));
        if (gasPrice > cap) throw Object.assign(new Error(`gas price ${gasPrice} wei is over the relayer cap (${settings.maxFeeGwei} gwei)`), { relayerRefusal: true });
        const gas = (estimate * 5n) / 4n;
        if (gas > BigInt(settings.gasLimitCap)) throw Object.assign(new Error(`gas ${gas} is over the relayer cap ${settings.gasLimitCap}`), { relayerRefusal: true });
        const maxFeePerGas = gasPrice * 2n < cap ? gasPrice * 2n : cap;
        const tip = gasPrice / 10n;
        const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
        if (balance < gas * maxFeePerGas) throw Object.assign(new Error("own relayer balance cannot pay this settlement's gas"), { relayerRefusal: true, relayerFunds: true });
        if (!ctx.stillHeld()) throw Object.assign(new Error("relayer lock lost before signing"), { relayerRefusal: true });
        const raw = await account.signTransaction({ type: "eip1559", chainId, to: token, data, value: 0n, nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
        const hash = keccak256(raw);
        try {
          await pub.request({ method: "eth_sendRawTransaction", params: [raw] });
        } catch (e) {
          // The node said no: nothing was taken, nothing can land.
          if (!alreadyKnown(e) && sendRefusedByNode(e)) throw e;
          // Otherwise it may be in the node's pool: answer the hash, so the
          // chain treats the payment as possibly on-chain and stops.
          log(`[own-relayer] send of ${hash} did not answer (${String(e?.shortMessage || e?.message || e).slice(0, 100)}); waiting on its receipt`);
        }
        // Hold the lock until the transaction is mined (or the wait runs out),
        // so the next submission reads the next nonce.
        try { receipts.set(hash, await waitReceipt(hash, settings.receiptTimeoutMs)); } catch { /* the package's wait reports it pending, with the hash */ }
        return hash;
      });
    },
    async sendTransaction() { throw Object.assign(new Error("own relayer sends no other transaction"), { relayerRefusal: true }); },
    async waitForTransactionReceipt({ hash }) {
      const done = receipts.get(hash);
      if (done) { receipts.delete(hash); return done; }
      return waitReceipt(hash, Math.min(5_000, settings.receiptTimeoutMs));
    },
  };

  // Only EOA signatures: no ERC-6492 factory deployments from our wallet.
  const scheme = new ExactEvmScheme(signer, { simulateInSettle: true, eip6492AllowedFactories: [] });
  const refuse = (reason, message, payer) => ({ success: false, errorReason: reason, errorMessage: message, transaction: "", network, payer });

  /** Our sale on 4663 in USDG to our treasury, or nothing. */
  function ours(requirements) {
    if (requirements?.network !== network || requirements?.scheme !== "exact") return "not an exact payment on eip155:4663";
    try {
      if (!isAddressEqual(String(requirements.asset || ""), token)) return "not USDG";
      if (!isAddressEqual(String(requirements.payTo || ""), treasury)) return "not our treasury";
    } catch { return "unreadable requirements"; }
    return null;
  }

  return {
    name: OWN_RELAYER_NAME,
    address: account.address,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: { [network]: [account.address] } }; },
    async verify(paymentPayload, requirements) {
      const why = ours(requirements);
      if (why) return { isValid: false, invalidReason: "own_relayer_refused", invalidMessage: why };
      return scheme.verify(paymentPayload, requirements);
    },
    async settle(paymentPayload, requirements) {
      const payer = paymentPayload?.payload?.authorization?.from;
      const why = ours(requirements);
      if (why) return refuse("own_relayer_refused", why, payer);
      if (paymentPayload?.accepted?.network && paymentPayload.accepted.network !== network) return refuse("own_relayer_refused", "payload names another network", payer);
      return scheme.settle(paymentPayload, requirements);
    },
  };
}
