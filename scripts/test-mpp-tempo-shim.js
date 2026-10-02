// Tempo MPP settlement (src/mpp-tempo.js) — two deliberately separate groups:
//
//   1. Spawns the real server (src/server.js) with TEMPO_API_KEY etc set to
//      prove the 402 challenge-minting wiring — a tempo/charge challenge
//      rides alongside the existing evm one, HMAC-verifies, and disappears
//      entirely when TEMPO_API_KEY is unset (the rollout switch). No relay
//      call is ever made on this path: an unpaid GET never validates or
//      broadcasts anything.
//   2. A standalone in-process Express app driving createTempoGate() with
//      INJECTED validate/broadcast stubs (same pattern mpp-index.js uses for
//      its own injectable `verify`) — proves the settlement-ordering
//      invariant precisely: the route handler always runs before broadcast,
//      a failed handler never triggers a broadcast at all, and a broadcast
//      failure AFTER a successful handler answers 402 (buyer never charged
//      for undelivered settlement), never a 200 with a broken receipt.
//
// Wire-format compatibility with Tempo's REAL relay (api.tempo.xyz) is
// UNVERIFIED until a real TEMPO_API_KEY exists — see the approved plan's
// "Verification" section. This file proves OUR logic, not their API.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import express from "express";
import { Challenge, Credential } from "mppx";
import { createTempoGate, createTempoChallengeAppender, mintTempoChallenge, tempoEnabled, checkTempoCredentialBinding, tempoSenderOf } from "../src/mpp-tempo.js";
import { Transaction as TempoTransaction } from "viem/tempo";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createReplayGuard } from "../src/replay-guard.js";
import { whenTempoLedgerPayerKnown } from "../src/tempo-push-debts.js";
import { paymentRequiredBodyMiddleware, PAYMENT_REQUIRED_OFFER_KEYS } from "../src/payment-required-body.js";
import { isDeepStrictEqual } from "node:util";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Group 1: real server, challenge-minting wiring only.
// ---------------------------------------------------------------------------
const PORT = 3079;
const FAC_PORT = 3080;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mpp-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TEMPO_CURRENCY = "0x2000000000000000000000000000000000000000";
// A real Tempo transaction signed by a throwaway key: the payload of every
// pull credential below, so the gate's sender recovery is exercised.
const PULL_SIGNER = privateKeyToAccount(generatePrivateKey());
const SIGNED_TX = await PULL_SIGNER.signTransaction({ chainId: 4217, type: "tempo", calls: [{ to: TEMPO_CURRENCY, data: "0x" }], nonce: 0, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, { serializer: TempoTransaction.serialize });

// Minimal stub facilitator — only /supported is ever hit in this file (no
// evm/x402 payment is sent), but the boot /supported guard needs SOMETHING
// reachable or it fail-opens into 500ing every paid route (unrelated to
// Tempo — see src/payments.js's boot guard).
const facilitator = createServer((req, res) => {
  if (req.url === "/supported") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const bootBaseEnv = {
  ...process.env, PORT: String(PORT), FREE_MODE: "",
  WALLET_ADDRESS: TREASURY, NETWORK: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  MPP_SECRET_KEY: SECRET,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
};

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("server never became healthy");
}

// A stub Tempo relay that counts every call: a credential the binding check
// refuses must never reach it.
const relayHits = [];
const relayStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => { relayHits.push(req.url); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: { code: "invalid_payment", message: "stub relay" } })); });
});
await new Promise((r) => relayStub.listen(0, "127.0.0.1", r));
const RELAY_URL = `http://127.0.0.1:${relayStub.address().port}`;

let proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY, TEMPO_API_BASE_URL: RELAY_URL },
  stdio: "ignore",
});
// ok() exits the process on a failure, which skips every `finally` below: kill
// whichever server is booted on exit, or it keeps holding the fixed port and
// the next suite to use it talks to a stale server.
process.on("exit", () => { try { proc?.kill("SIGKILL"); } catch { /* already gone */ } });
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  ok(r402.status === 402, "unpaid catalog GET -> 402 (tempo enabled)");
  const wwwAuth = r402.headers.get("www-authenticate");
  ok(!!wwwAuth, "402 carries WWW-Authenticate");
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }));
  const tempoCh = challenges.find((c) => c.method === "tempo" && c.intent === "charge");
  ok(!!tempoCh, "a tempo/charge challenge is offered alongside evm");
  // Regression lock for a bug caught live 2026-08-17: mintTempoChallenge()
  // originally formatted amount as a DECIMAL string ("0.001000"), which a
  // real mppx client rejects with "Cannot convert 0.001000 to a BigInt"
  // before it ever reaches signing — no offline test caught it because
  // Group 2 below only ever hand-builds its own (already-correct) fixture
  // credential, never exercises mintTempoChallenge()'s own formatting.
  // Amount must be a raw integer string in base units, same convention the
  // evm challenge's x402 accepts entry already uses.
  ok(/^\d+$/.test(tempoCh?.request?.amount || ""), `tempo challenge amount is a raw integer string, not decimal (got ${tempoCh?.request?.amount})`);
  ok(tempoCh?.request?.amount === "1000", `tempo challenge amount matches the uuid tool's $0.001 price in base units (got ${tempoCh?.request?.amount})`);
  // Wire shape must be what mppx's OWN builder emits (Challenge.fromMethod
  // through the tempo/charge schema): chainId under methodDetails, and NO
  // `decimals` key on the wire (a parsing input the schema strips). The
  // first hand-assembled version shipped `decimals` and no methodDetails.
  ok(tempoCh?.request?.methodDetails?.chainId === 4217, `tempo challenge carries methodDetails.chainId 4217 (Tempo mainnet) (got ${JSON.stringify(tempoCh?.request?.methodDetails)})`);
  ok(!("decimals" in (tempoCh?.request || {})), "tempo challenge request does not carry `decimals` on the wire (schema-canonical shape)");
  ok(Challenge.verify(tempoCh, { secretKey: SECRET }), "tempo challenge id HMAC-verifies");
  ok(Date.parse(tempoCh.expires) > Date.now(), "tempo challenge carries a future expires");
  const evmCh = challenges.find((c) => c.method === "evm" && c.intent === "charge");
  ok(!!evmCh, "the evm challenge is STILL offered (Tempo is additive, no regression)");
  // Order: mppx pays the FIRST challenge it has a method for and never falls
  // back, so a buyer holding Tempo funds and a Base wallet pays over Tempo.
  ok(challenges[0]?.method === "tempo", `the tempo challenge leads the header (order: ${challenges.map((c) => c.method).join(",")})`);

  // A long-running route (a report composite) is never payable over Tempo:
  // its run outlives the credential. The appender mints no challenge for it,
  // and challenges are not path-bound, so the GATE must refuse one minted for
  // another route: here a $2.00 challenge (what a large metered quote reaches)
  // HMAC-valid for this server, presented to POST /v1/research. It is refused
  // at the binding check, before any relay call, as a method-unsupported
  // problem. Control: the same credential on an ordinary route does reach the
  // relay (so the zero below measures the refusal, not a dead stub).
  const composite402 = await fetch(`${B}/v1/research`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q" }) });
  ok(composite402.status === 402 && !/method="tempo"/.test(composite402.headers.get("www-authenticate") || ""), "no tempo challenge is minted on a long-running route's 402");
  const big = Challenge.from({ realm: `127.0.0.1:${PORT}`, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000), request: { amount: "2000000", currency: TEMPO_CURRENCY, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, secretKey: SECRET });
  const bigCred = Credential.serialize({ challenge: big, payload: { signature: SIGNED_TX, type: "transaction" } });
  const hits0 = relayHits.length;
  const refused = await fetch(`${B}/v1/research`, { method: "POST", headers: { "content-type": "application/json", Authorization: bigCred }, body: JSON.stringify({ question: "what changed in x402 this month" }) });
  const rb = await refused.json().catch(() => ({}));
  ok(refused.status === 402 && relayHits.length === hits0 && /runs longer than a Tempo credential stays valid/.test(rb.detail || "") && rb.type === "https://paymentauth.org/problems/method-unsupported", `a $2.00 tempo challenge is refused on a composite before any relay call (status ${refused.status}, relay calls +${relayHits.length - hits0}, ${rb.type}: ${String(rb.detail).slice(0, 90)})`);
  const control = await fetch(`${B}/api/uuid`, { headers: { Authorization: bigCred } });
  ok(control.status === 402 && relayHits.length > hits0, `control: the same credential on an ordinary route reaches the relay (relay calls +${relayHits.length - hits0})`);
  // A tempo credential whose challenge we never minted (wrong HMAC secret)
  // is refused at the binding check and FALLS THROUGH to the paywall's 402.
  // That 402 carries PAYMENT-REQUIRED, so its RFC 9457 problem body also
  // carries the header's offer, key for key; the problem explains itself in
  // `detail`, so it carries no `error`.
  {
    const forged = Challenge.from({
      realm: tempoCh.realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
      request: { amount: "1000", currency: TEMPO_CURRENCY, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } },
      secretKey: "not-the-server-secret",
    });
    const r = await fetch(`${B}/api/uuid`, { headers: { Authorization: Credential.serialize({ challenge: forged, payload: { hash: `0x${"ab".repeat(32)}`, type: "hash" } }) } });
    const body = await r.json().catch(() => ({}));
    const hdr = r.headers.get("payment-required");
    const pr = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null;
    ok(r.status === 402 && /problem\+json/.test(r.headers.get("content-type") || "") && /^https:\/\/paymentauth\.org\/problems\//.test(body.type || "") && typeof body.detail === "string", `a forged tempo challenge falls through to a 402 problem (${body.type})`);
    ok(!!pr && typeof pr.error === "string" && !("error" in body) && Object.keys(pr).filter((k) => k !== "error").every((k) => isDeepStrictEqual(body[k], pr[k])), "that fall-through problem body mirrors the PAYMENT-REQUIRED offer key for key, and carries no error beside its detail");
  }
} finally {
  proc.kill("SIGKILL");
}

proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "", TEMPO_RECIPIENT_ADDRESS: "", TEMPO_CURRENCY: "" },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const wwwAuth = r402.headers.get("www-authenticate") || "";
  const challenges = wwwAuth ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth })) : [];
  ok(!challenges.some((c) => c.method === "tempo"), "no tempo challenge when TEMPO_API_KEY is unset (rollout switch)");
} finally {
  proc.kill("SIGKILL");
}

const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: "" },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const wwwAuth = r402.headers.get("www-authenticate");
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }));
  const tempoCh = challenges.find((c) => c.method === "tempo");
  ok(!!tempoCh, "tempo challenge still minted with TEMPO_CURRENCY unset (currency now has a default)");
  ok(tempoCh?.request?.currency === PATH_USD_ADDRESS, `defaults to PathUSD's verified address when TEMPO_CURRENCY is unset (got ${tempoCh?.request?.currency})`);
} finally {
  proc.kill("SIGKILL");
}

// TEMPO_CURRENCY is a CSV: one tempo/charge challenge per currency, in order.
// A stock mppx client pays the FIRST tempo challenge (no cross-challenge
// balance check, auto-swap off by default), so ORDER is the operator's
// "which currency do my buyers hold" decision - the ecosystem's is USDC.e.
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: `usdc, ${PATH_USD_ADDRESS}` },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": r402.headers.get("www-authenticate") }));
  const tempoChs = challenges.filter((c) => c.method === "tempo");
  ok(tempoChs.length === 2, `TEMPO_CURRENCY CSV mints one tempo challenge per currency (got ${tempoChs.length})`);
  ok(tempoChs[0]?.request?.currency === USDC_E && tempoChs[1]?.request?.currency === PATH_USD_ADDRESS, "challenges keep the CSV order (first = preferred), and the 'usdc' alias resolves to USDC.e");
  ok(tempoChs.every((c) => c.request.amount === "1000" && Challenge.verify(c, { secretKey: SECRET })), "both carry the same base-units amount and HMAC-verify");
} finally {
  proc.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// Group 2: settlement-ordering invariant, in-process, injected validate/broadcast.
// ---------------------------------------------------------------------------
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = TEMPO_CURRENCY;
ok(tempoEnabled(), "tempoEnabled() true once env is set (test setup sanity check)");

// The gate's binding inputs - the SAME shape server.js passes: our secret,
// our realm, and a route price lookup. /paid costs $0.05 (50000 base units).
const GATE_SECRET = "gate-secret-for-group-2";
const REALM = "test.local";
const priceFor = (_method, path) => (path === "/paid" ? { priceUsd: 0.05 } : path === "/pricier" ? { priceUsd: 0.5 } : null);
const GATE = { secretKey: GATE_SECRET, realm: REALM, priceFor };
// Prod's dispatcher: a request the tempo gate did not mark as settling hits
// the PoW/x402 paywall and gets a 402. The stub is that paywall, so a
// credential the gate REJECTS must never reach a handler here either.
const paywallStub = (req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" }));

/** Valid by default (HMAC with the gate's secret, our realm/recipient/
 *  currency, Tempo mainnet chain, the /paid price); overrides build the
 *  forgeries the binding check must refuse. Raw integer base-units amount
 *  string (50000 = $0.05 at 6 decimals) - a real mppx client throws on a
 *  decimal string (caught live 2026-08-17). */
// A PULL credential by default (payload.type "transaction": a real Tempo
// transaction signed by a throwaway key, so the sender recovery the gate does
// is exercised); `push: true` builds a PUSH credential (the hash of a transfer
// the buyer already sent).
function buildTempoCredential(o = {}) {
  const challenge = Challenge.from({
    realm: o.realm ?? REALM,
    method: "tempo",
    intent: "charge",
    expires: o.expires ?? new Date(Date.now() + 60_000),
    request: { amount: o.amount ?? "50000", currency: o.currency ?? TEMPO_CURRENCY, decimals: 6, recipient: o.recipient ?? TREASURY, methodDetails: { chainId: o.chainId ?? 4217 } },
    secretKey: o.secretKey ?? GATE_SECRET,
  });
  const payload = o.payload ?? (o.push ? { hash: `0x${"ab".repeat(32)}`, type: "hash" } : { signature: o.signature ?? SIGNED_TX, type: "transaction" });
  return Credential.serialize({ challenge, payload, ...(o.source ? { source: o.source } : {}) });
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Case A: valid credential, handler succeeds -> handler runs BEFORE broadcast, receipt attached.
{
  const callOrder = [];
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => { callOrder.push("validate"); return { ok: true, validation: {} }; },
    broadcast: async () => { callOrder.push("broadcast"); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }; },
  }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => { callOrder.push("handler"); res.status(200).json({ result: "ok" }); });
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 200, "case A: successful handler -> 200");
  ok(body.result === "ok", "case A: original handler body is delivered");
  ok(!!res.headers.get("payment-receipt"), "case A: Payment-Receipt header attached");
  ok(isDeepOrderOk(callOrder, ["validate", "handler", "broadcast"]), `case A: strict order validate -> handler -> broadcast (got ${callOrder.join(",")})`);
  server.close();
}

// Case B: valid credential, handler FAILS -> broadcast never called, buyer never charged.
{
  const callOrder = [];
  let broadcastCalled = false;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => { callOrder.push("validate"); return { ok: true, validation: {} }; },
    broadcast: async () => { broadcastCalled = true; return { ok: true, receipt: {} }; },
  }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => { callOrder.push("handler"); res.status(500).json({ error: "upstream broke" }); });
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 500, "case B: handler's own failure status is preserved");
  ok(body.error === "upstream broke", "case B: original error body is delivered");
  ok(broadcastCalled === false, "case B: broadcast is NEVER called after a failed handler (buyer not charged)");
  server.close();
}

