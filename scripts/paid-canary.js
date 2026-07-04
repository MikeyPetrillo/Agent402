// Paid-path canary — buys ONE tool from each live-data kit to prove that
// *buying* still settles end-to-end. Its pass/fail reflects whether PAYMENT
// works, NOT whether every third-party data API happened to respond:
//
//   • 200             → settled + delivered                       (success)
//   • 5xx / timeout   → payment SETTLED (x402 settles BEFORE the handler runs);
//                        the upstream data source errored          (WARNING, not a buying break)
//   • 402             → payment did NOT settle for that call       (settlement signal)
//   • 200 bad-shape   → delivered the wrong payload               (WARNING — tool/upstream quality)
//
// The canary PAGES (exit 1, opens the GitHub issue) only when *buying* is
// actually broken: the deterministic core tool (hash) didn't settle, nothing
// settled at all, or settlement failed on half-or-more of the tools. Isolated
// upstream throttles (CoinGecko / Pyth / Brave free-tier rate limits) are
// reported as warnings and do NOT page — that was the chronic false alarm
// ("PAID CANARY FAILED / buying may be broken" when a single data API blipped).
//
// Exit codes: 0 = buying works (warnings allowed) · 1 = buying broken · 2 = misconfig
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
// The x402 client + viem are imported dynamically inside main() so this module
// can be imported for unit tests (of the pure decision logic) without those
// packages installed — CI installs them just before the canary runs.

export const CORE_KIT = "core"; // deterministic baseline (hash): no upstream, so a failure = paywall/facilitator down

