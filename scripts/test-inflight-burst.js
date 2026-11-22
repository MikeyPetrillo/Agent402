#!/usr/bin/env node
// A wallet's paid calls in flight are covered by its balance TOGETHER, on
// every wire that settles after the handler (src/inflight-cover.js), and the
// settle breaker's bound on unpaid runs holds for calls that arrive at once
// (src/gateway-settle-breaker.js).
//
// One PAID-mode server (scripts/lib/paid-wires-rig.js) whose stubs behave like
// a chain: a payer has a balance, a settle takes the price out of it or
// refuses for funds, and the rail's balance read answers that balance or
// fails. Handler runs are observed as settle attempts (a gate only settles a
// handler that answered under 400) and, on a model route, as upstream calls.
//
// On x402 Base, the MPP evm wire, a Tempo pull credential, Solana, Algorand
// and Stellar:
//   - a wallet holding ONE call's price that sends many distinct payments at
//     once runs one handler; the rest are refused 429 before the handler,
//     uncharged, with the reason;
//   - a wallet that has never settled, whose balance cannot be read and whose
//     payments do not settle, runs at most the unread allowance at once;
//   - a wallet that HAS paid is never refused because its balance cannot be
//     read: twelve at once are all served;
//   - a new wallet holding N calls' price that sends N at once is served all
//     N, at once: no call waits for another's settlement;
//   - two wallets do not affect each other.
// Then: the same on a model route (the upstream is called once); the
// same admission on the paid routes mounted outside the kit dispatcher (the
// memory family and the bespoke content routes); the admission's latency for
// a funded wallet with a slow read and with a read that never answers;
// nothing stays in flight however a run ends; and the settleFailures word
// reads burst once one wallet's runs were served past its count. Two more
// boots show the lever: INFLIGHT_COVER=composite judges the report and media
// routes only, with the limits the check had before, and INFLIGHT_COVER=off
// judges nothing: every call runs, nothing is counted in flight.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires, WIRES, tallyOf, sleep } from "./lib/paid-wires-rig.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const SQL = { method: "POST", path: "/api/sql-guard", body: { sql: "select 1" } };
const CHAT = { method: "POST", path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "hi" }] } };
const IMAGE = { method: "POST", path: "/v1/images/fast", body: { prompt: "a red fox in the snow" } };
const UNREAD_PAID_MAX = 16;
const HARD_MAX = 10, UNREAD_MAX = 4, N_BURST = 30, N_HONEST = 20;
const BREAKER_ENV = { GATEWAY_SETTLE_BREAKER_HARD_MAX: String(HARD_MAX), GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000" };
const idle = async () => {
  let s = null;
  for (let i = 0; i < 100; i++) {
    s = await rig.operator("/api/gateway-status");
    if (s?.inflightCover?.runsInFlight === 0 && s?.inflightCover?.walletsInFlight === 0 && s?.settleFailures?.runsInFlightCounted === 0) return s;
    await sleep(200);
  }
  return s;
};

rig = await bootPaidWires({ label: "inflight-burst", env: BREAKER_ENV });
try {
  await ok(N_HONEST > HARD_MAX, `the honest burst (${N_HONEST}) is larger than the breaker's hard count (${HARD_MAX})`);
  for (const wire of WIRES) {
    // One call's balance, readable: one handler runs.
    const poor = await rig.wallet(wire);
    const price = await rig.priceOf(poor, SQL);
    rig.fund(poor, price);
    let rs = await rig.burst(poor, SQL, N_BURST);
    let t = tallyOf(rs), o = rig.outcomesOf(poor);
    await ok(o.attempts === 1 && o.settled === 1 && o.refused === 0, `${wire}: ${N_BURST} payments at once from a wallet holding one call's price ran ONE handler, and it settled (${JSON.stringify(o)})`);
    await ok(t[200] === 1 && t[429] === N_BURST - 1, `${wire}: one 200, the rest refused 429 before the handler (${JSON.stringify(t)})`);
    const refusal = rs.find((r) => r.status === 429);
    await ok(/You have not been charged\./.test(refusal?.json?.error || "") && /balance/.test(refusal.json.error) && refusal.headers.get("retry-after") === "30", `${wire}: the 429 says the balance does not cover the wallet's calls and that nothing was charged, with Retry-After (${String(refusal?.json?.error).slice(0, 90)}...)`);
    // Not an input error: the answer names its class and carries no input schema envelope.
    await ok(refusal?.json?.attribution === "ours" && refusal.json.hint === "cover-short" && refusal.json.reason === "cover_short" && typeof refusal.json.fix === "string" && !("expected" in refusal.json) && !("example" in refusal.json) && !("howToCall" in refusal.json) && !("required" in refusal.json), `${wire}: the coverage 429 body names its class (hint, reason, fix) and carries no expected, example or howToCall (${Object.keys(refusal?.json || {}).join(",")})`);

    // Never settled, balance unreadable, payments that do not settle: the
    // unread allowance at once, and the wallet's own count stops the rest.
    const dark = await rig.wallet(wire);
    rig.fund(dark, 0n, { readable: false });
    rs = await rig.burst(dark, SQL, N_BURST);
    t = tallyOf(rs); o = rig.outcomesOf(dark);
    // (A place freed by a failed run can be taken once more before the
    // wallet's own count of failures refuses it.)
    await ok(rig.peakOf(dark) >= 2 && rig.peakOf(dark) <= UNREAD_MAX && o.attempts <= UNREAD_MAX + 2 && o.settled === 0, `${wire}: a wallet that has never settled, balance unreadable: at most ${UNREAD_MAX} handlers at once (${rig.peakOf(dark)} at once, ${JSON.stringify(o)}; ${JSON.stringify(t)})`);
    await ok(!t[200] && (t[402] || 0) === o.attempts && (t[429] || 0) === N_BURST - o.attempts, `${wire}: every other call was refused 429 before its handler (${JSON.stringify(t)})`);

    // A wallet that has paid is never refused for an unreadable balance.
    const known = await rig.wallet(wire);
    rig.fund(known, price * 1000n, { readable: false });
    const firstPaid = await rig.pay(known, SQL);
    rs = await rig.burst(known, SQL, 12);
    t = tallyOf(rs); o = rig.outcomesOf(known);
    await ok(firstPaid.status === 200 && t[200] === 12 && o.settled === 13, `${wire}: a wallet that has paid, balance unreadable: 12 at once all served and settled (${JSON.stringify(t)}, ${JSON.stringify(o)})`);
    await ok(rig.peakOf(known) === 12, `${wire}: ... all twelve ran together, none held back (${rig.peakOf(known)} at once)`);

    // Funds for N, N at once: all served.
    const rich = await rig.wallet(wire);
    rig.fund(rich, price * BigInt(N_HONEST));
    rs = await rig.burst(rich, SQL, N_HONEST);
    t = tallyOf(rs); o = rig.outcomesOf(rich);
    await ok(t[200] === N_HONEST && o.settled === N_HONEST && o.refused === 0, `${wire}: a new wallet holding ${N_HONEST} calls' price is served all ${N_HONEST} at once and pays for each (${JSON.stringify(t)}, ${JSON.stringify(o)})`);

    // Two wallets at once: the short one does not touch the funded one.
    const a = await rig.wallet(wire), b = await rig.wallet(wire);
    rig.fund(a, price); rig.fund(b, price * 10n);
    const [ra, rb] = await Promise.all([rig.burst(a, SQL, 20), rig.burst(b, SQL, 10)]);
    await ok(tallyOf(rb)[200] === 10 && rig.outcomesOf(b).settled === 10, `${wire}: a funded wallet is served all 10 while another wallet's burst is refused (${JSON.stringify(tallyOf(rb))})`);
    await ok(rig.outcomesOf(a).attempts === 1 && tallyOf(ra)[429] === 19, `${wire}: the short wallet beside it still ran one handler (${JSON.stringify(rig.outcomesOf(a))})`);
  }

  // A Tempo pull credential signed by an ACCESS KEY of an account (a keychain
  // signature; the chain read of the key does not answer here) draws on the
  // account's balance, and is judged on it, together with the account's own
  // key: one price held, five at once, one run.
  {
    const N = 5;
    for (const [label, via] of [["an access key", true], ["the account key", false]]) {
      const acct = await rig.wallet("tempo");
      const price = await rig.priceOf(acct, SQL);
      rig.fund(acct, price);
      const w = via ? await rig.wallet("tempo", { accessKeyOf: acct }) : acct;
      const rs = await rig.burst(w, SQL, N);
      const t = tallyOf(rs), o = rig.outcomesOf(acct);
      await ok(o.attempts === 1 && o.settled === 1 && o.refused === 0 && t[200] === 1 && t[429] === N - 1, `tempo through ${label}: ${N} pull calls at once from an account holding one call's price ran ONE handler and it settled; the rest 429 before the handler (${JSON.stringify(t)}, ${JSON.stringify(o)})`);
      const refusal = rs.find((r) => r.status === 429);
      await ok(/You have not been charged\./.test(refusal?.json?.error || "") && refusal?.json?.reason === "cover_short", `tempo through ${label}: the 429 says nothing was charged (${refusal?.json?.reason})`);
      // Funded for N: all N served, none refused.
      const rich = await rig.wallet("tempo");
      rig.fund(rich, price * BigInt(N));
      const rw = via ? await rig.wallet("tempo", { accessKeyOf: rich }) : rich;
      const rr = await rig.burst(rw, SQL, N);
      await ok(tallyOf(rr)[200] === N && rig.outcomesOf(rich).settled === N, `tempo through ${label}: an account holding ${N} calls' price is served all ${N} at once (${JSON.stringify(tallyOf(rr))})`);
    }
    // The account key and an access key at once draw on one balance: one run.
    const acct = await rig.wallet("tempo");
    const price = await rig.priceOf(acct, SQL);
    rig.fund(acct, price);
    const key = await rig.wallet("tempo", { accessKeyOf: acct });
    const creds = [];
    for (let i = 0; i < 6; i++) creds.push(await rig.credentialFor(i % 2 ? key : acct, SQL));
    const rs = await Promise.all(creds.map((c) => rig.send(SQL, c)));
    const o = rig.outcomesOf(acct);
    await ok(o.attempts === 1 && o.settled === 1 && tallyOf(rs)[429] === 5, `tempo: the account key and an access key sending at once are judged on the account's one balance (${JSON.stringify(tallyOf(rs))}, ${JSON.stringify(o)})`);

    // A key that is NOT the account's, naming a funded account: every call is
    // refused before the handler, uncharged, and books nothing against that
    // account, whose own calls at the same moment are all admitted.
    const victim = await rig.wallet("tempo");
    rig.fund(victim, price * 5n);
    const forger = await rig.wallet("tempo", { forgedKeyOf: victim });
    const [forged, own] = await Promise.all([rig.burst(forger, SQL, 10), rig.burst(victim, SQL, 5)]);
    const ov = rig.outcomesOf(victim);
    await ok(forged.every((r) => r.status === 402 && r.json?.details?.reason === "sender-unverified" && r.json?.details?.charged === false), `tempo: 10 pulls signed by a key that is not the named account's are refused 402 before the handler, uncharged (${JSON.stringify(tallyOf(forged))})`);
    await ok(tallyOf(own)[200] === 5 && ov.attempts === 5 && ov.settled === 5, `tempo: the named account's own 5 calls at the same moment are all admitted and settled (${JSON.stringify(tallyOf(own))}, ${JSON.stringify(ov)})`);
    // An access key the chain holds no record of, and a key read that does
    // not answer in time: refused, uncharged.
    const lone = await rig.wallet("tempo"); rig.fund(lone, price * 3n);
    const stray = await rig.wallet("tempo", { accessKeyOf: lone, unregistered: true });
    const rStray = await rig.pay(stray, SQL);
    await ok(rStray.status === 402 && rStray.json?.details?.reason === "sender-unverified" && rig.outcomesOf(lone).attempts === 0, `tempo: an access key the chain holds no record of is refused before the handler (${rStray.status}, ${rStray.json?.details?.reason})`);
    const slowKey = await rig.wallet("tempo", { accessKeyOf: lone });
    rig.st.keyReadDelayMs = 4000;
    const t0 = Date.now();
    const rSlow = await rig.pay(slowKey, SQL);
    const took = Date.now() - t0;
    rig.st.keyReadDelayMs = 0;
    await ok(rSlow.status === 503 && rSlow.json?.details?.reason === "sender-check-unavailable" && rSlow.json?.details?.charged === false && rSlow.headers.get("retry-after") === "3" && rig.outcomesOf(lone).attempts === 0 && took < 3800, `tempo: a key read that does not answer within its timeout answers 503 with Retry-After before the handler, uncharged (${rSlow.status}, ${took} ms)`);
    // ...and the same key, sent again once the read answers, is admitted.
    const again = await rig.pay(slowKey, SQL);
    await ok(again.status === 200 && rig.outcomesOf(lone).settled === 1, `tempo: the same access key sent again with the chain answering is admitted and settles (${again.status})`);

    // Sixteen key reads for forged keys in flight fill every read slot. A
    // genuine key arriving next waits for a slot, and is admitted once one
    // frees within the read budget (the case where none frees in time, a 503
    // with Retry-After, is in scripts/test-tempo-sender.js: here every read is
    // itself bounded by the same budget, so a slot always frees inside it).
    for (const [label, forgedMs, want] of [["a slot frees within the budget", 900, 200]]) {
      const target = await rig.wallet("tempo"); rig.fund(target, price * 20n);
      const buyer = await rig.wallet("tempo"); rig.fund(buyer, price * 3n);
      const genuine = await rig.wallet("tempo", { accessKeyOf: buyer });
      const genuinePair = `${buyer.address.toLowerCase()}:${genuine.account.accessKeyAddress.toLowerCase()}`;
      rig.st.keyReadDelayFor = (pair) => (pair === genuinePair ? 0 : forgedMs);
      const forgers = []; for (let i = 0; i < 16; i++) forgers.push(await rig.wallet("tempo", { forgedKeyOf: target }));
      const fcreds = []; for (const f of forgers) fcreds.push(await rig.credentialFor(f, SQL));
      const gcred = await rig.credentialFor(genuine, SQL);
      const r0 = rig.st.keyReads;
      const fp = Promise.all(fcreds.map((c) => rig.send(SQL, c)));
      for (let i = 0; i < 100 && rig.st.keyReads - r0 < 16; i++) await sleep(10);
      const t1 = Date.now();
      const g = await rig.send(SQL, gcred);
      const gt = Date.now() - t1;
      await fp;
      rig.st.keyReadDelayFor = null;
      if (want === 200) await ok(g.status === 200 && rig.outcomesOf(buyer).settled === 1 && gt >= 500, `tempo: 16 forged key reads in flight, ${label}: the genuine key waits for a slot and is admitted (${g.status}, ${gt} ms)`);
      else await ok(g.status === 503 && g.json?.details?.reason === "sender-check-unavailable" && g.headers.get("retry-after") === "3" && rig.outcomesOf(buyer).attempts === 0, `tempo: 16 forged key reads in flight, ${label}: the genuine key answers 503 with Retry-After, uncharged, never 402 (${g.status}, ${g.json?.details?.reason}, ${gt} ms)`);
      await sleep(100);
    }
  }

  // A model-backed route: the upstream is called once per run that can be paid for.
  for (const wire of ["evm", "tempo", "svm"]) {
    const w = await rig.wallet(wire);
    rig.fund(w, await rig.priceOf(w, CHAT));
    const c0 = rig.st.completions;
    const rs = await rig.burst(w, CHAT, 20);
    await ok(rig.st.completions - c0 === 1 && rig.outcomesOf(w).attempts === 1 && tallyOf(rs)[200] === 1, `${wire}: 20 chat calls at once from a wallet holding one call's price reached the model upstream once (${rig.st.completions - c0}; ${JSON.stringify(tallyOf(rs))})`);
  }

  // Settlement success releases the run and is the wallet's paid record, on
  // every gate that reports it (the x402 hook and the Tempo gate).
  for (const wire of ["evm", "tempo", "svm"]) {
    const before = (await rig.operator("/api/gateway-status")).inflightCover.settledReleases;
    const w = await rig.wallet(wire); const price = await rig.priceOf(w, SQL);
    rig.fund(w, price * 3n);
    const r = await rig.pay(w, SQL);
    const after = (await rig.operator("/api/gateway-status")).inflightCover.settledReleases;
    await ok(r.status === 200 && after === before + 1, `${wire}: a settled call leaves the ledger on its settlement (settled releases +${after - before})`);
  }

  // The paid routes mounted outside the kit dispatcher take the same
  // admission. One wallet holds exactly a chat call's price and has that call
  // in flight; a payment from it to any other paid route cannot be covered
  // too, and is refused before that route's handler.
  {
    const OUTSIDE = [
      { method: "POST", path: "/api/memory", body: { key: "k", value: "v" } },
      { method: "GET", path: "/api/memory?key=k" },
      { method: "POST", path: "/api/memory/remember", body: { text: "a note" } },
      { method: "POST", path: "/api/memory/recall", body: { query: "note" } },
      { method: "POST", path: "/api/extract", body: { url: "http://127.0.0.1:9/a" } },
      { method: "POST", path: "/api/render", body: { url: "http://127.0.0.1:9/a" } },
      { method: "POST", path: "/api/pdf", body: { url: "http://127.0.0.1:9/a.pdf" } },
      { method: "GET", path: "/api/meta?url=http%3A%2F%2F127.0.0.1%3A9%2Fa" },
      { method: "GET", path: "/api/dns?name=localhost" },
      { method: "GET", path: "/api/screenshot?url=http%3A%2F%2F127.0.0.1%3A9%2Fa" },
    ];
    const w = await rig.wallet("evm");
    // The wallet has a paid sale on the books, so its chat call is settled
    // after its handler and its balance is held while the call runs (a wallet
    // with none has that payment settled before the model call:
    // scripts/test-settle-first.js). It bought that one call with exactly its
    // price, so no balance read made for it shows more than the wallet holds.
    rig.fund(w, await rig.priceOf(w, SQL));
    await ok((await rig.pay(w, SQL)).status === 200, "the holding wallet has one settled call on the books");
    await sleep(300);
    rig.fund(w, await rig.priceOf(w, CHAT));
    const creds = [];
    for (const route of OUTSIDE) creds.push(await rig.credentialFor(w, route));
    rig.st.llmDelayMs = 2500;
    const held = rig.pay(w, CHAT);
    await sleep(500);
    const rs = await Promise.all(OUTSIDE.map((route, i) => rig.send(route, creds[i])));
    rig.st.llmDelayMs = 0;
    for (let i = 0; i < OUTSIDE.length; i++) {
      // (Retry-After 30 on a read made for the call; on the record of an
      // earlier call's read, inside the read gap, the time left in the gap.)
      const ra = Number(rs[i].headers.get("retry-after"));
      await ok(rs[i].status === 429 && /does not cover this one as well/.test(rs[i].json?.error || "") && /You have not been charged\./.test(rs[i].json.error) && (ra === 30 || (ra >= 1 && ra <= 10)), `${OUTSIDE[i].method} ${OUTSIDE[i].path.split("?")[0]}: refused 429 before its handler while the wallet's balance is held by a call in flight (${rs[i].status})`);
    }
    await ok((await held).status === 200, "the call in flight is served and settled");
    // Control and burst on the memory family (it answers offline).
    const MEM = OUTSIDE[0];
    const rich = await rig.wallet("evm"); const mp = await rig.priceOf(rich, MEM);
    rig.fund(rich, mp * 5n);
    const five = await rig.burst(rich, MEM, 5);
    await ok(tallyOf(five)[200] === 5 && rig.outcomesOf(rich).settled === 5, `POST /api/memory: a funded wallet's 5 writes at once are served and settled (${JSON.stringify(tallyOf(five))})`);
    for (const route of [MEM, OUTSIDE[2]]) {
      const poor = await rig.wallet("evm");
      rig.fund(poor, await rig.priceOf(poor, route));
      const burst = await rig.burst(poor, route, 30);
      const o = rig.outcomesOf(poor);
      await ok(o.attempts === 1 && o.settled === 1 && tallyOf(burst)[429] === 29, `${route.method} ${route.path}: 30 payments at once from a wallet holding one call's price ran ONE handler (${JSON.stringify(o)}; ${JSON.stringify(tallyOf(burst))})`);
    }
  }

  // The admission's cost to a funded wallet that has paid: eight calls at a
  // time, 48 calls, against a slow balance read and one that never answers.
  {
    const run = async (readDelayMs) => {
      const w = await rig.wallet("evm"); const price = await rig.priceOf(w, SQL);
      rig.fund(w, price * 100000n);
      await rig.pay(w, SQL); // its paid record
      const creds = []; for (let i = 0; i < 48; i++) creds.push(await rig.credentialFor(w, SQL));
      rig.st.readDelayMs = readDelayMs;
      const r0 = rig.st.reads; let idx = 0; const st = {}; const lat = [];
      const t0 = Date.now();
      await Promise.all(Array.from({ length: 8 }, async () => { while (idx < creds.length) { const c = creds[idx++]; const t = Date.now(); const r = await rig.send(SQL, c); lat.push(Date.now() - t); st[r.status] = (st[r.status] || 0) + 1; } }));
      const total = Date.now() - t0;
      rig.st.readDelayMs = 0;
      await sleep(300);
      return { total, st, reads: rig.st.reads - r0, max: Math.max(...lat) };
    };
    const ideal = 6 * (rig.st.settleDelayMs + 35);
    const slow = await run(400);
    await ok(slow.st[200] === 48 && slow.total < ideal + 1500 && slow.reads <= 4, `a 400 ms balance read: 48 calls all served in ${slow.total} ms (ideal ${ideal}), ${slow.reads} reads, slowest call ${slow.max} ms`);
    const dead = await run(30_000);
    await ok(dead.st[200] === 48 && dead.total < ideal + 2500 && dead.max < 2000, `a balance read that never answers: 48 calls all served in ${dead.total} ms, slowest call ${dead.max} ms (${JSON.stringify(dead.st)})`);
    // One after another: no read at all.
    const w = await rig.wallet("evm"); rig.fund(w, (await rig.priceOf(w, SQL)) * 100n);
    const r0 = rig.st.reads;
    for (let i = 0; i < 6; i++) await rig.pay(w, SQL);
    await sleep(200);
    // (None when a read on the network failed in the last ten seconds, as one just did above: background reads are held back then.)
    await ok(rig.st.reads - r0 <= 1, `six calls one after another cost at most one balance read in all, taken in the background after a settlement (${rig.st.reads - r0})`);
  }

  // Nothing stays in flight, however a run ends.
  {
    const chatPrice = async (w) => rig.priceOf(w, CHAT);
    // handler errors (a model the tier does not serve: thrown after admission)
    const e1 = await rig.wallet("evm"); rig.fund(e1, (await chatPrice(e1)) * 10n);
    const bad = { ...CHAT, body: { model: "not-a-model", messages: CHAT.body.messages } };
    const errs = await Promise.all([1, 2, 3].map(() => rig.pay(e1, bad)));
    await ok(errs.every((r) => r.status === 400) && rig.outcomesOf(e1).attempts === 0, `three paid calls the handler refused answered 400 and were not settled (${errs.map((r) => r.status)})`);
    // upstream errors
    rig.st.llmStatus = 500;
    const e2 = await rig.wallet("tempo"); rig.fund(e2, (await chatPrice(e2)) * 10n);
    const ups = await Promise.all([1, 2, 3].map(() => rig.pay(e2, CHAT)));
    rig.st.llmStatus = 0;
    await ok(ups.every((r) => r.status >= 500) && rig.outcomesOf(e2).attempts === 0, `three paid calls whose upstream failed answered 5xx and were not settled (${ups.map((r) => r.status)})`);
    // hang-ups: the buyer leaves while the model is still answering
    rig.st.llmDelayMs = 1500;
    for (const wire of ["evm", "tempo", "svm"]) {
      const h = await rig.wallet(wire); rig.fund(h, (await chatPrice(h)) * 10n);
      const ctls = [1, 2, 3].map(() => new AbortController());
      const creds = []; for (let i = 0; i < 3; i++) creds.push(await rig.credentialFor(h, CHAT));
      const gone = creds.map((c, i) => rig.send(CHAT, c, { signal: ctls[i].signal }).then(() => "answered", () => "gone"));
      await sleep(400);
      for (const c of ctls) c.abort();
      await ok((await Promise.all(gone)).every((x) => x === "gone"), `${wire}: three buyers left mid-run`);
    }
    // a payment window that ends before the model answers (a timeout)
    {
      const w = await rig.wallet("mpp-evm"); rig.fund(w, (await chatPrice(w)) * 10n);
      const o = await rig.offerOf(CHAT);
      const ch = o.challenges.find((c) => c.method === "evm");
      const { Credential } = await import("mppx");
      const cred = (secs) => ({ Authorization: Credential.serialize({ challenge: ch, payload: { from: w.address, to: ch.request.recipient, value: ch.request.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + secs), nonce: "0x" + "ab".repeat(31) + String(10 + secs), signature: "0x" + "11".repeat(65), type: "authorization" } }) });
      rig.st.llmDelayMs = 12000;
      const c0 = rig.st.completions, t0 = Date.now();
      const r = await rig.send(CHAT, cred(16));
      const took = Date.now() - t0;
      rig.st.llmDelayMs = 0;
      await ok(r.status === 504 && rig.st.completions === c0 + 1 && took > 1000 && took < 12000, `a call whose payment window ends while the model is still answering is cut off with ${r.status} (${took} ms, upstream calls +${rig.st.completions - c0})`);
    }
    rig.st.llmDelayMs = 0;
    // settle failures: covered when admitted, short when settled
    const s1 = await rig.wallet("avm"); const p = await rig.priceOf(s1, SQL);
    rig.fund(s1, p, { shown: p * 100n });
    await rig.burst(s1, SQL, 3);
    await ok(rig.outcomesOf(s1).refused === 2, `settle failures: two of three covered runs were refused at settlement (${JSON.stringify(rig.outcomesOf(s1))})`);
    const s = await idle();
    await ok(s?.inflightCover?.runsInFlight === 0 && s?.inflightCover?.walletsInFlight === 0, `the coverage ledger holds nothing in flight after successes, settle failures, handler and upstream errors, an ended payment window and hang-ups (${JSON.stringify({ runs: s?.inflightCover?.runsInFlight, wallets: s?.inflightCover?.walletsInFlight })})`);
    await ok(s?.settleFailures?.runsInFlightCounted === 0, `the breaker counts no run in flight either (${s?.settleFailures?.runsInFlightCounted})`);
    await ok(s?.inflightCover?.admitted > 0 && s?.inflightCover?.refused > 0, "the ledger admitted and refused runs in this boot (control)");
    // a wallet that was refused and is now funded is served at once
    const again = await rig.wallet("stellar"); const sp = await rig.priceOf(again, SQL);
    rig.fund(again, sp);
    await rig.burst(again, SQL, 10);
    rig.fund(again, sp * 5n);
    await sleep(10_100); // a balance record younger than the read gap (10 s) is judged as it is
    const back = await rig.burst(again, SQL, 5);
    await ok(tallyOf(back)[200] === 5, `a wallet refused for coverage is served all 5 calls once it holds their price (${JSON.stringify(tallyOf(back))})`);
  }

  // The status word: ok so far; burst once one wallet's runs were served and
  // refused at settlement past its count.
  {
    const before = await rig.operator("/api/gateway-status");
    await ok(before.settleFailures.status === "ok" && before.settleFailures.overrunTrips === 0, `settleFailures reads ok before any wallet's runs passed its count (${before.settleFailures.status}, trips ${before.settleFailures.overrunTrips})`);
    let trips = 0;
    for (const wire of ["evm", "svm"]) {
      const w = await rig.wallet(wire); const price = await rig.priceOf(w, SQL);
      rig.fund(w, price, { shown: price * 100n }); // reads as funded, pays for one
      const rs = await rig.burst(w, SQL, 12);
      const o = rig.outcomesOf(w);
      await ok(o.attempts === 12 && o.refused === 11, `${wire}: 12 runs covered when admitted, 11 refused for funds at settlement (${JSON.stringify(o)}; ${JSON.stringify(tallyOf(rs))})`);
      let g = null;
      for (let i = 0; i < 25; i++) { g = await rig.operator("/api/gateway-status"); if (g.settleFailures.overrunTrips > trips) break; await sleep(200); }
      trips++;
      await ok(g.settleFailures.status === "burst" && g.settleFailures.overrunTrips === trips, `${wire}: settleFailures reads burst (${g.settleFailures.status}, trips ${g.settleFailures.overrunTrips})`);
      await ok((await rig.gatewayStatus()).settleFailures.status === "burst", `${wire}: the public word reads burst`);
      const next = await rig.pay(w, SQL);
      await ok(next.status === 429 && /failed to settle/.test(next.json?.error || ""), `${wire}: that wallet's next call is refused by its own count (${next.status})`);
    }
    const other = await rig.wallet("evm");
    await ok((await rig.pay(other, SQL)).status === 200, "another wallet is served while the word reads burst");
  }
  // A balance that is read decides alone. A funded wallet's calls at once are
  // all started at once, whether or not it has ever settled here: nothing is
  // held back for a settlement. (The time each burst takes shows it: one run's
  // length, not several in a row.)
  for (const [wire, paidFirst, n] of [["evm", false, 12], ["evm", false, 40], ["evm", true, 24], ["evm", true, 90], ["tempo", false, 12], ["svm", false, 12], ["stellar", false, 12], ["tempo", true, 24], ["svm", true, 24], ["stellar", true, 24]]) {
    const w = await rig.wallet(wire); const price = await rig.priceOf(w, CHAT);
    rig.fund(w, price * 1000n);
    if (paidFirst) await rig.pay(w, SQL);
    const creds = []; for (let i = 0; i < n; i++) creds.push(await rig.credentialFor(w, CHAT));
    rig.st.llmDelayMs = 3000;
    const c0 = rig.st.completions, t0 = Date.now();
    const rs = await Promise.all(creds.map((c) => rig.send(CHAT, c)));
    const ms = Date.now() - t0;
    rig.st.llmDelayMs = 0;
    await ok(tallyOf(rs)[200] === n && rig.st.completions - c0 === n && rig.outcomesOf(w).settled === n + (paidFirst ? 1 : 0) && ms < 3000 + 4500, `${wire}: a funded wallet ${paidFirst ? "with a paid call" : "that has never settled"}, ${n} chat calls at once on a 3 s route: all served and paid for, in one run's time (${JSON.stringify(tallyOf(rs))}, ${ms} ms)`);
  }
  {
    const w = await rig.wallet("evm"); const price = await rig.priceOf(w, SQL);
    rig.fund(w, price * 1000n);
    await rig.pay(w, SQL);
    const rs = await rig.burst(w, SQL, 200);
    await ok(tallyOf(rs)[200] === 200 && rig.outcomesOf(w).settled === 201, `a funded wallet with one paid call: 200 at once are all served and settled (${JSON.stringify(tallyOf(rs))})`);
  }
  // An authorization valid for 26 s, a 3 s route, 12 at once: nothing waits, so each is settled well inside its life.
  {
    const w = await rig.wallet("evm"); const price = await rig.priceOf(w, CHAT);
    rig.fund(w, price * 100n);
    const creds = []; for (let i = 0; i < 12; i++) creds.push(await rig.credentialFor(w, CHAT, { validForSeconds: 26 }));
    rig.st.llmDelayMs = 3000;
    const rs = await Promise.all(creds.map((c) => rig.send(CHAT, c)));
    rig.st.llmDelayMs = 0;
    await ok(tallyOf(rs)[200] === 12 && rig.outcomesOf(w).settled === 12, `a funded new wallet, authorizations valid for 26 s, 12 at once on a 3 s route: all served (${JSON.stringify(tallyOf(rs))})`);
  }
  // The report and media routes are judged as they always were: a balance read
  // is given five seconds there, so a read slower than the second every other
  // route gives it still decides.
  {
    const slow = new Set();
    rig.st.readDelayFor = (id) => (slow.has(id) ? 1500 : 0);
    rig.st.llmDelayMs = 1000;
    const one = await rig.wallet("evm"); slow.add(one.id);
    rig.fund(one, await rig.priceOf(one, IMAGE));
    let i0 = rig.st.images;
    let rs = await rig.burst(one, IMAGE, 40);
    await ok(rig.st.images - i0 === 1 && tallyOf(rs)[200] === 1 && tallyOf(rs)[429] === 39 && rs.filter((r) => r.status === 429).every((r) => r.headers.get("retry-after") === "30"), `/v1/images/fast, a one-price wallet whose balance read takes 1.5 s: 40 at once reach the image upstream once, the rest 429 with Retry-After 30 (${rig.st.images - i0}; ${JSON.stringify(tallyOf(rs))})`);
    for (const n of [6, 12, 24]) {
      const w = await rig.wallet("evm"); slow.add(w.id);
      rig.fund(w, (await rig.priceOf(w, IMAGE)) * 1000n);
      i0 = rig.st.images;
      rs = await rig.burst(w, IMAGE, n);
      await ok(rig.st.images - i0 === n && tallyOf(rs)[200] === n, `/v1/images/fast, a funded wallet whose balance read takes 1.5 s: ${n} at once are all served (${JSON.stringify(tallyOf(rs))})`);
    }
    // The same slow read on any other route is left after about a second: the allowance of four, the rest refused at once.
    const c = await rig.wallet("evm"); slow.add(c.id);
    rig.fund(c, (await rig.priceOf(c, CHAT)) * 1000n);
    const creds = []; for (let i = 0; i < 12; i++) creds.push(await rig.credentialFor(c, CHAT));
    const c0 = rig.st.completions, t0 = Date.now(); const at = [];
    rs = await Promise.all(creds.map((cr) => rig.send(CHAT, cr).then((r) => { if (r.status !== 200) at.push(Date.now() - t0); return r; })));
    // (A wallet with no paid sale on the books has each model call's payment
    // settled before the model is called, src/settle-first.js, and a settled
    // run leaves the allowance: so never more than the allowance is unpaid at
    // once, every run that was served is paid, and a place a settlement
    // freed inside the wait may be taken by one more call.)
    const served = tallyOf(rs)[200] || 0;
    await ok(served >= UNREAD_MAX && served <= UNREAD_MAX + 2 && rig.st.completions - c0 === served && rig.outcomesOf(c).settled === served && rig.peakOf(c) <= UNREAD_MAX && tallyOf(rs)[429] === 12 - served && Math.max(...at) < 2500, `/v1/chat/completions, a funded new wallet whose balance read takes 1.5 s: ${served} of 12 run, every one paid and never more than ${UNREAD_MAX} unsettled at once, and the rest are refused 429 after the one-second wait, none held (${JSON.stringify(tallyOf(rs))}; refusals by ${Math.max(...at)} ms)`);
    rig.st.readDelayFor = null;
    rig.st.llmDelayMs = 0;
    await sleep(1200);
  }

  // A call that arrived before the wallet's last settlement is judged on a
  // read, however long its verification took. The wallet holds one price; its
  // second call is verified slowly, so by the time it reaches the admission
  // the first has settled and left and nothing is in flight.
  {
    const w = await rig.wallet("evm"); const price = await rig.priceOf(w, CHAT);
    rig.fund(w, price);
    const cA = await rig.credentialFor(w, CHAT), cB = await rig.credentialFor(w, CHAT);
    rig.st.llmDelayMs = 600;
    const c0 = rig.st.completions;
    const pA = rig.send(CHAT, cA);
    await sleep(150);
    rig.st.verifyDelayMs = 2000;
    const pB = rig.send(CHAT, cB);
    await sleep(200);
    rig.st.verifyDelayMs = 0;
    const [a, b] = await Promise.all([pA, pB]);
    rig.st.llmDelayMs = 0;
    await ok(a.status === 200 && b.status === 429 && rig.st.completions - c0 === 1 && rig.outcomesOf(w).attempts === 1, `a call verified while the wallet's only price was being settled is judged on a read and refused, not run on that verification (${a.status}, ${b.status}; the model was reached ${rig.st.completions - c0} time)`);
  }
  // The balance cannot be read now. A wallet this server has read before is
  // judged on its last good read, less what its calls took or hold since: a
  // funded one is served in full, and one that held a single price is held
  // to the allowance a wallet with no read gets. (A settled call leaves that read behind; the bursts are sent after
  // the ten seconds a read is reused for, so each is judged on the kept one.)
  {
    const WIRES4 = ["evm", "svm", "tempo", "stellar"];
    const funded = [], single = [];
    for (const wire of WIRES4) {
      const f = await rig.wallet(wire); const cp = await rig.priceOf(f, CHAT), sp = await rig.priceOf(f, SQL);
      rig.fund(f, cp * 1000n);
      const one = await rig.wallet(wire);
      rig.fund(one, sp + cp);
      const [a, b] = await Promise.all([rig.pay(f, SQL), rig.pay(one, SQL)]);
      await ok(a.status === 200 && b.status === 200, `${wire}: two wallets each settle a call while their balances can be read`);
      funded.push(f); single.push(one);
    }
    const before = (await rig.operator("/api/gateway-status")).inflightCover;
    await sleep(10_500);
    rig.st.llmDelayMs = 1500;
    for (let i = 0; i < WIRES4.length; i++) {
      const wire = WIRES4[i], f = funded[i], one = single[i];
      rig.fund(f, (await rig.priceOf(f, CHAT)) * 1000n, { readable: false });
      rig.fund(one, await rig.priceOf(one, CHAT), { readable: false });
      let c0 = rig.st.completions;
      let rs = await rig.burst(f, CHAT, 40);
      await ok(tallyOf(rs)[200] === 40 && rig.st.completions - c0 === 40, `${wire}: balance unreadable, a funded wallet read before: 40 chat calls at once are all served (${JSON.stringify(tallyOf(rs))})`);
      c0 = rig.st.completions;
      rs = await rig.burst(one, CHAT, 40);
      const refusal = rs.find((r) => r.status === 429);
      await ok(rig.st.completions - c0 === UNREAD_PAID_MAX && tallyOf(rs)[200] === 1 && tallyOf(rs)[429] === 40 - UNREAD_PAID_MAX && /could not be read just now/.test(refusal?.json?.error || "") && /You have not been charged\./.test(refusal.json.error) && refusal.headers.get("retry-after") === "5", `${wire}: balance unreadable, a wallet whose last good read held one price: never stricter than no read, so the allowance of ${UNREAD_PAID_MAX} runs and the rest are 429 with Retry-After 5, uncharged (${rig.st.completions - c0}; ${JSON.stringify(tallyOf(rs))})`);
    }
    rig.st.llmDelayMs = 0;
    const after = (await rig.operator("/api/gateway-status")).inflightCover;
    // (A funded wallet's kept read, under five minutes old, covers its calls:
    // they are admitted on it at once, with no read asked for.)
    const onKept = (s) => s.admittedOnKeptRead + s.admittedAtOnceOnKeptRead;
    await ok(onKept(after) - onKept(before) >= 4 * 39 && after.admittedAtOnceOnKeptRead - before.admittedAtOnceOnKeptRead >= 4 * 39 && after.admittedPastKeptRead > before.admittedPastKeptRead && after.refusedOnKeptRead > before.refusedOnKeptRead, `those were judged on kept reads (${onKept(after) - onKept(before)} admitted, ${after.admittedAtOnceOnKeptRead - before.admittedAtOnceOnKeptRead} of them at once, ${after.refusedOnKeptRead - before.refusedOnKeptRead} refused)`);
  }
  // An unread balance is a bounded allowance, whoever asks and however the
  // balance came to be unread.
  rig.st.llmDelayMs = 1500;
  for (const wire of ["evm", "stellar", "tempo", "svm"]) {
    // Never settled, ONE price, unreadable: the allowance of four runs, and
    // every other call is refused at once. Nothing waits for a place in it.
    const w = await rig.wallet(wire);
    rig.fund(w, await rig.priceOf(w, CHAT), { readable: false });
    const c0 = rig.st.completions;
    const rs = await rig.burst(w, CHAT, 40);
    const o = rig.outcomesOf(w);
    // Under the settle-first budget every run is served first, as before
    // (src/settle-first-meter.js): all four admitted runs reach the model.
    await ok(rig.st.completions - c0 === UNREAD_MAX && o.settled === 1 && tallyOf(rs)[429] === 40 - UNREAD_MAX, `${wire}: a wallet that has never settled, holding one price, balance unreadable: 40 chat calls at once reached the model ${rig.st.completions - c0} times (the allowance of ${UNREAD_MAX}), one settled, the rest refused before the handler (${JSON.stringify(tallyOf(rs))})`);
  }
  for (const wire of ["evm", "stellar"]) {
    // A paid record, ONE price left, unreadable: the paid allowance, not an open door.
    const w = await rig.wallet(wire); const sp = await rig.priceOf(w, SQL);
    rig.fund(w, sp);
    const first = await rig.pay(w, SQL);
    rig.fund(w, await rig.priceOf(w, CHAT), { readable: false });
    const c0 = rig.st.completions;
    const rs = await rig.burst(w, CHAT, 100);
    await ok(first.status === 200 && rig.st.completions - c0 === UNREAD_PAID_MAX && tallyOf(rs)[429] === 100 - UNREAD_PAID_MAX, `${wire}: a wallet with a paid record, one price left, balance unreadable: 100 chat calls at once reached the model ${rig.st.completions - c0} times (the allowance of ${UNREAD_PAID_MAX}), the rest refused before the handler (${JSON.stringify(tallyOf(rs))})`);
  }
  {
    // A report or media route keeps the allowance it always had, for a wallet with a paid record too.
    const w = await rig.wallet("evm"); const sp = await rig.priceOf(w, SQL);
    rig.fund(w, sp);
    await rig.pay(w, SQL);
    rig.fund(w, await rig.priceOf(w, IMAGE), { readable: false });
    let i0 = rig.st.images;
    let rs = await rig.burst(w, IMAGE, 30);
    await ok(rig.st.images - i0 >= 1 && rig.st.images - i0 <= UNREAD_MAX, `/v1/images/fast, a wallet with a paid record, balance unreadable: 30 at once reached the image upstream ${rig.st.images - i0} times, at most ${UNREAD_MAX} (${JSON.stringify(tallyOf(rs))})`);
    // ... and a readable one-price balance runs one.
    const r = await rig.wallet("evm");
    rig.fund(r, sp); await rig.pay(r, SQL);
    rig.fund(r, await rig.priceOf(r, IMAGE));
    i0 = rig.st.images;
    rs = await rig.burst(r, IMAGE, 30);
    await ok(rig.st.images - i0 === 1 && rig.outcomesOf(r).settled === 2, `/v1/images/fast, a wallet with a paid record holding one price, balance readable: 30 at once reached the image upstream once (${rig.st.images - i0}; ${JSON.stringify(tallyOf(rs))})`);
    // The read lane filled by other wallets' slow reads does not turn that into "unread".
    const t = await rig.wallet("evm");
    rig.fund(t, sp); await rig.pay(t, SQL);
    rig.fund(t, await rig.priceOf(t, IMAGE));
    const helpers = []; for (let i = 0; i < 8; i++) { const h = await rig.wallet("evm"); rig.fund(h, (await rig.priceOf(h, IMAGE)) * 2n); helpers.push(h); }
    const slow = new Set(helpers.map((h) => h.id));
    rig.st.readDelayFor = (id) => (slow.has(id) ? 700 : 0);
    const tc = []; for (let i = 0; i < 30; i++) tc.push(await rig.credentialFor(t, IMAGE));
    const hc = []; for (const h of helpers) hc.push(await rig.credentialFor(h, IMAGE), await rig.credentialFor(h, IMAGE));
    const hp = hc.map((c) => rig.send(IMAGE, c));
    await sleep(80);
    const a0 = rig.outcomesOf(t).attempts;
    rs = await Promise.all(tc.map((c) => rig.send(IMAGE, c)));
    await Promise.all(hp);
    rig.st.readDelayFor = null;
    await ok(rig.outcomesOf(t).attempts - a0 === 1, `/v1/images/fast, the read lane full of other wallets' reads: a one-price wallet's 30 calls still ran one handler (${rig.outcomesOf(t).attempts - a0}; ${JSON.stringify(tallyOf(rs))})`);
  }
  rig.st.llmDelayMs = 0;
  {
    // One account's unreadable balance is that account's: an honest new
    // funded wallet on the same network is read and served, eight at once.
    const bad = await rig.wallet("stellar"); const price = await rig.priceOf(bad, SQL);
    rig.fund(bad, price * 10n, { readable: false });
    await rig.burst(bad, SQL, 3);
    const good = await rig.wallet("stellar");
    rig.fund(good, price * 8n);
    const t0 = Date.now();
    const rs = await rig.burst(good, SQL, 8);
    await ok(tallyOf(rs)[200] === 8 && rig.peakOf(good) === 8 && Date.now() - t0 < 2500, `stellar: beside an account whose balance cannot be read, a new funded wallet's 8 calls at once are all served together (${JSON.stringify(tallyOf(rs))}, ${rig.peakOf(good)} at once, ${Date.now() - t0} ms)`);
    // A Solana wallet's paid record is its authority's, whichever token account pays.
    const s1 = await rig.wallet("svm"); const sp = await rig.priceOf(s1, SQL);
    rig.fund(s1, sp);
    const firstPaid = await rig.pay(s1, SQL);
    const s2 = await rig.wallet("svm", { signer: s1.signer });
    rig.fund(s2, sp * 100n, { readable: false });
    const rs2 = await rig.burst(s2, SQL, 12);
    await ok(firstPaid.status === 200 && s2.source !== s1.source && tallyOf(rs2)[200] === 12 && rig.peakOf(s2) === 12, `svm: a wallet that paid from one token account is known when it pays from another: 12 at once, balance unreadable, all together (${rig.peakOf(s2)} at once)`);
  }
} finally { await rig.stop(); }

