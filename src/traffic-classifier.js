// Who hits us, classed per request and rolled up per UTC day.
//
// Before this the only reads of our own traffic were PostHog rollups keyed by
// slug or by paywall attempt, and the raw Railway HTTP log. Neither answered
// "who is this": a scanner walking the catalog, an indexer we want fed, a
// buyer's first 402, a buyer's tenth settlement and a browser reading /docs
// all counted as requests. This classes each response as it finishes and
// keeps bounded per-day rollups (classes, top paths / user-agent product
// tokens / hashed client ips per class, the discovery surfaces indexers pull,
// and the crawler list), persisted under DATA_DIR/traffic and served to the
// operator at /__operator/traffic.json. O(1) per request, every map capped,
// never a raw ip or a payer address in the store.
//
// STORE: one JSON file per UTC day plus payers.json under the directory, or,
// when the state database is configured (STATE_DATABASE_URL), the `records`
// table there (collection "traffic", id = the day or "payers"), on the same
// 60 s persist cadence and the same retention. The first load with the
// database on imports the directory's files once (insert-if-absent) and
// records the import under the directory's basename. Without a database
// nothing here changes: the files are read and written as before.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { railOf } from "./payment-rail.js";
import { importOnce, records, stateDbEnabled, stateDbSchema, stateQuery, trackStoreReady } from "./state-db.js";

