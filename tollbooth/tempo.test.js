// Native MPP on Tempo for the tollbooth (0.9.0) - offline, stub relay.
// Run from the repo root (uses mppx from the root node_modules only to prove
// our dependency-free challenge interoperates with the reference codec).
import express from "express";
import { Challenge } from "mppx";
import { createTollbooth, tempoConfig, mintTempoChallenges, parseTempoCredential, checkTempoBinding, toBaseUnits, tempoFromEnv, TEMPO_USDC_E } from "./index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const SECRET = "tollbooth-tempo-test-secret";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const FEE_TO = "0x2222222222222222222222222222222222222222";
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const listen = (app) => new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })); });

// ---- config + minting ----
ok(toBaseUnits("$0.001") === 1000n && toBaseUnits(0.05) === 50000n && toBaseUnits("1") === 1000000n, "toBaseUnits: $0.001 -> 1000, 0.05 -> 50000 at 6 decimals");
let threw = null; try { tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.001" }] }); } catch (e) { threw = e; }
ok(threw === null, "config: splits validated at config time (a split alone is fine - price check happens at mint)");
threw = null; try { tempoConfig({ apiKey: "", recipient: RECIPIENT }); } catch (e) { threw = e; }
ok(/apiKey/.test(threw?.message || ""), "config: apiKey required");
threw = null; try { tempoConfig({ apiKey: "k", recipient: "nope" }); } catch (e) { threw = e; }
ok(/recipient/.test(threw?.message || ""), "config: recipient must be a 0x address");
threw = null; try { tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: Array.from({ length: 11 }, () => ({ recipient: FEE_TO, amount: "0.0001" })) }); } catch (e) { threw = e; }
ok(/at most 10/.test(threw?.message || ""), "config: at most 10 splits");
const cfg = tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.0002" }], description: "tollbooth test" });
const www = mintTempoChallenges({ price: "$0.001", realm: "site.test", secretKey: SECRET, tempo: cfg });
ok(typeof www === "string" && /^Payment /.test(www), "mint: WWW-Authenticate value minted");
const parsed = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www }));
ok(parsed.length === 1 && parsed[0].method === "tempo" && parsed[0].intent === "charge", "mint: mppx parses our challenge as tempo/charge");
ok(Challenge.verify(parsed[0], { secretKey: SECRET }), "mint: mppx Challenge.verify agrees with our HMAC id binding");
const req0 = parsed[0].request;
ok(req0.amount === "1000" && req0.currency === TEMPO_USDC_E && req0.recipient === RECIPIENT && req0.methodDetails?.chainId === 4217 && req0.decimals === undefined, `mint: wire request is base units, no decimals, methodDetails.chainId (${JSON.stringify(req0).slice(0, 120)})`);
ok(Array.isArray(req0.methodDetails?.splits) && req0.methodDetails.splits[0].recipient === FEE_TO && req0.methodDetails.splits[0].amount === "200", "mint: splits ride in methodDetails in base units");
ok(mintTempoChallenges({ price: "$0.0001", realm: "site.test", secretKey: SECRET, tempo: cfg }) === null, "mint: a price the splits would exceed mints NOTHING (never an unpayable challenge)");
ok(mintTempoChallenges({ price: "$0.001", realm: "site.test", secretKey: SECRET, tempo: tempoConfig({ apiKey: "k", recipient: RECIPIENT, currencies: [TEMPO_USDC_E, "0x20c0000000000000000000000000000000000000"] }) }).split(", Payment ").length === 2, "mint: one challenge per configured currency");

