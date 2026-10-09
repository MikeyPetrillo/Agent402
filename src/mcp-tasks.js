// mcp-tasks - the MCP Tasks extension (`io.modelcontextprotocol/tasks`) on the
// hosted connector, so the long-running report products are sellable over /mcp.
//
// WHY: /mcp is stateless (a fresh Server+transport per POST) with a 30s
// per-request deadline, and clients/intermediaries time out well before a
// research/dossier/ticker-pack run finishes (30s to 4 min). A blocking
// tools/call cannot hold that open, so the highest-value things we sell were
// effectively unsellable on the connector. Tasks replace the blocking wait with
// a durable handle the client polls.
//
// WIRE (verified against the AUTHORITATIVE source, not the SDK - see below):
//   spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks
//   schema: modelcontextprotocol/ext-tasks @ schema/draft/schema.ts
//   - extension id `io.modelcontextprotocol/tasks`; the client declares it
//     PER REQUEST in `params._meta["io.modelcontextprotocol/clientCapabilities"]
//     .extensions`, and the server MUST NOT return a task to a client that did
//     not declare it on that request;
//   - the server is the SOLE decider, per request. There is no client-side
//     "please make this a task" flag;
//   - CreateTaskResult is FLAT (`Result & Task`) with the discriminator
//     `resultType: "task"` - NOT nested under a `task` key;
//   - tasks/get returns a DetailedTask, flat, `resultType: "complete"`, with
//     `result` on completed and `error` on failed;
//   - tasks/update and tasks/cancel acknowledge with `{resultType:"complete"}`;
//   - durations are `ttlMs` / `pollIntervalMs` (millisecond-suffixed).
//
// The installed @modelcontextprotocol/sdk (1.30.0) implements the EARLIER
// 2025-11-25 CORE tasks shape instead (`tasks/result` + `tasks/list`, nested
// `task`, `ttl`/`pollInterval`, per-request `params.task` opt-in). Those wires
// are mutually incompatible, so this module implements the 2026-07-28 extension
// by hand rather than bending the SDK's experimental helpers into a shape they
// do not speak. We own the Express route, so the shapes below are exactly what
// goes on the wire.
//
// PAYMENT (the part that must be right): settlement stays where it already is -
// on the paid loopback request, AFTER the handler, only on a <400. Creating a
// task does NOT settle anything. The loopback request simply outlives the MCP
// HTTP response that returned the handle. So a task that fails or dies with the
// process produced a non-200 (or no response at all) on the paid request, which
// CANCELS settlement: the buyer is not charged. A CANCELLED task only stops the
// connector waiting; the paid request may still settle, and a charge that never
// reached the buyer is recorded as owed (src/hangup-settlement.js). Nothing here can
// charge for nothing. The one residual case - a 200 that settled but whose
// result we then cannot retain - records a debt in the refund ledger, and only
// on the positive proof the ledger demands (`receiptProvesCharge`).
//
// DURABILITY: one atomic file per task under /data (tmp+rename), the same
// discipline as human-checkout.js. The RECORD survives a redeploy; the in-process
// RUN does not. A restart therefore resolves every orphaned task to a truthful
// terminal `failed` rather than leaving a handle that polls forever - and since
// the run died before delivering a 200, no payment was taken.
//
// STATE DATABASE: with STATE_DATABASE_URL set (src/state-db.js) the records
// live in the `records` table instead, one row per task under the collection
// named after the store directory ("mcp-tasks", "async-jobs"), and the
// directory is imported once at the first boot. Two containers then overlap
// during a deploy, so "a record owned by another boot" no longer means "its
// run died": each live store holds a renewed lease named after its boot id,
// and a working record is an orphan only when its owner's lease is gone. The
// sweep repeats on a timer for that reason (the old container dies after the
// new one booted). In that mode create/get/complete/fail/cancel/settle/sweep
// return promises (documented at each); atCapacity and activeCount stay
// synchronous and count this process's own live runs.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDbEnabled, stateDbSchema, stateQuery, records, leases, importOnce, trackStoreReady } from "./state-db.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

