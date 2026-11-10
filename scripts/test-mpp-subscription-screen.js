// MPP subscription payments are screened like per-call payments
// (src/mpp-subscriptions.js screenPayer over src/sanctions-screen.js).
// Offline: real mppx codec objects and real signed key authorizations,
// injected settlement that counts every send, the REAL screen over a stored
// list written to a temp file, and a stubbed fetch for the transfer feed (any
// other outbound call fails the test).
//
// Proves, each beside a live control: a listed wallet's first payment is
// refused before anything is sent (zero sends) with the per-call Tempo
// rail's answer; a wallet listed between renewals is not charged, the
// subscription ends and its key is destroyed; a clean wallet activates and
// renews with exactly one send each, the screen running before the send; the
// one-hop funding check refuses, passes when the feed fails, and reads the
// feed once per verdict; with no list loaded the payment proceeds and is
// counted, as on the x402 payer screen.
//   node scripts/test-mpp-subscription-screen.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import * as Tempo from "mppx/tempo";
import { KeyAuthorization } from "ox/tempo";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const SECRET = "test-mpp-secret";
const REALM = "agent402.test";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const tmp = mkdtempSync(join(tmpdir(), "a402-mppsubs-screen-"));
process.env.MPP_SECRET_KEY = SECRET;
process.env.TEMPO_RECIPIENT_ADDRESS = RECIPIENT;
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32); // throwaway: nothing is broadcast
process.env.SANCTIONS_SCREEN_FILE = join(tmp, "screen.json");
process.env.TEMPO_RPC_URL = "http://127.0.0.1:9/never-called";
delete process.env.MPP_SUBSCRIPTIONS;
delete process.env.TEMPO_DATA_API_KEY;
delete process.env.SANCTIONS_ONE_HOP;

// The only outbound call this file allows: the transfer feed, stubbed.
const feedCalls = [];
let feed = () => ({ status: 200, body: { data: [], nextCursor: null } });
const outside = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (/\/v1\/transfers\?/.test(url)) {
    feedCalls.push(url);
    const r = await feed(new URL(url));
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }
  outside.push(url);
  throw new Error(`unexpected outbound call: ${url}`);
};

const S = await import("../src/sanctions-screen.js");
const {
  createMppSubscriptions, periodMs, PERIOD_COUNT, PERIOD_UNIT, TEMPO_MAINNET_CHAIN_ID, SCREEN_ENDED_REASON,
} = await import("../src/mpp-subscriptions.js");
const { TEMPO_REFUSAL_CLASSES, tempoRefusalProblem } = await import("../src/mpp-tempo.js");
const { createX402PayerScreen, x402PayerScreenView } = await import("../src/x402-payer-screen.js");
const PERIOD = periodMs();

// The stored list, as the refresh writes it; a newer loadedAt replaces the held set.
let listSeq = 0;
async function loadList(addresses) {
  S.__resetSanctionsScreenForTests();
  writeFileSync(process.env.SANCTIONS_SCREEN_FILE, JSON.stringify({ v: 1, loadedAt: Date.now() + (++listSeq), publishDate: "11/10/2026", perAsset: { ETH: addresses.length }, addresses: addresses.map((a) => a.toLowerCase()) }));
  return S.loadStoredSanctionsScreen();
}
const OTHER_LISTED = "0xbad0000000000000000000000000000000000001";
const LISTED_FUNDER = "0xbad0000000000000000000000000000000000003";

const logs = [];
const realWarn = console.warn.bind(console);
console.warn = (...a) => { logs.push(a.join(" ")); };

