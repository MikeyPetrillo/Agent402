// The Payment-Receipt header for every MPP method (tempo, stripe): the same
// mppx Receipt serialization each way, so the two gates cannot drift.
import { Receipt } from "mppx";

/** A Receipt.Receipt ({method, status:"success", reference, timestamp})
 *  serialized for the Payment-Receipt header; null when it does not serialize. */
export function receiptHeader(receipt) {
  try { return Receipt.serialize(receipt); } catch { return null; }
}

/** Reverse of the above: OUR OWN Payment-Receipt header back to its reference
 *  (the tx), for the sales-ledger tally in server.js; null when unreadable. */
export function txFromReceiptHeader(header) {
  try { return Receipt.deserialize(String(header)).reference || null; } catch { return null; }
}
