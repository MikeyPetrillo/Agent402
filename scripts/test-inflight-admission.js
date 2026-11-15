#!/usr/bin/env node
// The admission rules of src/inflight-cover.js, offline (an injected balance
// reader and paid record; no server):
//   - a balance that is read decides alone: every call it covers is admitted
//     at once, however many, and a call it does not cover is refused at once;
//     no call waits for another's settlement to make room;
//   - a balance that cannot be read now: the wallet's last good read (up to
//     fifteen minutes old), less what its calls took or hold since, decides;
//     a wallet with no such read gets a fixed allowance of runs in flight
//     (sixteen with a paid record, four without, four on a report or media
//     route), and a call past it is refused at once;
//   - a slow read is not a failed one; a failed read marks that account only,
//     and is then made at most once a second; a full read lane is waited for;
//   - the admission wait is bounded (about a second; five on the report and
//     media routes, which are judged as they always were, Retry-After 30);
//   - a run that leaves while a read is under way forces no further read (the
//     read is judged with what left taken off, whether or not it is still in
//     the maps), and a judgment that has had a read never becomes an unread
//     one;
//   - a call that arrived before the wallet's last settlement is judged on a
//     read, not on verify's proof;
//   - a call beside one that is still settling, whose balance cannot yet be
//     confirmed, is refused with Retry-After 5 in words that say so;
//   - the per-wallet store is bounded;
//   - a Circle Gateway batched payment is judged on the signer's Gateway
//     balance; the EVM chain table comes from the rails table.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { admitCoveredRun, coverageReadsWord, coverageReadsVerdict, _ageUnreadDecisionsForTest, _ageKeptReadsForTest, coverTermsOfRequest, coveredRunStateOf, inflightCoverStatus, CHAIN_BY_CAIP2, _setBalanceReaderForTest, _resetInflightCoverForTest } from "../src/inflight-cover.js";
import { hasPaidRecord, notePaidSettlement, setPaidRecordLedger, _setPaidRecordForTest, _resetPaidRecordForTest } from "../src/paid-record.js";
import { readRailBalance, _setGatewayBalanceClientForTest } from "../src/rail-cover.js";
import { RAILS, GATED_RAILS } from "../src/rails.js";
import { toolErrorFields, notCallersInput } from "../src/tool-error-fields.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const PRICE = 600000n;
let nonce = 0;
const hdr = (from, { network = "eip155:8453", extra = null } = {}) => b64({ x402Version: 2, accepted: { scheme: "exact", network, asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", ...(extra ? { extra } : {}) }, payload: { signature: "0x11", authorization: { from, to: "0x" + "cd".repeat(20), value: String(PRICE), validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonce).toString(16).padStart(64, "0") } } });
const reqFor = (h) => ({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
const W = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(20);
const admit = async (from, opts = {}, hopts = {}) => { const req = reqFor(hdr(from, hopts)); try { return { req, release: await admitCoveredRun(req, opts) }; } catch (err) { return { req, err }; } };
const fresh = () => { _resetInflightCoverForTest(); _resetPaidRecordForTest(); };

// ---- the paid record ----
{
  fresh();
  ok(hasPaidRecord(W(1)) === false, "no ledger and no settlement seen: not a paid record");
  notePaidSettlement(W(1).toUpperCase().replace("0X", "0x"));
  ok(hasPaidRecord(W(1)) === true, "a settlement seen by this process is a paid record at once (EVM addresses in any case)");
  setPaidRecordLedger({ payerHasPaidSale: (p) => p === W(2), salesLedgerLoaded: () => true });
  ok(hasPaidRecord(W(2)) === true && hasPaidRecord(W(3)) === false, "else the sales ledger's paid-sale read answers");
  setPaidRecordLedger({ payerHasPaidSale: () => false, salesLedgerLoaded: () => false });
  ok(hasPaidRecord(W(3)) === true, "a ledger whose first load has not landed counts as paid");
  setPaidRecordLedger({ payerHasPaidSale: () => { throw new Error("db"); }, salesLedgerLoaded: () => true });
  ok(hasPaidRecord(W(3)) === true, "a ledger read that throws counts as paid");
  ok(hasPaidRecord("") === false && hasPaidRecord("not an address") === false && hasPaidRecord(null) === false, "no payer is no record");
  setPaidRecordLedger({});
}

// ---- an unread balance is a bounded allowance, never an open door ----
{
  fresh();
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  _setPaidRecordForTest((p) => p === W(0x11) || p === W(0x13));
  // A wallet with a paid record: sixteen at once, on a route that is not a report or media route.
  const paid = await Promise.all(Array.from({ length: 40 }, () => admit(W(0x11))));
  const in16 = paid.filter((x) => x.release), out16 = paid.filter((x) => x.err);
  ok(in16.length === 16 && out16.length === 24 && inflightCoverStatus().unreadPaidMax === 16, `balance unreadable, a wallet with a paid record: 16 at once are admitted and the rest refused (${in16.length} admitted)`);
  ok(out16.every((x) => x.err.statusCode === 429 && /You have not been charged\./.test(x.err.message)), "the rest are refused 429, uncharged");
  ok(in16.filter((x) => coveredRunStateOf(x.req) === "trusted").length === 15 && in16.filter((x) => coveredRunStateOf(x.req) === "covered").length === 1, "the first is covered by verify's proof and the rest are marked trusted");
  // The same wallet on a report or media route: the allowance that route always had.
  const tExp = Date.now();
  const exp = await Promise.all(Array.from({ length: 12 }, () => admit(W(0x13), { expensive: true })));
  ok(Date.now() - tExp < 300, `... and a call past it is refused at once there, as it always was (${Date.now() - tExp} ms)`);
  ok(exp.filter((x) => x.release).length === 4, `on a report or media route a wallet with a paid record keeps the allowance of four (${exp.filter((x) => x.release).length} admitted)`);
  // A wallet that has never settled: four.
  const neverPaid = await Promise.all(Array.from({ length: 12 }, () => admit(W(0x12))));
  const ran = neverPaid.filter((x) => x.release), refused = neverPaid.filter((x) => x.err);
  ok(ran.length === 4 && refused.length === 8 && refused.every((x) => x.err.statusCode === 429 && /could not be read/.test(x.err.message)), `balance unreadable, a wallet that has never settled: four at once, the rest refused (${ran.length} admitted)`);
  ok(ran.slice(1).every((x) => coveredRunStateOf(x.req) === "unread"), "those admitted on the allowance are marked unread");
  for (const x of [...in16, ...exp, ...ran]) x.release?.();
  ok(inflightCoverStatus().runsInFlight === 0, "all released");

  // A call past the allowance is refused at once: nothing waits for a place in it.
  fresh();
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  const first4 = []; for (let i = 0; i < 4; i++) first4.push(await admit(W(0x14)));
  ok(first4.every((x) => x.release) && inflightCoverStatus().runsInFlight === 4, "a never-settled wallet with the balance unreadable: four in flight");
  const tPast = Date.now();
  const past = await Promise.all(Array.from({ length: 26 }, () => admit(W(0x14))));
  ok(past.every((x) => x.err?.statusCode === 429 && x.err.retryAfter === 5 && /could not be read/.test(x.err.message) && /You have not been charged\./.test(x.err.message)) && Date.now() - tPast < 300, `26 more calls are refused at once, 429 with Retry-After 5, uncharged: none waits for a place (${Date.now() - tPast} ms)`);
  // A settlement makes a paid record: a call that BEGINS after it is held to the paid allowance.
  first4[0].release.settled();
  ok(hasPaidRecord(W(0x14)) && inflightCoverStatus().runsInFlight === 3, "one of the four settles: a paid record, three in flight");
  const late = await Promise.all(Array.from({ length: 20 }, () => admit(W(0x14))));
  ok(late.filter((x) => x.release).length === 13 && late.filter((x) => x.release).every((x) => coveredRunStateOf(x.req) === "trusted") && inflightCoverStatus().runsInFlight === 16, `calls that begin after the record exists are held to the paid allowance: sixteen in flight (${late.filter((x) => x.release).length} of 20 admitted)`);
  for (const x of [...first4.slice(1), ...late]) x.release?.();
  // A run that leaves makes room in the allowance for a call that arrives after it, and for no call before it.
  fresh();
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  const four = []; for (let i = 0; i < 4; i++) four.push(await admit(W(0x15)));
  const fifth = await admit(W(0x15));
  four[1].release();
  const sixth = await admit(W(0x15));
  ok(fifth.err?.statusCode === 429 && sixth.release && coveredRunStateOf(sixth.req) === "unread" && inflightCoverStatus().runsInFlight === 4, "a fifth call is refused while four are in flight; after one leaves, the next call takes its place");
  for (const x of [...four, sixth]) x.release?.();
  ok(inflightCoverStatus().runsInFlight === 0, "all released");
}

// ---- the admission wait is bounded; a slow read is not a failed one ----
{
  fresh();
  let reads = 0;
  _setBalanceReaderForTest(async () => { reads++; await sleep(3000); return PRICE * 1000n; });
  _setPaidRecordForTest(() => true);
  const first = await admit(W(0x21));
  const t0 = Date.now();
  const second = await admit(W(0x21));
  const took = Date.now() - t0;
  ok(typeof second.release === "function" && took >= 900 && took < 1500, `a read that does not answer is left behind after about a second (${took} ms)`);
  ok(coveredRunStateOf(second.req) === "trusted", "the run is admitted on the wallet's paid record");
  const t1 = Date.now();
  const more = await Promise.all(Array.from({ length: 10 }, () => admit(W(0x21))));
  const took2 = Date.now() - t1;
  ok(more.every((x) => x.release) && took2 >= 900 && took2 < 1500 && reads === 1, `a slow read does not mark the account down: ten more wait the same second for the same read (${took2} ms, ${reads} read)`);
  // Another wallet on the network waits for its own read.
  const other = await admit(W(0x22));
  const t2 = Date.now();
  const other2 = await admit(W(0x22));
  const took3 = Date.now() - t2;
  ok(other2.release && took3 >= 900, `another wallet on that network is not marked by it: its own read is waited for (${took3} ms)`);
  ok(inflightCoverStatus().readsTimedOut === 12 && inflightCoverStatus().readsWentDown === 0, `twelve admissions outlasted their read and no account was marked down (${inflightCoverStatus().readsTimedOut}, ${inflightCoverStatus().readsWentDown})`);
  // When the slow read answers it is the wallet's last good read: the next calls are judged on it at once.
  await sleep(3100 - (Date.now() - t0));
  const tOnRead = Date.now();
  const onRead = await Promise.all(Array.from({ length: 30 }, () => admit(W(0x21))));
  ok(onRead.every((x) => x.release && coveredRunStateOf(x.req) === "covered") && Date.now() - tOnRead < 300 && reads === 2, `once the slow read has answered, 30 more calls are covered by it at once, with no further read (${Date.now() - tOnRead} ms, ${reads} reads for two wallets)`);
  for (const x of [first, second, ...more, other, other2, ...onRead]) x.release();
  // A read that succeeds ends the down state.
  fresh();
  let slow = true;
  _setBalanceReaderForTest(async () => { if (slow) await sleep(1500); return PRICE * 1000n; });
  _setPaidRecordForTest(() => true);
  const a = await admit(W(0x23)); const b = await admit(W(0x23));
  slow = false;
  await sleep(700); // the slow read lands and is kept
  const c = await admit(W(0x23));
  ok(coveredRunStateOf(b.req) === "trusted" && coveredRunStateOf(c.req) === "covered", "once a read succeeds the next run is judged on it again");
  for (const x of [a, b, c]) x.release();

  // One account's failed read is that account's: an honest new wallet beside it is read and served.
  fresh();
  _setBalanceReaderForTest(async (t) => { if (t.payer === W(0x24)) throw new Error("this account cannot be read"); return PRICE * 100n; });
  const bad1 = await admit(W(0x24)); const bad2 = await admit(W(0x24));
  ok(coveredRunStateOf(bad2.req) === "unread", "an account whose read fails is held to its allowance");
  const t4 = Date.now();
  const honest = await Promise.all(Array.from({ length: 8 }, () => admit(W(0x25))));
  ok(honest.every((x) => x.release) && honest.slice(1).every((x) => coveredRunStateOf(x.req) === "covered") && Date.now() - t4 < 400, `a new funded wallet on the same network: eight at once, all covered by its own read (${honest.filter((x) => x.err).length} refused)`);
  for (const x of [bad1, bad2, ...honest]) x.release();

  // The read lane is a queue: a full lane is waited for, never read as unknown.
  fresh();
  let made = 0;
  _setBalanceReaderForTest(async (t) => { made++; if (t.payer !== W(0x2f)) await sleep(500); return t.payer === W(0x2f) ? PRICE : PRICE * 100n; });
  _setPaidRecordForTest(() => true);
  const helpers = [];
  for (let i = 0; i < 8; i++) helpers.push(await admit(W(0x30 + i)));
  const target1 = await admit(W(0x2f)); // holds one price, readable
  const helperSeconds = Promise.all(helpers.map((_, i) => admit(W(0x30 + i)))); // eight reads fill the lane
  await sleep(20);
  ok(inflightCoverStatus().readsQueued === 0, "eight reads fill the lane");
  const t5 = Date.now();
  const many = await Promise.all(Array.from({ length: 20 }, () => admit(W(0x2f))));
  const took5 = Date.now() - t5;
  ok(many.every((x) => x.err?.statusCode === 429 && /does not cover this one as well/.test(x.err.message)), `a wallet holding one price whose read finds the lane full: its read is made and all 20 are refused as short (${many.filter((x) => x.release).length} admitted)`);
  ok(took5 >= 350 && took5 < 1200 && made === 9, `the read waited its turn in the lane (${took5} ms, ${made} reads)`);
  for (const x of [target1, ...helpers, ...(await helperSeconds)]) x.release?.();
}

// ---- INFLIGHT_COVER=composite: the scope and limits the check had before ----
{
  fresh();
  process.env.INFLIGHT_COVER = "composite";
  _setBalanceReaderForTest(async () => PRICE * 100n);
  const cheap = await admit(W(0x71));
  ok(cheap.release === null && !cheap.err, "composite: a route that is not a report or media route is not judged at all");
  const twelve = await Promise.all(Array.from({ length: 12 }, () => admit(W(0x72), { expensive: true })));
  ok(twelve.every((x) => x.release), "composite: a new funded wallet's twelve report runs at once are all admitted");
  _setBalanceReaderForTest(async () => PRICE);
  const p1 = await admit(W(0x73), { expensive: true }); const p2 = await admit(W(0x73), { expensive: true });
  ok(p1.release && p2.err?.statusCode === 429, "composite: a wallet holding one price is refused its second report run");
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  _setPaidRecordForTest(() => true);
  const un = await Promise.all(Array.from({ length: 10 }, () => admit(W(0x74), { expensive: true, settleWaitMs: 50 })));
  ok(un.filter((x) => x.release).length === 4, "composite: an unread balance admits four, for any wallet");
  ok(inflightCoverStatus().mode === "composite" && inflightCoverStatus().enabled === true, "the operator view names the mode");
  for (const x of [...twelve, p1, ...un]) x.release?.();
  process.env.INFLIGHT_COVER = "off";
  const off = await admit(W(0x75), { expensive: true });
  ok(off.release === null && inflightCoverStatus().mode === "off", "off: nothing is judged anywhere");
  delete process.env.INFLIGHT_COVER;
}

// ---- runs that leave during a read force no further read ----
{
  fresh();
  let reads = 0;
  _setBalanceReaderForTest(async () => { reads++; await sleep(120); return PRICE * 100000n; });
  _setPaidRecordForTest(() => true);
  // Eight at a time, each run leaving 40 ms after it starts: a run leaves
  // during every read.
  let idx = 0; const lat = []; const errs = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (idx < 96) {
      idx++;
      const t = Date.now();
      const x = await admit(W(0x31));
      lat.push(Date.now() - t);
      if (x.err) { errs.push(x.err); continue; }
      x.release.settling();
      await sleep(40);
      x.release.settled();
    }
  }));
  const total = Date.now() - t0;
  ok(errs.length === 0, `96 calls, eight at a time, from a funded wallet: none refused (${errs.length})`);
  ok(reads <= 3, `a run leaving during a read does not force another read (${reads} reads for 96 calls)`);
  ok(total < 96 / 8 * 40 + 700, `the admissions add no more than one read's wait to the whole run (${total} ms for 12 rounds of 40 ms)`);
  const waited = lat.filter((ms) => ms > 60).length;
  ok(waited <= 10, `only the admissions that overlapped the first read waited for it (${waited} of 96 waited over 60 ms)`);
  // One after another: no read is waited for; the first settlement takes one in the background, kept as the wallet's last good read.
  fresh(); reads = 0;
  _setBalanceReaderForTest(async () => { reads++; return PRICE * 100000n; });
  for (let i = 0; i < 20; i++) { const x = await admit(W(0x32)); x.release.settling(); x.release.settled(); }
  ok(reads === 1 && inflightCoverStatus().backgroundReads === 1, `twenty calls one after another, each settled: one balance read in all, taken in the background (${reads})`);
  // The lower bound: a record is judged with what left since taken off, and a
  // judgment that fails on that alone takes one fresh read.
  fresh(); reads = 0;
  let balance = PRICE * 3n;
  _setBalanceReaderForTest(async () => { reads++; return balance; });
  _setPaidRecordForTest(() => true);
  const r1 = await admit(W(0x33)), r2 = await admit(W(0x33));
  ok(reads === 1 && r2.release, "a second run reads the balance once");
  r1.release.settled(); balance = PRICE * 2n; // r1's payment left the wallet
  const r3 = await admit(W(0x33));
  ok(r3.release && reads === 1, `a third run fits what the record still shows after one settlement is taken off: no read (${reads})`);
  const r4 = await admit(W(0x33));
  ok(r4.err?.statusCode === 429 && reads === 2 && /does not cover this one as well/.test(r4.err.message) && r4.err.retryAfter === 30, `a fourth does not: one fresh read decides, and it is refused as short (${r4.err?.statusCode}, reads ${reads})`);
  { const f = toolErrorFields(r4.err); ok(f.attribution === "ours" && f.hint === "cover-short" && f.reason === "cover_short" && f.retryAfterSeconds === 30 && /Retry-After|add funds/i.test(f.fix || "") && /Your input is fine/.test(r4.err.message), `the short refusal's answer fields name its class and the next step (${JSON.stringify(f)})`); }
  balance = PRICE * 3n; // a top-up
  const r4b = await admit(W(0x33));
  ok(r4b.err?.statusCode === 429 && reads === 2, "within a second of that read the record is reused: no further read");
  await sleep(1100);
  const r5 = await admit(W(0x33));
  ok(r5.release && reads === 3, "after a top-up, a read a second later admits it");
  for (const x of [r2, r3, r5]) x.release();
}

// ---- a call beside one that is still settling ----
{
  fresh();
  let balance = PRICE * 2n;
  _setBalanceReaderForTest(async () => balance);
  _setPaidRecordForTest(() => true);
  const a = await admit(W(0x41));
  a.release.settling();
  balance = PRICE; // A's payment is off the wallet; its settle call has not answered
  const t0 = Date.now();
  const b = await admit(W(0x41));
  const took = Date.now() - t0;
  ok(b.err?.statusCode === 429 && took >= 900 && took < 1500, `a call beside one whose settlement has not answered waits about a second, then is refused (${b.err?.statusCode}, ${took} ms)`);
  ok(b.err?.retryAfter === 5 && /Another call from this wallet is still settling/.test(b.err.message) && /retry the same call after Retry-After, once that call has settled\. You have not been charged\./.test(b.err.message) && !/does not cover/.test(b.err.message), `the refusal says another call is still settling and asks for a retry after Retry-After, 5 s (${b.err?.retryAfter}: ${String(b.err?.message).slice(0, 70)}...)`);
  // Not an input error: attributed to this server's own limit, so the answer
  // carries no input schema, and it names its class and the next step.
  {
    const f = toolErrorFields(b.err);
    ok(b.err.attribution === "ours" && notCallersInput(b.err, 429) && f.attribution === "ours" && f.hint === "cover-settling" && f.reason === "cover_settling" && f.retryAfterSeconds === 5 && /^Your input is fine\. Retry the same call after Retry-After/.test(f.fix || ""),
      `the settling refusal's answer fields: attribution ours, hint cover-settling, reason cover_settling, a fix, no schema (${JSON.stringify(f)})`);
  }
  ok(inflightCoverStatus().refusedSettling === 1, "counted as a settling refusal");
  // The settle answers within the wait: served.
  const cP = admit(W(0x41));
  setTimeout(() => a.release.settled(), 200);
  const c = await cP;
  ok(typeof c.release === "function", "when the settle answers inside the wait the call is admitted");
  c.release();
}

// ---- reads: a young record is reused, a read nobody waits for is dropped, no listener on an admitted call ----
{
  // One long run in flight from a wallet holding exactly its price: sixty
  // more calls one after another are refused on one read, not sixty.
  fresh();
  let reads = 0;
  _setBalanceReaderForTest(async () => { reads++; return PRICE; });
  _setPaidRecordForTest(() => true);
  const long = await admit(W(0x81));
  let refused = 0;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) { const x = await admit(W(0x81)); if (x.err?.statusCode === 429 && x.err.retryAfter === 30) refused++; }
  ok(refused === 60 && reads <= Math.ceil((Date.now() - t0) / 1000) + 1, `sixty refusals in ${Date.now() - t0} ms cost ${reads} balance read(s): a record under a second old is reused`);
  await sleep(1100);
  await admit(W(0x81));
  ok(reads >= 2, "a record over a second old is read again");
  long.release();
  // The read lane full of slow reads; twenty other wallets ask, give up, and
  // their reads are dropped when their turn comes.
  fresh();
  let made = 0;
  _setBalanceReaderForTest(async () => { made++; await sleep(400); return PRICE * 100n; });
  const firsts = []; for (let i = 0; i < 28; i++) firsts.push(await admit(W(0x90 + i)));
  const slow = Array.from({ length: 8 }, (_, i) => admit(W(0x90 + i), { settleWaitMs: 2000 }));
  await sleep(20);
  const quick = await Promise.all(Array.from({ length: 20 }, (_, i) => admit(W(0x98 + i), { settleWaitMs: 100 })));
  ok(inflightCoverStatus().readsQueued === 20 && quick.every((x) => x.release), `twenty reads wait behind a full lane; their admissions end after their short wait (${inflightCoverStatus().readsQueued} queued)`);
  await Promise.all(slow);
  await sleep(200);
  ok(made === 8 && inflightCoverStatus().readsDropped === 20 && inflightCoverStatus().readsQueued === 0, `when the lane frees, the reads nobody is waiting for are not made (${made} reads made, ${inflightCoverStatus().readsDropped} dropped)`);
  // The admission never puts a listener on a response: no call is held for
  // longer than the admission wait, so none watches for its buyer leaving.
  fresh();
  _setBalanceReaderForTest(async () => PRICE * 100n);
  const { EventEmitter } = await import("node:events");
  const warnings = [];
  const onWarning = (w) => { if (w?.name === "MaxListenersExceededWarning") warnings.push(w); };
  process.on("warning", onWarning);
  const withRes = (from = W(0x82)) => {
    const req = reqFor(hdr(from));
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, registered: 0 });
    for (let i = 0; i < 10; i++) res.on("close", () => {}); // a response already at its default limit, as a served one is
    const once = res.once.bind(res);
    res.once = (name, fn) => { if (name === "close") res.registered++; return once(name, fn); };
    req.res = res;
    return req;
  };
  const reqs = Array.from({ length: 6 }, () => withRes());
  const rels = []; for (const req of reqs) rels.push(await admitCoveredRun(req));
  ok(reqs.every((req) => req.res.registered === 0 && req.res.listenerCount("close") === 10), "six admitted calls (verify's proof, then balance reads): none put a close listener on its response");
  // Nor does a call that is refused, or one that waits out a settling run.
  rels[0].settling();
  const shortReq = withRes(W(0x83));
  _setBalanceReaderForTest(async () => PRICE);
  const heldRel = await admitCoveredRun(shortReq);
  const refusedReq = withRes(W(0x83));
  const refusedErr = await admitCoveredRun(refusedReq).then(() => null, (e) => e);
  ok(refusedErr?.statusCode === 429 && refusedReq.res.registered === 0 && refusedReq.res.listenerCount("close") === 10 && warnings.length === 0, `a refused call put no listener on its response either; no listener-limit warning was printed (${warnings.length})`);
  process.removeListener("warning", onWarning);
  for (const r of [...rels, heldRel]) r();
}

