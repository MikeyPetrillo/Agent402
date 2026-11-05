#!/usr/bin/env node
// Offline tests for the Stripe SHADOW ledger (src/stripe-shadow-ledger.js).
//
// The thing under test is not "does it post to Stripe" - it is "can this
// feature ever hurt us". So the assertions are weighted toward the structural
// claims: OFF is inert, a failure is swallowed, a replay cannot mint a second
// PaymentIntent, a restart neither loses nor double-posts, and the caller's
// return value and status are byte-identical whether the shadow ledger
// succeeds, fails, or is disabled.
//
// No network, no real Stripe key, no /data. Fetch is injected; the store is a
// temp sqlite file per case.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createShadowLedger, shadowLedgerEnabled, exactCents, eligibility, paymentIntentForm,
  SHADOW_API_VERSION,
} from "../src/stripe-shadow-ledger.js";

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
  console.error(`  FAIL  ${label}`);
}
const eq = (a, b, label) => ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const dirs = [];
function tmpDb(name) {
  const d = mkdtempSync(join(tmpdir(), "a402-shadow-"));
  dirs.push(d);
  return join(d, `${name}.db`);
}
const ENV_ON = { STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "sk_test_shadow" };

/** A stubbed Stripe that records every call and replays by Idempotency-Key,
 *  exactly as the real API does - so "two calls, one PaymentIntent" is proven
 *  against a server that WOULD create a second one if we sent a second POST. */
function stubStripe({ status = 200, body = null, throwWith = null } = {}) {
  const calls = [];
  const byKey = new Map();
  let n = 0;
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (throwWith) throw throwWith;
    const key = init.headers["Idempotency-Key"];
    if (status === 200 && byKey.has(key)) {
      const replay = byKey.get(key);
      return { status: 200, json: async () => replay };
    }
    if (status === 200) {
      const pi = { id: `pi_stub_${++n}`, object: "payment_intent", status: "succeeded" };
      byKey.set(key, pi);
      return { status: 200, json: async () => pi };
    }
    return { status, json: async () => body };
  };
  return { impl, calls, created: () => byKey.size };
}

const SALE = {
  slug: "research-deep", priceUsd: 5, rail: "usdc", network: "base",
  tx: "0xaaa1111111111111111111111111111111111111111111111111111111111111", synthetic: false,
};