// INFLIGHT_COVER=composite restores the scope and limits the check had before
// it covered every paid route: the report and media routes are judged (a
// one-price wallet runs one), and nothing else is.
rig = await bootPaidWires({ label: "inflight-burst-composite", env: { ...BREAKER_ENV, INFLIGHT_COVER: "composite" } });
try {
  rig.st.llmDelayMs = 1000;
  const one = await rig.wallet("evm");
  rig.fund(one, await rig.priceOf(one, IMAGE));
  let i0 = rig.st.images;
  let rs = await rig.burst(one, IMAGE, 30);
  await ok(rig.st.images - i0 === 1 && tallyOf(rs)[429] === 29, `composite: /v1/images/fast, a one-price wallet's 30 calls at once reach the image upstream once, as before (${rig.st.images - i0}; ${JSON.stringify(tallyOf(rs))})`);
  const fresh12 = await rig.wallet("evm");
  rig.fund(fresh12, (await rig.priceOf(fresh12, IMAGE)) * 12n);
  i0 = rig.st.images;
  rs = await rig.burst(fresh12, IMAGE, 12);
  await ok(rig.st.images - i0 === 12 && tallyOf(rs)[200] === 12 && rig.peakOf(fresh12) === 12, `composite: a new funded wallet's 12 image calls at once all run together (${rig.peakOf(fresh12)} at once)`);
  rig.st.llmDelayMs = 0;
  const poor = await rig.wallet("evm"); const price = await rig.priceOf(poor, SQL);
  rig.fund(poor, price);
  rs = await rig.burst(poor, SQL, 30);
  await ok(rig.outcomesOf(poor).attempts === 30 && !tallyOf(rs)[429], `composite: a route outside the report and media set is not judged, as before (${JSON.stringify(rig.outcomesOf(poor))})`);
  const s = await rig.operator("/api/gateway-status");
  await ok(s?.inflightCover?.mode === "composite" && s.settleFailures.runsInFlightCounted === 0, `composite: the operator view names the mode and the breaker counts nothing in flight (${s?.inflightCover?.mode})`);
} finally { await rig.stop(); }

