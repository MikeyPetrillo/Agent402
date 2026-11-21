#!/usr/bin/env node
// Price webhooks (src/price-webhooks.js, POST /api/price-webhook, the free
// POST /api/price-webhook/unsubscribe).
//
// Part 1 (in process) drives the store with an injected clock, sender and URL
// check: the input rules; who is bounded (the registrant, never the host a
// URL names), renewal, expiry and the store's own bound; a registration kept
// only when its call settles; the price comparison, one change set stored
// once and one queued delivery per subscription; the signature, the retry
// schedule, the 410 removal, the delivery switch; a delivery turn that is
// fair across receivers and never runs beside itself; and that nothing is
// stored for a documentation host or without a signing key.
// Part 2 uses the real fetch guard: a private target is refused at
// registration and a stored one is never connected to (a listener on
// loopback counts connections, with a control connection that it does count).
// Part 3 boots a FREE_MODE server on port 0: the catalog entry, its published
// example, the removal route, a registration over HTTP (kept once its
// response ends, bounded per client address there), and a boot whose kept
// prices differ from the catalog's queues one delivery for the subscription
// that watches the slug. The paid path (a registration whose settlement
// fails leaves nothing stored) is scripts/test-price-webhooks-paid.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { createJsonDocument } from "../src/json-document.js";
import {
  createPriceWebhooks, parseTarget, parseSlugs, priceChanges, changesOf, secretFor, ownerDigest, signatureFor, verifySignature, isDocumentationHost,
  RETRY_DELAYS_MS, MAX_SLUGS, MAX_URL_CHARS, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER, EVENT_PRICE_CHANGED, UNSUBSCRIBE_PATH, PRICE_WEBHOOK_SLUG,
  DELIVERY_TIMEOUT_MS, DELIVERY_LANES, HOST_TURN_MS, TURN_BUDGET_MS, PENDING_MS, MAX_CHANGE_SETS, lifetimeMs, maxPerRegistrant, maxSubscriptions, hardMaxSubscriptions,
} from "../src/price-webhooks.js";
import { hasLastingEffect } from "../src/lasting-effect-slugs.js";
import { PRICE_WEBHOOK_TOOLS, registrantOf, makePriceWebhookHandler } from "../src/tools/price-webhook-kit.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++; };
const refuses = async (fn, status, re, msg) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err && err.statusCode === status && (!re || re.test(err.message)), `${msg} (${err ? `${err.statusCode} ${err.message}` : "no refusal"})`);
};