// ---------------------------------------------------------------------------
console.log("\n1. Rollout switch: OFF by default, and OFF means zero of everything");
{
  eq(shadowLedgerEnabled({}), false, "no env -> disabled");
  eq(shadowLedgerEnabled({ STRIPE_SECRET_KEY: "sk_x" }), false, "key alone -> disabled");
  eq(shadowLedgerEnabled({ STRIPE_SHADOW_LEDGER: "on" }), false, "switch alone -> disabled");
  eq(shadowLedgerEnabled({ STRIPE_SHADOW_LEDGER: "true", STRIPE_SECRET_KEY: "sk_x" }), false, "'true' is not 'on' - only an explicit on enables");
  eq(shadowLedgerEnabled({ STRIPE_SHADOW_LEDGER: "ON", STRIPE_SECRET_KEY: "sk_x" }), true, "case-insensitive 'on' + key -> enabled");

  const dbFile = tmpDb("off");
  const s = stubStripe();
  const led = createShadowLedger({ env: {}, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  eq(led.enabled, false, "disabled ledger reports enabled:false");
  eq(led.record(SALE), undefined, "record() returns undefined when disabled");
  await led.drain();
  eq(s.calls.length, 0, "disabled: ZERO fetch calls");
  eq(existsSync(dbFile), false, "disabled: no database file is created at all");
  eq(led.start(), false, "disabled: start() arms nothing");
  eq(led.report().enabled, false, "disabled report says so");
  ok(typeof led.report().reason === "string", "disabled report explains why");
}

// ---------------------------------------------------------------------------
console.log("\n2. Eligibility is decided locally, before any network call");
{
  eq(exactCents(5), 500, "$5 -> 500 cents");
  eq(exactCents(0.05), 5, "$0.05 -> 5 cents (no float drift)");
  eq(exactCents(0.01), 1, "$0.01 -> 1 cent (Stripe's stablecoin floor)");
  eq(exactCents(0.001), null, "$0.001 is sub-cent -> null, NEVER rounded up to 1c");
  eq(exactCents(0.005), null, "$0.005 is sub-cent -> null, never rounded to 1c");
  eq(exactCents(0), null, "$0 -> null");
  eq(exactCents("nope"), null, "junk -> null");

  eq(eligibility({ ...SALE }).ok, true, "$5 Base settlement is eligible");
  eq(eligibility({ ...SALE }).stripeNetwork, "base", "base maps to Stripe's 'base'");
  eq(eligibility({ ...SALE, network: "eip155:8453" }).stripeNetwork, "base", "raw CAIP-2 base maps too");
  eq(eligibility({ ...SALE, network: "tempo" }).stripeNetwork, "tempo", "tempo supported");
  eq(eligibility({ ...SALE, network: "solana" }).stripeNetwork, "solana", "solana supported");
  eq(eligibility({ ...SALE, network: "polygon" }).skip, "network-unsupported", "polygon is not a Stripe transaction_verification network");
  eq(eligibility({ ...SALE, network: "stellar" }).skip, "network-unsupported", "stellar unsupported");
  eq(eligibility({ ...SALE, network: "algorand" }).skip, "network-unsupported", "algorand unsupported");
  eq(eligibility({ ...SALE, priceUsd: 0.001 }).skip, "sub-cent-amount", "$0.001 skipped as sub-cent");
  eq(eligibility({ ...SALE, rail: "pow" }).skip, "rail-not-onchain", "free PoW call is not a settlement");
  eq(eligibility({ ...SALE, rail: "card" }).skip, "rail-not-onchain", "card sales are already in Stripe");
  eq(eligibility({ ...SALE, rail: "credits" }).skip, "rail-not-onchain", "credits debits are not on-chain");
  eq(eligibility({ ...SALE, synthetic: true }).skip, "internal", "our own canary/volume money is never posted");
  eq(eligibility({ ...SALE, tx: null }).skip, "no-tx", "no tx hash -> nothing to verify");
  eq(eligibility({ ...SALE, tx: "   " }).skip, "no-tx", "blank tx hash -> no-tx");
}

// ---------------------------------------------------------------------------
console.log("\n3. The wire shape matches Stripe's documented x402 sample");
{
  const f = paymentIntentForm({ cents: 500, stripeNetwork: "base", tx: SALE.tx, slug: "research-deep" });
  eq(f.get("amount"), "500", "amount is integer CENTS");
  eq(f.get("currency"), "usd", "currency usd");
  eq(f.get("confirm"), "true", "confirm true");
  eq(f.get("payment_method_data[type]"), "crypto", "payment_method_data[type]=crypto");
  eq(f.get("payment_method_types[0]"), "crypto", "payment_method_types crypto");
  eq(f.get("payment_method_options[crypto][mode]"), "transaction_verification", "mode=transaction_verification");
  eq(f.get("payment_method_options[crypto][transaction_verification_options][network]"), "base", "tvo network");
  eq(f.get("payment_method_options[crypto][transaction_verification_options][transaction_hash]"), SALE.tx, "tvo transaction_hash");
  eq(f.get("metadata[agent402_shadow]"), "1", "marked as a shadow row in Stripe metadata");
  ok(!f.toString().includes("payer"), "no payer address is handed to Stripe");
  ok(/^\d{4}-\d{2}-\d{2}\.preview$/.test(SHADOW_API_VERSION), "a preview API version is pinned");
}

// ---------------------------------------------------------------------------
console.log("\n4. Idempotency on the tx hash: two calls, ONE PaymentIntent");
{
  const dbFile = tmpDb("idem");
  const s = stubStripe();
  const led = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  led.record(SALE);
  led.record(SALE);              // exact replay
  led.record({ ...SALE, slug: "other-slug", priceUsd: 9 }); // same tx, different everything
  await led.drain();
  await led.drain();             // a second drain must find nothing due
  eq(s.calls.length, 1, "exactly ONE Stripe call for three records of one tx");
  eq(s.created(), 1, "exactly ONE PaymentIntent");
  const r = led.report();
  eq(r.counts.recorded, 1, "one recorded row");
  eq(r.stripeSide.paymentIntents, 1, "surface reports one PaymentIntent");
  eq(r.stripeSide.usdTotal, 5, "surface reports $5 on the Stripe side");
  eq(r.ourSide.settlementsSeen, 1, "one settlement seen (the replays collapsed)");
  ok(r.recent[0].pi_id === "pi_stub_1", "the PaymentIntent id is stored");
  eq(s.calls[0].headers["Idempotency-Key"], SALE.tx, "Idempotency-Key is the tx hash");
  eq(s.calls[0].headers["Stripe-Version"], SHADOW_API_VERSION, "preview version header is sent");
  ok(String(s.calls[0].headers.Authorization).startsWith("Basic "), "basic auth with the secret key");
  ok(!String(s.calls[0].headers.Authorization).includes("sk_test_shadow"), "the raw key is not in the header verbatim (base64)");
  led.stop();
}

// ---------------------------------------------------------------------------
console.log("\n5. Failures are swallowed, counted, redacted - never thrown, never mismarked");
{
  // (a) permanent 4xx -> rejected, terminal, never retried
  const dbFile = tmpDb("fail4xx");
  const s = stubStripe({ status: 400, body: { error: { code: "resource_missing", type: "invalid_request_error", message: "SECRET UPSTREAM PROSE that must never be stored" } } });
  const led = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0, maxAttempts: 5 });
  led.record(SALE);
  let threw = null;
  try { await led.drain(); } catch (e) { threw = e; }
  eq(threw, null, "a Stripe 400 does not throw out of drain()");
  const r = led.report();
  eq(r.counts.rejected, 1, "row is rejected");
  eq(r.counts.recorded, undefined, "NOT marked recorded - a failure never counts as recorded");
  eq(r.stripeSide.paymentIntents, 0, "Stripe side stays at zero");
  eq(r.stripeSide.usdTotal, 0, "Stripe side USD stays at zero");
  eq(r.ourSide.usdTotal, 5, "our side still shows the settlement we saw");
  const reason = r.recent[0].reason;
  eq(reason, "http_400:resource_missing", "reason is status + the enum-ish Stripe code only");
  ok(!JSON.stringify(r).includes("SECRET UPSTREAM PROSE"), "the Stripe error MESSAGE is never stored or surfaced");
  await led.drain();
  eq(s.calls.length, 1, "a rejected row is terminal - never retried");
  led.stop();
}
{
  // (b) 5xx / network / timeout -> retried with backoff, then abandoned
  const dbFile = tmpDb("fail5xx");
  const s = stubStripe({ status: 503, body: { error: { type: "api_error" } } });
  const led = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0, maxAttempts: 3, backoffMs: 0 });
  led.record(SALE);
  await led.drain();
  eq(led.report().counts.pending, 1, "a 503 goes back to pending (transient)");
  await led.drain();
  await led.drain();
  const r = led.report();
  eq(s.calls.length, 3, "retried up to maxAttempts, no further");
  eq(r.counts.abandoned, 1, "exhausted row becomes abandoned, not recorded");
  eq(r.counts.recorded, undefined, "still never recorded");
  ok(String(r.recent[0].reason).endsWith(":max-attempts"), "abandonment reason says max-attempts");
  await led.drain();
  eq(s.calls.length, 3, "an abandoned row is terminal");
  led.stop();
}
{
  // (c) fetch itself explodes
  const dbFile = tmpDb("failthrow");
  const s = stubStripe({ throwWith: new Error("connect ECONNREFUSED 127.0.0.1:443") });
  const led = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0, maxAttempts: 1, backoffMs: 0 });
  led.record(SALE);
  let threw = null;
  try { await led.drain(); } catch (e) { threw = e; }
  eq(threw, null, "a thrown fetch does not escape drain()");
  const r = led.report();
  eq(r.counts.abandoned, 1, "network error is abandoned after maxAttempts");
  eq(r.recent[0].reason, "network-error:max-attempts", "reason is a code, not the OS error string");
  ok(!JSON.stringify(r).includes("ECONNREFUSED"), "the raw network error text is not surfaced");
  led.stop();
}
{
  // (d) a broken store degrades to inert rather than posting without dedupe
  const led = createShadowLedger({ env: ENV_ON, dbFile: "/nonexistent-dir-for-shadow-test/x.db", fetchImpl: async () => { throw new Error("must not be called"); }, intervalMs: 0 });
  eq(led.record(SALE), undefined, "record() on a broken store still returns undefined");
  await led.drain();
  eq(led.report().live, false, "a ledger with no store reports live:false");
  eq(led.start(), false, "and arms no timer");
}

