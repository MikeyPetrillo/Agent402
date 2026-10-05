// Base registration sweep: buy each named route once on Base so it appears as a
// resource in the CDP Bazaar catalog.
//
// WHY. A resource enters the Bazaar on its FIRST SETTLEMENT through Coinbase's
// facilitator, not by being advertised. Measured 2026-09-11: 547 of our 586
// paid routes are listed, and the 39 absent ones are exactly the set nothing
// has ever bought - the pro and premium model tiers, every report product,
// video, the X tools and whatever shipped that week. Cheap tools sell, so they
// list; expensive ones do not, so they are invisible to any agent shopping the
// Bazaar. This buys each one once to mint the record.
//
// The Algorand twin of this is scripts/challenge-sweep.js, which did the same
// job for the GoPlausible catalog. Same doctrine, different rail and registry.
//
// SAFETY / CONTROL
//   - Pays ONLY on Base, ONLY the accepts the live 402 quotes, ONLY to the
//     routes named in ROUTES below. It never walks the catalog.
//   - Self-buys: burner -> our own payTo, so the USDC recycles. The true cost
//     is the upstream spend each tool triggers (reports dominate it).
//   - Idempotent: skips anything already in the Bazaar, so a re-run after a
//     partial sweep buys only what is still missing.
//   - Hard total cap (SWEEP_MAX_USD) and per-tool cap (SWEEP_TOOL_MAX_USD);
//     aborts cleanly BEFORE a buy that would breach the total.
//   - SWEEP_DRY=1 quotes everything and signs nothing.
//   - Marks every request internal with the heartbeat token, so these buys do
//     not read as outside demand in the sales ledger or PostHog.
//
// Usage (CI, BURNER_KEY in env):
//   node scripts/base-list-sweep.js [--out report.json] [--max-usd 25] [--limit N]
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const BASE_CAIP2 = "eip155:8453";

// The routes missing from the Bazaar as measured 2026-09-11. Deliberately a
// LIST, not a catalog walk: this spends real upstream money, so the set that
// gets bought is reviewable in the diff.
//
// NOT HERE, on purpose: /api/route/execute-pro and /api/route/execute-max.
// Every other route on this list spends against our own API accounts, so the
// USDC recycles and only the upstream bill is real. Those two exist to PAY AN
// OUTSIDE SELLER, so buying them from ourselves sends money to a stranger and
// books against the Base wallet's daily ceiling. They can list on their own
// the first time a real buyer uses them.
// Methods here are a HINT for the bare probe only. The verb and the body that
// get PAID are taken from the challenge's own documented example, because the
// first run of this sweep hardcoded GET for three X tools and POST for
// research-company and lost all four to a 400: the paywall answers a 402 on
// either verb (the method-alias middleware runs the POST gate for a GET on a
// POST-only path), so a wrong verb here does not fail until after payment is
// signed. The challenge is the authority on how a route is called.
const ROUTES = [
  "POST /v1/research", "POST /v1/research/pro", "POST /v1/research/max",
  "POST /v1/research/market-brief", "POST /v1/dossier", "POST /v1/dossier/max",
  "POST /v1/fund", "POST /v1/fund/max", "POST /v1/domain-audit", "POST /v1/domain-audit/pro",
  "POST /v1/token-risk", "POST /v1/token-risk/pro", "POST /v1/token-brief",
  "POST /v1/ticker-pack", "POST /v1/filing-report", "POST /v1/insider-report",
  "POST /v1/recall-report", "POST /v1/linkedin-article",
  "POST /v1/pro/chat/completions", "POST /v1/pro/messages", "POST /v1/pro/responses",
  "POST /v1/premium/chat/completions", "POST /v1/premium/messages", "POST /v1/premium/responses",
  "POST /api/llm-pro", "POST /api/llm-premium",
  "POST /v1/videos/generations", "POST /api/image-gen-hd", "POST /api/image-gen-premium",
  "POST /api/tts-hd", "POST /api/tts-lite", "POST /api/transcribe-pro",
  "GET /api/x-search-recent", "GET /api/x-user-tweets", "GET /api/x-users-lookup",
  // Back on the list once its example stopped pointing at a placeholder host
  // that answers no 402 (2026-09-11). It now checks a $0.001 route on this
  // host, so the example is a healthy seller end to end.
  "POST /api/seller-payability",
  // 2026-10-04: the OpenAI transcription wire (multipart, see MULTIPART_AUDIO
  // below) and the memory writer, which read listed in one feed pass and not
  // the next.
  "POST /v1/audio/transcriptions", "POST /v1/pro/audio/transcriptions",
  "POST /api/memory/remember",
];