const dir = mkdtempSync(join(tmpdir(), "price-webhooks-"));
const KEY = "a-signing-key-for-the-test";
const KNOWN = new Set(["search", "answer", "hash", "uuid"]);
let fileN = 0;
// A store on a file of its own, with a clock, a sender and a URL check the test holds.
function rig({ env = { PRICE_WEBHOOK_SIGNING_KEY: KEY }, responder = () => ({ status: 200 }), checkUrl = async () => {}, deliveriesOn = () => true, attemptTimeoutMs = undefined } = {}) {
  const file = join(dir, `store-${++fileN}.json`);
  const clock = { t: Date.UTC(2026, 10, 21, 12) };
  const sent = [];
  const checked = [];
  const pw = createPriceWebhooks({
    doc: createJsonDocument({ name: null, file, log: () => {} }),
    now: () => clock.t, env, baseUrl: () => "https://tools.test",
    checkUrl: async (u) => { checked.push(u); return checkUrl(u); },
    send: async (url, init) => { sent.push({ url, ...init }); const r = await responder(url, init, sent.length); if (r instanceof Error) throw r; return r; },
    deliveriesOn, log: () => {}, settleRetryDelaysMs: [], ...(attemptTimeoutMs ? { attemptTimeoutMs } : {}),
  });
  const stored = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
  /** What a stored queued delivery announces to its subscription. */
  const announces = (q, body = stored()) => changesOf(body, q, body.subs[q.sub]);
  /** One price change, so every subscription that watches `slug` has a delivery due. */
  let priceN = 0;
  const change = async (slug = "search") => { if (!stored()?.prices) await pw.notePrices({ search: "$0.01", hash: "$0.001" }); return pw.notePrices({ search: "$0.01", hash: "$0.001", [slug]: `$1.${String(++priceN).padStart(2, "0")}` }); };
  return { pw, clock, sent, checked, stored, file, announces, change };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

try {
  // ---- Part 1: the rules ---------------------------------------------------------
  {
    eq(parseTarget(" https://hooks.buyer.test/a?b=1#frag "), { url: "https://hooks.buyer.test/a?b=1", host: "hooks.buyer.test" }, "a target is trimmed and loses its fragment");
    for (const [u, re] of [["", /required/], ["not a url", /not a valid URL/], ["http://hooks.buyer.test/a", /https/], ["ftp://hooks.buyer.test/a", /https/], ["https://user:pw@hooks.buyer.test/a", /credentials/], [`https://hooks.buyer.test/${"a".repeat(MAX_URL_CHARS)}`, /at most/], [42, /required/]]) {
      assert.throws(() => parseTarget(u), (e) => e.statusCode === 400 && re.test(e.message), `target ${String(u).slice(0, 40)}`); pass++;
    }
    for (const raw of [undefined, null, "*", []]) eq(parseSlugs(raw, KNOWN), null, `slugs ${JSON.stringify(raw)} watches every tool`);
    eq(parseSlugs(["search", " ANSWER ", "search"], KNOWN), ["answer", "search"], "slugs are trimmed, lowercased, de-duplicated and sorted");
    eq(parseSlugs("hash,uuid", KNOWN), ["hash", "uuid"], "a comma list is read");
    assert.throws(() => parseSlugs(["nope"], KNOWN), (e) => e.statusCode === 400 && /not a tool in this catalog/.test(e.message)); pass++;
    assert.throws(() => parseSlugs(["Bad Slug!"], KNOWN), (e) => e.statusCode === 400 && /not a tool slug/.test(e.message)); pass++;
    assert.throws(() => parseSlugs(Array.from({ length: MAX_SLUGS + 1 }, (_, i) => `t${i}`), null), (e) => e.statusCode === 400 && /at most/.test(e.message)); pass++;
    assert.throws(() => parseSlugs({ a: 1 }, KNOWN), (e) => e.statusCode === 400); pass++;
    eq(priceChanges({ a: "$0.01", b: "$0.02", gone: "$1" }, { a: "$0.01", b: "$0.03", added: "$5" }), [{ slug: "b", from: "$0.02", to: "$0.03" }], "a change is a slug in both maps whose price differs");
    eq(priceChanges(null, { a: "$1" }), [], "nothing kept, nothing changed");
    for (const h of ["example.com", "EXAMPLE.org", "example.net", "hooks.example", "a.b.example"]) ok(isDocumentationHost(h), `${h} is a documentation host`);
    for (const h of ["example.com.evil.test", "myexample.com", "example.co", "hooks.buyer.test"]) ok(!isDocumentationHost(h), `${h} is not`);
  }
  {
    // No signing key: refused, nothing stored, no URL checked.
    const r = rig({ env: {} });
    await refuses(() => r.pw.register({ url: "https://hooks.buyer.test/a" }, { known: KNOWN }), 503, /not configured/, "no signing key: a 503");
    eq(r.stored(), null, "and nothing is stored");
    eq(r.checked, [], "and no URL is checked");
    eq((await r.pw.deliverDue()).skipped, "no-signing-key", "and nothing is delivered");
    // The documentation host still answers in full (nothing is kept for it).
    const doc = await r.pw.register({ url: "https://example.com/h", slugs: ["hash"] }, { known: KNOWN });
    ok(/^a402whsec_[0-9a-f]{64}$/.test(doc.secret) && doc.registered === false && r.stored() === null, "no signing key: the documentation host answer has every field and stores nothing");
    await refuses(() => r.pw.register({ url: "http://example.com/h" }, { known: KNOWN }), 400, /https/, "no signing key: an input error is still the caller's 400");
    // POW_SECRET stands in when the dedicated key is unset.
    const viaPow = rig({ env: { POW_SECRET: "pow-secret" } });
    const reg = await viaPow.pw.register({ url: "https://hooks.buyer.test/a" }, { known: KNOWN });
    eq(reg.secret, secretFor("pow-secret", reg.id), "POW_SECRET is the fallback signing key");
  }
  {
    // A documentation host: a full answer, nothing stored, nothing checked or sent.
    const r = rig();
    const reg = await r.pw.register({ url: "https://example.com/hooks/agent402-prices", slugs: ["search", "answer"] }, { known: KNOWN });
    ok(/^pw_[0-9a-f]{32}$/.test(reg.id) && reg.secret === secretFor(KEY, reg.id) && reg.registered === false && reg.delivers === false && /documentation host/.test(reg.note), "the documentation host answer");
    eq(reg.slugs, ["answer", "search"], "with the slugs it named");
    eq(r.stored(), null, "nothing is stored for it");
    eq(r.checked, [], "its host is not resolved");
    await r.pw.notePrices({ search: "$1" }); await r.pw.notePrices({ search: "$2" });
    eq((await r.pw.deliverDue()).sent, 0, "and nothing is ever sent to it");
  }
  {
    // A registration: checked, stored without a secret, answered with the derived secret.
    const r = rig();
    const reg = await r.pw.register({ url: "https://hooks.buyer.test/a", slugs: ["search"] }, { known: KNOWN });
    eq(r.checked, ["https://hooks.buyer.test/a"], "the target goes through the URL check");
    ok(reg.registered === true && reg.delivers === true && reg.secret === secretFor(KEY, reg.id) && reg.unsubscribe.url === `https://tools.test${UNSUBSCRIBE_PATH}`, "the registration answer");
    const body = r.stored();
    eq(body.subs[reg.id], { url: "https://hooks.buyer.test/a", host: "hooks.buyer.test", slugs: ["search"], at: r.clock.t, exp: r.clock.t + lifetimeMs({}) }, "the stored record is the URL, host, slugs, time and expiry");
    eq(reg.expiresAt, new Date(r.clock.t + 90 * DAY).toISOString(), "the answer says when it expires: 90 days on");
    ok(!JSON.stringify(body).includes("a402whsec_") && !JSON.stringify(body).includes(KEY), "no secret and no key is stored");
    // A refused URL check stores nothing.
    const bad = rig({ checkUrl: async () => { throw Object.assign(new Error("URL host could not be resolved, or resolves to a private address"), { statusCode: 400 }); } });
    await refuses(() => bad.pw.register({ url: "https://hooks.private.test/a" }, { known: KNOWN }), 400, /private address/, "a target the guard refuses is a 400");
    eq(bad.stored(), null, "and nothing is stored");

    // Removal: the wrong secret and an unknown id read the same; the right one removes.
    eq(await r.pw.unsubscribe({ id: reg.id, secret: `a402whsec_${"0".repeat(64)}` }), { removed: false }, "a wrong secret removes nothing");
    eq(await r.pw.unsubscribe({ id: `pw_${"0".repeat(32)}`, secret: secretFor(KEY, `pw_${"0".repeat(32)}`) }), { removed: false }, "an unknown id removes nothing");
    ok(r.stored().subs[reg.id], "the subscription is still there");
    await refuses(() => r.pw.unsubscribe({ id: "nope", secret: "x" }), 400, /id/, "a malformed id is a 400");
    await refuses(() => r.pw.unsubscribe({ id: reg.id }), 400, /secret/, "a missing secret is a 400");
    eq(await r.pw.unsubscribe({ id: reg.id, secret: reg.secret }), { removed: true }, "the right secret removes it");
    eq(Object.keys(r.stored().subs), [], "and it is gone");
  }
  {
    // Who is bounded: the registrant, never the host a URL names.
    ok(maxPerRegistrant({}) === 25 && maxSubscriptions({}) === 5000 && hardMaxSubscriptions({}) === 10000 && lifetimeMs({}) === 90 * DAY, "defaults: 25 subscriptions a registrant, room made from 5,000 on, 10,000 at most, 90 days each");
    const r = rig({ env: { PRICE_WEBHOOK_SIGNING_KEY: KEY, PRICE_WEBHOOK_MAX_PER_PAYER: "2", PRICE_WEBHOOK_MAX_PER_HOST: "2" } });
    const A = "payer:0x00000000000000000000000000000000000000aa", B = "payer:0x00000000000000000000000000000000000000bb", C = "svm:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    // Many buyers point at one shared receiver host: none is refused for it.
    const shared = [];
    for (let i = 0; i < 6; i++) shared.push(await r.pw.register({ url: `https://relay.shared.test/hook/${i}` }, { known: KNOWN, registrant: `payer:0x${String(i + 1).padStart(40, "0")}` }));
    eq(shared.filter((x) => x.registered).length, 6, "six buyers register endpoints on one shared host and none is refused for the host");
    // A registrant's own excess is the only refusal, and it says so.
    const a1 = await r.pw.register({ url: "https://one.buyer.test/a" }, { known: KNOWN, registrant: A });
    await r.pw.register({ url: "https://two.buyer.test/a" }, { known: KNOWN, registrant: A });
    await refuses(() => r.pw.register({ url: "https://three.buyer.test/a" }, { known: KNOWN, registrant: A }), 409, /already holds 2 price webhooks.*Remove one first.*renew/, "a registrant's third registration past its cap of two is a 409 that says what to do");
    const b1 = await r.pw.register({ url: "https://three.buyer.test/a" }, { known: KNOWN, registrant: B });
    ok(b1.registered === true, "another registrant registers the URL the first was refused: nobody is refused for what another holds");
    // The same wallet from another rail's key is its own registrant; case is kept.
    ok((await r.pw.register({ url: "https://one.buyer.test/a" }, { known: KNOWN, registrant: C })).registered === true, "a Solana signer is a registrant of its own");
    const body = r.stored();
    ok(body.subs[a1.id].owner === ownerDigest(KEY, A) && /^o_[0-9a-f]{32}$/.test(body.subs[a1.id].owner) && body.subs[a1.id].owner !== body.subs[b1.id].owner, "a subscription names its registrant by a keyed digest");
    ok(!/0x0{38}aa|payer:|svm:|7xKXtg2CW87/.test(JSON.stringify(body)), "no wallet and no registrant key is stored");

    // Renewal: the same URL again from the same proven registrant keeps the id and the secret.
    r.clock.t += 30 * DAY;
    const again = await r.pw.register({ url: "https://one.buyer.test/a", slugs: ["hash"] }, { known: KNOWN, registrant: A });
    ok(again.id === a1.id && again.secret === a1.secret && again.renewed === true && again.registered === true, "registering a URL it already holds renews it: the same id and secret");
    eq([r.stored().subs[a1.id].exp, r.stored().subs[a1.id].slugs, again.expiresAt], [r.clock.t + 90 * DAY, ["hash"], new Date(r.clock.t + 90 * DAY).toISOString()], "with a new lifetime from that call and the slugs as sent");
    eq(Object.values(r.stored().subs).filter((x) => x.owner === ownerDigest(KEY, A)).length, 2, "a renewal takes no second place against the registrant's cap");
    // A registrant no payment proved (a client address) never gets another's id back.
    const ipReg = rig({ env: { PRICE_WEBHOOK_SIGNING_KEY: KEY, PRICE_WEBHOOK_MAX_PER_PAYER: "2" } });
    const ip1 = await ipReg.pw.register({ url: "https://one.buyer.test/a" }, { known: KNOWN, registrant: "ip:198.51.100.7" });
    const ip2 = await ipReg.pw.register({ url: "https://one.buyer.test/a" }, { known: KNOWN, registrant: "ip:198.51.100.7" });
    ok(ip2.id !== ip1.id && ip2.renewed === undefined, "the same URL from the same client address is a new subscription: an address proves no party, so no id or secret is handed back");
    await refuses(() => ipReg.pw.register({ url: "https://one.buyer.test/b" }, { known: KNOWN, registrant: "ip:198.51.100.7" }), 409, /already holds 2/, "a client address is held to the same cap (what bounds FREE_MODE, where there is no payer)");
    ok((await ipReg.pw.register({ url: "https://one.buyer.test/b" }, { known: KNOWN, registrant: "ip:198.51.100.8" })).registered === true, "and another address is not");

    // Expiry: a subscription is removed 90 days after its registration (or renewal).
    r.clock.t += 61 * DAY; // the six shared ones and A's second are 91 days old; A's first was renewed 61 days ago
    await r.change("search");
    const left = r.stored();
    ok(!left.subs[shared[0].id] && left.subs[a1.id] && left.queue.every((q) => left.subs[q.sub]), "past its lifetime a subscription is removed at the next store write, and a renewed one lives on");
    ok((await r.pw.register({ url: "https://three.buyer.test/b" }, { known: KNOWN, registrant: A })).registered === true, "the place an expired one held is the registrant's again");
    // An expired subscription is never delivered to, removed yet or not.
    const ex = rig();
    await ex.pw.register({ url: "https://old.buyer.test/h" }, { known: KNOWN });
    await ex.change("search");
    ex.clock.t += 91 * DAY;
    const turn = await ex.pw.deliverDue();
    eq([turn.sent, ex.sent.length], [0, 0], "a delivery queued for a subscription that has since expired is not sent");
    ok((await ex.pw.status()).sinceBoot.expired === 0 && (await ex.change("search")) && (await ex.pw.status()).sinceBoot.expired === 1 && Object.keys(ex.stored().subs).length === 0 && ex.stored().queue.length === 0, "and the next store write removes it with its delivery");
  }
  {
    // The store's own bound: failing subscriptions make room, then twice the bound, then a 503.
    const r = rig({ env: { PRICE_WEBHOOK_SIGNING_KEY: KEY, PRICE_WEBHOOK_MAX: "3", PRICE_WEBHOOK_MAX_PER_PAYER: "1" }, responder: (url) => ({ status: url.includes("dead") ? 500 : 200 }) });
    const reg = (n, host = `h${n}.buyer.test`) => r.pw.register({ url: `https://${host}/h` }, { known: KNOWN, registrant: `payer:0x${String(n).padStart(40, "0")}` });
    const dead = await reg(1, "dead.buyer.test");
    const live = [await reg(2), await reg(3)];
    // The dead receiver's delivery is tried to the end and dropped.
    await r.change("search");
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) { await r.pw.deliverDue(); r.clock.t += RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]; }
    eq([r.stored().subs[dead.id].fails, r.stored().queue.length], [1, 0], "setup: one of three subscriptions has had its delivery dropped after every attempt");
    const fourth = await reg(4);
    const after = r.stored();
    ok(fourth.registered === true && !after.subs[dead.id] && live.every((x) => after.subs[x.id]) && Object.keys(after.subs).length === 3, "at the bound a new registrant is admitted and the subscription whose deliveries fail is the one removed");
    // With nothing failing, new registrants are admitted past the bound and nothing is removed.
    const more = [await reg(5), await reg(6), await reg(7)];
    ok(more.every((x) => x.registered) && Object.keys(r.stored().subs).length === 6 && live.every((x) => r.stored().subs[x.id]), "with nothing failing a new registrant is admitted past the bound, and nothing a receiver answers is removed for room");
    await refuses(() => reg(8), 503, /as many price webhooks as it can keep/, "at twice the bound, the hard bound, a registration is a 503");
    let err = null; try { await reg(9); } catch (e) { err = e; }
    ok(err?.retryAfterSeconds === 3600 && Object.keys(r.stored().subs).length === 6, "with a Retry-After, and the store holds what it held");
    const st = await r.pw.status();
    eq([st.subscriptions, st.bound, st.hardBound, st.sinceBoot.removedForRoom, st.sinceBoot.refusedFull, st.failing], [6, 3, 6, 1, 2, 0], "the status counts what was removed for room and what was refused");
  }
  {
    // A registration is kept only when its call settles.
    const r = rig();
    const A = "payer:0x00000000000000000000000000000000000000aa";
    const p = await r.pw.registerPending({ url: "https://a.buyer.test/h", slugs: ["search"] }, { known: KNOWN, registrant: A });
    ok(p.answer.registered === true && typeof p.settle === "function" && r.stored().subs[p.answer.id].pending === r.clock.t + PENDING_MS, "a registration whose call has not settled is stored as pending");
    await r.change("search");
    eq([r.stored().queue.length, (await r.pw.deliverDue()).sent, r.sent.length], [0, 0, 0], "and nothing is queued for it or sent to it");
    ok((await p.settle(false)) === true && !r.stored().subs[p.answer.id] && Object.keys(r.stored().subs).length === 0, "a call that did not settle leaves nothing stored");
    eq(await r.pw.unsubscribe({ id: p.answer.id, secret: p.answer.secret }), { removed: false }, "the id it was answered with names nothing");
    // A settled one is confirmed, and then delivered to.
    const q = await r.pw.registerPending({ url: "https://a.buyer.test/h", slugs: ["search"] }, { known: KNOWN, registrant: A });
    await q.settle(true);
    ok(r.stored().subs[q.answer.id] && r.stored().subs[q.answer.id].pending === undefined, "a call that settled confirms it");
    await r.change("search");
    eq((await r.pw.deliverDue()).delivered, 1, "and it is delivered to");
    // One never reported (the process ended in between) ends on its own.
    const lost = await r.pw.registerPending({ url: "https://lost.buyer.test/h" }, { known: KNOWN, registrant: "payer:0x00000000000000000000000000000000000000cc" });
    r.clock.t += PENDING_MS + 1;
    await r.change("search");
    ok(!r.stored().subs[lost.answer.id] && r.stored().subs[q.answer.id], `a registration never reported settled is removed ${PENDING_MS / 60_000} minutes on, at the next store write`);
    // A renewal whose call does not settle leaves the subscription as it was.
    const before = { ...r.stored().subs[q.answer.id] };
    r.clock.t += DAY;
    const ren = await r.pw.registerPending({ url: "https://a.buyer.test/h", slugs: ["hash"] }, { known: KNOWN, registrant: A });
    ok(ren.answer.id === q.answer.id && ren.answer.renewed === true, "a renewal answers the same id");
    await ren.settle(false);
    eq(r.stored().subs[q.answer.id], before, "a renewal whose call did not settle changes nothing");
    const ren2 = await r.pw.registerPending({ url: "https://a.buyer.test/h", slugs: ["hash"] }, { known: KNOWN, registrant: A });
    await ren2.settle(true);
    eq([r.stored().subs[q.answer.id].exp, r.stored().subs[q.answer.id].slugs, r.stored().subs[q.answer.id].renew], [r.clock.t + 90 * DAY, ["hash"], undefined], "one whose call settled takes the new lifetime and slugs");
    // The handler: with a response to wait for it leaves a hook; without one it is kept at once.
    const h = rig();
    const handler = makePriceWebhookHandler({ store: () => h.pw, known: () => KNOWN, registrantOf: async () => A });
    const req = { headers: {}, res: { once() {} } };
    const ans = await handler({ url: "https://a.buyer.test/h" }, req);
    ok(ans.registered === true && h.stored().subs[ans.id].pending > 0 && Array.isArray(req.__onSettled) && req.__onSettled.length === 1, "the handler stores a pending registration and leaves one hook for the final response");
    req.__onSettled[0](false);
    for (let i = 0; i < 40 && h.stored().subs[ans.id]; i++) await sleep(10);
    ok(!h.stored().subs[ans.id], "a final response that is not a settled 200 removes it");
    const req2 = { headers: {}, res: { once() {} } };
    const ans2 = await handler({ url: "https://a.buyer.test/h" }, req2);
    req2.__onSettled[0](true);
    for (let i = 0; i < 40 && h.stored().subs[ans2.id]?.pending; i++) await sleep(10);
    ok(h.stored().subs[ans2.id] && h.stored().subs[ans2.id].pending === undefined, "a settled 200 keeps it");
    const direct = await handler({ url: "https://b.buyer.test/h" });
    ok(direct.registered === true && h.stored().subs[direct.id].pending === undefined, "a call with no response to wait for is kept at once");
  }
  {
    // The registrant of a request (src/tools/price-webhook-kit.js).
    const hadFree = process.env.FREE_MODE;
    const header = (from) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from } } })).toString("base64");
    const paidReq = (from, ip) => { const h = header(from); return { ip, headers: { "x-payment": h }, header: (n) => (String(n).toLowerCase() === "x-payment" ? h : undefined) }; };
    const W = `0x${"ab".repeat(20)}`;
    try {
      delete process.env.FREE_MODE; // the gate verified the payment
      eq(await registrantOf(paidReq(W, "198.51.100.9")), `payer:${W}`, "paid: the signed payer is the registrant, whatever address it calls from");
      eq(await registrantOf({ ip: "198.51.100.9", headers: {}, creditsKeyId: "k1" }), "credits:k1", "a credits key is");
      eq(await registrantOf({ ip: "198.51.100.9", headers: {}, mppTempoSender: "0xABCDEF0000000000000000000000000000000001" }), "tempo:0xabcdef0000000000000000000000000000000001", "a Tempo sender is");
      const cardA = await registrantOf({ ip: "198.51.100.9", headers: { authorization: "Payment card-credential-one" } });
      const cardB = await registrantOf({ ip: "198.51.100.9", headers: { authorization: "Payment card-credential-two" } });
      ok(/^paid:[0-9a-f]{32}$/.test(cardA) && cardA !== cardB, "a paid call that names no wallet is a registrant of its own, never counted with another caller at its address");
      process.env.FREE_MODE = "true"; // nothing is verified: no payer
      eq(await registrantOf(paidReq(W, "198.51.100.9")), "ip:198.51.100.9", "FREE_MODE: a payment header a caller typed names no registrant; the client address does");
      eq(await registrantOf({ ip: "2001:db8:1:2:3:4:5:6", headers: {} }), await registrantOf({ ip: "2001:db8:1:2::9", headers: {} }), "an IPv6 address is folded to its /64");
    } finally { if (hadFree === undefined) delete process.env.FREE_MODE; else process.env.FREE_MODE = hadFree; }
  }
  {
    // Prices: a first record announces nothing; a change queues one delivery per watcher.
    const r = rig();
    const search = await r.pw.register({ url: "https://a.buyer.test/h", slugs: ["search"] }, { known: KNOWN });
    const all = await r.pw.register({ url: "https://b.buyer.test/h" }, { known: KNOWN });
    const hash = await r.pw.register({ url: "https://c.buyer.test/h", slugs: ["hash"] }, { known: KNOWN });
    eq(await r.pw.notePrices({ search: "$0.01", hash: "$0.001" }), { first: true, changes: 0, queued: 0, ok: true }, "the first record announces nothing");
    eq(await r.pw.notePrices({ search: "$0.01", hash: "$0.001" }), { first: false, changes: 0, queued: 0, ok: true }, "the same prices change nothing");
    eq(await r.pw.notePrices({ search: "$0.01", hash: "$0.001", uuid: "$0.001" }), { first: false, changes: 0, queued: 0, ok: true }, "a tool added is not a price change");
    eq(r.stored().prices.uuid, "$0.001", "the added tool's price is kept for next time");
    eq(await r.pw.notePrices({ search: "$0.02", hash: "$0.001", uuid: "$0.001" }), { first: false, changes: 1, queued: 2, ok: true }, "a changed price queues the two subscriptions that watch it");
    let q = r.stored().queue;
    eq(q.map((x) => x.sub).sort(), [search.id, all.id].sort(), "the slug's watcher and the watch-all subscription, not the other slug's");
    eq(r.announces(q[0]), [{ slug: "search", from: "$0.01", to: "$0.02" }], "the change names the slug and both prices");
    // The change set is stored once and each queued delivery names it.
    const sets = r.stored().sets;
    eq(Object.values(sets).map((x) => x.changes), [[{ slug: "search", from: "$0.01", to: "$0.02" }]], "the changes are stored once, as one set");
    ok(q.every((x) => JSON.stringify(x.sets) === JSON.stringify(Object.keys(sets)) && x.changes === undefined) && !JSON.stringify(q).includes("from"), `each queued delivery names the set and copies no change (${JSON.stringify(q[0])})`);
    // A second change before the delivery joins the one waiting; a price that returns is dropped.
    await r.pw.notePrices({ search: "$0.03", hash: "$0.002", uuid: "$0.001" });
    q = r.stored().queue;
    eq(q.length, 3, "still one queued delivery per subscription");
    eq(r.announces(q.find((x) => x.sub === search.id)), [{ slug: "search", from: "$0.01", to: "$0.03" }], "the waiting change keeps its first price and takes the latest");
    eq(r.announces(q.find((x) => x.sub === all.id)).map((c) => c.slug), ["hash", "search"], "the watch-all delivery carries both changes");
    eq(Object.keys(r.stored().sets).length, 2, "a second change is a second set, stored once");
    await r.pw.notePrices({ search: "$0.01", hash: "$0.002", uuid: "$0.001" });
    q = r.stored().queue;
    ok(!q.some((x) => x.sub === search.id), "a price back at its first value leaves nothing to announce");
    eq(r.announces(q.find((x) => x.sub === hash.id)), [{ slug: "hash", from: "$0.001", to: "$0.002" }], "the other change still waits");
  }
  {
    // One change set, stored once, however many subscriptions it is queued for.
    const r = rig();
    const N = 200, SLUGS = Array.from({ length: 25 }, (_, i) => `tool-${String(i).padStart(2, "0")}`);
    for (let i = 0; i < N; i++) await r.pw.register({ url: `https://h${i}.buyer.test/h` }, { known: null });
    const price = (p) => Object.fromEntries(SLUGS.map((s) => [s, p]));
    await r.pw.notePrices(price("$0.01"));
    eq(await r.pw.notePrices(price("$0.02")), { first: false, changes: 25, queued: N, ok: true }, `25 price changes queue one delivery for each of ${N} watch-all subscriptions`);
    const body = r.stored();
    const queueBytes = JSON.stringify(body.queue).length, setBytes = JSON.stringify(body.sets).length;
    ok(Object.keys(body.sets).length === 1 && queueBytes < N * 200 && setBytes < 25 * 80, `the 25 changes are stored once (${setBytes} bytes) and the ${N} queued deliveries name them (${Math.round(queueBytes / N)} bytes each, ${queueBytes} in all)`);
    const turn = await r.pw.deliverDue();
    eq([turn.delivered, JSON.parse(r.sent[0].body).changes.length, JSON.parse(r.sent.at(-1).body).changes[24]], [N, 25, { slug: "tool-24", from: "$0.01", to: "$0.02" }], "and every delivery carries the whole list");
    eq([Object.keys(r.stored().sets).length, r.stored().queue.length], [0, 0], "a set no queued delivery names any more is dropped");
  }
  {
    // Sets are bounded: past the cap the two oldest are folded into one.
    const r = rig({ deliveriesOn: () => false });
    const all = await r.pw.register({ url: "https://a.buyer.test/h" }, { known: KNOWN });
    await r.pw.notePrices({ search: "$0.00" });
    for (let i = 1; i <= MAX_CHANGE_SETS + 4; i++) await r.pw.notePrices({ search: `$0.${String(i).padStart(2, "0")}` });
    const body = r.stored();
    ok(Object.keys(body.sets).length === MAX_CHANGE_SETS && body.queue.length === 1 && body.queue[0].sets.length === MAX_CHANGE_SETS, `at most ${MAX_CHANGE_SETS} change sets are kept (${Object.keys(body.sets).length})`);
    eq(r.announces(body.queue.find((q) => q.sub === all.id), body), [{ slug: "search", from: "$0.00", to: `$0.${MAX_CHANGE_SETS + 4}` }], "and the delivery still announces the first price and the latest");
  }
  {
    // Delivery: a signed POST; a 2xx ends it.
    const r = rig();
    const reg = await r.pw.register({ url: "https://a.buyer.test/h", slugs: ["search"] }, { known: KNOWN });
    await r.pw.notePrices({ search: "$0.01" }); await r.pw.notePrices({ search: "$0.02" });
    const out = await r.pw.deliverDue();
    eq([out.sent, out.delivered, out.left], [1, 1, 0], "one delivery sent and done");
    const s = r.sent[0];
    eq([s.url, s.method], ["https://a.buyer.test/h", "POST"], "a POST to the registered URL");
    const payload = JSON.parse(s.body);
    eq([payload.type, payload.id, payload.attempt, payload.changes], [EVENT_PRICE_CHANGED, reg.id, 1, [{ slug: "search", from: "$0.01", to: "$0.02" }]], "the payload names the event, the subscription and the change");
    ok(payload.unsubscribe.url === `https://tools.test${UNSUBSCRIBE_PATH}` && !s.body.includes(reg.secret), "the payload says how to remove it and carries no secret");
    eq([s.headers["Content-Type"], s.headers[EVENT_HEADER], s.headers[DELIVERY_HEADER]], ["application/json", EVENT_PRICE_CHANGED, payload.deliveryId], "the event and delivery headers");
    const sig = s.headers[SIGNATURE_HEADER];
    ok(verifySignature(reg.secret, sig, s.body, { now: r.clock.t }), "the signature verifies with the subscription's secret");
    ok(!verifySignature(reg.secret, sig, s.body.replace("$0.02", "$0.99"), { now: r.clock.t }), "a changed body does not verify");
    ok(!verifySignature(secretFor(KEY, `pw_${"1".repeat(32)}`), sig, s.body, { now: r.clock.t }), "another subscription's secret does not verify");
    ok(!verifySignature(reg.secret, sig, s.body, { now: r.clock.t + 10 * 60_000 }), "a signature older than the tolerance does not verify");
    ok(!verifySignature(reg.secret, "t=1,v1=zz", s.body) && !verifySignature(reg.secret, "", s.body), "a malformed header does not verify");
    eq(sig, signatureFor(reg.secret, Math.floor(r.clock.t / 1000), s.body), "the header is t=<seconds>,v1=<HMAC of t.body>");
    // Computed here from the documented scheme, not with the module's own function.
    const t = Math.floor(r.clock.t / 1000);
    eq(sig, `t=${t},v1=${createHmac("sha256", reg.secret).update(`${t}.${s.body}`).digest("hex")}`, "a receiver following the documented scheme computes the same header");
    eq(reg.secret, `a402whsec_${createHmac("sha256", KEY).update(`price-webhook-secret|${reg.id}`).digest("hex")}`, "the secret is the keyed digest of the subscription id");
    eq((await r.pw.deliverDue()).sent, 0, "nothing is sent twice");
  }
  {
    // Retries: the schedule, then the drop; a throw from the sender counts as no answer.
    const r = rig({ responder: (_u, _i, n) => (n === 2 ? new Error("refused by the guard") : { status: 500 }) });
    await r.pw.register({ url: "https://a.buyer.test/h" }, { known: KNOWN });
    await r.pw.notePrices({ search: "$0.01" }); await r.pw.notePrices({ search: "$0.02" });
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      const out = await r.pw.deliverDue();
      eq([out.sent, out.retried, out.dropped], [1, 1, 0], `attempt ${i + 1} fails and is kept`);
      const item = r.stored().queue[0];
      eq([item.tries, item.next], [i + 1, r.clock.t + RETRY_DELAYS_MS[i]], `the next attempt is ${RETRY_DELAYS_MS[i]} ms on`);
      eq((await r.pw.deliverDue()).sent, 0, "nothing is sent before it is due");
      r.clock.t = item.next;
    }
    const last = await r.pw.deliverDue();
    eq([last.sent, last.retried, last.dropped, last.left], [1, 0, 1, 0], "the last attempt fails and the delivery is dropped");
    eq(r.sent.length, RETRY_DELAYS_MS.length + 1, `${RETRY_DELAYS_MS.length + 1} attempts in all`);
    eq(JSON.parse(r.sent.at(-1).body).attempt, RETRY_DELAYS_MS.length + 1, "the payload counts the attempt");
    eq(Object.keys(r.stored().subs).length, 1, "the subscription stays");
    eq(Object.values(r.stored().subs)[0].fails, 1, "and is marked as one whose last delivery was dropped");
  }
  {
    // A 410 removes the subscription; a redirect is not followed (it is a failed attempt).
    const r = rig({ responder: (url) => ({ status: url.includes("gone") ? 410 : 302 }) });
    const gone = await r.pw.register({ url: "https://gone.buyer.test/h" }, { known: KNOWN });
    const moved = await r.pw.register({ url: "https://moved.buyer.test/h" }, { known: KNOWN });
    await r.pw.notePrices({ search: "$0.01" }); await r.pw.notePrices({ search: "$0.02" });
    const out = await r.pw.deliverDue();
    eq([out.sent, out.removedOn410, out.retried], [2, 1, 1], "the 410 removes, the 302 is retried");
    const body = r.stored();
    ok(!body.subs[gone.id] && body.subs[moved.id] && body.queue.length === 1 && body.queue[0].sub === moved.id, "the removed subscription and its delivery are gone");
  }
  {
    // The delivery switch: off sends nothing and keeps the queue; on sends.
    let on = false;
    const r = rig({ deliveriesOn: () => on });
    await r.pw.register({ url: "https://a.buyer.test/h" }, { known: KNOWN });
    await r.pw.notePrices({ search: "$0.01" }); await r.pw.notePrices({ search: "$0.02" });
    eq((await r.pw.deliverDue()).skipped, "deliveries-off", "off: nothing is sent");
    eq([r.sent.length, r.stored().queue.length], [0, 1], "and the delivery waits");
    on = true;
    eq((await r.pw.deliverDue()).delivered, 1, "on: it is sent");
    const st = await r.pw.status();
    eq([st.configured, st.deliveries, st.subscriptions, st.queued, st.sinceBoot.delivered], [true, "on", 1, 0, 1], "the status is counts only");
    // No free text anywhere in it: every value is a count, a flag or the on/off word.
    const leaves = (v) => (v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v]);
    ok(leaves(st).length > 4 && leaves(st).every((v) => typeof v === "number" || typeof v === "boolean" || v === null || v === "on" || v === "off"), `and names no target (${JSON.stringify(st)})`);
  }

  // ---- a delivery turn is fair across receivers ----------------------------------------
  {
    ok(DELIVERY_TIMEOUT_MS === 4_000 && HOST_TURN_MS === 8_000 && TURN_BUDGET_MS === 40_000 && DELIVERY_LANES === 16, "one attempt gets 4 s, one answering host 8 s of a turn, a turn starts nothing after 40 s, 16 hosts in flight");
    // One request at a time to a host; different hosts at once.
    const inFlight = new Map();
    let peakHost = 0, peakAll = 0, flying = 0;
    const r = rig({ responder: async (url) => {
      const host = new URL(url).host;
      inFlight.set(host, (inFlight.get(host) || 0) + 1); flying++;
      peakHost = Math.max(peakHost, inFlight.get(host)); peakAll = Math.max(peakAll, flying);
      await sleep(15);
      inFlight.set(host, inFlight.get(host) - 1); flying--;
      return { status: 200 };
    } });
    for (const host of ["one.buyer.test", "two.buyer.test", "three.buyer.test"]) for (let i = 0; i < 3; i++) await r.pw.register({ url: `https://${host}/h${i}` }, { known: KNOWN });
    await r.change("search");
    const turn = await r.pw.deliverDue();
    eq([turn.delivered, peakHost], [9, 1], "nine deliveries to three hosts: one request at a time to each host");
    ok(peakAll === 3, `and the three hosts are sent to at once (${peakAll} in flight at most)`);
  }
  {
    // A receiver that never answers: one short attempt this turn, and everyone else is delivered.
    const r = rig({ attemptTimeoutMs: 60, responder: (url) => (url.includes("tarpit") ? new Promise(() => {}) : { status: 200 }) });
    for (let i = 0; i < 3; i++) await r.pw.register({ url: `https://tarpit.buyer.test/h${i}` }, { known: KNOWN });
    for (let i = 0; i < 5; i++) await r.pw.register({ url: `https://ok${i}.buyer.test/h` }, { known: KNOWN });
    await r.change("search");
    const t0 = Date.now();
    const turn = await Promise.race([r.pw.deliverDue(), sleep(3_000).then(() => "the turn never ended")]);
    const ms = Date.now() - t0;
    ok(turn !== "the turn never ended" && ms < 1_000, `a receiver that never answers does not hold the turn (${ms} ms; ${JSON.stringify(turn)})`);
    eq([turn.delivered, turn.retried, turn.waiting], [5, 1, 2], "the five receivers that answer are delivered in the same turn; the silent host gets one attempt and its other two deliveries wait");
    eq(r.sent.filter((s) => s.url.includes("tarpit")).length, 1, "one request to the silent host this turn");
    const q = r.stored().queue;
    eq([q.length, q.filter((x) => x.tries === 1 && x.next === r.clock.t + RETRY_DELAYS_MS[0]).length, q.filter((x) => x.tries === 0).length], [3, 1, 2], "the failed attempt backs off on its own subscription's schedule; the two not tried are not charged a try");
    // Next turn: a new receiver and the five that answer are all delivered at once, whatever the silent host does.
    await r.pw.register({ url: "https://late.buyer.test/h" }, { known: KNOWN });
    await r.change("search");
    const before = r.sent.length, t1 = Date.now();
    const turn2 = await r.pw.deliverDue();
    ok(turn2.delivered === 6 && Date.now() - t1 < 1_000 && r.sent.slice(before).filter((s) => s.url.includes("tarpit")).length === 1, `in the next turn every receiver that answers is delivered, and the silent host again costs one short attempt (${JSON.stringify(turn2)})`);
    const subs = Object.values(r.stored().subs);
    ok(subs.filter((x) => x.miss >= 1).length === 2 && subs.filter((x) => x.host !== "tarpit.buyer.test").every((x) => x.miss === undefined), "a subscription keeps the count of its attempts that got no 2xx until one does");
  }
  {
    // A turn never runs beside itself in one process.
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const r = rig({ responder: async () => { await gate; return { status: 200 }; } });
    await r.pw.register({ url: "https://a.buyer.test/h" }, { known: KNOWN });
    await r.change("search");
    const first = r.pw.deliverDue();
    await sleep(20);
    const second = await r.pw.deliverDue();
    eq(second, { skipped: "turn-running" }, "a second turn that starts while one is under way does nothing");
    release();
    eq([(await first).delivered, r.sent.length], [1, 1], "so the delivery is sent once");
    eq((await r.pw.deliverDue()).sent, 0, "and a turn after it ended runs again (nothing left to send)");
  }
  {
    // Order: what has not failed first; one per registrant before anyone's second.
    const r = rig({ responder: (url) => ({ status: url.includes("down") ? 500 : 200 }) });
    const A = "payer:0x00000000000000000000000000000000000000aa", B = "payer:0x00000000000000000000000000000000000000bb";
    await r.pw.register({ url: "https://down.buyer.test/h" }, { known: KNOWN, registrant: "payer:0x00000000000000000000000000000000000000dd" });
    await r.change("search");
    await r.pw.deliverDue(); // the down receiver has now failed once
    r.clock.t += RETRY_DELAYS_MS[0];
    for (let i = 0; i < 3; i++) await r.pw.register({ url: `https://a${i}.buyer.test/h` }, { known: KNOWN, registrant: A });
    await r.pw.register({ url: "https://b0.buyer.test/h" }, { known: KNOWN, registrant: B });
    await r.change("search");
    r.sent.length = 0;
    await r.pw.deliverDue();
    eq(r.sent.map((s) => new URL(s.url).host.split(".")[0]), ["a0", "b0", "a1", "a2", "down"], "a registrant's second delivery waits for every other registrant's first, and a delivery that failed goes last");
  }
  {
    // One answering host gets HOST_TURN_MS of a turn; the rest of its deliveries wait for the next.
    const slowHost = rig({ responder: () => { slowHost.clock.t += 3_000; return { status: 200 }; } });
    for (let i = 0; i < 6; i++) await slowHost.pw.register({ url: `https://busy.buyer.test/h${i}` }, { known: KNOWN });
    await slowHost.change("search");
    const turn = await slowHost.pw.deliverDue();
    eq([turn.delivered, turn.waiting], [3, 3], "a host whose answers take 3 s each gets three deliveries in a turn (its 8 s) and the other three wait");
    eq((await slowHost.pw.deliverDue()).delivered, 3, "and get theirs in the next");
    // A turn starts nothing after its budget.
    const many = rig({ responder: () => { many.clock.t += 5_000; return { status: 200 }; } });
    for (let i = 0; i < DELIVERY_LANES + 4; i++) await many.pw.register({ url: `https://m${i}.buyer.test/h` }, { known: KNOWN });
    await many.change("search");
    const long = await many.pw.deliverDue();
    eq([long.delivered, long.waiting], [DELIVERY_LANES, 4], `a turn that has used its 40 s starts no further attempt: ${DELIVERY_LANES} hosts are sent to and 4 wait`);
    eq((await many.pw.deliverDue()).delivered, 4, "for the next turn");
  }

  // ---- Part 2: the real guard ------------------------------------------------------
  {
    // Registration with the real URL check: private and loopback literals are refused, with nothing stored.
    const file = join(dir, "guard.json");
    const real = createPriceWebhooks({ doc: createJsonDocument({ name: null, file, log: () => {} }), env: { PRICE_WEBHOOK_SIGNING_KEY: KEY }, baseUrl: () => "https://tools.test", log: () => {} });
    for (const u of ["https://127.0.0.1/hook", "https://10.0.0.5/hook", "https://192.168.1.10/hook", "https://169.254.169.254/latest/meta-data", "https://[::1]/hook"]) {
      await refuses(() => real.register({ url: u }, { known: KNOWN }), 400, /private address|resolve/i, `${u} is refused`);
    }
    let stored = null; try { stored = JSON.parse(readFileSync(file, "utf8")); } catch { /* never written */ }
    eq(stored, null, "and nothing is stored");

    // Delivery with the real sender: a stored loopback target is never connected to.
    let connections = 0;
    const listener = createServer((sock) => { connections++; sock.destroy(); });
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const port = listener.address().port;
    // Control: the listener does count a connection.
    await new Promise((r) => { const c = connect(port, "127.0.0.1", () => { c.end(); }); c.on("close", r); c.on("error", r); });
    for (let i = 0; i < 40 && connections < 1; i++) await new Promise((r) => setTimeout(r, 25));
    eq(connections, 1, "control: the loopback listener counts a connection");
    const id = `pw_${"a".repeat(32)}`;
    writeFileSync(file, JSON.stringify({ v: 1, subs: { [id]: { url: `https://127.0.0.1:${port}/hook`, host: "127.0.0.1", slugs: null, at: 1 } }, prices: { search: "$0.01" }, queue: [] }));
    await real.notePrices({ search: "$0.02" });
    const out = await real.deliverDue();
    eq([out.sent, out.delivered, out.retried], [1, 0, 1], "the delivery to a loopback target fails");
    await new Promise((r) => setTimeout(r, 100));
    eq(connections, 1, "and no connection reaches the loopback listener");
    await new Promise((r) => listener.close(r));
  }

  // ---- Part 3: the served tool -------------------------------------------------------
  {
    ok(hasLastingEffect(PRICE_WEBHOOK_SLUG), "the slug is in the lasting-effect list");
    const def = PRICE_WEBHOOK_TOOLS[0];
    ok(def.slug === PRICE_WEBHOOK_SLUG && def.route === "POST /api/price-webhook" && isDocumentationHost(new URL(def.discovery.input.url).hostname), "the published example names a documentation host");
    ok(!/\$\d/.test(def.description) && !def.description.includes("—"), "the description types no price and no em dash");
  }
  const seeded = join(dir, "seeded.json");
  const watcher = `pw_${"b".repeat(32)}`, other = `pw_${"c".repeat(32)}`;
  writeFileSync(seeded, JSON.stringify({ v: 1, subs: {
    [watcher]: { url: "https://hooks.watcher.test/h", host: "hooks.watcher.test", slugs: ["hash"], at: 1 },
    [other]: { url: "https://hooks.other.test/h", host: "hooks.other.test", slugs: ["uuid"], at: 1 },
  }, prices: { hash: "$9.99", uuid: "$0.001" }, queue: [] }));
  const srv = await bootServer({ stores: "price-webhooks", env: { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", POW_SECRET: "a-pow-secret-for-the-test", PRICE_WEBHOOK_SIGNING_KEY: "", PRICE_WEBHOOKS_FILE: seeded, PRICE_WEBHOOK_DELIVERIES: "off", PRICE_WEBHOOK_MAX_PER_PAYER: "2", BASE_URL: "" } });
  try {
    const post = async (path, body) => { const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
    const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
    const row = (pricing.endpoints || []).find((e) => e.slug === PRICE_WEBHOOK_SLUG);
    ok(row && row.method === "POST" && row.path === "/api/price-webhook" && row.price === PRICE_WEBHOOK_TOOLS[0].price, "the catalog lists the tool at its list price");
    const hashRow = (pricing.endpoints || []).find((e) => e.slug === "hash");
    // The boot compared the kept prices with the catalog's: hash differs, uuid does not.
    let body = null;
    for (let i = 0; i < 80; i++) { try { body = JSON.parse(readFileSync(seeded, "utf8")); } catch { body = null; } if (body?.prices?.hash === hashRow.price) break; await new Promise((r) => setTimeout(r, 250)); }
    eq(body?.prices?.hash, hashRow.price, "the boot kept the catalog's price in place of the old one");
    ok(Object.keys(body.prices).length > 100 && body.prices[PRICE_WEBHOOK_SLUG] === row.price, "every catalog tool's list price is kept");
    eq(body.queue.map((q) => [q.sub, changesOf(body, q, body.subs[q.sub])]), [[watcher, [{ slug: "hash", from: "$9.99", to: hashRow.price }]]], "one delivery is queued, for the subscription that watches the changed slug");
    ok(Number.isFinite(body.subs[watcher].exp) && body.subs[watcher].exp > Date.now() + 89 * DAY, "a subscription stored with no expiry gets one lifetime from this build's first store write");
    eq(body.queue[0].tries, 0, "and with deliveries switched off it waits unsent");

    // The published example answers in full and stores nothing.
    const ex = await post("/api/price-webhook", PRICE_WEBHOOK_TOOLS[0].discovery.input);
    eq(ex.status, 200, "the published example answers 200");
    ok(/^pw_[0-9a-f]{32}$/.test(ex.json.id) && /^a402whsec_[0-9a-f]{64}$/.test(ex.json.secret) && ex.json.registered === false && ex.json.unsubscribe.url.endsWith(UNSUBSCRIBE_PATH), "with an id, a secret and the removal route");
    eq(Object.keys(ex.json).sort(), Object.keys(PRICE_WEBHOOK_TOOLS[0].discovery.output.example).sort(), "and the fields its documented answer shows");
    eq(Object.keys(JSON.parse(readFileSync(seeded, "utf8")).subs).sort(), [watcher, other].sort(), "nothing is stored for the example");
    // A registration over HTTP is kept once its response has ended. FREE_MODE
    // verifies no payment, so there is no payer: the client address is the
    // registrant, held to the same cap (two here).
    const reg1 = await post("/api/price-webhook", { url: "https://8.8.8.8/hooks/one", slugs: ["hash"] });
    eq([reg1.status, reg1.json?.registered, typeof reg1.json?.expiresAt], [200, true, "string"], "a registration of a public target answers 200 with its expiry");
    let kept = null;
    for (let i = 0; i < 80; i++) { kept = JSON.parse(readFileSync(seeded, "utf8")).subs[reg1.json.id]; if (kept && !kept.pending) break; await sleep(50); }
    ok(kept && kept.pending === undefined && kept.url === "https://8.8.8.8/hooks/one" && /^o_[0-9a-f]{32}$/.test(kept.owner) && !/127\.0\.0\.1|::1|ip:/.test(JSON.stringify(kept)), `it is kept, confirmed, once its response ended, under a digest of the registrant (${JSON.stringify(kept)})`);
    const reg2 = await post("/api/price-webhook", { url: "https://8.8.8.8/hooks/two" });
    const reg3 = await post("/api/price-webhook", { url: "https://8.8.8.8/hooks/three" });
    eq([reg2.status, reg3.status], [200, 409], "FREE_MODE: the client address is the registrant, and its third registration past the cap of two is a 409");
    ok(/already holds 2 price webhooks/.test(reg3.json?.error || ""), `that says it is the caller's own (${String(reg3.json?.error).slice(0, 80)})`);
    for (const reg of [reg1, reg2]) eq((await post(UNSUBSCRIBE_PATH, { id: reg.json.id, secret: reg.json.secret })).status, 200, "and each is removed with its secret");
    // Input refusals reach the caller as 400s.
    eq((await post("/api/price-webhook", { url: "http://hooks.buyer.test/a" })).status, 400, "an http target is a 400");
    eq((await post("/api/price-webhook", { url: "https://127.0.0.1/hook" })).status, 400, "a loopback target is a 400");
    eq((await post("/api/price-webhook", { url: "https://example.com/h", slugs: ["no-such-tool-here"] })).status, 400, "an unknown slug is a 400");
    eq((await post("/api/price-webhook", {})).status, 400, "no url is a 400");
    // The removal route.
    eq((await post(UNSUBSCRIBE_PATH, { id: "nope" })).status, 400, "removal: a malformed id is a 400");
    const wrong = await post(UNSUBSCRIBE_PATH, { id: watcher, secret: `a402whsec_${"0".repeat(64)}` });
    eq([wrong.status, wrong.json.removed], [404, false], "removal: a wrong secret is a 404");
    const right = await post(UNSUBSCRIBE_PATH, { id: watcher, secret: secretFor("a-pow-secret-for-the-test", watcher) });
    eq([right.status, right.json], [200, { removed: true }], "removal: the right secret removes it");
    body = JSON.parse(readFileSync(seeded, "utf8"));
    ok(!body.subs[watcher] && body.subs[other] && body.queue.length === 0 && Object.keys(body.sets).length === 0, "the subscription, its queued delivery and the change set nothing names any more are gone");
  } finally { await srv.stop(); }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\nprice webhooks: ${pass} passed`);
