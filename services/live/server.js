// agent402-live: a read-only, separately deployed visualizer of x402 (Base)
// and MPP (Tempo) payments. It shares no process, database or key with the
// agent402 API; it reads public chain RPCs and public discovery data, fans the
// result out to browsers over one SSE stream, and serves a static page.
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBase } from "./lib/base.js";
import { startTempo } from "./lib/tempo.js";
import { makeDirectory, INTERNAL_PAYERS } from "./lib/directory.js";
import { makeLogoCache } from "./lib/logos.js";
import { makeStore } from "./lib/store.js";
import { BASE, TEMPO } from "./lib/chains.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MAX_CLIENTS = Number(process.env.LIVE_MAX_CLIENTS || 1000);
const DIRECTORY_REFRESH_MS = Number(process.env.LIVE_DIRECTORY_REFRESH_MS || 30 * 60_000);
const OFFLINE = process.env.LIVE_OFFLINE === "1"; // tests: no network ingest

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/mascot.svg": ["mascot.svg", "image/svg+xml"],
  "/walker.svg": ["walker.svg", "image/svg+xml"],
};
const files = Object.fromEntries(Object.entries(STATIC).map(([p, [f, type]]) => [p, { body: readFileSync(join(here, "public", f)), type }]));
// The page references its script with a content hash, so a deploy is never
// served a stale cached script.
const appVersion = createHash("sha256").update(files["/app.js"].body).digest("hex").slice(0, 12);
files["/"].body = Buffer.from(files["/"].body.toString("utf8").replace('src="/app.js"', `src="/app.js?v=${appVersion}"`));

const directory = makeDirectory();
const logos = makeLogoCache();
const store = makeStore();
const clients = new Set();
let pending = [];
const ingest = { base: null, tempo: null };

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

function sellerPublic(s) {
  return { key: s.key, name: s.name, host: hostOf(s.origin), logo: s.agent402 ? null : `/logo/${encodeURIComponent(s.key)}`, agent402: s.agent402, listed: s.listed };
}
const sellerByKey = new Map();
function sellerInfo(key) { return sellerByKey.get(key) || { key, name: key.split(":")[1] ? shortAddr(key.split(":")[1]) : key, host: null, logo: null, agent402: false, listed: false }; }

function toPublic(ev) {
  return {
    id: ev.id, chain: ev.chain, ts: Math.round(ev.ts), amountUsd: ev.amountUsd,
    payer: shortAddr(ev.payer), tx: ev.tx, txUrl: (ev.chain === "mpp" ? TEMPO : BASE).txUrl(ev.tx),
    seller: sellerInfo(ev.seller.key),
    endpoint: ev.seller.endpoints?.length === 1 ? ev.seller.endpoints[0] : null,
    internal: INTERNAL_PAYERS.has(ev.payer) || undefined,
  };
}

// A signed USDC transfer on Base is how x402 settles, but other apps use the
// same mechanism, so by default a Base payment counts only when its payTo is
// a seller listed in public x402 discovery (or Agent402). Tempo is already
// limited to MPP recipients read from sellers' own 402s.
const INCLUDE_UNLISTED = process.env.LIVE_INCLUDE_UNLISTED === "1";
function onEvents(evs) {
  for (const ev of evs) {
    const s = directory.lookup(ev.chain, ev.payTo);
    if (!s.listed && !INCLUDE_UNLISTED) continue;
    ev.seller = s;
    sellerByKey.set(s.key, sellerPublic(s));
    if (store.add(ev)) pending.push(ev);
  }
}

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const flush = setInterval(() => {
  if (!pending.length) return;
  const batch = pending.map(toPublic);
  pending = [];
  for (const c of clients) send(c, "payments", batch);
}, 1000);
flush.unref?.();
const statsTick = setInterval(() => { const st = statsNow(); for (const c of clients) send(c, "stats", st); }, 10_000);
statsTick.unref?.();
const keepAlive = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20_000);
keepAlive.unref?.();

function statsNow() {
  return { ...store.stats(sellerInfo), ingest: { base: pick(ingest.base?.status), tempo: pick(ingest.tempo?.status) } };
}
function pick(s) { return s ? { live: !!s.lastOkAt && Date.now() - s.lastOkAt < 60_000, backfilled: s.backfilled } : null; }

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); return res.end(); }
  if (files[path]) {
    res.writeHead(200, { "content-type": files[path].type, "cache-control": path === "/" ? "no-cache" : url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", ...securityHeaders });
    return res.end(req.method === "HEAD" ? undefined : files[path].body);
  }
  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: true, events1h: store.size(), clients: clients.size, directory: directory.status(), base: ingest.base?.status || null, tempo: ingest.tempo?.status || null }));
  }
  if (path === "/api/stats") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=10", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify(statsNow()));
  }
  if (path === "/events") {
    if (clients.size >= MAX_CLIENTS) { res.writeHead(503, { "retry-after": "30" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    send(res, "hello", { now: Date.now(), payments: store.recent(4000).map(toPublic), stats: statsNow() });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  const lm = /^\/logo\/((?:x402|mpp)%3A0x[0-9a-f]{40})$/i.exec(path);
  if (lm) {
    const key = decodeURIComponent(lm[1]).toLowerCase();
    const [chain, payTo] = key.split(":");
    const s = directory.lookup(chain, payTo);
    const hit = s.listed && !s.agent402 ? await logos.get(key, s) : null;
    if (!hit) { res.writeHead(404, { "cache-control": "public, max-age=3600" }); return res.end(); }
    res.writeHead(200, { "content-type": hit.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    return res.end(hit.body);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[live] listening on :${server.address().port}`);
  if (OFFLINE) return;
  directory.refresh().catch((e) => console.warn(`[live:directory] ${e.message}`)).finally(() => {
    ingest.base = startBase({ onEvents });
    ingest.tempo = startTempo({ onEvents, recipients: () => directory.mppRecipients() });
  });
  const t = setInterval(() => directory.refresh().catch(() => {}), DIRECTORY_REFRESH_MS);
  t.unref?.();
});

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { for (const c of clients) c.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });

export { server, onEvents, store, directory };
