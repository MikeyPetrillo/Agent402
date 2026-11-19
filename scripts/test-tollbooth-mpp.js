// agent402-tollbooth: x402 middleware mode + MPP, end to end and offline.
//
// Boots an Express app behind createTollbooth({ x402: paymentMiddleware(...) })
// with a REAL @x402/express v2 middleware pointed at a local stub facilitator,
// then drives:
//   - a REAL mppx client (the MPP reference implementation) over the native
//     MPP wire: 402 + WWW-Authenticate: Payment -> EIP-3009 credential ->
//     Authorization: Payment -> tollbooth mpp.js -> PAYMENT-SIGNATURE ->
//     @x402/express verify + (after the handler) settle -> 200 + Payment-Receipt
//   - a REAL @x402/fetch v2 client through the lifted PAYMENT-REQUIRED header
//   - a tampered credential, an expired-then-fresh 402, and the PoW-first rule
//
// Two things this pins that the package never had before 0.7.0:
//   1. SETTLEMENT ACTUALLY HAPPENS. @x402/express v2 settles after the handler
//      ends the response; the old x402VerifierFromExpress handed it a stub
//      response the real handler never ended, so it granted on verify and never
//      settled (served, never charged). Here the stub facilitator COUNTS
//      settles, and every paid 200 must produce exactly one.
//   2. The tollbooth's own dependency-free MPP codec is byte-compatible with the
//      reference client: mppx's Challenge.verify() agrees with our HMAC id
//      binding, and its signed credential round-trips through our translator
//      into a payload the middleware deep-equals against its own requirements.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Challenge, Credential, Receipt } from "mppx";
import { Fetch as MppFetch, evm } from "mppx/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";
import { createTollbooth } from "../tollbooth/index.js";

let pass = 0;
let facilitator = null; let app = null;
const fail = (m) => { console.error("FAIL:", m); try { facilitator?.close(); app?.close(); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const PAYTO = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"ab".repeat(32)}`;
const SECRET = "tollbooth-test-secret";

// ---- stub facilitator: counts verify/settle, never checks signatures ----
const facCalls = { verify: [], settle: [] };
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/verify") { facCalls.verify.push(parsed); return reply({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    if (req.url === "/settle") { facCalls.settle.push(parsed); return reply({ success: true, transaction: TX, network: "eip155:8453", payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

// ---- the operator's stack: @x402/express v2, exact USDC on Base, every GET ----
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FAC })).register("eip155:8453", new ExactEvmScheme());
const x402mw = paymentMiddleware(
  { "GET /*": { accepts: [{ scheme: "exact", network: "eip155:8453", price: "$0.001", payTo: PAYTO }], description: "tollbooth-gated page", mimeType: "application/json" } },
  resourceServer,
);

const gate = createTollbooth({ mode: "all", payTo: PAYTO, price: "$0.001", network: "eip155:8453", x402: x402mw, powSecret: SECRET, mppSecret: SECRET });
const e = express();
e.use(gate);
e.get("/page", (_req, res) => res.json({ page: "paid content", n: 42 }));
app = e.listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
const B = `http://127.0.0.1:${app.address().port}`;

// ---- 1. the 402: gate body + lifted PAYMENT-REQUIRED + MPP challenge ----
const r402 = await fetch(`${B}/page`);
ok(r402.status === 402, "unpaid GET -> 402");
const body402 = await r402.json();
ok(body402.error === "Payment Required" && body402.proofOfWork && Array.isArray(body402.accepts), "402 keeps the tollbooth body contract (accepts + proofOfWork + message)");
const pr = r402.headers.get("payment-required");
ok(!!pr, "402 carries the middleware's PAYMENT-REQUIRED header (lifted verbatim, so stock x402 v2 clients can pay)");
const advertised = JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts.find((a) => a.network === "eip155:8453");
ok(advertised?.payTo === PAYTO && advertised.scheme === "exact", "lifted requirements are the middleware's own");
const www = r402.headers.get("www-authenticate");
ok(!!www && /^Payment /i.test(www), "402 gains WWW-Authenticate: Payment (MPP challenge)");
const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www }));
const ch = challenges.find((c) => c.method === "evm" && c.intent === "charge");
ok(!!ch, `mppx parses our dependency-free challenge (${challenges.length} challenge/s, evm/charge present)`);
ok(Challenge.verify(ch, { secretKey: SECRET }), "mppx Challenge.verify agrees with our HMAC id binding (same secret)");
ok(ch.request.amount === advertised.amount && ch.request.recipient === PAYTO && ch.request.currency === advertised.asset && ch.request.methodDetails.chainId === 8453,
  "challenge request mirrors the advertised accepts entry (amount, recipient, currency, chainId)");