let clock = Date.now();
const advance = (ms) => { clock += ms; };
function makeEngine(name, { screen } = {}) {
  const calls = { activate: 0, charge: 0 };
  const events = [];
  const path = join(tmp, `${name}.json`);
  const engine = createMppSubscriptions({
    secretKey: SECRET, realm: REALM, storePath: path, now: () => clock,
    log: (m) => logs.push(String(m)),
    ...(screen ? { screen: screen(events) } : {}),
    // The stub the first payment's broadcast is counted on.
    activate: async (_header, ctx) => {
      calls.activate++; events.push("send");
      await engine._subStore.put({
        accessKey: { accessKeyAddress: ctx.accessKey.accessKeyAddress, keyType: ctx.accessKey.keyType },
        amount: String(ctx.binding.amountAtomic), billingAnchor: new Date(clock).toISOString(),
        chainId: TEMPO_MAINNET_CHAIN_ID, currency: CURRENCY, keyAuthorization: ctx.binding.credential.payload.signature,
        lastChargedPeriod: 0, lookupKey: ctx.lookupKey, payer: { address: ctx.payer, chainId: TEMPO_MAINNET_CHAIN_ID },
        periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT, recipient: RECIPIENT, reference: "0xactivation",
        subscriptionExpires: ctx.binding.challenge.request.subscriptionExpires,
        subscriptionId: `sub-${name}-${calls.activate}`, timestamp: new Date(clock).toISOString(),
      });
      return { receipt: { method: "tempo", status: "success", reference: "0xactivation", timestamp: new Date(clock).toISOString() } };
    },
    findRenewalOnChain: async () => ({ found: false }),
    // The stub a renewal's broadcast is counted on.
    chargePeriod: async (rec, { periodIndex }) => {
      calls.charge++; events.push("send");
      const mppxRec = await engine._subStore.get(rec.mppxSubscriptionId);
      await engine._subStore.put({ ...mppxRec, lastChargedPeriod: periodIndex, reference: `0xtx${calls.charge}` });
      return { reference: `0xtx${calls.charge}` };
    },
  });
  return { engine, calls, events, path };
}
async function credentialFor(engine, account, { target = "example.com", email = null } = {}) {
  const offer = await engine.mintOffer({ product: "domain-monitor", target, ...(email ? { email } : {}) });
  const challenge = Challenge.deserialize(offer.header);
  const signed = await Tempo.Subscription.signSubscriptionKeyAuthorization({
    accessKey: challenge.request.methodDetails.accessKey, account, challengeId: challenge.id, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request,
  });
  const credential = Credential.from({ challenge, payload: { type: "keyAuthorization", signature: KeyAuthorization.serialize(signed) } });
  return { header: `Payment ${Credential.serialize(credential).replace(/^Payment\s+/i, "")}`, accessKeyAddress: offer.accessKeyAddress };
}
const newAccount = () => privateKeyToAccount(generatePrivateKey());
const keyRecords = (engine, address) => Object.values(engine._store._snapshot()).filter((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress || "").toLowerCase() === String(address).toLowerCase());
async function tryActivate(engine, header) { try { return { sub: await engine.activateFromCredential(header) }; } catch (e) { return { err: e }; } }

const REFUSAL = TEMPO_REFUSAL_CLASSES["screen-rejected"];

// ---------------------------------------------------------------------------
// 1. No list loaded: the payment proceeds and is counted, as the x402 payer
//    screen does for a per-call payment.
// ---------------------------------------------------------------------------
{
  ok(S.sanctionsScreenStatus() === "missing" && S.screenAddresses(["0x" + "12".repeat(20)]).reason === "unavailable", "control: no list is loaded");
  const { engine, calls } = makeEngine("nolist");
  const acct = newAccount();
  const { header } = await credentialFor(engine, acct);
  const r = await tryActivate(engine, header);
  ok(r.sub?.status === "active" && calls.activate === 1, "with no list loaded a subscription activates with one send");
  const view = engine.payerScreenView();
  ok(view.servedUnscreened === 1 && view.screened === 0 && view.refused === 0 && view.lastUnscreenedAt, `and is counted as sent unscreened (${JSON.stringify(view)})`);
  ok(logs.some((l) => /subscription payer screen: no list loaded/.test(l)), "one log line says subscription payments are going out unscreened");
  // The per-call path the brief names: the x402 payer screen with the same payer and no list.
  const before = x402PayerScreenView().servedUnscreened;
  const b64 = Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from: acct.address } } })).toString("base64");
  let nexts = 0, status = 0;
  createX402PayerScreen({ log: () => {} })({ method: "GET", path: "/x", header: (n) => (n === "x-payment" ? b64 : undefined) }, { status: (c) => { status = c; }, setHeader() {}, json() {} }, () => { nexts++; });
  ok(nexts === 1 && status === 0 && x402PayerScreenView().servedUnscreened === before + 1, "the x402 payer screen does the same with no list: the payment is served and counted unscreened");
  advance(PERIOD + 1000);
  ok(await engine.refreshStatus(r.sub.subId) === "active" && calls.charge === 1 && engine.payerScreenView().servedUnscreened === 2, "a renewal with no list loaded is sent once and counted the same way");
}

