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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
  createStripeGate, createStripeChallengeAppender, validateStripeCredential, checkGrantedToken,
} from "../src/mpp-stripe.js";
import { createReplayGuard } from "../src/replay-guard.js";
import { fullAnswerMiddleware } from "../src/full-answer.js";
import { rawGet } from "./lib/raw-get.js";
import { __setTestClient } from "../src/shared-limit.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { console.error("FAIL:", m); process.exit(1); } };
const REALM = "agent402.tools";
const PROFILE = process.env.STRIPE_PROFILE_ID;
// The gate/binding default to the Stripe-derived signing secret; mirror it.
const SECRET = createHmac("sha256", process.env.STRIPE_SECRET_KEY).update("mpp-challenge-signing").digest("base64");
const priceFor = (m, p) => p === "/paid" ? { priceUsd: 0.50, identityBound: false } : p === "/premium" ? { priceUsd: 5.00, identityBound: false } : p === "/id" ? { priceUsd: 1.00, identityBound: true } : p === "/cheap" ? { priceUsd: 0.001, identityBound: false } : p === "/third" ? { priceUsd: 0.50, identityBound: false, paysThirdParty: true } : p === "/long" ? { priceUsd: 5.00, identityBound: false, longRunning: true } : null;

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
ok(/wallet payment only/.test(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/third" }).reason || ""), "binding: a route that buys from an outside seller refuses a card");
ok(/card minimum/.test(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/cheap" }).reason), "binding: a sub-$0.50 route is not stripe-offered");

// ---- gate end to end (injected validate/settle) ----
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const GATE = { secretKey: SECRET, realm: REALM, priceFor, checkToken: async () => ({ ok: true }) };

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
// A2) a GET with If-None-Match: * behind the full-answer seam (the order the
// server mounts them in, src/full-answer.js): the card is charged once and the
// answer is the full 200. The same request without the seam is the control:
// Express answers it 304 with no body.
for (const seam of [true, false]) {
  let settles = 0;
  const app = express();
  if (seam) app.use(fullAnswerMiddleware((path) => path === "/paid"));
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }),
    settle: async () => { settles++; return { ok: true, receipt: { method: "stripe", status: "success", reference: "pi_test_inm", timestamp: new Date().toISOString() } }; } }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { s, url } = await listen(app);
  const res = await rawGet(`${url}/paid`, { Authorization: credFor(), "If-None-Match": "*" });
  const text = res.body;
  if (seam) ok(res.status === 200 && JSON.parse(text).result === "ok" && settles === 1 && !!res.headers["payment-receipt"], `gate A2: with the full-answer seam a conditional GET is a full 200, charged once (status ${res.status}, settles ${settles})`);
  else ok(res.status === 304 && text === "", `gate A2 control: without the seam the same request is an empty 304 (status ${res.status})`);
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

// G) the shared replay store configured and not answering: a long-running
// route is refused 503 with Retry-After before its handler runs and nothing is
// captured; a fast route keeps the per-process claim and is served.
{
  const broken = { get: async () => { throw new Error("simulated outage"); }, set: async () => { throw new Error("simulated outage"); }, del: async () => { throw new Error("simulated outage"); }, expire: async () => { throw new Error("simulated outage"); } };
  let captures = 0, runs = 0;
  const app = express();
  app.use(createStripeGate({ ...GATE, replayGuard: createReplayGuard(), validate: async () => ({ ok: true, validation: {} }), settle: async () => { captures++; return { ok: true, receipt: { method: "stripe", status: "success", reference: `pi_test_outage_${captures}`, timestamp: new Date().toISOString() } }; } }));
  app.post("/long", (req, res) => { runs++; res.json({ ok: true }); });
  app.post("/paid", (req, res) => { runs++; res.json({ ok: true }); });
  const { s, url } = await listen(app);
  const e0 = console.error;
  const quiet = async (fn) => { console.error = () => {}; try { return await fn(); } finally { console.error = e0; } };
  __setTestClient(broken);
  try {
    const r = await quiet(() => fetch(`${url}/long`, { method: "POST", headers: { Authorization: credFor({ priceUsd: 5.00 }) } }));
    const b = await r.json().catch(() => ({}));
    ok(r.status === 503 && b.reason === "replay-store-unavailable" && r.headers.get("retry-after") === "30" && runs === 0 && captures === 0, `gate G: a long-running route is refused while the shared store is out, before its handler, nothing captured (${r.status}, runs ${runs}, captures ${captures})`);
    // A lone container inside its deploy overlap window (an old container
    // may still serve) refuses a fast route too; past the window it serves it
    // on the per-process claim (src/replay-topology.js).
    const overlap = process.env.DEPLOY_OVERLAP_SECONDS;
    process.env.DEPLOY_OVERLAP_SECONDS = "3600";
    const w = await quiet(() => fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } }));
    const wb = await w.json().catch(() => ({}));
    ok(w.status === 503 && wb.reason === "replay-store-unavailable" && runs === 0 && captures === 0, `gate G: inside the overlap window a fast route is refused too, nothing captured (${w.status}, runs ${runs}, captures ${captures})`);
    process.env.DEPLOY_OVERLAP_SECONDS = "0";
    const f = await quiet(() => fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } }));
    ok(f.status === 200 && runs === 1 && captures === 1, `gate G: past the window a fast route keeps the per-process claim and is served and captured (${f.status}, runs ${runs}, captures ${captures})`);
    if (overlap === undefined) delete process.env.DEPLOY_OVERLAP_SECONDS; else process.env.DEPLOY_OVERLAP_SECONDS = overlap;
  } finally { __setTestClient(null); s.close(); }
}

