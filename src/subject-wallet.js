// Data requests by wallet (access, portability, erasure), the half of
// /privacy's "Your rights" that a wallet address keys. The email half is
// scripts/erase-subject.js <email>.
//
// PROOF OF CONTROL. A request is honored only with a message signed by the
// wallet itself (GDPR Art. 12(6): we may confirm who is asking), in exactly the
// layout subjectRequestMessage prints, dated within REQUEST_MAX_AGE_DAYS:
//   - an EVM address (0x + 40 hex): an EIP-191 personal_sign signature from
//     the address (an externally owned account; viem's verifyMessage);
//   - a Solana address (base58, 32 bytes): an Ed25519 signature over the
//     message bytes (signMessage), base58 or base64;
//   - a Stellar account (G..., StrKey): an Ed25519 signature over
//     SHA-256("Stellar Signed Message:\n" + message) (SEP-53), base64.
// Addresses are compared case-folded only on EVM; base58 and StrKey are exact.
//
// WHAT A REQUEST REACHES (state database; the production store). Erase:
//   memory           namespace rows (kv, documents, request ids, its own audit
//                    log) deleted; grants it gave or holds removed. Entries in
//                    ANOTHER owner's audit log naming this wallet as the actor
//                    are that owner's tamper-evident record and age out with it.
//   issued receipts  rows naming the wallet as payer deleted.
//   feedback         the reason text nulled; the verdict and the sale stay.
//   decide           the wallet removed from decisions, credits and runs (each
//                    deleted after 30 days anyway).
//   first-call grant the record moved from the address to a keyed hash, so the
//                    same wallet is still never granted twice
//                    (allowanceRecordKey; src/first-call-allowance.js reads both).
//   KEPT, and said so: the sales and refund ledgers (accounting and tax
//   records; the same entries are public on chain), and sanctions-screening
//   records, which the law requires us to keep.
// Export: every row above plus the sales and refund ledger rows, as JSON.
// Analytics events carry only a keyed hash of the wallet (src/posthog.js
// telemetryPayerKey), so they hold no address to erase.
import { createHash, createHmac, createPublicKey, verify as edVerify } from "node:crypto";

export const REQUEST_MAX_AGE_DAYS = 14;
export const SUBJECT_ACTIONS = Object.freeze(["erase", "export"]);
const EVM = /^0x[0-9a-fA-F]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STELLAR = /^G[A-Z2-7]{55}$/;

/** "evm" | "solana" | "stellar" | null */
export function walletKind(wallet) {
  const w = typeof wallet === "string" ? wallet.trim() : "";
  if (EVM.test(w)) return "evm";
  if (STELLAR.test(w)) return "stellar";
  if (B58.test(w) && base58Decode(w)?.length === 32) return "solana";
  return null;
}

/** The exact text a wallet signs. `date` is YYYY-MM-DD (UTC). */
export function subjectRequestMessage({ action, wallet, date }) {
  return `Agent402 data request\nAction: ${action}\nWallet: ${wallet}\nDate: ${date}`;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s) {
  if (typeof s !== "string" || !s) return null;
  let n = 0n;
  for (const ch of s) { const i = B58_ALPHABET.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out = [];
  for (const ch of s) { const i = A.indexOf(ch); if (i < 0) return null; value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function crc16xmodem(buf) {
  let crc = 0;
  for (const b of buf) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
/** The 32-byte Ed25519 key of a Stellar G... account, checksum verified. */
export function stellarPublicKey(account) {
  if (!STELLAR.test(account || "")) return null;
  const raw = base32Decode(account);
  if (!raw || raw.length !== 35 || raw[0] !== 6 << 3) return null;
  const body = raw.subarray(0, 33), sum = raw.readUInt16LE(33);
  return crc16xmodem(body) === sum ? Buffer.from(raw.subarray(1, 33)) : null;
}
function edKey(raw32) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw32).toString("base64url") }, format: "jwk" });
}
function sigBytes(signature) {
  const s = String(signature || "").trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) { const b = base58Decode(s); if (b?.length === 64) return b; }
  try { const b = Buffer.from(s, "base64"); if (b.length === 64) return b; } catch { /* not base64 */ }
  return null;
}

/**
 * Verify a signed data request. Returns { ok: true, kind, action, date } or
 * { ok: false, reason }. `now` is ms.
 */
