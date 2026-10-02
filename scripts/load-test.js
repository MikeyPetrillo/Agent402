// Repeatable load test - LOCAL OR STAGING ONLY. Refuses any target that is not
// localhost/127.0.0.1 unless LOAD_TEST_ALLOW_HOST names it explicitly, and it
// never accepts agent402.tools: bursts against production are exactly what
// froze it on 2026-09-25.
//
// Each scenario runs for DURATION_MS while a steady "paid-path" stream (a priced
// catalog route, answered free under FREE_MODE) measures what a paying caller
// sees at the same moment. Reports client-side latency percentiles per stream,
// status counts, and the server's own stall counters and per-route compute from
// /__operator/perf.json.
//
//   TARGET_URL=http://127.0.0.1:3791 OPERATOR_TOKEN=... node scripts/load-test.js [scenario ...]
//
// Scenarios: search-one-ip, search-50-ips, discovery-flood, slow-clients,
// dead-upstream, mixed (all of the above at once).
import net from "node:net";
import { Agent } from "undici";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3791").replace(/\/+$/, "");
const host = new URL(TARGET).hostname;
if (/agent402\.tools$/i.test(host) || !(["localhost", "127.0.0.1", "::1"].includes(host) || host === process.env.LOAD_TEST_ALLOW_HOST)) {
  console.error(`refusing to load-test ${host}: local or an explicitly allowed staging host only`);
  process.exit(2);
}
const TOKEN = process.env.OPERATOR_TOKEN || "";
const DURATION_MS = Number(process.env.DURATION_MS || 20_000);
const agent = new Agent({ connections: 400, pipelining: 1, keepAliveTimeout: 10_000 });

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
const r0 = (v) => (v == null ? null : Math.round(v));
function summary(lat, statuses) {
  const s = [...lat].sort((a, b) => a - b);
  return { n: s.length, p50: r0(pct(s, 0.5)), p95: r0(pct(s, 0.95)), p99: r0(pct(s, 0.99)), max: r0(s.at(-1)), statuses };
}