// credential builder (payload shape a tempo client sends; the stub relay validates it)
const credFor = (challenge, over = {}) => `Payment ${b64url(JSON.stringify({ challenge: { ...challenge, ...over }, payload: { type: "transaction", signature: `0x${"ab".repeat(70)}` } }))}`;
const chObj = { id: parsed[0].id, realm: parsed[0].realm, method: "tempo", intent: "charge", request: www.match(/request="([^"]+)"/)[1], expires: parsed[0].expires };
const cred = parseTempoCredential(credFor(chObj));
ok(cred && cred.challenge.id === chObj.id && cred.payload.type === "transaction", "parseTempoCredential: well-formed tempo credential parses");
ok(parseTempoCredential("Payment zzz") === null && parseTempoCredential(`Payment ${b64url(JSON.stringify({ challenge: { ...chObj, method: "evm" }, payload: { type: "authorization" } }))}`) === null, "parseTempoCredential: garbage and evm credentials are not tempo");
ok(checkTempoBinding(cred, { secretKey: SECRET, realm: "site.test", price: "$0.001", tempo: cfg }).ok === true, "binding: our own challenge at this price binds");
ok(/HMAC/.test(checkTempoBinding(parseTempoCredential(credFor(chObj, { id: "x".repeat(43) })), { secretKey: SECRET, realm: "site.test", price: "$0.001", tempo: cfg }).reason), "binding: tampered id refused");
ok(/below this route's price/.test(checkTempoBinding(cred, { secretKey: SECRET, realm: "site.test", price: "$0.01", tempo: cfg }).reason), "binding: a $0.001 challenge does not buy a $0.01 route");
ok(/realm/.test(checkTempoBinding(cred, { secretKey: SECRET, realm: "other.test", price: "$0.001", tempo: cfg }).reason), "binding: realm must be ours");

// ---- env ----
ok(tempoFromEnv({}) === null, "env: no TOLLBOOTH_TEMPO_API_KEY -> off");
const envCfg = tempoFromEnv({ TOLLBOOTH_TEMPO_API_KEY: "k", TOLLBOOTH_TEMPO_RECIPIENT: RECIPIENT, TOLLBOOTH_TEMPO_SPLITS: `${FEE_TO}:0.0002` });
ok(envCfg.apiKey === "k" && envCfg.recipient === RECIPIENT && envCfg.splits[0].amount === "0.0002", "env: key, recipient, splits parse");

// ---- gate end to end (tempo-only, no x402 middleware) ----
const calls = { validate: [], broadcast: [] };
let broadcastOk = true, validateOk = true;
const relay = {
  async validate(input) { calls.validate.push(input); return validateOk ? { ok: true } : { ok: false, error: "relay HTTP 400 invalid_payment" }; },
  async broadcast(input, { idempotencyKey }) { calls.broadcast.push({ input, idempotencyKey }); return broadcastOk ? { ok: true, receipt: { method: "tempo", reference: `0x${"cd".repeat(32)}`, timestamp: new Date().toISOString() } } : { ok: false, error: "relay HTTP 503 temporarily_unavailable" }; },
};
const app = express();
let handlerRuns = 0, handlerStatus = 200;
app.use(createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.0002" }], relay } }));
app.get("/paid", (req, res) => { handlerRuns++; res.status(handlerStatus).json({ result: "ok", runs: handlerRuns }); });
const { server, url } = await listen(app);

const r402 = await fetch(`${url}/paid`);
const wwwLive = r402.headers.get("www-authenticate") || "";
ok(r402.status === 402 && /method="tempo"/.test(wwwLive) && /realm="site.test"/.test(wwwLive), "gate: unpaid -> 402 with a tempo challenge (realm = resource base host), no x402 middleware needed");
const liveCh = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwLive }))[0];
const liveChObj = { id: liveCh.id, realm: liveCh.realm, method: "tempo", intent: "charge", request: wwwLive.match(/request="([^"]+)"/)[1], expires: liveCh.expires };
const paid = await fetch(`${url}/paid`, { headers: { Authorization: credFor(liveChObj) } });
const paidBody = await paid.json();
ok(paid.status === 200 && paidBody.result === "ok" && paid.headers.get("x-tollbooth-paid") === "mpp-tempo", `gate: a bound tempo credential is validated, served and broadcast (got ${paid.status})`);
ok(calls.validate.length === 1 && calls.broadcast.length === 1 && calls.broadcast[0].idempotencyKey.startsWith("mpp_") && calls.broadcast[0].input.challenge.id === liveCh.id, "gate: relay validate once BEFORE the handler, broadcast once AFTER with an idempotency key");
// The relay's input is mppx's deserialized credential: `challenge.request` is
// the DECODED request object (amount/currency/recipient/methodDetails), never
// the base64url wire string; `payload` rides verbatim. The first live proof
// failed on exactly this (run 32295980187): the real relay refused the wire
// string while this stub accepted anything. Mirrors mppx Relay.js toRelayInput.
{
  const vi = calls.validate[0];
  ok(vi && typeof vi.challenge.request === "object" && vi.challenge.request.amount === "1000" && typeof vi.challenge.request.recipient === "string" && Number(vi.challenge.request.methodDetails?.chainId) === 4217 && typeof vi.challenge.id === "string" && vi.challenge.method === "tempo", `relay wire: challenge.request is the decoded object (${JSON.stringify(vi?.challenge?.request).slice(0, 80)})`);
  ok(vi && vi.payload && typeof vi.payload.type === "string", "relay wire: payload rides verbatim");
  ok(JSON.stringify(calls.broadcast[0].input.challenge.request) === JSON.stringify(vi.challenge.request), "relay wire: broadcast sends the same decoded input as validate");
}
const receipt = paid.headers.get("payment-receipt");
ok(receipt && JSON.parse(Buffer.from(receipt, "base64url").toString()).method === "tempo", "gate: Payment-Receipt rides on the 200 (base64url JSON, method tempo)");
ok(handlerRuns === 1, "gate: handler ran exactly once");
// replay of the same credential
const again = await fetch(`${url}/paid`, { headers: { Authorization: credFor(liveChObj) } });
const againBody = await again.json();
ok(again.status === 402 && againBody.problem?.type === "https://paymentauth.org/problems/invalid-challenge" && /already used/.test(againBody.problem.detail) && handlerRuns === 1 && calls.broadcast.length === 1, "gate: replaying a spent credential -> 402 invalid-challenge problem, handler not run, nothing broadcast");
// handler failure -> no broadcast
const fresh = async () => { const r = await fetch(`${url}/paid`); const w = r.headers.get("www-authenticate"); const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w }))[0]; return { id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }; };
handlerStatus = 500;
const failed = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
ok(failed.status === 500 && calls.broadcast.length === 1, "gate: a failing handler is never broadcast (buyer not charged), its own status passes through");
handlerStatus = 200;
// broadcast failure after success -> 402, body discarded
broadcastOk = false;
const bfail = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
const bfailBody = await bfail.json();
ok(bfail.status === 402 && bfailBody.problem?.type === "https://paymentauth.org/problems/verification-failed" && bfailBody.result === undefined && /temporarily_unavailable/.test(bfailBody.problem.detail), "gate: broadcast failure after a successful handler -> 402 verification-failed, handler body discarded, relay reason surfaced");
broadcastOk = true;
// validate failure -> 402, handler never runs
validateOk = false;
const before = handlerRuns;
const vfail = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
const vfailBody = await vfail.json();
ok(vfail.status === 402 && vfailBody.problem?.type === "https://paymentauth.org/problems/verification-failed" && handlerRuns === before && /invalid_payment/.test(vfailBody.problem.detail), "gate: relay validate failure -> 402 before the handler runs");
validateOk = true;
// tampered / insufficient
const tampered = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh(), { id: "y".repeat(43) }) } });
ok(tampered.status === 402 && (await tampered.json()).problem?.type === "https://paymentauth.org/problems/invalid-challenge" && /method="tempo"/.test(tampered.headers.get("www-authenticate") || ""), "gate: tampered credential -> 402 invalid-challenge WITH fresh challenges");
server.close();

