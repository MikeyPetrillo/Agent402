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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  const runs = new Map(); // taskId -> AbortController for the live loopback

  const read = (id) => (TASK_ID_RE.test(id) ? readJson(recPath(id)) : null);
  const expired = (rec) => rec.ttlMs != null && now() - (rec.createdAtMs || 0) > rec.ttlMs;

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
        rec.statusMessage = "This run did not survive a server restart and was not completed. You were not charged: payment settles only on a delivered result. Please call again.";
        rec.error = { code: TASK_INTERNAL_ERROR, message: "Task run interrupted by a server restart; not charged." };
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
    const iso = new Date(now()).toISOString();
    const rec = {
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
    rec.status = status;
    if (statusMessage) rec.statusMessage = String(statusMessage).slice(0, 500);
    else delete rec.statusMessage;
    if (status === "completed") {
      const body = result ?? {};
      let bytes = Infinity;
      try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { /* unserialisable: stays Infinity */ }
      let retained = false;
      if (bytes <= MAX_RESULT_BYTES) {
        rec.result = body;
        retained = write(rec);
      }
      if (retained) return true;
      // We hold a delivered 200 we cannot retain. This is the ONLY path here
      // that can leave a buyer charged for nothing, so it is the only one that
      // records a debt - and only on the ledger's positive proof of charge.
      delete rec.result;
      rec.status = "failed";
      rec.statusMessage = "The report was produced but could not be stored for delivery.";
      rec.error = { code: TASK_INTERNAL_ERROR, message: "Result could not be retained." };
      write(rec);
      try { onChargedFailure?.({ slug: rec.slug, receipt, priceUsd }); } catch { /* never break the path */ }
      log(`[${label}] result for ${rec.slug} could not be retained (${bytes} bytes); recorded for refund review`);
      return true;
    }
    if (status === "failed") rec.error = error || { code: TASK_INTERNAL_ERROR, message: "Task failed." };
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
    rec.statusMessage = "Cancelled at your request. The run may still have completed and been charged; if it was, the charge is recorded as owed in our refund ledger and repaid after review. Do not retry blindly: a retry is a new paid call.";
    write(rec);
    return true;
  }

  sweep();

  return {
    create, get, complete, fail, cancel, settle, sweep,
    activeCount, atCapacity, isRunning: (id) => runs.has(id),
    bootId, TTL_MS, POLL_MS, RUN_TIMEOUT_MS, MAX_ACTIVE, MAX_RESULT_BYTES, dir: root,
    _reset() { runs.clear(); try { for (const f of readdirSync(root)) if (f.endsWith(".json")) unlinkSync(join(root, f)); } catch { /* nothing to clear */ } },
  };
}
