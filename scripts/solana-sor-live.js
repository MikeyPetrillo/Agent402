#!/usr/bin/env node
// LIVE proof of the Solana spending wallet: a buyer pays US on Solana for a
// task that resolves to an EXTERNAL Solana seller, and route-and-execute pays
// that seller from SOLANA_UPSTREAM_BUYER_KEY's wallet and relays the result.
// Chain-matched (a Solana buyer reaches Solana sellers), real money both legs:
// the canary burner pays our route price, the spending wallet pays the seller.
// Asserts: a solana accept on the 402, a 200 with receipt.external === true,
// settleNetwork = mainnet CAIP-2, the payload delivered, and the spending
// wallet's USDC balance dropping by at least the seller's price.
// Dispatch-only (solana-sor-live.yml). A 404/409 from the router (no candidate
// cleared the pay-time proven-seller gate) exits 1 with the router's own words
// - that is a truthful "not proven yet", not a harness failure.
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPENDER = process.env.SOLANA_SPENDING_ADDRESS || "8KqQG8MefNvQEQmp9gBjov39DXcWsUpSeqjL9pPCGKKE";
const ROUTE_ALLOWED = new Set(["/api/route/execute", "/api/route/execute-plus", "/api/route/execute-pro"]);
// Defaults = the combination PROVEN on chain 2026-09-02 (tx 4a2GPKp6...): the
// task text ranks sol.blockrun.ai's /api/v1/exa/search first (its rows are
// named by path, so path-shaped text is what matches), $0.012 fits the
// execute-plus cap, and the route pays blockrun's shared Solana payTo, which
// clears the proven-seller gate by thousands. The old default ("list supported
// rpc chains") matched no Solana seller at all, and "us stock price" resolves
// to blockrun's Pyth-backed feed, which 502s on every ticker since Pyth went
// keyed (2026-08-26) - 23 red runs on 2026-09-01 proved the seller's upstream,
// not our rail.
const ROUTE = process.env.ROUTE || "/api/route/execute-plus";
if (!ROUTE_ALLOWED.has(ROUTE)) { console.error(`refusing ROUTE=${JSON.stringify(ROUTE)}: not one of ${[...ROUTE_ALLOWED].join(", ")}`); process.exit(2); }
const TASK = process.env.TASK || "api v1 exa search";
const PARAMS = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : { query: "bitcoin" };
const EXPECT_TEXT = process.env.EXPECT_TEXT || "results";
import { createHmac } from "node:crypto";
const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
if (!raw) { console.error("need SOLANA_BURNER_KEY"); process.exit(2); }

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
};
const usdcOf = async (owner) => {
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }]).catch(() => null);
  return res ? Number(res?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0) : null;
};
const secret = (process.env.POW_SECRET || "").trim();
const hb = () => secret ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) } : {};

const [{ x402Client }, { registerExactSvmScheme }, { wrapFetchWithPayment }, kit] = await Promise.all([
  import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit"),
]);
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
const signer = await kit.createKeyPairSignerFromBytes(bytes);
console.log(`buyer (burner): ${signer.address}`);
const before = await usdcOf(SPENDER);
console.log(`spending wallet ${SPENDER} USDC before: ${before}`);

// The canary's Request-based wrapper, verbatim in shape: the payment wrapper
// hands headers as a Headers INSTANCE, and spreading one as {...headers}
// yields {} - which silently dropped PAYMENT-SIGNATURE on the paid retry and
// bounced the first proof run 402 in 0.3s. new Request(input, init) preserves
// whatever the wrapper set; we only ADD the heartbeat token.
const synthFetch = (input, init) => {
  const req = new Request(input, init);
  const t = hb()["X-Heartbeat-Token"];
  if (t) req.headers.set("X-Heartbeat-Token", t);
  return fetch(req);
};
const pay = wrapFetchWithPayment(synthFetch, registerExactSvmScheme(new x402Client(), { signer }));
const url = `${TARGET}${ROUTE}`;
if (new URL(url).origin !== new URL(TARGET).origin) { console.error("refusing: target origin changed"); process.exit(2); }
const body = JSON.stringify({ task: TASK, include: "external", params: PARAMS });