// Case C: valid credential, handler succeeds, broadcast FAILS -> 402, not a 200 with a broken receipt.
{
  const app = express();
  app.use(paymentRequiredBodyMiddleware()); // prod mount order: before the gate
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "relay temporarily unavailable", reason: "relay temporarily unavailable" }),
  }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => res.status(200).json({ result: "should never reach the buyer" }));
  const { server, url } = await listen(app);
  // This path was SILENT through the first live settlement (2026-08-18): a
  // 23s broadcast failure answered 402 with nothing in our logs. Capture
  // console.warn and require the failure to be logged with per-phase timing.
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(" ")); };
  let res, body;
  try {
    res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
    body = await res.json();
  } finally { console.warn = origWarn; }
  ok(res.status === 402, "case C: broadcast failure after a successful handler -> 402, not 200");
  ok(body.result === undefined, "case C: the handler's original body is discarded, never leaked to the buyer");
  ok(typeof body.detail === "string" && body.detail.includes("unavailable"), "case C: the failure reason is surfaced (RFC 9457 detail)");
  ok(body.type === "https://paymentauth.org/problems/verification-failed" && body.status === 402 && /application\/problem\+json/.test(res.headers.get("content-type") || ""), `case C: settle failure is an RFC 9457 problem (type=${body.type}, ct=${res.headers.get("content-type")})`);
  ok(!res.headers.get("payment-required") && PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in body)), "case C: a direct problem has no PAYMENT-REQUIRED header, so its body states no offer");
  const line = warned.find((w) => w.includes("[mpp-tempo] broadcast failed"));
  ok(!!line && line.includes("unavailable"), "case C: the broadcast failure is LOGGED with the relay's reason (was a silent 402 before 2026-08-18)");
  ok(!!line && /validate=\d+ms handler=\d+ms broadcast=\d+ms/.test(line), "case C: the log line carries per-phase timing (validBefore is 25s on this rail; latency vs verdict must be distinguishable)");
  server.close();
}

// Case D: credential present but validate() rejects -> falls through untouched, no handler bypass flag set.
{
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: false, error: "expired", reason: "expired" }),
    broadcast: async () => ({ ok: true, receipt: {} }),
  }));
  let downstream = null;
  app.use((req, res) => { downstream = { fallenThrough: true, tempoSettling: !!req.tempoSettling }; res.status(402).json({ fallenThrough: true }); });
  const { server, url } = await listen(app);
  // /paid is priced, so the binding check PASSES and validate() is what rejects
  // (on /anything the binding check would refuse first: "route has no price").
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 402, "case D: invalid credential falls through to the next middleware's own 402");
  ok(downstream?.fallenThrough === true, "case D: request reaches downstream middleware untouched");
  ok(downstream?.tempoSettling === false, "case D: req.tempoSettling is never set for a rejected credential");
  // ...but the downstream 402's BODY is rewritten into the spec's problem+json
  // (RFC 9457) naming why the credential was refused; a 200 would be untouched.
  ok(body.type === "https://paymentauth.org/problems/verification-failed" && /expired/.test(body.detail || "") && body.fallenThrough === undefined && /problem\+json/.test(res.headers.get("content-type") || ""), `case D: the fall-through 402 body is an RFC 9457 verification-failed problem carrying the relay's reason (${body.type}: ${body.detail})`);
  let okBody = null;
  const app2 = express();
  app2.use(createTempoGate({ ...GATE, validate: async () => ({ ok: false, error: "expired", reason: "expired" }), broadcast: async () => ({ ok: true, receipt: {} }) }));
  app2.use((req, res) => res.status(200).json({ free: true }));
  const s2 = await listen(app2);
  okBody = await (await fetch(`${s2.url}/paid`, { headers: { Authorization: buildTempoCredential() } })).json();
  ok(okBody.free === true, "case D: a non-402 downstream response is never rewritten (only the 402 body becomes the problem)");
  s2.server.close();
  // Prod mount order: the body mirror sits BEFORE the gate, so the problem
  // patch delegates to it. When the paywall's 402 carries PAYMENT-REQUIRED,
  // the problem document also carries the header's offer (no `error`: the
  // problem's detail is the explanation).
  const OFFER = { x402Version: 2, error: "Payment required", resource: { url: "http://x/paid", description: "paid", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "50000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
  const app3 = express();
  app3.use(paymentRequiredBodyMiddleware());
  app3.use(createTempoGate({ ...GATE, validate: async () => ({ ok: false, error: "expired", reason: "expired" }), broadcast: async () => ({ ok: true, receipt: {} }) }));
  app3.use((req, res) => { res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(OFFER)).toString("base64")); res.status(402).json({}); });
  const s3 = await listen(app3);
  const r3 = await fetch(`${s3.url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const b3 = await r3.json();
  ok(r3.status === 402 && b3.type === "https://paymentauth.org/problems/verification-failed" && /expired/.test(b3.detail || "") && /problem\+json/.test(r3.headers.get("content-type") || ""), `case D: with the header present the fall-through body is still the problem (${b3.type})`);
  ok(!("error" in b3) && Object.keys(OFFER).filter((k) => k !== "error").every((k) => isDeepStrictEqual(b3[k], OFFER[k])), "case D: ...and it mirrors the PAYMENT-REQUIRED offer key for key, with no error beside its detail");
  s3.server.close();
  server.close();
}

// Case E: no tempo credential at all (plain request) -> completely unaffected, validate/broadcast never invoked.
{
  let validateCalled = false, broadcastCalled = false;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => { validateCalled = true; return { ok: true, validation: {} }; },
    broadcast: async () => { broadcastCalled = true; return { ok: true, receipt: {} }; },
  }));
  app.get("/free", (req, res) => res.status(200).json({ untouched: true }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/free`);
  const body = await res.json();
  ok(res.status === 200 && body.untouched === true, "case E: a plain request (no tempo credential) passes through unaffected");
  ok(!validateCalled && !broadcastCalled, "case E: validate/broadcast are never invoked for a non-tempo request");
  server.close();
}

// Case F: the SAME credential fired CONCURRENTLY at the same route -> the
// replay guard rejects the second before its handler ever runs. This is
// the real vulnerability the guard closes: without it, this gate bypasses
// the whole PoW/replay-guard/x402mw dispatcher (replay-guard.js only
// understands EIP-3009 nonces), so one signed credential could trigger N
// free handler executions before Tempo's relay ever sees the duplicate.
{
  const replayGuard = createReplayGuard();
  let handlerRuns = 0;
  const app = express();
  // Prod mount order: the challenge APPENDER sits before the gate, so the
  // gate's own direct 402s (replay, settle failure) carry a fresh tempo
  // challenge at writeHead - the spec's "402 + fresh challenge + problem".
  app.use(createTempoChallengeAppender(GATE));
  app.use(paymentRequiredBodyMiddleware());
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    replayGuard,
  }));
  app.use(paywallStub);
  app.get("/paid", async (req, res) => {
    handlerRuns++;
    await sleep(150); // widen the race window so both requests are genuinely in flight together
    res.status(200).json({ result: "ok" });
  });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const [r1, r2] = await Promise.all([
    fetch(`${url}/paid`, { headers: { Authorization: cred } }),
    fetch(`${url}/paid`, { headers: { Authorization: cred } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  ok(handlerRuns === 1, `case F: the SAME credential fired concurrently -> the handler runs exactly once, not twice (got ${handlerRuns})`);
  ok(statuses[0] === 200 && statuses[1] === 402, `case F: one request succeeds, the concurrent replay is rejected 402 (spec: invalid-challenge problem + fresh challenge, not a bare 409) (got ${statuses.join(",")})`);
  const replayRes = r1.status === 402 ? r1 : r2;
  const replayBody = await replayRes.json().catch(() => ({}));
  ok(replayBody.type === "https://paymentauth.org/problems/invalid-challenge" && /problem\+json/.test(replayRes.headers.get("content-type") || "") && /already used|in flight/.test(replayBody.detail || ""), `case F: the replay's body is an RFC 9457 invalid-challenge problem (${replayBody.type})`);
  ok(/method="tempo"|method=tempo|tempo/.test(replayRes.headers.get("www-authenticate") || ""), "case F: the replay 402 carries a FRESH tempo challenge (WWW-Authenticate: Payment)");
  ok(!replayRes.headers.get("payment-required") && PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in replayBody)), "case F: the direct replay problem has no PAYMENT-REQUIRED header, so its body states no offer");
  server.close();
}

// Case G: release-on-failure -> a credential whose attempt failed (never
// consumed) can be legitimately retried, same as replay-guard.js's own
// "release when NOT granted" rule for the x402 side.
{
  const replayGuard = createReplayGuard();
  let handlerRuns = 0;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    replayGuard,
  }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => {
    handlerRuns++;
    res.status(handlerRuns === 1 ? 500 : 200).json({ result: handlerRuns === 1 ? "boom" : "ok" });
  });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const r1 = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
  ok(r1.status === 500, "case G: first attempt fails (handler error) -> claim released, not consumed");
  const r2 = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
  ok(r2.status === 200, "case G: the SAME credential retried after a released failure succeeds (not treated as a replay)");
  ok(handlerRuns === 2, `case G: handler ran for both the failed attempt and the successful retry (got ${handlerRuns})`);
  server.close();
}

