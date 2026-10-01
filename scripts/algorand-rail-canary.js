// Algorand rail canary — buy EVERY tool in the catalog paying USDC on Algorand
// mainnet, and prove each one settles AND renders its payload.
//
// WHY THIS EXISTS (and how it differs from the two scripts next to it)
//   • scripts/paid-canary.js has ONE Algorand leg (/api/hash). It proves
//     the rail is alive; it cannot prove the rail works for the whole catalog.
//   • scripts/challenge-sweep.js buys every tool on Algorand but SKIPS anything
//     already in GoPlausible's catalog — it is a one-shot registration tool, so
//     on a second run it buys almost nothing and verifies almost nothing.
//   This canary is the recurring health check: no skip-set, every tool bought
//   every run, and each buy asserted end-to-end (402 → sign → settle → 200 →
//   non-empty payload). A tool that quietly stops offering the AVM accept, or
//   settles but 500s, shows up here and nowhere else.
//
// The tool handler is chain-agnostic (it never learns which rail settled), so
// what each row proves is the settlement→unlock→payload path for that tool on
// Algorand specifically.
//
// COST
//   Self-buys: burner -> our own revenue payTo, so the USDC recycles. The
//   burner still needs the full in-flight float before it comes back.
//
// SAFETY / CONTROL
//   • Pays ONLY on Algorand, ONLY to the accept the live 402 quotes. No EVM.
//   • Hard total-spend cap (CANARY_MAX_USD, default 15) — stops cleanly before
//     a buy that would exceed it. Per-tool cap (CANARY_TOOL_MAX_USD, default
//     0.25) skips the expensive skill packs by default.
//   • CANARY_DRY=1 / --dry reports what it WOULD buy, signs nothing.
//   • Carries the POW_SECRET-signed X-Heartbeat-Token when available, which
//     marks the traffic synthetic in our own analytics WITHOUT bypassing the
//     paywall (src/server.js isSyntheticRequest) — the payments are real, they
//     just don't masquerade as external demand.
//   • Signs a 1000-round validity window, never algokit's 10-round default:
//     settlement happens AFTER the handler, so a slow tool outlives the default
//     window and the facilitator rejects a dead txn (buyer refunded, our
//     upstream spend burned). See src/avm-validity.js for the server-side guard.
//
// EXIT CODE
//   0 when every attempted tool settled and returned a payload. 1 on any rail
//   failure (paid and still got a 402 — settlement rejected) or tool failure
//   (settled but the handler errored). Both are real defects, so neither is
//   tolerated by a threshold.
//
// Usage:
//   CANARY_DRY=1 node scripts/algorand-rail-canary.js                 # preview, no keys, no spend
//   ALGORAND_BURNER_MNEMONIC=… node scripts/algorand-rail-canary.js --out report.json
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
// The single source of truth for which routes legitimately advertise EVM rails
// only (security audit A402-03). Importing it means this canary can never drift
// from the server's own definition of an identity-bound route.
import { isIdentityBoundRoute } from "../src/payments.js";
import { isLongRunningSlug } from "../src/composite-spend-guard.js";
import { railsReportSubcentPause } from "../src/avm-sponsorship.js";