// ---- a balance that is read decides alone: no bound on runs at once, and nothing waits ----
{
  fresh();
  let reads = 0;
  _setBalanceReaderForTest(async () => { reads++; await sleep(40); return PRICE * 1000n; });
  for (const [who, paidRecord] of [[W(0x91), false], [W(0x92), true]]) {
    _setPaidRecordForTest(() => paidRecord);
    const t0 = Date.now();
    const all = await Promise.all(Array.from({ length: 200 }, () => admit(who)));
    ok(all.every((x) => x.release) && inflightCoverStatus().runsInFlight === 200 && Date.now() - t0 < 600, `a funded wallet ${paidRecord ? "with a paid record" : "that has never settled"}: 200 calls at once are all admitted at once, on one read (${all.filter((x) => x.release).length} admitted in ${Date.now() - t0} ms)`);
    for (const x of all) x.release();
  }
  ok(reads <= 4, `the two bursts of 200 cost a read or two each, never one per call (${reads})`);
  // Funded for one call, and for five: that many run, the rest are refused at once.
  for (const [who, n] of [[W(0x93), 1n], [W(0x94), 5n]]) {
    _setBalanceReaderForTest(async () => { await sleep(40); return PRICE * n; });
    const t0 = Date.now();
    const all = await Promise.all(Array.from({ length: 40 }, () => admit(who)));
    const ran = all.filter((x) => x.release), out = all.filter((x) => x.err);
    ok(ran.length === Number(n) && out.every((x) => x.err.statusCode === 429 && x.err.retryAfter === 30 && /does not cover this one as well/.test(x.err.message) && /You have not been charged\./.test(x.err.message)) && Date.now() - t0 < 600, `a wallet whose balance covers ${n}: of 40 calls at once ${ran.length} ${ran.length === 1 ? "is" : "are"} admitted and the rest refused at once, 429 with Retry-After 30, uncharged (${Date.now() - t0} ms)`);
    // A run that leaves unpaid makes room for exactly one more; nothing was waiting for it.
    ran[0].release();
    const next = await Promise.all([admit(who), admit(who)]);
    ok(next.filter((x) => x.release).length === 1 && inflightCoverStatus().runsInFlight === Number(n), "after one of them leaves unpaid, one more call is admitted and a second is refused");
    for (const x of [...ran, ...next]) x.release?.();
  }
  ok(inflightCoverStatus().runsInFlight === 0, "all released");
}

