// Native MPP stripe/charge gate (src/mpp-stripe.js) — offline, injected
// validate/settle stubs. Proves the settlement-ordering invariant precisely:
// the handler runs BEFORE settle, a failed handler never charges the card, a
// settle failure after a successful handler answers 402 (never a 200 with a
// broken receipt), the binding check gates before any Stripe call, and the
// challenge is offered ONLY on routes >= the $0.50 card minimum.
//
// The wire shape (decimal amount -> cents, paymentMethodTypes, networkId in
// methodDetails) is the shape `npx mppx validate --yes` accepted end to end
// against Stripe sandbox on 2026-08-20 (Payment [stripe] successful). This
// file proves OUR gate logic; the live sandbox run proved the Stripe API leg.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fakekey";
process.env.STRIPE_PROFILE_ID = process.env.STRIPE_PROFILE_ID || "profile_test_fake";
process.env.BASE_URL = "https://agent402.tools";

import express from "express";
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { Challenge, Credential, Method } from "mppx";
import { stripe as stripeMethods } from "mppx/server";
import {
  stripeEnabled, mintStripeChallenge, checkStripeCredentialBinding,
  createStripeGate, createStripeChallengeAppender, validateStripeCredential,
} from "../src/mpp-stripe.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { console.error("FAIL:", m); process.exit(1); } };
const REALM = "agent402.tools";
const PROFILE = process.env.STRIPE_PROFILE_ID;
// The gate/binding default to the Stripe-derived signing secret; mirror it.
const SECRET = createHmac("sha256", process.env.STRIPE_SECRET_KEY).update("mpp-challenge-signing").digest("base64");
const priceFor = (m, p) => p === "/paid" ? { priceUsd: 0.50, identityBound: false } : p === "/premium" ? { priceUsd: 5.00, identityBound: false } : p === "/id" ? { priceUsd: 1.00, identityBound: true } : p === "/cheap" ? { priceUsd: 0.001, identityBound: false } : null;

// A stripe method purely for building test challenges (no API call in mint).
const testMethod = stripeMethods.charge({ client: new Stripe("sk_test_fakekey"), networkId: PROFILE, paymentMethodTypes: ["card"], livemode: false });

// ---- mint ----
ok(stripeEnabled(), "stripeEnabled true with both env vars");
ok(typeof mintStripeChallenge({ priceUsd: 0.50, realm: REALM }) === "string", "mint: $0.50 route yields a challenge");
ok(mintStripeChallenge({ priceUsd: 0.25, realm: REALM }) === null, "mint: below the $0.50 card minimum mints nothing");

function credFor({ priceUsd = 0.50, realm = REALM, secretKey = SECRET, networkId = PROFILE, spt = "spt_test_123" } = {}) {
  const challenge = Challenge.fromMethod(testMethod, {
    realm, expires: new Date(Date.now() + 60_000),
    request: { amount: priceUsd.toFixed(2), currency: "usd", decimals: 2, networkId, paymentMethodTypes: ["card"] },
    secretKey,
  });
  return Credential.serialize({ challenge, payload: { type: "spt", spt } });
}

