#!/usr/bin/env node
// The router must never sign a payment to a sanctioned address, and never
// sign one to an address it could not screen.
//
// We buy from external sellers with our own wallet to resell. The check runs
// against the ONE accept (or challenge) about to be signed rather than an
// origin's advertised address: the 402 is the instruction, the listing is a
// claim. The rule pinned here:
//   - a listed address is refused (403) before anything is signed;
//   - no list held (none downloaded, none stored) refuses every external
//     payout (503) before anything is signed, and route-execute stops on the
//     first such refusal instead of trying every candidate into it;
//   - a list older than its refresh period still screens;
//   - the address map is stored with each download and read back at boot,
//     before the server listens, so a restart screens without a download.
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "router-sanctions-"));
process.env.SANCTIONS_PAYOUT_FILE = join(dir, "payout.json");
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(dir, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const buyerSrc = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
const tempoSrc = readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
const routeSrc = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const kitSrc = readFileSync(new URL("../src/tools/sanctions-kit.js", import.meta.url), "utf8");

// --- placement: what we verify must be what we sign -------------------------
{
  const payFn = buyerSrc.slice(buyerSrc.indexOf("export async function payX402("));
  const i = payFn.indexOf("await assertPayoutScreened(payable.payTo");
  ok(i > 0, "payX402 screens `payable.payTo`, the single accept about to be signed");
  ok(i < payFn.indexOf("const signable ="), "...before anything is signed");
  ok(i < payFn.indexOf("reserveSpend(quotedAtomic)"), "...and before any spend budget is held");
  ok(i > payFn.indexOf("provenPayToMatches({ provenPayTo"), "beside the other pay-time gates, which all key off the same pinned accept");
  ok(i < payFn.indexOf('if (chain === "solana") {\n    const { assertProvenSolanaSeller'), "and ahead of the per-chain gates, so Base, Solana and Algorand all pass through it");
  const blk = buyerSrc.slice(buyerSrc.indexOf("// SANCTIONS: never sign"), buyerSrc.indexOf("// SOLANA PROVEN-SELLER GATE"));
  ok(!/try \{/.test(blk) && !/proceeding unscreened/.test(blk), "the call site has no catch that could turn a refusal into an unscreened payment");
  ok(/503 when no list is held/.test(blk) && /still screens/.test(blk), "the comment states the rule: no list refuses, a stale list screens");

  const t = tempoSrc.slice(tempoSrc.indexOf("export async function payTempo("));
  const ti = t.indexOf("await assertPayoutScreened(recipient");
  ok(ti > 0, "payTempo screens the challenge's recipient");
  ok(ti > t.indexOf("names no valid recipient") && ti < t.indexOf("proof(recipient)") && ti < t.indexOf("const mint ="), "...after the recipient is validated and before the history read and any credential is minted");

  ok(/const screenUnavailable = e\?\.screenUnavailable === true;/.test(routeSrc) && /!waitedOnRefusal && !screenUnavailable\)/.test(routeSrc),
    "route-execute does not fall through to another candidate on a screen-unavailable refusal");
  const store = serverSrc.indexOf("startSanctionsPayoutStore();");
  ok(store > 0 && store < serverSrc.indexOf("await stateStoresReady({"), "server.js reads the stored payout map before it awaits the state stores and listens");
  ok(/trackStoreReady\(loadStoredPayoutList\(\), "sanctions-payout"\)/.test(kitSrc), "the stored read is registered with trackStoreReady");
}

// --- the router-facing primitive -------------------------------------------
{
  const fn = kitSrc.slice(kitSrc.indexOf("export async function screenAddressForPayment"), kitSrc.indexOf("/** The message a payout refused"));
  ok(/if \(!payout\.fetchedAt\) throw new Error/.test(fn), "it THROWS when no list is held: a null cannot mean both 'not listed' and 'no list'");
  ok(!/await loadSanctions/.test(fn), "and it never fetches - a payment path must not wait on a ~30MB download");
  ok(/payout\.addresses\.get\(key\) \|\| null/.test(fn), "a match returns the SDN entry so the refusal can name who it belongs to");
  ok(/normalizeAddress\(address\)/.test(fn), "the address is normalised first (EVM lowercased, base58 exact)");
  const gate = kitSrc.slice(kitSrc.indexOf("export async function assertPayoutScreened"), kitSrc.indexOf("/** Test seam: forget the payout map"));
  ok(/slice\(0, 64\)/.test(gate) && /slice\(0, 80\)/.test(gate) && /slice\(0, 16\)/.test(gate),
    "every interpolated value is length-bounded - the message is relayed to buyers, and the entity name comes from a third-party file");
}

const K = await import("../src/tools/sanctions-kit.js");
const buyer = await import("../src/x402-buyer.js");
const { payTempo } = await import("../src/tempo-buyer.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const guard = await import("../src/external-spend-guard.js");
const { stateStoresReady } = await import("../src/state-db.js");
const { parseSdnXml, __resetSdnListForTests } = await import("../src/ofac-sdn.js");

const LISTED = "0x" + "4c".repeat(20);       // on the stored fixture list
const CLEAN = "0x" + "5e".repeat(20);        // on no list
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const accept = (payTo) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const receipt = b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" });
const PAYTO = { "clean.example": CLEAN, "clean2.example": CLEAN, "listed.example": LISTED };
const hits = {};
let sdnFetches = 0;
const stubFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (/ofac|treas\.gov/.test(u.host)) { sdnFetches++; throw new Error("no download in this test"); }
  const h = init.headers || {};
  const paid = !!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"]);
  const k = `${u.host} ${paid ? "paid" : "bare"}`;
  hits[k] = (hits[k] || 0) + 1;
  if (paid) return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } });
  return new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept(PAYTO[u.host] || CLEAN)] }), "content-type": "application/json" } });
};
globalThis.fetch = stubFetch;
const count = (host, leg) => hits[`${host} ${leg}`] || 0;

