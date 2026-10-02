// Search-engine data pipeline: Google Search Console + Bing Webmaster Tools
// pulled daily into Postgres, with a weekly summary for the operator surface.
//
// Env-gated. Google needs GSC_SERVICE_ACCOUNT_JSON; Bing needs
// BING_WEBMASTER_API_KEY; storage needs DATABASE_URL. Anything missing makes
// that part a no-op. SEARCH_DATA=off disarms the scheduler.
//
// Row convention in search_daily (query/page are '' when not a dimension):
//   query='' page=''  site total for the day
//   query='' page=X   page total
//   query=X  page=''  query total (Bing)
//   query=X  page=X   query+page pair (Google)
import { createSign } from "node:crypto";

export const GSC_SCOPE_READ = "https://www.googleapis.com/auth/webmasters.readonly";
export const GSC_SCOPE_WRITE = "https://www.googleapis.com/auth/webmasters";
const GSC_API = "https://www.googleapis.com/webmasters/v3";
const INSPECT_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";
export const GSC_ROW_LIMIT = 25_000;
const DAY_MS = 86_400_000;

export const dayStr = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (day, n) => dayStr(Date.parse(day + "T00:00:00Z") + n * DAY_MS);

export function readConfig(env = process.env) {
  let sa = null, saError = null;
  const raw = (env.GSC_SERVICE_ACCOUNT_JSON || "").trim();
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (!j.client_email || !j.private_key) throw new Error("missing client_email or private_key");
      sa = { clientEmail: j.client_email, privateKey: j.private_key, keyId: j.private_key_id || null, tokenUri: j.token_uri || "https://oauth2.googleapis.com/token" };
    } catch (e) {
      // A fixed message: JSON.parse errors can quote the start of the value.
      saError = /missing client_email/.test(e.message) ? "GSC_SERVICE_ACCOUNT_JSON is missing client_email or private_key" : "GSC_SERVICE_ACCOUNT_JSON is not valid JSON";
    }
  }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: String(env.SEARCH_DATA || "").toLowerCase() !== "off",
    google: sa,
    googleError: saError,
    gscSite: (env.GSC_SITE_URL || "sc-domain:agent402.tools").trim(),
    bingKey: (env.BING_WEBMASTER_API_KEY || "").trim() || null,
    bingSite: (env.BING_SITE_URL || "https://agent402.tools/").trim(),
    sitemapUrl: (env.SEARCH_SITEMAP_URL || "https://agent402.tools/sitemapindex.xml").trim(),
    submitSitemap: ["1", "on", "true", "yes"].includes(String(env.SEARCH_SUBMIT_SITEMAP || "").toLowerCase()),
    lookbackDays: num(env.SEARCH_DATA_LOOKBACK_DAYS, 3),
    backfillMonths: Math.min(16, num(env.SEARCH_DATA_BACKFILL_MONTHS, 16)),
    backfillChunkDays: num(env.SEARCH_DATA_BACKFILL_CHUNK_DAYS, 30),
    maxRequestsPerRun: num(env.SEARCH_DATA_MAX_REQUESTS, 400),
  };
}

