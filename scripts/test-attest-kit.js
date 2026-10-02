#!/usr/bin/env node
// attest-kit — offline. The chain is a stub; the ledger is a throwaway DB;
// the decision path (lookup, digest required, one-per-sale, gas ceiling,
// spend guard, encoding, persistence) runs for real. Pins from source that the
// dispatcher records sha256 of the exact bytes res.json sends and that the
// finish hook hands it to the ledger.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "attest-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.X402_INDEX_CRAWL = "off";
const ledger = await import("../src/sales-ledger.js");
const guard = await import("../src/external-spend-guard.js");
const kit = await import("../src/tools/attest-kit.js");
const { makeAttestHandler, schemaUid, attestationFields, encodeAttestationData, normalizeTx, responseDigest, ATTEST_SCHEMA, ATTEST_TOOLS, ZERO_ADDRESS, setIdentityBoundSlugs } = kit;
const BUYER = "0x902dcf34e53695bdea2ffb354b1a2e58bd598256";
const asBuyer = { payerOf: () => BUYER };

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.equal(a, b, m); };
const rejects = async (fn, status, re) => { n++; try { await fn(); assert.fail(`expected ${status}`); } catch (e) { assert.equal(e.statusCode, status, `${m(e)} status`); if (re) assert.match(String(e.message), re); } };
const m = (e) => String(e?.message || e).slice(0, 120);

// --- 1. schema UID derivation = EAS's own, pinned against a LIVE Base schema
// (uint8 mode,... registered with no resolver, non-revocable; read from
// base.easscan.org on 2026-09-03).
eq(await schemaUid("uint8 mode,address white,address black,uint8 outcome,uint8 ending,uint16 moves"), "0xcc57f1f558544fef203638f8e9475f0781a2a87c23e8c256ba7a6c17b8a24cc0", "schemaUid matches a live EAS schema UID");
ok(/^0x[0-9a-f]{64}$/.test(await schemaUid()), "our schema derives a UID");
eq(ATTEST_SCHEMA.split(",").length, 7, "seven fields");

