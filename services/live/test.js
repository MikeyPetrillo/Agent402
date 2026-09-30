// Offline tests for agent402-live: pure ingest helpers, the directory, the
// store, and the HTTP surface booted with no network ingest.
import { pairSettlements } from "./lib/base.js";
import { tempoEvents } from "./lib/tempo.js";
import { bazaarDirectory } from "./lib/directory.js";
import { isPrivateIp } from "./lib/logos.js";
import { makeStore } from "./lib/store.js";
import { AUTH_USED_TOPIC, TRANSFER_TOPIC } from "./lib/chains.js";

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
}

// --- HTTP surface, booted offline
{
  process.env.PORT = "0"; process.env.LIVE_OFFLINE = "1";
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
  const ctl = new AbortController();
  const es = await fetch(base + "/events", { signal: ctl.signal });
  const reader = es.body.getReader(); const { value } = await reader.read(); ctl.abort();
  const hello = JSON.parse(/data: (.*)\n/.exec(new TextDecoder().decode(value))[1]);
  const p = hello.payments[0];
  ok(p && p.seller.agent402 === true && p.seller.name === "Agent402" && p.txUrl === "https://basescan.org/tx/0xabc", "events: an Agent402 payment is marked and links to basescan");
  ok(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(p.payer), "events: the buyer is shortened");
  ok((await fetch(base + "/logo/x402%3A" + "0".repeat(40))).status === 404 && (await fetch(base + "/logo/https%3A%2F%2Fevil.example")).status === 404, "logo: only a directory key is served, never an arbitrary URL");
  ok((await fetch(base + "/", { method: "POST" })).status === 405, "read-only: POST is refused");
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