// ---------------------------------------------------------------------------
// 2. A listed wallet's first payment is refused before anything is sent.
// ---------------------------------------------------------------------------
const listed = newAccount();
{
  ok(await loadList([listed.address, OTHER_LISTED, LISTED_FUNDER]) === true && S.screenAddresses([listed.address]).reason === "listed", "the list is loaded and names the test wallet");
  const { engine, calls, path } = makeEngine("listed");
  const clean = newAccount();

  // Live control first: a clean wallet, same engine, same list.
  const c1 = await tryActivate(engine, (await credentialFor(engine, clean, { target: "clean.example" })).header);
  ok(c1.sub?.status === "active" && calls.activate === 1, "control: a clean wallet activates with exactly one send");

  const offer = await credentialFor(engine, listed, { target: "listed.example", email: "l@example.com" });
  ok(keyRecords(engine, offer.accessKeyAddress).length > 0, "control: the offer's access key is held before the credential is presented");
  const r = await tryActivate(engine, offer.header);
  ok(!r.sub && calls.activate === 1, "a listed wallet's first payment is refused and nothing is sent (the send stub was not called)");
  ok(r.err?.statusCode === 402 && r.err.screenRejected === true && r.err.message === REFUSAL.detail, "the refusal is a 402 carrying the per-call Tempo rail's own text");
  const problem = tempoRefusalProblem("screen-rejected");
  ok(problem.details?.charged === false && problem.details?.reason === "screen-rejected" && problem.detail === S.TEMPO_SCREEN_REFUSED_DETAIL && /per-call and subscription payments/.test(problem.detail) && /not broadcast and nothing was charged/.test(problem.detail), "the answer the route sends is the screen-rejected problem: uncharged, and its text names subscription payments");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("if (e?.screenRejected) return sendMppProblem(res, tempoRefusalProblem(\"screen-rejected\"));");
  ok(at > 0 && at < server.indexOf("try { res.set(\"WWW-Authenticate\", (await mint()).header); }"), "the subscribe route answers with that problem before it would mint a fresh challenge");
  ok(engine._store._keys().filter((k) => k.startsWith("a402:sub:")).length === 1 && !readFileSync(path, "utf8").includes("l@example.com"), "no subscription record exists for the refused wallet");
  ok(keyRecords(engine, offer.accessKeyAddress).length === 0, "the access key minted for the refused offer is deleted at once");
  const view = engine.payerScreenView();
  ok(view.refused === 1 && view.screened === 2 && view.servedUnscreened === 0, `counted: two screened, one refused (${JSON.stringify(view)})`);
  ok(logs.some((l) => /subscription payer 0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4} refused before the first payment/.test(l)) && !logs.some((l) => l.toLowerCase().includes(listed.address.toLowerCase())), "the refusal is logged with the address masked");

  // Control after: the clean wallet still activates a second subscription.
  const c2 = await tryActivate(engine, (await credentialFor(engine, clean, { target: "clean-2.example" })).header);
  ok(c2.sub?.status === "active" && calls.activate === 2, "control: the clean wallet activates again after the refusal, one more send");
}

