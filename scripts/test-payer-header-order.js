// The payment-header precedence is a SECURITY BOUNDARY.
//
// @x402/express settles from `payment-signature` first, falling back to
// `x-payment`, and @x402/core puts PAYMENT-SIGNATURE on the wire. Our
// attribution read them in the OPPOSITE order, so a request carrying both was
// settled from one header and attributed from the other — and the second copy
// is never signature-checked by anything.
//
// The attack that made this urgent: pay with your own valid PAYMENT-SIGNATURE,
// add `X-Payment: base64({"payload":{"authorization":{"from":"<victim>"}}})`,
// and every consumer of payerFromRequest believes the victim paid. Memory
// namespaces are wallet-keyed ("payment = identity"), so that was a namespace
// takeover for the price of one call.
//
// This file pins the ordering against the INSTALLED middleware, so a future
// dependency bump that flips it fails CI instead of silently re-opening the
// hole.
import { readFileSync, existsSync } from "node:fs";
import { payerFromRequest, paymentHeaderOf } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const auth = (from) => b64({ payload: { authorization: { from } } });
// EVM addresses are normalised to lowercase by payerFromRequest — deliberate,
// and EVM-only (base58/base32 rails are case-SENSITIVE and must never be
// folded). Compare against the normalised form.
const ATTACKER = "0xAAAA000000000000000000000000000000000001";
const VICTIM = "0xBBBB000000000000000000000000000000000002";
const norm = (a) => a.toLowerCase();
const reqWith = (headers) => ({ header: (n) => headers[String(n).toLowerCase()] ?? undefined });

// 1. THE ATTACK. Both headers present, disagreeing. Attribution must follow the
//    one the middleware actually settles: payment-signature.
{
  const req = reqWith({ "payment-signature": auth(ATTACKER), "x-payment": auth(VICTIM) });
  const who = payerFromRequest(req);
  ok(who === norm(ATTACKER), `both headers -> attributed to the SETTLED payer (${who})`);
  ok(who !== norm(VICTIM) && who !== VICTIM, "the unsigned x-payment copy can no longer name a victim");
}

// 2. Neither direction breaks a legitimate single-header client.
{
  ok(payerFromRequest(reqWith({ "payment-signature": auth(ATTACKER) })) === norm(ATTACKER),
    "a v2 client sending only payment-signature is attributed");
  ok(payerFromRequest(reqWith({ "x-payment": auth(ATTACKER) })) === norm(ATTACKER),
    "a legacy client sending only x-payment is still attributed (no regression)");
  ok(payerFromRequest(reqWith({})) === null, "no payment header -> null, never a guess");
}

// 3. The helper itself, since three modules depend on it.
{
  ok(paymentHeaderOf(reqWith({ "payment-signature": "A", "x-payment": "B" })) === "A",
    "helper prefers payment-signature");
  ok(paymentHeaderOf(reqWith({ "x-payment": "B" })) === "B", "helper falls back to x-payment");
  ok(paymentHeaderOf(reqWith({})) === null, "helper returns null with neither");
  ok(paymentHeaderOf(null) === null && paymentHeaderOf({}) === null, "helper never throws on junk");
}

// 4. PIN IT TO THE INSTALLED MIDDLEWARE. If a dependency bump flips the
//    resolution order, our attribution silently diverges again — the exact
//    condition that created this vulnerability. Read the vendor source and
//    assert the order we mirror.
{
  let src = "";
  try { src = readFileSync("node_modules/@x402/express/dist/esm/index.mjs", "utf8"); } catch { /* optional */ }
  // A pin that degrades to a silent pass stops being a pin. If the package is
  // installed but its entry file moved, that is exactly when the guard is most
  // needed and least likely to be noticed - so it FAILS rather than skips.
  const installed = existsSync("node_modules/@x402/express");
  if (!src && installed) {
    ok(false, "@x402/express is installed but its entry file could not be read - the version pin is no longer guarding anything");
  } else if (!src) {
    console.log("ok - (skipped: @x402/express not installed)"); pass++;
  } else {
    const m = src.match(/paymentHeader:\s*adapter\.getHeader\("([a-z-]+)"\)\s*\|\|\s*adapter\.getHeader\("([a-z-]+)"\)/);
    ok(!!m, `the middleware's header resolution is still readable (${m ? m[0].slice(0, 60) : "NOT FOUND"})`);
    if (m) {
      ok(m[1] === "payment-signature" && m[2] === "x-payment",
        `middleware order is still payment-signature -> x-payment (got ${m[1]} -> ${m[2]})`);
    }
  }
}

// 5. Non-EVM `from` values are still refused. This field is only trustworthy
//    because the EIP-3009 signature covers it; AVM/SVM/Stellar schemes do not
//    sign an authorization.from, so honouring one would mint a namespace.
{
  ok(payerFromRequest(reqWith({ "payment-signature": auth("GBUYERSTELLARADDRESS") })) === null,
    "a non-EVM from is refused (it carries no signature over this field)");
  ok(payerFromRequest(reqWith({ "payment-signature": b64({ payload: {} }) })) === null,
    "a payload with no authorization -> null");
  ok(payerFromRequest(reqWith({ "payment-signature": "not-base64-json" })) === null,
    "an unparseable header -> null, never a throw");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