// JSON-RPC error codes the extension pins (ext-tasks "Error Handling").
export const TASK_INVALID_PARAMS = -32602;      // unknown/expired taskId
export const TASK_INTERNAL_ERROR = -32603;
export const TASK_MISSING_CAPABILITY = -32021;  // client did not declare the extension

const TASK_METHODS = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
export const isTaskMethod = (m) => TASK_METHODS.has(String(m || ""));

// A task id is a bearer capability: this connector is authless, so there is no
// authorization context to bind a task to. The spec's explicit instruction for
// that case is high-entropy ids plus a short TTL (and NOT offering task
// listing - the 2026-07-28 extension has no tasks/list, so there is nothing to
// leak by enumeration). 24 random bytes, same posture as /r/:sessionId.
const TASK_ID_BYTES = 24;
const TASK_ID_RE = /^[0-9a-f]{48}$/;
export const newTaskId = () => randomBytes(TASK_ID_BYTES).toString("hex");

// This process's identity. A task record claimed by a DIFFERENT boot is one
// whose run died with that process - pid alone can be recycled across restarts.
const BOOT_ID = randomBytes(8).toString("hex");

const DATA_ROOT = () => (existsSync("/data") ? "/data" : "/tmp");
const DEFAULT_DIR = () => join(DATA_ROOT(), "mcp-tasks");
/** A sibling store directory on the same volume (the HTTP async jobs use "async-jobs"). */
export const taskDataDir = (name) => join(DATA_ROOT(), name);

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** Rollout switch. On by default; `AGENT402_MCP_TASKS=off` disarms the whole
 *  extension without a code change (capability is not advertised, task methods
 *  stop being handled, and every composite falls back to a blocking call). */
export function mcpTasksEnabled() {
  return String(process.env.AGENT402_MCP_TASKS || "").trim().toLowerCase() !== "off";
}

/** True when THIS request declared the tasks extension. The spec forbids
 *  returning a CreateTaskResult to a client that did not, so this is checked
 *  per request and never remembered. */
export function clientDeclaresTasks(params) {
  const ext = params?._meta?.[CLIENT_CAPABILITIES_META]?.extensions;
  return Boolean(ext && typeof ext === "object" && Object.hasOwn(ext, TASKS_EXTENSION));
}

/** The public Task fields, in the spec's shape. Internal bookkeeping (owner,
 *  slug, receipt, ...) never crosses the wire. */
function publicTask(rec) {
  const t = {
    taskId: rec.taskId,
    status: rec.status,
    createdAt: rec.createdAt,
    lastUpdatedAt: rec.lastUpdatedAt,
    ttlMs: rec.ttlMs ?? null,
  };
  if (rec.statusMessage) t.statusMessage = String(rec.statusMessage);
  if (rec.pollIntervalMs) t.pollIntervalMs = rec.pollIntervalMs;
  return t;
}

/** CreateTaskResult: `Result & Task` FLAT plus `resultType: "task"`. Returned in
 *  lieu of a CallToolResult. */
export function createTaskResult(rec) {
  return { resultType: "task", ...publicTask(rec) };
}

/** GetTaskResult: the DetailedTask variant for the current status, FLAT, plus
 *  `resultType: "complete"`. `result` on completed, `error` on failed. */
export function detailedTask(rec) {
  const out = { resultType: "complete", ...publicTask(rec) };
  if (rec.status === "completed") out.result = rec.result ?? {};
  if (rec.status === "failed") out.error = rec.error || { code: TASK_INTERNAL_ERROR, message: "Task failed." };
  // input_required would carry `inputRequests` here. This connector never
  // elicits (it is stateless and authless), so a task never enters that state.
  return out;
}