// ---------------------------------------------------------------------------
// 3. Renewals: a clean wallet renews with one send; a wallet listed between
//    renewals is not charged and its subscription ends with its key destroyed.
// ---------------------------------------------------------------------------
{
  const later = newAccount(), clean = newAccount();
  await loadList([listed.address, OTHER_LISTED, LISTED_FUNDER]);
  const wrap = (events) => ({
    addresses: (l) => { events.push("screen"); return S.screenAddresses(l); },
    funding: (l, o) => S.screenFunding(l, o),
  });
  const { engine, calls, events, path } = makeEngine("renew", { screen: wrap });
  const a = await tryActivate(engine, (await credentialFor(engine, later, { target: "later.example", email: "later@example.com" })).header);
  const c = await tryActivate(engine, (await credentialFor(engine, clean, { target: "stays.example" })).header);
  ok(a.sub && c.sub && calls.activate === 2 && events.join(",") === "screen,send,screen,send", `each first payment is screened before it is sent (${events.join(",")})`);
  const recA = await engine._readRec(a.sub.subId);
  const keyA = keyRecords(engine, recA.accessKeyAddress)[0]?.privateKey;
  const hexA = String(keyA).slice(2).toLowerCase();

  events.length = 0;
  advance(PERIOD + 1000);
  ok(await engine.refreshStatus(a.sub.subId) === "active" && await engine.refreshStatus(c.sub.subId) === "active" && calls.charge === 2, "both wallets, clean, renew: exactly one send each");
  ok(events.join(",") === "screen,send,screen,send", `each renewal is screened before it is sent (${events.join(",")})`);
  ok(hexA.length === 64 && readFileSync(path, "utf8").toLowerCase().includes(hexA), "control: the wallet's subscription key is held while it renews");

  // The list now names the first wallet.
  ok(await loadList([listed.address, OTHER_LISTED, LISTED_FUNDER, later.address]) === true, "the list is refreshed and now names the first wallet");
  events.length = 0;
  advance(PERIOD);
  const st = await engine.refreshStatus(a.sub.subId);
  ok(st === "canceled" && calls.charge === 2 && events.join(",") === "screen", `a wallet listed between renewals is not charged: screened, nothing sent, subscription ended (${st}, sends ${calls.charge}, ${events.join(",")})`);
  const ended = await engine._readRec(a.sub.subId);
  ok(ended.status === "canceled" && ended.canceledReason === SCREEN_ENDED_REASON && ended.lastChargedPeriod === 1 && ended.tombstone === true && ended.email === undefined, "the record ends with the reason payer-not-accepted, the last paid period unchanged, reduced");
  ok(keyRecords(engine, recA.accessKeyAddress).length === 0 && !readFileSync(path, "utf8").toLowerCase().includes(hexA) && !JSON.stringify(engine._store._snapshot()).toLowerCase().includes(hexA), "its signing key is destroyed: no store entry and no byte of the store file carries it");
  const view = engine.publicView(ended);
  ok(view.status === "canceled" && view.canceledReason === "payer-not-accepted" && view.notice === REFUSAL.detail, "the subscriber-facing state says why in the refusal's own words");
  ok(await engine.refreshStatus(a.sub.subId) === "canceled" && calls.charge === 2 && engine.listActive().every((r) => r.subId !== a.sub.subId), "it is never charged or served again");
  // Live control in the same tick.
  events.length = 0;
  ok(await engine.refreshStatus(c.sub.subId) === "active" && calls.charge === 3 && events.join(",") === "screen,send", "control: the clean wallet's renewal in the same tick is sent once");
  const cv = engine.publicView(await engine._readRec(c.sub.subId));
  ok(cv.canceledReason === null && cv.notice === undefined && cv.status === "active", "and its status answer carries no reason and no notice");
}

