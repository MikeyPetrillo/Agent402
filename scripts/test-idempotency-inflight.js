// Idempotency in-flight guard, driven through the real middleware in the order
// src/server.js mounts it: the credits gate, then createIdempotency, then the
// handler. A prepaid credits key is reusable, so before the guard two copies of
// one keyed call sent while the first was still running both ran and were both
// debited. Proves: the overlapping copy gets 409 and is not charged, the first
// is debited once, a retry after it finishes replays without a second debit,
// and calls with no key, a different key or a different body are untouched.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredits } from "../src/credits.js";
import { createIdempotency, implicitReplayAllowed } from "../src/idempotency.js";
import { paymentNonceIdentityOf } from "../src/payer.js";
import { hasLastingEffect } from "../src/hangup-forgiveness.js";

let pass = 0, fail = 0;
// A regression here tends to hang (a duplicate that reaches the handler parks on the
// held first call), so a stuck run fails loudly instead of stalling the lane.
setTimeout(() => { console.log("NOT OK - timed out: a keyed duplicate reached the handler or never finished"); process.exit(1); }, 15000).unref();
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const DIR = mkdtempSync(join(tmpdir(), "test-idem-inflight-"));
const sessions = { cs_paid: { id: "cs_paid", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "c@x.com" }, metadata: { credits_pack: "credits-20" } } };
const stripe = { checkout: { sessions: { create: async () => ({ id: "x", url: "https://example.test" }), retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("no"); return s; } } } };
const debits = [];
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, onDebit: (d) => debits.push(d), onLoad: () => {}, log: () => {} });
const KEY = (await cr.claim("cs_paid")).key;

const PRICE = 0.01;
let runs = 0;
let failNext = false;
let releaseFirst;
const app = express();
app.use(express.json());
app.use(cr.gate((method, path) => (path === "/api/slow" ? { priceUsd: PRICE, slug: "slow" } : null)));
app.use(createIdempotency({ isCatalogRoute: (req) => req.path === "/api/slow", freeMode: false }));
app.post("/api/slow", async (req, res) => {
  runs++;
  if (req.body?.hold) await new Promise((r) => { releaseFirst = r; });
  if (failNext) { failNext = false; return res.status(500).json({ error: "boom" }); }
  res.json({ echo: req.body?.text ?? null, run: runs });
});
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
const call = (body, idem) => fetch(`${B}/api/slow`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...(idem ? { "idempotency-key": idem } : {}) },
  body: JSON.stringify(body),
});
const spent = () => cr.balance(KEY).spentUsd;
const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

try {
  // 1. The first keyed call is still running when its copy arrives.
  const first = call({ text: "a", hold: true }, "k-1");
  await waitFor(() => typeof releaseFirst === "function");
  const dup = await call({ text: "a", hold: true }, "k-1");
  const dupBody = await dup.json();
  ok(dup.status === 409 && dupBody.error === "idempotent_request_in_flight" && dup.headers.get("retry-after") === "2",
    `an overlapping copy of a running keyed call gets 409 in_flight with Retry-After (got ${dup.status})`);
  ok(runs === 1, `the copy never reached the handler (runs ${runs})`);
  releaseFirst();
  const firstRes = await first;
  ok(firstRes.status === 200 && (await firstRes.json()).echo === "a", "the first call completes with its answer");
  await waitFor(() => debits.length >= 1);
  ok(debits.length === 1 && Math.abs(spent() - PRICE) < 1e-9, `one debit for the pair, not two (debits ${debits.length}, spent ${spent()})`);

  // 2. A retry after the first finished replays its answer without a debit.
  const retry = await call({ text: "a", hold: true }, "k-1");
  ok(retry.status === 200 && retry.headers.get("x-idempotent-replay") === "true" && (await retry.json()).run === 1,
    "a retry after the first finished replays the stored answer");
  await new Promise((r) => setTimeout(r, 20));
  ok(debits.length === 1 && runs === 1, `the replay was not debited and did not run (debits ${debits.length}, runs ${runs})`);

  // 3. The guard is scoped to key + credential + body: other calls run normally.
  const diffBody = await call({ text: "b" }, "k-1");
  ok(diffBody.status === 200 && (await diffBody.json()).echo === "b", "same key with a different body is a new call, not refused");
  const noKey = await call({ text: "a" }, null);
  ok(noKey.status === 200, "a call with no Idempotency-Key is unaffected");
  await waitFor(() => debits.length >= 3);
  ok(debits.length === 3 && runs === 3, `each distinct call ran and was debited once (debits ${debits.length}, runs ${runs})`);

  // 4. A call that fails (non-200) clears its mark and is not debited; the retry runs.
  failNext = true;
  const failed = await call({ text: "c" }, "k-2");
  ok(failed.status === 500, `a failing keyed call answers its error (got ${failed.status})`);
  const again = await call({ text: "c" }, "k-2");
  ok(again.status === 200 && again.headers.get("x-idempotent-replay") !== "true", `a retry after a failed call runs fresh, not 409 or a replay (got ${again.status})`);
  await waitFor(() => debits.length >= 4);
  ok(debits.length === 4, `the failed call was not debited, its retry was (debits ${debits.length})`);
} finally {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
}

