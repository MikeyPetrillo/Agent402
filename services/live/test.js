// Offline tests for agent402-live: pure ingest helpers, the directory, the
// store, and the HTTP surface booted with no network ingest.
import { pairSettlements } from "./lib/base.js";
import { tempoEvents } from "./lib/tempo.js";
import { isPrivateIp } from "./lib/logos.js";
import { makeStore } from "./lib/store.js";
import { AUTH_USED_TOPIC, TRANSFER_TOPIC } from "./lib/chains.js";
// Our own wallet list is read when directory.js loads, so it is set first.
const OWN = "0x" + "d".repeat(40);
process.env.LIVE_INTERNAL_PAYERS = OWN;
const { bazaarDirectory } = await import("./lib/directory.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T = (a) => "0x" + "0".repeat(24) + a.slice(2);
const amt = (usd) => "0x" + BigInt(Math.round(usd * 1e6)).toString(16);
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);

// --- Base: only a transfer FROM the authorizer of a signed authorization in the same tx
{
  const auth = [{ transactionHash: "0x1", topics: [AUTH_USED_TOPIC, T(A), "0xn"] }];
  const tr = [
    { transactionHash: "0x1", logIndex: "0x2", blockNumber: "0x10", topics: [TRANSFER_TOPIC, T(A), T(B)], data: amt(0.01) },
    { transactionHash: "0x1", logIndex: "0x3", blockNumber: "0x10", topics: [TRANSFER_TOPIC, T(C), T(B)], data: amt(0.01) },
    { transactionHash: "0x2", logIndex: "0x1", blockNumber: "0x10", topics: [TRANSFER_TOPIC, T(A), T(B)], data: amt(0.01) },
    { transactionHash: "0x1", logIndex: "0x4", blockNumber: "0x10", topics: [TRANSFER_TOPIC, T(A), T(B)], data: amt(0) },
    { transactionHash: "0x1", logIndex: "0x5", blockNumber: "0x10", topics: [TRANSFER_TOPIC, T(A), T(B)], data: amt(500) },
  ];
  const ev = pairSettlements(auth, tr);
  ok(ev.length === 1 && ev[0].payer === A && ev[0].payTo === B && ev[0].amountUsd === 0.01, "Base: one settlement, from the authorizer, in the authorized tx");
  ok(!ev.some((e) => e.amountUsd === 0), "Base: a zero-value transfer (address-poisoning shape) is dropped");
  ok(!ev.some((e) => e.amountUsd > 50), "Base: a transfer above the per-payment ceiling is dropped");
  ok(pairSettlements([], tr).length === 0, "Base: no signed authorization, no payment");
}

// --- Tempo: only transfers to known recipients, never self-transfers
{
  const logs = [
    { transactionHash: "0xA", logIndex: "0x0", blockNumber: "0x1", topics: [TRANSFER_TOPIC, T(A), T(B)], data: amt(0.005) },
    { transactionHash: "0xB", logIndex: "0x0", blockNumber: "0x1", topics: [TRANSFER_TOPIC, T(A), T(C)], data: amt(0.005) },
    { transactionHash: "0xC", logIndex: "0x0", blockNumber: "0x1", topics: [TRANSFER_TOPIC, T(B), T(B)], data: amt(0.005) },
  ];
  const ev = tempoEvents(logs, new Set([B]));
  ok(ev.length === 1 && ev[0].chain === "mpp" && ev[0].payTo === B, "Tempo: a transfer to a known MPP recipient counts; others and self-transfers do not");
}

// --- Directory from Bazaar items
{
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const d = bazaarDirectory([
    { resource: "https://seller.example/a", serviceName: "Seller", iconUrl: "https://seller.example/i.png", accepts: [{ network: "eip155:8453", asset: USDC, payTo: B.toUpperCase().replace("0X", "0x") }] },
    { resource: "https://seller.example/b", serviceName: "Seller", accepts: [{ network: "base", asset: USDC, payTo: B }] },
    { resource: "http://insecure.example/x", serviceName: "<script>x</script>", accepts: [{ network: "eip155:8453", asset: USDC, payTo: C }] },
    { resource: "https://other.example/x", accepts: [{ network: "eip155:137", asset: USDC, payTo: A }] },
  ]);
  const s = d.get(B);
  ok(s && s.name === "Seller" && s.icon === "https://seller.example/i.png" && s.origin === "https://seller.example" && s.endpoints.length === 2, "Bazaar: payTo lowercased, name, icon, origin and endpoints collected");
  ok(!d.get(C).name.includes("<") && d.get(C).origin === null, "Bazaar: markup stripped from names; an http resource is not an origin");
  ok(!d.has(A), "Bazaar: a non-Base accept is not a Base seller");
}

