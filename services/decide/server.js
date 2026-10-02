// The decide service: a separate Railway service that owns the decision
// index and (from phase 2) plan building. It never settles a payment and
// never sits in the paid-call path of any other route: the main app verifies
// payment, then calls this service over the private network with a timeout.
//
// Env:
//   PORT                     listen port
//   DECIDE_INTERNAL_TOKEN    shared secret with the main app (both directions)
//   DECIDE_SOURCE_URL        main app base, e.g. http://agent402.railway.internal:8080
//   DECIDE_DATABASE_URL      Postgres (falls back to DATABASE_URL); unset = memory only
//   OPENAI_API_KEY           embeddings
//   TYPESAFE_API_KEY         fit judging by the judgment model (DECIDE_TYPESAFE_API_KEY wins)
//   DECIDE_SYNC_MS           index sync period (default 30 min)

import http from "node:http";
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ToolIndex } from "./tool-index.js";
import { PgToolStore, MemoryToolStore } from "./tool-store.js";
import { migrate } from "./migrations.js";
import { syncIndex, loadIndex } from "./sync.js";
import { embedTexts, embedBudgetStatus } from "./embed.js";
import { decideConfig } from "../../src/decide/config.js";
import { makeLlm, judgeText } from "./llm.js";
import { makeJevJudge } from "./jev.js";
import { buildDecision, parseDecideInput, cacheKeyFor } from "./planner.js";
import { MemoryDecisionStore, PgDecisionStore, makeGate, makeDecisionCache } from "./decision-store.js";
import { randomUUID } from "node:crypto";
import { Reliability, persistReliability } from "./reliability.js";

const PORT = Number(process.env.PORT) || 8090;
const TOKEN = String(process.env.DECIDE_INTERNAL_TOKEN || "");
const SOURCE = String(process.env.DECIDE_SOURCE_URL || "").replace(/\/+$/, "");
const DB_URL = process.env.DECIDE_DATABASE_URL || process.env.DATABASE_URL || "";
const SYNC_MS = Number(process.env.DECIDE_SYNC_MS) || 30 * 60_000;
const MAX_BODY = 16 * 1024;

export const state = { index: new ToolIndex(), store: null, pool: null, lastSync: null, syncing: false, bootedAt: Date.now(), loadedRows: 0,
  decisions: new MemoryDecisionStore(), reliability: new Reliability(), llm: null, jev: null, gate: makeGate(Number(process.env.DECIDE_MAX_CONCURRENT) || 4, Number(process.env.DECIDE_MAX_QUEUE) || 16),
  cache: makeDecisionCache(decideConfig().cacheTtlMs) };

