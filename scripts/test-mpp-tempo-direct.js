// Tempo settlement mode: TEMPO_RELAY=off checks and broadcasts a credential
// without Tempo's hosted relay (mppx verifies the signed transaction against
// the chain itself); unset keeps the relay. Offline: a credential that cannot
// verify is enough to show which endpoint a check reaches.
//   node scripts/test-mpp-tempo-direct.js
import { Challenge, Credential } from "mppx";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.SANCTIONS_SCREEN_FILE = (await import("node:path")).join((await import("node:os")).tmpdir(), `tempo-direct-screen-${process.pid}.json`);
// The gate case below reads the in-process hang-up budget (a REDIS_URL in the
// caller's environment would make reservations promises on a shared store).
process.env.SHARED_LIMITS = "off";
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  calls.push(url);
  if (/api\.tempo\.xyz/.test(url)) return new Response(JSON.stringify({ success: false, error: { code: "invalid_request", message: "stub" } }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub rpc" } }), { status: 200, headers: { "content-type": "application/json" } });
};
const mod = await import("../src/mpp-tempo.js");
function credentialHeader() {
  const ch = Challenge.from({ secretKey: "k", realm: "t.local", method: "tempo", intent: "charge", request: { amount: "1000", currency: "0x20C000000000000000000000b9537d11c60E8b50", recipient: TREASURY, methodDetails: { chainId: 4217 } }, expires: new Date(Date.now() + 60_000).toISOString() });
  const cred = { challenge: ch, payload: { type: "transaction", signature: "0x76" + "00".repeat(60) }, source: `did:pkh:eip155:4217:${TREASURY}` };
  return Credential.serialize(cred);
}
delete process.env.TEMPO_RELAY;
ok(mod.tempoSettlementMode() === "relay" && mod._tempoMethodUsesRelay() === true, "unset: settlement goes through Tempo's relay");
calls.length = 0;
await mod.validateTempoCredential(credentialHeader());
ok(calls.some((u) => /api\.tempo\.xyz\/v1\/mpp\/validate/.test(u)), `relay mode asks the relay to validate (${calls.length} call(s))`);
process.env.TEMPO_RELAY = "off";
ok(mod.tempoSettlementMode() === "direct" && mod._tempoMethodUsesRelay() === false, "TEMPO_RELAY=off: the method is built without the relay");
calls.length = 0;
const v = await mod.validateTempoCredential(credentialHeader());
ok(!calls.some((u) => /api\.tempo\.xyz/.test(u)), `direct mode never calls the relay (${calls.filter((u) => /api\.tempo\.xyz/.test(u)).length} relay call(s))`);
ok(v.ok === false, "an unverifiable credential is still refused in direct mode");
delete process.env.TEMPO_API_KEY;
ok(mod.tempoEnabled() === false && mod.tempoConfigured() === true, "direct mode offers nothing until its payment-party screen has a list");
const screen = await import("../src/sanctions-screen.js");
const fixture = (await import("node:fs")).readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
await screen.refreshSanctionsScreen({ fetchImpl: async () => new Response(fixture, { status: 200 }), log: () => {} });
ok(mod.tempoEnabled() === true, "direct mode does not need a relay key to stay enabled once the screen is loaded");
process.env.TEMPO_RELAY = "";
ok(mod.tempoEnabled() === false, "relay mode without a key stays off, as before");
globalThis.fetch = realFetch;

// The gate in direct mode, after a successful handler: the party screen runs
// once more right before the broadcast, and a refusal there broadcasts
// nothing, so the request is NOT marked "settle sent". The mark is what the
// dispatcher reads to decide a close before the first byte (server.js:
// abandoned, budget spent, when gone and not sent; released when sent) and
// what runOutcome reads to make the outcome a settlement outcome (the
// breaker). A screen refusal with the mark set would release the ticket of a
// buyer who closed in that window and feed the breaker a settlement failure
// that never left. Control: the same gate broadcasts a clean credential and
// marks it sent.
{
  process.env.TEMPO_RELAY = "off";
  const [{ default: express }, { createReplayGuard }, hs, hf] = await Promise.all([import("express"), import("../src/replay-guard.js"), import("../src/hangup-settlement.js"), import("../src/hangup-forgiveness.js")]);
  ok(mod.tempoSettlementMode() === "direct" && mod.tempoConfigured() === true && mod.tempoEnabled() === true, "the gate case runs in direct mode with the screen loaded");
  const LISTED = "0xbad0000000000000000000000000000000000002"; // in the fixture
  const CLEAN = "0x1234567890123456789012345678901234567890";
  const SECRET = "k", REALM = "t.local";
  const PATH_USD = "0x20c0000000000000000000000000000000000000"; // the default currency
  const cred = (source) => Credential.serialize({ challenge: Challenge.from({ secretKey: SECRET, realm: REALM, method: "tempo", intent: "charge", request: { amount: "1000", currency: PATH_USD, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, expires: new Date(Date.now() + 60_000).toISOString() }), payload: { type: "transaction", signature: "0x76" + "00".repeat(60) }, source: `did:pkh:eip155:4217:${source}` });
  let broadcasts = 0, runs = 0;
  const seen = new Map(); // source -> { req, settled: [] }
  hf._resetHangupForgiveness();
  const app = express();
  app.use(hs.createHangupSettlementHook({ onUndelivered: () => {} }));
  app.use(mod.createTempoGate({
    secretKey: SECRET, realm: REALM, replayGuard: createReplayGuard(), priceFor: () => ({ priceUsd: 0.001 }),
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => { broadcasts++; return { ok: true, receipt: { method: "tempo", status: "success", reference: `0xd${broadcasts}`, timestamp: new Date().toISOString() } }; },
  }));
  app.use((req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" })));
  app.get("/paid", (req, res) => {
    runs++;
    // Mirrors the dispatcher: a ticket reserved when the handler starts, keyed
    // on the verified sender; its close-time verdict is applied below.
    hf.reserveHangupForgiveness(req, { keys: [`tempo:${req.mppTempoSender}`, "ip:direct"], priceUsd: 0.001 });
    const entry = { req, settled: [] };
    hs.onSettleOutcome(req, res, (info) => entry.settled.push(info));
    seen.set(req.headers["x-case"], entry);
    res.json({ ok: true });
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/paid`;
  const e0 = console.error, w0 = console.warn;
  console.error = () => {}; console.warn = () => {};
  let r, body;
  try {
    r = await fetch(url, { headers: { Authorization: cred(LISTED), "x-case": "listed" } });
    body = await r.json().catch(() => ({}));
  } finally { console.error = e0; console.warn = w0; }
  const listed = seen.get("listed");
  ok(r.status === 402 && body?.details?.reason === "screen-rejected" && runs === 1 && broadcasts === 0, `a party the list names after the handler ran is refused before the broadcast: 402 screen-rejected, nothing broadcast (${r.status} ${body?.details?.reason}; runs ${runs}, broadcasts ${broadcasts})`);
  ok(listed && hs.settleSentWhileConnected(listed.req) === false, "the refused request is not marked settle-sent: no charge left");
  ok(listed && hf.hangupForgiven(listed.req) === true, "its ticket was granted (the budget had room)");
  // The dispatcher's close-time rule on that request, had the buyer closed in
  // that window (the hook's own-property flag, flipped as the close would):
  // gone and not sent reads abandoned, so the budget is spent, never released.
  const before = hf.hangupForgivenessStatus().abandonedInWindow;
  listed.req.__a402ClientGoneAt = Date.now();
  hf.settleHangupTicket(listed.req, { abandoned: hs.clientGoneBeforeFirstByte(listed.req) && !hs.settleSentWhileConnected(listed.req) });
  const after = hf.hangupForgivenessStatus().abandonedInWindow;
  ok(after === before + 1, `a close in that window abandons the ticket under the dispatcher's rule (abandoned ${before} -> ${after})`);
  // Control: a clean credential passes the screen, is broadcast, and is
  // marked sent; the same close would release its ticket.
  r = await fetch(url, { headers: { Authorization: cred(CLEAN), "x-case": "clean" } });
  body = await r.json().catch(() => ({}));
  const clean = seen.get("clean");
  ok(r.status === 200 && body?.ok === true && runs === 2 && broadcasts === 1, `control: a clean credential is served and broadcast once (${r.status}; broadcasts ${broadcasts})`);
  ok(clean && hs.settleSentWhileConnected(clean.req) === true, "control: the served request is marked settle-sent (the mark still fires in direct mode when the screen passes)");
  const before2 = hf.hangupForgivenessStatus().abandonedInWindow;
  clean.req.__a402ClientGoneAt = Date.now();
  hf.settleHangupTicket(clean.req, { abandoned: hs.clientGoneBeforeFirstByte(clean.req) && !hs.settleSentWhileConnected(clean.req) });
  ok(hf.hangupForgivenessStatus().abandonedInWindow === before2, "control: the same close on the broadcast request releases its ticket (nothing abandoned)");
  server.close();
  hf._resetHangupForgiveness();
}
try { (await import("node:fs")).rmSync(process.env.SANCTIONS_SCREEN_FILE, { force: true }); } catch { /* nothing to remove */ }
console.log(`test-mpp-tempo-direct: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
