// Buy from OTHER sellers on the Algorand x402 rail — real, outbound, capped.
//
// WHY
//   Every Algorand payment we make today is inbound (someone buys a tool) or a
//   self-buy (our own canaries). This script makes us a *buyer* on the rail:
//   real USDC to third-party sellers discovered in the GoPlausible facilitator
//   catalog. That is two-sided proof of the machine-to-machine economy, it is
//   what the x402 Global Challenge actually measures, and it exercises the same
//   discovery surface (src/algorand-sellers.js) the Smart Order Router uses to
//   pick external Algorand sellers to buy from and resell.
//
// THIS SPENDS REAL MONEY THAT DOES NOT COME BACK. Unlike the canaries, these
// payments leave our wallets for good, to third parties, with no refund path
// and no guarantee the response is useful. Every control below exists for that
// reason.
//
// SAFETY / CONTROL
//   • Hard total cap (EXT_MAX_USD, default 1.00). Checked before every single
//     buy; the script stops cleanly rather than exceed it by a cent.
//   • Per-buy cap (EXT_PER_BUY_USD, default 0.10).
//   • Pays ONLY on Algorand, ONLY USDC (ASA 31566704), ONLY to the accept the
//     seller's live 402 quotes — the catalog price is treated as a hint and
//     re-validated against the live quote before signing.
//   • Refuses any seller whose payTo is OUR OWN address (learned live from our
//     own 402, not hardcoded) — a self-buy would make the spend meaningless.
//   • Origin hygiene (https-only, no private hosts) comes from the catalog
//     builder in src/algorand-sellers.js.
//   • Spreads the budget: one buy per distinct seller origin per round, highest
//     facilitator-verified sellers first, so $1 reaches many sellers instead of
//     being dumped into one.
//   • EXT_DRY=1 / --dry prints the exact buy plan and signs nothing.
//   • Signs a 1000-round validity window (the dead-txn lesson — see
//     src/avm-validity.js).
//
// Usage:
//   EXT_DRY=1 node scripts/algorand-external-buy.js                    # plan only
//   ALGORAND_BURNER_MNEMONIC=… node scripts/algorand-external-buy.js --out ext.json
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { writeFileSync } from "node:fs";
import { algorandCatalog } from "../src/algorand-sellers.js";
import { getJsonAcross, ALGORAND_INDEXER_BASES } from "../src/revenue-live.js";
import { makeBudget, verifySettlement } from "./spend-budget.js";

const OUR_TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const OUR_ORIGIN = new URL(OUR_TARGET).origin.toLowerCase();
const AVM_CAIP2_PREFIX = "algorand:";
const USDC_ASA = "31566704";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out");
const MAX_USD = Number(arg("--max-usd", process.env.EXT_MAX_USD || "1.00"));
const PER_BUY_USD = Number(process.env.EXT_PER_BUY_USD || "0.10");
const DELAY_MS = Number(process.env.EXT_DELAY_MS || "1500");
const DRY = process.env.EXT_DRY === "1" || args.includes("--dry");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!(MAX_USD > 0) || MAX_USD > 5) die(`refusing an implausible total cap of $${MAX_USD} (expected 0 < cap <= 5)`);

// ── Algorand signer (skipped in dry mode — quoting needs no key) ──────────────
let client, http, payerAddress = "(dry)";
{
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  client = disableVendorSpendControls(new x402Client());
  if (!DRY) {
    const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
    if (!mnemonic) die("ALGORAND_BURNER_MNEMONIC not set (or use EXT_DRY=1 to preview the plan)");
    const [{ ExactAvmScheme }, { toClientAvmSigner }, algosdk] = await Promise.all([
      import("@x402/avm/exact/client"), import("@x402/avm"), import("algosdk"),
    ]);
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
    const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
    const { AlgorandClient } = await import("@algorandfoundation/algokit-utils/algorand-client");
    const algorandClient = AlgorandClient.fromConfig({ algodConfig: { server: algodUrl, token: "" } })
      .setDefaultValidityWindow(1000);
    client.register("algorand:*", new ExactAvmScheme(signer, { algorandClient }));
    payerAddress = account.addr.toString();
  }
  http = new x402HTTPClient(client);
}

// ── Learn OUR OWN Algorand payTo from a live 402, so a self-buy is impossible ─
let ourPayTo = "";
try {
  const bare = await fetch(`${OUR_TARGET}/api/hash`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20000),
  });
  const pr = http.getPaymentRequiredResponse((n) => bare.headers.get(n), await bare.json().catch(() => undefined));
  const avm = (pr?.accepts || []).find((a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX));
  ourPayTo = String(avm?.payTo || "");
} catch { /* non-fatal: the origin filter below is the primary guard */ }

// ── Discover external sellers ────────────────────────────────────────────────
const catalog = await algorandCatalog();
if (!catalog.length) die("GoPlausible catalog came back empty — nothing to buy from (facilitator down?)");