// ---- binding ----
ok(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).ok === true, "binding: our own $0.50 challenge on the $0.50 route binds");
ok(/HMAC-verify/.test(checkStripeCredentialBinding(credFor({ secretKey: "wrongsecret" }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).reason), "binding: a challenge signed with another secret is refused");
ok(/networkId/.test(checkStripeCredentialBinding(credFor({ networkId: "profile_test_other" }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).reason), "binding: a challenge for a different Stripe profile is refused");
ok(/below this route's price/.test(checkStripeCredentialBinding(credFor({ priceUsd: 0.50 }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/premium" }).reason), "binding: a $0.50 challenge does not buy the $5.00 route");
ok(/identity bound/.test(checkStripeCredentialBinding(credFor({ priceUsd: 1.00 }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/id" }).reason), "binding: an identity-bound route refuses stripe credentials");
ok(/card minimum/.test(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/cheap" }).reason), "binding: a sub-$0.50 route is not stripe-offered");

// ---- gate end to end (injected validate/settle) ----
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const GATE = { secretKey: SECRET, realm: REALM, priceFor };

// A) valid credential + 200 handler -> settled, receipt attached, ordering.
{
  const order = [];
  const app = express();
  app.use(createStripeGate({ ...GATE,
    validate: async () => { order.push("validate"); return { ok: true, validation: {} }; },
    settle: async () => { order.push("settle"); return { ok: true, receipt: { method: "stripe", status: "success", reference: "pi_test_123", timestamp: new Date().toISOString() } }; },
  }));
  app.post("/paid", (req, res) => { order.push("handler"); res.status(200).json({ result: "ok" }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  const body = await res.json();
  ok(res.status === 200 && body.result === "ok", "gate A: valid credential + 200 handler -> served");
  ok(order.join(",") === "validate,handler,settle", `gate A: strict order validate->handler->settle (got ${order.join(",")})`);
  ok(!!res.headers.get("payment-receipt"), "gate A: Payment-Receipt attached");
  s.close();
}
// B) handler fails -> card NEVER charged.
{
  let settleCalled = false;
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true }), settle: async () => { settleCalled = true; return { ok: true, receipt: {} }; } }));
  app.post("/paid", (req, res) => res.status(500).json({ error: "boom" }));
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(res.status === 500 && settleCalled === false, "gate B: a failed handler is NEVER settled (card not charged)");
  s.close();
}
// B2) a gateway cache hit (an answer someone already paid for) -> card NEVER charged.
{
  let settleCalled = false;
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true }), settle: async () => { settleCalled = true; return { ok: true, receipt: {} }; } }));
  app.post("/paid", (req, res) => { req.gatewayCacheHit = true; res.setHeader("X-Cache", "hit"); res.status(200).json({ cached: true }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  const body = await res.json().catch(() => ({}));
  ok(res.status === 200 && body.cached === true && settleCalled === false, "gate B2: a gateway cache hit is delivered and the card is NEVER charged");
  s.close();
}
// C) settle fails after a 200 -> 402, handler body discarded.
{
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true }), settle: async () => ({ ok: false, error: "card_declined", reason: "your card was declined" }) }));
  app.post("/paid", (req, res) => res.status(200).json({ result: "secret" }));
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  const body = await res.json();
  ok(res.status === 402 && body.result === undefined, "gate C: settle failure after a 200 -> 402, handler body discarded");
  ok(body.type === "https://paymentauth.org/problems/verification-failed", "gate C: RFC 9457 verification-failed problem");
  s.close();
}
// D) invalid credential -> falls through to the next middleware's own 402.
{
  const app = express();
  let downstream = false;
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: false, error: "expired", reason: "expired" }) }));
  app.post("/paid", (req, res) => { downstream = true; res.status(402).json({ fell: "through" }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(res.status === 402 && downstream === true, "gate D: a validate-rejected credential falls through untouched");
  s.close();
}
// E) appender adds a stripe challenge to a >= $0.50 route's 402, not a cheap one.
{
  const app = express();
  app.use(createStripeChallengeAppender({ ...GATE }));
  app.post("/paid", (req, res) => res.status(402).json({}));
  app.post("/cheap", (req, res) => res.status(402).json({}));
  const { s, url } = await listen(app);
  const r1 = await fetch(`${url}/paid`, { method: "POST" });
  const r2 = await fetch(`${url}/cheap`, { method: "POST" });
  ok(/method="stripe"/.test(r1.headers.get("www-authenticate") || ""), "gate E: $0.50 route's 402 carries a stripe/charge challenge");
  ok(!/method="stripe"/.test(r2.headers.get("www-authenticate") || ""), "gate E: sub-$0.50 route's 402 does NOT carry a stripe challenge");
  s.close();
}

// F) client gone before the handler's answer could be sent. The route mimics
// the dispatcher: it reserves a hang-up forgiveness ticket when the handler
// starts. WITH a granted ticket the card is NOT captured
// (src/hangup-settlement.js), the credential stays spent, and the hang-up hook
// sees an undelivered end with no settlement on it. WITHOUT one (the budget is
// spent) the card IS captured and the hook sees the settled charge server.js
// books as owed. A connected control is captured once.
{
  const { createHangupSettlementHook, clientGoneBeforeFirstByte } = await import("../src/hangup-settlement.js");
  const { reserveHangupForgiveness, settleHangupTicket, hangupForgiven, _resetHangupForgiveness } = await import("../src/hangup-forgiveness.js");
  _resetHangupForgiveness();
  // A card charge is at least $0.50, above the default per-key budget ($0.25),
  // so by default a Stripe hang-up is never forgiven: it is captured and
  // booked as owed. The gate's forgiven branch is exercised under a wider
  // budget set for this case only.
  const savedKeyBudget = process.env.HANGUP_FORGIVE_KEY_USD;
  delete process.env.HANGUP_FORGIVE_KEY_USD;
  const byDefault = {}; reserveHangupForgiveness(byDefault, { keys: ["ip:stripe-default"], priceUsd: 0.5 });
  ok(!hangupForgiven(byDefault) && byDefault.__a402HangupTicket.reason === "over per-key budget", `gate F: under the default budget a $0.50 card charge takes no forgiveness ticket (${byDefault.__a402HangupTicket.reason})`);
  _resetHangupForgiveness();
  process.env.HANGUP_FORGIVE_KEY_USD = "1";
  const replay = new Map();
  const replayGuard = { begin: async (k) => (replay.has(k) ? replay.get(k) : (replay.set(k, "inflight"), "ok")), settle: async (k) => { replay.set(k, "consumed"); }, release: async (k) => { replay.delete(k); } };
  let captures = 0, handlerRuns = 0;
  const undelivered = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, res, kind) => undelivered.push({ kind, stripeSettled: req.stripeSettled === true, status: res.statusCode, receipt: res.getHeader("Payment-Receipt") || null }) }));
  app.use(createStripeGate({ ...GATE, replayGuard, validate: async () => ({ ok: true, validation: {} }), settle: async () => { captures++; return { ok: true, receipt: { method: "stripe", status: "success", reference: `pi_test_gone_${captures}`, timestamp: new Date().toISOString() } }; } }));
  app.post("/paid", (req, res) => {
    handlerRuns++;
    if (req.headers["x-grant"] === "1") reserveHangupForgiveness(req, { keys: ["ip:stripe-f"], priceUsd: 0.5 });
    res.once("close", () => settleHangupTicket(req, { abandoned: clientGoneBeforeFirstByte(req) }));
    setTimeout(() => res.status(200).json({ late: true }), 400);
  });
  const { s, url } = await listen(app);
  const cred = credFor();
  const warned = [];
  const w0 = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); };
  try {
    await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: cred, "x-grant": "1" }, signal: AbortSignal.timeout(100) }).catch(() => null);
    await new Promise((r) => setTimeout(r, 700));
  } finally { console.warn = w0; }
  ok(captures === 0, `gate F: with a forgiveness ticket, a buyer gone before the handler answered is NOT captured (captures ${captures})`);
  ok(undelivered.length === 1 && undelivered[0].kind === "end" && !undelivered[0].stripeSettled && undelivered[0].receipt === null && undelivered[0].status === 499, `gate F: the hang-up hook sees the undelivered end once, with no settlement on it (${JSON.stringify(undelivered)})`);
  ok(warned.some((w) => /\[mpp-stripe\] client gone before the handler's answer could be sent[^\n]*not captured, not charged/.test(w)), "gate F: the gate says it did not capture");
  const again = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: cred } });
  ok(again.status !== 200 && handlerRuns === 1 && captures === 0, `gate F: the same credential is still spent and cannot run the handler again (status ${again.status}, handler runs ${handlerRuns})`);
  await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() }, signal: AbortSignal.timeout(100) }).catch(() => null);
  await new Promise((r) => setTimeout(r, 700));
  ok(captures === 1 && undelivered.length === 2 && undelivered[1].stripeSettled && !!undelivered[1].receipt, `gate F: WITHOUT a ticket the hang-up is captured and the hook sees the settled charge (captures ${captures}, ${JSON.stringify(undelivered[1])})`);
  const served = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor(), "x-grant": "1" } });
  ok(served.status === 200 && captures === 2 && undelivered.length === 2, "gate F: a connected buyer is captured once; the hook stays quiet");
  s.close();
  _resetHangupForgiveness();
  if (savedKeyBudget === undefined) delete process.env.HANGUP_FORGIVE_KEY_USD; else process.env.HANGUP_FORGIVE_KEY_USD = savedKeyBudget;
}