const COLLECTION = "traffic";
const PAYERS_ID = "payers";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CLASSES = Object.freeze(["ours", "repeat-buyer", "paid", "pow", "payment-refused", "known-indexer", "crawler", "challenge-only", "human", "other"]);
// Our own probes and sweeps, by the names they send (the signed heartbeat
// token is what marks them synthetic for money; this is only attribution).
export const OWN_UA = /^(agent402-(heartbeat|status-probe|paid-canary|ci-sweep|rail-canary|keepalive)|Agent402\/1\.0|Mozilla\/5\.0 \(compatible; Agent402-Router)/i;

// Indexers and bots we can name from the User-Agent. "wanted" says whether we
// want them fed complete metadata (an index that sends buyers) rather than
// merely tolerated. Matched on the whole UA, case-insensitive.
export const KNOWN_INDEXERS = Object.freeze([
  { name: "x402scan", re: /x402scan/i, wanted: true },
  { name: "x402pulse", re: /x402pulse/i, wanted: true },
  { name: "mako-pulse", re: /mako[-_ ]?pulse|\bmako\b/i, wanted: true },
  { name: "kkj-trust-index", re: /kkj/i, wanted: true },
  { name: "enclave402", re: /enclave402/i, wanted: true },
  { name: "sentinel402", re: /sentinel402/i, wanted: true },
  { name: "mpp32", re: /mpp32/i, wanted: true },
  { name: "x402-observer", re: /x402[-_ ]?observ/i, wanted: true },
  { name: "coinbase-bazaar", re: /coinbase|bazaar/i, wanted: true },
  { name: "mcp-registry", re: /modelcontextprotocol|mcp[-_ ]?registry|glama|smithery|pulsemcp|mcpqueen/i, wanted: true },
  { name: "uptime-trust", re: /uptime|payability|observatory|trust[-_ ]?(monitor|index)|stelar|nsgoods|ioi-indexer/i, wanted: true },
  { name: "search-bot", re: /Googlebot|Bingbot|DuckDuckBot|Applebot|YandexBot|Baiduspider/i, wanted: true },
  { name: "ai-crawler", re: /GPTBot|ClaudeBot|CCBot|PerplexityBot|Bytespider|Google-Extended|anthropic-ai|OAI-SearchBot|ChatGPT-User|Amazonbot|meta-externalagent/i, wanted: true },
]);

// The surfaces an indexer pulls. A client that fetches two of these and no
// tool is discovery traffic whatever its User-Agent says.
export const DISCOVERY_PATHS = new Set([
  "/api/pricing", "/openapi.json", "/.well-known/x402", "/.well-known/x402.json", "/.well-known/x402-services.json",
  "/llms.txt", "/api/find", "/api/route", "/api/index", "/api/leaderboard", "/api/stats", "/health", "/api/reliability",
  "/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/agent-registration.json", "/sitemap.xml", "/robots.txt",
]);

const HAS_DATA_DIR = existsSync("/data");
export const DEFAULTS = Object.freeze({
  dir: process.env.TRAFFIC_DIR || join(HAS_DATA_DIR ? "/data" : "/tmp", "traffic"),
  crawlerDistinctPaths: Number(process.env.TRAFFIC_CRAWLER_PATHS || 25),   // distinct /api paths inside the window
  windowMs: Number(process.env.TRAFFIC_WINDOW_MS || 10 * 60 * 1000),
  persistMs: Number(process.env.TRAFFIC_PERSIST_MS || 60 * 1000),
  keyCap: 400,      // top-N keys kept per map; the rest fold into _other
  ipCap: 20_000,    // sliding-window ip rows
  payerCap: 50_000,
  // Daily rollups hold salted ip hashes; a day file older than this is deleted
  // (on load and on every persist). /privacy states the same figure.
  retentionDays: Math.max(1, Number(process.env.TRAFFIC_RETENTION_DAYS) || 90),
  salt: process.env.TRAFFIC_HASH_SALT || process.env.POW_SECRET || "traffic",
});

const h12 = (s, salt) => createHash("sha256").update(`${salt}|${s}`).digest("hex").slice(0, 12);
export const uaToken = (ua) => String(ua || "").trim().split(/\s+/)[0].slice(0, 60) || "-";
export const indexerFor = (ua) => KNOWN_INDEXERS.find((k) => k.re.test(String(ua || ""))) || null;
export const isBrowserUa = (ua) => /Mozilla\/5\.0/.test(String(ua || "")) && !/bot|crawl|spider|slurp|curl|python|node|go-http|java|okhttp|httpx|axios|fetch/i.test(String(ua || ""));

/** Path with its query dropped and long tails bounded; /api/<slug> keeps the slug
 *  (which tools get walked is the point), everything else keeps two segments. */
export function templatePath(url) {
  const p = String(url || "/").split("?")[0].slice(0, 200);
  const seg = p.split("/").filter(Boolean);
  if (seg[0] === "api" || seg[0] === "v1") return "/" + seg.slice(0, seg[1] === "skill" || seg[1] === "chain" || seg[1] === "memory" ? 3 : 2).join("/");
  if (seg[0] === ".well-known") return "/" + seg.slice(0, 2).join("/");
  return seg.length ? "/" + seg[0] + (seg.length > 1 ? "/*" : "") : "/";
}

/** Pure: one request's class from what the response knew. */
export function classify({ status, path, ua, accept, hadPayment, hadPow, paidReceipt, priorPayerCount, ipDistinctPaths, crawlerDistinctPaths = DEFAULTS.crawlerDistinctPaths }) {
  const s = Number(status) || 0;
  if (OWN_UA.test(String(ua || ""))) return "ours";
  if (indexerFor(ua)) return "known-indexer";
  if (s < 300 && paidReceipt) return priorPayerCount > 0 ? "repeat-buyer" : "paid";
  if (s < 300 && hadPow) return "pow";
  if (s === 402 && hadPayment) return "payment-refused";
  if ((ipDistinctPaths || 0) >= crawlerDistinctPaths) return "crawler";
  if (s === 402) return "challenge-only";
  const p = String(path || "");
  if (isBrowserUa(ua) && /text\/html/.test(String(accept || "")) && !p.startsWith("/api") && !p.startsWith("/v1") && !p.startsWith("/mcp")) return "human";
  return "other";
}

const bump = (map, key, cap) => {
  const k = String(key);
  if (Object.hasOwn(map, k)) { map[k] += 1; return; }
  if (Object.keys(map).length >= cap) { map._other = (map._other || 0) + 1; return; }
  map[k] = 1;
};
const topN = (map, n) => Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, n: v }));
const emptyDay = (day) => ({ day, total: 0, classes: Object.fromEntries(CLASSES.map((c) => [c, 0])), byClass: Object.fromEntries(CLASSES.map((c) => [c, { paths: {}, uas: {}, ips: {} }])), discovery: {}, indexers: {}, crawlers: {}, distinctIps: 0 });