/** The ack shape shared by tasks/update and tasks/cancel. */
export const taskAck = () => ({ resultType: "complete" });

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (s) => TERMINAL.has(String(s || ""));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function writeJsonAtomic(path, obj) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

/**
 * Durable task store + lifecycle.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]                 store directory (tests override)
 * @param {()=>number} [opts.now]
 * @param {(s:string)=>void} [opts.log]
 * @param {(info:object)=>void} [opts.onChargedFailure]  called ONLY with positive
 *        proof of a settled charge we could not deliver; wired to the refund ledger.
 * @param {string} [opts.bootId]  this process's identity. Defaults to the
 *        module-level BOOT_ID (one value per process, which is what makes "a
 *        record claimed by another boot" mean "its run died"). Overridable so a
 *        test can simulate a restart without forking a process.
 */
export function createTaskStore({ dir, now = () => Date.now(), log = console.log, onChargedFailure = null, bootId = BOOT_ID, limits = {}, label = "mcp-tasks" } = {}) {
  const root = dir || DEFAULT_DIR();
  try { mkdirSync(root, { recursive: true }); } catch { /* writes fail loudly below */ }

  // Bounds. TTL is deliberately short: with no auth context the id IS the
  // credential, so the exposure window is part of the security posture.
  const TTL_MS = num(limits.ttlMs ?? process.env.AGENT402_MCP_TASK_TTL_MS, 60 * 60_000);          // 1h
  const POLL_MS = num(limits.pollMs ?? process.env.AGENT402_MCP_TASK_POLL_MS, 5_000);
  const RUN_TIMEOUT_MS = num(limits.runMs ?? process.env.AGENT402_MCP_TASK_RUN_MS, 6 * 60_000);   // > the 4 min worst case
  const MAX_ACTIVE = num(limits.maxActive ?? process.env.AGENT402_MCP_TASK_MAX_ACTIVE, 64);
  const MAX_RESULT_BYTES = num(limits.maxResultBytes ?? process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES, 8 * 1024 * 1024);

  const runs = new Map(); // taskId -> AbortController for the live loopback
  const expired = (rec) => rec.ttlMs != null && now() - (rec.createdAtMs || 0) > rec.ttlMs;
  const ORPHAN_MESSAGE = "This run did not survive a server restart and was not completed. You were not charged: payment settles only on a delivered result. Please call again.";
  const ORPHAN_ERROR = () => ({ code: TASK_INTERNAL_ERROR, message: "Task run interrupted by a server restart; not charged." });
  const CANCEL_MESSAGE = "Cancelled at your request. The run may still have completed and been charged; if it was, the charge is recorded as owed in our refund ledger and repaid after review. Do not retry blindly: a retry is a new paid call.";

  const newRecord = (slug) => {
    const iso = new Date(now()).toISOString();
    return {
      taskId: newTaskId(),
      status: "working",
      statusMessage: `Running ${slug}. This usually takes 30 seconds to a few minutes.`,
      createdAt: iso,
      lastUpdatedAt: iso,
      createdAtMs: now(),
      ttlMs: TTL_MS,
      pollIntervalMs: POLL_MS,
      slug: String(slug || ""),
      owner: bootId,
      pid: process.pid,
    };
  };

  /**
   * Apply a terminal transition to a record in memory. Returns
   * { rec, retain } where `retain` is the body that must be stored for the
   * transition to count, or null when the result could not be retained (the
   * record is then already rewritten as failed, and `charged` says a debt may
   * be owed). Shared by both backends so the money rule is written once.
   */
  function transition(rec, { status, result, error, statusMessage }) {
    rec.status = status;
    if (statusMessage) rec.statusMessage = String(statusMessage).slice(0, 500);
    else delete rec.statusMessage;
    if (status === "completed") {
      const body = result ?? {};
      let bytes = Infinity;
      try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { /* unserialisable: stays Infinity */ }
      if (bytes <= MAX_RESULT_BYTES) { rec.result = body; return { bytes, fits: true }; }
      return { bytes, fits: false };
    }
    if (status === "failed") rec.error = error || { code: TASK_INTERNAL_ERROR, message: "Task failed." };
    return { bytes: 0, fits: true };
  }
  function markUnretained(rec) {
    delete rec.result;
    rec.status = "failed";
    rec.statusMessage = "The report was produced but could not be stored for delivery.";
    rec.error = { code: TASK_INTERNAL_ERROR, message: "Result could not be retained." };
  }
  function reportCharged(rec, bytes, receipt, priceUsd) {
    // We hold a delivered 200 we cannot retain. This is the ONLY path here
    // that can leave a buyer charged for nothing, so it is the only one that
    // records a debt - and only on the ledger's positive proof of charge.
    try { onChargedFailure?.({ slug: rec.slug, receipt, priceUsd }); } catch { /* never break the path */ }
    log(`[${label}] result for ${rec.slug} could not be retained (${bytes} bytes); recorded for refund review`);
  }

  if (stateDbEnabled()) return createPgTaskStore();
  return createFileTaskStore();

  // ---------------------------------------------------------------------------
  // File backend: one atomic file per task, every method synchronous.
  function createFileTaskStore() {
    // THE ID IS VALIDATED HERE, at the one place a path is built from it, not at
    // each caller. Every current caller does check first, so this changes no
    // behaviour - but "every caller checks" is an invariant maintained by hand,
    // and the next caller is the one that forgets. A task id is 48 hex characters
    // and nothing else, so anything that could traverse (a slash, a dot, "..")
    // cannot be one, and a mistake here is ours rather than a request's.
    const recPath = (id) => {
      if (!TASK_ID_RE.test(id)) throw new Error("refusing to build a task path from a non-task id");
      return join(root, `${id}.json`);
    };

    const read = (id) => (TASK_ID_RE.test(id) ? readJson(recPath(id)) : null);

    function write(rec) {
      rec.lastUpdatedAt = new Date(now()).toISOString();
      return writeJsonAtomic(recPath(rec.taskId), rec);
    }

    /** Boot sweep + TTL prune. Runs once at construction, BEFORE any tasks/get can
     *  be served, so a client never sees a stale `working` handle from a dead run. */
    function sweep() {
      let orphaned = 0, pruned = 0;
      let files = [];
      try { files = readdirSync(root); } catch { return { orphaned, pruned }; }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (!TASK_ID_RE.test(id)) continue;
        const rec = readJson(join(root, f));
        if (!rec || !rec.taskId) { try { unlinkSync(join(root, f)); } catch { /* gone */ } continue; }
        if (expired(rec)) { try { unlinkSync(join(root, f)); pruned++; } catch { /* gone */ } continue; }
        if (rec.status === "working" && rec.owner !== bootId && !runs.has(rec.taskId)) {
          // The run died with its process. The paid loopback never returned a 200,
          // so settlement was cancelled and the buyer was NOT charged - say so
          // rather than leaving a handle that polls forever.
          rec.status = "failed";
          rec.statusMessage = ORPHAN_MESSAGE;
          rec.error = ORPHAN_ERROR();
          write(rec);
          orphaned++;
        }
      }
      if (orphaned || pruned) log(`[${label}] boot sweep: ${orphaned} interrupted run(s) resolved as failed, ${pruned} expired task(s) pruned`);
      return { orphaned, pruned };
    }

    /** Live (non-terminal, unexpired) task count - the disk/abuse bound. */
    function activeCount() {
      let n = 0;
      let files = [];
      try { files = readdirSync(root); } catch { return n; }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const rec = readJson(join(root, f));
        if (rec && rec.status === "working" && !expired(rec)) n++;
      }
      return n;
    }

    const atCapacity = () => activeCount() >= MAX_ACTIVE;

    /**
     * Durably create a task. The spec forbids returning a CreateTaskResult before
     * a tasks/get for that id would resolve, so this writes to disk FIRST and
     * reports failure rather than handing out a handle that does not exist.
     */
    function create({ slug, controller = null } = {}) {
      const rec = newRecord(slug);
      if (!write(rec)) return null;             // fail closed: no handle without durability
      if (controller) runs.set(rec.taskId, controller);
      return rec;
    }

    /** Read for the wire. Returns null for unknown, "expired" for a TTL'd id. */
    function get(id) {
      const rec = read(id);
      if (!rec) return null;
      // `rec` exists, so read() already matched TASK_ID_RE - recPath cannot throw
      // here, and the catch covers the file being gone either way.
      if (expired(rec)) { try { unlinkSync(recPath(id)); } catch { /* gone */ } return "expired"; }
      return rec;
    }

    /** Terminal transition. A terminal task NEVER transitions again (spec), so a
     *  late-arriving result can not overwrite a cancellation. */
    function settle(id, { status, result, error, statusMessage, receipt, priceUsd } = {}) {
      const rec = read(id);
      if (!rec) return false;
      runs.delete(id);
      if (isTerminal(rec.status)) return false;
      const t = transition(rec, { status, result, error, statusMessage });
      if (status === "completed") {
        const retained = t.fits && write(rec);
        if (retained) return true;
        markUnretained(rec);
        write(rec);
        reportCharged(rec, t.bytes, receipt, priceUsd);
        return true;
      }
      write(rec);
      return true;
    }

    const complete = (id, result, opts = {}) => settle(id, { status: "completed", result, ...opts });
    const fail = (id, error, statusMessage) => settle(id, { status: "failed", error, statusMessage });

    /** tasks/cancel. Cooperative and eventually consistent (spec): we stop
     *  waiting on the live run, which closes its loopback request. A paid
     *  request whose connection closes before the first response byte is not
     *  settled while it holds a hang-up forgiveness ticket
     *  (src/hangup-settlement.js); without one, or for a close that lands while
     *  the settle call itself is in flight, it is charged and that charge is
     *  owed in the refund ledger. */
    function cancel(id) {
      const rec = read(id);
      if (!rec) return false;
      const ctl = runs.get(id);
      if (ctl) { try { ctl.abort(); } catch { /* already aborted */ } }
      runs.delete(id);
      if (isTerminal(rec.status)) return true;   // ack anyway; terminal states are immutable
      rec.status = "cancelled";
      // The paid request has already cleared the paywall. Cancelling closes its
      // loopback, and a request closed before its first byte is not settled
      // while it holds a forgiveness ticket (src/hangup-settlement.js), but one
      // without a ticket, or caught mid-settlement, is: that charge is recorded
      // as owed and refunded. Which one happened is not known here, so the
      // message cannot promise "not charged".
      rec.statusMessage = CANCEL_MESSAGE;
      write(rec);
      return true;
    }

    sweep();

    return {
      create, get, complete, fail, cancel, settle, sweep,
      activeCount, atCapacity, isRunning: (id) => runs.has(id),
      backend: "file", ready: () => Promise.resolve(), close: () => {},
      bootId, TTL_MS, POLL_MS, RUN_TIMEOUT_MS, MAX_ACTIVE, MAX_RESULT_BYTES, dir: root,
      _reset() { runs.clear(); try { for (const f of readdirSync(root)) if (f.endsWith(".json")) unlinkSync(join(root, f)); } catch { /* nothing to clear */ } },
    };
  }

  // ---------------------------------------------------------------------------
  // State-database backend: one row per task in `records`, collection named
  // after the directory. Every durable method returns a promise.
  function createPgTaskStore() {
    const collection = basename(root);
    const LEASE = `${collection}:boot:${bootId}`;
    const LEASE_TTL_MS = 90_000;
    const SWEEP_EVERY_MS = 60_000;
    const T = (t) => `${stateDbSchema()}.${t}`;
    // Records this process created or settled: the synchronous capacity view.
    const mine = new Map(); // taskId -> rec
    const timers = [];
    let closed = false;

    const rowOf = async (id) => (TASK_ID_RE.test(id) ? records.get(collection, id) : null);
    const stamp = (rec) => { rec.lastUpdatedAt = new Date(now()).toISOString(); return rec; };
    const putRow = async (rec) => {
      // A terminal record never transitions again, so the write is conditional
      // on the status we read: a row another container already closed keeps
      // its own terminal state.
      const r = await stateQuery(
        `INSERT INTO ${T("records")} (collection, id, body) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
         WHERE ${T("records")}.body->>'status' NOT IN ('completed', 'failed', 'cancelled')
         RETURNING id`,
        [collection, rec.taskId, JSON.stringify(rec)],
      );
      return r.rowCount > 0;
    };
    const delRow = (id) => records.del(collection, id).catch(() => false);

    /** The directory, once, into the table (insert-if-absent: two booting containers are safe). */
    async function importDirectory() {
      let files = [];
      try { files = readdirSync(root); } catch { return { rows: 0, bytes: 0 }; }
      let rows = 0, bytes = 0;
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (!TASK_ID_RE.test(id)) continue;
        const rec = readJson(join(root, f));
        if (!rec || rec.taskId !== id || expired(rec)) continue;
        const text = JSON.stringify(rec);
        await stateQuery(
          `INSERT INTO ${T("records")} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO NOTHING`,
          [collection, id, text],
        );
        rows++; bytes += Buffer.byteLength(text);
      }
      if (rows) log(`[${label}] imported ${rows} task record(s) from ${root} into the state database`);
      return { rows, bytes };
    }

    /**
     * Sweep: expired rows are deleted; a working row owned by another boot
     * whose lease is gone is an orphan (its run died with its process; the
     * paid loopback never returned a 200, so the buyer was NOT charged).
     * Returns { orphaned, pruned }; never throws.
     */
    async function sweep() {
      let orphaned = 0, pruned = 0;
      try {
        const rows = await records.list(collection, { limit: 100_000 });
        const alive = new Map(); // owner -> boolean
        for (const { id, body: rec } of rows) {
          if (!rec || rec.taskId !== id) { await delRow(id); continue; }
          if (expired(rec)) { if (await delRow(id)) pruned++; continue; }
          if (rec.status !== "working" || rec.owner === bootId || runs.has(id)) continue;
          if (!alive.has(rec.owner)) {
            let holder = null;
            try { holder = await leases.holder(`${collection}:boot:${rec.owner}`); } catch { holder = undefined; }
            if (holder === undefined) continue; // the database could not say: not an orphan verdict
            alive.set(rec.owner, Boolean(holder));
          }
          if (alive.get(rec.owner)) continue;
          rec.status = "failed";
          rec.statusMessage = ORPHAN_MESSAGE;
          rec.error = ORPHAN_ERROR();
          if (await putRow(stamp(rec))) orphaned++;
        }
      } catch (e) {
        log(`[${label}] sweep could not read the state database: ${String(e?.message || e).slice(0, 120)}`);
        return { orphaned, pruned };
      }
      if (orphaned || pruned) log(`[${label}] sweep: ${orphaned} interrupted run(s) resolved as failed, ${pruned} expired task(s) pruned`);
      return { orphaned, pruned };
    }

    async function boot() {
      try { await importOnce(collection, { source: root, run: importDirectory }); }
      catch (e) { log(`[${label}] import from ${root} failed: ${String(e?.message || e).slice(0, 120)}`); }
      try { await leases.acquire(LEASE, { owner: bootId, ttlMs: LEASE_TTL_MS }); }
      catch (e) { log(`[${label}] boot lease not held: ${String(e?.message || e).slice(0, 120)}`); }
      const beat = setInterval(() => { if (!closed) leases.renew(LEASE, { owner: bootId, ttlMs: LEASE_TTL_MS }).catch(() => {}); }, Math.floor(LEASE_TTL_MS / 3));
      beat.unref?.(); timers.push(beat);
      await sweep();
      const again = setInterval(() => { if (!closed) void sweep(); }, SWEEP_EVERY_MS);
      again.unref?.(); timers.push(again);
    }
    const ready = trackStoreReady(boot());

    /** This process's live runs (the capacity bound is per container). */
    function activeCount() {
      let n = 0;
      for (const rec of mine.values()) if (rec.status === "working" && !expired(rec)) n++;
      return n;
    }
    const atCapacity = () => activeCount() >= MAX_ACTIVE;

    /** Resolves the record once its row is stored, or null (fail closed). */
    async function create({ slug, controller = null } = {}) {
      await ready;
      const rec = newRecord(slug);
      try { if (!(await putRow(rec))) return null; }
      catch { return null; }
      mine.set(rec.taskId, rec);
      if (controller) runs.set(rec.taskId, controller);
      return rec;
    }

    /** Resolves the record, null for unknown, "expired" for a TTL'd id. Throws on a database error. */
    async function get(id) {
      await ready;
      const rec = await rowOf(String(id || ""));
      if (!rec) return null;
      if (expired(rec)) { await delRow(id); mine.delete(id); return "expired"; }
      return rec;
    }

    async function settle(id, { status, result, error, statusMessage, receipt, priceUsd } = {}) {
      await ready;
      let rec;
      try { rec = await rowOf(String(id || "")); } catch { rec = mine.get(id) || null; }
      if (!rec) return false;
      runs.delete(id);
      if (isTerminal(rec.status)) { mine.delete(id); return false; }
      const t = transition(rec, { status, result, error, statusMessage });
      let stored = false;
      if (status === "completed") {
        if (t.fits) { try { stored = await putRow(stamp(rec)); } catch { stored = false; } }
        if (!stored) {
          markUnretained(rec);
          try { await putRow(stamp(rec)); } catch { /* the row keeps its last state */ }
          reportCharged(rec, t.bytes, receipt, priceUsd);
        }
      } else {
        try { stored = await putRow(stamp(rec)); } catch { stored = false; }
        if (!stored) log(`[${label}] could not store the ${status} state of a ${rec.slug} task`);
      }
      mine.set(id, rec);
      return true;
    }
    const complete = (id, result, opts = {}) => settle(id, { status: "completed", result, ...opts });
    const fail = (id, error, statusMessage) => settle(id, { status: "failed", error, statusMessage });

    async function cancel(id) {
      await ready;
      let rec;
      try { rec = await rowOf(String(id || "")); } catch { rec = mine.get(id) || null; }
      if (!rec) return false;
      const ctl = runs.get(id);
      if (ctl) { try { ctl.abort(); } catch { /* already aborted */ } }
      runs.delete(id);
      if (isTerminal(rec.status)) return true;
      rec.status = "cancelled";
      rec.statusMessage = CANCEL_MESSAGE;
      try { await putRow(stamp(rec)); } catch { /* the run's own close still ends it */ }
      mine.set(id, rec);
      return true;
    }

    async function close() {
      closed = true;
      for (const t of timers) clearInterval(t);
      await leases.release(LEASE, { owner: bootId }).catch(() => {});
    }

    return {
      create, get, complete, fail, cancel, settle, sweep,
      activeCount, atCapacity, isRunning: (id) => runs.has(id),
      backend: "pg", collection, ready: () => ready, close,
      bootId, TTL_MS, POLL_MS, RUN_TIMEOUT_MS, MAX_ACTIVE, MAX_RESULT_BYTES, dir: root,
      async _reset() {
        runs.clear(); mine.clear();
        await ready;
        await stateQuery(`DELETE FROM ${T("records")} WHERE collection = $1`, [collection]).catch(() => {});
      },
    };
  }
}