// ---- the report and media routes are judged as they always were ----
{
  fresh();
  // A balance read that takes two seconds: longer than the wait every other
  // route gives a read, inside the five seconds these routes always gave.
  _setBalanceReaderForTest(async ({ payer }) => { await sleep(2000); return payer === W(0xa1) || payer === W(0xa3) ? PRICE : PRICE * 1000n; });
  const t0 = Date.now();
  const [one, funded, other, otherFunded] = await Promise.all([
    Promise.all(Array.from({ length: 40 }, () => admit(W(0xa1), { expensive: true }))),
    Promise.all(Array.from({ length: 24 }, () => admit(W(0xa2), { expensive: true }))),
    Promise.all(Array.from({ length: 40 }, () => admit(W(0xa3))).map((p) => p.then((x) => ({ ...x, ms: Date.now() - t0 })))),
    Promise.all(Array.from({ length: 24 }, () => admit(W(0xa4))).map((p) => p.then((x) => ({ ...x, ms: Date.now() - t0 })))),
  ]);
  const ms = Date.now() - t0;
  ok(one.filter((x) => x.release).length === 1 && ms >= 1900 && ms < 3500, `report or media route, a wallet holding one price, a 2 s read: the read is waited for and one of 40 calls runs (${one.filter((x) => x.release).length}; ${ms} ms)`);
  ok(one.filter((x) => x.err).every((x) => x.err.statusCode === 429 && x.err.retryAfter === 30 && /does not cover this one as well/.test(x.err.message)), "the rest answer 429 with Retry-After 30, in the words they always had");
  ok(funded.every((x) => x.release), `report or media route, a funded wallet, a 2 s read: 24 at once are all admitted (${funded.filter((x) => x.release).length})`);
  ok(other.filter((x) => x.release).length === 4 && other.every((x) => x.ms < 1600) && other.filter((x) => x.err).every((x) => /could not be read/.test(x.err.message) && x.err.retryAfter === 5), `every other route, the same wallet and read: the read is left after about a second and the allowance of four applies (${other.filter((x) => x.release).length} admitted, the slowest answer ${Math.max(...other.map((x) => x.ms))} ms)`);
  ok(otherFunded.filter((x) => x.release).length === 4 && otherFunded.every((x) => x.ms < 1600), `every other route, a funded wallet whose read takes 2 s: four admitted and the rest refused (${otherFunded.filter((x) => x.release).length}); the one place a wallet that could pay is refused`);
  for (const x of [...one, ...funded, ...other, ...otherFunded]) x.release?.();
  await sleep(1200); // the reads left behind end
  ok(inflightCoverStatus().runsInFlight === 0, "all released");
}