ok(Date.parse(ch.expires) > Date.now(), "challenge carries a future expires");
ok(facCalls.verify.length === 0 && facCalls.settle.length === 0, "issuing a 402 touched the facilitator zero times");

// ---- 2. a stock mppx client buys over the native MPP wire ----
const account = privateKeyToAccount(generatePrivateKey());
const mppFetch = MppFetch.from({ methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
const paid = await mppFetch(`${B}/page`);
ok(paid.status === 200, `mppx native buy -> 200 (got ${paid.status})`);
const paidBody = await paid.json();
ok(paidBody.page === "paid content" && paidBody.n === 42, "the real handler's body reached the buyer");
ok(paid.headers.get("x-tollbooth-paid") === "mpp", "X-Tollbooth-Paid: mpp");
const receiptHdr = paid.headers.get("payment-receipt");
ok(!!receiptHdr, "settled response carries MPP Payment-Receipt");
const receipt = Receipt.deserialize(receiptHdr);
ok(receipt.method === "evm" && receipt.status === "success" && receipt.reference === TX, "Payment-Receipt: evm/success/reference = settle tx");
ok(!!paid.headers.get("payment-response"), "and still carries x402 PAYMENT-RESPONSE (settlement authority untouched)");
ok(facCalls.verify.length === 1 && facCalls.settle.length === 1, `exactly one verify + ONE SETTLE for the MPP buy (got ${facCalls.verify.length}/${facCalls.settle.length}) - the middleware settled after the handler`);
const sent = facCalls.settle[0];
ok(isDeepStrictEqual(sent.paymentPayload.accepted, sent.paymentRequirements), "translated payload.accepted deep-equals the middleware's matched requirements (byte-exact echo)");
const auth = sent.paymentPayload.payload.authorization;
ok(auth.from.toLowerCase() === account.address.toLowerCase() && auth.to.toLowerCase() === PAYTO.toLowerCase() && auth.value === advertised.amount, "authorization: buyer -> payTo for the advertised amount");
const sigValid = await verifyTypedData({
  address: account.address,
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
  signature: sent.paymentPayload.payload.signature,
});
ok(sigValid, "the relayed EIP-712 signature verifies against Base USDC's real domain (a real facilitator would accept it)");

// ---- 3. a stock @x402/fetch v2 client buys through the lifted header ----
const x402c = new x402Client(); registerExactEvmScheme(x402c, { signer: privateKeyToAccount(generatePrivateKey()) });
const payFetch = wrapFetchWithPayment(fetch, x402c);
const paidX = await payFetch(`${B}/page`);
ok(paidX.status === 200, `x402 v2 client buy -> 200 (got ${paidX.status})`);
ok(paidX.headers.get("x-tollbooth-paid") === "x402", "X-Tollbooth-Paid: x402");
ok(!paidX.headers.get("payment-receipt"), "an x402 buyer gets no MPP receipt (pass-through, no cross-talk)");
ok(facCalls.settle.length === 2, `the x402 buy settled too (settles=${facCalls.settle.length}) - the free-ride class is closed`);

// ---- 4. tampered credential -> fresh 402, facilitator untouched ----
const cred = await (async () => {
  // Build a real credential, then flip one character inside the challenge id.
  const { Mppx } = await import("mppx/client");
  const c = Mppx.create({ methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })], polyfill: false });
  const fresh = await fetch(`${B}/page`);
  return c.createCredential(fresh);
})();
const wire = JSON.parse(Buffer.from(cred.slice("Payment ".length), "base64url").toString("utf8"));
wire.challenge.id = wire.challenge.id.slice(0, -2) + (wire.challenge.id.endsWith("AA") ? "BB" : "AA");
const tampered = `Payment ${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
const before = { v: facCalls.verify.length, s: facCalls.settle.length };
const rt = await fetch(`${B}/page`, { headers: { Authorization: tampered } });
ok(rt.status === 402 && /^Payment /i.test(rt.headers.get("www-authenticate") || ""), "tampered challenge id -> 402 with fresh challenges");
ok(facCalls.verify.length === before.v && facCalls.settle.length === before.s, "a tampered credential never reaches the facilitator");

// ---- 5. proof-of-work is still checked FIRST and never touches the facilitator ----
const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } let x = b; while ((x & 0x80) === 0) { n++; x <<= 1; } break; } return n; };
const solve = (chal, diff) => { let n = 0; while (lz(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };
const q = await (await fetch(`${B}/page`)).json();
const sol = `${q.proofOfWork.token}:${solve(q.proofOfWork.challenge, q.proofOfWork.difficulty)}`;
const before2 = { v: facCalls.verify.length, s: facCalls.settle.length };
const rp = await fetch(`${B}/page`, { headers: { "X-Pow-Solution": sol } });
ok(rp.status === 200 && rp.headers.get("x-tollbooth-paid") === "pow", "a solved proof-of-work still passes free (X-Tollbooth-Paid: pow)");
ok(facCalls.verify.length === before2.v && facCalls.settle.length === before2.s, "PoW path never touches the facilitator");

// ---- 6. stats attribute the wires separately ----
const st = gate.stats();
ok(st.mppPaid === 1 && st.x402Paid === 1 && st.powSolved === 1, `stats: mppPaid=${st.mppPaid} x402Paid=${st.x402Paid} powSolved=${st.powSolved}`);

// ---- 7. MPP off (x402 middleware without mpp) -> no challenge, x402 still works ----
const gate2 = createTollbooth({ mode: "all", payTo: PAYTO, x402: x402mw, mpp: false, powSecret: SECRET });
const e2 = express(); e2.use(gate2); e2.get("/p", (_q, r) => r.json({ ok: 1 }));
const app2 = e2.listen(0, "127.0.0.1"); await new Promise((r) => app2.once("listening", r));
const r2 = await fetch(`http://127.0.0.1:${app2.address().port}/p`);
ok(r2.status === 402 && !r2.headers.get("www-authenticate") && !!r2.headers.get("payment-required"), "mpp:false -> no MPP challenge, PAYMENT-REQUIRED still lifted");
app2.close();