// Case H (2026-08-18 security review): the binding check. Before it, the gate
// handed the CLIENT-ECHOED challenge to validate()/broadcast() with no HMAC
// check and no route-price check, so a forged 1-base-unit challenge to any
// recipient bought any paid route. Each forgery below must be refused BEFORE
// validate() (no relay round trip), never reach the handler, and land on the
// paywall's 402; the honest credential must still work.
{
  const cases = [
    ["wrong secret (not minted by us)", buildTempoCredential({ secretKey: "attacker" })],
    ["amount below the route price ($0.001 challenge on a $0.05 route)", buildTempoCredential({ amount: "1000" })],
    ["recipient is not our payTo", buildTempoCredential({ recipient: "0x1111111111111111111111111111111111111111" })],
    ["currency we do not offer", buildTempoCredential({ currency: "0x3000000000000000000000000000000000000000" })],
    ["wrong chain", buildTempoCredential({ chainId: 8453 })],
    ["expired", buildTempoCredential({ expires: new Date(Date.now() - 1000) })],
    ["foreign realm", buildTempoCredential({ realm: "evil.example" })],
  ];
  for (const [label, cred] of cases) {
    let validateCalls = 0, handlerRuns = 0;
    const app = express();
    app.use(createTempoGate({ ...GATE, validate: async () => { validateCalls++; return { ok: true, validation: {} }; }, broadcast: async () => ({ ok: true, receipt: {} }) }));
    app.use(paywallStub);
    app.get("/paid", (_req, res) => { handlerRuns++; res.json({ result: "served" }); });
    const { server, url } = await listen(app);
    const r = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
    ok(r.status === 402 && validateCalls === 0 && handlerRuns === 0, `case H: ${label} -> 402 before validate() (validate=${validateCalls}, handler=${handlerRuns}, status=${r.status})`);
    server.close();
  }
  // a valid $0.05 challenge presented to a $0.50 route: minted by us, but not for that price
  {
    let handlerRuns = 0;
    const app = express();
    app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }), broadcast: async () => ({ ok: true, receipt: {} }) }));
    app.use(paywallStub);
    app.get("/pricier", (_req, res) => { handlerRuns++; res.json({ result: "served" }); });
    const { server, url } = await listen(app);
    const r = await fetch(`${url}/pricier`, { headers: { Authorization: buildTempoCredential() } });
    ok(r.status === 402 && handlerRuns === 0, "case H: a genuinely minted cheap-route challenge does not buy a pricier route");
    // and a route with no price at all
    const r2 = await fetch(`${url}/free`, { headers: { Authorization: buildTempoCredential() } });
    ok(r2.status !== 200 || handlerRuns === 0, "case H: a tempo credential on an unpriced route never marks the request as settling");
    server.close();
  }
  // the pure function agrees, with reasons
  const okB = checkTempoCredentialBinding(buildTempoCredential(), { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" });
  ok(okB.ok === true && okB.amountAtomic === 50000n && okB.expectedAtomic === 50000n, "checkTempoCredentialBinding: honest credential passes with amount + expected");
  ok(/HMAC/.test(checkTempoCredentialBinding(buildTempoCredential({ secretKey: "x" }), { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" }).reason || ""), "checkTempoCredentialBinding: names the HMAC failure");
  ok(/no MPP_SECRET_KEY/.test(checkTempoCredentialBinding(buildTempoCredential(), { secretKey: "", realm: REALM, priceFor, method: "GET", path: "/paid" }).reason || ""), "checkTempoCredentialBinding: refuses when the server has no secret");
  ok(createTempoGate({ validate: async () => ({ ok: true }), broadcast: async () => ({ ok: true }) }) === null, "createTempoGate without secretKey/priceFor refuses to mount (fail closed)");
  ok(mintTempoChallenge({ priceUsd: 0.001, realm: REALM, secretKey: "" }) === null, "mintTempoChallenge without a secret mints nothing (an unkeyed HMAC is forgeable)");
}

// Case I (2026-08-18 security review): a STREAMING handler (the LLM gateway's
// SSE writer does writeHead + flushHeaders + write + end) under a successful
// settlement must reach the buyer as a 200 with its body. Node's
// flushHeaders() calls writeHead() internally; unbuffered, the replay of the
// buffered writeHead threw ERR_HTTP_HEADERS_SENT after broadcast - the buyer
// was charged and the response hung. And under a FAILED broadcast nothing
// may leak: a clean 402, no streamed bytes.
{
  const app = express();
  let broadcasts = 0;
  app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }), broadcast: async () => { broadcasts++; return { ok: true, receipt: { method: "tempo", status: "success", reference: "0xfeed", timestamp: new Date().toISOString() } }; } }));
  app.use(paywallStub);
  app.get("/paid", (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders?.(); res.write("data: one\n\n"); res.write("data: [DONE]\n\n"); res.end(); });
  const { server, url } = await listen(app);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 4000);
  let status = 0, body = "", receipt = null, hung = false;
  try { const r = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() }, signal: ac.signal }); status = r.status; receipt = r.headers.get("payment-receipt"); body = await r.text(); } catch { hung = true; }
  clearTimeout(timer);
  ok(!hung && status === 200 && /data: \[DONE\]/.test(body) && !!receipt && broadcasts === 1, `case I: streaming handler (flushHeaders) settles once and the buyer receives the 200 stream (hung=${hung} status=${status} broadcasts=${broadcasts})`);
  server.close();
}
{
  const app = express();
  app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }), broadcast: async () => ({ ok: false, error: "relay down", reason: "relay down" }) }));
  app.use(paywallStub);
  app.get("/paid", (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders?.(); res.write("data: secret\n\n"); res.end(); });
  const { server, url } = await listen(app);
  const r = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await r.text();
  ok(r.status === 402 && !/secret/.test(body), `case I: streaming handler + failed broadcast -> 402, nothing streamed (status=${r.status})`);
  server.close();
}

function isDeepOrderOk(actual, expected) {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

// Case J (security review 2026-08-19): a tempo-settling request must not carry
// an unverified x402 payer. The dispatcher skips x402 verification once the
// tempo gate accepts, so a forged PAYMENT-SIGNATURE riding alongside the tempo
// credential would be read by payerFromRequest() as the payer (memory identity,
// my-usage, idempotency seeding). The gate drops those headers on acceptance.
{
  const { payerFromRequest, paymentIdentifierOf } = await import("../src/payer.js");
  const app = express();
  app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }), broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0x0j", timestamp: new Date().toISOString() } }) }));
  app.use((req, res, next) => (req.tempoSettling ? next() : res.status(402).json({})));
  app.get("/paid", (req, res) => res.json({ actor: payerFromRequest(req), pid: paymentIdentifierOf(req), xp: req.headers["x-payment"] ?? null }));
  const { server, url } = await listen(app);
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from: "0x1111111111111111111111111111111111111111" } }, extensions: { "payment-identifier": { info: { id: "attacker-id" } } } })).toString("base64");
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential(), "PAYMENT-SIGNATURE": forged, "X-PAYMENT": forged } });
  const body = await res.json();
  ok(res.status === 200 && body.actor === null && body.pid === null && body.xp === null, `case J: a forged x402 payer header alongside a tempo credential is dropped before the handler (actor ${body.actor}, pid ${body.pid})`);
  server.close();
}