// ---- balance not readable now: the wallet's last good read, less what left since ----
{
  fresh();
  let up = true, reads = 0, balance = PRICE * 1000n;
  _setBalanceReaderForTest(async () => { reads++; if (!up) throw new Error("rpc down"); return balance; });
  const settleOne = async (who) => { const x = await admit(who); x.release.settling(); x.release.settled(); await sleep(5); };
  // A funded wallet that has paid here: its settlement left a good read behind.
  await settleOne(W(0xb1));
  ok(reads === 1 && coverageReadsWord() === "ok", "a wallet's settled call leaves a last good read behind (one read, in the background)");
  up = false;
  _ageKeptReadsForTest(60_000); // past the ten seconds a read is reused for: every judgment now asks for a read and finds none
  for (const [n, paid] of [[12, false], [40, false], [90, true], [200, true]]) {
    _setPaidRecordForTest(() => paid);
    const t0 = Date.now();
    const all = await Promise.all(Array.from({ length: n }, () => admit(W(0xb1))));
    ok(all.every((x) => x.release && coveredRunStateOf(x.req) === "covered") && Date.now() - t0 < 400, `reads down, a funded wallet read before${paid ? ", with a paid record" : ""}: ${n} calls at once are all admitted on its last good read (${all.filter((x) => x.release).length}; ${Date.now() - t0} ms)`);
    for (const x of all) x.release();
  }
  ok(coverageReadsWord() === "degraded" && inflightCoverStatus().admittedOnKeptRead > 0 && inflightCoverStatus().accountsReadDown === 1, `the status word reads degraded while admissions are decided without a read (${coverageReadsWord()})`);
  // While the account's reads fail, it is read at most once a second.
  const r0 = reads, tr = Date.now();
  const burst = await Promise.all(Array.from({ length: 200 }, () => admit(W(0xb1))));
  // ... and so are 60 calls one after another, each of which asks for a read of its own.
  const seq = []; for (let i = 0; i < 60; i++) seq.push(await admit(W(0xb1)));
  ok(reads - r0 <= 1 + Math.ceil((Date.now() - tr) / 1000), `200 calls at once and 60 one after another while the read fails cost at most one read a second (${reads - r0} reads in ${Date.now() - tr} ms)`);
  for (const x of [...burst, ...seq]) x.release?.();
  // A kept read is never stricter than no read: a wallet whose last good read
  // held ONE price (it may have been funded since) falls to the allowance.
  fresh(); reads = 0; up = true; balance = PRICE;
  _setBalanceReaderForTest(async () => { reads++; if (!up) throw new Error("rpc down"); return balance; });
  await settleOne(W(0xb2)); // the read behind its settled call says one price is left; it has a paid record now
  await sleep(20);
  up = false;
  _ageKeptReadsForTest(60_000);
  const one = await Promise.all(Array.from({ length: 40 }, () => admit(W(0xb2))));
  const ran = one.filter((x) => x.release), out = one.filter((x) => x.err);
  ok(ran.length === 16 && out.length === 24 && inflightCoverStatus().admittedPastKeptRead === 15 && out.every((x) => x.err.statusCode === 429 && x.err.retryAfter === 5 && x.err.coverRefusal === "kept" && /could not be read just now/.test(x.err.message) && /You have not been charged\./.test(x.err.message)), `reads down, a wallet whose last good read holds one price: the allowance of a wallet with no read (16 of 40), the rest 429 with Retry-After 5, uncharged (${ran.length} ran)`);
  for (const x of ran) x.release();
  // Only what a run took is taken off a kept read: [what, how the runs leave, how many, admitted of five, covered by the kept read].
  for (const [what, leave, n, admitted, onKept] of [
    ["six calls that failed upstream (answered 502, nothing settled)", (x) => { x.req.res = { statusCode: 502 }; x.release(); }, 6, 5, 4],
    ["a settle under a ceiling of one price that took a tenth of it", (x) => { x.release.settling(); x.release.settled(PRICE / 10n); }, 1, 5, 4],
    ["a call that answered 200 with no settlement reported (counted in full: a settler this process was not told of may have taken it)", (x) => { x.req.res = { statusCode: 200 }; x.release(); }, 1, 4, 3],
    ["a settle reporting more than the payment commits (counted as the payment's amount, never more)", (x) => { x.release.settling(); x.release.settled(PRICE * 100n); }, 1, 4, 3],
  ]) {
    fresh(); up = true; balance = PRICE * 5n + PRICE / 2n;
    _setBalanceReaderForTest(async () => { if (!up) throw new Error("rpc down"); return balance; });
    _setPaidRecordForTest(() => false);
    await settleOne(W(0xb6)); // a kept read of five and a half prices
    await sleep(20);
    for (let i = 0; i < n; i++) leave(await admit(W(0xb6)));
    up = false;
    _ageKeptReadsForTest(60_000);
    const five = await Promise.all(Array.from({ length: 5 }, () => admit(W(0xb6))));
    ok(five.filter((x) => x.release).length === admitted && inflightCoverStatus().admittedOnKeptRead === onKept, `after ${what}: of five calls at once ${admitted} are admitted, ${onKept} of them on the kept read (${five.filter((x) => x.release).length} admitted, ${inflightCoverStatus().admittedOnKeptRead} on the kept read)`);
    for (const x of five) x.release?.();
  }
  _setPaidRecordForTest(() => false);
  // A wallet never read here, reads down: the allowance, then 429.
  _setPaidRecordForTest(() => false);
  const never = await Promise.all(Array.from({ length: 12 }, () => admit(W(0xb3))));
  ok(never.filter((x) => x.release).length === 4 && never.filter((x) => x.err).every((x) => x.err.coverRefusal === "unread"), `reads down, a wallet never read here: the allowance of four, then 429 (${never.filter((x) => x.release).length} admitted)`);
  for (const x of never) x.release?.();
  // A last good read older than fifteen minutes is no longer judged on: the allowance.
  fresh(); up = true; balance = PRICE * 1000n;
  _setBalanceReaderForTest(async () => { if (!up) throw new Error("rpc down"); return balance; });
  await settleOne(W(0xb4));
  up = false;
  _ageKeptReadsForTest(14 * 60_000);
  const young = await Promise.all(Array.from({ length: 12 }, () => admit(W(0xb4))));
  ok(young.every((x) => x.release), "a last good read fourteen minutes old is still judged on: 12 at once all admitted");
  for (const x of young) x.release();
  _ageKeptReadsForTest(2 * 60_000);
  const old = await Promise.all(Array.from({ length: 40 }, () => admit(W(0xb4))));
  ok(old.filter((x) => x.release).length === 16 && old.filter((x) => x.release).slice(1).every((x) => coveredRunStateOf(x.req) === "trusted") && inflightCoverStatus().goodReadMaxMs === 15 * 60_000, `past fifteen minutes it is not: the allowance (sixteen of 40: the wallet has a paid record) (${old.filter((x) => x.release).length} admitted)`);
  for (const x of old) x.release?.();
  // The report and media routes are not judged on a kept read: the four they always had.
  fresh(); up = true;
  _setBalanceReaderForTest(async () => { if (!up) throw new Error("rpc down"); return balance; });
  await settleOne(W(0xb5));
  up = false; _ageKeptReadsForTest(60_000);
  const exp = await Promise.all(Array.from({ length: 12 }, () => admit(W(0xb5), { expensive: true })));
  ok(exp.filter((x) => x.release).length === 4, `report or media route, reads down, a wallet read before: four at once, as always (${exp.filter((x) => x.release).length})`);
  for (const x of exp) x.release?.();
}

