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

/** The split contract's routed-payment event: three indexed ids, then nine
 *  data words, by position: 0 buyer wallet, 1 merchant id, 2 product id,
 *  3 gross amount, 4 to 7 the split legs, 8 merchant amount. Pinned to a real
 *  settlement (scripts/fixtures/referral-receipt-base.json): the token's
 *  AuthorizationUsed and the payer's Transfer into the contract, the split
 *  legs, the Transfer to the merchant's payout wallet, then this event last,
 *  in a transaction sent to the contract itself. */
export const ROUTED_EVENT_SIGNATURE = "PaymentRouted(uint256,uint256,uint256,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)";
// keccak256 of that signature (a constant here so this module needs no
// library; the suite checks it against the signature and the real receipt).
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
 * merchant. Pure. `{ verdict: "paid" | "unpaid" | "unknown", why, moved, read,
 * routedToUs, net }`. `read` is true when the receipt was there with its log
 * list (a verdict made on a complete reading); `moved` is true when the
 * authorization's own transfer into the contract is in it (whatever the
 * contract did next); `routedToUs` is true when, after that transfer, the
 * contract's routed event names OUR merchant id, whatever the payout
 * address, the amounts or the verdict (a payment that reached our merchant
 * and that this rule may still not prove: never closed by itself); `net` is
 * the merchant amount the receipt shows (a decimal string), on "paid" only.
 *
 * The token's receive path (FiatToken `_receiveWithAuthorization`: it requires
 * the caller to be the payee, marks the nonce used, then transfers) emits
 * AuthorizationUsed(from, nonce) and, as the very next log, Transfer(from,
 * payTo, value). A Transfer elsewhere in the transaction proves nothing
 * about this nonce, and one Transfer log follows one AuthorizationUsed log.
 * What the contract did with THIS payment is read from the logs between that
 * pair and the next authorization in the transaction.
 *
 * PAID needs all of: that pair; the contract's routed event naming this
 * buyer, this gross and `merchantId`; a Transfer from the contract to
 * `payoutAddress` of the merchant amount the event states; and that amount
 * at least `minNet` (base units). There is no other way to "paid": a payout
 * transfer with no decodable event is unknown. A receipt whose `to` is not
 * the contract is unknown too (the settlement this rule is pinned to is sent
 * to the contract).
 *
 * `nonce` null reads every authorization of `from` in the receipt (the refund
 * path knows the payer and the transaction, not the nonce). `merchantId`
 * (decimal string), `payoutAddress` and `minNet` are required for "paid";
 * `routedTopic` overrides the event topic.
 */
export function proveReceipt(receipt, { tx = null, from, nonce = null, payTo, amount, merchantId = null, payoutAddress = null, minNet = null, routedTopic = ROUTED_EVENT_TOPIC } = {}) {
  const out = (verdict, why, moved = false, read = true, routedToUs = false, net = null) => ({ verdict, why, moved, read, routedToUs, net });
  if (!receipt || typeof receipt !== "object") return out("unknown", "no receipt", false, false);
  if (tx && lc(receipt.transactionHash) !== lc(tx)) return out("unpaid", "the receipt is for another transaction");
  if (lc(receipt.status) !== "0x1") return out("unpaid", "the transaction did not succeed");
  let need;
  try { need = BigInt(amount); } catch { return out("unpaid", "no amount"); }
  if (!(need > 0n) || !ADDR.test(String(payTo || "")) || !ADDR.test(String(from || ""))) return out("unpaid", "no payer, pay-to or amount");
  if (!Array.isArray(receipt.logs)) return out("unknown", "the receipt carries no log list", false, false);
  const logs = [...receipt.logs].sort((a, b) => (indexOf(a) ?? 0) - (indexOf(b) ?? 0));
  const isUsed = (l) => lc(l?.address) === lc(TOKEN) && lc(l?.topics?.[0]) === AUTHORIZATION_USED_TOPIC;
  let ours = null;
  try { ours = merchantId === null || merchantId === "" ? null : BigInt(merchantId); } catch { ours = null; }
  const payout = ADDR.test(String(payoutAddress || "")) ? lc(payoutAddress) : null;
  let floor = null;
  try { floor = minNet === null || minNet === "" ? null : BigInt(minNet); } catch { floor = null; }
  const topic = B32.test(String(routedTopic || "")) ? lc(routedTopic) : ROUTED_EVENT_TOPIC;
  // Where the transaction was sent, when the receipt says: the contract itself.
  const sentElsewhere = ADDR.test(String(receipt.to || "")) && lc(receipt.to) !== lc(payTo);

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
    if (ours === null || payout === null) return out("unknown", "no merchant id or payout wallet configured to check the routing against", true);
    if (floor === null) return out("unknown", "no minimum net to check the payout against", true);
    const paidOut = (amt) => segment.some((l) => lc(l.address) === lc(TOKEN) && lc(l.topics?.[0]) === TRANSFER_TOPIC && lc(l.topics?.[1]) === topicOf(payTo) && lc(l.topics?.[2]) === topicOf(payout) && valueOf(l) === amt);
    const routed = segment.filter((l) => lc(l.address) === lc(payTo) && lc(l.topics?.[0]) === topic).map(decodeRouted);
    const decoded = routed.filter(Boolean);
    if (!decoded.length) return out("unknown", routed.length ? "a routed event of an unrecognized shape" : "no routed event", true);
    // The contract's event names our merchant id for this payment, whatever else holds.
    const toUs = decoded.some((e) => e.merchantId === ours);
    const mine = decoded.filter((e) => e.buyer === lc(from) && e.gross === value);
    if (mine.length !== 1) return out("unknown", "the routed event does not name this buyer and amount exactly once", true, true, toUs);
    if (mine[0].merchantId !== ours) return out("unpaid", "the payment was routed to another merchant", true, true, toUs);
    if (!(mine[0].merchantAmt > 0n) || !paidOut(mine[0].merchantAmt)) return out("unknown", "routed to this merchant, with no transfer of the merchant amount to the payout wallet", true, true, true);
    if (mine[0].merchantAmt < floor) return out("unknown", "routed to this merchant, with a merchant amount under the minimum net", true, true, true);
    if (sentElsewhere) return out("unknown", "the transaction was not sent to the pay-to contract", true, true, true);
    return out("paid", "routed to this merchant and paid out", true, true, true, mine[0].merchantAmt.toString());
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
