#!/usr/bin/env node
// Buy each tool that has NO Coinbase Bazaar row, once, from the CI burner, and
// ASSERT THE ANSWER - not just the HTTP status.
//
// WHY THIS EXISTS. A Bazaar row is minted by a SETTLED PAYMENT on the canonical
// URL, never by listing a tool, so a freshly shipped endpoint is invisible to
// every Bazaar-driven discovery surface until somebody actually buys it.
// Measured 2026-09-13: 584 of our 596 priced endpoints had rows and twelve did
// not, all of them recent work (token-safety, the five chain-* reads, feedback,
// receipts, both sanctions tools, both route-execute tiers).
//
// AND IT IS A CORRECTNESS CHECK, WHICH IS THE HALF THAT MATTERS MORE. The paid
// canaries prove settlement; they do not prove the tool answered correctly, and
// a hollow 200 passes every shape guard we own - that is exactly how
// demand-radar sold an empty radar for six weeks. So every leg here carries a
// `check` that reads the payload, and a leg that settles but answers wrongly
// FAILS the run.
//
// DEFAULT IS A DRY RUN. `--live` sends real money. Legs are opt-in by cost:
// the cheap set runs by default under --live, and the two route-execute tiers
// ($0.55 and $3.30, which also spend the SPENDING wallet at an outside seller)
// need --expensive on top, because minting a listing row is not worth $3.85 by
// accident.
//
// Usage:
//   node scripts/mint-bazaar-rows.js                  # dry run, prices only
//   node scripts/mint-bazaar-rows.js --live           # buys the cheap set
//   node scripts/mint-bazaar-rows.js --live --expensive
//   node scripts/mint-bazaar-rows.js --live --only token-safety,exa-search
//
// Env: BURNER_KEY (or KEY_FILE), POW_SECRET (marks the buys internal so they do
// not read as external demand in the ledger), TARGET_URL (default prod).

// Runs OUT OF TREE (copied to a temp dir by its workflow), so no import from src/:
// the vendor client default since @x402/core 2.23 is a $1 pegged-assets cap and
// this script bounds spend itself; the same line src/x402-spend-controls.js wraps.
import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const LIVE = process.argv.includes("--live");
const EXPENSIVE = process.argv.includes("--expensive");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i > -1 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(",").map((s) => s.trim())) : null;
})();

// A real, immutable Base mainnet address/token set so the assertions below are
// about OUR code, never about whether some third party still exists.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// The EXACT digest of the body the route-execute legs send. The first version
// of those checks asserted "a 64-char hex string", which any garbage would
// satisfy - the shape-not-outcome failure this whole script exists to catch,
// committed inside the script itself. A router that dispatched to the wrong
// tool, or returned a stale cached answer, would have passed.
const SHA256_BAZAAR = "131a0b6c32e4f927894683e6a932b0e11bd26a4e23e20cb59d744734418f95d2";

