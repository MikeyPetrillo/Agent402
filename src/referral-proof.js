// The receipt rule of the referral rail (src/referral-chain.js reads the
// chain and applies it; src/payment-verify.js applies it to a refund row):
// what one transaction receipt must show for a payment to count as OURS.
// Pure, and with no import, so the refund run loads nothing else for it.
//
// Base USDC, its AuthorizationUsed(address,bytes32) and Transfer topics.
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const topicOf = (addr) => `0x${"0".repeat(24)}${String(addr).slice(2).toLowerCase()}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (v) => String(v ?? "").toLowerCase();
const indexOf = (l) => { const n = parseInt(String(l?.logIndex ?? ""), 16); return Number.isFinite(n) ? n : null; };

/** The split contract's routed-payment event, as its reference documents it:
 *  three indexed ids, then nine data words (buyer wallet, merchant id, product
 *  id, gross amount, four split legs, merchant amount). */
export const ROUTED_EVENT_SIGNATURE = "PaymentRouted(uint256,uint256,uint256,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)";
// keccak256 of that signature (a constant here so this module needs no
// library; the suite checks it against the signature).
export const ROUTED_EVENT_TOPIC = "0x095295347a30fa3575b9fb1e8e4afe0db77928a86555467cb2dfd7b9034a0d17";
const ROUTED_DATA_WORDS = 9;
const B32 = /^0x[0-9a-fA-F]{64}$/;

/** The data words of a routed-payment log, or null when it is not that shape. */
function decodeRouted(log) {
  const data = String(log?.data || "");
  if (!Array.isArray(log?.topics) || log.topics.length !== 4) return null;
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length !== 2 + ROUTED_DATA_WORDS * 64) return null;
  const word = (i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
  // The buyer wallet is an address word: its upper twelve bytes are zero.
  if (!/^0{24}/.test(word(0))) return null;
  try {
    return { buyer: `0x${word(0).slice(24).toLowerCase()}`, merchantId: BigInt(`0x${word(1)}`), gross: BigInt(`0x${word(3)}`), merchantAmt: BigInt(`0x${word(8)}`) };
  } catch { return null; }
}
const valueOf = (log) => { try { return BigInt(log.data); } catch { return null; } };

/**
 * Whether a receipt proves that THIS authorization paid `amount` from `from`
 * to the split contract `payTo` AND that the contract routed it to OUR
 * merchant. Pure. `{ verdict: "paid" | "unpaid" | "unknown", why }`.
 *
 * The token's receive path (FiatToken `_receiveWithAuthorization`: it requires
 * the caller to be the payee, marks the nonce used, then transfers) emits
 * AuthorizationUsed(from, nonce) and, as the very next log, Transfer(from,
 * payTo, value). A Transfer elsewhere in the transaction proves nothing
 * about this nonce, and one Transfer log follows one AuthorizationUsed log.
 * What the contract did with THIS payment is read from the logs between that
 * pair and the next authorization in the transaction.
 *
 * `nonce` null reads every authorization of `from` in the receipt (the refund
 * path knows the payer and the transaction, not the nonce).
 * `merchantId` (decimal string) and `payoutAddress` are required for "paid";
 * `minNet` (base units) is the least a payout transfer must carry when no
 * routed event can be decoded; `routedTopic` overrides the event topic.
 */
export function proveReceipt(receipt, { tx = null, from, nonce = null, payTo, amount, merchantId = null, payoutAddress = null, minNet = null, routedTopic = ROUTED_EVENT_TOPIC } = {}) {
  const out = (verdict, why) => ({ verdict, why });
  if (!receipt || typeof receipt !== "object") return out("unknown", "no receipt");
  if (tx && lc(receipt.transactionHash) !== lc(tx)) return out("unpaid", "the receipt is for another transaction");
  if (lc(receipt.status) !== "0x1") return out("unpaid", "the transaction did not succeed");
  let need;
  try { need = BigInt(amount); } catch { return out("unpaid", "no amount"); }
  if (!(need > 0n) || !ADDR.test(String(payTo || "")) || !ADDR.test(String(from || ""))) return out("unpaid", "no payer, pay-to or amount");
  if (!Array.isArray(receipt.logs)) return out("unknown", "the receipt carries no log list");
  const logs = [...receipt.logs].sort((a, b) => (indexOf(a) ?? 0) - (indexOf(b) ?? 0));
  const isUsed = (l) => lc(l?.address) === lc(TOKEN) && lc(l?.topics?.[0]) === AUTHORIZATION_USED_TOPIC;
  let ours = null;
  try { ours = merchantId === null || merchantId === "" ? null : BigInt(merchantId); } catch { ours = null; }
  const payout = ADDR.test(String(payoutAddress || "")) ? lc(payoutAddress) : null;
  let floor = null;
  try { floor = minNet === null || minNet === "" ? null : BigInt(minNet); } catch { floor = null; }
  const topic = B32.test(String(routedTopic || "")) ? lc(routedTopic) : ROUTED_EVENT_TOPIC;

  const one = (i) => {
    // 1. Its own transfer into the split contract.
    const t = logs[i + 1];
    if (!t || lc(t.address) !== lc(TOKEN) || lc(t.topics?.[0]) !== TRANSFER_TOPIC) return out("unpaid", "no transfer directly after the authorization");
    if (indexOf(logs[i]) !== null && indexOf(t) !== null && indexOf(t) !== indexOf(logs[i]) + 1) return out("unpaid", "the transfer is not the log directly after the authorization");
    if (lc(t.topics?.[1]) !== topicOf(from) || lc(t.topics?.[2]) !== topicOf(payTo)) return out("unpaid", "its transfer is not from the payer to the pay-to contract");
    const value = valueOf(t);
    if (value === null || value < need) return out("unpaid", "its transfer is short");
    // 2. What the contract did with it: the logs up to the next authorization.
    let end = logs.length;
    for (let k = i + 2; k < logs.length; k++) { if (isUsed(logs[k])) { end = k; break; } }
    const segment = logs.slice(i + 2, end);
    if (ours === null || payout === null) return out("unknown", "no merchant id or payout wallet configured to check the routing against");
    const paidOut = (test) => segment.some((l) => lc(l.address) === lc(TOKEN) && lc(l.topics?.[0]) === TRANSFER_TOPIC && lc(l.topics?.[1]) === topicOf(payTo) && lc(l.topics?.[2]) === topicOf(payout) && (() => { const v = valueOf(l); return v !== null && test(v); })());
    const routed = segment.filter((l) => lc(l.address) === lc(payTo) && lc(l.topics?.[0]) === topic).map(decodeRouted);
    const decoded = routed.filter(Boolean);
    if (decoded.length) {
      const mine = decoded.filter((e) => e.buyer === lc(from) && e.gross === value);
      if (mine.length !== 1) return out("unknown", "the routed event does not name this buyer and amount exactly once");
      if (mine[0].merchantId !== ours) return out("unpaid", "the payment was routed to another merchant");
      if (!(mine[0].merchantAmt > 0n) || !paidOut((v) => v === mine[0].merchantAmt)) return out("unknown", "routed to this merchant, with no transfer of the merchant amount to the payout wallet");
      return out("paid", "routed to this merchant and paid out");
    }
    // No event this module can decode: the payout transfer alone.
    if (floor !== null && floor > 0n && paidOut((v) => v >= floor && v <= value)) return out("paid", "paid out to the payout wallet (no routed event decoded)");
    return out("unknown", routed.length ? "a routed event of an unrecognized shape, and no payout transfer" : "no routed event and no payout transfer");
  };

  const candidates = [];
  for (let i = 0; i < logs.length; i++) {
    if (!isUsed(logs[i]) || lc(logs[i].topics?.[1]) !== topicOf(from)) continue;
    if (nonce !== null && lc(logs[i].topics?.[2]) !== lc(nonce)) continue;
    candidates.push(i);
  }
  if (!candidates.length) return out("unpaid", "the transaction did not use this authorization");
  const verdicts = candidates.map(one);
  return verdicts.find((v) => v.verdict === "paid") || verdicts.find((v) => v.verdict === "unknown") || verdicts[0];
}
/** proveReceipt's one word. */
export const receiptProvesPayment = (receipt, o) => proveReceipt(receipt, o).verdict;