// Case K (same review): identity-bound routes (wallet-keyed memory, my-usage)
// are never payable over Tempo - no tempo challenge is minted for them and a
// tempo credential for one is refused at the binding check, before any relay
// call, as an RFC 9457 problem on the fall-through 402.
{
  const priceForId = (_m, path) => (path === "/memory" ? { priceUsd: 0.05, identityBound: true } : priceFor(_m, path));
  const b = checkTempoCredentialBinding(buildTempoCredential(), { secretKey: GATE_SECRET, realm: REALM, priceFor: priceForId, method: "GET", path: "/memory" });
  ok(b.ok === false && /identity/.test(b.reason || ""), `case K: binding refuses a tempo credential on an identity-bound route (${b.reason})`);
  let validateCalls = 0;
  const app = express();
  app.use(createTempoChallengeAppender({ ...GATE, priceFor: priceForId }));
  app.use(createTempoGate({ ...GATE, priceFor: priceForId, validate: async () => { validateCalls++; return { ok: true, validation: {} }; }, broadcast: async () => ({ ok: true, receipt: {} }) }));
  app.use((req, res) => (req.tempoSettling ? res.json({ served: true }) : res.status(402).json({})));
  const { server, url } = await listen(app);
  const bare = await fetch(`${url}/memory`);
  const www = bare.headers.get("www-authenticate") || "";
  ok(bare.status === 402 && !/tempo/i.test(www), `case K: no tempo challenge is minted on an identity-bound route's 402 (WWW-Authenticate: ${www.slice(0, 40) || "(none)"})`);
  const paidBare = await fetch(`${url}/paid`);
  ok(/tempo/i.test(paidBare.headers.get("www-authenticate") || ""), "case K: an ordinary paid route still gets its tempo challenge");
  const res = await fetch(`${url}/memory`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 402 && validateCalls === 0 && /identity/.test(body.detail || ""), `case K: a tempo credential on an identity-bound route is refused before any relay call (${res.status}, validate calls ${validateCalls}: ${String(body.detail).slice(0, 80)})`);
  server.close();
}

// ---------------------------------------------------------------------------
// First-session findings (2026-09-24): every refusal says WHY in a class the
// buyer can act on, every refusal is logged, a relay outage is a 503, a bad
// body is refused before the relay, and a client that hung up is not charged.
// ---------------------------------------------------------------------------
const { classifyTempoRefusal, TEMPO_REFUSAL_CLASSES, bindingRefusal } = await import("../src/mpp-tempo.js");
async function withWarnings(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => { warned.push(a.join(" ")); };
  try { return { value: await fn(), warned }; } finally { console.warn = orig; }
}

// Case L: classification of the relay's REAL verdict shapes. The memo line is
// the exact 2026-09-20 relay body; the class is read from it, never copied out.
{
  const traced = (relayError, extra = {}) => Object.assign(new Error("Payment verification failed."), { __relayTrace: { relayError, ...extra } });
  const memo = traced('relay /v1/mpp/validate HTTP 200 {"error":{"code":"unknown","message":"Payment verification failed: memo is not bound to this challenge."},"success":false}');
  ok(classifyTempoRefusal(memo) === "memo-unbound", "case L: the live 'memo is not bound' relay body classifies as memo-unbound");
  ok(classifyTempoRefusal(traced('relay /v1/mpp/validate HTTP 200 {"error":{"code":"unknown","message":"Invalid transaction: no matching payment call found - amount: 1000"}}')) === "transfer-mismatch", "case L: 'no matching payment call' is transfer-mismatch (amount/currency/recipient)");
  ok(classifyTempoRefusal(traced("relay /v1/mpp/validate NETWORK ERROR after 10321ms: UND_ERR_CONNECT_TIMEOUT (attempts 2)", { networkError: true })) === "relay-unreachable", "case L: a connect timeout is relay-unreachable");
  ok(classifyTempoRefusal(traced('relay /v1/mpp/validate HTTP 403 {"error":{"code":"api_key_scope_missing"}}', { relayUnavailable: 403 })) === "relay-unavailable", "case L: a relay 401/403/5xx (our key or their outage) is relay-unavailable, never blamed on the buyer");
  ok(classifyTempoRefusal(Object.assign(new Error("Payment verification failed."), { details: { code: "expired" } })) === "expired", "case L: relay code expired -> expired");
  ok(classifyTempoRefusal(Object.assign(new Error("Payment verification failed."), { details: { code: "insufficient_funds" } })) === "insufficient-funds", "case L: relay code insufficient_funds -> insufficient-funds");
  ok(classifyTempoRefusal(Object.assign(new Error("Transaction hash has already been used"), {})) === "replay", "case L: an already-used hash is replay");
  const secretish = "tempo-api-key-SECRET-123";
  const leaky = traced(`relay /v1/mpp/validate HTTP 200 {"error":{"message":"memo is not bound to this challenge (key ${secretish})"}}`);
  const cls = classifyTempoRefusal(leaky);
  const doc = JSON.stringify({ ...TEMPO_REFUSAL_CLASSES[cls] });
  ok(cls === "memo-unbound" && !doc.includes(secretish), "case L: the buyer-facing words are a fixed table: nothing from the relay body is relayed");
  for (const [name, c] of Object.entries(TEMPO_REFUSAL_CLASSES)) {
    ok(typeof c.detail === "string" && c.detail.length > 20 && typeof c.hint === "string" && c.hint.length > 20, `case L: class ${name} carries a specific detail and hint`);
  }
  const b = bindingRefusal("challenge expired");
  ok(b.cls === "expired" && b.kind === "payment-expired" && /fresh challenge/.test(b.hint || ""), "case L: a binding refusal has a class, a spec type and a next step");
}

// Case M: the memo refusal reaches the buyer as a specific problem, and the
// refusal is logged with class, route, amount and timing - no payer address.
{
  const payer = "0x1111111111111111111111111111111111111111";
  const app = express();
  app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: false, cls: "memo-unbound", reason: "Payment verification failed.", error: `Payment verification failed. relay /v1/mpp/validate HTTP 200 {"source":"did:pkh:eip155:4217:${payer}","message":"memo is not bound to this challenge."}` }), broadcast: async () => ({ ok: true, receipt: {} }) }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => res.json({ served: true }));
  const { server, url } = await listen(app);
  const { value: res, warned } = await withWarnings(async () => { const r = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } }); return { status: r.status, body: await r.json() }; });
  ok(res.status === 402 && /memo is not bound/.test(res.body.detail) && /agent402\.tools/.test(res.body.hint || "") && res.body.details?.reason === "memo-unbound", `case M: the memo refusal names the cause and the fix (${res.body.detail})`);
  const line = warned.find((w) => w.includes("[mpp-tempo] refused"));
  ok(!!line && /class=memo-unbound/.test(line) && /route="GET \/paid"/.test(line) && /amount=50000/.test(line) && /validate=\d+ms/.test(line), `case M: one refusal line with class, route, amount and timing (${line})`);
  ok(!!line && !line.toLowerCase().includes(payer.slice(2)) && !/did:pkh:eip155/.test(line), "case M: the log line masks the payer address and the did:pkh source");
  server.close();
}

// Case N: the relay is unreachable BEFORE validation -> 503 + Retry-After,
// nothing validated or broadcast, the handler never runs, no demotion.
{
  let handlerRan = false, broadcastCalled = false;
  const { _resetTempoDemotion, tempoLeads } = await import("../src/mpp-tempo.js");
  _resetTempoDemotion();
  const app = express();
  app.use(createTempoGate({ ...GATE, validate: async () => ({ ok: false, cls: "relay-unreachable", reason: "Payment verification failed.", error: "relay /v1/mpp/validate NETWORK ERROR after 10000ms: UND_ERR_CONNECT_TIMEOUT (attempts 2)" }), broadcast: async () => { broadcastCalled = true; return { ok: true, receipt: {} }; } }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => { handlerRan = true; res.json({ served: true }); });
  const { server, url } = await listen(app);
  const { value: r, warned } = await withWarnings(async () => { const x = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential(), "User-Agent": "agent/9" } }); return { status: x.status, retry: x.headers.get("retry-after"), body: await x.json() }; });
  ok(r.status === 503 && Number(r.retry) > 0, `case N: an unreachable relay answers 503 with Retry-After (got ${r.status}, Retry-After ${r.retry})`);
  ok(r.body.type === "https://paymentauth.org/problems/internal-payment-error" && r.body.details?.charged === false && /nothing was charged/i.test(r.body.detail), "case N: the problem says the relay was unreachable and nothing was charged");
  ok(!handlerRan && !broadcastCalled, "case N: no handler run, no broadcast");
  ok(tempoLeads({ ip: "127.0.0.1", headers: { "user-agent": "agent/9" } }) === true, "case N: our relay outage does not demote the buyer's tempo challenge");
  ok(warned.some((w) => /class=relay-unreachable/.test(w)), "case N: the refusal is logged");
  server.close();
}