// Sight check first: the bare 402 must OFFER solana, or nothing below means anything.
const bare = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...hb() }, body });
const prHdr = bare.headers.get("payment-required") || "";
let offersSolana = false;
try { offersSolana = JSON.parse(Buffer.from(prHdr, "base64").toString("utf8")).accepts.some((a) => String(a.network || "").startsWith("solana:")); } catch { /* checked below */ }
console.log("bare:", bare.status, "solana accept offered:", offersSolana);
if (bare.status !== 402 || !offersSolana) { console.error("NOT PROVEN: the route's 402 offers no solana accept"); process.exit(1); }

const paid = await pay(url, { method: "POST", headers: { "content-type": "application/json" }, body });
const out = await paid.json().catch(() => ({}));
console.log("paid:", paid.status, JSON.stringify(out?.receipt || out).slice(0, 500));
const resultText = JSON.stringify(out?.result ?? null);
console.log("result excerpt:", resultText.slice(0, 600));
const payloadOk = resultText.toLowerCase().includes(EXPECT_TEXT.toLowerCase());
console.log(`result contains ${JSON.stringify(EXPECT_TEXT)}:`, payloadOk, `(result ${resultText.length} chars)`);
try { const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.RESPONSE_OUT || "solana-sor-response.json", JSON.stringify(out)); } catch { /* best-effort */ }
const r = out?.receipt || {};
// The spend is proven from the CHAIN, not from a single balance re-read: the
// first version slept 6 s and read the balance once, and a lagging RPC node
// answered the pre-buy figure - a settled, on-chain-verified buy (tx
// 4a2GPKp6..., 2026-09-02 00:29Z, spender -0.01 / seller +0.01) reported
// NOT PROVEN. Preferred proof: the receipt's settleTx, read at confirmed
// commitment, must debit the spending wallet's USDC by at least the seller
// price. Fallback (no tx named): poll the balance for up to 45 s.
const owed = Number(r.underlyingPriceUsd || 0);
let after = null, proof = "";
if (r.settleTx) {
  for (let i = 0; i < 15 && !proof; i++) {
    const tx = await rpc("getTransaction", [r.settleTx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    if (tx && !tx.meta?.err) {
      const at = (list, owner) => Number((list || []).find((b) => b?.mint === USDC_MINT && b?.owner === owner)?.uiTokenAmount?.amount || 0) / 1e6;
      const debit = at(tx.meta?.preTokenBalances, SPENDER) - at(tx.meta?.postTokenBalances, SPENDER);
      if (debit >= owed - 1e-6 && debit > 0) proof = `tx ${r.settleTx} debits the spending wallet ${debit.toFixed(6)} USDC at slot ${tx.slot}`;
      else { console.error(`settle tx found but the spending wallet's USDC delta is ${debit.toFixed(6)} (owed ${owed})`); break; }
    } else if (tx?.meta?.err) { console.error("settle tx FAILED on chain:", JSON.stringify(tx.meta.err)); break; }
    else await new Promise((res) => setTimeout(res, 3000));
  }
}
for (let i = 0; i < 15 && !proof; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  after = await usdcOf(SPENDER);
  if (before != null && after != null && before - after >= owed - 1e-6 && before - after > 0) proof = `balance fell ${(before - after).toFixed(6)} USDC`;
}
if (after == null) after = await usdcOf(SPENDER);
console.log(`spending wallet USDC after: ${after} (delta ${before != null && after != null ? (after - before).toFixed(6) : "?"}); proof: ${proof || "none"}; receipt:`, JSON.stringify(r).slice(0, 400));
const ok = paid.status === 200 && r.external === true && String(r.settleNetwork || "") === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  && out.result && payloadOk && Boolean(proof);
if (ok) console.log(`PROVEN: Solana buyer -> route-execute -> external Solana seller ${r.seller} paid from the spending wallet (seller $${r.underlyingPriceUsd}${r.settleTx ? `, tx https://solscan.io/tx/${r.settleTx}` : ""}); payload delivered (${resultText.length} chars)`);
else console.error(`NOT PROVEN${paid.status === 404 || paid.status === 409 ? ` - router said: ${JSON.stringify(out?.error || out).slice(0, 300)}` : ""}`);
process.exit(ok ? 0 : 1);
