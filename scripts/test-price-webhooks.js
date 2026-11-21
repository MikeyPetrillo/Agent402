#!/usr/bin/env node
// Price webhooks (src/price-webhooks.js, POST /api/price-webhook, the free
// POST /api/price-webhook/unsubscribe).
//
// Part 1 (in process) drives the store with an injected clock, sender and URL
// check: the input rules, the bounds, the price comparison, one queued
// delivery per subscription, the signature, the retry schedule, the 410
// removal, the delivery switch, and that nothing is stored for a
// documentation host or without a signing key.
// Part 2 uses the real fetch guard: a private target is refused at
// registration and a stored one is never connected to (a listener on
// loopback counts connections, with a control connection that it does count).
// Part 3 boots a FREE_MODE server on port 0: the catalog entry, its published
// example, the removal route, and a boot whose kept prices differ from the
// catalog's queues one delivery for the subscription that watches the slug.
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
  createPriceWebhooks, parseTarget, parseSlugs, priceChanges, secretFor, signatureFor, verifySignature, isDocumentationHost,
  RETRY_DELAYS_MS, MAX_SLUGS, MAX_URL_CHARS, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER, EVENT_PRICE_CHANGED, UNSUBSCRIBE_PATH, PRICE_WEBHOOK_SLUG,
} from "../src/price-webhooks.js";
import { hasLastingEffect } from "../src/lasting-effect-slugs.js";
import { PRICE_WEBHOOK_TOOLS } from "../src/tools/price-webhook-kit.js";

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
function rig({ env = { PRICE_WEBHOOK_SIGNING_KEY: KEY }, responder = () => ({ status: 200 }), checkUrl = async () => {}, deliveriesOn = () => true } = {}) {
  const file = join(dir, `store-${++fileN}.json`);
  const clock = { t: Date.UTC(2026, 10, 21, 12) };
  const sent = [];
  const checked = [];
  const pw = createPriceWebhooks({
    doc: createJsonDocument({ name: null, file, log: () => {} }),
    now: () => clock.t, env, baseUrl: () => "https://tools.test",
    checkUrl: async (u) => { checked.push(u); return checkUrl(u); },
    send: async (url, init) => { sent.push({ url, ...init }); const r = await responder(url, init, sent.length); if (r instanceof Error) throw r; return r; },
    deliveriesOn, log: () => {},
  });
  const stored = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
  return { pw, clock, sent, checked, stored, file };
}

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
    ok(/^whsec_[0-9a-f]{64}$/.test(doc.secret) && doc.registered === false && r.stored() === null, "no signing key: the documentation host answer has every field and stores nothing");
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
    eq(body.subs[reg.id], { url: "https://hooks.buyer.test/a", host: "hooks.buyer.test", slugs: ["search"], at: r.clock.t }, "the stored record is the URL, host, slugs and time");
    ok(!JSON.stringify(body).includes("whsec_") && !JSON.stringify(body).includes(KEY), "no secret and no key is stored");
    // A refused URL check stores nothing.
    const bad = rig({ checkUrl: async () => { throw Object.assign(new Error("URL host could not be resolved, or resolves to a private address"), { statusCode: 400 }); } });
    await refuses(() => bad.pw.register({ url: "https://hooks.private.test/a" }, { known: KNOWN }), 400, /private address/, "a target the guard refuses is a 400");
    eq(bad.stored(), null, "and nothing is stored");

    // Removal: the wrong secret and an unknown id read the same; the right one removes.
    eq(await r.pw.unsubscribe({ id: reg.id, secret: `whsec_${"0".repeat(64)}` }), { removed: false }, "a wrong secret removes nothing");
    eq(await r.pw.unsubscribe({ id: `pw_${"0".repeat(32)}`, secret: secretFor(KEY, `pw_${"0".repeat(32)}`) }), { removed: false }, "an unknown id removes nothing");
    ok(r.stored().subs[reg.id], "the subscription is still there");
    await refuses(() => r.pw.unsubscribe({ id: "nope", secret: "x" }), 400, /id/, "a malformed id is a 400");
    await refuses(() => r.pw.unsubscribe({ id: reg.id }), 400, /secret/, "a missing secret is a 400");
    eq(await r.pw.unsubscribe({ id: reg.id, secret: reg.secret }), { removed: true }, "the right secret removes it");
    eq(Object.keys(r.stored().subs), [], "and it is gone");
  }
  {
    // Bounds: per host, then service-wide.
    const r = rig({ env: { PRICE_WEBHOOK_SIGNING_KEY: KEY, PRICE_WEBHOOK_MAX_PER_HOST: "2", PRICE_WEBHOOK_MAX: "3" } });
    await r.pw.register({ url: "https://one.buyer.test/a" }, { known: KNOWN });
    await r.pw.register({ url: "https://one.buyer.test/b" }, { known: KNOWN });
    await refuses(() => r.pw.register({ url: "https://one.buyer.test/c" }, { known: KNOWN }), 409, /already has 2/, "a third registration for one host is a 409");
    await r.pw.register({ url: "https://two.buyer.test/a" }, { known: KNOWN });
    await refuses(() => r.pw.register({ url: "https://three.buyer.test/a" }, { known: KNOWN }), 503, /as many/, "past the service-wide bound is a 503");
    eq(Object.keys(r.stored().subs).length, 3, "three are stored");
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
    eq(q[0].changes, [{ slug: "search", from: "$0.01", to: "$0.02" }], "the change names the slug and both prices");
    // A second change before the delivery joins the one waiting; a price that returns is dropped.
    await r.pw.notePrices({ search: "$0.03", hash: "$0.002", uuid: "$0.001" });
    q = r.stored().queue;
    eq(q.length, 3, "still one queued delivery per subscription");
    eq(q.find((x) => x.sub === search.id).changes, [{ slug: "search", from: "$0.01", to: "$0.03" }], "the waiting change keeps its first price and takes the latest");
    eq(q.find((x) => x.sub === all.id).changes.map((c) => c.slug).sort(), ["hash", "search"], "the watch-all delivery carries both changes");
    await r.pw.notePrices({ search: "$0.01", hash: "$0.002", uuid: "$0.001" });
    q = r.stored().queue;
    ok(!q.some((x) => x.sub === search.id), "a price back at its first value leaves nothing to announce");
    eq(q.find((x) => x.sub === hash.id).changes, [{ slug: "hash", from: "$0.001", to: "$0.002" }], "the other change still waits");
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
    eq(reg.secret, `whsec_${createHmac("sha256", KEY).update(`price-webhook-secret|${reg.id}`).digest("hex")}`, "the secret is the keyed digest of the subscription id");
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
  const srv = await bootServer({ stores: "price-webhooks", env: { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", POW_SECRET: "a-pow-secret-for-the-test", PRICE_WEBHOOK_SIGNING_KEY: "", PRICE_WEBHOOKS_FILE: seeded, PRICE_WEBHOOK_DELIVERIES: "off", BASE_URL: "" } });
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
    eq(body.queue.map((q) => [q.sub, q.changes]), [[watcher, [{ slug: "hash", from: "$9.99", to: hashRow.price }]]], "one delivery is queued, for the subscription that watches the changed slug");
    eq(body.queue[0].tries, 0, "and with deliveries switched off it waits unsent");

    // The published example answers in full and stores nothing.
    const ex = await post("/api/price-webhook", PRICE_WEBHOOK_TOOLS[0].discovery.input);
    eq(ex.status, 200, "the published example answers 200");
    ok(/^pw_[0-9a-f]{32}$/.test(ex.json.id) && /^whsec_[0-9a-f]{64}$/.test(ex.json.secret) && ex.json.registered === false && ex.json.unsubscribe.url.endsWith(UNSUBSCRIBE_PATH), "with an id, a secret and the removal route");
    eq(Object.keys(ex.json).sort(), Object.keys(PRICE_WEBHOOK_TOOLS[0].discovery.output.example).sort(), "and the fields its documented answer shows");
    eq(Object.keys(JSON.parse(readFileSync(seeded, "utf8")).subs).sort(), [watcher, other].sort(), "nothing is stored for the example");
    // Input refusals reach the caller as 400s.
    eq((await post("/api/price-webhook", { url: "http://hooks.buyer.test/a" })).status, 400, "an http target is a 400");
    eq((await post("/api/price-webhook", { url: "https://127.0.0.1/hook" })).status, 400, "a loopback target is a 400");
    eq((await post("/api/price-webhook", { url: "https://example.com/h", slugs: ["no-such-tool-here"] })).status, 400, "an unknown slug is a 400");
    eq((await post("/api/price-webhook", {})).status, 400, "no url is a 400");
    // The removal route.
    eq((await post(UNSUBSCRIBE_PATH, { id: "nope" })).status, 400, "removal: a malformed id is a 400");
    const wrong = await post(UNSUBSCRIBE_PATH, { id: watcher, secret: `whsec_${"0".repeat(64)}` });
    eq([wrong.status, wrong.json.removed], [404, false], "removal: a wrong secret is a 404");
    const right = await post(UNSUBSCRIBE_PATH, { id: watcher, secret: secretFor("a-pow-secret-for-the-test", watcher) });
    eq([right.status, right.json], [200, { removed: true }], "removal: the right secret removes it");
    body = JSON.parse(readFileSync(seeded, "utf8"));
    ok(!body.subs[watcher] && body.subs[other] && body.queue.length === 0, "the subscription and its queued delivery are gone");
  } finally { await srv.stop(); }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\nprice webhooks: ${pass} passed`);
