// Tempo gas sponsorship for per-call payments (src/tempo-charge-sponsor.js,
// wired into src/mpp-tempo.js), offline with a stub chain: the switch, the
// mint-time decision on the caller path (the 402 appender), every limit
// turning the NEXT challenge into the ordinary one (never a refusal), the
// unproven-sender decline, a sponsored credential routed to this server's
// own settlement (never the relay), the booking of a sponsored send on the
// stub RPC (service-wide and per-payer windows, the operator view), the
// chain-truth confirm finding the co-signed transaction id, and the gas
// sponsor's low-balance word holding the subscription reserve.
//   node scripts/test-tempo-gas-sponsorship.js
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { createClient, http } from "viem";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "tempo-gas-sponsor-"));
const FIXTURE = readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const SECRET = "test-mpp-secret";
const REALM = "t.local";
const SPONSOR_KEY = "0x" + "11".repeat(32);
const sponsorAcct = privateKeyToAccount(SPONSOR_KEY);

// The stub chain: answers the sponsor's PathUSD balance, records every
// method, and answers a raw send with a transaction hash.
let balanceMicro = 10_000_000n; // $10
const rpcSeen = [];
const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const j = JSON.parse(body);
    rpcSeen.push(j.method);
    res.setHeader("content-type", "application/json");
    let result = "0x" + "ab".repeat(32);
    if (j.method === "eth_call" && String(j.params?.[0]?.to).toLowerCase() === PATH_USD) result = "0x" + balanceMicro.toString(16).padStart(64, "0");
    else if (j.method === "eth_chainId") result = "0x1079";
    res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
  });
});
await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
const RPC_URL = `http://127.0.0.1:${rpc.address().port}`;

for (const k of Object.keys(process.env)) if (/^TEMPO_GAS_SPONSOR/.test(k)) delete process.env[k];
Object.assign(process.env, {
  SANCTIONS_SCREEN_FILE: join(dir, "screen.json"), SANCTIONS_PAYOUT_FILE: join(dir, "payout.json"), SANCTIONS_LIST_URL: "http://fixture.local/SDN.XML",
  TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_API_KEY: "relay-key-fixture", TEMPO_RPC_URL: RPC_URL, MPP_SECRET_KEY: SECRET,
  TEMPO_SUBSCRIPTION_FEE_PAYER_KEY: SPONSOR_KEY,
});
delete process.env.TEMPO_RELAY; delete process.env.TEMPO_CURRENCY; delete process.env.SIGNING_HALTED;

// Every outbound fetch: the list fixture, the relay (recorded), the stub RPC.
const realFetch = globalThis.fetch;
const relayCalls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  const host = new URL(url).hostname;
  if (host === "fixture.local") return new Response(FIXTURE, { status: 200, headers: { "content-type": "application/xml" } });
  if (host === "api.tempo.xyz") { relayCalls.push(url); return new Response(JSON.stringify({ success: false, error: { code: "invalid_payment", message: "stub" } }), { status: 200, headers: { "content-type": "application/json" } }); }
  return realFetch(input, init);
};

const S = await import("../src/sanctions-screen.js");
const C = await import("../src/tempo-charge-sponsor.js");
const T = await import("../src/mpp-tempo.js");
const { confirmTempoSettlement } = await import("../src/tempo-confirm.js");
const { subscriptionFeePayerStatus } = await import("../src/mpp-subscriptions.js");

const reqOf = (ip = "203.0.113.7", ua = "agent/1.0") => ({ method: "POST", path: "/api/hash", ip, headers: { "user-agent": ua } });
// The 402 appender on the caller path: what WWW-Authenticate a request gets.
const appender = T.createTempoChallengeAppender({ realm: REALM, secretKey: SECRET, priceFor: () => ({ priceUsd: 0.01, description: "hash" }) });
async function challengeFor(req) {
  const headers = {};
  const res = { statusCode: 402, getHeader: (k) => headers[k.toLowerCase()], setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, writeHead() { return this; } };
  await new Promise((resolve) => appender(req, res, resolve));
  res.writeHead(402);
  const raw = headers["www-authenticate"];
  return raw ? Challenge.deserialize(raw) : null;
}
const sponsoredOf = (ch) => ch?.request?.methodDetails?.feePayer === true;