// ---------------------------------------------------------------------------
console.log("\n6. Restart durability: nothing lost, nothing double-posted");
{
  const dbFile = tmpDb("restart");
  const s = stubStripe();
  // First process: enqueues, then dies before draining.
  const a = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  a.record(SALE);
  a.record({ ...SALE, tx: "0xbbb2222222222222222222222222222222222222222222222222222222222222", priceUsd: 15, slug: "market-brief" });
  a.stop();
  eq(s.calls.length, 0, "nothing posted before the crash");

  // Second process, same file: the queue survived.
  const b = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  eq(b.report().counts.pending, 2, "both settlements survived the restart");
  await b.drain();
  eq(s.calls.length, 2, "both posted after restart - nothing lost");
  eq(b.report().counts.recorded, 2, "both recorded");
  b.stop();

  // Third process: re-enqueue the same settlements. Must be a no-op.
  const c = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  c.record(SALE);
  await c.drain();
  eq(s.calls.length, 2, "a replay after restart posts NOTHING - the tx hash is the primary key");
  eq(s.created(), 2, "still exactly two PaymentIntents");
  c.stop();

  // Fourth: a row stranded mid-send by a crash is reclaimed and re-driven, and
  // Stripe's idempotency key means the replay returns the SAME PaymentIntent.
  const dbFile2 = tmpDb("stranded");
  const s2 = stubStripe();
  const d = createShadowLedger({ env: ENV_ON, dbFile: dbFile2, fetchImpl: s2.impl, intervalMs: 0 });
  d.record(SALE);
  d._db.prepare("UPDATE shadow SET status='sending' WHERE tx=?").run(SALE.tx); // simulate death mid-flight
  d.stop();
  const e = createShadowLedger({ env: ENV_ON, dbFile: dbFile2, fetchImpl: s2.impl, intervalMs: 0 });
  eq(e.report().counts.pending, 1, "a stranded 'sending' row is reclaimed to pending at boot");
  await e.drain();
  eq(s2.created(), 1, "re-driving a stranded row yields ONE PaymentIntent, not two");
  eq(e.report().counts.recorded, 1, "and it is recorded once");
  e.stop();
}