// --- Private address guard for the logo fetcher
{
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) ok(isPrivateIp(ip), `logo guard refuses ${ip}`);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) ok(!isPrivateIp(ip), `logo guard allows ${ip}`);
}

// --- Store: dedupe, window, distinct buyers, prune
{
  let t = Date.now();
  const st = makeStore({ now: () => t });
  const seller = { key: "x402:" + B };
  const e = (i, payer, ts, usd = 0.01) => ({ chain: "x402", tx: "0x" + i, logIndex: 0, payer, payTo: B, amountUsd: usd, ts, seller });
  ok(st.add(e(1, A, t - 1000)) && !st.add(e(1, A, t - 1000)), "store: the same settlement is counted once");
  st.add(e(2, A, t - 2000)); st.add(e(3, C, t - 3000));
  st.add(e(4, C, t - 2 * 3600_000));
  const s = st.stats((k) => ({ key: k, name: "Seller" }));
  ok(s.x402.h1.payments === 3 && s.x402.h24.payments === 4, "store: 1h and 24h windows");
  ok(s.x402.h1.buyers === 2, "store: buyers are distinct payers");
  ok(s.mpp.h1.payments === 0 && s.all.h1.payments === 3, "store: scopes separate x402 and MPP");
  ok(st.recent().length === 3, "store: the replay buffer keeps only the last hour");
  const st2 = makeStore({ now: () => t });
  for (const [i, dt] of [[1, 100], [2, 500], [3, 300], [4, 50]]) st2.add(e(i + 10, A, t - dt * 1000));
  ok(st2.recent().map((x) => x.ts).every((ts, i, a) => i === 0 || a[i - 1] <= ts), "store: events arriving newest first are kept in time order");
  // Our own canary and volume payments walk past, never reach a count.
  const st3 = makeStore({ now: () => t });
  st3.add(e(21, A, t - 1000, 0.01));
  st3.add({ ...e(22, C, t - 900, 5), internal: true });
  const s3 = st3.stats((k) => ({ key: k, name: "Seller" }));
  ok(s3.all.h1.payments === 1 && s3.all.h1.usd === 0.01 && s3.all.h1.buyers === 1 && s3.all.h24.payments === 1, "store: an internal payment is in no count (payments, usd, buyers, 24h)");
  ok(s3.all.h1.topSellers.length === 1 && s3.all.h1.topSellers[0].payments === 1, "store: an internal payment does not rank a seller");
  ok(st3.recent().length === 2 && st3.recent().some((x) => x.internal), "store: the internal payment still reaches the page's event list");
}

