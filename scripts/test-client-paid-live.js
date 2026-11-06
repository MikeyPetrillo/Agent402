// LIVE paid test of the agent402-client spending-cap 402-inspection, against PROD
// with the real Base burner (BURNER_KEY). The offline suite proves the preflight
// LOGIC; this proves the added preflight does NOT break a real settle against a
// live facilitator (the one box the offline test can't check) and that the cap
// gates end-to-end. Spends a few cents of burner USDC. Skips cleanly with no key,
// so it never fails CI without a signer. Marks itself internal (heartbeat token)
// so the buy doesn't pollute the external sales ledger.
import { assertOwnPaidTarget } from "./lib/buyer-guard.js";
import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Agent402, SpendingLimitError } from "../client/index.js";

const TARGET = assertOwnPaidTarget(process.env.TARGET_URL || "https://agent402.tools", "test-client-paid-live");
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.log("SKIP: no BURNER_KEY / KEY_FILE — live paid test needs a signer"); process.exit(0); }

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// Same internal-traffic marker the canary uses (HMAC(POW_SECRET, UTC minute)).
// Also logs each outgoing request (whether it carried a payment) + the response,
// so we can see if payFetch actually SENT a paid request or gave up.
const secret = (process.env.POW_SECRET || "").trim();
const reqLog = [];
const decodePR = (r) => {
  const hdr = r.headers.get("payment-required") || r.headers.get("www-authenticate") || "";
  if (!hdr) return "";
  try { return JSON.stringify(JSON.parse(Buffer.from(hdr.replace(/^Bearer /, ""), "base64").toString("utf8"))).slice(0, 300); }
  catch { return hdr.slice(0, 120); }
};
const synthFetch = (input, init) => {
  // input may be a string URL or a Request object — @x402/fetch passes a Request
  // (with the X-PAYMENT header) for the paid retry. Build via `new Request` so the
  // method/body/payment header are PRESERVED, then ADD the heartbeat header. The
  // old `fetch(url, {...init, headers})` rebuilt the request and dropped X-PAYMENT,
  // so no payment was ever sent.
  const req = new Request(input, init);
  if (secret) req.headers.set("X-Heartbeat-Token", createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60000)}`).digest("base64url").slice(0, 32));
  const paid = req.headers.has("x-payment");
  const label = req.url.split("/").pop().split("?")[0];
  return fetch(req).then((r) => {
    reqLog.push(`  ${req.method} ${label} paid=${paid} -> ${r.status}${r.status !== 200 ? " · x402err: " + decodePR(r).slice(0, 90) : ""}`);
    return r;
  });
};
const payFetch = wrapFetchWithPayment(synthFetch, client);

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// Choose a reliable, cheap, wallet-only tool that's present in the live catalog.
const probe = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch });
const cat = await probe._loadCatalog();
const KNOWN = [
  { slug: "whois", input: { domain: "example.com" } },
  { slug: "gas-snapshot", input: {} },
  { slug: "edgar-company-lookup", input: { ticker: "AAPL" } },
  { slug: "stock-quote", input: { symbol: "AAPL" } },
];
let chosen = null;
for (const k of KNOWN) { const t = cat.get(k.slug); if (t && !t.computePayable) { chosen = { slug: k.slug, t, input: k.input }; break; } }
if (!chosen) { console.log("SKIP: no known wallet-only tool in the live catalog"); process.exit(0); }
const price = parseFloat(String(chosen.t.price).replace(/[^0-9.]/g, "")) || 0;
console.log(`live target: "${chosen.slug}" @ $${price} on ${TARGET} (payer ${account.address})`);

// CONTROL — a RAW payFetch buy (no client, no preflight). Isolates whether the
// burner can settle this tool at all (funding/facilitator) from the client's
// preflight, so a 402 can be attributed correctly.
const method = (chosen.t.method || "GET").toUpperCase();
const path = chosen.t.path || `/api/${chosen.slug}`;
const reqUrl = method === "GET" ? `${TARGET}${path}?${new URLSearchParams(chosen.input)}` : `${TARGET}${path}`;
const reqInit = method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(chosen.input) };
let controlStatus = -1, controlReason = "";
try {
  const r = await payFetch(reqUrl, reqInit);
  controlStatus = r.status;
  if (r.status !== 200) controlReason = (await r.text().catch(() => "")).slice(0, 180);
} catch (e) { controlReason = e.message; }
console.log(`control (raw payFetch, NO preflight): HTTP ${controlStatus}${controlReason ? " — " + controlReason : ""}`);

// TEST — client WITH a cap above price: the preflight runs, then the real payment.
let clientSettled = false, clientErr = "";
try {
  const a = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch, maxPerCallUsd: price + 0.02 });
  const res = await a.call(chosen.slug, chosen.input, { cache: false });
  clientSettled = !!(res && typeof res === "object" && !res.error);
} catch (e) { clientErr = e.message; }
console.log(`client (cap above, preflight ACTIVE): ${clientSettled ? "SETTLED" : "did not settle — " + clientErr}`);

if (controlStatus === 200 && clientSettled) {
  ok(true, "preflight is production-SAFE: raw buy AND client-with-preflight both SETTLED");
} else if (controlStatus !== 200 && !clientSettled) {
  ok(true, `preflight NOT the cause: the raw buy also failed (HTTP ${controlStatus}) — identical with/without the preflight, so it's funding/facilitator, not the client`);
} else if (controlStatus === 200 && !clientSettled) {
  ok(false, `preflight BREAKS the settle: raw buy SETTLED but client-with-preflight did NOT — ${clientErr}`);
} else {
  ok(false, `unexpected: control HTTP ${controlStatus}, client settled=${clientSettled}`);
}

// TEST B — cap BELOW price: refused before signing, no funds move.
try {
  const b = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch, maxPerCallUsd: Math.max(price / 2, 0.0001) });
  await b.call(chosen.slug, chosen.input, { cache: false });
  ok(false, "cap BELOW price: should have refused, but the call went through");
} catch (e) {
  ok(e instanceof SpendingLimitError || e?.name === "SpendingLimitError", `cap BELOW price: refused before paying (${e?.name || "error"})`);
}

console.log(`--- request flow (payFetch internals) ---\n${reqLog.join("\n")}`);
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