// Case O: a paid credential with a body the handler would refuse is answered
// 400 BEFORE the relay round trip; an unpaid request still gets its 402.
{
  let validateCalls = 0;
  const { preValidateInput } = await import("../src/handler-input.js");
  const def = { slug: "paid-tool", discovery: { inputSchema: { required: ["text"], properties: { text: { type: "string" } } }, input: { text: "hello" } } };
  const app = express();
  app.use(express.json());
  app.use(createTempoGate({ ...GATE, preValidate: (req) => preValidateInput(def, req), validate: async () => { validateCalls++; return { ok: true, validation: {} }; }, broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0x01", timestamp: new Date().toISOString() } }) }));
  app.use(paywallStub);
  app.post("/paid", (req, res) => res.json({ echoed: req.body.text }));
  const { server, url } = await listen(app);
  const unpaid = await fetch(`${url}/paid`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(unpaid.status === 402, "case O: an UNPAID bad body still gets the 402 first (same order as x402)");
  const { value: bad, warned } = await withWarnings(async () => { const r = await fetch(`${url}/paid`, { method: "POST", headers: { "content-type": "application/json", Authorization: buildTempoCredential() }, body: "{}" }); return { status: r.status, body: await r.json() }; });
  ok(bad.status === 400 && validateCalls === 0, `case O: a paid bad body is refused 400 before any relay call (status ${bad.status}, validate calls ${validateCalls})`);
  ok(/Missing required parameter: text/.test(bad.body.error) && bad.body.tool === "paid-tool" && Array.isArray(bad.body.required) && bad.body.example?.text === "hello" && bad.body.charged === false, "case O: the 400 carries the self-correcting envelope and says nothing was charged");
  ok(warned.some((w) => /class=input-invalid/.test(w)), "case O: the pre-validation refusal is logged");
  const good = await fetch(`${url}/paid`, { method: "POST", headers: { "content-type": "application/json", Authorization: buildTempoCredential() }, body: JSON.stringify({ text: "x" }) });
  ok(good.status === 200 && validateCalls === 1, "case O: a good body proceeds to validation and settles");
  // A tool's own pure validator is honoured, and only its 4xx.
  const judgeLike = { slug: "j", discovery: { inputSchema: { required: ["state"] } }, validateInput: (i) => { if (typeof i.questions !== "object") { const e = new Error('"questions" must be a map'); e.statusCode = 400; throw e; } } };
  ok(/questions/.test(preValidateInput(judgeLike, { body: { state: "s" }, query: {} })?.body?.error || ""), "case O: a tool's validateInput 400 is used before the relay");
  const crashy = { slug: "c", discovery: { inputSchema: {} }, validateInput: () => { throw new Error("boom"); } };
  ok(preValidateInput(crashy, { body: {}, query: {} }) === null, "case O: a non-4xx throw from validateInput is left to the handler");
  server.close();
}

// Case P: every refusal path leaves a line - binding, replay, malformed.
{
  const app = express();
  app.use(createTempoGate({ ...GATE, replayGuard: createReplayGuard(), validate: async () => ({ ok: true, validation: {} }), broadcast: async () => { await sleep(150); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0x02", timestamp: new Date().toISOString() } }; } }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => res.json({ ok: 1 }));
  const { server, url } = await listen(app);
  const { warned, value } = await withWarnings(async () => {
    const expired = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential({ expires: new Date(Date.now() - 1000) }) } });
    const eb = await expired.json();
    const cred = buildTempoCredential();
    await Promise.all([fetch(`${url}/paid`, { headers: { Authorization: cred } }), sleep(20).then(() => fetch(`${url}/paid`, { headers: { Authorization: cred } }))]);
    await fetch(`${url}/paid`, { headers: { Authorization: "Payment not-a-credential" } });
    return eb;
  });
  ok(value.type === "https://paymentauth.org/problems/payment-expired" && value.details?.reason === "expired" && typeof value.hint === "string", `case P: an expired challenge is a payment-expired problem with a hint (${value.type})`);
  ok(warned.some((w) => /refused class=expired/.test(w)), "case P: the binding refusal is logged with its class");
  ok(warned.some((w) => /refused class=replay/.test(w)), "case P: a replayed credential is logged (it used to leave no line)");
  ok(warned.some((w) => /refused class=malformed/.test(w)), "case P: an undecodable Payment credential is logged");
  server.close();
}

// Case Q: a client that disconnects while the handler runs. The route here
// mimics the dispatcher: it reserves a hang-up forgiveness ticket when the
// handler starts (src/hangup-forgiveness.js). WITH a granted ticket the
// credential is NOT broadcast (nothing charged, the credential stays spent,
// the hook sees no settlement); WITHOUT one (the budget is spent) it IS
// broadcast and the hook sees the settled charge server.js books as owed.
{
  const { createHangupSettlementHook, clientGoneBeforeFirstByte } = await import("../src/hangup-settlement.js");
  const { reserveHangupForgiveness, settleHangupTicket, _resetHangupForgiveness } = await import("../src/hangup-forgiveness.js");
  _resetHangupForgiveness();
  let broadcasts = 0, handlerRuns = 0;
  const undelivered = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, res, kind) => undelivered.push({ kind, tempoSettled: req.tempoSettled === true, status: res.statusCode, receipt: res.getHeader("Payment-Receipt") || null }) }));
  app.use(createTempoGate({ ...GATE, replayGuard: createReplayGuard(), validate: async () => ({ ok: true, validation: {} }), broadcast: async () => { broadcasts++; return { ok: true, receipt: { method: "tempo", status: "success", reference: `0x0a${broadcasts}`, timestamp: new Date().toISOString() } }; } }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => {
    handlerRuns++;
    // A ticket only when the test asks for one (x-grant); keyed like server.js.
    if (req.headers["x-grant"] === "1") reserveHangupForgiveness(req, { keys: [req.mppTempoSender ? `tempo:${req.mppTempoSender}` : null, "ip:q"], priceUsd: 0.05 });
    res.once("close", () => settleHangupTicket(req, { abandoned: clientGoneBeforeFirstByte(req) }));
    setTimeout(() => res.json({ late: true }), 400);
  });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const { warned } = await withWarnings(async () => {
    await fetch(`${url}/paid`, { headers: { Authorization: cred, "x-grant": "1" }, signal: AbortSignal.timeout(100) }).catch(() => null);
    await sleep(700);
  });
  ok(broadcasts === 0, `case Q: with a forgiveness ticket, the credential of a client that hung up mid-handler is NOT broadcast (broadcasts ${broadcasts})`);
  ok(undelivered.length === 1 && !undelivered[0].tempoSettled && undelivered[0].kind === "end" && undelivered[0].receipt === null && undelivered[0].status === 499, `case Q: the hang-up hook sees the undelivered end once, with no settlement on it (${JSON.stringify(undelivered)})`);
  ok(warned.some((w) => /\[mpp-tempo\] client gone before the handler's answer could be sent[^\n]*not broadcast, not charged/.test(w)), "case Q: the gate says it did not broadcast");
  const again = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
  ok(again.status === 402 && handlerRuns === 1 && broadcasts === 0, `case Q: the same credential is still spent and cannot run the handler again (status ${again.status}, handler runs ${handlerRuns})`);
  // No ticket (budget spent): the hang-up is broadcast, and the hook sees the
  // settled charge - the point where server.js books it as owed.
  await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() }, signal: AbortSignal.timeout(100) }).catch(() => null);
  await sleep(700);
  ok(broadcasts === 1 && undelivered.length === 2 && undelivered[1].tempoSettled && !!undelivered[1].receipt, `case Q: WITHOUT a ticket the hang-up is broadcast and the hook sees the settled charge (broadcasts ${broadcasts}, ${JSON.stringify(undelivered[1])})`);
  // Control: a client that stays connected is served, broadcast once, and nothing is flagged.
  const served = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential(), "x-grant": "1" } });
  ok(served.status === 200 && broadcasts === 2 && undelivered.length === 2, "case Q: a connected client is served and broadcast once; the hook stays quiet");
  server.close();
  _resetHangupForgiveness();
}

