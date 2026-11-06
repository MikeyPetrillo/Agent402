// x402 Global Challenge registration sweep: buy each of our tools once on
// Algorand mainnet so every endpoint appears as a resource in the GoPlausible
// Bazaar catalog (a resource record is minted on first settlement there).
//
// These are self-buys, burner -> our own revenue payTo, so the USDC recycles;
// the only true cost is whatever upstream spend a tool triggers. It is the
// Foundation's own sanctioned onboarding step ("one real Mainnet payment against
// your endpoint end-to-end"), done once per endpoint for catalog registration.
//
// SAFETY / CONTROL
//   • Pays ONLY on Algorand, ONLY to accepts the live 402 quotes. No EVM.
//   • Idempotent + resumable: skips endpoints already in GoPlausible's catalog.
//   • Hard total-spend cap (SWEEP_MAX_USD, default 25) — aborts before a buy
//     that would exceed it. Per-tool price cap (SWEEP_TOOL_MAX_USD, default 2).
//   • SWEEP_DRY=1 reports what it WOULD buy and spend, signs nothing.
//   • Paced (SWEEP_DELAY_MS, default 1000) to be polite to prod + facilitator.
//   • Writes a JSON report (--out) of registered / skipped / failed.
//
// Usage (CI, ALGORAND_BURNER_MNEMONIC in env):
//   node scripts/challenge-sweep.js [--out report.json] [--max-usd 25] [--limit N]
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { writeFileSync } from "node:fs";
import { openapiReader, resolveReplayableInput } from "./lib/replayable-example.js";
import { assertOwnPaidTarget } from "./lib/buyer-guard.js";

const TARGET = assertOwnPaidTarget((process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, ""), "challenge-sweep");
const readOpenapi = openapiReader(TARGET);
const GP_RESOURCES = "https://facilitator.goplausible.xyz/discovery/resources";
const AVM_CAIP2_PREFIX = "algorand:";
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out");
const MAX_USD = Number(arg("--max-usd", process.env.SWEEP_MAX_USD || "25"));
const TOOL_MAX_USD = Number(process.env.SWEEP_TOOL_MAX_USD || "2");
const LIMIT = Number(arg("--limit", process.env.SWEEP_LIMIT || "0")) || Infinity;
const DELAY_MS = Number(process.env.SWEEP_DELAY_MS || "1000");
const DRY = process.env.SWEEP_DRY === "1" || args.includes("--dry");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Algorand signer (skipped in dry mode — quoting needs no key) ──────────────
let client, http, payerAddress;
if (!DRY) {
  const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
  if (!mnemonic) die("ALGORAND_BURNER_MNEMONIC not set (or use SWEEP_DRY=1 to preview)");
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const [{ ExactAvmScheme }, { toClientAvmSigner }, algosdk] = await Promise.all([
    import("@x402/avm/exact/client"), import("@x402/avm"), import("algosdk"),
  ]);
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  client = disableVendorSpendControls(new x402Client());
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
  const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
  // Sign with the protocol-max validity window (1000 rounds ≈ 47 min), not
  // algokit's 10-round (~28s) default: settlement happens AFTER the handler, so
  // a slow tool (image-gen-premium ~60s of gpt-image-2) outlives the default and
  // the facilitator rejects the dead txn ("txn dead", buyer refunded, our
  // upstream spend burned). Proven live: sweep run 29974531159.
  const { AlgorandClient } = await import("@algorandfoundation/algokit-utils/algorand-client");
  const algorandClient = AlgorandClient.fromConfig({ algodConfig: { server: algodUrl, token: "" } })
    .setDefaultValidityWindow(1000);
  client.register("algorand:*", new ExactAvmScheme(signer, { algorandClient }));
  http = new x402HTTPClient(client);
  payerAddress = account.addr.toString();
} else {
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  client = disableVendorSpendControls(new x402Client());
  http = new x402HTTPClient(client);
}

// ── Catalog + already-registered set ──────────────────────────────────────────
function walkTools(o) {
  const out = [];
  const rec = (x) => {
    if (Array.isArray(x)) x.forEach(rec);
    else if (x && typeof x === "object") {
      if (x.price && (x.path || x.route) && x.method) out.push(x);
      else Object.values(x).forEach(rec);
    }
  };
  rec(o);
  return out;
}

const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
let tools = walkTools(pricing).map((t) => ({
  method: String(t.method).toUpperCase(),
  path: t.path || (t.route || "").replace(/^[A-Z]+\s+/, ""),
  slug: t.slug,
  priceUsd: Number(String(t.price).replace("$", "")),
}));
// Dedup by METHOD path.
const seen = new Set();
tools = tools.filter((t) => { const k = `${t.method} ${t.path}`; if (seen.has(k)) return false; seen.add(k); return true; });