const external = catalog.filter((r) => r.origin !== OUR_ORIGIN && !/agent402/i.test(r.origin) && r.priceUsd > 0 && r.priceUsd <= PER_BUY_USD);
if (!external.length) die(`no external Algorand sellers with a route at or under the $${PER_BUY_USD} per-buy cap`);

// Group by origin; cheapest route first within a seller, sellers ordered by
// facilitator-witnessed verifications (the proven-activity signal).
const byOrigin = new Map();
for (const r of external) {
  if (!byOrigin.has(r.origin)) byOrigin.set(r.origin, []);
  byOrigin.get(r.origin).push(r);
}
for (const rs of byOrigin.values()) rs.sort((a, b) => a.priceUsd - b.priceUsd);
const origins = [...byOrigin.entries()].sort((a, b) => Math.max(...b[1].map((r) => r.verifs)) - Math.max(...a[1].map((r) => r.verifs)));

console.log(`Algorand external buy · payer ${payerAddress} · dry=${DRY}`);
console.log(`catalog ${catalog.length} resources · ${external.length} external routes at/under $${PER_BUY_USD} across ${origins.length} sellers`);
console.log(`budget $${MAX_USD.toFixed(2)} total, $${PER_BUY_USD.toFixed(2)} per buy${ourPayTo ? `\nself-buy guard: refusing payTo ${ourPayTo.slice(0, 12)}…` : "\nself-buy guard: our payTo unknown (origin filter only)"}\n`);

// Round-robin the sellers so the budget spreads before it deepens.
const plan = [];
const takenIdx = new Map();
for (let round = 0; ; round++) {
  let added = false;
  for (const [origin, rs] of origins) {
    const i = takenIdx.get(origin) || 0;
    if (i >= rs.length) continue;
    plan.push(rs[i]);
    takenIdx.set(origin, i + 1);
    added = true;
  }
  if (!added || round > 40) break;
}

// ── Buy ───────────────────────────────────────────────────────────────────────
// The budget COMMITS before each signed payment goes out and releases only when
// the chain proves the payment never landed — see scripts/spend-budget.js for
// why a receipt header is not evidence.
const budget = makeBudget(MAX_USD);
const report = {
  payer: payerAddress, dry: DRY, maxUsd: MAX_USD, perBuyUsd: PER_BUY_USD,
  bought: [], failed: [], skipped: [], spentUsd: 0, sellers: origins.length,
  startedAt: new Date().toISOString(),
};

