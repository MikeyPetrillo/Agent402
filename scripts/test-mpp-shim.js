// MPP dual-stack shim round trip, fully offline: boots the real server with
// the x402 paywall ACTIVE plus a local stub facilitator, then drives a REAL
// mppx client (the MPP reference implementation) through the native MPP wire:
//
//   402 + WWW-Authenticate: Payment  →  client signs EIP-3009  →
//   Authorization: Payment  →  shim → PAYMENT-SIGNATURE → @x402/express
//   verify+settle (stub)  →  200 + PAYMENT-RESPONSE → shim → Payment-Receipt
//
// The stub facilitator never checks signatures, so the test verifies the
// client's EIP-712 signature itself (viem verifyTypedData against Base USDC's
// real domain) — proving a production facilitator would accept the exact same
// payload. Also locks: pass-through for plain x402 buyers (no receipt), a
// single verify + single settle per purchase (no double-settle), HMAC tamper
// and expiry rejection in the translator.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { Challenge, Credential, PaymentRequest, Receipt, x402 } from "mppx";
import { Fetch, Mppx as MppClient, evm } from "mppx/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";
import { translateCredential, translateCredentialDetailed, challengeHeaderFromPaymentRequired } from "../src/mpp-shim.js";

const PORT = 3077;
const FAC_PORT = 3078;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mpp-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"ab".repeat(32)}`;

let pass = 0;
let proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub facilitator: records every verify/settle body ----
const facCalls = { verify: [], settle: [] };
facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") {
      return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    }
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/verify") {
      facCalls.verify.push(parsed);
      return reply({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from });
    }
    if (req.url === "/settle") {
      facCalls.settle.push(parsed);
      return reply({ success: true, transaction: TX, network: "eip155:8453", payer: parsed.paymentPayload?.payload?.authorization?.from });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    MPP_SECRET_KEY: SECRET,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  // ---- 1. The 402 carries BOTH wires, and the MPP challenge is spec-sound ----
  const r402 = await fetch(`${B}/api/uuid`);
  ok(r402.status === 402, "unpaid catalog GET -> 402");
  const prHeader = r402.headers.get("payment-required");
  ok(!!prHeader, "402 still carries x402 PAYMENT-REQUIRED (no regression)");
  const wwwAuth = r402.headers.get("www-authenticate");
  ok(!!wwwAuth && /^Payment /i.test(wwwAuth.trim()), "402 gains WWW-Authenticate: Payment (MPP challenge)");

  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }));
  ok(challenges.length >= 1, `WWW-Authenticate parses via mppx (${challenges.length} challenge/s)`);
  const ch = challenges.find((c) => c.method === "evm" && c.intent === "charge");
  ok(!!ch, "an evm/charge challenge is offered");
  ok(Challenge.verify(ch, { secretKey: SECRET }), "challenge id HMAC-verifies (spec challenge binding)");
  ok(Date.parse(ch.expires) > Date.now(), "challenge carries a future expires");
  const meta = Challenge.meta(ch) ?? (ch.opaque ? PaymentRequest.deserialize(ch.opaque) : undefined);
  const advertised = x402.Header.decodePaymentRequiredEnvelope(prHeader).accepts
    .find((a) => a.network === "eip155:8453");
  ok(JSON.stringify(JSON.parse(meta.x402)) === JSON.stringify(advertised),
    "challenge meta carries the advertised accepts entry verbatim");
  ok(ch.request.amount === advertised.amount && ch.request.recipient === advertised.payTo
    && ch.request.currency === advertised.asset && ch.request.methodDetails.chainId === 8453,
    "native ChargeRequest mirrors the accepts entry");

  // Baseline stats BEFORE any buy — the local stats DB persists across runs,
  // so the wire-attribution check below asserts DELTAS, not absolutes.
  const statsBefore = await (await fetch(`${B}/api/stats`)).json();

  // ---- 2. A stock mppx client buys the tool over the native MPP wire ----
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const mppFetch = Fetch.from({
    methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })],
  });
  const paid = await mppFetch(`${B}/api/uuid`);
  ok(paid.status === 200, `mppx client native buy -> 200 (got ${paid.status})`);
  const paidBody = await paid.json();
  ok(Array.isArray(paidBody.uuids) && paidBody.uuids[0]?.length === 36, "tool answered (uuids in body)");
  ok(!!paid.headers.get("payment-response"), "settled response still carries x402 PAYMENT-RESPONSE");
  const receiptHeader = paid.headers.get("payment-receipt");
  ok(!!receiptHeader, "settled response carries MPP Payment-Receipt");
  const receipt = Receipt.deserialize(receiptHeader);
  ok(receipt.status === "success" && receipt.method === "evm" && receipt.reference === TX,
    "Payment-Receipt: status success, method evm, reference = settle tx");

  // ---- 3. Settlement authority: exactly one verify + one settle, payload sound ----
  ok(facCalls.verify.length === 1 && facCalls.settle.length === 1,
    `exactly one facilitator verify + settle (got ${facCalls.verify.length}/${facCalls.settle.length})`);
  const sent = facCalls.settle[0];
  ok(isDeepStrictEqual(sent.paymentPayload.accepted, sent.paymentRequirements),
    "payload.accepted deep-equals the server's matched requirements");
  const auth = sent.paymentPayload.payload.authorization;
  ok(auth.from.toLowerCase() === account.address.toLowerCase(), "authorization.from is the buyer wallet");
  ok(auth.to.toLowerCase() === TREASURY.toLowerCase() && auth.value === advertised.amount,
    "authorization pays the treasury the advertised amount");
  const sigValid = await verifyTypedData({
    address: account.address,
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { from: auth.from, to: auth.to, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
    signature: sent.paymentPayload.payload.signature,
  });
  ok(sigValid, "EIP-3009 signature verifies against Base USDC's real EIP-712 domain");

  // ---- 4. Plain x402 buyers are untouched: pass-through, no MPP receipt ----
  const now = Math.floor(Date.now() / 1000);
  const xAuth = {
    from: account.address, to: TREASURY,
    value: advertised.amount, validAfter: String(now - 60), validBefore: String(now + 300),
    nonce: `0x${"11".repeat(32)}`,
  };
  const xSig = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...xAuth, value: BigInt(xAuth.value), validAfter: BigInt(xAuth.validAfter), validBefore: BigInt(xAuth.validBefore) },
  });
  const xHeader = x402.Header.encodePaymentSignature({
    x402Version: 2, accepted: advertised, payload: { authorization: xAuth, signature: xSig },
  });
  const xPaid = await fetch(`${B}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": xHeader } });
  ok(xPaid.status === 200, `plain x402 buy still works (got ${xPaid.status})`);
  ok(!xPaid.headers.get("payment-receipt"), "x402 buyer gets NO Payment-Receipt (wire isolation)");

  // ---- 4a. x402 payment-identifier extension (2026-08-19): declared on the
  // 402, honoured as an Idempotency-Key alias under the same binding rules ----
  {
    const pr = x402.Header.decodePaymentRequiredEnvelope(prHeader);
    ok(pr.extensions?.["payment-identifier"]?.info?.required === false && pr.extensions["payment-identifier"].schema, "402 declares the payment-identifier extension (optional)");
    const payId = `pay_${"e".repeat(32)}`;
    const idAuth = { ...xAuth, nonce: `0x${"55".repeat(32)}` };
    const idSig = await account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: { ...idAuth, value: BigInt(idAuth.value), validAfter: BigInt(idAuth.validAfter), validBefore: BigInt(idAuth.validBefore) },
    });
    const idHeader = x402.Header.encodePaymentSignature({
      x402Version: 2, accepted: advertised, payload: { authorization: idAuth, signature: idSig },
      extensions: { "payment-identifier": { info: { required: false, id: payId }, schema: pr.extensions["payment-identifier"].schema } },
    });
    const settlesBefore = facCalls.settle.length;
    const first = await fetch(`${B}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": idHeader } });
    const firstBody = await first.json();
    ok(first.status === 200 && first.headers.get("x-idempotent-replay") !== "true" && facCalls.settle.length === settlesBefore + 1, `x402 buy carrying a payment-identifier settles once (got ${first.status})`);
    const again = await fetch(`${B}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": idHeader } });
    const againBody = await again.json();
    ok(again.status === 200 && again.headers.get("x-idempotent-replay") === "true" && facCalls.settle.length === settlesBefore + 1 && JSON.stringify(againBody) === JSON.stringify(firstBody), "exact retry (same credential + same payment id) replays the result with NO second settle - no Idempotency-Key header needed");
    // A different credential with the same id is a NEW payment (the id is
    // client-chosen text on an unverified payload; only the exact original
    // credential can replay).
    const otherAuth = { ...xAuth, nonce: `0x${"66".repeat(32)}` };
    const otherSig = await account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: { ...otherAuth, value: BigInt(otherAuth.value), validAfter: BigInt(otherAuth.validAfter), validBefore: BigInt(otherAuth.validBefore) },
    });
    const otherHeader = x402.Header.encodePaymentSignature({
      x402Version: 2, accepted: advertised, payload: { authorization: otherAuth, signature: otherSig },
      extensions: { "payment-identifier": { info: { required: false, id: payId }, schema: pr.extensions["payment-identifier"].schema } },
    });
    const other = await fetch(`${B}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": otherHeader } });
    ok(other.status === 200 && other.headers.get("x-idempotent-replay") !== "true" && facCalls.settle.length === settlesBefore + 2, "same payment id on a DIFFERENT credential is a new payment (settles again) - never a cross-credential replay");
  }

  // ---- 4b. Body-bearing POST buy over the native MPP wire ----
  const settlesBefore = facCalls.settle.length;
  const paidPost = await mppFetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(paidPost.status === 200, `MPP native buy of a POST tool with body -> 200 (got ${paidPost.status})`);
  const postBody = await paidPost.json();
  ok(postBody.hex?.startsWith("b94d27b9"), "POST tool computed over the request body (sha256 of 'hello world')");
  ok(!!paidPost.headers.get("payment-receipt"), "POST buy carries Payment-Receipt");
  ok(facCalls.settle.length === settlesBefore + 1, "POST buy settled exactly once");

  // ---- 4c. Idempotency parity: same MPP credential + Idempotency-Key replays ----
  // The shim mounts BEFORE the idempotency middleware, so the translated
  // PAYMENT-SIGNATURE is the gate credential the cache binds to — an MPP
  // buyer who paid but lost the response replays without re-charging,
  // exactly like an x402 buyer.
  const idemClient = MppClient.create({
    methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })],
    polyfill: false,
  });
  const idemBody = JSON.stringify({ text: "idem-mpp" });
  const idem402 = await idemClient.rawFetch(`${B}/api/hash`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: idemBody,
  });
  ok(idem402.status === 402, "idempotency leg: unpaid POST -> 402");
  const idemCred = await idemClient.createCredential(
    new Response(null, { status: 402, headers: { "WWW-Authenticate": idem402.headers.get("www-authenticate") } })
  );
  const idemHeaders = { "Content-Type": "application/json", Authorization: idemCred, "Idempotency-Key": "mpp-idem-1" };
  const settlesBeforeIdem = facCalls.settle.length;
  const first = await idemClient.rawFetch(`${B}/api/hash`, { method: "POST", headers: idemHeaders, body: idemBody });
  ok(first.status === 200, `idempotency leg: first keyed MPP buy -> 200 (got ${first.status})`);
  const firstBody = await first.json();
  const retry = await idemClient.rawFetch(`${B}/api/hash`, { method: "POST", headers: idemHeaders, body: idemBody });
  ok(retry.status === 200 && retry.headers.get("x-idempotent-replay") === "true",
    `retry with SAME MPP credential + key replays without re-charging (got ${retry.status}, replay=${retry.headers.get("x-idempotent-replay")})`);
  const retryBody = await retry.json();
  ok(typeof firstBody.hex === "string" && retryBody.hex === firstBody.hex, "replay serves the original paid body");
  ok(facCalls.settle.length === settlesBeforeIdem + 1, "one settle across original + replay (never re-charged)");

  // ---- 4d. Wire attribution: /api/stats counts MPP-wire buys separately ----
  // Three MPP-wire settles so far (uuid GET, POST hash, idempotency first buy —
  // the replay is served from the cache and never reaches the tally); the
  // plain-x402 buy must NOT count. The MPP-adoption signal on /api/stats.
  const stats = await (await fetch(`${B}/api/stats`)).json();
  const dMpp = stats.toolCallsServed?.viaMPPWire - statsBefore.toolCallsServed?.viaMPPWire;
  const dUsdc = stats.toolCallsServed?.viaUSDC - statsBefore.toolCallsServed?.viaUSDC;
  ok(dMpp === 3, `stats viaMPPWire grew by exactly the MPP-wire settles (delta ${dMpp}, want 3)`);
  ok(dUsdc === 6, `stats viaUSDC grew by all USDC settles regardless of wire (delta ${dUsdc}, want 6: 3 MPP-wire + 1 plain x402 + 2 payment-identifier buys; the replay settled nothing)`);

  // ---- 5. Translator rejects tampering, wrong secret, and expiry ----
  const header402 = challengeHeaderFromPaymentRequired(prHeader, { secretKey: SECRET, realm: `localhost:${PORT}` });
  const [freshCh] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": header402 }));
  const goodCred = Credential.serialize({ challenge: freshCh, payload: {
    from: account.address, to: TREASURY, value: advertised.amount, validAfter: "0",
    validBefore: String(now + 300), nonce: `0x${"22".repeat(32)}`, signature: xSig, type: "authorization",
  } });
  ok(!!translateCredential(goodCred, { secretKey: SECRET }), "translator accepts a well-formed credential");
  ok(translateCredential(goodCred, { secretKey: "wrong-secret" }) === null, "wrong HMAC secret -> rejected");
  const tampered = Credential.serialize({
    challenge: { ...freshCh, meta: { x402: JSON.stringify({ ...advertised, payTo: account.address }) }, opaque: undefined },
    payload: { from: account.address, to: TREASURY, value: advertised.amount, validAfter: "0",
      validBefore: String(now + 300), nonce: `0x${"33".repeat(32)}`, signature: xSig, type: "authorization" },
  });
  ok(translateCredential(tampered, { secretKey: SECRET }) === null, "tampered accepts entry (payTo swap) -> HMAC rejects");
  const expired = Challenge.from({
    realm: `localhost:${PORT}`, method: "evm", intent: "charge",
    expires: new Date(Date.now() - 60_000), request: freshCh.request,
    meta: { x402: JSON.stringify(advertised) }, secretKey: SECRET,
  });
  const expiredCred = Credential.serialize({ challenge: expired, payload: {
    from: account.address, to: TREASURY, value: advertised.amount, validAfter: "0",
    validBefore: String(now + 300), nonce: `0x${"44".repeat(32)}`, signature: xSig, type: "authorization",
  } });
  ok(translateCredential(expiredCred, { secretKey: SECRET }) === null, "expired challenge -> rejected");

  // RFC 9457 on the wire (2026-08-19): a rejected MPP credential still gets the
  // paywall's 402 with fresh challenges, but the BODY is now problem+json
  // naming why, with the paymentauth.org type vocabulary mppx servers use.
  ok(translateCredentialDetailed(tampered, { secretKey: SECRET }).reject?.kind === "invalid-challenge", "detailed translator: tampered -> invalid-challenge");
  ok(translateCredentialDetailed(expiredCred, { secretKey: SECRET }).reject?.kind === "invalid-challenge" && /expired/.test(translateCredentialDetailed(expiredCred, { secretKey: SECRET }).reject.detail), "detailed translator: expired -> invalid-challenge (detail says expired)");
  ok(translateCredentialDetailed("Payment !!!not-base64url!!!", { secretKey: SECRET }).reject?.kind === "malformed-credential", "detailed translator: undecodable -> malformed-credential");
  for (const [label, cred, kind, re] of [["tampered", tampered, "invalid-challenge", /invalid/], ["expired", expiredCred, "invalid-challenge", /expired/], ["garbage", "Payment !!!not-base64url!!!", "malformed-credential", /malformed/]]) {
    const r = await fetch(`${B}/api/uuid`, { headers: { Authorization: cred } });
    const ct = r.headers.get("content-type") || "";
    const body = await r.json().catch(() => ({}));
    ok(r.status === 402 && /application\/problem\+json/.test(ct) && body.type === `https://paymentauth.org/problems/${kind}` && body.status === 402 && re.test(body.detail || ""), `wire: ${label} credential -> 402 problem+json ${kind} (got ${r.status} ${ct} ${body.type})`);
    ok(/^Payment /i.test(r.headers.get("www-authenticate") || "") && !!r.headers.get("payment-required"), `wire: ${label} rejection still carries FRESH MPP challenges and the x402 PAYMENT-REQUIRED header`);
  }
  const plain = await fetch(`${B}/api/uuid`);
  ok(plain.status === 402 && !/problem\+json/.test(plain.headers.get("content-type") || ""), "wire: a bare unpaid 402 (no credential) is NOT a problem document - only rejections are");

  console.log(`\nPASS - ${pass} checks (MPP dual-stack shim round trip)`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