const LEGS = [
  // ---- the five chain reads --------------------------------------------
  { slug: "chain-nonce", priceUsd: 0.001, method: "GET",
    path: `/api/chain/nonce?address=${VITALIK}&network=base`,
    // The tool returns the nonce as a STRING alongside nonceHex, which is the
    // right call for a chain integer (no float precision cliff) - the first
    // draft of this check demanded a JS integer and failed a correct answer.
    // Assert the two agree, which is the property that would actually break.
    check: (r) => { const d = Number(r.nonce), h = Number(r.nonceHex); return (Number.isFinite(d) && d >= 0 && d === h) || `expected nonce and nonceHex to agree, got ${JSON.stringify(r).slice(0, 140)}`; } },

  { slug: "chain-total-supply", priceUsd: 0.001, method: "GET",
    path: `/api/chain/total-supply?address=${USDC_BASE}&network=base`,
    // Base USDC supply is in the billions; a zero here means the call resolved
    // but read nothing, which is the hollow-200 shape this script exists for.
    check: (r) => { const v = Number(r.totalSupply ?? r.supply ?? r.value); return (Number.isFinite(v) && v > 0) || `expected a positive total supply, got ${JSON.stringify(r).slice(0, 140)}`; } },

  { slug: "chain-storage", priceUsd: 0.001, method: "GET",
    path: `/api/chain/storage?address=${USDC_BASE}&slot=0&network=base`,
    check: (r) => (typeof (r.value ?? r.data) === "string" && /^0x[0-9a-f]{64}$/i.test(r.value ?? r.data)) || `expected a 32-byte hex word, got ${JSON.stringify(r).slice(0, 140)}` },

  { slug: "chain-pending", priceUsd: 0.001, method: "GET",
    // This reads the PENDING BLOCK - transaction count, base fee, gas - not a
    // per-address pending nonce, which is what the first draft of this check
    // wrongly assumed from the slug alone. Read the tool, not its name.
    path: `/api/chain/pending?network=base`,
    check: (r) => (Number.isFinite(Number(r.transactionCount)) && Number(r.number) > 0) || `expected a pending block with a tx count, got ${JSON.stringify(r).slice(0, 160)}` },

  { slug: "chain-erc1155-balance", priceUsd: 0.002, method: "GET",
    // An address that holds none reads 0 - that is a correct ANSWER, not a
    // failure, so the check asserts the shape and that it is a real number.
    path: `/api/chain/erc1155-balance?contract=0x76BE3b62873462d2142405439777e971754E8E77&address=${VITALIK}&id=1&network=ethereum`,
    check: (r) => { const v = r.balance ?? r.value; return (v !== undefined && v !== null && Number.isFinite(Number(v))) || `expected a numeric balance, got ${JSON.stringify(r).slice(0, 140)}`; } },

  // ---- sanctions -------------------------------------------------------
  { slug: "sanctions-wallet", priceUsd: 0.002, method: "GET",
    path: `/api/sanctions/wallet?address=${VITALIK}`,
    // A clean wallet must come back explicitly clean, never an empty object.
    // The verdict vocabulary is deliberate: never "clear" or "safe", always
    // "no_match_on_lists_checked", because a clearance is not ours to give.
    // Assert the word AND that lists were actually loaded - a verdict over an
    // empty list is the failure that reads exactly like a clean answer.
    check: (r) => (typeof r.verdict === "string" && r.verdict.length > 0 && Number(r.addressesOnList) > 0) || `expected a verdict over a loaded list, got ${JSON.stringify(r).slice(0, 160)}` },

  { slug: "sanctions-name", priceUsd: 0.005, method: "GET",
    path: `/api/sanctions/name?name=Vladimir%20Putin`,
    // A name that IS on the list must produce hits; zero here would mean the
    // list never loaded, which reads identically to "clean" without this.
    // A listed person written the ordinary way round MUST match. This exact
    // query returned zero on 2026-09-13 against a correctly loaded 19,388-entry
    // list, because OFAC stores "PUTIN, Vladimir Vladimirovich" and matching was
    // substring-only - a false negative on a sanctions screen, which is the one
    // direction it must not fail in. Fixed by all-token matching; this is the
    // regression check against the live list rather than a fixture.
    check: (r) => { const n = Array.isArray(r.matches) ? r.matches.length : 0; return (n > 0 && Number(r.entriesOnList) > 0) || `expected a listed name to match, got ${JSON.stringify(r).slice(0, 220)}`; } },

  // ---- token safety ----------------------------------------------------
  { slug: "token-safety", priceUsd: 0.005, method: "POST",
    path: "/api/token-safety", body: { address: USDC_BASE, chain: "base" },
    // USDC must not come back "unsafe", and the verdict must be a real word
    // from the table rather than an empty string.
    // `because` is a SENTENCE, not an array - the first draft demanded an array
    // and failed a good answer. What matters is that the verdict is real and
    // that "unknown" is a first-class list: USDC on Base answers "caution -
    // upgradeable proxy" with mintable/hidden-owner listed as UNKNOWN, which is
    // the honest shape. A tool that silently treated unknown as safe would pass
    // a laxer check than this one.
    check: (r) => (typeof r.verdict === "string" && r.verdict.length > 0 && typeof r.because === "string" && Array.isArray(r.unknown)) || `expected a verdict, a reason and an explicit unknown list, got ${JSON.stringify(r).slice(0, 220)}` },

  // ---- Exa (only present once EXA_KEY is live in prod) ------------------
  { slug: "exa-search", priceUsd: 0.012, method: "POST",
    path: "/api/exa-search", body: { query: "x402 payment protocol", numResults: 3 },
    check: (r) => (r.count > 0 && Array.isArray(r.results) && typeof r.results[0]?.url === "string") || `expected at least one result with a url, got ${JSON.stringify(r).slice(0, 200)}` },

  { slug: "exa-answer", priceUsd: 0.010, method: "POST",
    path: "/api/exa-answer", body: { query: "What is the x402 payment protocol?" },
    check: (r) => (typeof r.answer === "string" && r.answer.length > 40 && r.citationCount > 0) || `expected a written answer with citations, got ${JSON.stringify(r).slice(0, 200)}` },

  { slug: "exa-contents", priceUsd: 0.02, method: "POST",
    path: "/api/exa-contents", body: { urls: ["https://x402.org/"] },
    check: (r) => (r.count > 0 && typeof r.results?.[0]?.text === "string" && r.results[0].text.length > 50) || `expected page text, got ${JSON.stringify(r).slice(0, 200)}` },

  // ---- identity-bound: must run AFTER the buys above -------------------
  { slug: "receipts", priceUsd: 0.005, method: "POST", path: "/api/receipts", body: {}, after: true,
    // ZERO ROWS IS THE CORRECT ANSWER HERE AND THE CHECK SAYS SO. qPayerReceipts
    // filters `internal = 0`, and this burner is in OUR_EVM_WALLETS, so its own
    // buys are classified internal and are invisible to its own receipts - by
    // design, since receipts is a customer-facing payables export and our canary
    // traffic is not a payable. The consequence worth recording: NO internal buy
    // can ever validate this tool's happy path, so it has no self-test route and
    // the first real proof is an outside buyer. Assert the envelope instead.
    check: (r) => (typeof r.wallet === "string" && Array.isArray(r.rows) && Number.isFinite(Number(r.total)) && typeof r.note === "string") || `expected a well-formed receipts envelope, got ${JSON.stringify(r).slice(0, 200)}` },

  { slug: "feedback", priceUsd: 0.001, method: "POST", path: "/api/feedback", after: true,
    // Writable only by the wallet that paid for THAT exact call, so it is fed
    // the settlement tx of a leg this run just bought.
    body: (ctx) => ({ tx: ctx.lastSettledTx, verdict: "good" }),
    needsTx: true,
    check: (r) => (r.ok === true || typeof r.verdict === "string" || typeof r.tx === "string") || `expected the verdict to be recorded, got ${JSON.stringify(r).slice(0, 200)}` },

  // ---- expensive: opt in with --expensive ------------------------------
  { slug: "route-execute-max", priceUsd: 0.55, method: "POST", expensive: true,
    path: "/api/route/execute-max", body: { slug: "hash", params: { text: "bazaar", algo: "sha256" } },
    check: (r) => (r.result?.hex === SHA256_BAZAAR) || `expected sha256("bazaar") = ${SHA256_BAZAAR}, got ${JSON.stringify(r).slice(0, 200)}` },

  { slug: "route-execute-pro", priceUsd: 3.30, method: "POST", expensive: true,
    path: "/api/route/execute-pro", body: { slug: "hash", params: { text: "bazaar", algo: "sha256" } },
    check: (r) => (r.result?.hex === SHA256_BAZAAR) || `expected sha256("bazaar") = ${SHA256_BAZAAR}, got ${JSON.stringify(r).slice(0, 200)}` },
];

