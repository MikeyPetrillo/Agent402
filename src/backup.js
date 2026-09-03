// Nightly offsite backup of /data to an S3-compatible bucket (Railway
// Buckets). The volume holds the money-adjacent state — refund ledger,
// stats, status history, leads, buyer memory — with nothing but platform
// snapshots behind it; this module puts a bounded, priced copy elsewhere.
//
// COST DISCIPLINE (the reason half this file exists):
//   - Objects are date-keyed (backups/YYYY-MM-DD/<file>.gz): a same-day
//     retry OVERWRITES, it never accumulates.
//   - Retention prunes date prefixes older than BACKUP_KEEP_DAYS (14) after
//     every successful run — storage is bounded at ~keepDays × nightly size.
//   - BACKUP_MAX_RUN_MB (512) caps compressed upload bytes per run; files
//     over the remaining budget are HELD and named in the status report,
//     never silently dropped.
//   - BACKUP_MAX_TOTAL_GB (20) is the bill guard: if the bucket's stored
//     bytes exceed it, the run refuses to upload and flags loudly — a
//     runaway can cost at most one alert cycle, not a compounding invoice.
//   - Cache-like files (*cache*, *tmp*, -wal/-shm sidecars) are excluded:
//     they rebuild themselves and would dominate the bill for zero value.
//
// SERVING-PATH DISCIPLINE: everything here is background work — no catalog
// route, no paywall contact, no buyer-visible surface. The operator
// endpoints (server.js) are 404-posture. Uploads stream from a temp copy in
// the container's ephemeral disk (never /data — backing up must not grow
// the volume being backed up). SQLite files are copied with better-sqlite3's
// online backup API, so a live writer never yields a torn copy.
//
// Env (all optional; module is a NO-OP without the four BACKUP_S3_* creds —
// the plan/status surface still works so the inventory is visible pre-bucket):
//   BACKUP_S3_ENDPOINT   https://<host>  (S3-compatible; path-style)
//   BACKUP_S3_BUCKET     bucket name
//   BACKUP_S3_KEY_ID / BACKUP_S3_SECRET
//   BACKUP_S3_REGION     default "auto"
//   BACKUP_DATA_DIR      default /data
//   BACKUP_UTC_HOUR      default 4 (nightly window)
//   BACKUP_KEEP_DAYS     default 14
//   BACKUP_MAX_RUN_MB    default 512 (compressed, per run)
//   BACKUP_MAX_TOTAL_GB  default 20  (stored, bill guard)