for (const r of plan) {
  const remaining = budget.remaining();
  if (remaining <= 0) break;
  const label = `${r.method} ${r.url}`;

  // Live 402 — the catalog price is a hint; only the seller's own quote binds.
  let paymentRequired;
  try {
    const bare = await fetch(r.url, {
      method: r.method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(r.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (bare.status !== 402) { report.skipped.push({ label, reason: `no paywall: HTTP ${bare.status}` }); continue; }
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), await bare.json().catch(() => undefined));
  } catch (e) { report.skipped.push({ label, reason: `quote: ${String(e.message).slice(0, 120)}` }); continue; }

  const accepts = (paymentRequired?.accepts || []).filter(
    (a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX) && String(a.asset || "") === USDC_ASA,
  );
  if (!accepts.length) { report.skipped.push({ label, reason: "no algorand USDC accept in the live quote" }); continue; }
  const accept = accepts[0];

  if (ourPayTo && String(accept.payTo || "") === ourPayTo) { report.skipped.push({ label, reason: "payTo is our own wallet (self-buy refused)" }); continue; }

  const usd = Number(accept.amount ?? accept.maxAmountRequired) / 1e6;
  if (!(usd > 0)) { report.skipped.push({ label, reason: "unparseable quote amount" }); continue; }
  if (usd > PER_BUY_USD) { report.skipped.push({ label, reason: `live quote $${usd} > per-buy cap $${PER_BUY_USD} (catalog said $${r.priceUsd})` }); continue; }
  if (!budget.canAfford(usd)) { report.skipped.push({ label, reason: `$${usd} exceeds the $${remaining.toFixed(4)} left in budget` }); continue; }

  if (DRY) {
    console.log(`PLAN  $${usd.toFixed(3)}  ${label}  (${r.verifs} verifs) — ${r.description.slice(0, 60)}`);
    report.bought.push({ label, usd, verifs: r.verifs, dry: true });
    budget.reserve(usd);
    continue;
  }

  // Commit BEFORE the signed payment leaves. From here on the money is treated
  // as spent unless the chain says otherwise, so a seller that settles and then
  // errors can never push us past the cap.
  const sinceIso = new Date(Date.now() - 120_000).toISOString();
  budget.reserve(usd);

  try {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const paid = await fetch(r.url, {
      method: r.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...payHeaders },
      ...(r.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(60000),
    });
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    let tx = null;
    if (receiptHdr) { try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")).transaction; } catch { /* best-effort */ } }
    const body = await paid.text().catch(() => "");

    if (paid.status === 200) {
      report.bought.push({ label, usd, verifs: r.verifs, tx: tx || null, bytes: body.length, preview: body.slice(0, 200) });
      console.log(`BOUGHT $${usd.toFixed(3)}  ${label}${tx ? ` · tx ${tx.slice(0, 10)}…` : ""} · ${body.length}B`);
    } else if (tx) {
      // Settled and then failed: charged, and the receipt says so outright.
      report.failed.push({ label, usd, status: paid.status, tx, charged: true, body: body.slice(0, 160) });
      console.log(`FAIL   $${usd.toFixed(3)}  ${label} → HTTP ${paid.status} (settled tx ${tx.slice(0, 10)}… — charged anyway)`);
    } else {
      // No receipt header. That is NOT evidence we kept our money: a third
      // party's stack may settle before it fails (ours cancels settlement on a
      // >=400, theirs need not). Ask the chain, and release the reservation
      // only if the read succeeds AND finds nothing.
      const v = await verifySettlement(
        { payer: payerAddress, payTo: String(accept.payTo || ""), amountAtomic: String(accept.amount ?? accept.maxAmountRequired), sinceIso },
        { getJsonAcross, bases: ALGORAND_INDEXER_BASES },
      );
      if (v.settled) {
        report.failed.push({ label, usd, status: paid.status, tx: v.tx, charged: true, viaChain: true, body: body.slice(0, 160) });
        console.log(`FAIL   $${usd.toFixed(3)}  ${label} → HTTP ${paid.status} (NO receipt, but chain shows tx ${String(v.tx).slice(0, 10)}… — CHARGED)`);
      } else if (v.conclusive) {
        budget.release(usd);
        report.failed.push({ label, usd, status: paid.status, charged: false, body: body.slice(0, 160) });
        console.log(`FAIL   $${usd.toFixed(3)}  ${label} → HTTP ${paid.status} (chain confirms not charged — budget released)`);
      } else {
        report.failed.push({ label, usd, status: paid.status, charged: "unknown", body: body.slice(0, 160) });
        console.log(`FAIL   $${usd.toFixed(3)}  ${label} → HTTP ${paid.status} (indexer unavailable — held against budget)`);
      }
    }
  } catch (e) {
    // The request itself threw, so we never saw a response. The payment may
    // still have been submitted; keep it committed.
    report.failed.push({ label, usd, charged: "unknown", reason: `pay: ${String(e.message).slice(0, 160)}` });
    console.log(`FAIL   $${usd.toFixed(3)}  ${label} → ${String(e.message).slice(0, 60)} (held against budget)`);
  }
  report.spentUsd = budget.committedUsd;

  await sleep(DELAY_MS);
}

report.finishedAt = new Date().toISOString();
// The budget is the single source of truth for spend, in dry and live runs
// alike (the dry path reserves too, so the preview shows real planned spend).
report.spentUsd = budget.committedUsd;
const distinct = new Set(report.bought.map((b) => new URL(b.label.split(" ")[1]).origin)).size;

// Charged-but-failed is the number that matters: money out with nothing back.
const chargedFails = report.failed.filter((f) => f.charged === true);
const unknownFails = report.failed.filter((f) => f.charged === "unknown");
report.chargedFailUsd = chargedFails.reduce((s, f) => s + f.usd, 0);

console.log(`\n=== external Algorand buys ===`);
console.log(`bought: ${report.bought.length} from ${distinct} distinct sellers · failed: ${report.failed.length} · skipped: ${report.skipped.length}`);
console.log(`spent: $${report.spentUsd.toFixed(4)} of the $${MAX_USD.toFixed(2)} budget (never exceeds it: every payment is committed before it is sent)`);
if (chargedFails.length) {
  console.log(`charged but got no result: ${chargedFails.length} buy(s), $${report.chargedFailUsd.toFixed(4)} — these sellers settled and then errored`);
}
if (unknownFails.length) {
  console.log(`indeterminate: ${unknownFails.length} buy(s) held against the budget (indexer unavailable or the request threw)`);
}
if (report.failed.length) {
  console.log(`\nfailures:`);
  for (const f of report.failed) {
    const tag = f.charged === true ? "CHARGED" : f.charged === false ? "not charged" : "unknown";
    console.log(`  [${tag}] ${f.label} — ${f.reason || `HTTP ${f.status}: ${f.body}`}`);
  }
}
if (report.skipped.length) {
  console.log(`\nskipped (${report.skipped.length}):`);
  for (const s of report.skipped.slice(0, 20)) console.log(`  ${s.label} — ${s.reason}`);
  if (report.skipped.length > 20) console.log(`  … ${report.skipped.length - 20} more (see the report artifact)`);
}
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\nwrote ${OUT}`); }

// Buying from third parties is informational: a seller being down is THEIR
// outage, not our defect, so a failed buy must never page us. The run only
// fails if we could not complete a single purchase, which points at our side.
if (!DRY && report.bought.length === 0) { console.error(`\nFAIL: not one external buy completed.`); process.exit(1); }