// Bought even when a feed read shows them listed: a row we saw in one pass and
// not the next is not proof the listing holds, and a payment is what makes it.
const ALWAYS_BUY = new Set(["/api/memory/remember"]);

// Routes on the OpenAI transcription wire take a multipart `file` part, and
// their published example is a placeholder that says so. They are paid with a
// short public-domain clip as that part (the clip /api/transcribe's own example
// uses); every other route keeps the challenge's JSON example.
const MULTIPART_AUDIO = { url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg", filename: "example.ogg", type: "audio/ogg" };
let audioClip = null;
async function multipartAudioBody(fields) {
  if (!audioClip) {
    const r = await fetch(MULTIPART_AUDIO.url, { headers: { "User-Agent": "agent402-base-list-sweep" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`audio clip fetch HTTP ${r.status}`);
    audioClip = new Uint8Array(await r.arrayBuffer());
  }
  const form = new FormData();
  form.append("file", new Blob([audioClip], { type: MULTIPART_AUDIO.type }), MULTIPART_AUDIO.filename);
  for (const [k, v] of Object.entries(fields || {})) if (k !== "file" && v != null && typeof v !== "object") form.append(k, String(v));
  return form;
}
const isMultipartExample = (body) => typeof body?.file === "string" && /multipart/i.test(body.file);

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out");
const MAX_USD = Number(arg("--max-usd", process.env.SWEEP_MAX_USD || "25"));
const TOOL_MAX_USD = Number(process.env.SWEEP_TOOL_MAX_USD || "3.5");
const LIMIT = Number(arg("--limit", process.env.SWEEP_LIMIT || "0")) || Infinity;
const DELAY_MS = Number(process.env.SWEEP_DELAY_MS || "2000");
// Report composites run 30 s to 4 min; the paywall settles AFTER the handler,
// so the client has to outlast the work or the buy is wasted.
const CALL_TIMEOUT_MS = Number(process.env.SWEEP_CALL_TIMEOUT_MS || "300000");
const DRY = process.env.SWEEP_DRY === "1" || args.includes("--dry");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Internal-traffic marker: the same unspoofable HMAC the heartbeat sends, so a
// self-buy is not counted as outside demand. Without it this sweep would print
// 37 fake customers into the ledger.
const POW = (process.env.POW_SECRET || "").trim();
if (!POW && !DRY) console.warn("WARN  POW_SECRET not set - these buys will record as EXTERNAL demand");
const stamp = (headers = {}) => {
  if (!POW) return headers;
  const minute = Math.floor(Date.now() / 60_000);
  return { ...headers, "X-Heartbeat-Token": createHmac("sha256", POW).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
};

let client, http;
{
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  client = disableVendorSpendControls(new x402Client());
  http = new x402HTTPClient(client);
  if (!DRY) {
    const pk = (process.env.BURNER_KEY || "").trim();
    if (!pk) die("BURNER_KEY not set (or use SWEEP_DRY=1 to preview)");
    const [{ privateKeyToAccount }, { registerExactEvmScheme }] = await Promise.all([
      import("viem/accounts"), import("@x402/evm/exact/client"),
    ]);
    registerExactEvmScheme(client, { signer: privateKeyToAccount(pk) });
  }
}

// Already-listed set. Paged by limit/offset - the Bazaar caps a page at 1000
// and holds 14k+ rows, and reading only the first page is how this whole
// investigation started with a wrong number (5 instead of 547).
const OUR_HOST = new URL(TARGET).host;
const listed = new Set();
try {
  for (let offset = 0; offset < 40000; offset += 1000) {
    const page = await (await fetch(`${BAZAAR}?limit=1000&offset=${offset}`, { signal: AbortSignal.timeout(30000) })).json();
    const items = page.items || page.resources || [];
    for (const r of items) {
      const u = String(r.resource || r.url || "");
      try { if (new URL(u).host === OUR_HOST) listed.add(new URL(u).pathname); } catch { /* not a url */ }
    }
    const total = page?.pagination?.total;
    if (items.length < 1000 || (total != null && offset + items.length >= total)) break;
  }
  console.log(`bazaar: ${listed.size} of our routes already listed`);
} catch (e) {
  die(`could not read the Bazaar catalog (${e.message}) - refusing to sweep blind, every route would look unlisted and be re-bought`);
}

console.log(`routes on the list: ${ROUTES.length} · dry=${DRY} · total cap $${MAX_USD} · per-tool cap $${TOOL_MAX_USD}`);

const report = { bought: [], skipped: [], failed: [], spentUsd: 0, startedAt: new Date().toISOString() };
let processed = 0;

for (const entry of ROUTES) {
  if (processed >= LIMIT) break;
  const [method, path] = entry.split(" ");
  if (listed.has(path) && !ALWAYS_BUY.has(path)) { report.skipped.push({ entry, reason: "already listed" }); continue; }

  let paymentRequired, example;
  try {
    const bare = await fetch(`${TARGET}${path}`, {
      method,
      headers: stamp({ "Content-Type": "application/json", Accept: "application/json" }),
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(45000),
    });
    if (bare.status !== 402) { report.failed.push({ entry, reason: `bare request HTTP ${bare.status}` }); continue; }
    const body = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), body);
    example = paymentRequired?.extensions?.bazaar?.info?.input || {};
  } catch (e) { report.failed.push({ entry, reason: `challenge: ${e.message}` }); continue; }

  const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === BASE_CAIP2);
  if (!accepts.length) { report.failed.push({ entry, reason: "no Base accept on the live 402" }); continue; }

  const usd = Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6;
  if (usd > TOOL_MAX_USD) { report.skipped.push({ entry, reason: `price $${usd} over the per-tool cap $${TOOL_MAX_USD}` }); continue; }
  if (report.spentUsd + usd > MAX_USD) die(`next buy ($${usd}) would breach the $${MAX_USD} cap (spent $${report.spentUsd.toFixed(4)}) - stopping cleanly`);

  if (DRY) { report.bought.push({ entry, usd, dry: true }); report.spentUsd += usd; processed++; continue; }

  let url = `${TARGET}${path}`;
  // The challenge names the verb this route is actually called with; fall back
  // to the list's hint only when it does not.
  const payMethod = (typeof example.method === "string" && /^(GET|POST)$/i.test(example.method)) ? example.method.toUpperCase() : method;
  const init = { method: payMethod, headers: stamp({ "Content-Type": "application/json", Accept: "application/json" }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
  if (payMethod === "POST" && isMultipartExample(example.body)) {
    try { init.body = await multipartAudioBody(example.body); } catch (e) { report.failed.push({ entry, reason: `multipart body: ${e.message}` }); continue; }
    delete init.headers["Content-Type"]; // fetch sets multipart/form-data with its boundary
  } else if (payMethod === "POST") init.body = JSON.stringify(example.body || {});
  else if (example.queryParams) {
    const qs = new URLSearchParams();
    for (const [k, val] of Object.entries(example.queryParams)) if (val != null && typeof val !== "object") qs.set(k, String(val));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  const t0 = Date.now();
  try {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const paid = await fetch(url, { ...init, headers: { ...init.headers, ...payHeaders } });
    const hdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    let tx = null;
    if (hdr) { try { tx = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).transaction; } catch { /* best effort */ } }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (paid.status !== 200) {
      // A >=400 cancels settlement, so nothing was charged and nothing listed.
      const b = await paid.text().catch(() => "");
      report.failed.push({ entry, reason: `HTTP ${paid.status} after ${secs}s: ${b.slice(0, 140)}` });
      console.warn(`FAIL ${entry}  HTTP ${paid.status} (${secs}s)`);
    } else {
      report.bought.push({ entry, usd, tx: tx || null, secs: Number(secs) });
      report.spentUsd += usd;
      console.log(`OK   ${entry}  $${usd}  ${secs}s${tx ? `  tx ${tx.slice(0, 12)}...` : "  (no receipt header)"}  [${report.bought.length}]`);
    }
  } catch (e) { report.failed.push({ entry, reason: `pay: ${String(e.message).slice(0, 140)}` }); console.warn(`FAIL ${entry}  ${String(e.message).slice(0, 90)}`); }

  processed++;
  await sleep(DELAY_MS);
}

report.finishedAt = new Date().toISOString();
console.log(`\n=== base list sweep done ===`);
console.log(`bought: ${report.bought.length} · skipped: ${report.skipped.length} · failed: ${report.failed.length}`);
console.log(`spent (recycles to our own payTo): $${report.spentUsd.toFixed(4)}`);
if (report.failed.length) console.log(`failures:\n  ${report.failed.map((f) => `${f.entry} (${f.reason})`).join("\n  ")}`);
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`wrote ${OUT}`); }