// ---------------------------------------------------------------------------
console.log("\n7. The operator surface reconciles both sides honestly");
{
  const dbFile = tmpDb("surface");
  const s = stubStripe();
  const led = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s.impl, intervalMs: 0 });
  led.record(SALE);                                                            // $5 base, postable
  led.record({ ...SALE, tx: "0xccc3", priceUsd: 15, slug: "market-brief" });    // $15 base, postable
  led.record({ ...SALE, tx: "0xddd4", priceUsd: 0.001, slug: "uuid" });         // sub-cent
  led.record({ ...SALE, tx: "0xeee5", network: "polygon" });                    // unsupported chain
  led.record({ ...SALE, tx: "0xfff6", synthetic: true });                       // our own canary
  led.record({ ...SALE, tx: null, slug: "no-hash" });                           // no tx
  await led.drain();
  const r = led.report();
  eq(r.authoritative, false, "the surface states it is NOT authoritative");
  ok(/SHADOW ONLY/.test(r.note), "the note says shadow only");
  eq(r.counts.recorded, 2, "two recorded");
  eq(r.counts.skipped, 4, "four skipped");
  eq(r.stripeSide.paymentIntents, 2, "Stripe side: 2 PaymentIntents");
  eq(r.stripeSide.usdTotal, 20, "Stripe side: $20");
  eq(r.ourSide.settlementsSeen, 6, "our side counted every settlement it was handed");
  eq(Math.round(r.ourSide.usdTotal * 1000) / 1000, 35.001, "our side USD includes what Stripe could not take ($5+$15 posted, $0.001 sub-cent, $5 polygon, $5 internal, $5 no-tx)");
  const reasons = Object.fromEntries(r.reasons.map((x) => [x.reason, x.n]));
  eq(reasons["sub-cent-amount"], 1, "sub-cent skip is named");
  eq(reasons["network-unsupported"], 1, "unsupported-network skip is named");
  eq(reasons.internal, 1, "internal skip is named");
  eq(reasons["no-tx"], 1, "no-tx skip is named");
  ok(typeof r.compare === "string" && r.compare.includes("/api/revenue/daily"), "the surface tells the operator what to compare");
  eq(s.calls.length, 2, "only the two postable settlements ever hit the network");
  led.stop();
}