// --- the switch: off by default -------------------------------------------------
{
  const d = C.tempoGasSponsorConfig({});
  ok(d.enabled === false && d.payerDailyMaxUsd === 1 && d.dailyMaxUsd === 5 && d.reserveUsd === 2 && d.maxFeeUsd === 0.01, `off by default; $1 per payer and $5 in all per 24 h, $2 reserve, $0.01 per transaction (${JSON.stringify(d)})`);
  const bad = C.tempoGasSponsorConfig({ TEMPO_GAS_SPONSORSHIP: "true", TEMPO_GAS_SPONSOR_PAYER_DAILY_MAX_USD: "-1", TEMPO_GAS_SPONSOR_DAILY_MAX_USD: "lots", TEMPO_GAS_SPONSOR_MAX_FEE_USD: "9" });
  ok(bad.enabled === false && bad.payerDailyMaxUsd === 1 && bad.dailyMaxUsd === 5 && bad.maxFeeUsd === 1, "only `on` switches it on; a malformed value reads as the default and the per-transaction bound is at most $1");
  ok(C.chargeSponsorPolicy({}).maxTotalFee === 10n ** 16n, "the per-transaction fee bound is $0.01 in attodollars");
  const ch = await challengeFor(reqOf());
  ok(ch && ch.method === "tempo" && !sponsoredOf(ch), "with the switch off the 402 carries the ordinary tempo challenge");
}

process.env.TEMPO_GAS_SPONSORSHIP = "on";
await C._resetChargeSponsor();
// --- a limit makes the next challenge ordinary, never a refusal ---------------------
{
  let ch = await challengeFor(reqOf());
  ok(ch && !sponsoredOf(ch), "no list loaded yet: the challenge is the ordinary one");
  ok(C.chargeSponsorshipPause() === "screen-unavailable", "and the pause names the screen");
  await S.refreshSanctionsScreen({ log: () => {} });
  await C.refreshChargeSponsorState();
  ch = await challengeFor(reqOf());
  ok(sponsoredOf(ch), `with the list, a key, a balance over the reserve and room in the cap, the challenge asks for a fee-sponsored transaction (${C.chargeSponsorshipPause()})`);
  ok(Challenge.verify(ch, { secretKey: SECRET }) && ch.request.recipient === TREASURY && ch.request.amount === "10000", "it is HMAC-bound with the same amount and recipient");

  balanceMicro = 1_500_000n; // $1.50, under the $2 reserve
  await C.refreshChargeSponsorState();
  ok(!sponsoredOf(await challengeFor(reqOf())) && C.chargeSponsorshipPause() === "reserve", "a sponsor balance under the subscription reserve: ordinary challenge");
  const st = await subscriptionFeePayerStatus();
  ok(st.status === "low" && st.chargeSponsorship === "paused", `the sponsor's low-balance word reads low under the reserve while sponsorship is on (${JSON.stringify(st)})`);
  delete process.env.TEMPO_GAS_SPONSORSHIP;
  ok((await subscriptionFeePayerStatus()).status === "ok", "CONTROL with the switch off the same balance reads ok (the subscription mark alone)");
  process.env.TEMPO_GAS_SPONSORSHIP = "on";
  balanceMicro = 10_000_000n;
  await C.refreshChargeSponsorState();
  ok(sponsoredOf(await challengeFor(reqOf())), "refilled: sponsored again");

  process.env.SIGNING_HALTED = "1";
  ok(!sponsoredOf(await challengeFor(reqOf())), "outbound signing halted: ordinary challenge");
  delete process.env.SIGNING_HALTED;

  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: 10, globalMicro: 0, subCeiling: "reached" });
  ok(!sponsoredOf(await challengeFor(reqOf())), "the subscription sponsor ceiling reached: ordinary challenge");
  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: 10, globalMicro: 5_000_000, subCeiling: "ok" });
  ok(!sponsoredOf(await challengeFor(reqOf())) && C.chargeSponsorshipPause() === "daily-cap", "the service-wide 24 h cap reached: ordinary challenge");
  await C._resetChargeSponsor({ at: Date.now() - 10 * 60_000, balanceUsd: 10, globalMicro: 0, subCeiling: "ok" });
  ok(!sponsoredOf(await challengeFor(reqOf())), "a background read older than five minutes is not trusted: ordinary challenge");
  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: null, globalMicro: 0, subCeiling: "ok" });
  ok(!sponsoredOf(await challengeFor(reqOf())), "an unread balance: ordinary challenge");
  delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: 10, globalMicro: 0, subCeiling: "ok" });
  ok(!sponsoredOf(await challengeFor(reqOf())) && C.chargeSponsorshipPause() === "no-key", "no sponsor key: ordinary challenge");
  process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = SPONSOR_KEY;
}

