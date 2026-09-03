import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function receiptOutputPath(value) {
  const path = String(value || "").trim();
  if (!path) return "";
  if (existsSync(path)) throw new Error(`smoke-buy: SMOKE_RECEIPT_OUT already exists: ${path}`);
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`smoke-buy: SMOKE_RECEIPT_OUT parent directory does not exist: ${parent}`);
  }
  return path;
}

export function decodeSettlementHeader(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function signedOfferReceiptFromSettlement(settlement) {
  const receipt = settlement?.extensions?.["offer-receipt"]?.info?.receipt;
  return receipt && typeof receipt === "object" ? receipt : null;
}

export function writeSignedOfferReceipt(path, receipt) {
  if (!path || !receipt) return false;
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return true;
}
