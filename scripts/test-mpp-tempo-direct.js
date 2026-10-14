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
ok(mod.tempoEnabled() === true, "direct mode does not need a relay key to stay enabled");
process.env.TEMPO_RELAY = "";
ok(mod.tempoEnabled() === false, "relay mode without a key stays off, as before");
globalThis.fetch = realFetch;
console.log(`test-mpp-tempo-direct: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