// 5. The implicit key: which routes may replay a re-sent payment, and the
// identity a payment header yields (src/idempotency.js, src/payer.js).
{
  const bound = (d) => d.identityBound === true;
  const allow = (slug, body = {}, extra = {}) => implicitReplayAllowed({ slug, ...extra }, { body }, { hasLastingEffect, isIdentityBound: bound });
  ok(allow("hash") === true, "a plain tool replays a re-sent payment");
  ok(allow("route-execute") === false, "a route whose effect outlives the answer never replays implicitly (not identity-bound)");
  ok(allow("hash", {}, { identityBound: true }) === false, "an identity-bound route never replays implicitly");
  ok(allow("hash", { stream: true }) === false, "a streamed call never replays implicitly");
  ok(implicitReplayAllowed(undefined, { body: {} }, { hasLastingEffect, isIdentityBound: bound }) === false, "no catalog entry: no implicit key");

  const FROM = "0x1111111111111111111111111111111111111111";
  const reqOf = (payload) => { const h = Buffer.from(JSON.stringify(payload)).toString("base64"); return { header: (n) => (n === "payment-signature" ? h : undefined), headers: {} }; };
  const N1 = `0x${"ab".repeat(32)}`, N2 = `0x${"cd".repeat(32)}`;
  const v2 = { x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x00", authorization: { from: FROM, nonce: `0x${"AB".repeat(32)}` } } };
  const id = paymentNonceIdentityOf(reqOf(v2));
  ok(id && id.network === "eip155:8453" && id.from === FROM && id.nonce === N1, `an EIP-3009 payment's identity: network from accepted, signed payer, nonce lower case (${JSON.stringify(id)})`);
  const p2 = { x402Version: 2, accepted: { scheme: "upto", network: "eip155:8453" }, payload: { signature: "0x00", permit2Authorization: { from: FROM, nonce: N2 }, authorization: { from: FROM, nonce: N1 } } };
  ok(paymentNonceIdentityOf(reqOf(p2))?.nonce === N2, "a Permit2 payment's identity is its Permit2 nonce, never the unsigned authorization block beside it");
  const noNet = { ...v2, accepted: { scheme: "exact", network: "" } };
  ok(paymentNonceIdentityOf(reqOf(noNet)) === null, "an empty network yields no identity");
  const unsigned = { ...p2, payload: { ...p2.payload, permit2Authorization: { nonce: N2 } } };
  ok(paymentNonceIdentityOf(reqOf(unsigned)) === null, "no signed payer: no identity");
}

// 6. An implicit key's overlapping copy is told to resend the same payment.
{
  let release;
  const app2 = express();
  app2.use(express.json());
  app2.use(createIdempotency({ isCatalogRoute: (req) => req.path === "/api/hold", freeMode: false, implicitReplay: () => true }));
  app2.post("/api/hold", async (req, res) => { await new Promise((r) => { release = r; }); res.json({ ok: true }); });
  const s2 = app2.listen(0);
  await new Promise((r) => s2.once("listening", r));
  const B2 = `http://127.0.0.1:${s2.address().port}`;
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x00", authorization: { from: "0x1111111111111111111111111111111111111111", nonce: `0x${"ef".repeat(32)}` } } })).toString("base64");
  const send = () => fetch(`${B2}/api/hold`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": hdr }, body: "{}" });
  try {
    const first = send();
    await waitFor(() => typeof release === "function");
    const dup = await send();
    const body = await dup.json();
    ok(dup.status === 409 && /same signed payment/.test(body.hint || "") && !/Idempotency-Key/.test(body.hint || ""), `an implicit copy's 409 names the payment, not a key it never sent (${body.hint})`);
    release();
    await first;
  } finally { s2.close(); }
}

// 7. A client that times out (closes its socket) while its keyed call is still
// running, then retries with the same key: the claim is held until the RUN
// ends, not until the socket closes. Mounted as the server mounts it: the
// hang-up hook, the credits gate, then idempotency. The retry during the run
// gets 409 (no second run, no second debit); once the run ends, the abandoned
// answer was committed under its booked hang-up debt and the next retry
// replays it.
{
  const DIR7 = mkdtempSync(join(tmpdir(), "test-idem-close-"));
  const debits7 = [];
  const cr7 = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR7, onDebit: (d) => debits7.push(d), onLoad: () => {}, log: () => {} });
  const KEY7 = (await cr7.claim("cs_paid")).key;
  const { createHangupSettlementHook } = await import("../src/hangup-settlement.js");
  let runs7 = 0, open = false;
  const waiting = [];
  const app7 = express();
  app7.use(express.json());
  // What server.js recordHangupDebt does for a credits hold debited on close.
  app7.use(createHangupSettlementHook({ onUndelivered: (req) => {
    if (req.creditsSettled && Number(req.creditsChargedOnClose) > 0) req.__a402HangupDebt = { tx: `credits-hangup:${runs7}`, network: "credits", wire: "credits" };
  } }));
  app7.use(cr7.gate((method, path) => (path === "/api/slow" ? { priceUsd: PRICE, slug: "slow" } : null)));
  app7.use(createIdempotency({ isCatalogRoute: (req) => req.path === "/api/slow", freeMode: false }));
  app7.post("/api/slow", async (req, res) => { const n = ++runs7; if (!open) await new Promise((r) => waiting.push(r)); res.json({ run: n }); });
  const s7 = app7.listen(0);
  await new Promise((r) => s7.once("listening", r));
  const U = `http://127.0.0.1:${s7.address().port}/api/slow`;
  const hdr = { "content-type": "application/json", authorization: `Bearer ${KEY7}`, "idempotency-key": "k-close" };
  try {
    const ac = new AbortController();
    const first = fetch(U, { method: "POST", headers: hdr, body: "{}", signal: ac.signal }).then((r) => r.status, () => "aborted");
    await waitFor(() => waiting.length === 1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 50)); // the server has seen the close
    const during = await fetch(U, { method: "POST", headers: hdr, body: "{}" });
    ok(during.status === 409 && (await during.json()).error === "idempotent_request_in_flight", `a retry after the client closed, while the run still goes, gets 409 in_flight (got ${during.status})`);
    ok(runs7 === 1, `the retry never reached the handler (runs ${runs7})`);
    open = true; waiting.forEach((r) => r());
    ok((await first) === "aborted", "the first client had left");
    await waitFor(() => debits7.length >= 1);
    await new Promise((r) => setTimeout(r, 30)); // the claim is released after the commit lands
    const after = await fetch(U, { method: "POST", headers: hdr, body: "{}" });
    const afterBody = await after.json();
    ok(after.status === 200 && after.headers.get("x-idempotent-replay") === "true" && afterBody.run === 1, `a retry after the run replays its answer (status ${after.status}, replay ${after.headers.get("x-idempotent-replay")}, run ${afterBody.run})`);
    await new Promise((r) => setTimeout(r, 30));
    ok(runs7 === 1 && debits7.length === 1, `one run and one debit for the whole sequence (runs ${runs7}, debits ${debits7.length})`);
  } finally { s7.close(); rmSync(DIR7, { recursive: true, force: true }); }
}