function selected() {
  let legs = LEGS.filter((l) => (l.expensive ? EXPENSIVE : true));
  if (ONLY) legs = legs.filter((l) => ONLY.has(l.slug));
  return legs.sort((a, b) => (a.after ? 1 : 0) - (b.after ? 1 : 0));
}

function budget(legs) {
  return legs.reduce((s, l) => s + l.priceUsd, 0);
}

async function main() {
  const legs = selected();
  const total = budget(legs);
  console.log(`target ${TARGET}`);
  console.log(`legs: ${legs.length}${EXPENSIVE ? " (including the expensive tiers)" : " (cheap set; add --expensive for the route-execute tiers)"}`);
  for (const l of legs) console.log(`  ${l.slug.padEnd(24)} $${l.priceUsd.toFixed(3)}  ${l.method} ${String(l.path).split("?")[0]}`);
  console.log(`\nBURNER MUST HOLD AT LEAST $${total.toFixed(3)} USDC on Base (plus a little ETH for nothing - buys are gasless EIP-3009).`);
  if (!LIVE) { console.log("\nDRY RUN. Re-run with --live to buy."); return; }

  const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) { console.error("no BURNER_KEY / KEY_FILE - cannot buy"); process.exit(2); }

  const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  client.setSpendControls?.(false);
  registerExactEvmScheme(client, { signer: account });

  // Mark the buys internal, or they read as external demand in our own ledger
  // and quietly inflate the number we publish about ourselves.
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) console.warn("WARN  POW_SECRET unset - these buys will record as EXTERNAL demand");
  // Build via `new Request` so the X-PAYMENT header survives the paid retry.
  const synthFetch = !secret ? fetch : (input, init) => {
    const minute = Math.floor(Date.now() / 60_000);
    const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
    const req = new Request(input, init);
    req.headers.set("X-Heartbeat-Token", token);
    return fetch(req);
  };
  const payFetch = wrapFetchWithPayment(synthFetch, client);

  const ctx = { lastSettledTx: null };
  let settled = 0, failed = 0, skipped = 0, spent = 0;

  for (const leg of legs) {
    if (leg.needsTx && !ctx.lastSettledTx) { console.log(`SKIP  ${leg.slug} - no settled tx yet to attach a verdict to`); skipped++; continue; }
    const url = `${TARGET}${leg.path}`;
    const body = typeof leg.body === "function" ? leg.body(ctx) : leg.body;
    const init = { method: leg.method, headers: { Accept: "application/json" } };
    if (body !== undefined && leg.method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try { res = await payFetch(url, init); }
    catch (e) { console.log(`FAIL  ${leg.slug} - request threw: ${e.message}`); failed++; continue; }

    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }

    if (res.status !== 200) {
      // A >= 400 cancels settlement, so nothing was charged for this.
      console.log(`FAIL  ${leg.slug} - HTTP ${res.status} ${String(text).slice(0, 160)}`);
      failed++; continue;
    }
    const receipt = res.headers.get("payment-response") || res.headers.get("PAYMENT-RESPONSE");
    let tx = null;
    if (receipt) { try { tx = JSON.parse(Buffer.from(receipt, "base64").toString()).transaction || null; } catch {} }
    if (!tx) {
      // A 200 with no settle receipt means it was served FREE - no Bazaar row
      // is minted by that, which is the whole point of this run.
      console.log(`FAIL  ${leg.slug} - 200 but no settlement receipt: nothing was paid, so no Bazaar row`);
      failed++; continue;
    }

    const verdict = leg.check ? leg.check(json ?? {}) : true;
    if (verdict !== true) { console.log(`FAIL  ${leg.slug} - settled ${tx.slice(0, 12)}… but the ANSWER is wrong: ${verdict}`); failed++; continue; }

    ctx.lastSettledTx = tx;
    spent += leg.priceUsd; settled++;
    console.log(`OK    ${leg.slug.padEnd(24)} $${leg.priceUsd.toFixed(3)}  tx ${tx.slice(0, 14)}…`);
  }

  console.log(`\n${settled} settled and verified, ${failed} failed, ${skipped} skipped, ~$${spent.toFixed(3)} spent`);
  console.log("Bazaar rows are minted from settled payments and appear on their next discovery refresh, not instantly.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