// ---- a read that left the maps still has what settled since taken off it ----
{
  fresh();
  // A holds the wallet's one price and is settling. X asks for a read (slow);
  // Y asks 50 ms later for a later one, which replaces X's in the maps after
  // 250 ms. A settles and leaves while X's read is still under way. X's read
  // then answers with the balance from BEFORE that settlement.
  let n = 0;
  _setBalanceReaderForTest(async () => { const mine = ++n; await sleep(mine === 1 ? 20 : 600); return mine === 1 ? PRICE : mine === 2 ? PRICE : 0n; });
  for (const expensive of [true, false]) {
    n = 0; _resetInflightCoverForTest();
    _setBalanceReaderForTest(async () => { const mine = ++n; await sleep(mine === 1 ? 20 : 600); return mine <= 2 ? PRICE : 0n; });
    const who = expensive ? W(0xc1) : W(0xc2);
    const A = await admit(who, { expensive });
    const Z = await admit(who, { expensive }); // leaves a cached read of one price
    A.release.settling();
    await sleep(1050); // the cached read is past its second: the next judgment takes a fresh one
    const pX = admit(who, { expensive, settleWaitMs: 3000 });
    await sleep(50);
    const pY = admit(who, { expensive, settleWaitMs: 3000 });
    await sleep(300); // Y's read has replaced X's in the maps
    A.release.settled(); // the price is off the wallet; X's read, begun before, still says one price
    const [X, Y] = await Promise.all([pX, pY]);
    ok(Z.err && X.err?.statusCode === 429 && Y.err?.statusCode === 429 && inflightCoverStatus().runsInFlight === 0, `${expensive ? "report or media route" : "every other route"}: a read replaced in the maps while a run settled and left does not admit a second run (${[X, Y].filter((x) => x.release).length} admitted)`);
    for (const x of [X, Y]) x.release?.();
  }
}

