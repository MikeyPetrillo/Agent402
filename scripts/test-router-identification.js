#!/usr/bin/env node
// A PURCHASE SAYS WHO IT IS FROM.
//
// The crawler has identified itself since it existed: safeFetch sets a
// User-Agent naming us and pointing at /crawler, and that page tells an
// operator what we read and how to stop us. The BUYER is a different code path
// - a bare fetch with the SSRF dispatcher, never safeFetch - and it set no
// User-Agent at all, so undici sent `node` and a real paid call from our router
// was indistinguishable at the seller from any other script on the internet.
//
// Found 2026-09-21 by a seller trying to separate our probes from our purchases
// in their own logs, which was impossible from their side. Measured rather than
// reasoned about: a bare Node fetch sends `User-Agent: node`.
//
// Both halves are pinned here because both can regress silently. A missing
// header is invisible to every other test we own - nothing else reads what the
// buyer puts on the wire - and a seller who cannot attribute our traffic has no
// way to tell us, which is how this survived.
//
//   node scripts/test-router-identification.js
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

// A key is required before the request is built, and this one signs nothing:
// every fetch is stubbed, so no credential it produces ever reaches a chain.
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + "11".repeat(32);
const { payX402, ROUTER_UA } = await import("../src/x402-buyer.js");
const { CRAWLER_UA } = await import("../src/crawler-page.js");

// Header lookup that does not care about case, because a seller's does not
// either and neither does HTTP.
const hget = (headers, name) => {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

// --- 1. the two strings are distinguishable, and both explain themselves -----
{
  ok(ROUTER_UA !== CRAWLER_UA, "the router and the crawler send DIFFERENT User-Agents - separating a probe from a purchase is the whole point, and not every seller logs headers");
  for (const [what, ua] of [["router", ROUTER_UA], ["crawler", CRAWLER_UA]]) {
    ok(ua.includes("agent402.tools/crawler"), `the ${what} string points at a page that says who we are`);
    ok(/Agent402/.test(ua), `the ${what} string carries the Agent402 token, so a seller already tolerating one tolerates the other`);
  }
}

// --- 2. what actually leaves on a paid call ---------------------------------
//
// Driven through the real payX402 against a stub seller, not asserted against
// the source: the header object is assembled from three spreads and a source
// pin cannot see which one wins.
const PAID_RECEIPT = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "base" })).toString("base64");

/** A seller that answers 402 unpaid and 200 once a credential arrives, recording
 *  every request it saw. */
function stubSeller() {
  const seen = [];
  const required = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", resource: "https://seller.example/x", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
  })).toString("base64");
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers || {} });
    const cred = hget(init?.headers, "payment-signature") || hget(init?.headers, "x-payment");
    if (!cred) {
      return { status: 402, headers: { get: (h) => (String(h).toLowerCase() === "payment-required" ? required : null) }, json: async () => ({}), text: async () => "{}" };
    }
    return { status: 200, headers: { get: (h) => (String(h).toLowerCase() === "payment-response" ? PAID_RECEIPT : String(h).toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  };
  return seen;
}

const buy = (opts = {}) => payX402("https://seller.example/x", {
  maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base",
  notDebited: async () => ({ debited: true, observed: 1 }), ...opts,
}).catch((e) => e);

{
  const seen = stubSeller();
  await buy();
  ok(seen.length >= 2, `the stub saw both legs of a purchase (${seen.length})`);

  // CONTROL. Every assertion below reads a header off a recorded request, so a
  // harness that records nothing useful would report a clean run. Prove it can
  // tell a present header from an absent one before believing any of them.
  eq(hget(seen[0].headers, "x-nothing-sets-this"), undefined, "control: the harness reports a header nobody set as absent");
  ok(hget(seen[0].headers, "accept") != null, "control: and reports one we do set as present");

  for (const [i, leg] of [[0, "the unpaid 402 probe"], [seen.length - 1, "the paid retry"]]) {
    eq(hget(seen[i].headers, "user-agent"), ROUTER_UA, `${leg} names us in its User-Agent`);
    eq(hget(seen[i].headers, "x-agent402-via"), "router", `${leg} carries X-Agent402-Via: router`);
  }
  // The paid leg is the one that matters most and is the easiest to break, so
  // assert it IS the paid leg rather than trusting the index.
  ok(hget(seen[seen.length - 1].headers, "PAYMENT-SIGNATURE") || hget(seen[seen.length - 1].headers, "payment-signature"),
     "...and the leg checked as 'paid' really did carry a payment credential");
}

// --- 3. identity is not a parameter -----------------------------------------
//
// `headers` reaches payX402 from callers whose values are shaped by a buyer's
// own input (seller-payability takes a url and body from the caller). Ours are
// spread AFTER, so a caller cannot rewrite who we claim to be or strip the
// attribution a seller is relying on. This is the reason for the ordering and
// the only thing that would make it safe to loosen.
{
  const seen = stubSeller();
  await buy({ headers: { "User-Agent": "curl/8.0", "X-Agent402-Via": "definitely-a-human", "X-Caller": "kept" } });
  eq(hget(seen[0].headers, "user-agent"), ROUTER_UA, "a caller CANNOT overwrite the router's User-Agent");
  eq(hget(seen[0].headers, "x-agent402-via"), "router", "a caller CANNOT overwrite X-Agent402-Via");
  eq(hget(seen[0].headers, "x-caller"), "kept", "...while an unrelated caller header still rides, so this is ordering and not a filter");
}

// --- 4. the Tempo buyer says the same thing ---------------------------------
//
// A source pin, not a drive: payTempo needs an mppx credential and a relay, and
// the property under test is one object literal. What a pin CAN prove is that
// it imports the one string rather than typing a second one that drifts.
{
  const src = readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
  ok(/import \{[^}]*\bROUTER_UA\b[^}]*\} from "\.\/x402-buyer\.js"/.test(src), "the Tempo buyer imports ROUTER_UA rather than typing its own copy");
  ok(/"user-agent": ROUTER_UA/.test(src), "the Tempo buyer sets the router User-Agent");
  ok(/"x-agent402-via": "router"/.test(src), "the Tempo buyer sets X-Agent402-Via");
  // `extra` carries the payment credential and must stay last.
  ok(src.indexOf('"x-agent402-via": "router"') < src.indexOf("...extra,"), "...before the spread that carries the credential, which must win");
}

// --- 5. the page the string promises actually explains it -------------------
//
// The UA points a seller at /crawler. A page that described only the crawler
// would send someone looking for the meaning of a purchase to a document about
// robots.txt, which is not just unhelpful but wrong - robots.txt does not
// govern a paid call.
{
  const src = readFileSync(new URL("../src/crawler-page.js", import.meta.url), "utf8");
  ok(src.includes("ROUTER_UA"), "the crawler page renders the router's string, not only the crawler's");
  ok(/X-Agent402-Via/.test(src), "...and names the header a seller would filter on");
  ok(/robots\.txt.*does not govern|does not govern.*robots\.txt/s.test(src), "...and says plainly that robots.txt does not govern a purchase");
}

console.log(`\nOK: ${n} passed`);