// --- HTTP surface, booted offline
{
  process.env.PORT = "0"; process.env.LIVE_OFFLINE = "1"; process.env.GA_MEASUREMENT_ID = "G-TEST12345";
  const { server, onEvents } = await import("./server.js");
  await new Promise((r) => server.listening ? r() : server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  onEvents([{ chain: "x402", tx: "0xabc", logIndex: 1, block: 1, payer: A, payTo: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", amountUsd: 0.001, ts: Date.now() }]);
  onEvents([{ chain: "x402", tx: "0xdef", logIndex: 1, block: 1, payer: A, payTo: C, amountUsd: 0.001, ts: Date.now() }]);
  const page = await fetch(base + "/");
  const html = await page.text();
  ok(page.status === 200 && /script-src|default-src 'self'/.test(page.headers.get("content-security-policy") || "") && /app\.js\?v=[0-9a-f]{12}/.test(html), "page: served with a CSP and a versioned script");
  const health = await (await fetch(base + "/health")).json();
  ok(health.ok === true && health.events1h === 1, "health: one event, the unlisted Base payTo was not counted");
  const { onEvents: push } = await import("./server.js");
  push([{ chain: "x402", tx: "0xold", logIndex: 1, block: 1, payer: A, payTo: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", amountUsd: 0.001, ts: Date.now() - 600_000 }], { backfill: true });
  ok((await (await fetch(base + "/health")).json()).events1h === 2, "health: a backfilled payment joins the hour");
  const ctl = new AbortController();
  const es = await fetch(base + "/events", { signal: ctl.signal });
  const reader = es.body.getReader(); const { value } = await reader.read(); ctl.abort();
  const hello = JSON.parse(/data: (.*)\n/.exec(new TextDecoder().decode(value))[1]);
  const p = hello.payments.find((x) => x.tx === "0xabc");
  ok(p && p.seller.agent402 === true && p.seller.name === "Agent402" && p.txUrl === "https://basescan.org/tx/0xabc", "events: an Agent402 payment is marked and links to basescan");
  ok(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(p.payer), "events: the buyer is shortened");
  {
    const before = await (await fetch(base + "/api/stats")).json();
    push([{ chain: "x402", tx: "0xown", logIndex: 1, block: 1, payer: OWN, payTo: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", amountUsd: 0.5, ts: Date.now() }]);
    const after = await (await fetch(base + "/api/stats")).json();
    ok(after.all.h1.payments === before.all.h1.payments && after.all.h1.usd === before.all.h1.usd && after.all.h1.buyers === before.all.h1.buyers, "stats: a payment from our own wallet changes no count");
    ok(after.excludesOwnPayments === true, "stats: says our own payments are excluded when the wallet list is configured");
    const page = await (await fetch(base + "/")).text();
    ok(/left out of every count/.test(page) && !/<!--OWN-->|<!--MAXUSD-->/.test(page) && /up to \$50 to a recipient/.test(page), "page: the read-me states the exclusion and the derived per-payment ceiling");
    ok(/carries no marker that says it was an MPP payment/.test(page), "page: says the Tempo side counts every transfer to an MPP recipient");
  }
  ok((await fetch(base + "/logo/v2/x402%3A" + "0".repeat(40))).status === 404 && (await fetch(base + "/logo/https%3A%2F%2Fevil.example")).status === 404, "logo: only a directory key is served, never an arbitrary URL");
  ok((await fetch(base + "/", { method: "POST" })).status === 405, "read-only: POST is refused");
  {
    const home = await fetch(base + "/"), emb = await fetch(base + "/embed");
    const hc = home.headers.get("content-security-policy") || "", ec = emb.headers.get("content-security-policy") || "";
    ok(/frame-ancestors 'none'/.test(hc), "the live page itself still refuses every framer");
    ok(emb.status === 200 && /frame-ancestors https:\/\/agent402\.tools https:\/\/www\.agent402\.tools(;|$)/.test(ec) && !/'none'/.test(ec.split("frame-ancestors")[1].split(";")[0]), "/embed may be framed by agent402.tools only");
    const html = await emb.text();
    ok(/<style id="embed">[\s\S]*header\.hero[\s\S]*display:none/.test(html) && /<canvas id="scene"/.test(html) && /id="latest"/.test(html), "/embed is the scene and the LATEST bar, nothing else shown");
    ok(!/frame-ancestors [^;]*\*/.test(ec), "no wildcard ancestor");
  }
  {
    const html = await (await fetch(base + "/")).text(), app = await (await fetch(base + "/app.js")).text();
    const toolbar = html.split('<div class="toolbar">')[1]?.split('<div class="field"')[0] || "";
    ok(/<button id="fs" type="button"/.test(toolbar), "full screen: the button sits in the stage toolbar (which /embed hides)");
    ok(/stage\.requestFullscreen \|\| stage\.webkitRequestFullscreen/.test(app) && /classList\.toggle\("is-full"/.test(app) && /\.stage\.is-full \{ position: fixed; inset: 0;/.test(html), "full screen: native fullscreen of the whole stage, with a fixed overlay where the browser has none");
  }
  {
    const home = await fetch(base + "/"), html = await home.text(), csp = home.headers.get("content-security-policy") || "";
    ok(/<script id="ga-config" type="application\/json">\{"id":"G-TEST12345"\}<\/script><script src="\/ga-loader\.js\?v=[0-9a-f]{12}"><\/script><\/head>/.test(html), "analytics: the id island and the versioned loader sit in the page head");
    ok(/script-src 'self' https:\/\/www\.googletagmanager\.com;/.test(csp) && /connect-src 'self' [^;]*google-analytics\.com/.test(csp) && !/unsafe-inline'[^;]*script|script-src[^;]*unsafe/.test(csp) && /frame-ancestors 'none'/.test(csp), "analytics: CSP allows Google tag and collection hosts only, no inline script, still unframeable");
    const emb = await fetch(base + "/embed"), ehtml = await emb.text(), ecsp = emb.headers.get("content-security-policy") || "";
    ok(!/ga-config|ga-loader/.test(ehtml) && !/googletagmanager/.test(ecsp), "analytics: /embed carries no tag, so the homepage hero is not counted twice");
    const loader = await fetch(base + "/ga-loader.js"), src = await loader.text();
    ok(loader.status === 200 && /javascript/.test(loader.headers.get("content-type")) && /https:\/\/agent402\.tools\/privacy/.test(src), "analytics: loader served, its privacy link points at agent402.tools");
  }
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