// ---- once a judgment has had a read, a later read that does not answer never makes it an unread one ----
for (const expensive of [false, true]) {
  fresh();
  let n = 0;
  _setBalanceReaderForTest(async () => { const mine = ++n; if (mine > 1) await sleep(5000); return PRICE; });
  const who = expensive ? W(0xd2) : W(0xd1);
  const A = await admit(who, { expensive });
  A.release.settling();
  const pX = admit(who, { expensive, settleWaitMs: 1000 }), pY = admit(who, { expensive, settleWaitMs: 1000 }); // both wait on the settling run, on a read of one price
  await sleep(300);
  A.release.settled();
  const [X, Y] = await Promise.all([pX, pY]);
  ok(X.err?.statusCode === 429 && Y.err?.statusCode === 429, `${expensive ? "report or media route" : "every other route"}: two calls that waited on a settling run, whose fresh read then outlasts the wait, are refused 429, not admitted on the allowance (${[X, Y].filter((x) => x.release).length} admitted)`);
  ok(inflightCoverStatus().admittedUnread === 0 && inflightCoverStatus().admittedTrusted === 0, "nothing was admitted as unread");
  for (const x of [X, Y]) x.release?.();
}

// ---- a settlement that lands after a request arrived: verify's proof no longer stands ----
{
  fresh();
  let reads = 0, balance = PRICE;
  _setBalanceReaderForTest(async () => { reads++; return balance; });
  const A = await admit(W(0xe1));
  const arrivedAt = Date.now(); // B arrives (and is verified) while A is in flight
  await sleep(10);
  A.release.settling(); A.release.settled(); balance = 0n; // A's payment leaves the wallet
  await sleep(10);
  const B = await admit(W(0xe1), { arrivedAt });
  ok(B.err?.statusCode === 429 && inflightCoverStatus().judgedAfterSettlement === 1, `a call that arrived before the wallet's last settlement is judged on a read, not on verify's proof (${B.err?.statusCode || "admitted"})`);
  const C = await admit(W(0xe1), { arrivedAt: Date.now() });
  ok(typeof C.release === "function", "a call that arrives after that settlement is admitted on verify's proof, as before");
  C.release();
}

