#!/usr/bin/env node
// LIVE proof of the Tempo spending wallet: a buyer pays US over MPP/Tempo for
// a task that resolves to an EXTERNAL Tempo seller, and route-and-execute pays
// that seller from TEMPO_UPSTREAM_BUYER_KEY's wallet and relays the result.
// Chain-matched (a Tempo buyer reaches Tempo sellers), real money both legs:
// the canary burner pays our route price, the spending wallet pays the seller.
// Asserts: a tempo challenge on the 402, a 200 with receipt.external === true,
// receipt.wire === "mpp", settleNetwork eip155:4217 and a settle tx, a
// Payment-Receipt on our response, and the spending wallet's USDC.e balance
// dropping by the seller's price. Dispatch-only (tempo-sor-live.yml).
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const USDCE = "0x20C000000000000000000000b9537d11c60E8b50";
const SPENDER = (process.env.TEMPO_SPENDING_ADDRESS || "0xaF13AA07E7360cC56B3dAbf649fFeF087c0cD5A6").toLowerCase();
// ROUTE is a dispatch input that steers a REAL-MONEY request signed by the
// burner: allowlisted to our router tiers, never a free-form path (a value
// like `@evil.example/` would otherwise rewrite the URL's host).
const ROUTE_ALLOWED = new Set(["/api/route/execute", "/api/route/execute-plus", "/api/route/execute-pro"]);
const ROUTE = process.env.ROUTE || "/api/route/execute";
if (!ROUTE_ALLOWED.has(ROUTE)) { console.error(`refusing ROUTE=${JSON.stringify(ROUTE)}: not one of ${[...ROUTE_ALLOWED].join(", ")}`); process.exit(2); }
const TASK = process.env.TASK || "scrape a web page with firecrawl";
const PARAMS = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : { url: "https://example.com" };
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) { console.error("need BURNER_KEY"); process.exit(2); }
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

const usdce = async (addr) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDCE, data: `0x70a08231000000000000000000000000${addr.slice(2)}` }, "latest"] }) });
  const j = await r.json(); return j.result && j.result !== "0x" ? Number(BigInt(j.result)) / 1e6 : null;
};
const secret = (process.env.POW_SECRET || "").trim();
const hb = () => secret ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) } : {};

const [{ Mppx, tempo }, { Challenge, Receipt }] = await Promise.all([import("mppx/client"), import("mppx")]);
const client = Mppx.create({ methods: [tempo.charge({ account, autoSwap: true })], polyfill: false });

const before = await usdce(SPENDER);
console.log(`spending wallet ${SPENDER} USDC.e before: ${before}`);
const body = JSON.stringify({ task: TASK, include: "external", params: PARAMS });
const url = `${TARGET}${ROUTE}`;
if (new URL(url).origin !== new URL(TARGET).origin) { console.error("refusing: target origin changed"); process.exit(2); }
const bare = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...hb() }, body });
await bare.text().catch(() => "");
const www = bare.headers.get("www-authenticate") || "";
console.log("bare:", bare.status, "tempo challenge:", /method="tempo"/.test(www));
if (bare.status !== 402 || !/method="tempo"/.test(www)) { console.error("NOT PROVEN: no tempo challenge on the route (TEMPO_API_KEY unset on prod, or the route is EVM-only)"); process.exit(1); }
const ch = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })).find((c) => c.method === "tempo");
const credential = await client.createCredential(new Response(null, { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(ch) } }));
const paid = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Authorization: credential, ...hb() }, body });
const out = await paid.json().catch(() => ({}));
const rc = paid.headers.get("payment-receipt");
console.log("paid:", paid.status, JSON.stringify(out?.receipt || out).slice(0, 400));
// The PAYLOAD is the point: print what the seller returned (an excerpt) and
// check it is the page we asked for, not just "an object came back".
const resultText = JSON.stringify(out?.result ?? null);
console.log("result excerpt:", resultText.slice(0, 600));
const expectText = process.env.EXPECT_TEXT || "Example Domain";
const payloadOk = resultText.includes(expectText);
console.log(`result contains ${JSON.stringify(expectText)}:`, payloadOk, `(result ${resultText.length} chars)`);
console.log("our Payment-Receipt:", rc ? Receipt.deserialize(rc).status : null, "X-Tollbooth-Error/problem:", paid.headers.get("x-tollbooth-error") || (out && out.problem ? JSON.stringify(out.problem).slice(0, 200) : null));
const r = out?.receipt || {};
// Keep the REAL response for the announcement card (router-receipt-card.js
// renders receipt + a sha256 over result); the workflow uploads it as an artifact.
try { const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.RESPONSE_OUT || "tempo-sor-response.json", JSON.stringify(out)); } catch { /* best-effort */ }
await new Promise((res) => setTimeout(res, 4000));
const after = await usdce(SPENDER);
console.log(`spending wallet USDC.e after: ${after} (delta ${before != null && after != null ? (after - before).toFixed(6) : "?"}); receipt:`, JSON.stringify(r).slice(0, 400));
const ok = paid.status === 200 && r.external === true && r.wire === "mpp" && r.settleNetwork === "eip155:4217" && /^0x[0-9a-f]{64}$/i.test(r.settleTx || "")
  && out.result && typeof out.result === "object" && payloadOk && before != null && after != null && before - after >= Number(r.underlyingPriceUsd || 0) - 1e-6 && before - after > 0;
if (ok) console.log(`PROVEN: Tempo buyer -> route-execute -> external MPP seller ${r.seller} paid from the spending wallet (seller ${r.underlyingPriceUsd} USDC.e, tx https://explore.tempo.xyz/tx/${r.settleTx}); payload delivered (${resultText.length} chars, contains ${JSON.stringify(expectText)})`);
else console.error("NOT PROVEN");
process.exit(ok ? 0 : 1);