import { FAST_REJECT_MS, isThrottle, isUpstreamOutage, isOurSettleBreaker, outcomeOf, subcentBudget, rotateSubcent } from "./avm-canary-classify.js";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const AVM_CAIP2_PREFIX = "algorand:";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out");
const MAX_USD = Number(arg("--max-usd", process.env.CANARY_MAX_USD || "15"));
const TOOL_MAX_USD = Number(process.env.CANARY_TOOL_MAX_USD || "0.25");
const LIMIT = Number(arg("--limit", process.env.CANARY_LIMIT || "0")) || Infinity;
// 250ms was too aggressive for the Algorand facilitator specifically: run
// 32006536872 (2026-08-17) settled 415 real Algorand purchases cleanly, then
// every subsequent call failed instantly (55-85ms, far too fast to have ever
// reached the chain - genuine settlements in the same run took 5s+) until the
// run ended, with one lone success mixed back in. That shape - fast local
// rejection after a volume threshold, not a structural defect (identical
// accept payloads either side of the cutoff) - is the facilitator throttling
// this wallet, not the rail breaking. Slower default pacing to stay further
// under whatever threshold it enforces; see isFastReject below for the
// classification half of this fix.
const DELAY_MS = Number(process.env.CANARY_DELAY_MS || "1000");
// A sweep that buys ~500 tools at 250ms is not representative load: it hits
// every OpenAI-backed tool back to back, and the upstream throttles. The
// 2026-08-03 run booked 7 of those as "tool failures" - tts, tts-hd,
// transcribe, transcribe-pro, embed, embed-large, moderate - when the rail was
// perfect (0 rail failures, 486 settled) and the handlers were fine.
//
// An alarm that reports our own burst as a product defect is worse than no
// alarm, because the next real defect arrives in a file people have learned to
// skim. So a throttle gets ONE retry after a real pause, and only a throttle
// that survives that is reported - as its own class, not as a broken tool.
const THROTTLE_BACKOFF_MS = Number(process.env.CANARY_THROTTLE_BACKOFF_MS || "8000");
// OUR OWN settle-failure breaker opens for GATEWAY_SETTLE_BREAKER_WINDOW_MS,
// which is 15 minutes. An 8-second backoff cannot clear it, so before this the
// sweep answered a 15-minute refusal with an 8-second pause, failed, and did it
// again for every remaining tool. Honour the Retry-After the refusal carries,
// bounded, and only then give up on that tool.
const BREAKER_MAX_WAIT_MS = Number(process.env.CANARY_BREAKER_MAX_WAIT_MS || "120000");
// ...and stop entirely once it is clear nothing more can be measured. On
// 2026-09-21 an upstream facilitator failed 14 minutes in, after 145 clean
// settlements, and the sweep spent a further 71 minutes of attempts
// on tools it could not observe, reporting 346 of them as somebody else's
// throttle. Consecutive is the right trigger rather than a total: an isolated
// failure among successes is exactly what this alarm exists to catch, while an
// unbroken run of them means the rail or the breaker is the only thing being
// measured.
const ABORT_AFTER_CONSECUTIVE = Number(process.env.CANARY_ABORT_AFTER_CONSECUTIVE || "12");
// A genuine settlement rejection means the facilitator actually attempted (and
// failed) an on-chain broadcast - real Algorand round trips through this
// script measured 5s+. A 402 that comes back in under this window never
// reached the chain, which is the AVM-specific shape of the same throttle
// class isThrottle() catches for 429/503 (see DELAY_MS above for the incident
// this was found from). Threshold sits well above the ~85ms observed fast
// rejections and well below genuine ~5s settlements, so it can't misclassify
// a real slow rejection as a throttle.

const ONLY = String(arg("--slugs", process.env.CANARY_SLUGS || "")).split(",").map((s) => s.trim()).filter(Boolean);
const DRY = process.env.CANARY_DRY === "1" || args.includes("--dry");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marks our own traffic synthetic in analytics. Does NOT bypass payment.
const secret = (process.env.POW_SECRET || "").trim();
const heartbeatHeaders = () =>
  secret
    ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) }
    : {};

// ── Algorand signer (skipped in dry mode — quoting needs no key) ──────────────
let client, http, payerAddress = "(dry)";
if (!DRY) {
  const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
  if (!mnemonic) die("ALGORAND_BURNER_MNEMONIC not set (or use CANARY_DRY=1 to preview)");
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const [{ ExactAvmScheme }, { toClientAvmSigner }, algosdk] = await Promise.all([
    import("@x402/avm/exact/client"), import("@x402/avm"), import("algosdk"),
  ]);
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
  const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
  const { AlgorandClient } = await import("@algorandfoundation/algokit-utils/algorand-client");
  const algorandClient = AlgorandClient.fromConfig({ algodConfig: { server: algodUrl, token: "" } })
    .setDefaultValidityWindow(1000);
  client = disableVendorSpendControls(new x402Client());
  client.register("algorand:*", new ExactAvmScheme(signer, { algorandClient }));
  http = new x402HTTPClient(client);
  payerAddress = account.addr.toString();
} else {
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  client = disableVendorSpendControls(new x402Client());
  http = new x402HTTPClient(client);
}