// ---- the per-wallet store is bounded ----
{
  fresh();
  _setBalanceReaderForTest(async () => PRICE * 10n);
  const base = 0x1000000;
  for (let i = 0; i < 50_300; i++) { const who = "0x" + (base + i).toString(16).padStart(40, "0"); const x = await admit(who); x.release(); }
  ok(inflightCoverStatus().walletsKept <= 50_000 && inflightCoverStatus().walletsKept > 49_000, `50,300 wallets seen: at most 50,000 are kept (${inflightCoverStatus().walletsKept})`);
  _ageKeptReadsForTest(16 * 60_000);
  for (let i = 0; i < 7000; i++) { const x = await admit(W(0xf1)); x.release(); }
  ok(inflightCoverStatus().walletsKept < 1000, `wallets not touched for fifteen minutes are dropped as others are served (${inflightCoverStatus().walletsKept} kept)`);
}

// ---- the status verdict is sustained only for buyers at large, never for one wallet ----
{
  fresh();
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  const unreadOnce = async (who, hopts) => { const a = await admit(who, {}, hopts); const b = await admit(who, {}, hopts); a.release?.(); b.release?.(); };
  // One wallet, in four separate minutes.
  for (let i = 0; i < 4; i++) { await unreadOnce(W(0x71)); _ageUnreadDecisionsForTest(60_000); }
  await unreadOnce(W(0x71));
  let v = coverageReadsVerdict();
  ok(v.status === "degraded" && v.sustained === false, `one wallet decided without a read in five separate minutes: degraded, never sustained (${JSON.stringify(v)})`);
  // Three wallets inside one minute.
  fresh();
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  for (const n of [0x72, 0x73, 0x74]) await unreadOnce(W(n));
  v = coverageReadsVerdict();
  ok(v.status === "degraded" && v.sustained === false, `three wallets inside one minute: not sustained (${JSON.stringify(v)})`);
  // Three wallets across three separate minutes.
  _ageUnreadDecisionsForTest(60_000); await unreadOnce(W(0x72));
  _ageUnreadDecisionsForTest(60_000); await unreadOnce(W(0x73));
  v = coverageReadsVerdict();
  ok(v.status === "degraded" && v.sustained === true, `three wallets across three separate minutes: sustained (${JSON.stringify(v)})`);
  _ageUnreadDecisionsForTest(11 * 60_000);
  v = coverageReadsVerdict();
  ok(v.status === "ok" && v.sustained === false, `eleven minutes later: ok (${JSON.stringify(v)})`);
}

// ---- reads that hang on one network take no place from a wallet on another ----
{
  fresh();
  _setBalanceReaderForTest(async ({ network }) => { if (network === "eip155:137") await sleep(4000); return PRICE * 1000n; });
  const hung = []; for (let i = 0; i < 12; i++) { hung.push(await admit(W(0x50 + i), {}, { network: "eip155:137" })); }
  const hanging = hung.map((_, i) => admit(W(0x50 + i), {}, { network: "eip155:137" })); // twelve reads asked for on one network; they hang
  await sleep(50);
  const t0 = Date.now();
  const base = await Promise.all(Array.from({ length: 8 }, () => admit(W(0x6f))));
  ok(base.every((x) => x.release && (coveredRunStateOf(x.req) === "covered")) && Date.now() - t0 < 300, `with twelve reads hanging on another network, a funded new wallet's eight calls at once are all covered by its own read at once (${base.filter((x) => x.release).length} admitted, ${Date.now() - t0} ms)`);
  for (const x of [...base, ...hung, ...(await Promise.all(hanging))]) x.release?.();
}

// ---- the read taken after a settlement: queued when the lane is busy, held back while reads fail ----
{
  fresh();
  let reads = 0, fail = false;
  _setBalanceReaderForTest(async () => { reads++; if (fail) throw new Error("rpc down"); await sleep(300); return PRICE * 1000n; });
  // Eight wallets hold the network's lane with slow reads.
  const holders = []; for (let i = 0; i < 8; i++) holders.push(await admit(W(0x40 + i)));
  const second = holders.map((_, i) => admit(W(0x40 + i)));
  await sleep(30);
  const x = await admit(W(0x4f)); x.release.settling(); x.release.settled(); // its background read finds the lane full
  await sleep(5);
  ok(inflightCoverStatus().backgroundReads === 1 && inflightCoverStatus().backgroundReadsSkipped === 0 && inflightCoverStatus().readsQueued >= 1, `a settlement's read that finds the lane full is queued, not skipped (${inflightCoverStatus().readsQueued} queued)`);
  for (const y of [...holders, ...(await Promise.all(second))]) y.release?.();
  await sleep(700);
  fail = true; _ageKeptReadsForTest(60_000);
  const kept = await Promise.all(Array.from({ length: 40 }, () => admit(W(0x4f))));
  ok(kept.every((y) => y.release), `that queued read became the wallet's last good read: with reads then failing, 40 at once are all admitted (${kept.filter((y) => y.release).length})`);
  for (const y of kept) y.release();
  // While reads on the network fail, wallets that settle ask for no read each.
  const r0 = reads;
  for (let i = 0; i < 300; i++) { const who = "0x" + (0x2000000 + i).toString(16).padStart(40, "0"); const y = await admit(who); y.release.settling(); y.release.settled(); }
  ok(reads - r0 <= 3 && inflightCoverStatus().backgroundReadsSkipped >= 295, `300 wallets settling while reads fail asked for ${reads - r0} reads in all (${inflightCoverStatus().backgroundReadsSkipped} held back)`);
}

// ---- while an account's reads are down, an admission waits for a read only a moment ----
{
  fresh();
  let n = 0;
  _setBalanceReaderForTest(async () => { if (++n === 1) throw new Error("rpc down"); await sleep(800); return PRICE * 1000n; });
  const a = await admit(W(0x7a)); const b = await admit(W(0x7a)); // the read fails: the account is marked down
  await sleep(1100); // past the one-read-a-second gap: the next admission asks for a read, which is slow
  const t0 = Date.now();
  const c = await admit(W(0x7a));
  ok(c.release && coveredRunStateOf(c.req) === "unread" && Date.now() - t0 < 200 && n === 2, `an admission for an account whose reads are down waits about 25 ms for the read it asks for, not the whole second (${Date.now() - t0} ms)`);
  for (const y of [a, b, c]) y.release?.();
}