// H) one payment token, many challenges: the token is claimed before the
// handler. Ten credentials at once that carry one token run ONE handler and
// make ONE capture; the claim lasts only while a run is in flight, so after
// a capture the token pays again under a fresh challenge, while the captured
// credential itself is refused as a replay; a run that fails (or whose
// capture fails) releases the token, and the same token then runs once; two
// tokens run independently. The real validate reads the token.
{
  let seq = 0;
  const tokenCred = (spt) => {
    const challenge = Challenge.fromMethod(testMethod, {
      realm: REALM, expires: new Date(Date.now() + 60_000 + (seq++)),
      request: { amount: "0.50", currency: "usd", decimals: 2, networkId: PROFILE, paymentMethodTypes: ["card"] },
      secretKey: SECRET,
    });
    return Credential.serialize({ challenge, payload: { spt } });
  };
  const runs = new Map(), captures = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let failNext = 0, declineNext = 0;
  const app = express();
  app.use(createStripeGate({ ...GATE, replayGuard: createReplayGuard(),
    settle: async (auth) => {
      const spt = Credential.deserialize(auth).payload.spt;
      await new Promise((r) => setTimeout(r, 50));
      if (declineNext > 0) { declineNext--; return { ok: false, error: "declined", reason: "declined" }; }
      bump(captures, spt);
      return { ok: true, receipt: { method: "stripe", status: "success", reference: `pi_${spt}_${captures.get(spt)}`, timestamp: new Date().toISOString() } };
    } }));
  app.post("/paid", (req, res) => {
    const spt = Credential.deserialize(req.headers.authorization).payload.spt;
    bump(runs, spt);
    if (failNext > 0) { failNext--; return res.status(502).json({ error: "upstream failed" }); }
    setTimeout(() => res.status(200).json({ ok: true }), 150);
  });
  const { s, url } = await listen(app);
  const post = (auth) => fetch(`${url}/paid`, { method: "POST", headers: { Authorization: auth } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const w0 = console.warn; console.warn = () => {};
  try {
    const tenCreds = Array.from({ length: 10 }, () => tokenCred("spt_burst"));
    const ten = await Promise.all(tenCreds.map(post));
    const ok200 = ten.filter((r) => r.status === 200).length;
    const refused = ten.filter((r) => r.status === 402 && r.body?.details?.reason === "token-inflight" && r.body?.details?.charged === false).length;
    ok(runs.get("spt_burst") === 1 && captures.get("spt_burst") === 1 && ok200 === 1 && refused === 9, `gate H: ten credentials at once carrying one token ran ONE handler and made ONE capture; nine refused 402 before the handler, uncharged (runs ${runs.get("spt_burst")}, captures ${captures.get("spt_burst")}, ${ok200} x 200, ${refused} refused)`);
    const sb = () => `runs ${runs.get("spt_burst")}, captures ${captures.get("spt_burst")}`;
    const after = await post(tokenCred("spt_burst"));
    ok(after.status === 200 && runs.get("spt_burst") === 2 && captures.get("spt_burst") === 2, `gate H: after the capture the same token pays again under a fresh challenge, run and captured once (${after.status}, ${sb()})`);
    const winner = tenCreds[ten.findIndex((r) => r.status === 200)];
    const replayed = await post(winner);
    ok(replayed.status === 402 && /already used or is in flight/.test(replayed.body?.detail || "") && runs.get("spt_burst") === 2 && captures.get("spt_burst") === 2, `gate H: the captured credential sent again is refused as a replay before the handler, not charged (${replayed.status}, ${sb()})`);
    // A credential refused for its token left its own challenge unclaimed:
    // sent again once the token is free, it runs and is captured once.
    const loser = tenCreds[ten.findIndex((r) => r.body?.details?.reason === "token-inflight")];
    const again = await post(loser);
    ok(again.status === 200 && runs.get("spt_burst") === 3 && captures.get("spt_burst") === 3, `gate H: a credential refused for its token kept its challenge unclaimed and pays once the token is free (${again.status}, ${again.body?.details?.reason || String(again.body?.detail || "").slice(0, 60)}, ${sb()})`);

    failNext = 1;
    const failedCred = tokenCred("spt_retry");
    const f1 = await post(failedCred);
    ok(f1.status === 502 && runs.get("spt_retry") === 1 && !captures.get("spt_retry"), `gate H: a failed run is not captured (${f1.status})`);
    const f2 = await post(failedCred);
    ok(f2.status === 200 && runs.get("spt_retry") === 2 && captures.get("spt_retry") === 1, `gate H: after a failed run the same token (and credential) runs once more and is captured once (${f2.status}, runs ${runs.get("spt_retry")}, captures ${captures.get("spt_retry")})`);

    declineNext = 1;
    const d1 = await post(tokenCred("spt_decline"));
    const d2 = await post(tokenCred("spt_decline"));
    ok(d1.status === 402 && d2.status === 200 && runs.get("spt_decline") === 2 && captures.get("spt_decline") === 1, `gate H: a capture that fails releases the token; the next credential with it runs and is captured (${d1.status}, ${d2.status})`);

    const two = await Promise.all([post(tokenCred("spt_a")), post(tokenCred("spt_b"))]);
    ok(two.every((r) => r.status === 200) && runs.get("spt_a") === 1 && runs.get("spt_b") === 1 && captures.get("spt_a") === 1 && captures.get("spt_b") === 1, `gate H: two tokens at once run independently (${two.map((r) => r.status)})`);
  } finally { console.warn = w0; s.close(); }
}

// H2) the token claim spans the capture, and a hang-up frees it.
//   - A slow capture: one request runs, and nine more carrying the same token
//     arrive while its capture is still under way: still one run and one
//     capture, the nine refused before the handler.
//   - A buyer gone before the answer, holding a forgiveness ticket: nothing is
//     captured, and the same token under a fresh challenge then runs and is
//     captured once.
{
  const { createHangupSettlementHook, clientGoneBeforeFirstByte } = await import("../src/hangup-settlement.js");
  const { reserveHangupForgiveness, settleHangupTicket, _resetHangupForgiveness } = await import("../src/hangup-forgiveness.js");
  const savedKeyBudget = process.env.HANGUP_FORGIVE_KEY_USD;
  _resetHangupForgiveness();
  process.env.HANGUP_FORGIVE_KEY_USD = "1";
  let seq = 0;
  const tokenCred = (spt) => Credential.serialize({ challenge: Challenge.fromMethod(testMethod, { realm: REALM, expires: new Date(Date.now() + 60_000 + (seq++)), request: { amount: "0.50", currency: "usd", decimals: 2, networkId: PROFILE, paymentMethodTypes: ["card"] }, secretKey: SECRET }), payload: { spt } });
  const runs = new Map(), captures = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let captureMs = 0, capturing = 0;
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: () => {} }));
  app.use(createStripeGate({ ...GATE, replayGuard: createReplayGuard(),
    settle: async (auth) => {
      const spt = Credential.deserialize(auth).payload.spt;
      capturing++;
      await new Promise((r) => setTimeout(r, captureMs));
      capturing--;
      bump(captures, spt);
      return { ok: true, receipt: { method: "stripe", status: "success", reference: `pi_${spt}_${captures.get(spt)}`, timestamp: new Date().toISOString() } };
    } }));
  app.post("/paid", (req, res) => {
    const spt = Credential.deserialize(req.headers.authorization).payload.spt;
    bump(runs, spt);
    if (req.headers["x-grant"] === "1") reserveHangupForgiveness(req, { keys: ["ip:stripe-h2"], priceUsd: 0.5 });
    res.once("close", () => settleHangupTicket(req, { abandoned: clientGoneBeforeFirstByte(req) }));
    setTimeout(() => res.status(200).json({ ok: true }), Number(req.headers["x-delay"] || 20));
  });
  const { s, url } = await listen(app);
  const post = (auth, headers = {}, signal) => fetch(`${url}/paid`, { method: "POST", headers: { Authorization: auth, ...headers }, signal }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const w0 = console.warn; console.warn = () => {};
  try {
    captureMs = 600;
    const first = post(tokenCred("spt_slow"));
    for (let i = 0; i < 40 && capturing === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const midCapture = capturing === 1;
    const nine = await Promise.all(Array.from({ length: 9 }, () => post(tokenCred("spt_slow"))));
    const one = await first;
    captureMs = 0;
    const refused = nine.filter((r) => r.status === 402 && r.body?.details?.reason === "token-inflight").length;
    ok(midCapture && one.status === 200 && runs.get("spt_slow") === 1 && captures.get("spt_slow") === 1 && refused === 9, `gate H2: nine requests with the token arriving during a slow capture: still ONE run and ONE capture, nine refused before the handler (runs ${runs.get("spt_slow")}, captures ${captures.get("spt_slow")}, ${refused} refused)`);

    await post(tokenCred("spt_gone"), { "x-grant": "1", "x-delay": "400" }, AbortSignal.timeout(100)).catch(() => null);
    await new Promise((r) => setTimeout(r, 700));
    ok(runs.get("spt_gone") === 1 && !captures.get("spt_gone"), `gate H2: a buyer gone before the answer, with a forgiveness ticket, is not captured (runs ${runs.get("spt_gone")}, captures ${captures.get("spt_gone") || 0})`);
    const after = await post(tokenCred("spt_gone"));
    ok(after.status === 200 && runs.get("spt_gone") === 2 && captures.get("spt_gone") === 1, `gate H2: after the hang-up the same token under a fresh challenge runs and is captured once (${after.status}, ${after.body?.details?.reason || "-"}, runs ${runs.get("spt_gone")}, captures ${captures.get("spt_gone") || 0})`);
  } finally {
    console.warn = w0; s.close(); _resetHangupForgiveness();
    if (savedKeyBudget === undefined) delete process.env.HANGUP_FORGIVE_KEY_USD; else process.env.HANGUP_FORGIVE_KEY_USD = savedKeyBudget;
  }
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

// ---- the payment token is checked with Stripe BEFORE the handler runs ----
// A string that merely looks like a token used to run the paid handler (and
// spend upstream) before the capture failed.
{
  let paidAs = null, settleCalled = false;
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true, validation: { spt: "spt_fake" } }), checkToken: async () => ({ ok: false, reason: "Stripe does not know this payment token" }), settle: async () => { settleCalled = true; return { ok: true, receipt: {} }; } }));
  // Stands in for the paywall after the gate: it serves only a request the gate accepted as card-paid.
  app.post("/paid", (req, res) => { paidAs = req.mppStripeCredential === true || req.stripeSettling === true; res.status(paidAs ? 200 : 402).json({}); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(paidAs === false && !settleCalled && res.status === 402, `token check: an unknown token is never accepted as card payment (status ${res.status}, accepted ${paidAs})`);
  s.close();
}
{
  let handlerRan = false;
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true, validation: { spt: "spt_x" } }), checkToken: async () => ({ ok: false, unavailable: true, reason: "Stripe could not be reached" }) }));
  app.post("/paid", (req, res) => { handlerRan = true; res.status(200).json({ result: "ok" }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(!handlerRan && res.status >= 400, `token check: no answer from Stripe fails closed (status ${res.status})`);
  s.close();
}
{
  const NOW = Date.parse("2026-10-19T12:00:00Z");
  const tokenRes = (body, status = 200) => async (url, init) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(body), { status }); };
  const seen = {};
  const good = { id: "spt_1", deactivated_at: null, deactivated_reason: null, usage_limits: { currency: "usd", expires_at: NOW / 1000 + 3600, max_amount: 1000 }, usage_details: { amount_captured: { value: 200, currency: "usd" } } };
  let r = await checkGrantedToken("spt_1", 500, { fetchImpl: tokenRes(good), secretKey: "sk_test_x", now: NOW });
  ok(r.ok === true, "token check: an active token with room under its limit passes");
  ok(/\/v1\/shared_payment\/granted_tokens\/spt_1$/.test(seen.url) && /^Bearer /.test(seen.init.headers.Authorization) && /preview/.test(seen.init.headers["Stripe-Version"]), "token check: reads the granted token with the preview API version");
  r = await checkGrantedToken("spt_1", 900, { fetchImpl: tokenRes(good), secretKey: "sk_test_x", now: NOW });
  ok(r.ok === false && /remaining limit/.test(r.reason), "token check: a price above the remaining limit is refused");
  r = await checkGrantedToken("spt_1", 100, { fetchImpl: tokenRes({ ...good, deactivated_reason: "revoked", deactivated_at: 1 }), secretKey: "sk_test_x", now: NOW });
  ok(r.ok === false && /no longer active/.test(r.reason), "token check: a revoked token is refused");
  r = await checkGrantedToken("spt_1", 100, { fetchImpl: tokenRes({ ...good, usage_limits: { ...good.usage_limits, expires_at: NOW / 1000 - 1 } }), secretKey: "sk_test_x", now: NOW });
  ok(r.ok === false && /expired/.test(r.reason), "token check: an expired token is refused");
  r = await checkGrantedToken("spt_nope", 100, { fetchImpl: tokenRes({ error: {} }, 404), secretKey: "sk_test_x", now: NOW });
  ok(r.ok === false && !r.unavailable, "token check: a token Stripe does not know is refused");
  r = await checkGrantedToken("spt_1", 100, { fetchImpl: async () => { throw new TypeError("fetch failed"); }, secretKey: "sk_test_x", now: NOW });
  ok(r.ok === false && r.unavailable === true, "token check: a network failure fails closed and says so");
  r = await checkGrantedToken("spt_1", 100, { fetchImpl: tokenRes(good), secretKey: "", now: NOW });
  ok(r.ok === false, "token check: with no secret key nothing passes");
}

// The server's own priceFor for the card gate marks a long-running route, so
// gate G's refusal applies on the real server (the closure is not exported;
// read from source like the other server wiring checks).
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("const stripeGate = createStripeGate({");
  const block = at >= 0 ? server.slice(at, server.indexOf("});", at)) : "";
  ok(/priceFor:/.test(block) && /longRunning: isLongRunningSlug\(def\.slug\)/.test(block), "server: the card gate's priceFor marks long-running routes");
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