// ── Catalog ───────────────────────────────────────────────────────────────────
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
  category: t.category,
  priceUsd: Number(String(t.price).replace("$", "")),
}));
const seen = new Set();
tools = tools.filter((t) => { const k = `${t.method} ${t.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
if (ONLY.length) tools = tools.filter((t) => ONLY.includes(t.slug));

// SUB-CENT BUDGET. The facilitator's sponsored sub-cent settlements are
// capped per payTo; see subcentBudget/rotateSubcent in avm-canary-classify.js.
// Read the live quota, keep a reserve for real buyers, cap this run, and rotate which
// sub-cent tools get it so the catalog is still covered over a month. Tools at
// or above $0.01 are unlimited and never budgeted. An explicit --slugs run
// (re-verifying a fix) is exempt: it is a handful of tools by definition.
// 50 a run and a 500 reserve (2026-10-01, were 150 and 300): September's
// 1,015 sponsored sub-cent settlements were 1,006 of ours, two uncapped sweeps
// alone 841. At 50 a week our testing spends about 230 of the monthly 1,000,
// the daily paid canary proves the rail itself, and every tool is also swept
// on Base, so the rotation through sub-cent tools only takes longer.
const SUBCENT_MAX = Math.max(0, Number(process.env.CANARY_SUBCENT_MAX ?? "50"));
const SUBCENT_RESERVE = Math.max(0, Number(process.env.CANARY_SUBCENT_RESERVE ?? "500"));
const FACILITATOR_URL = (process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz").replace(/\/$/, "");
// While the allowance is spent the SERVER withdraws Algorand from sub-cent
// 402s (src/avm-sponsorship.js) and says so on /api/rails. A sub-cent tool
// with no Algorand accept is then the server behaving as designed, not a rail
// that silently stopped being offered - so the sweep asks, and remembers a yes
// for the rest of the run.
let subcentWithdrawnSeen = false;
async function subcentWithdrawnNow() {
  if (subcentWithdrawnSeen) return true;
  try {
    const rails = await (await fetch(`${TARGET}/api/rails`, { signal: AbortSignal.timeout(15000) })).json();
    subcentWithdrawnSeen = railsReportSubcentPause(rails);
  } catch { /* unreadable: nothing is excused */ }
  return subcentWithdrawnSeen;
}
let subcentPlan = { budget: Infinity, source: "slugs-run", remaining: null };
if (!ONLY.length) {
  let status = null, payTo = null;
  try {
    // The payTo is read from a ONE-CENT route: a sub-cent 402 carries no
    // Algorand accept at all while the allowance is spent.
    const r = await fetch(`${TARGET}/api/solidity-scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
    const pr = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
    payTo = (pr.accepts || []).find((a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX))?.payTo || null;
    if (payTo) {
      const st = await (await fetch(`${FACILITATOR_URL}/sponsorship/status?wallet=${payTo}`, { signal: AbortSignal.timeout(15000) })).json();
      status = (st.chains || []).find((c) => c.chain === "algorand") || null;
    }
  } catch (e) { console.warn(`sub-cent quota read failed (${String(e.message).slice(0, 80)}) - applying the fixed cap alone`); }
  subcentPlan = (await subcentWithdrawnNow())
    ? { budget: 0, source: "withdrawn by the server", remaining: 0 }
    : subcentBudget({ status, max: SUBCENT_MAX, reserve: SUBCENT_RESERVE });
  const week = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
  tools = rotateSubcent(tools, { week, cap: subcentPlan.budget });
  const subTotal = tools.filter((t) => t.priceUsd < 0.01).length;
  console.log(`sub-cent budget: ${subcentPlan.budget} of ${subTotal} sub-cent tools this run (${subcentPlan.source}${status ? `; month ${status.usedMonth}/${status.quota} used, SU ${status.suBalance}, reserve ${SUBCENT_RESERVE} kept for buyers` : ""}; window rotates weekly)`);
}

console.log(`Algorand rail canary · target ${TARGET} · payer ${payerAddress}`);
console.log(`catalog: ${tools.length} routes · dry=${DRY} · total cap $${MAX_USD} · per-tool cap $${TOOL_MAX_USD}\n`);

// ── Sweep ─────────────────────────────────────────────────────────────────────
// ok          settled on Algorand and returned a non-empty payload
// railFail    we paid and still got a 402 AFTER a genuine (slow) settlement
//             attempt — settlement was actually refused (RAIL DEFECT)
// rateLimited a 402 that came back too fast to have reached the chain, and
//             survived one backoff-and-retry — the facilitator throttling
//             this wallet, not a rail defect (see FAST_REJECT_MS above)
// toolFail    settled but the handler errored, or returned an empty body
// noAvm       the live 402 offers no algorand:* accept for this tool
// skipped     over the per-tool price cap, or the total cap was reached
const report = {
  target: TARGET, payer: payerAddress, dry: DRY,
  ok: [], railFail: [], rateLimited: [], toolFail: [], throttled: [], upstreamFail: [], noAvm: [], skipped: [],
  // Refused by OUR OWN breaker before the handler ran: nothing was measured
  // about these tools, so they are neither a pass nor a failure.
  blocked: [], aborted: null,
  spentUsd: 0, startedAt: new Date().toISOString(),
};
let processed = 0;
let capped = false;
// Runs of outcomes that observed nothing about the tool under test.
let consecutiveBlind = 0;

