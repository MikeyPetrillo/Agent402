// A refused payment says WHY, on the 402 itself.
//
// @x402/express answers `res.status(402).json({})` and discards the reason, so
// a buyer refused before the facilitator learns nothing and retries the same
// bytes forever. Measured 2026-08-29: one client sent a payment header to
// /api/render ~9 times a minute for twelve hours - ~2,100 attempts, every one
// answered `402 {}`.
//
// Locks the classifier's verdicts, that it stays QUIET when it cannot be sure
// (a wrong reason is worse than none, and the facilitator's own hint is the
// better answer once a payment gets that far), and the wire behaviour through
// the real server: a bare 402 is untouched, a refused one carries reason/hint.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { classifyPaymentRejection, unclassifiedPaymentShape } from "../src/payment-reject.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const accept = (over = {}) => ({
  scheme: "exact", network: "eip155:8453", amount: "20000", payTo: PAY_TO,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, ...over,
});
const required = (accepts) => b64({ x402Version: 2, accepts });
const NOW = 1_800_000_000;
const payment = (over = {}, auth = {}) => b64({
  x402Version: 2, scheme: "exact", network: "eip155:8453",
  payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "33".repeat(32) , ...auth }, signature: "0x" + "44".repeat(65) },
  ...over,
});
const classify = (p, r = required([accept()])) => classifyPaymentRejection({ paymentHeader: p, paymentRequiredHeader: r, nowSec: NOW });

// ---- verdicts ----
ok(classify("!!!not base64!!!")?.reason === "malformed-header", "an undecodable header is named, not swallowed");
ok(classify(payment({ x402Version: 1 }))?.reason === "version-mismatch",
  "a client on an older x402 version is told so (the leading hypothesis for the render loop)");
ok(classify(payment({ scheme: "upto" }))?.reason === "unsupported-scheme", "a scheme this route does not sell is named, with what is offered");
ok(classify(payment({ network: "eip155:1" }))?.reason === "unsupported-network", "a chain this route does not sell is named");
ok(classify(payment({}, { validBefore: String(NOW - 1) }))?.reason === "authorization-expired", "an expired authorization is distinguished from a bad one");
ok(classify(payment({}, { value: "1" }))?.reason === "amount-below-price", "an underpaying authorization is named with both amounts");
ok(classify(payment({}, { to: "0x" + "99".repeat(20) }))?.reason === "wrong-recipient", "paying the wrong address is named");
const stale = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453", accepted: accept({ amount: "10000" }),
  payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "33".repeat(32) }, signature: "0x" + "44".repeat(65) } });
ok(classify(stale)?.reason === "requirements-mismatch", "a payload built against stale requirements is named, with the differing field");

// The case the /api/render loop was actually in (2026-08-30): every field
// correct, no `accepted` block, refused before the facilitator, bare 402. The
// first cut of this classifier said nothing about it, because it only looked
// at `accepted` when it was present - so the one payload shape it was written
// to diagnose was the one it stayed silent on. Reproduced against prod first.
const noAccepted = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453",
  payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "77".repeat(32) }, signature: "0x" + "44".repeat(65) } });
ok(classify(noAccepted)?.reason === "missing-accepted",
  "a payload with NO accepted block is named - x402 matches on what the payment echoes back, so it matched nothing");
ok(/PAYMENT-REQUIRED/.test(classify(noAccepted)?.detail || ""), "and the fix names the header to copy it from");

// x402 deep-equals the echoed entry against the advertised one, so an EXTRA
// field a client adds is refused exactly like a wrong value. The first two
// revisions of this classifier walked only OUR keys and could not see that -
// which is how it stayed silent on a live client twice running. Reproduced
// against prod before the fix: an accepted with one surplus key -> bare 402.
const withExtra = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453",
  accepted: { ...accept(), surplus: "added-by-the-client" },
  payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "88".repeat(32) }, signature: "0x" + "44".repeat(65) } });
const extraV = classify(withExtra);
ok(extraV?.reason === "requirements-mismatch", `an accepted with an EXTRA field is named (got ${extraV?.reason})`);
ok(/surplus/.test(extraV?.detail || ""), "and the surplus field is named, so the caller knows what to drop");
const missing = { ...accept() }; delete missing.maxTimeoutSeconds;
const withMissing = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453", accepted: missing,
  payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "99".repeat(32) }, signature: "0x" + "44".repeat(65) } });
ok(/maxTimeoutSeconds/.test(classify(withMissing)?.detail || ""), "a MISSING field is named too - the comparison is a union, not a one-way walk");