// ---- only a read begun inside a judgment is its own: a cached one that does not cover falls to the allowance ----
{
  fresh();
  let up = true, balance = PRICE;
  _setBalanceReaderForTest(async () => { if (!up) throw new Error("rpc down"); return balance; });
  const a = await admit(W(0x9a)); const b = await admit(W(0x9a)); // b is refused on a read of one price, which is cached
  a.req.res = { statusCode: 502 }; a.release(); // nothing was taken
  _ageKeptReadsForTest(5_000); // five seconds on: the wallet has been funded, and reads now fail
  up = false;
  const four = await Promise.all(Array.from({ length: 4 }, () => admit(W(0x9a))));
  ok(b.err?.coverRefusal === "short" && four.every((x) => x.release) && inflightCoverStatus().admittedPastKeptRead === 3, `a wallet read at one price five seconds ago, reads now failing: four calls at once are admitted on the allowance, not refused on the cached read (${four.filter((x) => x.release).length} of 4)`);
  for (const x of four) x.release?.();
  // With the balance readable, the cached read is replaced by a fresh one and one price still runs one call.
  fresh(); up = true; balance = PRICE;
  _setBalanceReaderForTest(async () => { if (!up) throw new Error("rpc down"); return balance; });
  const c = await admit(W(0x9b)); const d = await admit(W(0x9b));
  _ageKeptReadsForTest(5_000);
  const more = await Promise.all(Array.from({ length: 40 }, () => admit(W(0x9b))));
  ok(d.err && more.every((x) => x.err?.statusCode === 429 && x.err.coverRefusal === "short"), `with the balance readable, a one-price wallet's 40 more calls beside its one run are all refused on a fresh read (${more.filter((x) => x.release).length} admitted)`);
  c.release();
}

// ---- reads an admission waits for go before the reads taken after settlements ----
{
  fresh();
  _setBalanceReaderForTest(async ({ payer }) => { await sleep(300); return payer === W(0x9c) ? PRICE : PRICE * 1000n; });
  for (let i = 0; i < 60; i++) { const who = "0x" + (0x3000000 + i).toString(16).padStart(40, "0"); const y = await admit(who); y.release.settling(); y.release.settled(); }
  await sleep(5);
  const st = inflightCoverStatus();
  ok(st.backgroundReads === 36 && st.backgroundReadsSkipped === 24 && st.readsQueued === 32, `60 wallets settle while reads take 300 ms: four background reads run, 32 wait, and 24 past that cap are not asked for (${st.backgroundReads} asked, ${st.readsQueued} waiting, ${st.backgroundReadsSkipped} held back)`);
  const first = await admit(W(0x9c));
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 40 }, () => admit(W(0x9c))));
  ok(first.release && burst.every((x) => x.err?.coverRefusal === "short") && Date.now() - t0 < 700, `beside them, a one-price wallet's 40 calls are judged on its own read, which takes a place before the 32 that wait: one run (${burst.filter((x) => x.release).length} more admitted, ${Date.now() - t0} ms)`);
  first.release();
  await sleep(3000);
}

// ---- one ledger key per balance: a payment that names no asset draws on the chain's token ----
{
  fresh();
  _setBalanceReaderForTest(async () => PRICE);
  const withAsset = await admit(W(0x9d));
  const h = JSON.parse(Buffer.from(hdr(W(0x9d)), "base64").toString());
  delete h.accepted.asset;
  const req = reqFor(b64(h));
  const noAsset = await admitCoveredRun(req).then((release) => ({ release }), (err) => ({ err }));
  ok(withAsset.release && noAsset.err?.statusCode === 429 && inflightCoverStatus().walletsInFlight === 1, `a second payment from the wallet that names no asset is judged in the same ledger and refused (${noAsset.err?.statusCode || "admitted"})`);
  withAsset.release();
}

// ---- the settle hook hands the coverage ledger the amount the settlement reports ----
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(/const took = typeof result\?\.amount === "string" && \/\^\\d\{1,78\}\$\/\.test\(result\.amount\) \? result\.amount : null;\s*\n\s*try \{ return markCoveredRunSettled\(ctx\?\.transportContext\?\.request\?\.adapter\?\.req, took\); \}/.test(src), "releaseCoverOnSettled passes the settle result's amount to markCoveredRunSettled");
}

// ---- Circle Gateway batched: judged on the Gateway balance ----
{
  fresh();
  const batched = { extra: { name: "GatewayWalletBatched" } };
  const t = await coverTermsOfRequest(reqFor(hdr(W(0x61), batched)));
  ok(t?.rail === "gateway" && t.payer === W(0x61) && t.atomic === PRICE && t.network === "eip155:8453", `a batched payment has terms of its own: the signer, the amount, the network's domain (${JSON.stringify(t, (k, v) => (typeof v === "bigint" ? String(v) : v))})`);
  const plain = await coverTermsOfRequest(reqFor(hdr(W(0x61))));
  ok(plain?.rail === "evm", "the same authorization without the batched kind is an EVM payment");
  const asked = [];
  _setGatewayBalanceClientForTest({ balances: async (q) => { asked.push(q); return { usd: 1.2, byDomain: { 6: 1.2 } }; } });
  ok((await readRailBalance(t)) === 1_200_000n && asked[0].depositor === W(0x61) && asked[0].domains[0] === 6, "its balance is the signer's Gateway balance on that domain, in base units");
  _setGatewayBalanceClientForTest({ balances: async () => { throw new Error("gateway down"); } });
  ok((await readRailBalance(t)) === null, "a Gateway read that fails is unknown, never zero");
  ok((await readRailBalance({ ...t, network: "eip155:137" })) === null, "a network with no Gateway domain is unknown");
  // Through the admission: a wallet balance of zero does not refuse it, the Gateway balance decides.
  let gw = 2;
  _setGatewayBalanceClientForTest({ balances: async () => ({ usd: gw * 0.6, byDomain: { 6: gw * 0.6 } }) });
  _setPaidRecordForTest(() => true);
  const g1 = await admit(W(0x62), {}, batched), g2 = await admit(W(0x62), {}, batched), g3 = await admit(W(0x62), {}, batched);
  ok(g1.release && g2.release && g3.err?.statusCode === 429, "two batched runs fit a Gateway balance of two prices; a third is refused");
  const e1 = await admit(W(0x62)); // an on-chain payment from the same signer: another balance
  ok(e1.release, "the same signer's on-chain payment is judged on its own ledger");
  for (const x of [g1, g2, e1]) x.release();
  _setGatewayBalanceClientForTest(null);
}

// ---- the EVM chain table comes from the rails table ----
{
  const { EVM } = await import("../src/revenue-live.js");
  const evmRails = [...RAILS, ...GATED_RAILS].filter((r) => Number.isInteger(r.chainId));
  ok(evmRails.length >= 8 && evmRails.every((r) => typeof CHAIN_BY_CAIP2[r.caip2] === "string"), `every EVM rail in the rails table has a chain key (${evmRails.length})`);
  const missing = evmRails.filter((r) => !EVM[CHAIN_BY_CAIP2[r.caip2]]?.token).map((r) => r.name);
  ok(missing.length === 0, `each key names a chain the balance read has a token and RPCs for (missing: ${missing.join(", ") || "none"})`);
  ok(Object.keys(CHAIN_BY_CAIP2).length === evmRails.length && CHAIN_BY_CAIP2["eip155:8453"] === "base" && !Object.keys(CHAIN_BY_CAIP2).some((k) => !k.startsWith("eip155:")), "nothing else is in it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