// Spy the signer: payX402 signs through the cached buyer's client.
const ub = await buyer.getUpstreamBuyer();
let signs = 0;
const realSign = ub.client.createPaymentPayload.bind(ub.client);
ub.client.createPaymentPayload = async (...a) => { signs++; return realSign(...a); };

const notDebited = async () => ({ debited: false, observed: 1, expired: true });
const buy = (host) => buyer.payX402(`https://${host}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited }).then((r) => ({ r }), (e) => ({ e }));

const origWarn = console.warn;
const quiet = () => { console.warn = () => {}; };
const loud = () => { console.warn = origWarn; };

// --- 1. no list held: every external payout is refused before signing ------
{
  K.__resetSanctionsForTests();
  let threw = false;
  try { await K.screenAddressForPayment(CLEAN); } catch { threw = true; }
  ok(threw, "with no list the screen throws (unknown), never answers null");

  quiet(); const { e } = await buy("clean.example"); loud();
  ok(e?.statusCode === 503 && e?.screenUnavailable === true, `no list: payX402 refuses 503 screenUnavailable (got ${e?.statusCode})`);
  ok(/screening is temporarily unavailable/i.test(e?.message || "") && /Nothing was signed and nothing is charged/.test(e?.message || ""), "the message names screening as temporarily unavailable and says nothing was signed or charged");
  eq(signs, 0, "no list: the signer was never called");
  eq(count("clean.example", "paid"), 0, "no list: no paid request left");
  ok(e?.committed !== true, "no list: the refusal is not marked committed (nothing may have left)");

  // Tempo: the recipient is screened before the history read and the mint.
  let minted = 0, proofs = 0;
  const ch = 'Payment id="c1", realm="t.example", method="tempo", intent="charge", request="' +
    Buffer.from(JSON.stringify({ amount: "1000", currency: "0x20C000000000000000000000b9537d11c60E8b50", recipient: CLEAN, methodDetails: { chainId: 4217 } })).toString("base64url") + '"';
  globalThis.fetch = async () => new Response("{}", { status: 402, headers: { "www-authenticate": ch } });
  let te = null;
  quiet();
  try { await payTempo("https://t.example/x", { maxAtomic: 500000n, trusted: true, body: {}, createCredential: async () => { minted++; return "Payment x"; }, proof: async () => { proofs++; return { count: 999, payers: 99 }; } }); } catch (x) { te = x; }
  loud();
  globalThis.fetch = stubFetch;
  ok(te?.statusCode === 503 && te?.screenUnavailable === true, `no list: payTempo refuses 503 screenUnavailable (got ${te?.statusCode}: ${String(te?.message).slice(0, 80)})`);
  eq([minted, proofs], [0, 0], "no list: payTempo minted no credential and read no history");

  // Route-execute: the buyer's call fails >= 400 (x402 cancels its settlement),
  // nothing is booked, and the second candidate is never tried.
  const PRO = EXEC_TIERS.find((t) => t.slug === "route-execute-pro");
  const cand = (host) => ({ seller: `https://${host}`, slug: host.split(".")[0], url: `https://${host}/x`, method: "POST", price: "$0.001", networks: ["eip155:8453"] });
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: PRO,
    resolveExternal: async () => [cand("clean.example"), cand("clean2.example")],
    payExternal: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, memoizeDelivery: true, notDebited }),
    externalEnabled: () => true, externalChains: () => ["base"],
  });
  const before = guard.walletDailySpentUsd("base");
  let re = null;
  quiet();
  try { await tool.handler({ task: "t", include: "external", params: {} }, { ip: "198.51.100.7" }); } catch (x) { re = x; }
  loud();
  ok(re?.statusCode === 503, `route-execute answers 503, so the buyer's payment is not settled (got ${re?.statusCode}: ${String(re?.message).slice(0, 100)})`);
  ok(re?.screenUnavailable === true && re?.committed !== true, "...marked screenUnavailable and not committed");
  eq(count("clean2.example", "bare"), 0, "route-execute stops on the first screen refusal; the next candidate is not tried");
  eq(signs, 0, "route-execute: nothing was signed");
  ok(Math.abs(guard.walletDailySpentUsd("base") - before) < 1e-9, "route-execute: nothing stays booked on the chain's day");
}