const newDecisionId = () => `dec_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Build (or reuse from cache) a decision. A cache hit is a new decision with
 *  its own id: the caller paid for it, so it is recorded like any other. */
/** Ready once the index has loaded rows or completed a sync: before that a
 *  decision would be an empty plan sold as an answer. */
export const isReady = () => state.loadedRows > 0 || state.lastSync?.complete === true;

export async function decide(body, { now = Date.now() } = {}) {
  if (!isReady()) throw Object.assign(new Error("the decision index is still loading - retry shortly"), { statusCode: 503, retryAfter: 30 });
  const input = parseDecideInput(body);
  // The caller's own deadline: past it the main app has already answered (503,
  // not charged), so any work still queued here would be spend for nothing.
  const callerDeadline = Number.isFinite(Number(body?.deadlineAt)) ? Number(body.deadlineAt) : Infinity;
  const late = () => Object.assign(new Error("decision deadline passed"), { statusCode: 503 });
  if (Date.now() >= callerDeadline) throw late();
  const cfg = decideConfig();
  const key = cacheKeyFor(input.task, input.constraints, input.depth);
  let result = state.cache.get(key, now);
  let cached = false;
  const meter = [];
  const t0 = Date.now();
  if (result) {
    result = { ...structuredClone(result), decisionId: newDecisionId() };
    cached = true;
  } else {
    result = await state.gate.run(() => Date.now() >= callerDeadline - 500 ? Promise.reject(late()) : buildDecision(input, {
      index: state.index,
      embed: (t, o) => embedTexts(t, o),
      meter,
      llm: state.llm || (state.llm = makeLlm({ models: [cfg.model, cfg.modelFallback] })),
      judge: (state.jev || (state.jev = makeJevJudge())).judge,
      choose: (t, items, o) => state.jev.choose(t, items, { ...o, textOf: judgeText }),
      checkParams: (t, items, o) => state.jev.checkParams(t, items, { ...o, textOf: judgeText }),
      reliability: (id) => state.reliability.get(id),
      cfg, now,
      deadline: Math.min(now + cfg.budgetMs[input.depth], callerDeadline - 500),
    }));
    if (!result.partial) state.cache.set(key, result, now);
  }
  const { _rankingLog, ...pub } = result;
  const cost = summarizeCost(meter, { cached, depth: input.depth, ms: Date.now() - t0, partial: !!result.partial });
  await state.decisions.save(pub, { constraints: input.constraints, cacheKey: key, payer: body.payer || null, rail: body.rail || null, priceUsd: Number(body.priceUsd) || 0, rankingLog: _rankingLog || [], cost });
  return { ...pub, cached };
}

/** The private network, loopback, or an explicit sslmode=disable: no TLS. */
export function plainDbConnection(url) {
  try {
    const u = new URL(url);
    return /\.railway\.internal$/.test(u.hostname) || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || u.searchParams.get("sslmode") === "disable";
  } catch { return false; }
}

/** One decision's serving cost, from the meter. Kept with the decision in the
 *  service's own store; never part of the response the main app forwards. */
export function summarizeCost(meter, { cached = false, depth = "", ms = 0, partial = false } = {}) {
  const llm = meter.filter((m) => m.stage !== "embed_query");
  const emb = meter.filter((m) => m.stage === "embed_query");
  const sum = (a, k) => a.reduce((t, m) => t + (Number(m[k]) || 0), 0);
  return {
    depth, cached, partial, ms,
    modelCalls: llm.filter((m) => m.outcome !== "skipped_no_budget").length,
    fallbackUsed: llm.some((m) => m.attempt > 0 && m.outcome === "ok"),
    failedAttempts: llm.filter((m) => m.outcome !== "ok" && m.outcome !== "skipped_no_budget").map((m) => `${m.stage}:${m.model}:${m.outcome}`),
    promptTokens: sum(llm, "promptTokens"), completionTokens: sum(llm, "completionTokens"), cachedTokens: sum(llm, "cachedTokens"),
    modelUsd: Math.round(sum(llm, "costUsd") * 1e8) / 1e8,
    modelUsdUnknown: llm.some((m) => m.outcome === "ok" && m.costUsd === null),
    embedTokens: sum(emb, "tokens"),
    calls: meter,
  };
}

function tokenOk(req) {
  if (TOKEN.length < 24) return false;
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

// The shared token is only ever sent over TLS or the private network.
export function safeInternalUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (/\.railway\.internal$/.test(x.hostname) || x.hostname === "127.0.0.1" || x.hostname === "localhost");
  } catch { return false; }
}

async function source() {
  if (!safeInternalUrl(SOURCE)) throw new Error("DECIDE_SOURCE_URL must be https or a private-network address");
  const res = await fetch(`${SOURCE}/__internal/decide/tools.ndjson`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw Object.assign(new Error(`index source HTTP ${res.status}`), { status: res.status, retryAfterS: Number(res.headers.get("retry-after")) || null });
  return res.body;
}

export async function runSync() {
  if (state.syncing || !SOURCE || TOKEN.length < 24) return null;
  state.syncing = true;
  try {
    state.lastSync = await syncIndex({ index: state.index, store: state.store, source, embed: (t) => embedTexts(t) });
    console.log("[decide] sync", JSON.stringify(state.lastSync));
  } catch (e) {
    state.lastSync = { error: String(e?.message || e).slice(0, 200), at: Date.now() };
    console.warn("[decide] sync failed:", state.lastSync.error);
    // The main app answers 503 while its index is still loading: try again
    // soon rather than at the next full period (bounded, at most 5 minutes).
    if (e?.status === 503) setTimeout(runSync, Math.min(300, Math.max(15, e.retryAfterS || 30)) * 1000).unref();
  } finally {
    state.syncing = false;
  }
  return state.lastSync;
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error("body too large"), { statusCode: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
}

export const routes = {
  // Public health says only that the service is up; details need the token.
  // Liveness by default; `?ready=1` answers 503 until the index can serve.
  "GET /health": async (req) => (/[?&]ready=1\b/.test(req.url) && !isReady() ? Promise.reject(Object.assign(new Error("not ready"), { statusCode: 503 })) : tokenOk(req)
    ? { ok: true, ready: isReady(), rows: state.index.size, vectors: state.index.vectors.count, lastSync: state.lastSync, embed: embedBudgetStatus(), db: !!state.pool, gate: state.gate.stats(), llm: state.llm?.stats() || null, cached: state.cache.size() }
    : { ok: true }),
  "POST /internal/search": async (req) => {
    const b = await readJson(req);
    const query = String(b.query || "").slice(0, 500);
    if (!query) throw Object.assign(new Error('"query" is required'), { statusCode: 400 });
    let queryVec = null;
    try { [queryVec] = await embedTexts([query]); } catch { /* lexical-only */ }
    const r = state.index.search({ query, queryVec, constraints: b.constraints || {}, k: Math.min(50, Number(b.k) || 20) });
    return { mode: r.mode, candidates: r.candidates, hits: r.hits.map((h) => ({ id: h.id, rrf: h.rrf, slug: h.row.slug, seller: h.row.seller, firstParty: h.row.firstParty, priceUsd: h.row.priceUsd, name: h.row.name })) };
  },
  "POST /internal/sync": async () => runSync(),
  "POST /internal/decide": async (req) => decide(await readJson(req)),
  // Observations from the main app: execute outcomes (source "execution") and
  // buyer reports (source "feedback", already bound to the buyer's token).
  "POST /internal/observations": async (req) => {
    const b = await readJson(req);
    const list = Array.isArray(b.observations) ? b.observations.slice(0, 64) : [];
    let accepted = 0;
    for (const o of list) if (state.reliability.record({ toolId: o?.toolId, ok: o?.ok === true, latencyMs: Number(o?.latencyMs), source: o?.source, by: typeof o?.by === "string" ? o.by : null })) accepted++;
    return { accepted };
  },
  "POST /internal/decision-cost": async (req) => {
    const b = await readJson(req);
    return { decisionId: String(b.decisionId || ""), cost: await state.decisions.getCost(String(b.decisionId || "")) };
  },
  "POST /internal/decision": async (req) => {
    const b = await readJson(req);
    const d = await state.decisions.get(String(b.decisionId || ""));
    if (!d) throw Object.assign(new Error("unknown decision"), { statusCode: 404 });
    return d;
  },
};

export function handler(req, res) {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  // Own keys only: a request must never reach an inherited property.
  const fn = Object.hasOwn(routes, key) && typeof routes[key] === "function" ? routes[key] : null;
  if (!fn) return send(res, 404, { error: "Not found" });
  if (key !== "GET /health" && !tokenOk(req)) return send(res, 404, { error: "Not found" });
  fn(req).then((out) => send(res, 200, out)).catch((e) => {
    if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
    if (!e.statusCode) console.warn("[decide] handler error:", String(e?.stack || e).slice(0, 400));
    send(res, e.statusCode || 500, { error: e.statusCode ? e.message : "internal error" });
  });
}

export async function boot() {
  if (DB_URL) {
    // A statement that runs long here holds a connection on a database the
    // main app shares, so every statement is bounded.
    state.pool = new pg.Pool({ connectionString: DB_URL, max: 5, connectionTimeoutMillis: 20_000, statement_timeout: 15_000, ssl: plainDbConnection(DB_URL) ? false : { rejectUnauthorized: false } });
    await migrate(state.pool);
    state.store = new PgToolStore(state.pool);
    state.decisions = new PgDecisionStore(state.pool);
  } else {
    state.store = new MemoryToolStore();
    console.warn("[decide] no database configured: index lives in memory only");
  }
  if (state.pool) {
    const { rows } = await state.pool.query("SELECT tool_id, successes, failures, fb_successes, fb_failures, latency_p95_ms, last_success_at FROM decide_tool_reliability");
    state.reliability.load(rows);
    setInterval(() => {
      const dirty = state.reliability.takeDirty();
      if (dirty.length) persistReliability(state.pool, dirty).catch((e) => console.warn("[decide] reliability flush failed:", String(e?.message || e).slice(0, 120)));
    }, 60_000).unref();
    // Retention: decisions carry task text and payer ids. Keep 30 days.
    const prune = () => state.decisions.prune(30).then((r) => { if (r.decisions || r.feedback) console.log("[decide] pruned", JSON.stringify(r)); }).catch((e) => console.warn("[decide] prune failed:", String(e?.message || e).slice(0, 120)));
    setTimeout(prune, 60_000).unref();
    setInterval(prune, 24 * 3_600_000).unref();
  }
  state.loadedRows = await loadIndex({ index: state.index, store: state.store });
  console.log(`[decide] loaded ${state.loadedRows} rows, ${state.index.vectors.count} vectors`);
  http.createServer(handler).listen(PORT, () => console.log(`[decide] listening on ${PORT}`));
  setTimeout(runSync, 15_000).unref();
  setInterval(runSync, SYNC_MS).unref();
}

const isMain = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (isMain) {
  boot().catch((e) => { console.error("[decide] boot failed:", e); process.exit(1); });
}