// --- a sponsored send is booked on the stub chain ------------------------------------
const sender = privateKeyToAccount(generatePrivateKey());
let nonce = 0;
async function cosigned({ from = sender, gas = 1_000_000n, maxFeePerGas = 400_000_000_000n } = {}) { // $0.40 bound each
  return from.signTransaction({
    type: "tempo", chainId: 4217, nonce: nonce++, nonceKey: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 1n,
    calls: [{ to: PATH_USD, data: "0x" }], feePayer: sponsorAcct,
  }, { serializer: Transaction.serialize });
}
{
  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: 10, globalMicro: 0, subCeiling: "ok" });
  await C._clearPayerWindow(sender.address);
  const client = createClient({ transport: C.withSponsorBooking(http(RPC_URL)) });
  const buyer = reqOf("198.51.100.9", "buyer/2.0");
  const other = reqOf("198.51.100.10", "buyer/2.0");
  ok(sponsoredOf(await challengeFor(buyer)), "CONTROL the buyer's first challenge is sponsored");
  const sendsOf = () => rpcSeen.filter((m) => m === "eth_sendRawTransactionSync" || m === "eth_sendRawTransaction").length;
  const sends = sendsOf();
  const first = await cosigned();
  await C.runWithSponsorContext(buyer, () => C.runSponsoredBroadcast("challenge-one", () => client.request({ method: "eth_sendRawTransactionSync", params: [first] })));
  ok(sendsOf() === sends + 1, "the booked send reaches the chain (booking never refuses)");
  ok(C.sponsoredTxIdFor("challenge-one") === (await import("viem")).keccak256(first), "the challenge's co-signed transaction id is kept for the chain-truth confirm");
  const r1 = await C.tempoGasSponsorshipReport();
  ok(r1.counts.booked === 1 && Math.abs(r1.sponsoredFeeBoundUsd24h - 0.4) < 1e-9 && r1.recent.length === 1 && r1.recent[0].payer.includes("...") && !JSON.stringify(r1).includes(sender.address.toLowerCase()), `the operator view books the fee bound, payer shortened (${JSON.stringify(r1.recent[0])})`);
  ok(sponsoredOf(await challengeFor(buyer)), "under the per-payer cap the buyer is still sponsored");
  for (let i = 0; i < 2; i++) { const raw = await cosigned(); await C.runWithSponsorContext(buyer, () => client.request({ method: "eth_sendRawTransaction", params: [raw] })); }
  ok(!sponsoredOf(await challengeFor(buyer)), "past $1 of fees in 24 h, the buyer's client gets the ordinary challenge (it pays its own fee; never refused)");
  ok(sponsoredOf(await challengeFor(other)), "another client is still sponsored");
  const plain = await sender.signTransaction({ type: "tempo", chainId: 4217, nonce: nonce++, nonceKey: 0n, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, calls: [{ to: PATH_USD, data: "0x" }] }, { serializer: Transaction.serialize });
  const before = (await C.tempoGasSponsorshipReport()).counts.booked;
  await client.request({ method: "eth_sendRawTransaction", params: [plain] });
  ok((await C.tempoGasSponsorshipReport()).counts.booked === before, "a transaction with no fee-payer signature is not booked");
}