// INFLIGHT_COVER=off is a true rollback: nothing is judged, nothing is counted
// in flight, and every call from one wallet runs, as before either rule existed.
rig = await bootPaidWires({ label: "inflight-burst-off", env: { ...BREAKER_ENV, INFLIGHT_COVER: "off" } });
try {
  for (const wire of ["evm", "tempo", "stellar"]) {
    const w = await rig.wallet(wire); const price = await rig.priceOf(w, SQL);
    rig.fund(w, price * 1000n);
    const rs = await rig.burst(w, SQL, 40);
    const o = rig.outcomesOf(w), t = tallyOf(rs);
    await ok(o.attempts === 40 && o.settled === 40 && t[200] === 40, `${wire}, coverage off: a funded wallet's 40 calls at once all run and settle (${JSON.stringify(o)}; ${JSON.stringify(t)})`);
    const poor = await rig.wallet(wire);
    rig.fund(poor, price);
    const rp = await rig.burst(poor, SQL, 40);
    await ok(rig.outcomesOf(poor).attempts === 40 && !tallyOf(rp)[429], `${wire}, coverage off: nothing is refused before the handler, as before (${JSON.stringify(rig.outcomesOf(poor))}; ${JSON.stringify(tallyOf(rp))})`);
  }
  const s = await rig.operator("/api/gateway-status");
  await ok(s?.settleFailures?.runsInFlightCounted === 0 && s?.inflightCover?.enabled === false && s.inflightCover.admitted === 0, `coverage off: the ledger admitted nothing and the breaker counted nothing in flight (${s?.settleFailures?.runsInFlightCounted})`);
} finally { await rig.stop(); }

console.log(`\n${pass} checks passed`);
