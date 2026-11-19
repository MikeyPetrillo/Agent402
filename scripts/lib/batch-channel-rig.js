// A local x402 batch-settlement rig: an in-process facilitator that models
// the channel escrow (deposits, claims, settles, refunds) and a buyer that
// signs real deposit authorizations and vouchers with @x402/evm's own client
// builders under a key made for the run. Nothing leaves the process; no
// chain is read. Used by scripts/test-batch-settlement.js.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildChannelConfig, computeChannelId, createBatchSettlementEIP3009DepositPayload, signVoucher } from "@x402/evm/batch-settlement/client";

export const BASE = "eip155:8453";
export const RECEIVER_AUTHORIZER = "0x00000000000000000000000000000000000a1b2c";

/** The escrow as the facilitator sees it, and every call it was sent. */
export function makeEscrowFacilitator({ network = BASE, receiverAuthorizer = RECEIVER_AUTHORIZER, kinds = null, failSettleTypes = new Set() } = {}) {
  const channels = new Map(); // channelId -> { balance, totalClaimed, refundNonce, payer }
  const calls = [];
  const stateOf = (id) => channels.get(id) || { balance: 0n, totalClaimed: 0n, refundNonce: 0, payer: null };
  const extraOf = (id) => {
    const c = stateOf(id);
    return { channelId: id, balance: c.balance.toString(), totalClaimed: c.totalClaimed.toString(), withdrawRequestedAt: 0, refundNonce: c.refundNonce };
  };
  let txn = 0;
  const tx = () => `0x${(++txn).toString(16).padStart(64, "0")}`;
  const supported = () => ({
    kinds: kinds || [
      { x402Version: 2, scheme: "exact", network },
      { x402Version: 2, scheme: "batch-settlement", network, extra: { receiverAuthorizer, withdrawDelay: 86_400 } },
    ],
    extensions: [],
    signers: {},
  });
  const client = {
    async getSupported() { return supported(); },
    async verify(payload) {
      const p = payload?.payload || {};
      calls.push({ op: "verify", type: p.type || "exact" });
      if (!p.voucher) return { isValid: true, payer: p?.authorization?.from };
      const id = p.voucher.channelId;
      return { isValid: true, payer: String(p.channelConfig.payer).toLowerCase(), extra: extraOf(id) };
    },
    async settle(payload) {
      const p = payload?.payload || {};
      const type = p.type || "exact";
      calls.push({ op: "settle", type, payload: p });
      if (failSettleTypes.has(type)) return { success: false, errorReason: "stub_refused", transaction: "", network };
      if (type === "deposit") {
        const id = p.voucher.channelId;
        const c = stateOf(id);
        c.balance += BigInt(p.deposit.amount);
        c.payer = String(p.channelConfig.payer).toLowerCase();
        channels.set(id, c);
        return { success: true, transaction: tx(), network, payer: c.payer, extra: { channelState: extraOf(id) } };
      }
      if (type === "claim") {
        for (const cl of p.claims) {
          const id = computeChannelId(cl.voucher.channel, network);
          const c = stateOf(id);
          const total = BigInt(cl.totalClaimed);
          if (total > c.balance || total > BigInt(cl.voucher.maxClaimableAmount)) return { success: false, errorReason: "claim_over_cap", transaction: "", network };
          c.totalClaimed = total;
          channels.set(id, c);
        }
        return { success: true, transaction: tx(), network };
      }
      if (type === "settle") return { success: true, transaction: tx(), network };
      if (type === "refund") {
        const id = p.voucher.channelId;
        const c = stateOf(id);
        for (const cl of p.claims || []) c.totalClaimed = BigInt(cl.totalClaimed);
        const amt = BigInt(p.amount);
        if (c.totalClaimed + amt > c.balance) return { success: false, errorReason: "refund_over_balance", transaction: "", network };
        c.balance -= amt;
        c.refundNonce += 1;
        channels.set(id, c);
        return { success: true, transaction: tx(), network, extra: { channelState: extraOf(id) } };
      }
      return { success: true, transaction: tx(), network };
    },
  };
  return { client, channels, calls, supported };
}

/** A buyer with a fresh key and one channel per payTo. */
export function makeChannelBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { address: account.address, signTypedData: (args) => account.signTypedData(args) };
  const salt = `0x${"00".repeat(31)}01`;
  const deps = { signer, storage: null, salt };
  let charged = 0n;
  return {
    address: account.address,
    get charged() { return charged; },
    set charged(v) { charged = BigInt(v); },
    channelIdFor(req) { return computeChannelId(buildChannelConfig(deps, req), req.network); },
    /** The first payment: a deposit of `depositAtomic` plus the first voucher. */
    async deposit(req, depositAtomic) {
      const cfg = buildChannelConfig(deps, req);
      const max = (charged + BigInt(req.amount)).toString();
      const r = await createBatchSettlementEIP3009DepositPayload(signer, 2, req, cfg, String(depositAtomic), max);
      return { x402Version: 2, accepted: req, payload: r.payload };
    },
    /** A later payment: a voucher for the running total plus this call. */
    async voucher(req, { base = charged } = {}) {
      const cfg = buildChannelConfig(deps, req);
      const id = computeChannelId(cfg, req.network);
      const max = (BigInt(base) + BigInt(req.amount)).toString();
      const v = await signVoucher(signer, id, max, req.network);
      return { x402Version: 2, accepted: req, payload: { type: "voucher", channelConfig: cfg, voucher: v } };
    },
  };
}

export const encodePayment = (p) => Buffer.from(JSON.stringify(p)).toString("base64");