// GoPlausible registered resource IDs decode to "METHOD:url".
const OUR_HOST = new URL(TARGET).host;
let registered = new Set();
try {
  // Paginate the full catalog: a single limit=500 page silently dropped our
  // entries past #500 once the catalog outgrew it, so a re-run re-bought them.
  for (let offset = 0; offset < 20000; offset += 500) {
    const gp = await (await fetch(`${GP_RESOURCES}?limit=500&offset=${offset}`, { signal: AbortSignal.timeout(15000) })).json();
    const items = gp.items || gp.resources || [];
    for (const r of items) {
      const id = r.id || r.resource;
      if (typeof id !== "string") continue;
      let dec;
      try { dec = Buffer.from(id, "base64").toString("utf8"); } catch { continue; }
      const m = dec.match(/^([A-Z]+):(https?:\/\/\S+)$/);
      // Host-scope the skip-set to OUR endpoints — another seller's /api/hash
      // must never mark ours as already-registered.
      if (m && new URL(m[2]).host === OUR_HOST) registered.add(`${m[1]} ${new URL(m[2]).pathname}`);
    }
    if (items.length < 500) break;
  }
} catch (e) { console.warn(`[sweep] could not read GoPlausible catalog (${e.message}) — proceeding without skip-set`); }

console.log(`catalog: ${tools.length} tools · already registered on GoPlausible: ${registered.size} · dry=${DRY} · cap $${MAX_USD}`);

// ── Sweep ─────────────────────────────────────────────────────────────────────
const report = { registered: [], skipped: [], failed: [], noAlgorand: [], spentUsd: 0, startedAt: new Date().toISOString() };
let processed = 0;

for (const t of tools) {
  if (processed >= LIMIT) break;
  const key = `${t.method} ${t.path}`;
  if (registered.has(key)) { report.skipped.push({ key, reason: "already-registered" }); continue; }
  if (t.priceUsd > TOOL_MAX_USD) { report.skipped.push({ key, reason: `price $${t.priceUsd} > tool cap $${TOOL_MAX_USD}` }); continue; }

  // Bare request -> 402 (paywall precedes handler, so any body yields the
  // challenge, which carries BOTH the example input and the live accepts).
  let paymentRequired, exampleInput;
  try {
    const bare = await fetch(`${TARGET}${t.path}`, {
      method: t.method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(t.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (bare.status !== 402) { report.failed.push({ key, reason: `bare request HTTP ${bare.status}` }); continue; }
    const bareBody = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
    exampleInput = await resolveReplayableInput(paymentRequired?.extensions?.bazaar?.info?.input || {}, { method: t.method, path: t.path, readOpenapi });
    if (!exampleInput) { report.failed.push({ key, reason: "shortened 402 example with no full example on /openapi.json" }); continue; }
  } catch (e) { report.failed.push({ key, reason: `challenge: ${e.message}` }); continue; }

  const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX));
  if (!accepts.length) { report.noAlgorand.push(key); continue; } // identity-bound (memory) tools have no AVM accept

  const usd = Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6;
  if (report.spentUsd + usd > MAX_USD) die(`next buy ($${usd}) would exceed the $${MAX_USD} cap (spent $${report.spentUsd.toFixed(4)}) — stopping cleanly`);

  if (DRY) { report.registered.push({ key, usd, dry: true }); report.spentUsd += usd; processed++; continue; }

  // Build the paid request from the example the challenge gave us.
  const reqInit = {
    method: t.method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  };
  let url = `${TARGET}${t.path}`;
  if (t.method === "POST") reqInit.body = JSON.stringify(exampleInput.body || {});
  else if (exampleInput.queryParams) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(exampleInput.queryParams)) if (v != null && typeof v !== "object") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  try {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const paid = await fetch(url, { ...reqInit, headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" } });
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    let tx = null;
    if (receiptHdr) { try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")).transaction; } catch { /* best-effort */ } }
    if (paid.status !== 200) {
      // A 4xx/5xx cancels settlement — not charged. Report for a retry pass.
      const b = await paid.text().catch(() => "");
      report.failed.push({ key, reason: `settle HTTP ${paid.status}: ${b.slice(0, 120)}` });
    } else {
      report.registered.push({ key, usd, tx: tx || null });
      report.spentUsd += usd;
      console.log(`OK  ${key}  $${usd}${tx ? ` · tx ${tx.slice(0, 12)}…` : ""}  [${report.registered.length}]`);
    }
  } catch (e) { report.failed.push({ key, reason: `pay: ${String(e.message).slice(0, 120)}` }); }

  processed++;
  await sleep(DELAY_MS);
}

report.finishedAt = new Date().toISOString();
console.log(`\n=== sweep done ===`);
console.log(`registered: ${report.registered.length} · skipped: ${report.skipped.length} · noAlgorand: ${report.noAlgorand.length} · failed: ${report.failed.length}`);
console.log(`spent (self-recycled): $${report.spentUsd.toFixed(4)}`);
if (report.failed.length) console.log(`failures (retry later):`, report.failed.slice(0, 10).map((f) => `${f.key} (${f.reason})`).join("\n  "));
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`wrote ${OUT}`); }
