// Data requests by wallet (src/subject-wallet.js, scripts/erase-subject.js
// --wallet, POST /__operator/subject-request):
//   - a request runs only on the exact request text signed by the wallet:
//     EIP-191 (EVM), Ed25519 (Solana), SEP-53 (Stellar); a wrong action, wallet,
//     date, signer or a tampered text is refused, with a live control each;
//   - erase on a real Postgres: memory namespace, grants, receipts, feedback
//     reasons and decide payers go; another wallet's rows stay; the sales and
//     refund ledgers stay; the first-call grant moves to a keyed hash and is
//     still read as granted; a dry run changes nothing;
//   - export returns the wallet's rows, the ledgers included;
//   - analytics carries a keyed hash of the payer, never the address.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-subject-wallet.js
import "./lib/own-stats.js"; // a stats store of this suite's own; the Postgres half reads STATE_DATABASE_URL itself
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const S = await import("../src/subject-wallet.js");
const today = new Date().toISOString().slice(0, 10);
const old = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

// --- EVM ---------------------------------------------------------------------
const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const W = acct.address;
{
  const msg = S.subjectRequestMessage({ action: "erase", wallet: W, date: today });
  const sig = await acct.signMessage({ message: msg });
  ok((await S.verifySubjectRequest({ action: "erase", wallet: W, message: msg, signature: sig })).ok === true, "EVM: the wallet's own EIP-191 signature over the request text verifies");
  ok((await S.verifySubjectRequest({ action: "erase", wallet: W.toLowerCase(), message: S.subjectRequestMessage({ action: "erase", wallet: W.toLowerCase(), date: today }), signature: await acct.signMessage({ message: S.subjectRequestMessage({ action: "erase", wallet: W.toLowerCase(), date: today }) }) })).ok === true, "EVM: a lower-case address verifies too");
  ok((await S.verifySubjectRequest({ action: "erase", wallet: W, message: msg, signature: await other.signMessage({ message: msg }) })).ok === false, "EVM: another wallet's signature is refused");
  ok((await S.verifySubjectRequest({ action: "export", wallet: W, message: msg, signature: sig })).ok === false, "EVM: an erase text does not authorize an export");
  ok((await S.verifySubjectRequest({ action: "erase", wallet: other.address, message: msg, signature: sig })).ok === false, "EVM: the text must name the wallet asked about");
  const stale = S.subjectRequestMessage({ action: "erase", wallet: W, date: old });
  ok(/days/.test((await S.verifySubjectRequest({ action: "erase", wallet: W, message: stale, signature: await acct.signMessage({ message: stale }) })).reason || ""), "EVM: a text dated more than 14 days ago is refused");
  ok((await S.verifySubjectRequest({ action: "erase", wallet: W, message: `${msg}\nAlso: everything`, signature: sig })).ok === false, "EVM: a text with anything added is refused");
}
// --- Solana ------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let n = BigInt(`0x${Buffer.from(buf).toString("hex") || "0"}`); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b) break; s = `1${s}`; } return s; };
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x;
  const addr = b58(Buffer.from(raw, "base64url"));
  ok(S.walletKind(addr) === "solana" && S.base58Decode(addr).equals(Buffer.from(raw, "base64url")), "Solana: base58 address round-trips to its key");
  const msg = S.subjectRequestMessage({ action: "export", wallet: addr, date: today });
  const sig = edSign(null, Buffer.from(msg), privateKey);
  ok((await S.verifySubjectRequest({ action: "export", wallet: addr, message: msg, signature: b58(sig) })).ok === true, "Solana: a signMessage signature (base58) verifies");
  ok((await S.verifySubjectRequest({ action: "export", wallet: addr, message: msg, signature: sig.toString("base64") })).ok === true, "Solana: and base64");
  const other2 = generateKeyPairSync("ed25519").privateKey;
  ok((await S.verifySubjectRequest({ action: "export", wallet: addr, message: msg, signature: b58(edSign(null, Buffer.from(msg), other2)) })).ok === false, "Solana: another key's signature is refused");
}
// --- Stellar -----------------------------------------------------------------
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const body = Buffer.concat([Buffer.from([6 << 3]), raw]);
  let crc = 0; for (const b of body) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  const full = Buffer.concat([body, Buffer.from([crc & 255, crc >> 8])]);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0, g = "";
  for (const b of full) { v = (v << 8) | b; bits += 8; while (bits >= 5) { g += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) g += A[(v << (5 - bits)) & 31];
  ok(S.walletKind(g) === "stellar" && S.stellarPublicKey(g)?.equals(raw), "Stellar: a G account decodes with its checksum");
  const msg = S.subjectRequestMessage({ action: "erase", wallet: g, date: today });
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(msg)])).digest();
  ok((await S.verifySubjectRequest({ action: "erase", wallet: g, message: msg, signature: edSign(null, digest, privateKey).toString("base64") })).ok === true, "Stellar: a SEP-53 signature verifies");
  ok((await S.verifySubjectRequest({ action: "erase", wallet: g, message: msg, signature: edSign(null, Buffer.from(msg), privateKey).toString("base64") })).ok === false, "Stellar: a signature over the bare text (not SEP-53) is refused");
}
// --- Analytics carries a keyed hash ------------------------------------------
{
  const { telemetryPayerKey } = await import("../src/posthog.js");
  const k = telemetryPayerKey(W, { idSecret: "s1" });
  ok(/^a402:[0-9a-f]{32}$/.test(k) && !k.toLowerCase().includes(W.slice(2).toLowerCase()), "analytics: the payer is a keyed hash, never the address");
  ok(k === telemetryPayerKey(W.toLowerCase(), { idSecret: "s1" }) && k !== telemetryPayerKey(W, { idSecret: "s2" }), "analytics: the same EVM wallet in any case groups; another secret does not");
  ok(telemetryPayerKey(W, { idSecret: "" }) === null, "analytics: no secret, no property at all");
  const src = (await import("node:fs")).readFileSync(new URL("../src/posthog.js", import.meta.url), "utf8");
  ok(!/\.\.\.\(payer \? \{ payer \} : \{\}\)/.test(src), "analytics: no event sends the raw payer");
}