export async function verifySubjectRequest({ action, wallet, message, signature, now = Date.now() }) {
  if (!SUBJECT_ACTIONS.includes(action)) return { ok: false, reason: "action must be erase or export" };
  const w = typeof wallet === "string" ? wallet.trim() : "";
  const kind = walletKind(w);
  if (!kind) return { ok: false, reason: "not a wallet address this server keys data by (EVM, Solana or Stellar)" };
  const m = typeof message === "string" ? message.replace(/\r\n/g, "\n").trim() : "";
  const date = /\nDate: (\d{4}-\d{2}-\d{2})$/.exec(m)?.[1];
  if (!date || m !== subjectRequestMessage({ action, wallet: w, date })) return { ok: false, reason: "the message is not the request text for this action and wallet" };
  const at = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(at) || at > now + 86_400_000 || now - at > REQUEST_MAX_AGE_DAYS * 86_400_000) return { ok: false, reason: `the message date must be within the last ${REQUEST_MAX_AGE_DAYS} days` };
  try {
    if (kind === "evm") {
      const { verifyMessage } = await import("viem");
      const sig = String(signature || "").trim();
      if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: "an EVM signature is 65 bytes of 0x hex" };
      const ok = await verifyMessage({ address: w, message: m, signature: sig });
      return ok ? { ok: true, kind, action, date } : { ok: false, reason: "the signature is not this wallet's" };
    }
    const sig = sigBytes(signature);
    if (!sig) return { ok: false, reason: "an Ed25519 signature is 64 bytes, base58 or base64" };
    if (kind === "solana") {
      const ok = edVerify(null, Buffer.from(m, "utf8"), edKey(base58Decode(w)), sig);
      return ok ? { ok: true, kind, action, date } : { ok: false, reason: "the signature is not this wallet's" };
    }
    const pub = stellarPublicKey(w);
    if (!pub) return { ok: false, reason: "the Stellar account's checksum does not match" };
    const digest = createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), Buffer.from(m, "utf8")])).digest();
    const ok = edVerify(null, digest, edKey(pub), sig);
    return ok ? { ok: true, kind, action, date } : { ok: false, reason: "the signature is not this wallet's" };
  } catch (e) {
    return { ok: false, reason: `the signature could not be checked (${String(e?.message || e).slice(0, 80)})` };
  }
}

/** The first-call grant record's id once its wallet asked to be erased: a
 *  keyed hash, so the grant still counts and the address is gone. Null with no
 *  secret (then the record is left as it is and the report says so). */
export function allowanceRecordKey(wallet, secret = process.env.TELEMETRY_ID_SECRET || process.env.POW_SECRET || process.env.MPP_SECRET_KEY || "") {
  if (!secret || typeof wallet !== "string" || !wallet) return null;
  const basis = EVM.test(wallet) ? wallet.toLowerCase() : wallet;
  return `erased:${createHmac("sha256", secret).update(`first-call:${basis}`).digest("hex").slice(0, 40)}`;
}

/**
 * Erase (dry: count) or export a wallet's data in the state database.
 * `query(text, params)` runs one statement and returns { rows, rowCount }.
 * Returns { report: [{ store, count, note }], data } (data on export only).
 */