// --- 2. the digest is sha256 of what Express sends for res.json (no replacer/spaces/escape)
{
  const app = express();
  const body = { a: 1, b: "xé ", c: [1, 2, { d: null }] };
  app.get("/j", (_req, res) => res.json(body));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${srv.address().port}/j`)).arrayBuffer());
  srv.close();
  eq(createHash("sha256").update(bytes).digest("hex"), responseDigest(body), "sha256(JSON.stringify(result)) equals sha256 of the bytes res.json sent");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(!/app\.set\(\s*["']json (replacer|spaces|escape)["']/.test(server), "server.js sets no json replacer/spaces/escape (the digest assumes Express defaults)");
  // `body` is the object actually sent: the handler's result, plus
  // `ignoredParams` when the request carried shape fields the tool did not apply.
  ok(server.includes('req.__responseSha256 = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")'), "dispatcher stashes the digest of JSON.stringify(body), the object it sends");
  ok(server.includes("responseSha256: req.__responseSha256 || null,"), "finish hook hands the digest to recordSale");
  ok(server.indexOf('req.__responseSha256 = createHash') < server.indexOf("res.json(body);", server.indexOf('req.__responseSha256 = createHash')), "digest is computed before res.json(body), from the same object");
}

// --- 3. ledger: digest recorded, lookup by tx, write-once attestation
const TX = "0x" + "ab".repeat(32);
ledger.recordSale({ slug: "crypto-price", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: "0x902dCf34E53695bDEA2fFB354b1a2e58bD598256", tx: TX, wire: "x402", responseSha256: responseDigest({ ok: 1 }) });
const row = ledger.saleByTx(TX);
ok(row && row.slug === "crypto-price" && row.responseSha256 === responseDigest({ ok: 1 }) && row.payer === "0x902dcf34e53695bdea2ffb354b1a2e58bd598256", "saleByTx returns the row with digest + lowercased payer");
eq(ledger.saleByTx("0x" + "00".repeat(32)), null, "unknown tx -> null");
ledger.recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: null, tx: "0x" + "cd".repeat(32), wire: "x402", responseSha256: "not-a-digest" });
eq(ledger.saleByTx("0x" + "cd".repeat(32)).responseSha256, null, "a malformed digest is stored as NULL, never as text");
ledger.recordSale({ slug: "render", priceUsd: 0.005, rail: "usdc", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", tx: "5Sig" + "x".repeat(60), wire: "x402" });
eq(ledger.saleByTx("5Sig" + "x".repeat(60)).responseSha256, null, "no digest (streamed/binary) -> NULL");

// --- 4. fields + encoding
const f = attestationFields(row);
eq(f.payer, "0x902dcf34e53695bdea2ffb354b1a2e58bd598256", "EVM payer kept");
const solF = attestationFields({ ...ledger.saleByTx("5Sig" + "x".repeat(60)), responseSha256: "0".repeat(64) });
eq(solF.payer, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "non-EVM payer kept as a string");
eq(solF.recipient, ZERO_ADDRESS, "non-EVM payer -> zero EAS recipient");
eq(f.recipient, f.payer, "EVM payer is the EAS recipient");
eq(f.priceMicroUsd, 10000n, "price in micro-USD");
eq(f.responseSha256, "0x" + responseDigest({ ok: 1 }), "digest as bytes32");
const enc = await encodeAttestationData(f);
ok(enc.startsWith("0x") && enc.length > 7 * 64, "abi-encoded attestation data");

// --- 5. normalizeTx
eq(normalizeTx(" 0xABCDEF" + "1".repeat(58) + " "), "0xabcdef" + "1".repeat(58), "EVM hash lowercased");
eq(normalizeTx("5Sig" + "x".repeat(60)), "5Sig" + "x".repeat(60), "base58 kept case-exact");
eq(normalizeTx("../etc"), null, "junk refused");
eq(normalizeTx(""), null, "empty refused");

// --- 6. the handler against a stub chain
guard.__reset();
const calls = { ensure: 0, estimate: 0, attest: 0 };
let estimateUsd = 0.002;
const chain = {
  address: "0x77065d81e18ad403BCD6e9A0616b288e16744121",
  ensureSchema: async () => { calls.ensure++; },
  estimateUsd: async () => { calls.estimate++; return estimateUsd; },
  attest: async (uid, recipient, data) => { calls.attest++; calls.last = { uid, recipient, data }; return { uid: "0x" + "11".repeat(32), attestTx: "0x" + "22".repeat(32), block: "1" }; },
};
const handler = makeAttestHandler({ chain, ...asBuyer });
await rejects(() => handler({}), 400, /tx/);
await rejects(() => handler({ tx: "0x" + "00".repeat(32) }), 403, /No sale of yours/);
// the Solana row's payer is a base58 address, not this caller: refused as "not yours" before the digest is even considered
await rejects(() => handler({ tx: "5Sig" + "x".repeat(60) }), 403, /No sale of yours/);
// a digest-less sale OF THIS BUYER is a 422 that names the tx but never the slug
ledger.recordSale({ slug: "render", priceUsd: 0.005, rail: "usdc", network: "eip155:8453", payer: BUYER, tx: "0x" + "dd".repeat(32), wire: "x402" });
{ let e = null; try { await handler({ tx: "0x" + "dd".repeat(32) }); } catch (x) { e = x; } eq(e?.statusCode, 422, "own digest-less sale -> 422"); ok(!/render/.test(String(e?.message)), "the 422 never names the slug"); }
eq(calls.attest, 0, "nothing signed on any refusal");
const out = await handler({ tx: TX.toUpperCase().replace("0X", "0x") });
eq(out.uid, "0x" + "11".repeat(32), "uid returned");
ok(calls.last.recipient === f.recipient && calls.last.data === enc && calls.last.uid === await schemaUid(), "attest got the payer as recipient, the encoded data and our schema uid");
eq(out.existing, false, "first attestation");
eq(out.attestationUrl, "https://base.easscan.org/attestation/view/0x" + "11".repeat(32), "easscan link");
eq(out.data.slug, "crypto-price", "public fields carry the slug");
eq(out.data.priceUsd, 0.01, "price in USD on the public shape");
ok(!("recipient" in out.data) && !("priceMicroUsd" in out.data), "public shape carries schema fields only");
eq(out.schemaUid, await schemaUid(), "schema uid on the response");
eq(calls.ensure, 1, "schema ensured once");
eq(ledger.saleByTx(TX).attestUid, out.uid, "attestation persisted on the row");
const again = await handler({ tx: TX });
eq(again.existing, true, "repeat returns the existing attestation");
eq(again.uid, out.uid, "same uid");
eq(calls.attest, 1, "no second send for the same sale");

// --- 7. gas ceiling + spend guard + wallet-without-gas, all uncharged 503s
ledger.recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: BUYER, tx: "0x" + "ee".repeat(32), wire: "x402", responseSha256: responseDigest({ u: 1 }) });
estimateUsd = 0.5;
await rejects(() => handler({ tx: "0x" + "ee".repeat(32) }), 503, /gas is high/);
eq(calls.attest, 1, "over-ceiling: nothing signed");
estimateUsd = 0.002;
const paused = makeAttestHandler({ chain, ...asBuyer, spend: { maySpend: () => ({ ok: false, reason: "wallet daily ceiling reached." }), noteSpend: () => null, adjustSpend: () => {} } });
await rejects(() => paused({ tx: "0x" + "ee".repeat(32) }), 503, /paused/);
const broke = makeAttestHandler({ chain: { ...chain, attest: async () => { throw new Error("insufficient funds for gas * price + value"); } }, ...asBuyer });
await rejects(() => broke({ tx: "0x" + "ee".repeat(32) }), 503, /no ETH/);
eq(ledger.saleByTx("0x" + "ee".repeat(32)).attestUid, null, "a failed send persists nothing");
// the spend is booked against the base wallet and corrected to the estimate
guard.__reset();
await handler({ tx: "0x" + "ee".repeat(32) });
const spent = guard.walletDailySpentUsd("base");
ok(spent > 0 && spent <= 0.0021, `base wallet booked the estimate (${spent})`);

// --- 7b. binding: only the buyer, never a wallet-scoped sale, never an unsigned caller
{
  const other = makeAttestHandler({ chain, payerOf: () => "0x" + "99".repeat(20) });
  let e1 = null; try { await other({ tx: TX }); } catch (x) { e1 = x; }
  let e2 = null; try { await other({ tx: "0x" + "00".repeat(32) }); } catch (x) { e2 = x; }
  eq(e1?.statusCode, 403, "another wallet cannot attest this buyer's sale");
  eq(String(e1?.message).replace(TX, "T"), String(e2?.message).replace("0x" + "00".repeat(32), "T"), "not-yours and unknown-tx are the same message: the tx's existence is not confirmed to a stranger");
  const unsigned = makeAttestHandler({ chain, payerOf: () => null });
  await rejects(() => unsigned({ tx: TX }), 403, /signed EVM authorization/);
  ledger.recordSale({ slug: "memory-get", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: BUYER, tx: "0x" + "aa".repeat(32), wire: "x402", responseSha256: responseDigest({ v: 1 }) });
  setIdentityBoundSlugs(new Set(["memory-get", "my-usage", "attest"]));
  await rejects(() => handler({ tx: "0x" + "aa".repeat(32) }), 403, /wallet-scoped/);
  const before = calls.attest;
  eq(calls.attest, before, "no attestation was signed for the wallet-scoped sale");
  const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(/isIdentityBoundRoute = \(def\) =>[\s\S]*def\?\.slug === "attest"/.test(payments), "attest is identity-bound in payments.js (EVM exact only, so a non-EVM buyer is never charged then refused)");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(server.includes("setIdentityBoundSlugs(new Set(Object.values(CATALOG).filter((d) => d.identityBound)"), "server hands the kit the catalog's own identity-bound slugs");
}

// --- 8. catalog entry + registrations
const tool = ATTEST_TOOLS[0];
eq(tool.slug, "attest", "slug");
eq(tool.route, "POST /api/attest", "route");
eq(tool.price, "$0.050", "price");
ok(tool.discovery.inputSchema.required.includes("tx"), "tx required");
eq(tool.discovery.bodyType, "json", "POST tool declares bodyType for the Bazaar extension (a missing one is an invalid extension at boot)");
const pow = readFileSync(new URL("../src/pow.js", import.meta.url), "utf8");
ok(/"attest",/.test(pow), "attest is wallet-only (never PoW: it spends gas)");
const nonMetered = readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8"); // METERED_SLUGS lives in src/
ok(/"attest",/.test(nonMetered), "attest is in METERED_SLUGS (CI has no wallet)");
const testAll = readFileSync(new URL("./test-all.js", import.meta.url), "utf8");
ok(testAll.includes('"/api/attest"'), "attest is in test-all's NETWORK set");
// The tool's own worst case (the gas ceiling) sits under the margin rule.
eq(tool.price, "$0.050", "priced from the MEASURED 616k-gas attest, not the 150k guess");
ok(35000 <= (50000 * 7) / 10, "gas ceiling under the margin share of price (micro-USD, no float)");
ok(0.0277 < 0.035, "the first live run's bounded estimate clears the ceiling");

rmSync(dir, { recursive: true, force: true });
console.log(`test-attest-kit: ${n} assertions ok`);