// ---- 8. the deprecated verifier really is a free ride with a v2 middleware ----
// Not a regression test - a MEASUREMENT of the claim in the deprecation notice,
// so the README's warning stays true against the installed @x402/express.
const { x402VerifierFromExpress } = await import("../tollbooth/index.js");
const gate3 = createTollbooth({ mode: "all", payTo: PAYTO, verifyX402: x402VerifierFromExpress(x402mw, { timeoutMs: 5000 }), pow: false });
const e3 = express(); e3.use(gate3); e3.get("/p", (_q, r) => r.json({ ok: 1 }));
const app3 = e3.listen(0, "127.0.0.1"); await new Promise((r) => app3.once("listening", r));
const before3 = { v: facCalls.verify.length, s: facCalls.settle.length };
// The old gate emits no PAYMENT-REQUIRED header, so a v2 client cannot even
// negotiate; hand it a credential signed for the middleware's requirements.
const x402c3 = new x402Client(); registerExactEvmScheme(x402c3, { signer: privateKeyToAccount(generatePrivateKey()) });
const sig3 = await x402c3.createPaymentPayload({ x402Version: 2, accepts: [advertised], resource: { url: `${B}/page` } }).catch(() => null);
if (sig3) {
  const enc = Buffer.from(JSON.stringify(sig3)).toString("base64");
  const r3 = await fetch(`http://127.0.0.1:${app3.address().port}/p`, { headers: { "PAYMENT-SIGNATURE": enc } });
  await new Promise((r) => setTimeout(r, 300));
  ok(r3.status === 200, "legacy x402VerifierFromExpress + v2 middleware: request is GRANTED (verify passed)");
  ok(facCalls.verify.length === before3.v + 1 && facCalls.settle.length === before3.s, `...and NEVER SETTLED (verify +${facCalls.verify.length - before3.v}, settle +${facCalls.settle.length - before3.s}) - the free ride the deprecation notice describes`);
} else {
  console.log("  note: could not build a v2 payload for the legacy path on this client version; skipping the measurement");
}
app3.close();

facilitator.close(); app.close();
console.log(`\nAll ${pass} assertions passed`);
process.exit(0);
