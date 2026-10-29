// Offline tests for agent402-live: pure ingest helpers, the directory, the
// store, and the HTTP surface booted with no network ingest.
import { pairSettlements } from "./lib/base.js";
import { tempoEvents } from "./lib/tempo.js";
import { bazaarDirectory } from "./lib/directory.js";
import { isPrivateIp, makeLogoCache } from "./lib/logos.js";
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

// --- Logo state: unknown until tried, then a hit or a remembered miss
{
  const lc = makeLogoCache({ fetchImpl: async () => { throw new Error("offline"); } });
  ok(lc.known("x402:0xabc") === null, "logo: an untried seller's logo state is unknown (no URL is published for it)");
  await lc.get("x402:0xabc", { origin: "https://seller.example" });
  ok(lc.known("x402:0xabc") === "miss", "logo: a seller with no usable icon is remembered as a miss (still no URL)");
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
}

// --- HTTP surface, booted offline
{
  process.env.PORT = "0"; process.env.LIVE_OFFLINE = "1"; process.env.LIVE_POLL_KEEP_BATCHES = "2"; process.env.LIVE_POLL_HELLO_PER_MIN = "14"; process.env.GA_MEASUREMENT_ID = "G-TEST12345";
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
    const app = await fetch(base + "/app.js", { headers: { "accept-encoding": "gzip" } });
    ok(app.headers.get("content-encoding") === "gzip" && /accept-encoding/i.test(app.headers.get("vary") || "") && (await app.text()).length > 1000, "compression: app.js goes out gzipped when accepted, and varies on it");
    const st = await fetch(base + "/api/stats", { headers: { "accept-encoding": "gzip" } });
    ok(st.headers.get("content-encoding") === "gzip" && typeof (await st.json()) === "object", "compression: /api/stats is gzipped JSON");
    const loader = await fetch(base + "/ga-loader.js"), src = await loader.text();
    ok(loader.status === 200 && /javascript/.test(loader.headers.get("content-type")) && /https:\/\/agent402\.tools\/privacy/.test(src), "analytics: loader served, its privacy link points at agent402.tools");
  }
  {
    // Polling fallback: the opening hour, then only the batches after the cursor.
    const AG = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
    const pay = (tx) => ({ chain: "x402", tx, logIndex: 1, block: 1, payer: A, payTo: AG, amountUsd: 0.001, ts: Date.now() });
    const poll = async (after) => { const r = await fetch(base + "/api/poll" + (after === undefined ? "" : `?after=${encodeURIComponent(after)}`), { headers: { "accept-encoding": "gzip" } }); return { r, d: await r.json() }; };
    const flushed = () => new Promise((r) => setTimeout(r, 1200));
    const first = await poll();
    ok(first.r.status === 200 && first.r.headers.get("cache-control") === "no-store" && first.r.headers.get("content-encoding") === "gzip", "poll: no-store, gzipped JSON");
    ok(first.d.hello === true && first.d.payments.some((x) => x.tx === "0xabc") && /^[0-9a-f]{8}\.\d+$/.test(first.d.cursor) && typeof first.d.stats === "object", "poll: without a cursor, the opening hour, stats and a cursor");
    await flushed();
    let cur = (await poll(first.d.cursor)).d.cursor;
    onEvents([pay("0xp1")]); await flushed();
    const next = await poll(cur);
    ok(!next.d.hello && next.d.payments.length === 1 && next.d.payments[0].tx === "0xp1" && next.d.cursor !== cur, "poll: with a cursor, only the batch sent after it");
    const again = await poll(next.d.cursor);
    ok(!again.d.hello && again.d.payments.length === 0 && again.d.cursor === next.d.cursor, "poll: nothing new, an empty list and the same cursor");
    const stale = next.d.cursor;
    for (const tx of ["0xp2", "0xp3", "0xp4"]) { onEvents([pay(tx)]); await flushed(); }
    const gap = await poll(stale);
    ok(gap.d.hello === true && ["0xp2", "0xp3", "0xp4"].every((tx) => gap.d.payments.some((x) => x.tx === tx)), "poll: a cursor older than the kept batches gets the hour again, never a gap");
    const [bootId, n] = gap.d.cursor.split(".");
    const other = (bootId[0] === "0" ? "1" : "0") + bootId.slice(1);
    ok((await poll(gap.d.cursor)).d.hello !== true && (await poll(`${other}.${n}`)).d.hello === true, "poll: another process's cursor gets the hour (restart or replica), a current one does not");
    for (const bad of ["x", "", `${bootId}.99999999`, `${bootId}.-1`, "<script>"]) ok((await poll(bad)).d.hello === true, `poll: cursor ${JSON.stringify(bad)} gets the hour`);
    ok((await fetch(base + "/api/poll", { method: "POST" })).status === 405, "poll: read-only");
    {
      // One address gets the whole hour a bounded number of times a minute;
      // a cursor poll is never refused, and another address is unaffected.
      const xff = (ip) => ({ headers: { "x-forwarded-for": ip } });
      const codes = [];
      for (let i = 0; i < 16; i++) codes.push((await fetch(base + "/api/poll", xff("203.0.113.9"))).status);
      ok(codes.slice(0, 14).every((c) => c === 200) && codes.slice(14).every((c) => c === 429), `poll: the 15th full-hour poll in a minute from one address is refused (${codes.join(",")})`);
      const cur = (await (await fetch(base + "/api/poll", xff("203.0.113.10"))).json()).cursor;
      ok((await fetch(base + `/api/poll?after=${cur}`, xff("203.0.113.9"))).status === 200, "poll: a cursor poll from that address still answers");
      const a1 = await (await fetch(base + "/api/poll", xff("203.0.113.11"))).arrayBuffer(), a2 = await (await fetch(base + "/api/poll", xff("203.0.113.12"))).arrayBuffer();
      ok(Buffer.from(a1).equals(Buffer.from(a2)), "poll: back-to-back full-hour answers are the same cached body");
    }
    const app = await (await fetch(base + "/app.js")).text();
    ok(/STREAM_WAIT_MS = 8000/.test(app) && /if \(!heard\) \{ es\.close\(\); poll\(""\); \}/.test(app) && /fetch\(`\/api\/poll\?after=/.test(app), "page: with no opening hour on the stream in 8 s, it closes the stream and polls");
    ok(/!seenIds\.has\(p\.id\)/.test(app), "page: a payment seen twice is taken once");
    ok(/\$\("conn"\)\.textContent = link;/.test(app) && !/textContent = conn \|\|/.test(app), "page: the status label is the connection's state, not whether a payment arrived in the last 45 s");
  }
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