import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, statSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createGzip, gunzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const cfg = () => ({
  endpoint: (process.env.BACKUP_S3_ENDPOINT || "").trim().replace(/\/+$/, ""),
  bucket: (process.env.BACKUP_S3_BUCKET || "").trim(),
  keyId: (process.env.BACKUP_S3_KEY_ID || "").trim(),
  secret: (process.env.BACKUP_S3_SECRET || "").trim(),
  region: (process.env.BACKUP_S3_REGION || "auto").trim(),
  encKey: parseEncKey(process.env.BACKUP_ENCRYPTION_KEY),
  dataDir: (process.env.BACKUP_DATA_DIR || "/data").trim(),
  utcHour: clampInt(process.env.BACKUP_UTC_HOUR, 4, 0, 23),
  keepDays: clampInt(process.env.BACKUP_KEEP_DAYS, 14, 2, 90),
  maxRunMb: clampInt(process.env.BACKUP_MAX_RUN_MB, 512, 16, 4096),
  maxTotalGb: clampInt(process.env.BACKUP_MAX_TOTAL_GB, 20, 1, 500),
});
function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// Client-side encryption (AES-256-GCM) of every object before upload: the
// bundles carry customer emails, paid reports and access-key material, and
// the bucket's own encryption is one layer under someone else's control.
// BACKUP_ENCRYPTION_KEY = 32 bytes as 64 hex chars or base64; without it the
// run still uploads (a plaintext backup beats none) but reports
// `encrypted:false` and the boot log says so. Format: "A402ENC1" + 12-byte
// IV + ciphertext + 16-byte GCM tag. Decrypt: scripts/backup-restore.js.
const ENC_MAGIC = Buffer.from("A402ENC1");
export function parseEncKey(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  return buf.length === 32 ? buf : null;
}
export function encryptBackupBuffer(plain, key) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ENC_MAGIC, iv, body, c.getAuthTag()]);
}
export function decryptBackupBuffer(buf, key) {
  if (buf.length < ENC_MAGIC.length + 12 + 16 || !buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new Error("not an A402ENC1 object");
  const iv = buf.subarray(8, 20), tag = buf.subarray(buf.length - 16), body = buf.subarray(20, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
export const backupEncrypted = () => Boolean(cfg().encKey);

export const backupConfigured = () => {
  const c = cfg();
  return Boolean(c.endpoint && c.bucket && c.keyId && c.secret);
};

// Known-critical files upload FIRST so a tight budget always covers the
// ledger before bulk. Everything else follows smallest-first (most files
// safe beats one big file safe).
// Real store names (the old list named files that never existed, so priority
// ordering was dead): the refund debt ledger, the sales ledger, the two
// customer directories (prepaid credit balances, delivered paid reports), then
// the subscriber/alert stores. Everything else follows smallest-first.
const PRIORITY = ["agent402-refunds.db", "agent402-sales.db", "credits", "human-checkout", "stripe-subscriptions.json", "mpp-subscriptions.json", "free-alerts.json", "followups.json", "monitor-runs.json", "agent402-stats.db", "status.db"];
// Directory-shaped stores (one JSON file per record) are bundled into one
// gzip'd NDJSON object each: {"path","body"} per file. Until 2026-08-28 the
// plan skipped every directory, so prepaid credit balances and every purchased
// report had NO offsite copy while the module said the volume was covered.
const DIR_BUNDLE_MAX_FILES = 50_000;
const EXCLUDE = [/cache/i, /\btmp\b|\.tmp$/i, /-wal$/, /-shm$/, /\.log$/i];

/** Inventory of /data: what a run would consider, with sizes and the
 *  exclude/include decision per file. Pure read — safe pre-bucket. */
export function backupPlan() {
  const c = cfg();
  let names = [];
  try { names = readdirSync(c.dataDir); } catch (e) { return { dataDir: c.dataDir, error: String(e.message) }; }
  const files = [];
  for (const name of names) {
    let st;
    try { st = statSync(join(c.dataDir, name)); } catch { continue; }
    const excluded = EXCLUDE.some((re) => re.test(name));
    if (st.isDirectory()) {
      let bytes = 0, count = 0;
      try {
        for (const f of readdirSync(join(c.dataDir, name))) {
          if (EXCLUDE.some((re) => re.test(f))) continue;
          try { const fs = statSync(join(c.dataDir, name, f)); if (fs.isFile()) { bytes += fs.size; count++; } } catch { /* raced */ }
        }
      } catch { continue; }
      if (!count) continue; // an empty directory is not a store
      files.push({ name, bytes, excluded, dir: true, count });
      continue;
    }
    if (!st.isFile()) continue;
    files.push({ name, bytes: st.size, excluded });
  }
  const included = files.filter((f) => !f.excluded);
  order(included);
  return {
    dataDir: c.dataDir,
    configured: backupConfigured(),
    utcHour: c.utcHour, keepDays: c.keepDays, maxRunMb: c.maxRunMb, maxTotalGb: c.maxTotalGb,
    files,
    includedCount: included.length,
    includedBytes: included.reduce((a, f) => a + f.bytes, 0),
  };
}
function order(files) {
  files.sort((a, b) => {
    const pa = PRIORITY.indexOf(a.name), pb = PRIORITY.indexOf(b.name);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 1e9 : pa) - (pb === -1 ? 1e9 : pb);
    return a.bytes - b.bytes;
  });
}

// ---------------------------------------------------------------------------
// Minimal SigV4 for path-style S3 PUT/GET/DELETE — no SDK dependency. Bodies
// ride UNSIGNED-PAYLOAD over https, so uploads stream instead of buffering.
function sig({ method, host, path, query = "", headers, secret, keyId, region, now }) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host, "x-amz-date": amzDate };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const canonHeaders = names.map((h) => `${h}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === h)]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canon = [method, path, query, canonHeaders, signedHeaders, all["x-amz-content-sha256"]].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canon).digest("hex")].join("\n");
  let k = createHmac("sha256", "AWS4" + secret).update(date).digest();
  for (const part of [region, "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function s3(method, key, { body, contentLength, query = "" } = {}) {
  const c = cfg();
  const url = new URL(c.endpoint);
  const path = `/${c.bucket}${key ? `/${key}` : ""}`;
  const headers = sig({
    method, host: url.host, path,
    query,
    headers: {
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      ...(contentLength !== undefined ? { "content-length": String(contentLength) } : {}),
    },
    secret: c.secret, keyId: c.keyId, region: c.region, now: new Date(),
  });
  const res = await fetch(`${c.endpoint}${path}${query ? `?${query}` : ""}`, {
    method, headers, body, duplex: body ? "half" : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  return res;
}

async function listAll(prefix) {
  // ListObjectsV2, paginated. Returns [{key, size}].
  const out = [];
  let token = "";
  for (let page = 0; page < 50; page++) {
    const q = `list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const res = await s3("GET", "", { query: q });
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
      out.push({ key: m[1], size: Number(m[2]) });
    }
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    if (!t) break;
    token = t[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run. Status is in-memory and served by the operator endpoint — a
// backup that fails forever must be VISIBLE, not quietly absent.
const status = {
  lastAttempt: null, lastSuccess: null, lastError: null,
  lastUploaded: [], lastHeld: [], lastPruned: 0, storedBytes: null,
};
export const backupStatus = () => ({ ...status, configured: backupConfigured() });

let running = false;
export async function runBackup({ log = console.log } = {}) {
  if (!backupConfigured()) return { skipped: "not configured (BACKUP_S3_* unset)" };
  if (running) return { skipped: "already running" };
  running = true;
  status.lastAttempt = new Date().toISOString();
  const c = cfg();
  const day = status.lastAttempt.slice(0, 10);
  const tmp = mkdtempSync(join(tmpdir(), "a402-backup-"));
  try {
    // Bill guard BEFORE any upload: if the bucket already holds more than
    // the cap, something is wrong (retention broken, foreign writes) — stop
    // and surface rather than keep paying.
    const existing = await listAll("backups/");
    const storedBytes = existing.reduce((a, o) => a + o.size, 0);
    status.storedBytes = storedBytes;
    if (storedBytes > c.maxTotalGb * 1024 ** 3) {
      throw new Error(`bucket holds ${(storedBytes / 1024 ** 3).toFixed(1)}GB > BACKUP_MAX_TOTAL_GB=${c.maxTotalGb} - refusing to add more; investigate retention`);
    }

    const plan = backupPlan();
    if (plan.error) throw new Error(`data dir unreadable: ${plan.error}`);
    const candidates = plan.files.filter((f) => !f.excluded);
    order(candidates);

    let budget = c.maxRunMb * 1024 * 1024;
    const uploaded = [], held = [];
    for (const f of candidates) {
      const src = join(c.dataDir, f.name);
      const objName = f.dir ? `${f.name}.ndjson` : f.name;
      const gz = join(tmp, objName + ".gz");
      try {
        if (f.dir) await stageDir(src, f.name, gz);
        else await stageCopy(src, f.name, gz, tmp);
      } catch (e) {
        held.push({ name: f.name, reason: `stage failed: ${e.message}` });
        continue;
      }
      // Encrypt in place when a key is set; the object name says which it is.
      let up = gz, suffix = ".gz";
      if (c.encKey) {
        const enc = gz + ".enc";
        writeFileSync(enc, encryptBackupBuffer(readFileSync(gz), c.encKey));
        rmSync(gz, { force: true });
        up = enc; suffix = ".gz.enc";
      }
      const bytes = statSync(up).size;
      if (bytes > budget) {
        held.push({ name: f.name, reason: `over budget (${(bytes / 1e6).toFixed(1)}MB compressed, ${(budget / 1e6).toFixed(1)}MB left)` });
        rmSync(up, { force: true });
        continue;
      }
      const key = `backups/${day}/${objName}${suffix}`;
      const res = await s3("PUT", key, { body: createReadStream(up), contentLength: bytes });
      if (!res.ok) throw new Error(`upload ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      budget -= bytes;
      uploaded.push({ name: f.name, gzBytes: bytes, encrypted: Boolean(c.encKey) });
      rmSync(up, { force: true });
    }

    // Retention: delete whole date prefixes older than keepDays. Dates sort
    // lexicographically, so the cutoff is a string compare — no clock math
    // on object timestamps.
    const cutoff = new Date(Date.now() - c.keepDays * 86_400_000).toISOString().slice(0, 10);
    let pruned = 0;
    for (const obj of existing) {
      const m = /^backups\/(\d{4}-\d{2}-\d{2})\//.exec(obj.key);
      if (m && m[1] < cutoff) {
        const res = await s3("DELETE", obj.key);
        if (res.ok || res.status === 404) pruned++;
        else log(`[backup] prune ${obj.key} failed: HTTP ${res.status}`);
      }
    }

    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
    status.lastUploaded = uploaded;
    status.encrypted = Boolean(c.encKey);
    status.lastHeld = held;
    status.lastPruned = pruned;
    log(`[backup] OK day=${day} uploaded=${uploaded.length} (${(uploaded.reduce((a, u) => a + u.gzBytes, 0) / 1e6).toFixed(1)}MB gz) held=${held.length} pruned=${pruned} stored=${(storedBytes / 1e6).toFixed(0)}MB`);
    return { ok: true, day, uploaded, held, pruned };
  } catch (e) {
    status.lastError = `${new Date().toISOString()} ${String(e.message).slice(0, 300)}`;
    log(`[backup] FAILED: ${e.message}`);
    return { ok: false, error: String(e.message) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    running = false;
  }
}

/** Stage a directory store as one gzip'd NDJSON bundle: {"path","body"} per
 *  regular file (JSON records are read as text; a file that changes under us
 *  is skipped, never half-read). Restore: scripts/backup-restore.js. */
async function stageDir(srcDir, name, gzPath) {
  const out = createGzip({ level: 6 });
  const done = pipeline(out, createWriteStream(gzPath));
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (EXCLUDE.some((re) => re.test(f))) continue;
    if (++n > DIR_BUNDLE_MAX_FILES) break;
    let body;
    try { const st = statSync(join(srcDir, f)); if (!st.isFile()) continue; body = readFileSync(join(srcDir, f), "utf8"); } catch { continue; }
    if (!out.write(JSON.stringify({ path: `${name}/${f}`, body }) + "\n")) await new Promise((r) => out.once("drain", r));
  }
  out.end();
  await done;
}

/** Stage one file into the temp dir as gzip. SQLite files go through the
 *  online backup API (consistent under live writers); everything else is a
 *  plain stream copy. Never touches /data for scratch space. */
async function stageCopy(src, name, gzPath, tmp) {
  if (/\.(db|sqlite3?)$/i.test(name)) {
    const { default: Database } = await import("better-sqlite3");
    const raw = join(tmp, name + ".raw");
    const db = new Database(src, { readonly: true });
    try { await db.backup(raw); } finally { db.close(); }
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gzPath));
    rmSync(raw, { force: true });
  } else {
    await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(gzPath));
  }
}

// ---------------------------------------------------------------------------
// Nightly scheduler: a 10-minute tick that fires once per UTC day inside the
// configured hour. In-memory lastDay means a restart can re-run the same
// day, which is safe: date-keyed objects overwrite, they never accumulate.
let lastDay = null;
export function startBackupScheduler({ log = console.log } = {}) {
  if (!backupConfigured()) {
    log("[backup] not configured (BACKUP_S3_* unset) - nightly offsite backup disabled, plan endpoint still live");
    return null;
  }
  const timer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === cfg().utcHour && lastDay !== day) {
      lastDay = day;
      runBackup({ log }).catch((e) => log(`[backup] scheduler run threw: ${e.message}`));
    }
  }, 10 * 60 * 1000);
  timer.unref?.(); // never keep the process alive for the backup timer
  log(`[backup] nightly scheduler armed (UTC hour ${cfg().utcHour}, keep ${cfg().keepDays} days, run cap ${cfg().maxRunMb}MB, bill guard ${cfg().maxTotalGb}GB, ${cfg().encKey ? "AES-256-GCM client-side encryption ON" : "WARNING: BACKUP_ENCRYPTION_KEY unset - objects upload as plain gzip"})`);
  return timer;
}