// 8. A resend of a charged-but-undelivered answer: its debt's void decides.
// A void whose ledger write failed or is queued resolves false while the row
// still reads owed; the queued void lands later. Refusing that resend as
// refunded left the buyer neither served nor repaid, so it is asked to retry.
{
  const { chargedReplayVerdict } = await import("../src/idempotency.js");
  const v = (voidOnClaim, rowOf) => chargedReplayVerdict("0xtx", { voidOnClaim, rowOf });
  ok((await v(async () => true, async () => null)).verdict === "serve", "a void that landed serves");
  ok((await v(async () => false, async () => null)).verdict === "serve", "no debt row serves");
  ok((await v(async () => false, async () => ({ id: 1, status: "void" }))).verdict === "serve", "a row already void serves");
  ok((await v(async () => false, async () => ({ id: 1, status: "owed" }))).verdict === "pending", "a void that did not land on a row still owed is pending, not refunded");
  ok((await v(async () => { throw new Error("db"); }, async () => ({ id: 1, status: "owed" }))).verdict === "pending", "a void that threw on a row still owed is pending");
  ok((await v(async () => false, async () => ({ id: 1, status: "sending" }))).verdict === "refunded", "a row the refund run claimed is refunded");
  ok((await v(async () => false, async () => ({ id: 1, status: "paid" }))).verdict === "refunded", "a paid row is refunded");

  // The middleware carries a refusal's Retry-After.
  const store = { get: async () => ({ __a402Stored: 1, body: { ok: 1 }, charged: { tx: "0xtx" } }), claim: async () => true, renew: async () => true, release: async () => {}, set: async () => true };
  const app8 = express();
  app8.use(express.json());
  app8.use(createIdempotency({ isCatalogRoute: () => true, store, onReplay: async () => ({ serve: false, status: 503, retryAfter: 10, body: { error: "replay_pending" } }) }));
  app8.post("/api/x", (req, res) => res.json({ ran: true }));
  const s8 = app8.listen(0);
  await new Promise((r) => s8.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${s8.address().port}/api/x`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k", "x-pow-solution": "t:1" }, body: "{}" });
    const b = await r.json();
    ok(r.status === 503 && r.headers.get("retry-after") === "10" && b.error === "replay_pending", `a pending replay answers 503 with Retry-After (got ${r.status}, ${r.headers.get("retry-after")})`);
  } finally { s8.close(); }
}

// 9. The claim is released only after the run's answer is written: a store
// whose write is slow (a Redis round trip) must not leave a gap in which a
// retry finds neither the claim nor the answer and runs again.
{
  const { createLocalIdempotencyStore } = await import("../src/idempotency-store.js");
  const local = createLocalIdempotencyStore();
  const slow = { ...local, get: (k) => local.get(k), claim: (k) => local.claim(k), renew: (k) => local.renew(k), release: (k) => local.release(k),
    set: (k, b, n) => new Promise((r) => setTimeout(() => r(local.set(k, b, n)), 300)) };
  let runs9 = 0;
  const app9 = express();
  app9.use(express.json());
  app9.use(createIdempotency({ isCatalogRoute: () => true, freeMode: true, store: slow }));
  app9.post("/api/y", (req, res) => { runs9++; res.json({ run: runs9 }); });
  const s9 = app9.listen(0);
  await new Promise((r) => s9.once("listening", r));
  const send = () => fetch(`http://127.0.0.1:${s9.address().port}/api/y`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k9", "x-pow-solution": "t:9" }, body: "{}" });
  try {
    const a = await send(); await a.text();
    await new Promise((r) => setTimeout(r, 50)); // the run has ended; its write is still landing
    const b = await send(); await b.text();
    ok(runs9 === 1 && (b.status === 409 || b.headers.get("x-idempotent-replay") === "true"), `a retry while the answer is being written gets 409 or the answer, never a second run (status ${b.status}, runs ${runs9})`);
    await new Promise((r) => setTimeout(r, 400));
    const c = await send(); await c.text();
    ok(c.status === 200 && c.headers.get("x-idempotent-replay") === "true" && runs9 === 1, `once written, the retry replays it (status ${c.status}, runs ${runs9})`);
  } finally { s9.close(); local.stop(); }
}

// 10. An answer other than 200 is never stored, so its claim is released when
// the response is ended, not on "finish". "finish" waits for the socket write
// to complete; a client that resends the same payment as soon as a 402's
// headers arrive could land in between and be told the first call was still
// running. Here "finish" is held back until the check has been made, as a
// write that completes late holds it.
{
  const { createLocalIdempotencyStore } = await import("../src/idempotency-store.js");
  const local = createLocalIdempotencyStore();
  const released = [];
  const spy = { ...local, get: (k) => local.get(k), claim: (k) => local.claim(k), renew: (k) => local.renew(k), set: (k, b, n) => local.set(k, b, n),
    release: (k) => { released.push(k); return local.release(k); } };
  const seen = {};
  const app10 = express();
  app10.use(express.json());
  app10.use(createIdempotency({ isCatalogRoute: () => true, freeMode: true, store: spy }));
  app10.post("/api/z", async (req, res) => {
    const status = Number(req.body?.status) || 200;
    released.length = 0;
    let finished = false, heldFinish = null;
    const emit = res.emit;
    res.emit = function heldEmit(ev, ...args) {
      if (ev === "finish" && !heldFinish) { heldFinish = () => { finished = true; return emit.call(this, ev, ...args); }; return true; }
      return emit.call(this, ev, ...args);
    };
    res.status(status).json({ status });
    await new Promise((r) => setTimeout(r, 30));
    seen[status] = { released: released.length, finished };
    heldFinish?.();
  });
  const s10 = app10.listen(0);
  await new Promise((r) => s10.once("listening", r));
  const send = (status, key) => fetch(`http://127.0.0.1:${s10.address().port}/api/z`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, "x-pow-solution": `t:${key}` }, body: JSON.stringify({ status }) });
  try {
    await (await send(402, "k10a")).text();
    await waitFor(() => seen[402]);
    ok(seen[402] && seen[402].finished === false && seen[402].released === 1, `a 402's claim is released when it is ended, before "finish" (released ${seen[402]?.released}, finished ${seen[402]?.finished})`);
    await (await send(200, "k10b")).text();
    await waitFor(() => seen[200]);
    ok(seen[200] && seen[200].finished === false && seen[200].released === 0, `a 200 keeps its claim until "finish" commits it (released ${seen[200]?.released}, finished ${seen[200]?.finished})`);
  } finally { s10.close(); local.stop(); }
}