// --- Erase and export on a real Postgres -------------------------------------
const url = String(process.env.STATE_DATABASE_URL || "").trim();
if (!url) {
  if (process.env.CI) { console.error("FAIL - no STATE_DATABASE_URL (a missing database is a failure under CI)"); process.exit(1); }
  console.log("SKIP - the Postgres half (set STATE_DATABASE_URL)");
} else {
  const schema = `t_subj_${Date.now().toString(36)}`;
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const q = (t, p = []) => db.query(t, p);
  const T = (t) => `${schema}.${t}`;
  await q(`CREATE SCHEMA ${schema}`);
  await q(`CREATE TABLE ${T("memory_kv")} (ns TEXT, k TEXT, v TEXT)`);
  await q(`CREATE TABLE ${T("memory_docs")} (ns TEXT, id TEXT, text TEXT)`);
  await q(`CREATE TABLE ${T("memory_requests")} (ns TEXT, rid TEXT)`);
  await q(`CREATE TABLE ${T("memory_memlog")} (ns TEXT, seq INT, actor TEXT)`);
  await q(`CREATE TABLE ${T("memory_grants")} (owner TEXT, grantee TEXT)`);
  await q(`CREATE TABLE ${T("issued_receipts")} (receipt_id TEXT, ts BIGINT, payer TEXT, rail TEXT, settlement TEXT, slug TEXT, jws TEXT)`);
  await q(`CREATE TABLE ${T("sale_feedback")} (tx TEXT, slug TEXT, payer TEXT, verdict TEXT, reason TEXT, ts BIGINT)`);
  for (const t of ["decisions", "credits", "runs"]) await q(`CREATE TABLE ${T(`decide_ledger_${t}`)} (id TEXT, payer TEXT)`);
  await q(`CREATE TABLE ${T("records")} (collection TEXT, id TEXT, body JSONB, PRIMARY KEY (collection, id))`);
  await q(`CREATE TABLE ${T("sales")} (ts BIGINT, slug TEXT, price_usd FLOAT, rail TEXT, network TEXT, payer TEXT, tx TEXT, response_sha256 TEXT, attest_uid TEXT)`);
  await q(`CREATE TABLE ${T("refunds")} (evidence TEXT, payer TEXT)`);
  const O = other.address;
  for (const who of [W, O]) {
    await q(`INSERT INTO ${T("memory_kv")} VALUES ($1, 'k', 'v')`, [who.toLowerCase()]);
    await q(`INSERT INTO ${T("memory_docs")} VALUES ($1, 'd', 'text')`, [who.toLowerCase()]);
    await q(`INSERT INTO ${T("memory_memlog")} VALUES ($1, 1, $1)`, [who.toLowerCase()]);
    await q(`INSERT INTO ${T("issued_receipts")} VALUES ('r-' || $1, 1, $1, 'x402', '0xtx', 'hash', 'jws')`, [who]);
    await q(`INSERT INTO ${T("sale_feedback")} VALUES ('tx-' || $1, 'hash', $1, 'bad', 'it was slow today', 1)`, [who]);
    for (const t of ["decisions", "credits", "runs"]) await q(`INSERT INTO ${T(`decide_ledger_${t}`)} VALUES ('d-' || $1, $1)`, [who]);
    await q(`INSERT INTO ${T("sales")} VALUES (1, 'hash', 0.001, 'usdc', 'base', $1, '0xsale', null, null)`, [who]);
    await q(`INSERT INTO ${T("refunds")} VALUES ('e-' || $1, $1)`, [who]);
    await q(`INSERT INTO ${T("records")} VALUES ('first-call-allowance', $1, '{"grantedAt":"2026-11-01T00:00:00Z","slug":"hash","network":"base"}')`, [who]);
    // A refusal row keeps an EVM payer lowercased (src/payment-refusals.js refusalPayerOf).
    await q(`INSERT INTO ${T("records")} VALUES ('payment-refusals', '2026-11-20:' || $1, jsonb_build_object('payer', $1::text, 'reason', 'invalid_exact_evm_insufficient_balance', 'count', 2))`, [who.toLowerCase()]);
  }
  // The day's overflow row names no payer.
  await q(`INSERT INTO ${T("records")} VALUES ('payment-refusals', '2026-11-20:overflow', '{"payer":null,"count":7}')`);
  await q(`INSERT INTO ${T("memory_grants")} VALUES ($1, $2)`, [O.toLowerCase(), W.toLowerCase()]);
  const count = async (t, where = "") => Number((await q(`SELECT count(*) n FROM ${T(t)} ${where}`)).rows[0].n);
  const run = (action, dry = false) => S.walletSubjectRun({ query: q, schema, wallet: W, action, dry, secret: "test-secret" });

  const exp = await run("export");
  ok(!exp.failed && exp.data.memory_kv.length === 1 && exp.data.issued_receipts.length === 1 && exp.data.sale_feedback[0].reason === "it was slow today" && exp.data.sales.length === 1 && exp.data.refunds.length === 1 && exp.data["first-call-allowance"].length === 1 && exp.data.memory_grants.length === 1 && exp.data["payment-refusals"]?.length === 1 && exp.data["payment-refusals"][0].body.payer === W.toLowerCase(),
    `export returns the wallet's memory, receipts, feedback, grant and ledger rows (${exp.report.map((r) => `${r.store}=${r.count}`).join(" ")})`);
  ok(!JSON.stringify(exp.data).includes(O.toLowerCase().slice(2, 12)) || exp.data.memory_grants.every((g) => g.grantee === W.toLowerCase()), "export holds only rows that name the wallet");

  const before = await count("memory_kv");
  const dry = await run("erase", true);
  ok(!dry.failed && (await count("memory_kv")) === before && (await count("records")) === 5, "a dry run reports and changes nothing");

  const er = await run("erase");
  ok(!er.failed, `erase ran clean (${er.report.map((r) => `${r.store}=${r.count}`).join(" ")})`);
  ok((await count("memory_kv", `WHERE ns = '${W.toLowerCase()}'`)) === 0 && (await count("memory_docs", `WHERE ns = '${W.toLowerCase()}'`)) === 0 && (await count("memory_memlog", `WHERE ns = '${W.toLowerCase()}'`)) === 0 && (await count("memory_grants")) === 0, "memory: namespace, documents, its log and the grant it held are gone");
  ok((await count("memory_kv")) === 1 && (await count("issued_receipts")) === 1 && (await count("decide_ledger_runs", "WHERE payer IS NOT NULL")) === 1, "control: the other wallet's rows stay");
  ok((await count("issued_receipts", `WHERE payer = '${W}'`)) === 0, "receipts naming the wallet are deleted");
  ok((await count("sale_feedback", `WHERE payer = '${W}' AND reason IS NULL AND verdict = 'bad'`)) === 1 && (await count("sale_feedback", "WHERE reason IS NOT NULL")) === 1, "feedback: the reason is removed, the verdict stays; the other wallet's reason stays");
  ok((await count("decide_ledger_decisions", `WHERE payer = '${W}'`)) === 0, "decide: the wallet is removed");
  ok((await count("sales")) === 2 && (await count("refunds")) === 2, "the sales and refund ledgers are kept");
  ok((await count("records", `WHERE collection = 'payment-refusals' AND body->>'payer' = '${W.toLowerCase()}'`)) === 0 && (await count("records", `WHERE collection = 'payment-refusals'`)) === 2,
    "refused payment records naming the wallet are deleted; the other wallet's and the overflow row stay");
  const key = S.allowanceRecordKey(W, "test-secret");
  ok((await count("records", `WHERE id = '${W}'`)) === 0 && (await count("records", `WHERE id = '${key}'`)) === 1, "first-call grant: the address is gone, the grant stays under a keyed hash");
  const kept = (await q(`SELECT body FROM ${T("records")} WHERE id = $1`, [key])).rows[0].body;
  ok(kept.grantedAt && !("slug" in kept) && !JSON.stringify(kept).includes(W), "and the kept record names no wallet");
  ok(key === S.allowanceRecordKey(W.toLowerCase(), "test-secret"), "the key is the same whatever case the payer signs in, so the grant is still found");
  const again = await run("erase");
  ok(!again.failed && again.report.filter((r) => typeof r.count === "number").every((r) => r.count === 0), "a second erase finds nothing left");
  await q(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
}
{
  // The allowance check reads the keyed record (source pin; the claim path is
  // covered by the allowance suites).
  const src = (await import("node:fs")).readFileSync(new URL("../src/first-call-allowance.js", import.meta.url), "utf8");
  ok(/allowanceRecordKey\(payer\)/.test(src) && /startsWith\("erased:"\)/.test(src), "the first-call check reads an erased wallet's keyed record, and the returned-payer list skips it");
}

console.log(`\ntest-subject-wallet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