// Case S: a PUSH credential (payload.type "hash"). The buyer's transfer is on
// chain before the request arrives, so the gate finalizes it BEFORE the
// handler (the relay claims the hash) and marks the request settled: every
// answer that is not delivered is then a settled charge the server books as
// owed. Before this, a push hang-up or a push >= 400 was never finalized and
// never booked, and the buyer was told nothing was charged.
{
  const { createHangupSettlementHook } = await import("../src/hangup-settlement.js");
  const order = [];
  let broadcasts = 0, failNext = null;
  const undelivered = [];
  const seenSettled = [];
  const seenLedger = [];
  const notClaimed = [];
  const PUSH_FROM = "0x5555555555555555555555555555555555555555";
  const app = express();
  app.use(express.json());
  app.use(createHangupSettlementHook({ onUndelivered: (req, res) => undelivered.push({ tempoSettled: req.tempoSettled === true, receipt: res.getHeader("Payment-Receipt") || null, status: res.statusCode }) }));
  app.use(createTempoGate({
    ...GATE, replayGuard: createReplayGuard(),
    preValidate: (req) => (req.body?.text ? null : { status: 400, body: { error: "Missing required parameter: text" } }),
    validate: async () => { order.push("validate"); return { ok: true, validation: {} }; },
    broadcast: async () => { order.push("broadcast"); broadcasts++; if (failNext) { const f = failNext; failNext = null; return f; } return { ok: true, receipt: { method: "tempo", status: "success", reference: `0xpush${broadcasts}`, timestamp: new Date().toISOString() } }; },
    // The transfer's sender as the chain reports it (stubbed: offline).
    pushSender: async () => PUSH_FROM,
    onPushNotClaimed: async (_req, info) => { notClaimed.push(info); return true; },
  }));
  app.use(paywallStub);
  app.post("/paid", (req, res) => {
    order.push("handler");
    seenSettled.push(req.tempoSettled === true);
    // The sender read runs beside the handler; a booking waits for it.
    whenTempoLedgerPayerKnown(req, "test", () => seenLedger.push(req.mppTempoLedgerPayer ?? null));
    if (!req.body?.text || req.body.text === "bad") return res.status(400).json({ error: "handler refused the input" });
    if (req.body?.text === "slow") return setTimeout(() => res.json({ late: true }), 400);
    res.json({ ok: 1 });
  });
  const { server, url } = await listen(app);
  const post = (cred, text, extra = {}) => fetch(`${url}/paid`, { method: "POST", headers: { "content-type": "application/json", Authorization: cred }, body: JSON.stringify(text === undefined ? {} : { text }), ...extra });
  const r1 = await post(buildTempoCredential({ push: true, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" }), "x");
  ok(r1.status === 200 && !!r1.headers.get("payment-receipt") && isDeepOrderOk(order, ["validate", "broadcast", "handler"]) && seenSettled[0] === true, `case S: a push credential is finalized BEFORE the handler, which sees the request settled (order ${order.join(",")})`);
  for (let i = 0; i < 50 && seenLedger.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  ok(seenLedger[0] === PUSH_FROM, `case S: a push sale is booked under the sender the chain reports, never the client-written source (${seenLedger[0]})`);
  order.length = 0;
  const r2 = await post(buildTempoCredential({ push: true }), "bad");
  ok(r2.status === 400 && !!r2.headers.get("payment-receipt") && order.join(",") === "validate,broadcast,handler", `case S: a push credential whose handler refuses keeps its receipt (the finish path books it as owed) (status ${r2.status})`);
  order.length = 0;
  const typo = buildTempoCredential({ push: true });
  const r3 = await post(typo, undefined);
  const b3 = await r3.json();
  ok(r3.status === 400 && order.join(",") === "validate" && !r3.headers.get("payment-receipt") && b3.transferClaimed === false && /not been claimed/.test(b3.payment || "") && b3.error === "Missing required parameter: text",
    `case S: a push credential whose body the handler would refuse is answered by the input check AFTER the relay confirms the transfer and BEFORE it is claimed: no finalize, no handler, no receipt (order ${order.join(",")}, ${JSON.stringify(b3)})`);
  order.length = 0;
  const r3b = await post(typo, "x");
  ok(r3b.status === 200 && !!r3b.headers.get("payment-receipt") && order.join(",") === "validate,broadcast,handler", `case S: ...and the same credential with a corrected body is then served and claimed (${r3b.status}, order ${order.join(",")})`);
  order.length = 0;
  await post(buildTempoCredential({ push: true }), "slow", { signal: AbortSignal.timeout(100) }).catch(() => null);
  await sleep(700);
  ok(undelivered.length === 1 && undelivered[0].tempoSettled && !!undelivered[0].receipt, `case S: a push buyer who hangs up is a settled charge the hook sees (booked as owed) (${JSON.stringify(undelivered)})`);
  // The relay could not be reached to claim the hash: 503, the hash is NOT
  // claimed, the handler does not run, and the SAME credential then works.
  order.length = 0;
  failNext = { ok: false, cls: "relay-unreachable", error: "relay down", reason: "relay down" };
  const same = buildTempoCredential({ push: true });
  const r4 = await post(same, "x");
  const b4 = await r4.json();
  ok(r4.status === 503 && !order.includes("handler") && b4.details?.transferClaimed === false && Number(r4.headers.get("retry-after")) > 0, `case S: relay unreachable at finalize -> 503, handler not run, transfer not claimed (${r4.status} ${JSON.stringify(b4.details)})`);
  const r5 = await post(same, "x");
  ok(r5.status === 200 && order.filter((x) => x === "handler").length === 1, `case S: ... and the same credential is then served (${r5.status})`);
  // The hash was already claimed (a replay of a paid transfer): refused, no handler.
  order.length = 0;
  failNext = { ok: false, cls: "replay", error: "Transaction hash has already been used", reason: "Transaction hash has already been used" };
  const r6 = await post(buildTempoCredential({ push: true }), "x");
  ok(r6.status === 402 && !order.includes("handler") && notClaimed.length === 0, `case S: a push hash the relay already claimed is refused before the handler, and books no debt (it paid for an earlier request) (${r6.status})`);
  // Any other finalize refusal: the relay confirmed the transfer pays this
  // challenge, it was not claimed, nothing was delivered. Booked as owed
  // BEFORE the answer, keyed on the hash, under the chain-reported sender.
  order.length = 0;
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  const r7 = await post(buildTempoCredential({ push: true }), "x");
  const b7 = await r7.json();
  ok(r7.status === 402 && !order.includes("handler") && notClaimed.length === 1 && notClaimed[0].hash === `0x${"ab".repeat(32)}` && notClaimed[0].payer === PUSH_FROM && notClaimed[0].amountUsd === 0.05 && b7.details?.refundOwed === true,
    `case S: a push transfer the relay confirmed but could not claim is booked as owed (hash, chain sender, amount) before the 402 (${JSON.stringify(notClaimed)} ${JSON.stringify(b7.details)})`);
  server.close();
}

// Case T: the credential kinds and the recovered sender.
{
  ok(tempoSenderOf(buildTempoCredential()) === PULL_SIGNER.address.toLowerCase(), "case T: tempoSenderOf recovers the signer of a pull credential from its signed transaction");
  ok(tempoSenderOf(buildTempoCredential({ push: true })) === null && tempoSenderOf(buildTempoCredential({ signature: "0x76deadbeef" })) === null && tempoSenderOf("Payment junk") === null, "case T: no sender for a push credential, an undecodable transaction or junk (never throws)");
  // The `source` hint is client-supplied: a fresh one per request would be a
  // fresh per-buyer key. The recovered sender does not move.
  const spoofA = buildTempoCredential({ source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" });
  const spoofB = buildTempoCredential({ source: "did:pkh:eip155:4217:0x2222222222222222222222222222222222222222" });
  const bA = checkTempoCredentialBinding(spoofA, { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" });
  const bB = checkTempoCredentialBinding(spoofB, { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" });
  ok(bA.payerHint !== bB.payerHint && tempoSenderOf(spoofA) === tempoSenderOf(spoofB) && tempoSenderOf(spoofA) === PULL_SIGNER.address.toLowerCase(), "case T: two credentials naming different sources still recover the same sender");
  const { gatewaySettleBreakerKey } = await import("../src/gateway-settle-breaker.js");
  const reqA = { mppTempoPayer: bA.payerHint, mppTempoSender: tempoSenderOf(spoofA), ip: "1.2.3.4", headers: {}, header: () => undefined };
  const reqB = { mppTempoPayer: bB.payerHint, mppTempoSender: tempoSenderOf(spoofB), ip: "1.2.3.4", headers: {}, header: () => undefined };
  ok(gatewaySettleBreakerKey(reqA) === gatewaySettleBreakerKey(reqB) && gatewaySettleBreakerKey(reqA) === `tempo:${PULL_SIGNER.address.toLowerCase()}`, `case T: the settle breaker keys both on the recovered sender (three credentials from one signer, one key) (${gatewaySettleBreakerKey(reqA)})`);
  ok(gatewaySettleBreakerKey({ mppTempoPayer: bA.payerHint, ip: "1.2.3.4", headers: {}, header: () => undefined }) === "ip:1.2.3.4", "case T: a Tempo request with only the source hint keys on the client IP, never the hint");
  // "proof" credentials move no money and are refused before any relay call.
  const proof = buildTempoCredential({ payload: { signature: `0x${"cd".repeat(65)}`, type: "proof" } });
  const bp = checkTempoCredentialBinding(proof, { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" });
  ok(bp.ok === false && /payload type "proof" does not pay/.test(bp.reason || ""), `case T: a proof credential is refused at the binding check (${bp.reason})`);
  ok(checkTempoCredentialBinding(buildTempoCredential(), { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" }).payloadType === "transaction" && checkTempoCredentialBinding(buildTempoCredential({ push: true }), { secretKey: GATE_SECRET, realm: REALM, priceFor, method: "GET", path: "/paid" }).payloadType === "hash", "case T: the binding reports the credential kind");
  let validateCalls = 0;
  const app = express();
  app.use(createTempoGate({ ...GATE, validate: async () => { validateCalls++; return { ok: true, validation: {} }; }, broadcast: async () => ({ ok: true, receipt: {} }) }));
  app.use(paywallStub);
  app.get("/paid", (_req, res) => res.json({ served: true }));
  const { server, url } = await listen(app);
  const r = await fetch(`${url}/paid`, { headers: { Authorization: proof } });
  const body = await r.json();
  ok(r.status === 402 && validateCalls === 0 && body.type === "https://paymentauth.org/problems/malformed-credential", `case T: the gate refuses a proof credential before validate() (${r.status}, ${body.type})`);
  // The gate stamps the recovered sender on an accepted pull request.
  const app2 = express();
  app2.use(createTempoGate({ ...GATE, validate: async () => ({ ok: true, validation: {} }), broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0x0t", timestamp: new Date().toISOString() } }) }));
  app2.use(paywallStub);
  app2.get("/paid", (req, res) => res.json({ sender: req.mppTempoSender ?? null, hint: req.mppTempoPayer ?? null, ledger: req.mppTempoLedgerPayer ?? null }));
  const s2 = await listen(app2);
  const j = await (await fetch(`${s2.url}/paid`, { headers: { Authorization: spoofA } })).json();
  ok(j.sender === PULL_SIGNER.address.toLowerCase() && j.hint === "0x1111111111111111111111111111111111111111", `case T: an accepted pull request carries the recovered sender beside the classification hint (${JSON.stringify(j)})`);
  ok(j.ledger === PULL_SIGNER.address.toLowerCase(), `case T: the ledger payer of a pull sale is the recovered sender, never the spoofed source (${j.ledger})`);
  s2.server.close();
  server.close();
}

// Case Q2: the residual window. The handler has answered and the broadcast is
// in flight when the client leaves: the payment settles (the gate cannot see
// the close before it broadcasts), and the hook sees tempoSettled - the point
// where server.js books the charge as owed in the refund ledger.
{
  const { createHangupSettlementHook } = await import("../src/hangup-settlement.js");
  let broadcasts = 0, broadcastStarted = null;
  const started = new Promise((r) => { broadcastStarted = r; });
  const undelivered = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, res, kind) => undelivered.push({ kind, tempoSettled: req.tempoSettled === true, receipt: res.getHeader("Payment-Receipt") || null }) }));
  app.use(createTempoGate({ ...GATE, replayGuard: createReplayGuard(), validate: async () => ({ ok: true, validation: {} }), broadcast: async () => { broadcasts++; broadcastStarted(); await sleep(400); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0x0b", timestamp: new Date().toISOString() } }; } }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => res.json({ fast: true }));
  const { server, url } = await listen(app);
  const ctl = new AbortController();
  started.then(() => sleep(50)).then(() => ctl.abort());
  await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() }, signal: ctl.signal }).catch(() => null);
  await sleep(600);
  ok(broadcasts === 1, `case Q2: a client that leaves DURING the broadcast is charged (broadcasts ${broadcasts})`);
  ok(undelivered.length === 1 && undelivered[0].tempoSettled && undelivered[0].kind === "end" && !!undelivered[0].receipt, `case Q2: the hook sees the settled response it could not deliver - the residual debt (${JSON.stringify(undelivered)})`);
  server.close();
}

// Case R: a broadcast that fails AFTER a successful handler leaves the
// credential spent - presenting it again answers 402 without re-running the
// handler.
{
  let handlerRuns = 0, calls = 0;
  const app = express();
  app.use(createTempoGate({ ...GATE, replayGuard: createReplayGuard(), validate: async () => ({ ok: true, validation: {} }), broadcast: async () => { calls++; return { ok: false, error: "nope", reason: "nope" }; } }));
  app.use(paywallStub);
  app.get("/paid", (req, res) => { handlerRuns++; res.json({ ok: 1 }); });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const { value } = await withWarnings(async () => {
    const first = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
    const second = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
    return [first.status, second.status];
  });
  ok(value[0] === 402 && value[1] === 402 && handlerRuns === 1 && calls === 1, `case R: after a failed post-handler broadcast the credential stays spent (statuses ${value}, handler runs ${handlerRuns}, broadcasts ${calls})`);
  server.close();
}

facilitator.close();
relayStub.close();
// Wiring pin: server.js books every Tempo sale and debt under the payer the
// gate PROVED (tempoLedgerPayer), never the client-written source hint, and
// books an unclaimed push transfer as owed.
{
  const srv = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const hintReads = srv.split("\n").filter((l) => /req\.mppTempoPayer/.test(l) && !/^\s*\/\//.test(l));
  ok(hintReads.length === 0, `server.js never reads the Tempo source hint as a payer (${hintReads.join(" | ")})`);
  ok((srv.match(/tempoLedgerPayer\(req\)/g) || []).length >= 3, "server.js books Tempo sales, hang-up debts and charged-failure debts under tempoLedgerPayer(req)");
  ok(/onPushNotClaimed: \(req, info\) => tempoPushDebts\.notClaimed\(req, info\)/.test(srv), "server.js books an unclaimed push transfer through tempoPushDebts (scripts/test-tempo-push-debts.js drives it on the real ledger)");
}

console.log(`\n${pass} passed, 0 failed`);

// ---- tempo refusal demotes the tempo challenge for that client -------------
{
  const { noteTempoRefusal, tempoLeads, _resetTempoDemotion } = await import("../src/mpp-tempo.js");
  _resetTempoDemotion();
  const a = { ip: "203.0.113.5", headers: { "user-agent": "agent/1.0" } };
  const other = { ip: "203.0.113.6", headers: { "user-agent": "agent/1.0" } };
  ok(tempoLeads(a) === true, "tempo leads for a client with no refusal");
  ok(noteTempoRefusal(a) === true, "a refusal is recorded for a keyed client");
  ok(tempoLeads(a) === false, "after a tempo refusal that client gets evm first");
  ok(tempoLeads(other) === true, "another client is unaffected");
  ok(tempoLeads(a, Date.now() + 31 * 60 * 1000) === true, "the demotion lapses after its window");
  ok(noteTempoRefusal({ ip: "203.0.113.7", headers: {} }) === false, "a client with no User-Agent is never keyed");
  const src = (await import("node:fs")).readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  ok(/if \(!v\.ok\) \{[\s\S]{0,1800}noteTempoRefusal\(req\)/.test(src), "the validate-rejection branch records the refusal");
  ok(/tempoLeads\(req\) \? `\$\{header\}, \$\{existing\}`/.test(src), "the appender puts tempo first unless demoted");
  _resetTempoDemotion();
  console.log(`${pass} passed (with demotion)`);
}