// WHICH field differs, carried to telemetry as names. The live client's flush
// came back "requirements-mismatch" with no indication of what it was actually
// getting wrong - the class without the diagnosis. Names only, same rule as
// the unclassified shape.
{
  const bad = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453",
    accepted: { ...accept(), amount: "999999", surplus: "added" },
    payload: { authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: "20000", validAfter: "0", validBefore: String(NOW + 300), nonce: "0x" + "ab".repeat(32) }, signature: "0x" + "44".repeat(65) } });
  const v = classify(bad);
  ok(v?.reason === "requirements-mismatch", "still classified");
  ok(Array.isArray(v?.fields) && v.fields.includes("amount") && v.fields.includes("surplus"),
    `the differing field NAMES ride along for telemetry (${JSON.stringify(v?.fields)})`);
  ok(!JSON.stringify(v.fields).includes("999999") && !JSON.stringify(v.fields).includes(PAY_TO),
    "and never a value - not the amount, not the address");
  ok(v.fields.length <= 6, "bounded, so it cannot inflate the rollup key space");
}

// When we refuse but cannot say why, record the SHAPE - key names only. Three
// classifier revisions each reproduced a live 402 loop's symptom and none was
// the client's real payload, so the next unclassified refusal has to answer
// itself rather than cost another guess-and-deploy cycle.
{
  const secretish = b64({ x402Version: 2, scheme: "exact", network: "eip155:8453",
    accepted: { amount: "20000", asset: "0xASSET", payTo: PAY_TO },
    payload: { authorization: { from: "0xFROMSECRET", to: PAY_TO, value: "20000", nonce: "0xNONCEVALUE" }, signature: "0xSIGNATUREVALUE" } });
  const shape = unclassifiedPaymentShape(secretish);
  ok(/^p:/.test(shape) && shape.includes("|a:") && shape.includes("|z:"), `shape reports all three levels (${shape})`);
  ok(shape.includes("accepted") && shape.includes("payTo") && shape.includes("nonce"), "it names the KEYS present, which is the diagnostic");
  ok(!/SECRET|NONCEVALUE|SIGNATUREVALUE|0x/.test(shape),
    "and never a VALUE - no signature, nonce, address or amount ever reaches telemetry");
  ok(unclassifiedPaymentShape("!!!not-base64!!!") === null, "an undecodable header yields no shape rather than junk");
  ok(unclassifiedPaymentShape(b64({ a: 1 }), { maxChars: 12 }).length <= 12, "bounded, so it cannot inflate the rollup key space");
}

// ---- silence where it cannot be sure ----
// Genuinely sound means it also ECHOES the requirements back - a payload
// without `accepted` is refused by x402 itself, so calling that "sound" was
// the test's own mistake, found when missing-accepted was added.
const sound = payment({ accepted: accept() });
ok(classify(sound) === null, "a sound payload gets NO invented reason - the facilitator's hint is the better answer");
ok(classifyPaymentRejection({ paymentHeader: sound, paymentRequiredHeader: null }) === null, "no advertised accepts to compare against -> stays quiet");
ok(classifyPaymentRejection({}) === null, "no payment header at all -> not our case");
for (const junk of [undefined, "", "e30=", b64({}), b64([1, 2]), b64({ payload: null })]) {
  if (classifyPaymentRejection({ paymentHeader: junk, paymentRequiredHeader: required([accept()]), nowSec: NOW })?.reason === undefined) pass++;
}
ok(true, "every junk shape either names a reason or returns null - never throws");

// ---- the wire ----
const [PORT, FAC_PORT] = await (async () => [await getFreePort(), await getFreePort()])();
const B = `http://127.0.0.1:${PORT}`;
// A stub facilitator, so the paywall actually mounts. It is never reached by
// these cases - that is the whole point: they are refused before it.
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    res.end(JSON.stringify({ isValid: true, success: true }));
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));
const done = (code) => { proc?.kill("SIGKILL"); facilitator.close(); process.exit(code); };
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: PAY_TO, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    PAYMENT_NETWORKS: "base", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", X402_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  const bare = await fetch(`${B}/api/uuid`);
  const bareBody = await bare.json().catch(() => ({}));
  ok(bare.status === 402 && !bareBody.reason && !bareBody.hint,
    "a bare unpaid 402 is untouched - only a REFUSED payment gets an explanation");

  const refused = await fetch(`${B}/api/uuid`, { headers: { "X-PAYMENT": "!!!not base64!!!" } });
  const rb = await refused.json();
  ok(refused.status === 402, `a refused payment is still a 402 (got ${refused.status})`);
  ok(rb.reason === "malformed-header" && typeof rb.hint === "string" && rb.hint.length > 20,
    `the 402 body now carries the reason and a fix (reason=${rb.reason})`);
  ok(typeof rb.retry === "string", `and a machine-readable retry verb (retry=${rb.retry})`);
  ok(refused.headers.get("retry-after") === "5", "plus a Retry-After, so a loop slows down");
  ok(!!refused.headers.get("payment-required"), "the accepts offer is still on the same response");

  console.log(`\nPASS - ${pass} checks (payment rejection is explained)`);
  done(0);
} catch (e) { fail(e?.stack || String(e)); }