for (const t of tools) {
  if (processed >= LIMIT) break;
  const key = `${t.method} ${t.path}`;
  if (t.priceUsd > TOOL_MAX_USD) { report.skipped.push({ key, slug: t.slug, reason: `price $${t.priceUsd} > per-tool cap $${TOOL_MAX_USD}` }); continue; }
  // Outside this week's sub-cent window: recorded, never bought, never a
  // failure. It is measured next time its window comes round.
  if (t.subcentSkip) { report.skipped.push({ key, slug: t.slug, reason: "sub-cent tool outside this week's budget window (facilitator's free sponsored quota reserved for buyers)" }); continue; }

  // A bare request yields the 402 challenge, which carries BOTH the live
  // accepts and the tool's own canonical example input (the paywall precedes
  // the handler, so no valid input is needed to get it).
  let paymentRequired, exampleInput;
  try {
    const bareFetch = () => fetch(`${TARGET}${t.path}`, {
      method: t.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...heartbeatHeaders() },
      ...(t.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(30000),
    });
    let bare = await bareFetch();
    // Single-retry doctrine (same as the heartbeat prober): a bare request that
    // lands inside a deploy's container switch answers 502 from the edge for
    // ~1-2 minutes. Measured 2026-08-19 run 32288638827: 16 "tool failures"
    // between 19:19:32 and 19:21:28, the deploy job ending at 19:21:19 - every
    // one a 502 on the bare request, none a tool defect. One re-probe after
    // 20s: a real outage fails both and records exactly as before.
    if (bare.status !== 402) {
      await bare.arrayBuffer().catch(() => {});
      await new Promise((r) => setTimeout(r, 20_000));
      bare = await bareFetch();
    }
    if (bare.status !== 402) {
      // A bare (UNPAID) probe that still is not a 402 after the retry: a 502/
      // 503/504 here is the edge/infra IN FRONT of the tool (the handler only
      // ever answers 402 when unpaid), never a handler defect - same
      // third-party/edge class as a paid upstream outage, so it is reported but
      // does NOT fail the run (the paid path already does this; the bare path
      // missed it, which opened #842 on a transient edge 502 for nft-holdings
      // while it was 402ing fine seconds later). Any OTHER status (400/404/500
      // with a body) is a real problem and still fails.
      const bucket = isUpstreamOutage(bare.status, "") ? report.upstreamFail : report.toolFail;
      bucket.push({ key, slug: t.slug, reason: `bare request HTTP ${bare.status} (expected 402) - twice, 20s apart` });
      console.log(`${bucket === report.upstreamFail ? "UPSTREAM" : "FAIL"} ${key.padEnd(bucket === report.upstreamFail ? 41 : 46)} bare HTTP ${bare.status} (expected 402)`);
      continue;
    }
    const bareBody = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
    exampleInput = paymentRequired?.extensions?.bazaar?.info?.input || {};
    // A function-priced route (the metered tiers) quotes its 402 from the
    // BODY: the bare `{}` request above quoted the floor, the paid retry
    // below sends the example body, and the accept echoed with the payment
    // then names an amount the gate no longer derives - "requirements-
    // mismatch", filed as a rail failure for two weeks running on
    // /v1/metered/messages and /v1/metered/responses (2026-08-31, 09-07)
    // while the chat wire passed only because its example quotes the floor
    // too. So once the example is known, ask for the 402 AGAIN with the body
    // that will actually be paid, and sign against that quote. One more
    // unpaid request per POST tool; a flat-priced route quotes the same.
    if (t.method === "POST" && exampleInput.body && Object.keys(exampleInput.body).length) {
      const quoted = await fetch(`${TARGET}${t.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...heartbeatHeaders() },
        body: JSON.stringify(exampleInput.body),
        signal: AbortSignal.timeout(30000),
      });
      const quotedBody = await quoted.json().catch(() => undefined);
      if (quoted.status === 402) paymentRequired = http.getPaymentRequiredResponse((n) => quoted.headers.get(n), quotedBody);
    }
  } catch (e) { report.toolFail.push({ key, slug: t.slug, reason: `challenge: ${String(e.message).slice(0, 120)}` }); continue; }

  const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX));
  // TWO reasons a tool legitimately advertises no AVM accept, and both are
  // imported from the server rather than restated here, so neither can drift:
  //
  //  - IDENTITY-BOUND (the memory family, my-usage) derives the caller from the
  //    signed EIP-3009 authorization, which is EVM-only.
  //  - LONG-RUNNING (the report composites and media tiers) takes 40 to 240
  //    seconds, which outlives the default AVM validity window. Settlement runs
  //    after the handler, so offering the rail would mean the work is done and
  //    the buyer is never charged.
  //
  // Anything ELSE missing the accept means the rail silently stopped being
  // offered, which is a real regression. This sweep reported three media tiers
  // as exactly that on 2026-08-24: it was right to ask, and the answer lived in
  // a local const inside server.js that it could not reach.
  // A MULTIPART ROUTE CANNOT BE DRIVEN FROM HERE, and pretending otherwise
  // manufactures a defect. The two /v1/*/audio/transcriptions routes declare
  // `bodyType: "form-data"` and a placeholder `file` part; this sweep posts
  // JSON, so the handler correctly refuses with a self-explaining 400 and the
  // sweep booked it as "settled path fine, handler did not deliver". The
  // handler was right and the sweep was wrong. Read from the seller's own
  // declaration in the challenge rather than a slug list, so a new multipart
  // route is covered the day it ships.
  //
  // It does mean the rail goes unmeasured on those routes. That is the honest
  // trade: an unmeasured route is recorded as skipped, where a fabricated
  // failure would have to be explained away every week until someone stopped
  // reading the report.
  if (String(exampleInput.bodyType || "").toLowerCase() === "form-data") {
    report.skipped.push({ key, slug: t.slug, reason: "multipart route (bodyType form-data): this sweep can only post JSON, so a 400 here would be ours" });
    continue;
  }

  const expectedNoAvm = isIdentityBoundRoute(t) || isLongRunningSlug(t.slug);
  if (!accepts.length) {
    // THIRD reason, and a temporary one: a sub-cent route while the server has
    // withdrawn Algorand for the facilitator's spent sub-cent allowance (it can
    // start mid-sweep, on the first refused settle, so it is asked here).
    const withdrawn = !expectedNoAvm && t.priceUsd < 0.01 && (await subcentWithdrawnNow());
    report.noAvm.push({ key, slug: t.slug, expected: expectedNoAvm || withdrawn, ...(withdrawn ? { why: "sub-cent allowance spent" } : {}) });
    continue;
  }

  const usd = Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6;
  if (report.spentUsd + usd > MAX_USD) {
    capped = true;
    report.skipped.push({ key, slug: t.slug, reason: `total cap $${MAX_USD} reached (spent $${report.spentUsd.toFixed(4)})` });
    continue;
  }

  if (DRY) { report.ok.push({ key, slug: t.slug, usd, dry: true }); report.spentUsd += usd; processed++; continue; }

  // Replay the tool's own documented example so a 200 means a real payload.
  const reqInit = {
    method: t.method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(90000),
  };
  let url = `${TARGET}${t.path}`;
  if (t.method === "POST") reqInit.body = JSON.stringify(exampleInput.body || {});
  else if (exampleInput.queryParams) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(exampleInput.queryParams)) if (v != null && typeof v !== "object") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  // One complete buy: fresh signature, fresh request. Extracted so a throttled
  // attempt can be repeated after a backoff. Each call MUST sign again - an AVM
  // authorization is single-use, so replaying the first payload would be
  // refused by the replay guard rather than retried.
  const payOnce = async () => {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    return fetch(url, {
      ...reqInit,
      headers: { ...reqInit.headers, ...payHeaders, ...heartbeatHeaders(), "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
    });
  };

  // One buy = up to TWO fresh attempts. Every attempt SIGNS AGAIN (an AVM
  // authorization is single-use, and a >=400 cancels settlement, so a retried
  // payment costs nothing unless it succeeds). This sweep makes ~500 sequential
  // paid buys over ~55 min; on the way, three NON-defects each fail the whole
  // weekly gate if judged on first sight (measured across runs 2026-08-19):
  //   - an edge 502 "upstream error" (Railway swapping a container mid-sweep;
  //     it hits pure-CPU tools like xml-validate too, which have no upstream);
  //   - a THIRD-PARTY upstream 5xx/timeout (Blockscout/GLEIF/OpenRouter, or a
  //     router "Seller rejected the paid retry") - their outage, buyer NOT
  //     charged (>=400 cancels settlement);
  //   - a 409 "authorization already used": two equal-priced AVM buys inside
  //     one ~50-min validity window can sign to the same txid, so the second
  //     trips the replay guard. A fresh signature in a later round is a new
  //     txid, so the retry clears it.
  // So: classify only what SURVIVES a fresh retry, and a persistent third-party
  // outage is reported but does NOT fail the run (same posture as the external
  // buyer - "a failed third-party buy never pages"). A persistent failure from
  // OUR OWN handler still fails the run.
  const attempt = async () => {
    const startedMs = Date.now();
    const paid = await payOnce();
    const elapsedMs = Date.now() - startedMs;
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    let tx = null;
    if (receiptHdr) { try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")).transaction; } catch { /* best-effort */ } }
    const body = await paid.text().catch(() => "");
    const retryAfterS = Number(paid.headers.get("retry-after"));
    return { status: paid.status, body, tx, elapsedMs, retryAfterMs: Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : null };
  };
  try {
    let a = await attempt();
    let out = outcomeOf(a);
    let retried = false;
    // Anything that is not a clean settled payload gets ONE fresh retry after a
    // real pause. fast-402/throttle already meant "our own burst"; slow-402 and
    // other non-200s get the same benefit of the doubt - a rail/edge/upstream
    // blip mid-sweep must not fail a weekly gate on first sight. Only a problem
    // that SURVIVES the retry is real.
    if (out !== "ok") {
      const why = out === "breaker" ? `HTTP 429 from OUR OWN settle breaker (not the seller, not a vendor)`
        : out === "fast-402" ? `HTTP 402 in ${a.elapsedMs}ms (too fast to be a settlement)`
        : out === "throttle" ? `HTTP ${a.status} (upstream throttle)`
          : out === "slow-402" ? `HTTP 402 after ${a.elapsedMs}ms`
            : out === "empty" ? "settled 200 with an empty body"
              : `HTTP ${a.status}: ${a.body.slice(0, 100)}`;
      // The breaker's window is minutes, so it gets the pause IT asks for
      // rather than the burst pause. Bounded, because a long Retry-After on a
      // ~500-tool sweep would otherwise run for hours.
      const waitMs = out === "breaker" ? Math.min(a.retryAfterMs ?? BREAKER_MAX_WAIT_MS, BREAKER_MAX_WAIT_MS) : THROTTLE_BACKOFF_MS;
      console.log(`WAIT ${key.padEnd(46)} ${why} - retrying in ${waitMs}ms`);
      await sleep(waitMs);
      a = await attempt();
      out = outcomeOf(a);
      retried = true;
    }

    if (out === "ok") {
      report.ok.push({ key, slug: t.slug, usd, tx: a.tx || null, bytes: a.body.length, ...(retried ? { recovered: true } : {}) });
      report.spentUsd += usd;
      console.log(`OK   ${key.padEnd(46)} $${usd}${a.tx ? ` · tx ${a.tx.slice(0, 10)}…` : " · (no receipt header)"}${retried ? " · recovered on retry" : ""}  [${report.ok.length}]`);
    } else if (out === "breaker") {
      // NOT a verdict about this tool. Our own breaker refused the request
      // before the handler ran, so the sweep observed nothing - recording it as
      // a throttle blamed a vendor, and recording it as a failure would blame a
      // handler that was never reached.
      report.blocked.push({ key, slug: t.slug, reason: `refused by our own settle breaker: ${String(a.body).slice(0, 140)}` });
      console.log(`BLOCKED ${key.padEnd(42)} our own settle breaker (nothing measured)`);
    } else if (out === "fast-402" || out === "throttle") {
      // Survived a real pause and is STILL the fast/throttle shape -> the
      // facilitator is rate-limiting THIS wallet's volume, not a rail defect.
      report.throttled.push({ key, slug: t.slug, reason: `HTTP ${a.status} after ${THROTTLE_BACKOFF_MS}ms backoff: ${String(a.body).slice(0, 120)}` });
      console.log(`THROTTLED ${key.padEnd(40)} still limited after backoff`);
    } else if (out === "slow-402") {
      // Took real time (>= FAST_REJECT_MS) TWICE, so the facilitator genuinely
      // attempted and refused settlement - the rail (facilitator, accept,
      // validity window, opt-in) is the fault.
      report.railFail.push({ key, slug: t.slug, usd, reason: `settlement rejected after ${a.elapsedMs}ms, twice: ${a.body.slice(0, 140) || "(empty body)"}` });
      console.log(`FAIL ${key.padEnd(46)} HTTP 402 (settlement refused, twice)`);
    } else if (out === "empty") {
      report.toolFail.push({ key, slug: t.slug, reason: "settled 200 with an empty body, twice" });
      console.log(`FAIL ${key.padEnd(46)} 200 empty body (twice)`);
    } else if (isUpstreamOutage(a.status, a.body)) {
      // Persistent third-party / edge failure: their outage, not our defect,
      // and a >=400 cancelled settlement so the buyer was never charged.
      // Reported, does NOT fail the run.
      report.upstreamFail.push({ key, slug: t.slug, reason: `HTTP ${a.status}: ${a.body.slice(0, 140)}` });
      console.log(`UPSTREAM ${key.padEnd(41)} HTTP ${a.status} (third-party/edge, not charged, twice)`);
    } else {
      // A >=400 cancels settlement (x402 settles after the handler), so we
      // were NOT charged - our own handler is the fault, the rail is fine.
      report.toolFail.push({ key, slug: t.slug, reason: `HTTP ${a.status}: ${a.body.slice(0, 160)} (twice)` });
      console.log(`FAIL ${key.padEnd(46)} HTTP ${a.status} (twice)`);
    }
    // Consecutive unmeasurable outcomes: the rail is refusing everything, or
    // our own breaker is, and either way the remaining tools tell us nothing.
    // An `ok` anywhere resets it, so an isolated failure among successes - the
    // thing this alarm exists to catch - never trips it.
    if (out === "ok") consecutiveBlind = 0;
    else if (out === "breaker" || out === "slow-402" || out === "fast-402") consecutiveBlind++;
    else consecutiveBlind = 0;
  } catch (e) { report.toolFail.push({ key, slug: t.slug, reason: `pay: ${String(e.message).slice(0, 160)}` }); }

  processed++;
  if (consecutiveBlind >= ABORT_AFTER_CONSECUTIVE) {
    report.aborted = {
      afterTools: processed,
      unmeasured: tools.length - processed,
      consecutive: consecutiveBlind,
      why: "settlement or our own breaker refused every attempt in a row - the remaining tools could not be observed",
    };
    console.log(`\nABORTED after ${processed} tools: ${consecutiveBlind} consecutive attempts measured nothing.`);
    console.log(`${report.aborted.unmeasured} tools were NOT tested. This is not a verdict about them.`);
    break;
  }
  await sleep(DELAY_MS);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
report.finishedAt = new Date().toISOString();
const unexpectedNoAvm = report.noAvm.filter((n) => !n.expected);

console.log(`\n=== Algorand rail canary ===`);
const recovered = report.ok.filter((o) => o.throttledFirst).length;
console.log(`settled+payload: ${report.ok.length} · rail failures: ${report.railFail.length} · rate-limited: ${report.rateLimited.length} · tool failures: ${report.toolFail.length} · upstream throttles: ${report.throttled.length} · third-party outages: ${report.upstreamFail.length}${recovered ? ` (${recovered} recovered on retry)` : ""}`);
if (report.blocked.length) console.log(`blocked by OUR OWN settle breaker (nothing measured, neither pass nor fail): ${report.blocked.length}`);
if (report.aborted) console.log(`ABORTED: ${report.aborted.unmeasured} tools never tested (${report.aborted.why})`);
console.log(`no AVM accept: ${report.noAvm.length} (${report.noAvm.length - unexpectedNoAvm.length} expected: identity-bound, long-running, or sub-cent while the facilitator's sub-cent allowance is spent (${report.noAvm.filter((n) => n.why).length}); ${unexpectedNoAvm.length} unexpected) · skipped: ${report.skipped.length}`);
console.log(`spent (recycles to our own payTo): $${report.spentUsd.toFixed(4)}${capped ? "  [TOTAL CAP REACHED]" : ""}`);

if (report.railFail.length) {
  console.log(`\nRAIL FAILURES (Algorand settlement refused after a genuine, slow attempt):`);
  for (const f of report.railFail) console.log(`  ${f.key} — ${f.reason}`);
}
if (report.blocked.length) {
  console.log(`\nBLOCKED BY OUR OWN SETTLE BREAKER (nothing was measured about these tools):`);
  for (const f of report.blocked.slice(0, 15)) console.log(`  ${f.key}`);
  if (report.blocked.length > 15) console.log(`  … ${report.blocked.length - 15} more (see the report artifact)`);
  console.log(`  This is OUR gate, not a vendor and not the seller: a wallet whose payments`);
  console.log(`  verified and then failed to settle is refused for GATEWAY_SETTLE_BREAKER_WINDOW_MS.`);
  console.log(`  It FOLLOWS real settle failures, so read the rail failures above for the cause;`);
  console.log(`  these rows are the consequence, and they are neither a pass nor a failure.`);
}
if (report.rateLimited.length) {
  console.log(`\nRATE-LIMITED (fast 402s that survived a backoff - likely the facilitator throttling this wallet's volume, not a rail defect):`);
  for (const f of report.rateLimited) console.log(`  ${f.key} — ${f.reason}`);
  console.log(`  NOTE: this sweep buys ~500 tools back to back, which no real buyer does.`);
  console.log(`  Raise CANARY_DELAY_MS or CANARY_THROTTLE_BACKOFF_MS if this recurs.`);
}
if (report.toolFail.length) {
  console.log(`\nTOOL FAILURES (settled path fine, handler did not deliver):`);
  for (const f of report.toolFail.slice(0, 40)) console.log(`  ${f.key} — ${f.reason}`);
  if (report.toolFail.length > 40) console.log(`  … ${report.toolFail.length - 40} more (see the report artifact)`);
}
if (report.throttled.length) {
  console.log(`\nUPSTREAM THROTTLES (handler fine, vendor refused us even after a backoff):`);
  for (const f of report.throttled) console.log(`  ${f.key} — ${f.reason}`);
  console.log(`  NOTE: this sweep buys every tool back to back, which no real buyer does.`);
  console.log(`  Raise CANARY_DELAY_MS or CANARY_THROTTLE_BACKOFF_MS if this recurs.`);
}
if (report.upstreamFail.length) {
  console.log(`\nTHIRD-PARTY / EDGE OUTAGES (persisted through a fresh retry; buyer NOT charged - their outage or an edge blip, not our rail/tool defect, so these do NOT fail the run):`);
  for (const f of report.upstreamFail) console.log(`  ${f.key} — ${f.reason}`);
}
if (unexpectedNoAvm.length) {
  console.log(`\nUNEXPECTED: these tools offer no algorand accept and are not identity-bound:`);
  for (const n of unexpectedNoAvm) console.log(`  ${n.key} (${n.slug})`);
}

if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\nwrote ${OUT}`); }

// Rail failures and tool failures are both real defects. Unexpected missing
// accepts mean the rail silently stopped being offered, which is the exact
// regression this canary exists to catch — all three fail the run.
//
// Upstream throttles deliberately do NOT. This sweep buys ~500 tools back to
// back and hits one vendor repeatedly; no real buyer produces that shape, so a
// 429 under it is our own load, not a product defect. The 2026-08-03 run failed
// on exactly this: 7 OpenAI-backed tools reported as broken while the rail was
// perfect and the handlers were fine.
//
// An alarm that reports our own burst as a defect is worse than no alarm,
// because the next real failure lands in a report people have learned to skim.
// They are still printed, and a throttle that survives a real backoff is worth
// reading - it just does not page.
// Third-party/edge outages (report.upstreamFail) are deliberately excluded:
// they persisted through a fresh retry but the buyer was never charged and the
// fault is a vendor or the edge, not our rail or handler - same doctrine as the
// external buyer. They are printed above so a spike is still visible.
const bad = report.railFail.length + report.toolFail.length + unexpectedNoAvm.length;
// A sweep that aborted measured only part of the catalog. Saying "pass" over a
// partial sweep is the flattering failure this whole script exists to avoid, so
// an abort fails the run whether or not it also recorded a defect.
if (report.aborted && !bad) {
  console.error(`\nFAIL: the sweep could not be completed - ${report.aborted.unmeasured} of ${tools.length} tools were never tested.`);
  process.exit(1);
}
if (bad) { console.error(`\nFAIL: ${bad} problem(s) on the Algorand rail.${report.aborted ? ` Sweep ABORTED with ${report.aborted.unmeasured} tools never tested.` : ""}`); process.exit(1); }
console.log(`\nPASS: every attempted tool settled on Algorand and returned a payload.`);