async function timed(path, { method = "GET", body, ip, timeoutMs = 15_000, headers = {} } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${TARGET}${path}`, {
      method, dispatcher: agent, signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(ip ? { "x-forwarded-for": ip } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    await res.arrayBuffer();
    return { ms: performance.now() - t0, status: res.status };
  } catch (e) {
    const code = e?.cause?.code || e?.code || e?.name || "error";
    return { ms: performance.now() - t0, status: e?.name === "TimeoutError" ? "timeout" : `error:${code}` };
  }
}

// Run `fn` with `concurrency` workers until the deadline; collect results.
async function stream(label, concurrency, fn, until) {
  const lat = [], statuses = {};
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < until) {
      const r = await fn(i++);
      lat.push(r.ms);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
  }));
  return [label, summary(lat, statuses)];
}

// A steady paid-path probe: one request every 100 ms (not closed-loop, so a
// stalled server shows up as latency rather than as fewer samples).
async function paidProbe(until) {
  const lat = [], statuses = {}, inflight = [];
  while (Date.now() < until) {
    // Carries a payment-shaped header so the server classes it as paid (the
    // local server runs FREE_MODE and never verifies it); a paying caller is
    // exactly what the load-shedding gate must keep serving.
    inflight.push(timed("/api/hash", { method: "POST", body: { text: `probe-${Date.now()}`, algorithm: "sha256" }, headers: { "payment-signature": "load-test-paid-probe-".padEnd(48, "x") } }).then((r) => { lat.push(r.ms); statuses[r.status] = (statuses[r.status] || 0) + 1; }));
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.all(inflight);
  return ["paid-path (POST /api/hash every 100 ms)", summary(lat, statuses)];
}

async function perf(reset = false) {
  if (!TOKEN) return null;
  try { return await (await fetch(`${TARGET}/__operator/perf.json?min=1&top=200${reset ? "&reset=1" : ""}`, { headers: { authorization: `Bearer ${TOKEN}` }, dispatcher: agent })).json(); } catch { return null; }
}

const WORDS = ["json", "csv", "weather", "price", "token", "pdf", "image", "hash", "dns", "email", "wallet", "stock", "news", "translate", "convert", "search", "crypto", "qr", "uuid", "time"];
const query = (i) => `${WORDS[i % 20]} ${WORDS[(i * 7) % 20]} ${WORDS[(i * 13) % 20]} ${i}`;

function slowClients(n, until) {
  // Slowloris: open sockets and dribble a header byte every 5 s, never finishing.
  const socks = [];
  const { port, hostname } = new URL(TARGET);
  for (let i = 0; i < n; i++) {
    const s = net.connect(Number(port) || 80, hostname);
    s.on("error", () => {});
    s.write(`GET /health HTTP/1.1\r\nHost: ${hostname}\r\nX-Slow: `);
    socks.push(s);
  }
  const t = setInterval(() => { for (const s of socks) if (!s.destroyed) s.write("a"); }, 5_000);
  return new Promise((resolve) => setTimeout(() => {
    clearInterval(t);
    const open = socks.filter((s) => !s.destroyed).length;
    for (const s of socks) s.destroy();
    resolve(["slow-clients", { opened: n, stillOpenAtEnd: open }]);
  }, until - Date.now()));
}

const SCENARIOS = {
  "search-one-ip": (until) => [stream("uncached /api/find, one IP, 20 parallel", 20, (i) => timed(`/api/find?q=${encodeURIComponent(query(i))}`, { ip: "203.0.113.7" }), until)],
  "search-50-ips": (until) => [stream("uncached /api/route, 50 IPs, 50 parallel", 50, (i) => timed(`/api/route?q=${encodeURIComponent(query(i))}`, { ip: `198.51.100.${i % 50}` }), until)],
  "discovery-flood": (until) => {
    const paths = ["/", "/tools", "/api/pricing", "/openapi.json", "/llms.txt", "/.well-known/x402", "/sitemap.xml", "/api/index", "/marketplace", "/leaderboard", "/api/stats"];
    return [stream("discovery pages, 60 parallel", 60, (i) => timed(paths[i % paths.length], { ip: `192.0.2.${i % 200}` }), until)];
  },
  "slow-clients": (until) => [slowClients(300, until), stream("/health during slowloris", 2, () => timed("/health"), until)],
  // The SSRF guard refuses loopback and private targets, so a local hung
  // server cannot stand in here; DEAD_UPSTREAM_URL names a public host:port
  // that accepts no connection (default: a filtered port on example.com), at
  // low concurrency so the probe stays polite.
  "dead-upstream": (until) => {
    const url = process.env.DEAD_UPSTREAM_URL || "http://example.com:81/";
    return [stream("tool fetching an unreachable upstream, 10 parallel", 10, () => timed("/api/http-check", { method: "POST", body: { url }, timeoutMs: 30_000 }), until)];
  },
};

async function run(name) {
  const until = Date.now() + DURATION_MS;
  const before = await perf(true);
  const load = name === "mixed" ? (await Promise.all(Object.keys(SCENARIOS).map((k) => SCENARIOS[k](until)))).flat() : await SCENARIOS[name](until);
  const results = await Promise.all([...load, paidProbe(until)]);
  const after = await perf();
  const out = { scenario: name, durationMs: DURATION_MS, streams: Object.fromEntries(results) };
  if (before && after) {
    out.server = {
      stallsOver1s: (after.loop.stalls ?? 0) - (before.loop.stalls ?? 0),
      worstLoopDelayMs: after.loop.worstMs,
      paidPathComputeMs: after.routes.find((r) => r.route === "POST /api/hash")?.computeMs ?? null,
      findComputeMs: after.routes.find((r) => r.route === "GET /api/find")?.computeMs ?? null,
      routeComputeMs: after.routes.find((r) => r.route === "GET /api/route")?.computeMs ?? null,
    };
  }
  console.log(JSON.stringify(out, null, 1));
  await new Promise((r) => setTimeout(r, 3_000)); // let the server settle between scenarios
}

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : [...Object.keys(SCENARIOS), "mixed"]) {
  if (name !== "mixed" && !SCENARIOS[name]) { console.error(`unknown scenario ${name}`); process.exit(2); }
  await run(name);
}
await agent.close();
process.exit(0);
