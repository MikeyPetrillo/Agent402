// Signed offer receipt capture for the paid smoke buyer (scripts/smoke-buy.js).
// A seller may return a signed offer receipt inside its settlement header
// (extensions["offer-receipt"].info.receipt). These helpers decode that header,
// pick the receipt out unchanged, and save it to a NEW file: an existing file is
// never overwritten, so earlier evidence is never lost.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The output path from SMOKE_RECEIPT_OUT, checked before any payment. Blank
// means capture is off.
export function receiptOutputPath(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) return "";
  if (existsSync(path)) throw new Error(`smoke-buy: SMOKE_RECEIPT_OUT already exists: ${path}`);
  const parent = dirname(path);
  let isDir = false;
  try { isDir = statSync(parent).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`smoke-buy: SMOKE_RECEIPT_OUT parent directory does not exist: ${parent}`);
  return path;
}

// Base64 JSON settlement header -> object with every field kept, or null.
export function decodeSettlementHeader(value) {
  if (!value) return null;
  try {
    const doc = JSON.parse(Buffer.from(String(value).trim(), "base64").toString("utf8"));
    return doc !== null && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

// The seller-signed receipt object itself (same reference), or null.
export function signedOfferReceiptFromSettlement(settlement) {
  const receipt = settlement?.extensions?.["offer-receipt"]?.info?.receipt;
  return receipt !== null && typeof receipt === "object" ? receipt : null;
}

// Exclusive create, mode 0600; an existing file throws EEXIST and is untouched.
export function writeSignedOfferReceipt(path, receipt) {
  if (!path || !receipt) return false;
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return true;
}