// --- 2. a stored list is adopted at boot and screens with no download -----
{
  const fetchedAt = Date.now() - 3600_000;
  writeFileSync(process.env.SANCTIONS_PAYOUT_FILE, JSON.stringify({ v: 1, fetchedAt, publishDate: "10/01/2026", addresses: [
    { address: LISTED, asset: "ETH", entity: "STORED FIXTURE ENTITY", sdnId: "920001" },
    { address: "TXYZbase58CaseKept1111111111111111", asset: "USDT", entity: "STORED FIXTURE ENTITY", sdnId: "920001" },
  ] }));
  K.__resetSanctionsForTests();
  K.startSanctionsPayoutStore();
  eq(await stateStoresReady({ timeoutMs: 5000 }), "ready", "the stored payout map registers as a state store and loads before stateStoresReady resolves");
  ok(K.sanctionsStatus().payoutScreen.loaded && K.sanctionsStatus().payoutScreen.source === "store", "the stored copy is held (source store)");
  ok(!K.sanctionsStatus().loaded, "the names list is not claimed loaded from the address store");
  eq((await K.screenAddressForPayment(LISTED.toUpperCase().replace(/^0X/, "0x")))?.sdnId, "920001", "a listed EVM payTo matches in any case");
  eq((await K.screenAddressForPayment("TXYZbase58CaseKept1111111111111111"))?.sdnId, "920001", "a base58 address matches exactly");
  eq(await K.screenAddressForPayment("txyzbase58casekept1111111111111111"), null, "...and is never case-folded");

  quiet(); const listed = await buy("listed.example"); loud();
  ok(listed.e?.statusCode === 403 && listed.e?.sanctioned === true, `a listed payTo is refused 403 (got ${listed.e?.statusCode})`);
  ok(/STORED FIXTURE ENTITY/.test(listed.e?.message || "") && /Nothing was signed/.test(listed.e?.message || ""), "the refusal names the entity and says nothing was signed");
  eq(signs, 0, "the listed payTo was never signed for");
  const clean = await buy("clean.example");
  ok(clean.r && !clean.e, `an unlisted payTo is paid at once from the stored list (got ${clean.e?.statusCode || "ok"})`);
  eq(signs, 1, "...signing exactly once");
  eq(sdnFetches, 0, "no download was attempted (the stub fetch that throws for the list was never reached)");

  // Only a newer stored copy replaces the one held.
  writeFileSync(process.env.SANCTIONS_PAYOUT_FILE, JSON.stringify({ v: 1, fetchedAt: fetchedAt - 1000, addresses: [{ address: CLEAN, asset: "ETH", entity: "OLDER", sdnId: "1" }] }));
  eq(await K.loadStoredPayoutList(), false, "an older stored copy is not adopted");
  eq(await K.screenAddressForPayment(CLEAN), null, "...the held list still answers");
  writeFileSync(process.env.SANCTIONS_PAYOUT_FILE, JSON.stringify({ v: 1, fetchedAt: fetchedAt + 1000, addresses: [
    { address: LISTED, asset: "ETH", entity: "STORED FIXTURE ENTITY", sdnId: "920001" },
    { address: CLEAN, asset: "ETH", entity: "NEWER", sdnId: "2" },
  ] }));
  eq(await K.loadStoredPayoutList(), true, "a newer stored copy (another container's download) is adopted");
  eq((await K.screenAddressForPayment(CLEAN))?.sdnId, "2", "...and screens at once");
  writeFileSync(process.env.SANCTIONS_PAYOUT_FILE, JSON.stringify({ v: 1, fetchedAt: fetchedAt + 2000, addresses: [] }));
  eq(await K.loadStoredPayoutList(), false, "an empty stored copy is never adopted");
}