// --- the chain-truth confirm reads the co-signed id ----------------------------------
{
  const tx = await cosigned();
  const txid = (await import("viem")).keccak256(tx);
  const ch = Challenge.from({ secretKey: SECRET, realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000).toISOString(), request: { amount: "10000", currency: PATH_USD, recipient: TREASURY, methodDetails: { chainId: 4217, feePayer: true } } });
  const auth = Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: "0x76" + "00".repeat(60) } });
  const asked = [];
  const fetchImpl = async (_u, init) => {
    const j = JSON.parse(init.body);
    asked.push(j.params?.[0]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
  };
  await confirmTempoSettlement(auth, { rpcUrl: "http://stub.invalid", fetchImpl, attempts: 1 });
  ok(!asked.includes(txid), "CONTROL before it is booked, the confirm never asks for the co-signed id");
  await C.runSponsoredBroadcast(ch.id, () => C.bookSponsoredSend(tx));
  asked.length = 0;
  await confirmTempoSettlement(auth, { rpcUrl: "http://stub.invalid", fetchImpl, attempts: 1 });
  ok(asked.includes(txid), "after a sponsored send the confirm also reads the co-signed transaction id, so a landed charge is found");
}

// --- the gate's half: unproven senders, and routing away from the relay ----------------
{
  await C._resetChargeSponsor({ at: Date.now(), balanceUsd: 10, globalMicro: 0, subCeiling: "ok" });
  const req = reqOf("192.0.2.44", "multisig/1");
  const ch = await challengeFor(req);
  ok(sponsoredOf(ch), "CONTROL the client is offered sponsorship");
  const junk = Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: "0x76" + "00".repeat(60) } });
  relayCalls.length = 0;
  const v = await C.runWithSponsorContext(req, () => T.validateTempoCredential(junk));
  ok(v.ok === false && v.cls === "fee-sponsor-declined", `a sponsored pull whose sender the gate cannot prove is declined before any claim (${v.cls})`);
  const p = T.tempoRefusalProblem("fee-sponsor-declined");
  ok(T.TEMPO_REFUSAL_CLASSES["fee-sponsor-declined"].status === 402 && p.details.charged === false, "a 402 that says nothing was charged (the fresh challenge rides in the same 402)");
  ok(!sponsoredOf(await challengeFor(req)), "that client's next challenge is the ordinary one");
  ok(relayCalls.length === 0, "nothing reached the relay");

  // A proven sender's sponsored credential is checked by this server, never the relay.
  const fresh = reqOf("192.0.2.45", "proven/1");
  const ch2 = await challengeFor(fresh);
  const signed = await sender.signTransaction({ type: "tempo", chainId: 4217, nonce: 0, nonceKey: 0n, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, calls: [{ to: PATH_USD, data: "0x" }], feePayer: true }, { serializer: Transaction.serialize });
  const auth = Credential.serialize({ challenge: ch2, payload: { type: "transaction", signature: signed } });
  ok(T.inspectTempoSender(auth).verified === sender.address.toLowerCase(), "CONTROL the sender's signature proves it");
  const v2 = await C.runWithSponsorContext(fresh, () => T.validateTempoCredential(auth));
  ok(v2.cls !== "fee-sponsor-declined", `a proven sender is not declined (${v2.cls})`);
  ok(relayCalls.length === 0, "and its sponsored credential never goes to the relay (this server settles it)");
  ok(sponsoredOf(await challengeFor(fresh)), "and the client stays sponsored");
  // CONTROL: an ordinary credential in relay mode does go to the relay.
  process.env.TEMPO_GAS_SPONSORSHIP = "off";
  const ch3 = await challengeFor(fresh);
  ok(!sponsoredOf(ch3), "CONTROL off again: the ordinary challenge");
  await T.validateTempoCredential(Credential.serialize({ challenge: ch3, payload: { type: "transaction", signature: signed } }));
  ok(relayCalls.length > 0, "CONTROL an ordinary credential is checked by the relay");
}

await C._resetChargeSponsor();
rpc.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\ntest-tempo-gas-sponsorship: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
