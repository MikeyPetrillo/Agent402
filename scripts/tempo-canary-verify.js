// One-off LIVE verification: a real mppx client, signed by the existing EVM
// canary burner (0x902dCf34E53695bDEA2fFB354b1a2e58bD598256 — GitHub Actions
// secret BURNER_KEY, the SAME wallet paid-canary.js already uses for its
// other EVM legs, now also funded on Tempo mainnet), makes
// ONE real purchase against agent402.tools's live tempo/charge challenge.
//
// This exists because scripts/test-mpp-tempo-shim.js only proves OUR OWN
// logic (challenge minting + settlement ordering) against injected
// validate/broadcast stubs — Tempo's real relay wire format was explicitly
// left unverified in that PR. This script was the first live proof it
// worked; a permanent "mpp-tempo" leg now also runs daily inside
// paid-canary.js (same burner, same relay). This standalone script stays
// for fast, isolated on-demand verification (workflow_dispatch) without
// waiting for or spending on the other ~33 legs.
//
// Marked synthetic via the same X-Heartbeat-Token mechanism paid-canary.js
// uses (HMAC(POW_SECRET, UTC minute)), so this doesn't pollute the sales
// ledger / PostHog settlement stream as fake external demand.
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) {
  console.error("tempo-canary-verify: no BURNER_KEY — cannot run");
  process.exit(2);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`buyer: ${account.address}`);

const secret = (process.env.POW_SECRET || "").trim();
if (!secret) console.warn("WARN  POW_SECRET not set — this buy will record as EXTERNAL demand in the sales ledger");

// autoSwap: the burner is funded in PathUSD; if prod's first tempo challenge
// quotes USDC.e (the ecosystem's currency - see TEMPO_CURRENCY in mpp-tempo.js),
// mppx swaps on Tempo's stablecoin DEX in the same signed transaction. A no-op
// while the challenge currency matches the balance.
const mppxClient = Mppx.create({ methods: [tempo.charge({ account, autoSwap: true })] });

let sawChallenge = false;
let sawCredential = false;
let credentialRounds = 0;
let paymentFailure = null;
mppxClient.onChallengeReceived(() => { sawChallenge = true; console.log("challenge received"); });
mppxClient.onCredentialCreated(() => { sawCredential = true; credentialRounds++; console.log("credential created (signed by the burner)"); });
mppxClient.onPaymentFailed((e) => {
  paymentFailure = e;
  console.error("PAYMENT FAILED event:", JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 800));
});
mppxClient.onPaymentResponse(() => console.log("payment response received"));

const headers = {};
if (secret) {
  const minute = Math.floor(Date.now() / 60_000);
  headers["X-Heartbeat-Token"] = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
}

// CANARY_CALLS (optional JSON array of {method, path, body}) buys several
// tools in one run; default is the original single /api/uuid buy. Every call
// must settle and answer 200 with a JSON body.
let calls = [{ method: "GET", path: "/api/uuid", check: (b) => Array.isArray(b?.uuids) && b.uuids.length > 0 }];
if ((process.env.CANARY_CALLS || "").trim()) {
  try {
    const parsedCalls = JSON.parse(process.env.CANARY_CALLS);
    if (!Array.isArray(parsedCalls) || !parsedCalls.length || parsedCalls.length > 10) throw new Error("need 1-10 calls");
    calls = parsedCalls.map((c) => {
      if (!/^\/(api|v1)\//.test(String(c.path || ""))) throw new Error(`path must start /api/ or /v1/: ${c.path}`);
      return { method: String(c.method || "GET").toUpperCase(), path: c.path, body: c.body, check: (b) => b && typeof b === "object" && !b.error };
    });
  } catch (e) { console.error(`FAIL: CANARY_CALLS unreadable: ${e.message}`); process.exit(2); }
}

let failed = 0;
for (const call of calls) {
  sawChallenge = false; sawCredential = false; credentialRounds = 0; paymentFailure = null;
  const init = { method: call.method, headers: { ...headers, ...(call.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}) };
  let res;
  try {
    res = await mppxClient.fetch(`${TARGET}${call.path}`, init);
  } catch (e) {
    console.error(`FAIL ${call.method} ${call.path}: fetch threw: ${e?.message || e}`); failed++; continue;
  }
  const bodyText = await res.text();
  console.log(`\n${call.method} ${call.path} -> status ${res.status}`);
  console.log(`payment-receipt header: ${res.headers.get("payment-receipt") || "(none)"}`);
  console.log(`body: ${bodyText.slice(0, 300)}`);
  let parsed = null; try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
  const why = !sawChallenge ? "never saw a 402 challenge"
    : !sawCredential ? "never created a signed credential"
    : paymentFailure ? "mppx reported a payment.failed event"
    : res.status !== 200 ? `final status ${res.status}, expected 200`
    : !res.headers.get("payment-receipt") ? "200 without a Payment-Receipt"
    : !call.check(parsed) ? "response body is not the tool's answer"
    : null;
  if (why) { console.error(`FAIL ${call.method} ${call.path}: ${why}`); failed++; continue; }
  // More than one signed credential is still a pass (one debit on-chain), but
  // not a clean one: say so, and read prod's [mpp-tempo] timing lines.
  if (credentialRounds > 1) console.warn(`WARN  ${call.path} settled only on credential round ${credentialRounds}`);
  console.log(`OK ${call.method} ${call.path} settled over tempo`);
}
if (failed) { console.error(`\nFAIL: ${failed} of ${calls.length} call(s) did not settle and answer`); process.exit(1); }
console.log(`\nPASS — ${calls.length} real Tempo settlement round trip(s) confirmed live against production.`);