// --- 3. a stale list still screens ------------------------------------------
{
  K.__resetSanctionsForTests();
  K.__seedPayoutListForTests([{ address: LISTED, asset: "ETH", entity: "STALE FIXTURE", sdnId: "930001" }], { fetchedAt: Date.now() - 30 * 24 * 3600_000 });
  eq((await K.screenAddressForPayment(LISTED))?.sdnId, "930001", "a list a month old still refuses a listed address");
  eq(await K.screenAddressForPayment(CLEAN), null, "...and answers null for an unlisted one");
  quiet(); const { e } = await buy("listed.example"); loud();
  ok(e?.statusCode === 403 && e?.sanctioned === true, "a stale list refuses a listed payTo 403, never 503");
}

// --- 4. a download replaces the stored copy, under the shrink guard --------
// The long fixture entry carries 60 Digital Currency Addresses, the shape the
// CSV export cut short; the router must refuse every one of them, including
// the base58 ones listed under a ticker outside CASE_SENSITIVE.
{
  K.__resetSanctionsForTests();
  const LONG = readFileSync(new URL("./fixtures/ofac-sdn-long-entry.xml", import.meta.url), "utf8");
  await K.loadSanctions({ force: true, fetchImpl: async () => new Response(LONG, { status: 200 }) });
  const big = parseSdnXml(LONG).entries.find((e) => e.uid === "910001");
  const missed = [];
  for (const a of big.addresses) if ((await K.screenAddressForPayment(a.address))?.sdnId !== "910001") missed.push(a.address);
  eq(missed, [], `every one of the ${big.addresses.length} addresses on one long entry is refused`);
  for (const w of ["0x902dCf34E53695bDEA2fFB354b1a2e58bD598256", "0xaF13AA07E7360cC56B3dAbf649fFeF087c0cD5A6", "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0"])
    eq(await K.screenAddressForPayment(w), null, `an unlisted address answers null (${w.slice(0, 6)})`);
  ok(K.sanctionsStatus().payoutScreen.source === "fetch", "the download replaced the payout map");
  await new Promise((r) => setTimeout(r, 50));
  const stored = existsSync(process.env.SANCTIONS_PAYOUT_FILE) ? JSON.parse(readFileSync(process.env.SANCTIONS_PAYOUT_FILE, "utf8")) : null;
  const body = stored?.body ?? stored;
  ok(body && Array.isArray(body.addresses) && body.addresses.length === K.sanctionsStatus().payoutScreen.addresses && Number.isFinite(body.fetchedAt),
    "the downloaded address map is stored with its fetchedAt");
  ok(body && body.addresses.every((r) => r.address && r.asset && r.sdnId && typeof r.entity === "string") && !("names" in body), "only the address map is stored (entity, sdnId, asset per address), never the names");

  // A process that read that store screens the same addresses without a download.
  K.__resetSanctionsForTests();
  eq(await K.loadStoredPayoutList(), true, "a fresh process adopts the stored download");
  eq((await K.screenAddressForPayment(big.addresses[0].address))?.sdnId, "910001", "...and refuses from it");

  // A download that drops past half of the held map is refused; the map stays.
  const held = K.sanctionsStatus().payoutScreen.addresses;
  const SAMPLE = readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
  const sampleAddrs = new Set(parseSdnXml(SAMPLE).entries.flatMap((e) => e.addresses.map((a) => a.address))).size;
  if (sampleAddrs * 2 < held) {
    let refused = false;
    __resetSdnListForTests(); // a fresh fetch, not the parse held from the download above
    quiet();
    try { await K.loadSanctions({ force: true, fetchImpl: async () => new Response(SAMPLE, { status: 200 }) }); } catch { refused = true; }
    loud();
    ok(refused || K.sanctionsStatus().lastError, "a download past half below the stored map is refused");
    eq(K.sanctionsStatus().payoutScreen.addresses, held, "...and the stored map stays");
  } else ok(false, `fixture sizes do not exercise the shrink guard (${sampleAddrs} vs ${held})`);
}

console.log(`test-router-sanctions: ${n} assertions OK`);
process.exit(0);