// ---------------------------------------------------------------------------
console.log("\n8. THE LOAD-BEARING ONE: the caller is identical in all three worlds");
{
  // A stand-in for src/server.js's res.on("finish") block: book our own sale,
  // then hand the same settlement to the shadow ledger, then answer. If the
  // shadow ledger can ever change what this returns, the feature is unsafe.
  const ourBooks = [];
  function finishHandler(led, sale) {
    let statusCode = 200;
    try {
      ourBooks.push({ slug: sale.slug, priceUsd: sale.priceUsd }); // authoritative
      led.record(sale);                                            // shadow, after
      return { status: statusCode, body: { ok: true, slug: sale.slug }, booked: ourBooks.length };
    } catch (e) {
      statusCode = 500;
      return { status: statusCode, body: { error: String(e?.message || e) }, booked: ourBooks.length };
    }
  }

  const worlds = {
    disabled: createShadowLedger({ env: {}, dbFile: tmpDb("w-off"), fetchImpl: async () => { throw new Error("nope"); }, intervalMs: 0 }),
    succeeds: createShadowLedger({ env: ENV_ON, dbFile: tmpDb("w-ok"), fetchImpl: stubStripe().impl, intervalMs: 0 }),
    stripeFails: createShadowLedger({ env: ENV_ON, dbFile: tmpDb("w-4xx"), fetchImpl: stubStripe({ status: 402, body: { error: { code: "card_declined" } } }).impl, intervalMs: 0 }),
    fetchExplodes: createShadowLedger({ env: ENV_ON, dbFile: tmpDb("w-boom"), fetchImpl: () => { throw new Error("boom"); }, intervalMs: 0 }),
    storeBroken: createShadowLedger({ env: ENV_ON, dbFile: "/nonexistent-dir-for-shadow-test/y.db", fetchImpl: async () => { throw new Error("nope"); }, intervalMs: 0 }),
  };

  const results = {};
  for (const [name, led] of Object.entries(worlds)) {
    ourBooks.length = 0;
    const before = Date.now();
    const out = finishHandler(led, SALE);
    results[name] = out;
    ok(Date.now() - before < 200, `${name}: record() returns immediately (no network on the caller's path)`);
    eq(ourBooks.length, 1, `${name}: our own books were written exactly once`);
    // Drain AFTER the caller has already returned - this is the timer's job.
    await led.drain().catch(() => { ok(false, `${name}: drain rejected`); });
    led.stop();
  }
  const baseline = JSON.stringify(results.disabled);
  for (const [name, out] of Object.entries(results)) {
    eq(JSON.stringify(out), baseline, `${name}: caller's status AND return value are identical to the disabled world`);
  }
  eq(results.disabled.status, 200, "and that identical status is 200");

  // record() must be synchronous void: a caller cannot accidentally await it,
  // and no rejected promise can escape into a request.
  const led = createShadowLedger({ env: ENV_ON, dbFile: tmpDb("void"), fetchImpl: () => { throw new Error("boom"); }, intervalMs: 0 });
  const rv = led.record(SALE);
  eq(rv, undefined, "record() returns undefined, not a promise");
  ok(!(rv && typeof rv.then === "function"), "record() is not thenable - it cannot be awaited into the request path");
  led.stop();
}

// ---------------------------------------------------------------------------
console.log("\n9. The mirror never reaches back into serving");
{
  const src = await import("node:fs").then((m) => m.readFileSync("src/stripe-shadow-ledger.js", "utf8"));
  ok(!/\breq\b\s*\./.test(src), "the module never touches a request object");
  ok(!/\bres\b\s*\.(status|json|send|set|end|write)\b/.test(src), "the module never touches a response object");
  ok(!/process\.exit/.test(src), "the module can never kill the process");
  ok(/\.unref\(\)/.test(src), "the drain timer is unref'd so it cannot hold the process open");
  const server = await import("node:fs").then((m) => m.readFileSync("src/server.js", "utf8"));
  ok(/recordShadowSettlement\(/.test(server), "server.js calls the shadow ledger");
  const shadowIdx = server.indexOf("recordShadowSettlement({");
  const saleIdx = server.indexOf('if (rail !== "credits") recordSale({');
  ok(saleIdx > 0 && shadowIdx > saleIdx, "the shadow call comes AFTER our own recordSale, never before");
  ok(!/await\s+recordShadowSettlement/.test(server), "server.js never awaits the shadow ledger");
  ok(/__operator\/shadow-ledger\.json/.test(server), "the operator reconciliation route is registered");
  const routeIdx = server.indexOf('app.get("/__operator/shadow-ledger.json"');
  ok(/operatorAuthed\(req\)/.test(server.slice(routeIdx, routeIdx + 400)), "the operator route is operator-authed");
  ok(!/shadowLedgerReport|recordShadowSettlement/.test(server.slice(server.indexOf("/api/revenue"), server.indexOf("/api/revenue") + 4000)), "no revenue surface reads the shadow ledger");
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
ok(!existsSync("/nonexistent-dir-for-shadow-test"), "the broken-store cases never created a directory");

console.log(`\n${fails.length ? "FAILED" : "PASSED"}: ${pass} assertions, ${fails.length} failures`);
if (fails.length) { for (const f of fails) console.error(` - ${f}`); process.exit(1); }