// ---------------------------------------------------------------------------
// 4. The one-hop funding check: refuses, passes when the feed fails, and
//    reads the feed once per verdict.
// ---------------------------------------------------------------------------
{
  await loadList([listed.address, OTHER_LISTED, LISTED_FUNDER]);
  process.env.TEMPO_DATA_API_KEY = "test-data-key";
  const funded = newAccount(), clean = newAccount(), down = newAccount();
  const usd = (n) => ({ destinationToken: { address: CURRENCY.toLowerCase(), decimals: 6 }, destinationAmount: { baseUnits: String(Math.round(n * 1e6)) } });
  feed = (u) => {
    const r = u.searchParams.get("recipient");
    if (r === funded.address.toLowerCase()) return { status: 200, body: { data: [{ recipient: r, sender: LISTED_FUNDER, ...usd(5) }, { recipient: r, sender: "0x" + "77".repeat(20), ...usd(1) }], nextCursor: null } };
    if (r === down.address.toLowerCase()) return "throw";
    return { status: 200, body: { data: [{ recipient: r, sender: "0x" + "77".repeat(20), ...usd(3) }], nextCursor: null } };
  };
  const { engine, calls } = makeEngine("funding");
  feedCalls.length = 0;
  const c = await tryActivate(engine, (await credentialFor(engine, clean, { target: "funded-clean.example" })).header);
  ok(c.sub?.status === "active" && calls.activate === 1 && feedCalls.length === 1, "control: a wallet with clean inflows activates (one feed read, one send)");
  const f = await tryActivate(engine, (await credentialFor(engine, funded, { target: "funded.example" })).header);
  ok(!f.sub && calls.activate === 1 && f.err?.screenRejected === true && f.err.message === REFUSAL.detail && feedCalls.length === 2, "a wallet funded by a listed sender past the threshold is refused before anything is sent, with the same answer");
  const d = await tryActivate(engine, (await credentialFor(engine, down, { target: "feed-down.example" })).header);
  ok(d.sub?.status === "active" && calls.activate === 2 && feedCalls.length === 3, "when the transfer feed does not answer the payment proceeds on the exact match alone");

  // Cached verdict: no feed read, and the screen costs well under a few milliseconds.
  feedCalls.length = 0;
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) { S.screenAddresses([clean.address]); await S.screenFunding([clean.address], { now: clock }); }
  const perCall = (performance.now() - t0) / N;
  ok(feedCalls.length === 0 && perCall < 3, `a cached verdict reads no feed and the whole screen takes ${perCall.toFixed(4)} ms per payment (under 3 ms)`);
  advance(PERIOD + 1000);
  feedCalls.length = 0;
  ok(await engine.refreshStatus(c.sub.subId) === "active" && calls.charge === 1 && feedCalls.length === 1, "a renewal a period later reads the feed again (the 7-day verdict has lapsed) and is sent once");
  delete process.env.TEMPO_DATA_API_KEY;
}

// ---------------------------------------------------------------------------
// 5. The copy says what the code does, and the code screens before it sends.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(new URL("../src/mpp-subscriptions.js", import.meta.url), "utf8");
  const act = src.indexOf("async function activateFromCredential(");
  const firstScreen = src.indexOf("await screenPayer(payer, \"before the first payment\")", act);
  const firstSend = src.indexOf("await doActivate(authorizationHeader", act);
  const pull = src.indexOf("async function pull(rec, subId, due, at");
  const renewScreen = src.indexOf("await screenPayer(rec.payer, \"before a renewal\")", pull);
  const renewSend = src.indexOf("await charge(rec, { periodIndex: due })", pull);
  ok(act > 0 && firstScreen > act && firstScreen < firstSend && pull > 0 && renewScreen > pull && renewScreen < renewSend, "in the source the screen call precedes the send on both paths");
  ok(src.split("await doActivate(").length === 2 && src.split("await charge(rec,").length === 2, "and each path has exactly one send call");
  const flat = (s) => s.replace(/\s+/g, " ");
  const { privacyPage } = await import("../src/privacy.js");
  const p = flat(privacyPage("https://agent402.tools"));
  ok(p.includes("and the paying wallet of an MPP monitor subscription (before its first payment and before each renewal) are checked against the US Treasury OFAC SDN list") && p.includes("For such a Tempo payment and for a subscription payment we also read the paying wallet's recent inbound transfers"),
    "/privacy says subscription payers are checked before the first payment and each renewal, and that their inbound transfers are read");
  const wiki = flat(readFileSync(new URL("../wiki/Security-Model.md", import.meta.url), "utf8"));
  ok(wiki.includes("A monitor subscription paid over MPP is sent by the server in either mode: its paying wallet is checked against the same list") && wiki.includes("when the transfer feed answers in time, before the first payment and before each renewal") && wiki.includes("If the list has not loaded, a subscription payment is sent and counted as unscreened."),
    "the Security Model wiki page says the same, scoped: the funding read only when the feed answers in time, unscreened when no list is loaded");
  ok(!/screens Tempo per-call payments against/.test(readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8")) && /per-call and subscription payments against/.test(S.TEMPO_SCREEN_REFUSED_DETAIL), "the 402 text names per-call and subscription payments");
}

ok(outside.length === 0, `no call left the process other than the stubbed transfer feed (${outside.length})`);
console.warn = realWarn;
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, 0 failed`);