export async function walletSubjectRun({ query, schema, wallet, action, dry = false, secret }) {
  const w = String(wallet).trim();
  const evm = walletKind(w) === "evm";
  // A wallet column matched case-folded on EVM only (base58 and StrKey are exact).
  const eq = (col, n = 1) => (evm ? `lower(${col}) = lower($${n})` : `${col} = $${n}`);
  const T = (t) => `${schema}.${t}`;
  const report = [];
  const data = {};
  const absent = (e) => e?.code === "42P01" || /does not exist/.test(String(e?.message || ""));
  async function step(store, fn) {
    try { await fn(); } catch (e) { if (absent(e)) report.push({ store, count: 0, note: "absent" }); else report.push({ store, count: null, note: `FAILED (${String(e?.message || e).slice(0, 160)})`, failed: true }); }
  }
  const read = async (store, sql) => { const r = await query(sql, [w]); data[store] = r.rows; return r.rows.length; };
  const erase = action === "erase" && !dry;

  await step("memory", async () => {
    const tables = [["memory_kv", "ns"], ["memory_docs", "ns"], ["memory_requests", "ns"], ["memory_memlog", "ns"]];
    let n = 0;
    if (action === "export") {
      for (const [t, c] of tables) if (t !== "memory_requests") n += await read(t, `SELECT * FROM ${T(t)} WHERE ${eq(c)}`);
      n += await read("memory_grants", `SELECT * FROM ${T("memory_grants")} WHERE ${eq("owner")} OR ${eq("grantee")}`);
    } else {
      for (const [t, c] of tables) n += (await query(`${erase ? "DELETE" : "SELECT 1"} FROM ${T(t)} WHERE ${eq(c)}`, [w])).rowCount;
      n += (await query(`${erase ? "DELETE" : "SELECT 1"} FROM ${T("memory_grants")} WHERE ${eq("owner")} OR ${eq("grantee")}`, [w])).rowCount;
    }
    report.push({ store: "memory", count: n, note: action === "export" ? "rows" : `rows ${erase ? "deleted" : "would be deleted"} (namespace, documents, its audit log, grants)` });
  });
  await step("issued_receipts", async () => {
    const n = action === "export" ? await read("issued_receipts", `SELECT receipt_id, ts, rail, settlement, slug, jws FROM ${T("issued_receipts")} WHERE ${eq("payer")}`)
      : (await query(`${erase ? "DELETE" : "SELECT 1"} FROM ${T("issued_receipts")} WHERE ${eq("payer")}`, [w])).rowCount;
    report.push({ store: "issued_receipts", count: n, note: action === "export" ? "receipts" : `receipts ${erase ? "deleted" : "would be deleted"}` });
  });
  await step("sale_feedback", async () => {
    const n = action === "export" ? await read("sale_feedback", `SELECT tx, slug, verdict, reason, ts FROM ${T("sale_feedback")} WHERE ${eq("payer")}`)
      : (await query(erase ? `UPDATE ${T("sale_feedback")} SET reason = NULL WHERE ${eq("payer")} AND reason IS NOT NULL` : `SELECT 1 FROM ${T("sale_feedback")} WHERE ${eq("payer")} AND reason IS NOT NULL`, [w])).rowCount;
    report.push({ store: "sale_feedback", count: n, note: action === "export" ? "verdicts" : `reasons ${erase ? "removed" : "would be removed"} (the verdict stays)` });
  });
  await step("decide", async () => {
    let n = 0;
    for (const t of ["decisions", "credits", "runs"]) {
      const tbl = T(`decide_ledger_${t}`);
      if (action === "export") n += await read(`decide_${t}`, `SELECT * FROM ${tbl} WHERE ${eq("payer")}`);
      else n += (await query(erase ? `UPDATE ${tbl} SET payer = NULL WHERE ${eq("payer")}` : `SELECT 1 FROM ${tbl} WHERE ${eq("payer")}`, [w])).rowCount;
    }
    report.push({ store: "decide", count: n, note: action === "export" ? "rows" : `rows ${erase ? "had the wallet removed" : "would have the wallet removed"}` });
  });
  await step("first-call-allowance", async () => {
    const r = await query(`SELECT id, body FROM ${T("records")} WHERE collection = 'first-call-allowance' AND ${eq("id")}`, [w]);
    if (action === "export") { data["first-call-allowance"] = r.rows; report.push({ store: "first-call-allowance", count: r.rows.length, note: "grant records" }); return; }
    const key = allowanceRecordKey(w, secret);
    if (r.rows.length && !key) { report.push({ store: "first-call-allowance", count: r.rows.length, note: "kept: no telemetry secret to key it by (set TELEMETRY_ID_SECRET as the server has it)", failed: true }); return; }
    if (erase) for (const row of r.rows) {
      const body = { grantedAt: row.body?.grantedAt || null, erasedAt: new Date().toISOString() };
      await query(`INSERT INTO ${T("records")} (collection, id, body) VALUES ('first-call-allowance', $1, $2::jsonb) ON CONFLICT (collection, id) DO NOTHING`, [key, JSON.stringify(body)]);
      await query(`DELETE FROM ${T("records")} WHERE collection = 'first-call-allowance' AND id = $1`, [row.id]);
    }
    report.push({ store: "first-call-allowance", count: r.rows.length, note: `grant records ${erase ? "moved" : "would move"} to a keyed hash (the wallet still has had its one grant)` });
  });
  if (action === "export") {
    await step("sales", async () => {
      const n = await read("sales", `SELECT ts, slug, price_usd, rail, network, tx, response_sha256, attest_uid FROM ${T("sales")} WHERE ${eq("payer")} ORDER BY ts`);
      report.push({ store: "sales", count: n, note: "sales ledger rows (kept for accounting; also public on chain)" });
    });
    await step("refunds", async () => {
      const n = await read("refunds", `SELECT * FROM ${T("refunds")} WHERE ${eq("payer")}`);
      report.push({ store: "refunds", count: n, note: "refund ledger rows (kept for accounting)" });
    });
  } else {
    report.push({ store: "sales, refunds, sanctions records", count: null, note: "kept: accounting, tax and sanctions records the law requires (the same payments are public on chain)" });
  }
  return { report, data: action === "export" ? data : undefined, failed: report.some((r) => r.failed) };
}