// ---- stats + x402 coexistence: tempoPaid counted; evm + tempo challenges side by side ----
{
  const app2 = express();
  const gate = createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, relay } });
  app2.use(gate);
  app2.get("/p", (req, res) => res.json({ ok: 1 }));
  const s2 = await listen(app2);
  const r = await fetch(`${s2.url}/p`);
  const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": r.headers.get("www-authenticate") }))[0];
  const w = r.headers.get("www-authenticate");
  await fetch(`${s2.url}/p`, { headers: { Authorization: credFor({ id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }) } });
  ok(gate.stats().tempoPaid === 1, `stats: tempoPaid counted (${gate.stats().tempoPaid})`);
  s2.server.close();
}

// ---- chain-truth confirm on broadcast failure (2026-08-20) ----
// The relay can report `invalid_payment: "Broadcast transaction hash does not
// match the signed transaction"` for a payment that SETTLED (a yParity-style
// v byte the node normalizes). The gate must verify the chain before turning
// that verdict into a buyer-facing 402 + double-charge loop. The fixture is
// the REAL incident tx's on-chain bytes (Tempo mainnet, public data).
{
  const { keccak256Hex, candidateTxIds, confirmTempoSettlement } = await import("./tempo.js");
  ok(keccak256Hex(Buffer.alloc(0)) === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak: empty-input vector (Keccak padding, not SHA-3)");
  ok(keccak256Hex(Buffer.from("abc")) === "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak: 'abc' vector");

  const ONCHAIN_RAW = "0x76f90110821079808447868c008306b9c2f87ef87c9420c000000000000000000000b9537d11c60e8b5080b86495777d59000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d000000000000000000000000000000000000000000000000000000000000003e8ef1ed71201faae27dd2de7e4657aff0000000000000000000055f3b3923b81d7c0a0da0e157163014a9f525ee19dca60039586bc2cc0fd5eda90326cd4c891ba57c080846a866f63809420c000000000000000000000b9537d11c60e8b5080c0b8419e35bf47532bcce30d028b13020ca217c47f348468d6a6bb129f851672eac35b337ed106315204c48b6daac0eac04bb34e03b7964c1ce4294b1b76c4a1ddf78a1c";
  const REAL_TXID = "0x753f5655f3823e1a2cea84c9afca8d39b63669059b27120953e2da0cb78abc4f";
  ok(keccak256Hex(Buffer.from(ONCHAIN_RAW.slice(2), "hex")) === REAL_TXID, "keccak: the incident tx's 277 bytes (multi-block absorb) hash to its REAL on-chain txid");
  const SUBMITTED = ONCHAIN_RAW.slice(0, -2) + "01"; // what a yParity signer submits
  const cands = candidateTxIds(SUBMITTED);
  ok(cands.length === 2 && cands[1] === REAL_TXID, "candidates: v-swap (01 -> 1c) recovers the incident's on-chain txid from the submitted form");
  ok(candidateTxIds(ONCHAIN_RAW)[1] === keccak256Hex(Buffer.from(SUBMITTED.slice(2), "hex")), "candidates: the reverse swap works too");
  ok(candidateTxIds(`0x02${ONCHAIN_RAW.slice(4)}`).length === 0, "candidates: non-0x76 envelopes yield nothing");
  ok(candidateTxIds(ONCHAIN_RAW.slice(0, -2) + "ff").length === 1, "candidates: an unrecognisable v byte gets only the identity candidate");
  ok(candidateTxIds(`0x${"ab".repeat(70)}`).length === 0 && candidateTxIds(null).length === 0, "candidates: the test suite's own fake signature (and junk) derive nothing - the default confirm can never make a network call for them");

  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const chReq = (amount = "1000") => b64url(JSON.stringify({ amount, currency: TEMPO_USDC_E, recipient: RECIPIENT, methodDetails: { chainId: 4217 } }));
  const CH_ID = "ch-tempo-confirm-test";
  const cred = (over = {}) => ({ challenge: { id: over.id ?? CH_ID, request: over.request ?? chReq() }, payload: over.payload ?? { type: "transaction", signature: SUBMITTED } });
  const { encode: encodeMemo } = await import("../node_modules/mppx/dist/tempo/Attribution.js");
  const memoFor = (id) => encodeMemo({ challengeId: id, serverId: "site.test", clientId: "buyer" });
  const TRANSFER_WITH_MEMO = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
  const receiptFor = ({ status = "0x1", token = TEMPO_USDC_E, to = RECIPIENT, amount = 1000n, memo = memoFor(CH_ID), withMemoEvent = true } = {}) => {
    const topicsTo = `0x${to.slice(2).toLowerCase().padStart(64, "0")}`, data = `0x${amount.toString(16).padStart(64, "0")}`;
    return { status, logs: [
      { address: token, topics: [TRANSFER, `0x${"0".repeat(64)}`, topicsTo], data },
      ...(withMemoEvent ? [{ address: token, topics: [TRANSFER_WITH_MEMO, `0x${"0".repeat(64)}`, topicsTo, memo], data }] : []),
    ] };
  };
  const stubFetch = (map) => async (u, init) => { const q = JSON.parse(init.body); const r = map[q.params[0]] ?? null; return { ok: true, json: async () => ({ result: r }) }; };

  const found = await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor() }), attempts: 1 });
  ok(found?.txId === REAL_TXID, "confirm: the settled tx is found via the v-swapped candidate");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({}), attempts: 1 }) === null, "confirm: no receipt -> null (the 402 stands)");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ status: "0x0" }) }), attempts: 1 }) === null, "confirm: a reverted tx never confirms");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ token: FEE_TO }) }), attempts: 1 }) === null, "confirm: a transfer in a different token never confirms");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ to: FEE_TO }) }), attempts: 1 }) === null, "confirm: a transfer to someone else never confirms");
  ok(await confirmTempoSettlement(cred({ request: chReq("5000") }), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ amount: 1000n }) }), attempts: 1 }) === null, "confirm: an on-chain amount below the challenge amount never confirms");
  ok(await confirmTempoSettlement(cred({ payload: { type: "hash", hash: "0xab" } }), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor() }), attempts: 1 }) === null, "confirm: a non-transaction payload derives nothing -> null");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: async () => { throw new Error("rpc down"); }, attempts: 1 }) === null, "confirm: RPC failure -> null, never throws");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ memo: memoFor("another-challenge") }) }), attempts: 1 }) === null, "confirm: a settled transfer bound to a DIFFERENT challenge never confirms");
  ok(await confirmTempoSettlement(cred(), { rpcUrl: "http://stub", fetchImpl: stubFetch({ [REAL_TXID]: receiptFor({ withMemoEvent: false }) }), attempts: 1 }) === null, "confirm: a plain Transfer with no MPP memo never confirms");

  // Gate: relay says failed, chain says settled -> buyer SERVED.
  const failRelay = { async validate() { return { ok: true }; }, async broadcast() { return { ok: false, error: "relay HTTP 200 invalid_payment" }; } };
  {
    const app3 = express();
    const gate = createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, relay: failRelay, confirmSettlement: async () => ({ txId: REAL_TXID }) } });
    app3.use(gate);
    app3.get("/p", (req, res) => res.json({ result: "ok" }));
    const s3 = await listen(app3);
    const r = await fetch(`${s3.url}/p`);
    const w = r.headers.get("www-authenticate");
    const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w }))[0];
    const res3 = await fetch(`${s3.url}/p`, { headers: { Authorization: credFor({ id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }) } });
    const body3 = await res3.json();
    const receipt = JSON.parse(Buffer.from(res3.headers.get("payment-receipt") || "", "base64url").toString());
    ok(res3.status === 200 && body3.result === "ok" && res3.headers.get("x-tollbooth-paid") === "mpp-tempo", "gate: relay-failed but chain-confirmed -> 200, served as paid");
    ok(receipt.reference === REAL_TXID && receipt.method === "tempo" && receipt.status === "success", "gate: Payment-Receipt carries the CONFIRMED on-chain txid");
    ok(gate.stats().tempoPaid === 1, "gate: a chain-confirmed settlement counts as tempoPaid");
    s3.server.close();
  }
  // Gate: confirm disabled -> the old behavior even when a confirm fn exists.
  {
    const app4 = express();
    app4.use(createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, relay: failRelay, confirm: false, confirmSettlement: async () => ({ txId: REAL_TXID }) } }));
    app4.get("/p", (req, res) => res.json({ result: "ok" }));
    const s4 = await listen(app4);
    const r = await fetch(`${s4.url}/p`);
    const w = r.headers.get("www-authenticate");
    const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w }))[0];
    const res4 = await fetch(`${s4.url}/p`, { headers: { Authorization: credFor({ id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }) } });
    ok(res4.status === 402 && (await res4.json()).problem?.type === "https://paymentauth.org/problems/verification-failed", "gate: confirm:false disables the fallback entirely (402 as before)");
    s4.server.close();
  }
  // Gate: default confirm with the suite's fake signature must answer 402
  // WITHOUT any RPC fetch (no candidates -> no network in offline runs).
  {
    let rpcCalls = 0;
    const app5 = express();
    app5.use(createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, relay: failRelay, fetch: async () => { rpcCalls++; throw new Error("no network in tests"); } } }));
    app5.get("/p", (req, res) => res.json({ result: "ok" }));
    const s5 = await listen(app5);
    const r = await fetch(`${s5.url}/p`);
    const w = r.headers.get("www-authenticate");
    const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w }))[0];
    const res5 = await fetch(`${s5.url}/p`, { headers: { Authorization: credFor({ id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }) } });
    ok(res5.status === 402 && rpcCalls === 0, "gate: default confirm derives no candidates from a non-0x76 signature and never touches the RPC (offline-safe)");
    s5.server.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