// Per-tool spec: { kit, path, method, body?, priceUsd, check(body) → true | string }
export const TOOLS = [
  {
    kit: "core",
    path: "/api/hash",
    method: "POST",
    body: { text: "hello world" },
    priceUsd: 0.001,
    check: (r) => r.hex?.startsWith("b94d27b9") || `expected hex starting with b94d27b9, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "edgar",
    path: "/api/edgar-company-lookup?ticker=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => r.cik === "0000320193" || `expected cik 0000320193, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "search",
    path: "/api/search?q=bitcoin&count=1",
    method: "GET",
    priceUsd: 0.01,
    check: (r) => (Array.isArray(r.results) && r.results.length > 0) || `expected non-empty results array, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "macro",
    path: "/api/treasury-yield-curve",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (typeof r.yr10 === "number" && r.yr10 > 0 && r.yr10 < 25) || `expected yr10 in (0, 25), got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "finance",
    path: "/api/stock-quote?symbol=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.symbol === "AAPL" && r.currency === "USD" && r.price > 1) || `expected AAPL/USD/price>1, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "crypto",
    path: "/api/crypto-price?coins=BTC",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.coins?.bitcoin?.price > 1000) || `expected bitcoin.price > 1000, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "chain",
    path: "/api/gas-snapshot",
    method: "POST",
    body: { network: "base" },
    priceUsd: 0.005,
    check: (r) => (
      typeof r.baseFeeGwei === "number" && r.baseFeeGwei > 0 && r.baseFeeGwei < 1000 &&
      r.fast && typeof r.fast.totalGwei === "number" && r.fast.totalGwei >= r.baseFeeGwei &&
      r.chainId === 8453
    ) || `expected baseFeeGwei (0,1000) + fast.totalGwei>=baseFee + chainId=8453, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "price-feed",
    path: "/api/price-pyth",
    method: "POST",
    body: { ids: ["ETHUSD"] },
    priceUsd: 0.001,
    check: (r) => {
      const eth = Array.isArray(r.feeds) && r.feeds.find((f) => f.alias === "ETHUSD");
      return (eth && typeof eth.price === "number" && eth.price > 80 && eth.price < 50000)
        || `expected feeds[ETHUSD].price in (80, 50000), got ${JSON.stringify(r).slice(0, 120)}`;
    },
  },
  {
    kit: "answer",
    path: "/api/answer?q=what+is+the+speed+of+light",
    method: "GET",
    priceUsd: 0.03,
    check: (r) => (typeof r.answer === "string" && r.answer.length > 0 && r.citationCount > 0) || `expected non-empty answer + citationCount>0, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "llm-gateway",
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.02,
    check: (r) => (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0) || `expected choices[0].message.content, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    kit: "edgar",
    path: "/api/company-financials?ticker=AAPL",
    method: "GET",
    priceUsd: 0.02,
    check: (r) => (Array.isArray(r.metrics) && r.metrics.length === 9 && r.metrics[0].label === "Revenue" && r.metrics[0].latestAnnual?.value > 1e9) || `expected 9 metrics with Revenue > $1B, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "search",
    path: "/api/multi-search",
    method: "POST",
    body: { queries: ["x402 protocol", "USDC micropayments"], count: 2 },
    priceUsd: 0.08,
    check: (r) => (Array.isArray(r.searches) && r.searches.length === 2 && r.totalResults > 0) || `expected 2 searches with totalResults>0, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/financial-analysis",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.04,
    check: (r) => (r.pack === "financial-analysis" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=financial-analysis with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/market-brief",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.025,
    check: (r) => (r.pack === "market-brief" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=market-brief with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  // Stellar (USDC on Stellar) settlement is tested via a separate mechanism —
  // the TOOLS array pays exclusively through Base EVM (registerExactEvmScheme),
  // so adding a Stellar entry here would settle on Base, not prove the Stellar
  // rail. First Stellar settlement confirmed manually 2026-07-04 ($0.001).
  // A dedicated inline Stellar leg (like the Solana/Robinhood legs below) can
  // be added once @x402/stellar/exact/client is available in the SDK.
  {
    kit: "skill-pack",
    path: "/api/skill/domain-intel",
    method: "POST",
    body: { domain: "stripe.com" },
    priceUsd: 0.25,
    check: (r) => (r.pack === "domain-intel" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/company-dossier",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.50,
    check: (r) => (r.pack === "company-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/crypto-dossier",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.30,
    check: (r) => (r.pack === "crypto-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
];

// Classify one tool result. Pure — unit-tested in scripts/test-paid-canary.js.
//   settled | bad-shape | unsettled | upstream | request-error | unreachable
export function classifyResult({ status, shapeOk, transportError } = {}) {
  if (transportError) return "unreachable";
  if (status === 200) return shapeOk === true ? "settled" : "bad-shape";
  if (status === 402) return "unsettled";   // x402 payment did not complete
  if (status >= 500) return "upstream";     // PAID (settles pre-handler); upstream data source errored
  return "request-error";                   // other 4xx — tool-specific, not a buying break
}

// Decide whether BUYING is broken from all tool results. Pure — unit-tested.
export function decideCanary(results, { coreKit = CORE_KIT } = {}) {
  const rows = results.map((r) => ({ ...r, cls: classifyResult(r) }));
  const core = rows.find((r) => r.kit === coreKit);
  const coreSettled = !!core && core.status === 200; // payment went through on the deterministic baseline
  const settled = rows.filter((r) => r.cls === "settled").length;
  const unsettled = rows.filter((r) => r.cls === "unsettled").length;
  const unreachable = rows.filter((r) => r.cls === "unreachable").length;
  const half = Math.ceil(rows.length / 2);

  const reasons = [];
  if (!coreSettled) reasons.push(`core tool "${coreKit}" did not settle — paywall / facilitator / settlement is down`);
  if (settled === 0) reasons.push("no tool settled — buying is down");
  if ((unsettled + unreachable) >= half) reasons.push(`${unsettled + unreachable}/${rows.length} calls failed to settle — systemic settlement failure`);

  const warnings = rows
    .filter((r) => r.cls !== "settled")
    .map((r) => `${r.kit}:${r.path} [${r.cls}]${r.status ? ` HTTP ${r.status}` : ""}${typeof r.shapeOk === "string" ? ` — ${r.shapeOk}` : ""}`);

  return { broken: reasons.length > 0, coreSettled, settled, unsettled, unreachable, rows, warnings, reasons };
}

// --- CLI (network). Importing this module for tests does NOT run any of this. ---
async function main() {
  const TARGET = process.env.TARGET_URL || "https://agent402.tools";
  const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) { console.error("paid-canary: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

  const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });

  // Mark every canary request as internal traffic: X-Heartbeat-Token =
  // HMAC(POW_SECRET, UTC minute) — the same unspoofable marker the heartbeat
  // probe sends (verified in src/pow.js; rail attribution is unaffected, the
  // buy still settles as usdc). Without it the canary's daily REAL purchases
  // are indistinguishable from external demand in the sales ledger and the
  // PostHog settlement stream. Minted per request (minute-scoped token).
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) console.warn("WARN  POW_SECRET not set — canary buys will record as EXTERNAL demand in the sales ledger");
  const synthFetch = !secret ? fetch : (url, init = {}) => {
    const minute = Math.floor(Date.now() / 60_000);
    const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
    const headers = new Headers(init.headers || {});
    headers.set("X-Heartbeat-Token", token);
    return fetch(url, { ...init, headers });
  };
  const payFetch = wrapFetchWithPayment(synthFetch, client);

  // One-shot retry on 5xx — absorbs a true one-off upstream throttle before we
  // even classify. A persistent upstream issue fails the retry too and is then
  // recorded as an "upstream" warning (payment still settled), not a buying break.
  async function payOnceWithRetryOn5xx(url, init) {
    const first = await payFetch(url, init);
    if (first.status < 500 || first.status > 599) return first;
    await first.text().catch(() => "");
    console.warn(`  retry ${init.method} ${url} after HTTP ${first.status} (10s backoff)`);
    await new Promise((r) => setTimeout(r, 10000));
    return payFetch(url, init);
  }

  // Preflight (config) — a WARNING only; it indicates a missing env var, not a
  // payments outage, so it must not page.
  try {
    const health = await (await fetch(`${TARGET}/health`)).json();
    if (health?.flags?.yahooRelay !== true) console.warn(`WARN  preflight: /health.flags.yahooRelay=${health?.flags?.yahooRelay} (set YAHOO_RELAY_URL/TOKEN) — finance tool may warn`);
    else console.log("OK    preflight /health.flags.yahooRelay=true");
  } catch (e) {
    console.warn(`WARN  preflight: GET ${TARGET}/health failed: ${(e?.message || String(e)).slice(0, 120)}`);
  }

  const results = [];
  for (const t of TOOLS) {
    const url = `${TARGET}${t.path}`;
    const init = { method: t.method };
    if (t.body) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(t.body); }
    try {
      const res = await payOnceWithRetryOn5xx(url, init);
      const body = await res.json().catch(() => ({}));
      const shapeOk = res.status === 200 ? t.check(body) : false;
      const row = { kit: t.kit, path: t.path, status: res.status, shapeOk, priceUsd: t.priceUsd };
      results.push(row);
      const cls = classifyResult(row);
      if (cls === "settled") console.log(`OK    ${t.kit.padEnd(10)} ${t.path}  → settled $${t.priceUsd.toFixed(3)}`);
      else console.warn(`WARN  ${t.kit}:${t.path} [${cls}] HTTP ${res.status}${typeof shapeOk === "string" ? ` — ${shapeOk}` : ` ${JSON.stringify(body).slice(0, 100)}`}`);
    } catch (e) {
      results.push({ kit: t.kit, path: t.path, status: null, shapeOk: false, transportError: true, priceUsd: t.priceUsd });
      console.warn(`WARN  ${t.kit}:${t.path} [unreachable] ${(e?.message || String(e)).slice(0, 140)}`);
    }
  }

  // Optional Solana leg — gated on SOLANA_BURNER_KEY (base58 64-byte secret
  // or JSON byte array; fund it with USDC on Solana). Buys the $0.05
  // skill-decode-blob pack (seven pure-CPU tools, deterministic, no upstream
  // cost) with an SVM-ONLY client, so the payment can only settle on a Solana
  // accept — a true Solana-path proof with no silent EVM fallback. $0.05
  // instead of the $0.001 hash so the transfer clears explorer dust filters;
  // the printed tx signature is still the authoritative proof either way.
  // Informational: failures WARN, never page (the EVM verdict above decides
  // paging), so an unset or unfunded burner cannot open an issue.
  await (async () => {
    const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
    if (!raw) { console.log("\nsolana leg: skipped (no SOLANA_BURNER_KEY)"); return; }
    try {
      const [{ x402Client: SvmClient }, { registerExactSvmScheme }, { wrapFetchWithPayment: wrapSvm }, kit, { createHash }] = await Promise.all([
        import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit"), import("node:crypto"),
      ]);
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
      const signer = await kit.createKeyPairSignerFromBytes(bytes);
      const svmPay = wrapSvm(synthFetch, registerExactSvmScheme(new SvmClient(), { signer }));
      const res = await svmPay(`${TARGET}/api/skill/decode-blob`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The pack's own documented example blob (a JWT) — deterministic steps.
        body: JSON.stringify({ blob: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.pack === "decode-blob" && Array.isArray(body.steps) && body.steps.length >= 5) {
        // Print the on-chain proof, not just the claim: the settle receipt
        // (PAYMENT-RESPONSE header, v2; X-PAYMENT-RESPONSE, v1) carries the
        // transaction signature — a clickable solscan link beats "trust the
        // facilitator" (and dust-sized transfers are hidden by default in
        // explorer transfer views, so the signature is the reliable check).
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    solana     /api/skill/decode-blob  → settled $0.05 USDC on Solana (payer ${signer.address})${tx ? `\n      tx: https://solscan.io/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (res.status === 402) {
        console.warn(`\nWARN  solana leg did NOT settle (HTTP 402, payer ${signer.address}) — decoding diagnostics:`);
        // The rejection reason lives in the PAYMENT-REQUIRED header of the
        // response that came back AFTER the client attached payment — decode
        // it verbatim so the log names the actual verify/settle failure
        // (wrong mint, missing feePayer, insufficient funds, version skew)
        // instead of guessing.
        const decode402 = (r) => {
          const h = r.headers.get("payment-required");
          if (!h) return null;
          try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
        };
        const failReq = decode402(res);
        console.warn(`      post-payment challenge: error=${JSON.stringify(failReq?.error ?? null)} x402Version=${failReq?.x402Version ?? "?"}`);
        try {
          // Fresh unpaid request → what a Solana buyer is actually offered.
          const bare = await fetch(`${TARGET}/api/skill/decode-blob`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob: "canary" }) });
          const req = decode402(bare) ?? (await bare.json().catch(() => null));
          const sol = (req?.accepts || []).filter((a) => String(a.network || "").startsWith("solana:"));
          console.warn(`      solana accepts offered: ${sol.length ? JSON.stringify(sol).slice(0, 600) : "NONE — Solana missing from the live 402"}`);
        } catch (e2) {
          console.warn(`      (could not re-fetch challenge for diagnostics: ${(e2?.message || String(e2)).slice(0, 100)})`);
        }
      } else {
        console.warn(`\nWARN  solana leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  solana leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Optional Robinhood Chain leg — same burner key as the EVM canary above
  // (one 0x address, funded with USDG on chain 4663). wrapFetchWithPayment
  // lets the client pick ANY eip155 accept (it would settle on Base), so this
  // leg negotiates manually: take the live 402, filter the accepts down to
  // eip155:4663, and pay THAT — settlement can only happen in USDG on
  // Robinhood Chain, a true rail proof with no silent Base fallback. The
  // accept carries the USDG asset + EIP-712 domain (extra.name/version), so
  // the standard EVM scheme signs it as-is. $0.001/call; a funded burner
  // covers years of daily proof. Informational: failures WARN, never page
  // (the EVM verdict above decides paging) — but a WARN here that robinhood
  // is missing from the accepts is the early signal the rail was dropped.
  await (async () => {
    try {
      const { x402HTTPClient } = await import("@x402/core/client");
      const http = new x402HTTPClient(client);
      const reqInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "usdg-canary" }) };
      const bare = await synthFetch(`${TARGET}/api/hash`, reqInit);
      if (bare.status !== 402) {
        console.warn(`\nWARN  robinhood leg: expected a 402 challenge from /api/hash, got HTTP ${bare.status}`);
        return;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        console.warn(`\nWARN  robinhood leg: could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        return;
      }
      const rh = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === "eip155:4663");
      if (!rh.length) {
        console.warn(`\nWARN  robinhood leg: eip155:4663 NOT among the live 402 accepts — the Robinhood/USDG rail has dropped out of the offer (PAYMENT_NETWORKS or ROBINHOOD_FACILITATOR_URL changed on prod?)`);
        return;
      }
      const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: rh });
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      const paid = await synthFetch(`${TARGET}/api/hash`, {
        ...reqInit,
        headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
      });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && typeof body.hex === "string") {
        let tx = null, net = null;
        const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
        if (receiptHdr) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"));
            tx = receipt?.transaction || null;
            net = receipt?.network || null;
          } catch { /* best-effort */ }
        }
        console.log(`\nOK    robinhood  /api/hash  → settled $0.001 USDG on Robinhood Chain (payer ${account.address}${net ? `, network ${net}` : ""})${tx ? `\n      tx: https://robinhoodchain.blockscout.com/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (paid.status === 402) {
        const h = paid.headers.get("payment-required");
        let reason = null;
        if (h) { try { reason = JSON.parse(Buffer.from(h, "base64").toString("utf8"))?.error ?? null; } catch { /* ignore */ } }
        console.warn(`\nWARN  robinhood leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded USDG burner, facilitator outage, or EIP-712 domain drift)`);
      } else {
        console.warn(`\nWARN  robinhood leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  robinhood leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  const decision = decideCanary(results);
  const spentUsd = decision.rows.filter((r) => r.cls === "settled").reduce((s, r) => s + (r.priceUsd || 0), 0);
  console.log(`\npayer ${account.address}`);
  console.log(`tools: ${decision.settled} settled, ${results.length - decision.settled} not | spent ~$${spentUsd.toFixed(3)} USDC on Base`);
  if (decision.warnings.length) console.warn(`\nwarnings (non-blocking — upstream/data, not payments):\n  ${decision.warnings.join("\n  ")}`);

  if (decision.broken) {
    console.error(`\nPAID CANARY FAILED — buying looks broken:\n  ${decision.reasons.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`\npaid-canary OK — buying works (${decision.settled}/${results.length} settled${decision.warnings.length ? `; ${decision.warnings.length} upstream warning(s)` : ""}).`);
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