// ---------- Google auth ----------
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function buildJwtAssertion(sa, scope, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT", ...(sa.keyId ? { kid: sa.keyId } : {}) };
  const claims = { iss: sa.clientEmail, scope, aud: sa.tokenUri, iat: nowSec, exp: nowSec + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  return `${input}.${b64url(signer.sign(sa.privateKey))}`;
}

async function readJson(res, label) {
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  if (!res.ok) {
    const msg = j?.error?.message || j?.error_description || j?.Message || text.slice(0, 200);
    const e = new Error(`${label} HTTP ${res.status}: ${String(msg).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return j ?? {};
}

// ---------- store (Postgres) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_daily (
  source TEXT NOT NULL, day DATE NOT NULL, query TEXT NOT NULL DEFAULT '', page TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0,
  ctr DOUBLE PRECISION NOT NULL DEFAULT 0, position DOUBLE PRECISION,
  PRIMARY KEY (source, day, query, page)
);
CREATE INDEX IF NOT EXISTS search_daily_day_idx ON search_daily (source, day);
CREATE TABLE IF NOT EXISTS search_index_snapshot (
  source TEXT NOT NULL, day DATE NOT NULL, metric TEXT NOT NULL, value DOUBLE PRECISION,
  PRIMARY KEY (source, day, metric)
);`;

export function createPgStore(databaseUrl = process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL || "") {
  if (!databaseUrl) return null;
  let pool = null, ready = null;
  const getPool = async () => {
    if (pool) return pool;
    const pg = (await import("pg")).default;
    const { dbSsl } = await import("./db-ssl.js");
    pool = new pg.Pool({ connectionString: databaseUrl, ssl: dbSsl(databaseUrl), max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 20_000 });
    pool.on("error", (e) => console.error("[search-data] pool error:", e.message));
    return pool;
  };
  const q = async (sql, params) => {
    const p = await getPool();
    if (!ready) ready = p.query(SCHEMA).catch((e) => { ready = null; throw e; });
    await ready;
    return p.query(sql, params);
  };
  return {
    kind: "pg",
    async upsertDaily(input) {
      // One statement cannot touch the same key twice; last row wins.
      const rows = [...new Map(input.map((r) => [`${r.source}|${r.day}|${r.query || ""}|${r.page || ""}`, r])).values()];
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const part = rows.slice(i, i + 500);
        const vals = [], params = [];
        part.forEach((r, k) => {
          const b = k * 8;
          vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
          params.push(r.source, r.day, r.query || "", r.page || "", r.clicks | 0, r.impressions | 0, Number(r.ctr) || 0, r.position ?? null);
        });
        await q(`INSERT INTO search_daily (source, day, query, page, clicks, impressions, ctr, position) VALUES ${vals.join(",")}
          ON CONFLICT (source, day, query, page) DO UPDATE SET clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions, ctr=EXCLUDED.ctr, position=EXCLUDED.position`, params);
        n += part.length;
      }
      return n;
    },
    async upsertSnapshot(rows) {
      for (const r of rows) {
        await q(`INSERT INTO search_index_snapshot (source, day, metric, value) VALUES ($1,$2,$3,$4)
          ON CONFLICT (source, day, metric) DO UPDATE SET value=EXCLUDED.value`, [r.source, r.day, r.metric, r.value]);
      }
      return rows.length;
    },
    async getSnapshot(source, metric) {
      const r = await q(`SELECT day::text AS day, value FROM search_index_snapshot WHERE source=$1 AND metric=$2 ORDER BY day DESC LIMIT 1`, [source, metric]);
      return r.rows[0] || null;
    },
    async latestSnapshots(source) {
      const r = await q(`SELECT s.metric, s.day::text AS day, s.value FROM search_index_snapshot s
        JOIN (SELECT metric, max(day) AS day FROM search_index_snapshot WHERE source=$1 GROUP BY metric) m
        ON m.metric=s.metric AND m.day=s.day WHERE s.source=$1 ORDER BY s.metric`, [source]);
      return r.rows;
    },
    async maxDay(source) {
      const r = await q(`SELECT max(day)::text AS d FROM search_daily WHERE source=$1`, [source]);
      return r.rows[0]?.d || null;
    },
    async readRange(source, from, to) {
      const r = await q(`SELECT day::text AS day, query, page, clicks, impressions, ctr, position FROM search_daily
        WHERE source=$1 AND day BETWEEN $2 AND $3`, [source, from, to]);
      return r.rows.map((x) => ({ ...x, source }));
    },
  };
}

// In-memory store with the same interface (tests, and a DB-less boot).
export function createMemoryStore() {
  const daily = new Map(), snaps = new Map();
  return {
    kind: "memory",
    daily, snaps,
    async upsertDaily(rows) {
      for (const r of rows) daily.set(`${r.source}|${r.day}|${r.query || ""}|${r.page || ""}`, { source: r.source, day: r.day, query: r.query || "", page: r.page || "", clicks: r.clicks | 0, impressions: r.impressions | 0, ctr: Number(r.ctr) || 0, position: r.position ?? null });
      return rows.length;
    },
    async upsertSnapshot(rows) { for (const r of rows) snaps.set(`${r.source}|${r.day}|${r.metric}`, { ...r }); return rows.length; },
    async getSnapshot(source, metric) {
      const hits = [...snaps.values()].filter((s) => s.source === source && s.metric === metric).sort((a, b) => b.day.localeCompare(a.day));
      return hits[0] ? { day: hits[0].day, value: hits[0].value } : null;
    },
    async latestSnapshots(source) {
      const best = new Map();
      for (const s of snaps.values()) if (s.source === source && (!best.has(s.metric) || best.get(s.metric).day < s.day)) best.set(s.metric, s);
      return [...best.values()].map(({ metric, day, value }) => ({ metric, day, value })).sort((a, b) => a.metric.localeCompare(b.metric));
    },
    async maxDay(source) {
      let m = null;
      for (const r of daily.values()) if (r.source === source && (!m || r.day > m)) m = r.day;
      return m;
    },
    async readRange(source, from, to) { return [...daily.values()].filter((r) => r.source === source && r.day >= from && r.day <= to); },
  };
}

// ---------- weekly summary (pure) ----------
function aggregate(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const a = m.get(k) || { key: k, clicks: 0, impressions: 0, posWeight: 0 };
    a.clicks += Number(r.clicks) || 0;
    a.impressions += Number(r.impressions) || 0;
    if (r.position != null && Number(r.position) > 0) a.posWeight += Number(r.position) * (Number(r.impressions) || 0);
    m.set(k, a);
  }
  for (const a of m.values()) finish(a);
  return m;
}
function finish(a) {
  a.ctr = a.impressions ? a.clicks / a.impressions : 0;
  a.position = a.impressions && a.posWeight ? a.posWeight / a.impressions : null;
  delete a.posWeight;
  return a;
}
const round = (n, d = 4) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (a, b) => (b ? (a - b) / b : null);

function movers(cur, prev, limit) {
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const list = [...keys].map((k) => {
    const c = cur.get(k) || { clicks: 0, impressions: 0, position: null };
    const p = prev.get(k) || { clicks: 0, impressions: 0, position: null };
    return { key: k, clicks: c.clicks, prevClicks: p.clicks, clicksDelta: c.clicks - p.clicks, impressions: c.impressions, prevImpressions: p.impressions, impressionsDelta: c.impressions - p.impressions, position: round(c.position, 1), prevPosition: round(p.position, 1) };
  });
  const score = (x) => x.clicksDelta * 1000 + x.impressionsDelta;
  return {
    gainers: list.filter((x) => score(x) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit),
    losers: list.filter((x) => score(x) < 0).sort((a, b) => score(a) - score(b)).slice(0, limit),
  };
}

// Summary for one source over [end-6, end] vs the 7 days before.
export function computeWeeklySummary(rows, { end, limit = 15, lowCtrMinImpressions = 100, lowCtrMax = 0.01, lowCtrMaxPosition = 20 } = {}) {
  if (!end) return { empty: true };
  const curFrom = addDays(end, -6), prevFrom = addDays(end, -13), prevTo = addDays(end, -7);
  const cur = rows.filter((r) => r.day >= curFrom && r.day <= end);
  const prev = rows.filter((r) => r.day >= prevFrom && r.day <= prevTo);
  const totals = (set) => {
    let site = set.filter((r) => !r.query && !r.page);
    if (!site.length) site = set.filter((r) => !r.query && r.page); // fall back to page rows
    return finish(site.reduce((a, r) => { a.clicks += Number(r.clicks) || 0; a.impressions += Number(r.impressions) || 0; if (r.position != null && Number(r.position) > 0) a.posWeight += Number(r.position) * (Number(r.impressions) || 0); return a; }, { clicks: 0, impressions: 0, posWeight: 0 }));
  };
  const tc = totals(cur), tp = totals(prev);
  const byQuery = (set) => aggregate(set.filter((r) => r.query), (r) => r.query);
  const byPage = (set) => aggregate(set.filter((r) => !r.query && r.page), (r) => r.page);
  const qc = byQuery(cur), qp = byQuery(prev), pc = byPage(cur), pp = byPage(prev);
  const qm = movers(qc, qp, limit), pm = movers(pc, pp, limit);
  const newPages = [...pc.values()].filter((a) => a.impressions > 0 && !(pp.get(a.key)?.impressions > 0))
    .sort((a, b) => b.impressions - a.impressions).slice(0, limit).map((a) => ({ page: a.key, impressions: a.impressions, clicks: a.clicks, position: round(a.position, 1) }));
  const droppedPages = [...pp.values()].filter((a) => a.impressions > 0 && !(pc.get(a.key)?.impressions > 0))
    .sort((a, b) => b.impressions - a.impressions).slice(0, limit).map((a) => ({ page: a.key, prevImpressions: a.impressions, prevClicks: a.clicks }));
  const lowCtr = [...pc.values()].filter((a) => a.impressions >= lowCtrMinImpressions && a.ctr < lowCtrMax && (a.position == null || a.position <= lowCtrMaxPosition))
    .sort((a, b) => b.impressions - a.impressions).slice(0, limit).map((a) => ({ page: a.key, impressions: a.impressions, clicks: a.clicks, ctr: round(a.ctr), position: round(a.position, 1) }));
  return {
    window: { from: curFrom, to: end, prevFrom, prevTo },
    totals: {
      clicks: tc.clicks, prevClicks: tp.clicks, clicksChange: round(pct(tc.clicks, tp.clicks)),
      impressions: tc.impressions, prevImpressions: tp.impressions, impressionsChange: round(pct(tc.impressions, tp.impressions)),
      ctr: round(tc.ctr), prevCtr: round(tp.ctr),
      position: round(tc.position, 2), prevPosition: round(tp.position, 2),
    },
    queries: { gaining: qm.gainers, losing: qm.losers, distinct: qc.size },
    pages: { gaining: pm.gainers, losing: pm.losers, distinct: pc.size, new: newPages, dropped: droppedPages },
    lowCtrPages: lowCtr,
    thresholds: { lowCtrMinImpressions, lowCtrMax, lowCtrMaxPosition },
  };
}

// ---------- Bing parsing ----------
export function parseBingDate(v) {
  const m = String(v || "").match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (m) return dayStr(Number(m[1]));
  const t = Date.parse(v);
  return Number.isFinite(t) ? dayStr(t) : null;
}
const bingPos = (r) => { const p = Number(r.AvgImpressionPosition ?? r.AvgClickPosition); return Number.isFinite(p) && p > 0 ? p : null; };
const bingRow = (day, query, page, r) => {
  const clicks = Number(r.Clicks) || 0, impressions = Number(r.Impressions) || 0;
  return { source: "bing", day, query, page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: bingPos(r) };
};

// ---------- pipeline ----------
export function createSearchData({ env = process.env, fetchImpl = globalThis.fetch, store, now = () => Date.now(), log = console.log } = {}) {
  const cfg = readConfig(env);
  const db = store === undefined ? createPgStore() : store;
  const tokens = new Map(); // scope -> { token, exp }
  const state = { lastRunAt: null, lastRunDay: null, lastResult: null, running: false, inspectLog: [] };
  let requests = 0;

  const googleOn = () => Boolean(cfg.google);
  const bingOn = () => Boolean(cfg.bingKey);

  async function googleToken(scope = GSC_SCOPE_READ) {
    const hit = tokens.get(scope);
    const nowSec = Math.floor(now() / 1000);
    if (hit && hit.exp - 60 > nowSec) return hit.token;
    const assertion = buildJwtAssertion(cfg.google, scope, nowSec);
    const res = await fetchImpl(cfg.google.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await readJson(res, "google token");
    if (!j.access_token) throw new Error("google token: no access_token in response");
    tokens.set(scope, { token: j.access_token, exp: nowSec + (Number(j.expires_in) || 3600) });
    return j.access_token;
  }

  async function gfetch(url, { method = "GET", body, scope, counted = true } = {}) {
    if (counted && ++requests > cfg.maxRequestsPerRun) throw new Error("request budget for this run exhausted");
    const token = await googleToken(scope);
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    return readJson(res, `google ${method} ${new URL(url).pathname.split("/").slice(-1)[0]}`);
  }

  const siteBase = () => `${GSC_API}/sites/${encodeURIComponent(cfg.gscSite)}`;

  // All rows for one date range + dimension set, paginated by startRow.
  async function gscQuery(startDate, endDate, dimensions) {
    const out = [];
    for (let startRow = 0; ; startRow += GSC_ROW_LIMIT) {
      const j = await gfetch(`${siteBase()}/searchAnalytics/query`, {
        method: "POST",
        body: { startDate, endDate, dimensions, type: "web", dataState: "all", rowLimit: GSC_ROW_LIMIT, startRow },
      });
      const rows = j.rows || [];
      for (const r of rows) {
        const k = Object.fromEntries(dimensions.map((d, i) => [d, r.keys?.[i] ?? ""]));
        out.push({ source: "google", day: k.date, query: k.query || "", page: k.page || "", clicks: r.clicks | 0, impressions: r.impressions | 0, ctr: Number(r.ctr) || 0, position: r.position ?? null });
      }
      if (rows.length < GSC_ROW_LIMIT) break;
    }
    return out;
  }

  async function pullGoogleRange(from, to) {
    let n = 0;
    for (const dims of [["date"], ["date", "page"], ["date", "query", "page"]]) {
      const rows = await gscQuery(from, to, dims);
      n += await db.upsertDaily(rows);
    }
    return n;
  }

  // Backfill chunks, newest first, from `oldest` to `newest` inclusive.
  function backfillChunks(oldest, newest, size = cfg.backfillChunkDays) {
    const chunks = [];
    for (let end = newest; end >= oldest; end = addDays(end, -size)) {
      const start = addDays(end, -(size - 1));
      chunks.push([start < oldest ? oldest : start, end]);
    }
    return chunks;
  }

  async function listSitemaps() {
    const j = await gfetch(`${siteBase()}/sitemaps`);
    return j.sitemap || [];
  }

  async function submitGoogleSitemap(feed = cfg.sitemapUrl) {
    await gfetch(`${siteBase()}/sitemaps/${encodeURIComponent(feed)}`, { method: "PUT", scope: GSC_SCOPE_WRITE, counted: false });
    return { ok: true, feed };
  }

  function sitemapSnapshots(list, day) {
    const rows = [];
    for (const s of list) {
      const name = String(s.path || "").replace(/^https?:\/\/[^/]+/, "") || "?";
      rows.push({ source: "google", day, metric: `sitemap:${name}:errors`, value: Number(s.errors) || 0 });
      rows.push({ source: "google", day, metric: `sitemap:${name}:warnings`, value: Number(s.warnings) || 0 });
      for (const c of s.contents || []) {
        rows.push({ source: "google", day, metric: `sitemap:${name}:${c.type || "web"}:submitted`, value: Number(c.submitted) || 0 });
        if (c.indexed != null) rows.push({ source: "google", day, metric: `sitemap:${name}:${c.type || "web"}:indexed`, value: Number(c.indexed) || 0 });
      }
    }
    return rows;
  }

  async function syncGoogle() {
    const today = dayStr(now());
    const to = addDays(today, -1), from = addDays(today, -cfg.lookbackDays);
    const r = { recent: 0, backfill: 0, backfillChunks: 0, sitemaps: 0 };
    r.recent = await pullGoogleRange(from, to);
    const done = await db.getSnapshot("google", "backfill_done");
    if (!done) {
      // Resumable: backfill_cursor holds the oldest day already pulled (as a day number).
      const oldest = addDays(today, -Math.floor(cfg.backfillMonths * 30.4));
      const cursor = await db.getSnapshot("google", "backfill_cursor");
      const newest = cursor ? addDays(dayStr(cursor.value * DAY_MS), -1) : addDays(from, -1);
      for (const [s, e] of backfillChunks(oldest, newest)) {
        r.backfill += await pullGoogleRange(s, e);
        r.backfillChunks++;
        await db.upsertSnapshot([{ source: "google", day: today, metric: "backfill_cursor", value: Math.round(Date.parse(s + "T00:00:00Z") / DAY_MS) }]);
      }
      await db.upsertSnapshot([{ source: "google", day: today, metric: "backfill_done", value: 1 }]);
    }
    try {
      const maps = await listSitemaps();
      r.sitemaps = maps.length;
      if (db) await db.upsertSnapshot(sitemapSnapshots(maps, today));
    } catch (e) { r.sitemapError = e.message; }
    if (cfg.submitSitemap) {
      try { await submitGoogleSitemap(); r.sitemapSubmitted = true; } catch (e) { r.sitemapSubmitError = e.message; }
    }
    return r;
  }

  async function bing(method, params = {}, { post = null, counted = true } = {}) {
    if (counted && ++requests > cfg.maxRequestsPerRun) throw new Error("request budget for this run exhausted");
    const qs = new URLSearchParams({ apikey: cfg.bingKey, ...params });
    const res = await fetchImpl(`${BING_API}/${method}?${qs}`, {
      method: post ? "POST" : "GET",
      headers: post ? { "Content-Type": "application/json; charset=utf-8" } : {},
      body: post ? JSON.stringify(post) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const j = await readJson(res, `bing ${method}`);
    return j.d ?? j;
  }

  async function syncBing() {
    const site = cfg.bingSite, today = dayStr(now());
    const r = { traffic: 0, queries: 0, pages: 0, crawl: 0 };
    const rows = [];
    for (const t of (await bing("GetRankAndTrafficStats", { siteUrl: site })) || []) {
      const day = parseBingDate(t.Date);
      if (day) { rows.push(bingRow(day, "", "", t)); r.traffic++; }
    }
    for (const q of (await bing("GetQueryStats", { siteUrl: site })) || []) {
      const day = parseBingDate(q.Date);
      if (day && q.Query) { rows.push(bingRow(day, String(q.Query), "", q)); r.queries++; }
    }
    for (const p of (await bing("GetPageStats", { siteUrl: site })) || []) {
      const day = parseBingDate(p.Date);
      if (day && p.Query) { rows.push(bingRow(day, "", String(p.Query), p)); r.pages++; }
    }
    if (db) await db.upsertDaily(rows);
    try {
      const crawl = (await bing("GetCrawlStats", { siteUrl: site })) || [];
      const snaps = [];
      for (const c of crawl) {
        const day = parseBingDate(c.Date);
        if (!day) continue;
        for (const [k, v] of Object.entries(c)) if (k !== "Date" && typeof v === "number") snaps.push({ source: "bing", day, metric: `crawl:${k}`, value: v });
      }
      r.crawl = crawl.length;
      try {
        const issues = (await bing("GetCrawlIssues", { siteUrl: site })) || [];
        snaps.push({ source: "bing", day: today, metric: "crawl_issues", value: Array.isArray(issues) ? issues.length : 0 });
      } catch (e) { r.crawlIssuesError = e.message; }
      if (db) await db.upsertSnapshot(snaps);
    } catch (e) { r.crawlError = e.message; }
    if (cfg.submitSitemap) {
      try { await submitBingSitemap(); r.sitemapSubmitted = true; } catch (e) { r.sitemapSubmitError = e.message; }
    }
    return r;
  }

  async function submitBingSitemap(feed = cfg.sitemapUrl) {
    await bing("SubmitFeed", {}, { post: { siteUrl: cfg.bingSite, feedUrl: feed }, counted: false });
    return { ok: true, feed };
  }

  async function runOnce() {
    if (state.running) return { ok: false, reason: "already-running" };
    if (!googleOn() && !bingOn()) return { ok: false, reason: "not-configured" };
    if (!db) return { ok: false, reason: "no-db" };
    state.running = true;
    requests = 0;
    const result = { at: new Date(now()).toISOString(), store: db ? db.kind : "none" };
    try {
      if (googleOn()) { try { result.google = await syncGoogle(); } catch (e) { result.google = { error: e.message }; log(`[search-data] google sync failed: ${e.message}`); } }
      if (bingOn()) { try { result.bing = await syncBing(); } catch (e) { result.bing = { error: e.message }; log(`[search-data] bing sync failed: ${e.message}`); } }
      result.requests = requests;
      result.ok = !result.google?.error && !result.bing?.error;
      return result;
    } finally {
      state.running = false;
      state.lastRunAt = result.at;
      state.lastRunDay = dayStr(now());
      state.lastResult = result;
    }
  }

  // URL Inspection, capped per call and per day (Google allows 2,000/day).
  async function inspectUrls(urls, { max = 20, dailyCap = 500 } = {}) {
    if (!googleOn()) return { ok: false, reason: "not-configured" };
    const list = [...new Set((urls || []).map(String).filter((u) => /^https?:\/\//.test(u)))].slice(0, max);
    const today = dayStr(now());
    state.inspectLog = state.inspectLog.filter((d) => d === today);
    const results = [];
    for (const url of list) {
      if (state.inspectLog.length >= dailyCap) { results.push({ url, error: "daily inspection cap reached" }); continue; }
      state.inspectLog.push(today);
      try {
        const j = await gfetch(INSPECT_API, { method: "POST", body: { inspectionUrl: url, siteUrl: cfg.gscSite }, counted: false });
        const ir = j.inspectionResult?.indexStatusResult || {};
        results.push({ url, verdict: ir.verdict || null, coverageState: ir.coverageState || null, indexingState: ir.indexingState || null, lastCrawlTime: ir.lastCrawlTime || null, googleCanonical: ir.googleCanonical || null, userCanonical: ir.userCanonical || null, robotsTxtState: ir.robotsTxtState || null, pageFetchState: ir.pageFetchState || null });
      } catch (e) { results.push({ url, error: e.message }); }
    }
    return { ok: true, results };
  }

  async function submitSitemaps() {
    const out = {};
    if (googleOn()) { try { out.google = await submitGoogleSitemap(); } catch (e) { out.google = { error: e.message }; } }
    if (bingOn()) { try { out.bing = await submitBingSitemap(); } catch (e) { out.bing = { error: e.message }; } }
    return out;
  }

  async function summary(opts = {}) {
    const out = { generatedAt: new Date(now()).toISOString(), status: status(), sources: {} };
    if (!db) return { ...out, note: "no database configured" };
    for (const source of ["google", "bing"]) {
      if (source === "google" && !googleOn()) continue;
      if (source === "bing" && !bingOn()) continue;
      try {
        const end = await db.maxDay(source);
        if (!end) { out.sources[source] = { empty: true }; continue; }
        const rows = await db.readRange(source, addDays(end, -13), end);
        out.sources[source] = { ...computeWeeklySummary(rows, { end, ...opts }), index: await db.latestSnapshots(source) };
      } catch (e) { out.sources[source] = { error: e.message }; }
    }
    return out;
  }

  function status() {
    return {
      enabled: cfg.enabled,
      google: googleOn() ? { site: cfg.gscSite } : { configured: false, ...(cfg.googleError ? { error: cfg.googleError } : {}) },
      bing: bingOn() ? { site: cfg.bingSite } : { configured: false },
      store: db ? db.kind : "none",
      submitSitemap: cfg.submitSitemap,
      lastRunAt: state.lastRunAt,
      lastResult: state.lastResult,
      running: state.running,
    };
  }

  // Daily: first check a few minutes after boot, then every 6 hours, running
  // at most once per UTC day.
  function start({ firstDelayMs = 5 * 60_000, everyMs = 6 * 3_600_000 } = {}) {
    if (!cfg.enabled) { log("[search-data] disabled (SEARCH_DATA=off)"); return null; }
    if (!googleOn() && !bingOn()) { log(`[search-data] not configured (no GSC_SERVICE_ACCOUNT_JSON or BING_WEBMASTER_API_KEY)${cfg.googleError ? `; ${cfg.googleError}` : ""}`); return null; }
    if (!db) { log("[search-data] not started: no DATABASE_URL"); return null; }
    const tick = () => {
      if (state.lastRunDay === dayStr(now())) return;
      runOnce().catch((e) => log(`[search-data] run threw: ${e.message}`));
    };
    const first = setTimeout(tick, firstDelayMs);
    first.unref?.();
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    log(`[search-data] scheduler armed (google ${googleOn() ? "on" : "off"}, bing ${bingOn() ? "on" : "off"}, store ${db ? db.kind : "none"})`);
    return { first, timer, stop: () => { clearTimeout(first); clearInterval(timer); } };
  }

  return { config: cfg, runOnce, summary, status, inspectUrls, submitSitemaps, listSitemaps, start, googleToken, backfillChunks, _gscQuery: gscQuery };
}