// ---- wiring pin: server.js MUST bypass the x402 paywall for a validated
// stripe request, exactly like req.tempoSettling. Without it a real card
// payment is 402'd by the paywall and never served (the gate here runs with
// no paywall in front, so it cannot catch this — hence a source scan). Caught
// by the 2026-08-20 security review. ----
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  // Own-property checks since 2026-09-24 (a polluted prototype made every request look settled).
  ok(/ownTrue\(req, "tempoSettling"\)\s*\|\|\s*ownTrue\(req, "stripeSettling"\)/.test(src), "wiring: server.js bypasses the x402 paywall for an own req.stripeSettling (like req.tempoSettling)");
}

// ---- the REAL pre-handler validate, unstubbed (2026-08-26 live finding) ----
// mppx's stripe/charge method has no non-mutating `validate`: its only step is
// `verify`, which creates the PaymentIntent. The gate used to call
// Method.validateCredential, which throws for such methods, so EVERY card
// credential was refused before the handler - unseen here because the gate
// tests inject validate stubs. Pin the vendor fact and the fixed behaviour.
{
  let vendorThrew = "";
  try { await Method.validateCredential([testMethod], credFor({ spt: "spt_live_abc" })); } catch (e) { vendorThrew = String(e?.message || e); }
  ok(/non-mutating credential validation/.test(vendorThrew), "vendor: mppx Method.validateCredential refuses stripe/charge (no validate step) - the gate must not call it");
  const good = await validateStripeCredential(credFor({ spt: "spt_live_abc" }));
  ok(good.ok === true && good.validation?.spt === "spt_live_abc", "validate: a well-formed unexpired credential carrying an SPT passes WITHOUT touching Stripe");
  const expiredCh = Challenge.fromMethod(testMethod, { realm: REALM, expires: new Date(Date.now() - 1000), request: { amount: "0.50", currency: "usd", decimals: 2, networkId: PROFILE, paymentMethodTypes: ["card"] }, secretKey: SECRET });
  const expired = await validateStripeCredential(Credential.serialize({ challenge: expiredCh, payload: { spt: "spt_live_abc" } }));
  ok(expired.ok === false && /expired/i.test(expired.error), "validate: an expired challenge is refused");
  const noSpt = await validateStripeCredential(credFor({ spt: "" }));
  ok(noSpt.ok === false && /Shared Payment Token/.test(noSpt.reason), "validate: a credential without an SPT id is refused");
  const junk = await validateStripeCredential("Payment not-a-credential");
  ok(junk.ok === false, "validate: an undecodable credential is refused, never thrown");
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