export function createTrafficStore(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const days = new Map();            // day -> rollup
  const ipWindow = new Map();        // ipHash -> { since, paths:Set, ua, requests, discovery:Set }
  const payers = new Map();          // payerHash -> settlements (all time, persisted)
  const dayIps = new Map();          // day -> Set(ipHash)
  let dirty = false;
  const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const rollup = (day) => { if (!days.has(day)) days.set(day, emptyDay(day)); return days.get(day); };
  const expired = (day, now) => day < dayOf(now - o.retentionDays * 864e5);
  // The database backend, decided once at construction.
  const usePg = o.backend === "file" ? false : stateDbEnabled();
  const log = typeof o.log === "function" ? o.log : console.warn;
  const say = (m) => { try { log(`[traffic] ${m}`); } catch { /* logging never throws */ } };
  let ready = Promise.resolve();
  let pgFailedOnce = false;
  const RT = () => `${stateDbSchema()}.records`;
  // Drop rollups past retention, in memory and on disk.
  function prune(now = Date.now()) {
    for (const d of [...days.keys()]) if (expired(d, now)) days.delete(d);
    for (const d of [...dayIps.keys()]) if (expired(d, now)) dayIps.delete(d);
    if (usePg) {
      // The day rows past retention. Never the payers row: 'payers' sorts
      // after every date, and the guard says so outright.
      const cutoff = dayOf(now - o.retentionDays * 864e5);
      void stateQuery(`DELETE FROM ${RT()} WHERE collection = $1 AND id <> $2 AND id < $3`, [COLLECTION, PAYERS_ID, cutoff]).catch((e) => { if (!pgFailedOnce) { pgFailedOnce = true; say(`retention delete failed: ${String(e?.message || e).slice(0, 120)}`); } });
    }
    try {
      if (!existsSync(o.dir)) return;
      for (const f of readdirSync(o.dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (m && expired(m[1], now)) { try { unlinkSync(join(o.dir, f)); } catch { /* retried next persist */ } }
      }
    } catch { /* unreadable dir */ }
  }

  /** Read the directory's files into memory (the file backend's load). */
  function loadFiles(now) {
    try {
      if (!existsSync(o.dir)) return;
      for (const f of readdirSync(o.dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) { try { const d = JSON.parse(readFileSync(join(o.dir, f), "utf8")); if (d?.day && !expired(d.day, now)) days.set(d.day, d); } catch { /* a torn file is skipped */ } }
        if (f === "payers.json") { try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(o.dir, f), "utf8")))) payers.set(k, Number(v) || 0); } catch { /* same */ } }
      }
    } catch { /* unreadable dir: start cold */ }
  }
  /** Copy the directory's files into the table, insert-if-absent (two containers booting at once are safe). */
  async function importDir(now) {
    let rows = 0, bytes = 0;
    if (!existsSync(o.dir)) return { rows, bytes };
    const put = async (id, body, file) => {
      await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO NOTHING`, [COLLECTION, id, JSON.stringify(body)]);
      rows++; try { bytes += statSync(file).size; } catch { /* counted as zero */ }
    };
    for (const f of readdirSync(o.dir)) {
      const file = join(o.dir, f);
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
        let d; try { d = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
        if (d?.day && DAY_RE.test(d.day) && !expired(d.day, now)) await put(d.day, d, file);
      } else if (f === "payers.json") {
        let j; try { j = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
        if (j && typeof j === "object") await put(PAYERS_ID, j, file);
      }
    }
    return { rows, bytes };
  }
  async function loadPg(now) {
    const imp = await importOnce(basename(o.dir), { source: o.dir, run: () => importDir(now) });
    if (imp.imported && imp.rows) say(`imported ${imp.rows} file(s) from ${o.dir}`);
    const rows = await records.list(COLLECTION, { limit: 100_000 });
    for (const { id, body } of rows) {
      if (id === PAYERS_ID) { if (body && typeof body === "object") for (const [k, v] of Object.entries(body)) if (!payers.has(k)) payers.set(k, Number(v) || 0); continue; }
      if (!DAY_RE.test(id) || expired(id, now) || !body?.day) continue;
      if (!days.has(id)) days.set(id, body); // a rollup already counting in memory is newer than the row
    }
  }
  /**
   * Read the store. Synchronous on the files; with the database it returns a
   * promise (registered with the server's boot ordering) and fills memory
   * when it resolves. Both prune first.
   */
  function load(now = Date.now()) {
    prune(now);
    if (!usePg) { loadFiles(now); return; }
    ready = trackStoreReady(loadPg(now).catch((e) => { say(`load failed: ${String(e?.message || e).slice(0, 120)}; starting cold`); }));
    return ready;
  }
  // The file writes (the file backend's persist, and the database backend's
  // write-through while the volume is there so a rollback reads current files).
  function writeFiles(bodies) {
    mkdirSync(o.dir, { recursive: true });
    for (const r of bodies.days) {
      const tmp = join(o.dir, `${r.day}.json.tmp`); writeFileSync(tmp, JSON.stringify(r)); renameSync(tmp, join(o.dir, `${r.day}.json`));
    }
    const tmp = join(o.dir, "payers.json.tmp"); writeFileSync(tmp, JSON.stringify(bodies.payers)); renameSync(tmp, join(o.dir, "payers.json"));
  }
  const bodiesNow = (now) => {
    const today = dayOf(now);
    return { days: [today, dayOf(now - 864e5)].map((d) => days.get(d)).filter(Boolean), payers: Object.fromEntries(payers) };
  };
  // Database saves coalesce: one write in flight, the newest bodies waiting,
  // so persists issued back to back land in order and a burst costs one write.
  let inFlight = null;
  let pendingBodies = null;
  function savePg(bodies) {
    pendingBodies = bodies;
    if (!inFlight) {
      inFlight = (async () => {
        while (pendingBodies) {
          const b = pendingBodies; pendingBodies = null;
          try {
            await ready;
            for (const r of b.days) await records.put(COLLECTION, r.day, r);
            await records.put(COLLECTION, PAYERS_ID, b.payers);
            pgFailedOnce = false;
            try { if (existsSync(o.dir)) writeFiles(b); } catch { /* best effort */ }
          } catch (e) {
            dirty = true; // the next persist retries with the newer rollup
            if (!pgFailedOnce) { pgFailedOnce = true; say(`persist failed: ${String(e?.message || e).slice(0, 120)}`); }
          }
        }
        inFlight = null;
      })();
    }
    return inFlight;
  }
  // `now` is injectable like record()'s: the test fixture records a fixed day,
  // and a wall-clock-only persist made it fail from the second day after.
  /** Write what changed. True when written (files) or queued (database). */
  function persist(now = Date.now()) {
    prune(now);
    if (!dirty) return false;
    if (usePg) { dirty = false; void savePg(bodiesNow(now)); return true; }
    try {
      writeFiles(bodiesNow(now));
      dirty = false; return true;
    } catch { return false; }
  }
  /** Resolves once no database write is in flight (tests and shutdown). */
  async function flush() { while (inFlight) await inFlight; }

  function record({ ip, ua, path, method, status, accept, hadPayment, hadPow, paidReceipt, payer, rail = null, powAccepted = false, now = Date.now() }) {
    const day = dayOf(now);
    const r = rollup(day);
    const ipHash = h12(ip || "-", o.salt);
    const tpath = templatePath(path);
    // sliding window per ip: distinct /api paths, discovery surfaces
    let w = ipWindow.get(ipHash);
    if (!w || now - w.since > o.windowMs) { w = { since: now, paths: new Set(), discovery: new Set(), ua: uaToken(ua), requests: 0 }; ipWindow.set(ipHash, w); if (ipWindow.size > o.ipCap) ipWindow.delete(ipWindow.keys().next().value); }
    w.requests += 1;
    const dpath0 = String(path || "").split("?")[0];
    // Discovery surfaces are not tools: an indexer that reads /api/pricing and
    // /openapi.json has walked no catalog, so they count toward `discovery`
    // and never toward the distinct-tool threshold.
    if (DISCOVERY_PATHS.has(dpath0)) w.discovery.add(dpath0);
    else if (tpath.startsWith("/api") || tpath.startsWith("/v1")) w.paths.add(tpath);
    // payer memory (hashed): a second settlement from the same payer is a repeat
    let priorPayerCount = 0;
    const payerHash = payer ? h12(String(payer), o.salt) : null;
    if (paidReceipt && payerHash) { priorPayerCount = payers.get(payerHash) || 0; if (payers.size < o.payerCap || payers.has(payerHash)) payers.set(payerHash, priorPayerCount + 1); }
    const cls = classify({ status, path: tpath, ua, accept, hadPayment, hadPow, paidReceipt, priorPayerCount, ipDistinctPaths: w.paths.size, crawlerDistinctPaths: o.crawlerDistinctPaths });
    // Per-rail outcome of every request that PRESENTED a payment credential:
    // attempts, paid, refused (402 again), errored (>= 500). Distinct payers
    // are salted hashes, never addresses; the set is capped per rail per day.
    if (rail) {
      const rails = r.rails || (r.rails = {});
      const x = rails[rail] || (rails[rail] = { attempts: 0, paid: 0, refused: 0, errored: 0, payers: {} });
      x.attempts += 1;
      if (paidReceipt || (rail === "pow" && powAccepted)) { x.paid += 1; if (payerHash && Object.keys(x.payers).length < 5000) x.payers[payerHash] = (x.payers[payerHash] || 0) + 1; }
      else if (status === 402) x.refused += 1;
      else if (status >= 500) x.errored += 1;
    }
    r.total += 1; r.classes[cls] += 1;
    const b = r.byClass[cls];
    bump(b.paths, `${method} ${tpath}`, o.keyCap); bump(b.uas, uaToken(ua), o.keyCap); bump(b.ips, ipHash, o.keyCap);
    const dpath = String(path || "").split("?")[0];
    if (DISCOVERY_PATHS.has(dpath)) bump(r.discovery, dpath, o.keyCap);
    const idx = indexerFor(ua);
    if (idx) bump(r.indexers, idx.name, o.keyCap);
    if (cls === "crawler" || idx || (w.discovery.size >= 2 && w.paths.size === 0)) {
      // Keyed by ip AND user-agent token: a shared address that carries a
      // named indexer and an unnamed walker is two callers, not one.
      const ck = `${ipHash}|${uaToken(ua)}`;
      const c = r.crawlers[ck] || (r.crawlers[ck] = { ip: ipHash, ua: uaToken(ua), requests: 0, distinctPaths: 0, discovery: 0, c402: 0, indexer: idx ? idx.name : null, wanted: idx ? idx.wanted : null });
      c.requests += 1; c.distinctPaths = Math.max(c.distinctPaths, w.paths.size); c.discovery = Math.max(c.discovery, w.discovery.size); if (status === 402) c.c402 += 1;
      if (Object.keys(r.crawlers).length > 2000) delete r.crawlers[Object.keys(r.crawlers)[0]];
    }
    if (!dayIps.has(day)) {
      // Only today's set is live (distinctIps is already saved on each day's
      // rollup); older sets used to be kept for the life of the process.
      for (const k of dayIps.keys()) if (k !== day) dayIps.delete(k);
      dayIps.set(day, new Set());
    }
    const di = dayIps.get(day); if (di.size < 200_000) di.add(ipHash); r.distinctIps = di.size;
    dirty = true;
    return cls;
  }

  function report({ days: n = 2, top = 15 } = {}) {
    const keys = [...days.keys()].sort().reverse().slice(0, n);
    return {
      generatedAt: new Date().toISOString(),
      detection: { crawlerDistinctPaths: o.crawlerDistinctPaths, windowMs: o.windowMs, classes: CLASSES, note: "ips and payers are salted sha256 prefixes; never addresses" },
      payersKnown: payers.size,
      days: keys.map((k) => {
        const r = days.get(k);
        const crawlers = Object.values(r.crawlers).map((c) => ({ ...c, verdict: c.indexer ? (c.wanted ? "known-indexer (wanted)" : "known-bot") : c.distinctPaths >= o.crawlerDistinctPaths ? "catalog-walker" : "discovery-only" })).sort((a, b) => b.requests - a.requests).slice(0, top * 2);
        return {
          day: r.day, total: r.total, distinctIps: r.distinctIps, classes: r.classes,
          shares: Object.fromEntries(Object.entries(r.classes).map(([c, v]) => [c, r.total ? Number((v / r.total).toFixed(3)) : 0])),
          discovery: topN(r.discovery, top), indexers: topN(r.indexers, top),
          rails: railSummary(r.rails),
          byClass: Object.fromEntries(Object.entries(r.byClass).map(([c, b]) => [c, { paths: topN(b.paths, top), uas: topN(b.uas, top), ips: topN(b.ips, top) }])),
          crawlers,
        };
      }),
    };
  }
  const summaryLine = (day = dayOf(Date.now() - 864e5)) => { const r = days.get(day); if (!r) return null; const rails = railSummary(r.rails); return `[traffic] ${day} total=${r.total} ` + CLASSES.map((c) => `${c}=${r.classes[c]}`).join(" ") + ` distinctIps=${r.distinctIps} crawlers=${Object.keys(r.crawlers).length}` + Object.entries(rails).map(([k, v]) => ` rail.${k}=${v.paid}/${v.attempts}paid,${v.distinctPayers}payers`).join(""); };
  return { record, report, persist, load, summaryLine, flush, ready: () => ready, backend: usePg ? "pg" : "file", _days: days, _payers: payers };
}

/** Counts only: attempts, paid, refused, errored, distinct payers and paid
 *  calls per payer, per rail. Never the payer hashes themselves. */
export function railSummary(rails) {
  const out = {};
  for (const [k, v] of Object.entries(rails || {})) {
    const distinctPayers = Object.keys(v.payers || {}).length;
    out[k] = { attempts: v.attempts, paid: v.paid, refused: v.refused, errored: v.errored, distinctPayers, paidPerPayer: distinctPayers ? Number((v.paid / distinctPayers).toFixed(2)) : null, paidRate: v.attempts ? Number((v.paid / v.attempts).toFixed(3)) : null };
  }
  return out;
}

/** Express middleware: classes every response as it finishes. `payerOf(req, res)`
 *  returns the paying wallet when the response settled (used only hashed). */
export function trafficMiddleware(store, { payerOf = () => null, log = console.log } = {}) {
  let lastDay = new Date().toISOString().slice(0, 10);
  const timer = setInterval(() => {
    store.persist();
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastDay) { const line = store.summaryLine(lastDay); if (line) log(line); lastDay = today; }
  }, DEFAULTS.persistMs);
  timer.unref?.();
  return (req, res, next) => {
    res.on("finish", () => {
      try {
        const hadPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"] || /^(Payment|Bearer a402_)/i.test(String(req.headers.authorization || "")));
        const hadPow = !!req.headers["x-pow-solution"];
        const paidReceipt = res.statusCode < 300 && !!(res.getHeader("payment-response") || res.getHeader("payment-receipt") || res.getHeader("x-credits-balance") || req.creditsSettled || req.mppTempoCredential || req.stripeSettled);
        let payer = null; try { payer = paidReceipt ? payerOf(req, res) : null; } catch { payer = null; }
        store.record({ ip: req.ip, ua: req.headers["user-agent"], path: req.originalUrl || req.url, method: req.method, status: res.statusCode, accept: req.headers.accept, hadPayment, hadPow, paidReceipt, payer, rail: railOf(req), powAccepted: res.getHeader("x-pow-accepted") === "true" });
      } catch { /* classification never breaks a response */ }
    });
    next();
  };
}