// 11. A credits buyer that leaves AFTER the first byte: the response went out
// in part, "finish" never comes, and the gate debits the 200 as the response
// ends. Mounted as the server mounts it (hang-up hook, credits gate,
// idempotency). The answer must be committed before the claim is let go, so a
// retry with the same key replays it: one run, one debit.
{
  const DIR11 = mkdtempSync(join(tmpdir(), "test-idem-after-headers-"));
  const debits11 = [];
  const cr11 = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR11, onDebit: (d) => debits11.push(d), onLoad: () => {}, log: () => {} });
  const KEY11 = (await cr11.claim("cs_paid")).key;
  const { createHangupSettlementHook } = await import("../src/hangup-settlement.js");
  let runs11 = 0;
  const app11 = express();
  app11.use(express.json());
  app11.use(createHangupSettlementHook({ onUndelivered: () => {} }));
  // /api/forgiven holds a granted hang-up ticket (src/hangup-forgiveness.js).
  app11.use((req, _res, next) => { if (req.path === "/api/forgiven") Object.defineProperty(req, "__a402HangupTicket", { value: { granted: true }, configurable: true }); next(); });
  const PATHS11 = new Set(["/api/big", "/api/cut", "/api/forgiven"]);
  app11.use(cr11.gate((method, path) => (PATHS11.has(path) ? { priceUsd: PRICE, slug: "big" } : null)));
  // The store's write takes a Redis-like round trip: the claim must outlast it.
  const { createLocalIdempotencyStore } = await import("../src/idempotency-store.js");
  const local11 = createLocalIdempotencyStore();
  const slow11 = { ...local11, get: (k) => local11.get(k), claim: (k) => local11.claim(k), renew: (k) => local11.renew(k), release: (k) => local11.release(k),
    set: (k, b, n) => new Promise((r) => setTimeout(() => r(local11.set(k, b, n)), 200)) };
  app11.use(createIdempotency({ isCatalogRoute: (req) => PATHS11.has(req.path), freeMode: false, store: slow11 }));
  // A buyer that leaves before the first byte with a granted ticket is not
  // charged: that answer is no receipt and must not be replayed.
  app11.post("/api/forgiven", (req, res) => { const n = ++runs11; res.once("close", () => setTimeout(() => res.json({ run: n }), 10)); });
  // /api/cut: the answer is ended on a live socket, then the socket closes
  // before its write completes (no "finish"), as a buyer that read the
  // headers and left does.
  app11.post("/api/cut", (req, res) => {
    const n = ++runs11;
    const emit = res.emit;
    res.emit = function noFinish(ev, ...args) { return ev === "finish" ? true : emit.call(this, ev, ...args); };
    res.json({ run: n });
    setImmediate(() => req.socket.destroy());
  });
  // /api/big: a real client that reads the headers of a large answer and
  // aborts while the body is still being written.
  app11.post("/api/big", (req, res) => { const n = ++runs11; res.json({ run: n, pad: "x".repeat(900 * 1024) }); });
  const s11 = app11.listen(0);
  await new Promise((r) => s11.once("listening", r));
  const base = `http://127.0.0.1:${s11.address().port}`;
  const hdr = (k) => ({ "content-type": "application/json", authorization: `Bearer ${KEY11}`, "idempotency-key": k });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  try {
    const first = await fetch(`${base}/api/cut`, { method: "POST", headers: hdr("k-cut"), body: "{}" }).then((r) => r.text().then(() => "read", () => "cut"), () => "cut");
    await waitFor(() => debits11.length >= 1); await settle();
    ok(debits11.length === 1, `the first call is debited once though its client left after headers (debits ${debits11.length}, first ${first})`);
    const soon = await fetch(`${base}/api/cut`, { method: "POST", headers: hdr("k-cut"), body: "{}" });
    await soon.text();
    ok(runs11 === 1 && (soon.status === 409 || soon.headers.get("x-idempotent-replay") === "true"), `a retry while the answer is still being written gets 409 or the answer, never a second run (status ${soon.status}, runs ${runs11})`);
    await new Promise((r) => setTimeout(r, 300));
    const retry = await fetch(`${base}/api/cut`, { method: "POST", headers: hdr("k-cut"), body: "{}" });
    const rb = await retry.json().catch(() => ({}));
    await settle();
    ok(retry.status === 200 && retry.headers.get("x-idempotent-replay") === "true" && rb.run === 1, `the retry with the same key replays the answer (status ${retry.status}, replay ${retry.headers.get("x-idempotent-replay")}, run ${rb.run})`);
    ok(runs11 === 1 && debits11.length === 1, `one run and one debit after a hang-up past the first byte (runs ${runs11}, debits ${debits11.length})`);

    const runs0 = runs11, debits0 = debits11.length;
    const ac = new AbortController();
    const r1 = await fetch(`${base}/api/big`, { method: "POST", headers: hdr("k-big"), body: "{}", signal: ac.signal });
    ac.abort();
    await r1.text().catch(() => {});
    await waitFor(() => debits11.length >= debits0 + 1); await new Promise((r) => setTimeout(r, 300));
    const r2 = await fetch(`${base}/api/big`, { method: "POST", headers: hdr("k-big"), body: "{}" });
    const b2 = await r2.json().catch(() => ({}));
    await settle();
    ok(r2.status === 200 && r2.headers.get("x-idempotent-replay") === "true" && b2.run === runs0 + 1 && runs11 === runs0 + 1 && debits11.length === debits0 + 1, `a real client aborting a large answer after its headers is debited once and its retry replays (status ${r2.status}, replay ${r2.headers.get("x-idempotent-replay")}, runs +${runs11 - runs0}, debits +${debits11.length - debits0})`);

    const runsF = runs11, debitsF = debits11.length;
    const acF = new AbortController();
    const f1 = fetch(`${base}/api/forgiven`, { method: "POST", headers: hdr("k-forgiven"), body: "{}", signal: acF.signal }).catch(() => "aborted");
    await waitFor(() => runs11 === runsF + 1);
    acF.abort(); await f1;
    await new Promise((r) => setTimeout(r, 300));
    ok(debits11.length === debitsF, `a buyer gone before the first byte with a granted ticket is not debited (debits +${debits11.length - debitsF})`);
    fetch(`${base}/api/forgiven`, { method: "POST", headers: hdr("k-forgiven"), body: "{}" }).catch(() => {});
    await waitFor(() => runs11 === runsF + 2);
    ok(runs11 === runsF + 2, `...and its retry runs fresh: the uncharged answer was not stored as a receipt (runs +${runs11 - runsF})`);
    acF.abort();
  } finally { s11.closeAllConnections?.(); s11.close(); local11.stop(); rmSync(DIR11, { recursive: true, force: true }); }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
