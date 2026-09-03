// monitor-scheduler - the fulfilment half of the recurring engine. Turns an ACTIVE
// monitoring subscription (src/stripe-subscriptions.js) into delivered reports:
// a welcome report on first sight, a cheap free re-check on a cadence, a paid
// full re-run only when the cadence says so or something actually CHANGED, and
// an email with a durable report link each time one is produced.
//
// Per kind:
// - domain  (domain-monitor): full graded audit on first sight and every
//   FULL_MS (30d). Every CHECK_MS (24h) a FREE re-probe (probeDomain: the same
//   function the paid handler grades with, no LLM) whose fingerprint is compared
//   to the last one; a change (grade, SPF/DMARC/DKIM/MX, header set, TLS issuer
//   or renewal) or a certificate inside TLS_ALERT_DAYS triggers a full re-run +
//   an alert email. A flapping domain is bounded by MIN_FULL_GAP_MS (one paid
//   re-run per 12h); a TLS-expiry alert is sent once per certificate.
// - fund    (fund-monitor): resolve the manager once, then every CHECK_MS read
//   the latest 13F-HR accession (one small EDGAR JSON read); a NEW accession
//   triggers the full report + a "new filing" email. First sight = welcome
//   report. The accession only advances after a SUCCESSFUL report, so a failed
//   run is retried (with backoff) against the same filing.
//
// Cost bounds: MAX_FULL_PER_TICK paid reports per tick (the rest wait for the
// next tick, logged), per-sub exponential backoff on failure (1h doubling to
// 24h, never an email on failure), 12 retained reports per sub.
// Multi-replica: one tick runs at a time via a lock in the shared /data store
// (owner + timestamp, stale after LOCK_STALE_MS); a second replica's tick sees
// the lock and skips - it is not an error.
// Nothing here charges the subscriber: billing is Stripe's recurring invoice;
// this is fulfilment only. Rollout: mounts only when subscriptions are enabled;
// MONITOR_SCHEDULER=off disables the timer (manual runs still work).
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

const HOUR = 3600_000, DAY = 24 * HOUR;
export const DOMAIN_CHECK_MS = DAY;
export const DOMAIN_FULL_MS = 30 * DAY;
export const FUND_CHECK_MS = DAY;
export const RECALL_CHECK_MS = DAY;
export const TOKEN_CHECK_MS = DAY;
export const FILING_CHECK_MS = DAY;
export const INSIDER_CHECK_MS = DAY;
export const IPO_DIGEST_MS = 7 * DAY;
export const MIN_FULL_GAP_MS = 12 * HOUR;
export const TLS_ALERT_DAYS = 14;
export const MAX_FULL_PER_TICK = 10;
export const MAX_BACKOFF_MS = DAY;
export const LOCK_STALE_MS = 20 * 60_000;
export const TICK_MS = 10 * 60_000;
export const RESEARCH_RERUN_MS = 7 * DAY; // a saved question is re-researched weekly (the 30-day cap bounds a 5-week month)
export const MAX_FULL_PER_SUB_30D = 4;   // welcome + scheduled + up to 4 change runs; beyond = alert-only.
// Bounds a $3/month subscription against its own upstream. MEASURED cost of one
// report is ~$0.10-0.30 (Opus synthesis p50 $0.075/call plus cheap planning), so
// 4 runs is ~$1.20 against the $3 fee ($2.61 net of card fees). The tier's own `maxUpstreamUsd`
// (0.15-0.30 on the monitor slugs) is a circuit breaker that downgrades the synthesis model, not
// the normal cost; a run that hit it every time would still be capped here at 4.
export const PERMANENT_FAIL_NOTICE_AT = 5; // consecutive failures before the subscriber is told (once)
const REPORTS_PER_SUB = 12;
const MAX_RUNS_KEPT = 24;

const STORE_PATH = () => join(existsSync("/data") ? "/data" : "/tmp", "monitor-runs.json");

function loadStore(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { lock: j.lock || null, subs: j.subs || {}, reports: j.reports || {}, lastTickAt: j.lastTickAt || null, lastTick: j.lastTick || null };
  } catch { return { lock: null, subs: {}, reports: {}, lastTickAt: null, lastTick: null }; }
}
function saveStore(path, store) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, path);
  } catch { /* best-effort; in-memory still works this process */ }
}
const newReportId = () => randomBytes(16).toString("base64url");
const errMsg = (e) => String(e?.message || e).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200);

// Target -> handler input, by kind. A string is wrapped by the generate()
// pipeline's per-kind argOf (server.js _humanGenerate); an OBJECT passes
// through as the handler input, which is how the fund kind pins the resolved
// CIK rather than re-resolving a name every run.
function inputFor(kind, target, st) {
  if (kind === "fund") return st?.cik ? { cik: st.cik } : { manager: target };
  if (kind === "recall") return { query: target, allowEmpty: true }; // a welcome report may find nothing yet
  if (kind === "ipo") return { days: 7, keyword: target === "all" ? "" : target };
  if (kind === "insider") return { ticker: target, days: 90 };
  if (kind === "token") return { mint: target };
  if (kind === "filing") return { ticker: target, days: 30, allowEmpty: true, ...(st?.filingNew?.length ? { focus: st.filingNew } : {}) };
  return target;
}

// Human-readable diff between two domain signal snapshots (the alert body).
export function describeDomainChanges(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  if (prev.grade !== next.grade || prev.composite !== next.composite) out.push(`Overall grade ${prev.grade} (${prev.composite}/100) -> ${next.grade} (${next.composite}/100)`);
  if (prev.spf !== next.spf) out.push(`SPF: ${prev.spf ?? "unassessed"} -> ${next.spf ?? "unassessed"}`);
  if (prev.dmarc !== next.dmarc) out.push(`DMARC: ${prev.dmarc ?? "unassessed"} -> ${next.dmarc ?? "unassessed"}`);
  if (JSON.stringify(prev.dkim) !== JSON.stringify(next.dkim)) out.push(`DKIM selectors: ${(prev.dkim || []).join(", ") || "none"} -> ${(next.dkim || []).join(", ") || "none"}`);
  if (prev.mx !== next.mx) out.push(`MX records: ${prev.mx ?? "?"} -> ${next.mx ?? "?"}`);
  if (JSON.stringify(prev.headers) !== JSON.stringify(next.headers)) {
    const a = new Set(prev.headers || []), b = new Set(next.headers || []);
    const added = [...b].filter((h) => !a.has(h)), removed = [...a].filter((h) => !b.has(h));
    out.push(`Security headers: ${added.length ? "added " + added.join(", ") : ""}${added.length && removed.length ? "; " : ""}${removed.length ? "removed " + removed.join(", ") : ""}`.trim());
  }
  if (prev.tls_issuer !== next.tls_issuer) out.push(`TLS issuer: ${prev.tls_issuer || "?"} -> ${next.tls_issuer || "?"}`);
  else if (prev.tls_valid_to !== next.tls_valid_to) out.push(`Certificate renewed (now valid to ${next.tls_valid_to || "?"})`);
  return out;
}

/**
 * @param {object} deps
 * @param {{listActive:(kind?:string)=>any[], get:(id:string)=>any}} deps.subs
 * @param {(kind:string, slug:string, input:string)=>Promise<object>} deps.generate  the real report pipeline (bundle)
 * @param {(domain:string, opts?:object)=>Promise<object>} deps.probeDomain          free domain probe + grade
 * @param {(input:string)=>string} deps.normDomain
 * @param {(a:{cik:string})=>Promise<object|null>} deps.latestFiling               latest 13F-HR identity
 * @param {(a:{cik?:string,name?:string,ticker?:string})=>Promise<{cik:string,name:string}>} deps.resolveManager
 * @param {(mail:object)=>Promise<boolean>} deps.notify                              sendMonitorEmail (best-effort)
 * @param {string} deps.baseUrl
 * @param {string} [deps.storePath]
 * @param {()=>number} [deps.now]
 * @param {string} [deps.ownerId]
 * @param {(s:string)=>void} [deps.log]
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 */
export function createMonitorScheduler({ subs, generate, probeDomain, normDomain, latestFiling, resolveManager, notify, baseUrl, storePath, now = () => Date.now(), ownerId, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), manageUrlFor = () => `${baseUrl}/monitors`, refreshStatus = null, probeRecalls = null, probeIpos = null, probeInsiderFilings = null, probeTokenBrief = null, describeTokenChanges = null, probeCompanyFilings = null, describeFilingChanges = null }) {
  const path = storePath || STORE_PATH();
  let store = loadStore(path);
  const me = ownerId || `${process.env.RAILWAY_REPLICA_ID || "local"}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const persist = () => saveStore(path, store);
  const stateOf = (subId) => (store.subs[subId] ||= { failures: 0, runs: [] });

  // --- shared-store lock -----------------------------------------------------
  function acquireLock() {
    const disk = loadStore(path);
    const l = disk.lock;
    if (l && l.owner !== me && now() - l.at < LOCK_STALE_MS) return false;
    // Disk is the freshest view: only a lock holder writes state, and we are
    // not one yet - so another replica's results win over our stale memory.
    store = { ...store, lock: { owner: me, at: now() }, subs: { ...store.subs, ...disk.subs }, reports: { ...store.reports, ...disk.reports } };
    persist();
    const check = loadStore(path).lock;
    return !!(check && check.owner === me);
  }
  function releaseLock() { if (store.lock?.owner === me) { store.lock = null; persist(); } }

  // --- delivery ---------------------------------------------------------------
  function pruneReports(subId) {
    const mine = Object.entries(store.reports).filter(([, r]) => r.subId === subId).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
    while (mine.length > REPORTS_PER_SUB) { const [id] = mine.shift(); delete store.reports[id]; }
  }

  // Paid runs in the trailing 30 days (from the run log) - the per-sub cost cap.
  function fullsIn30d(st) {
    const since = now() - 30 * DAY;
    return (st.runs || []).filter((r) => !r.alertOnly && Date.parse(r.at) >= since).length;
  }
  const capReached = (st) => fullsIn30d(st) >= MAX_FULL_PER_SUB_30D;

  // Before spending on a paid run, ask Stripe whether this subscription is
  // STILL active (a cancellation or failed renewal the webhook has not
  // delivered must stop fulfilment). Unreadable -> proceed on the stored status.
  async function stillActive(rec) {
    if (typeof refreshStatus !== "function") return true;
    const st = await refreshStatus(rec.subId);
    return st == null || st === "active" || st === "trialing";
  }

  async function runFull(rec, st, reason, changes = []) {
    const p = MONITOR_PRODUCTS[rec.product];
    if (!(await stillActive(rec))) { const e = new Error("subscription no longer active"); e.inactive = true; throw e; }
    const input = inputFor(p.kind, rec.target, st);
    const g = await generate(p.kind, p.slug, input, { buyerKey: `sub:${rec.subId}`, rail: "monitor", priceUsd: Number(p.price) / 100 });
    const bundle = (g && typeof g === "object") ? g : { report: String(g ?? "") };
    if (!bundle.report) throw new Error("empty report");
    const id = newReportId();
    const at = new Date(now()).toISOString();
    store.reports[id] = {
      subId: rec.subId, kind: p.kind, product: rec.product, label: p.label, target: rec.target,
      title: bundle.title || rec.target, report: bundle.report,
      sources: Array.isArray(bundle.sources) ? bundle.sources : [], tables: Array.isArray(bundle.tables) ? bundle.tables : [],
      at, reason, changes,
    };
    st.lastFullAt = now(); st.lastReportId = id; st.failures = 0; st.nextAttemptAt = null; st.lastError = null;
    st.runs = [...(st.runs || []), { at, reason, reportId: id }].slice(-MAX_RUNS_KEPT);
    pruneReports(rec.subId);
    persist();
    if (rec.email) {
      // The manage link (a keyed bearer to the Stripe portal) rides ONLY in the
      // subscriber's email; the report JSON/page carry no bearer to the portal.
      notify({ to: rec.email, reason, label: p.label, target: rec.target, changes, reportUrl: `${baseUrl}/m/${id}`, manageUrl: manageUrlFor(id) }).catch(() => {});
    }
    return id;
  }

  // An alert that does NOT regenerate (the anti-flap gap blocked a paid re-run):
  // links the latest report and says what changed.
  async function alertOnly(rec, st, reason, changes) {
    const p = MONITOR_PRODUCTS[rec.product];
    const at = new Date(now()).toISOString();
    st.runs = [...(st.runs || []), { at, reason, reportId: st.lastReportId || null, alertOnly: true }].slice(-MAX_RUNS_KEPT);
    persist();
    if (rec.email) {
      const id = st.lastReportId;
      notify({ to: rec.email, reason, label: p.label, target: rec.target, changes, reportUrl: id ? `${baseUrl}/m/${id}` : `${baseUrl}/monitors`, manageUrl: id ? manageUrlFor(id) : `${baseUrl}/monitors` }).catch(() => {});
    }
  }

  // A successful step (probe, filing check, or report) ends a backoff episode.
  function recovered(st) { st.failures = 0; st.nextAttemptAt = null; st.lastError = null; }

  function fail(st, e, rec = null) {
    if (e?.inactive) { st.lastError = "subscription not active"; st.nextAttemptAt = now() + DAY; persist(); return; }
    st.failures = (st.failures || 0) + 1;
    const backoff = Math.min(HOUR * 2 ** (st.failures - 1), MAX_BACKOFF_MS);
    st.nextAttemptAt = now() + backoff;
    st.lastError = errMsg(e);
    st.lastErrorAt = new Date(now()).toISOString();
    // A target we keep failing on is not "retry quietly forever while billing":
    // tell the subscriber ONCE (with the manage link) and flag it for the
    // operator; retries continue at the 24h backoff in case it recovers.
    if (rec && st.failures === PERMANENT_FAIL_NOTICE_AT && !st.problemNotifiedAt) {
      st.problemNotifiedAt = new Date(now()).toISOString();
      const p = MONITOR_PRODUCTS[rec.product];
      if (rec.email) notify({ to: rec.email, reason: "problem", label: p?.label || "monitor", target: rec.target, changes: [`We have not been able to complete a report for this target (${st.lastError}).`], reportUrl: st.lastReportId ? `${baseUrl}/m/${st.lastReportId}` : `${baseUrl}/monitors`, manageUrl: st.lastReportId ? manageUrlFor(st.lastReportId) : `${baseUrl}/monitors` }).catch(() => {});
    }
    persist();
  }

  // --- per-kind logic ----------------------------------------------------------
  // Returns one of: "full" | "alert" | "checked" | "skip" | "error"
  async function processDomain(rec, st, { force, budget }) {
    let domain;
    try { domain = normDomain(rec.target); }
    catch (e) { st.invalidTarget = errMsg(e); st.nextAttemptAt = now() + DAY; persist(); return "skip"; }
    const first = !st.lastFullAt;
    const fullDue = first || now() - st.lastFullAt >= DOMAIN_FULL_MS;
    // A pending retry (failures > 0) is always due: the backoff in nextAttemptAt
    // already governs WHEN, and a check interval must not push it out a day.
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= DOMAIN_CHECK_MS;
    if (fullDue) {
      if (!first && capReached(st)) return "skip"; // 30d cap: the scheduled run waits
      if (!budget.allow()) return "skip";
      try {
        // Probe first so the fingerprint baseline is set by the same run.
        const pr = await probeDomain(domain);
        st.signals = pr.signals; st.fingerprint = pr.fingerprint; st.lastCheckAt = now();
        await runFull(rec, st, first ? "welcome" : "scheduled");
        return "full";
      } catch (e) { fail(st, e, rec); return "error"; }
    }
    if (!checkDue) return "skip";
    let pr;
    try { pr = await probeDomain(domain); }
    catch (e) { fail(st, e, rec); return "error"; }
    const prev = st.signals || null, prevFp = st.fingerprint, prevTlsAlerted = st.tlsAlertedFor;
    const changes = describeDomainChanges(prev, pr.signals);
    const changed = !!(st.fingerprint && pr.fingerprint !== st.fingerprint);
    st.signals = pr.signals; st.fingerprint = pr.fingerprint; st.lastCheckAt = now();
    const days = pr.signals?.tls_days_remaining;
    const validTo = pr.signals?.tls_valid_to || null;
    const tlsExpiring = typeof days === "number" && days <= TLS_ALERT_DAYS && st.tlsAlertedFor !== validTo;
    if (!changed && !tlsExpiring) { recovered(st); persist(); return "checked"; }
    const reason = tlsExpiring && !changed ? "tls-expiring" : "change";
    if (tlsExpiring) { st.tlsAlertedFor = validTo; changes.unshift(`TLS certificate expires in ${days} day${days === 1 ? "" : "s"} (valid to ${validTo || "?"})`); }
    const gapOk = !st.lastFullAt || now() - st.lastFullAt >= MIN_FULL_GAP_MS;
    if (gapOk && !capReached(st) && budget.allow()) {
      try { await runFull(rec, st, reason, changes); return "full"; }
      catch (e) {
        // The change is NOT delivered yet: restore the previous baseline so the
        // retry re-detects it (otherwise the new fingerprint would read as
        // "unchanged" and the subscriber would never hear about it).
        st.signals = prev; st.fingerprint = prevFp; st.tlsAlertedFor = prevTlsAlerted;
        fail(st, e, rec); return "error";
      }
    }
    recovered(st);
    await alertOnly(rec, st, reason, changes);
    return "alert";
  }

  async function processFund(rec, st, { force, budget }) {
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= FUND_CHECK_MS || !st.accession;
    if (!checkDue) return "skip";
    let latest;
    try {
      if (!st.cik) {
        const t = String(rec.target || "").trim();
        const r = /^\d{1,10}$/.test(t) ? await resolveManager({ cik: t }) : await resolveManager({ name: t });
        st.cik = r.cik; st.managerName = r.name || null;
      }
      latest = await latestFiling({ cik: st.cik });
    } catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    if (!latest) { recovered(st); st.lastError = "no 13F-HR filings yet"; persist(); return "checked"; }
    const first = !st.accession;
    if (!first && latest.accessionNumber === st.accession) { recovered(st); persist(); return "checked"; }
    if (!first && capReached(st)) { // 30d paid cap: tell them, advance, no paid run
      await alertOnly(rec, st, "filing", [`New 13F-HR filed ${latest.filedDate || "?"} (period ${latest.reportDate || "?"}), accession ${latest.accessionNumber}`]);
      st.accession = latest.accessionNumber; recovered(st); persist(); return "alert";
    }
    if (!budget.allow()) { persist(); return "skip"; }
    try {
      const reason = first ? "welcome" : "filing";
      const changes = first ? [] : [`New 13F-HR filed ${latest.filedDate || "?"} (period ${latest.reportDate || "?"}), accession ${latest.accessionNumber}`];
      await runFull(rec, st, reason, changes);
      st.accession = latest.accessionNumber; st.filedDate = latest.filedDate || null; st.reportDate = latest.reportDate || null;
      persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  // recall: welcome report on first sight; every RECALL_CHECK_MS a FREE probe
  // of the FDA feeds; a recall number not seen before = paid re-run + "recall"
  // email listing the new records. The seen-set advances only after success.
  // token: a welcome brief on first sight; then a FREE keyless probe every
  // TOKEN_CHECK_MS. A changed safety fingerprint (authority flipped, LP lock
  // bucket moved, concentration bucket moved, risk band changed) triggers one
  // paid re-run and a "safety-change" email. The baseline advances only after a
  // filing: welcome report on first sight; then a FREE one-request probe of the
  // company's EDGAR submissions index every FILING_CHECK_MS. An accession not
  // seen before means a paid re-run plus a "filing-new" email naming what
  // landed. The seen-set advances only after a SUCCESSFUL run, so a failed run
  // re-detects the same filings on the retry.
  async function processFiling(rec, st, { force, budget }) {
    if (typeof probeCompanyFilings !== "function") return "skip";
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= FILING_CHECK_MS || !st.filingKeys;
    if (!checkDue) return "skip";
    let pf;
    try { pf = await probeCompanyFilings(rec.target); }
    catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    const first = !st.filingKeys;
    const seen = new Set(st.filingKeys || []);
    const fresh = first ? [] : (pf.filings || []).filter((f) => !seen.has(`${f.accession}|${String(f.form || "").toUpperCase()}`));
    if (!first && !fresh.length) { recovered(st); persist(); return "checked"; }
    const changes = first || typeof describeFilingChanges !== "function" ? [] : describeFilingChanges({ keys: st.filingKeys }, pf);
    if (!first && capReached(st)) { await alertOnly(rec, st, "filing-new", changes); st.filingKeys = pf.keys; recovered(st); persist(); return "alert"; }
    if (!budget.allow()) { persist(); return "skip"; }
    st.filingNew = fresh.slice(0, 3).map((f) => f.accession);   // read what just landed FIRST
    try {
      await runFull(rec, st, first ? "welcome" : "filing-new", changes);
      st.filingKeys = pf.keys; st.filingNew = null; persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  // SUCCESSFUL run, so a failed run re-detects the change on the retry.
  async function processToken(rec, st, { force, budget }) {
    if (typeof probeTokenBrief !== "function") return "skip";
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= TOKEN_CHECK_MS || !st.tokenFingerprint;
    if (!checkDue) return "skip";
    let pr;
    try { pr = await probeTokenBrief(rec.target); }
    catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    const prevSignals = st.tokenSignals || null, prevFp = st.tokenFingerprint || null;
    const first = !prevFp;
    const changed = !first && pr.fingerprint !== prevFp;
    st.tokenSignals = pr.signals; st.tokenFingerprint = pr.fingerprint;
    if (!first && !changed) { recovered(st); persist(); return "checked"; }
    const changes = first || typeof describeTokenChanges !== "function" ? [] : describeTokenChanges(prevSignals, pr.signals);
    if (!first && capReached(st)) { await alertOnly(rec, st, "safety-change", changes); recovered(st); persist(); return "alert"; }
    const gapOk = !st.lastFullAt || now() - st.lastFullAt >= MIN_FULL_GAP_MS;
    if (!gapOk || !budget.allow()) { recovered(st); if (!first) await alertOnly(rec, st, "safety-change", changes); persist(); return "alert"; }
    try { await runFull(rec, st, first ? "welcome" : "safety-change", changes); persist(); return "full"; }
    catch (e) { st.tokenSignals = prevSignals; st.tokenFingerprint = prevFp; fail(st, e, rec); return "error"; }
  }

  async function processRecall(rec, st, { force, budget }) {
    if (typeof probeRecalls !== "function") return "skip";
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= RECALL_CHECK_MS || !st.recallIds;
    if (!checkDue) return "skip";
    let pr;
    try { pr = await probeRecalls(rec.target); }
    catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    const seen = new Set(st.recallIds || []);
    const first = !st.recallIds;
    const fresh = first ? [] : pr.items.filter((x) => x.recallNumber && !seen.has(x.recallNumber));
    if (!first && !fresh.length) { recovered(st); persist(); return "checked"; }
    const recallChanges = fresh.slice(0, 10).map((x) => `${x.recallInitiated || "?"} · ${x.classification || "?"} · ${x.firm || "?"}: ${x.product || "?"} (${x.reason || "no reason given"})`);
    if (fresh.length > 10) recallChanges.push(`...and ${fresh.length - 10} more`);
    if (!first && capReached(st)) { await alertOnly(rec, st, "recall", recallChanges); st.recallIds = pr.ids; recovered(st); persist(); return "alert"; }
    if (!budget.allow()) { persist(); return "skip"; }
    try {
      const changes = recallChanges;
      await runFull(rec, st, first ? "welcome" : "recall", changes);
      st.recallIds = pr.ids; persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  // ipo: a weekly digest (deterministic, cheap). First sight = welcome; then
  // every IPO_DIGEST_MS a "digest" run - only when the week had filings
  // matching the keyword (a no-filings week is a checked, no email).
  async function processIpo(rec, st, { force, budget }) {
    if (typeof probeIpos !== "function") return "skip";
    const retryPending = (st.failures || 0) > 0;
    const first = !st.lastFullAt;
    const due = force || retryPending || first || now() - st.lastFullAt >= IPO_DIGEST_MS;
    if (!due) return "skip";
    let pr;
    try { pr = await probeIpos({ days: 7, keyword: rec.target === "all" ? "" : rec.target }); }
    catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    if (!first && !pr.rows.length) { recovered(st); st.lastFullAt = now(); persist(); return "checked"; }
    if (!first && capReached(st)) { recovered(st); st.lastFullAt = now(); persist(); return "checked"; }
    if (!budget.allow()) { persist(); return "skip"; }
    try {
      const priced = pr.rows.filter((r) => r.stage === "priced").length;
      const changes = pr.rows.length ? [`${priced} priced IPO${priced === 1 ? "" : "s"} and ${pr.rows.length - priced} new registration${pr.rows.length - priced === 1 ? "" : "s"} this week`] : [];
      await runFull(rec, st, first ? "welcome" : "digest", changes);
      st.ipoIds = pr.ids; persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  // research: there is no cheap probe for "did the answer change" - the
  // product IS the weekly re-run. Welcome report on first sight, then a fresh
  // paid run every RESEARCH_RERUN_MS; past the 30-day cap it waits (no alert
  // has anything to say), the cap resets as old runs age out.
  async function processResearch(rec, st, { force, budget }) {
    const retryPending = (st.failures || 0) > 0;
    const first = !st.lastFullAt;
    const due = force || retryPending || first || now() - st.lastFullAt >= RESEARCH_RERUN_MS;
    if (!due) return "skip";
    st.lastCheckAt = now();
    if (!first && capReached(st)) { recovered(st); persist(); return "checked"; }
    if (!budget.allow()) { persist(); return "skip"; }
    try {
      await runFull(rec, st, first ? "welcome" : "scheduled", first ? [] : ["Weekly re-run of your question from live sources"]);
      persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  // insider: welcome report on first sight; daily FREE probe of Form 4
  // accessions against the ticker; a new accession = paid re-run + "filing"
  // email. The seen-set advances only after a successful report.
  async function processInsider(rec, st, { force, budget }) {
    if (typeof probeInsiderFilings !== "function") return "skip";
    const retryPending = (st.failures || 0) > 0;
    const checkDue = force || retryPending || !st.lastCheckAt || now() - st.lastCheckAt >= INSIDER_CHECK_MS || !st.form4Ids;
    if (!checkDue) return "skip";
    let pf;
    try { pf = await probeInsiderFilings({ ticker: rec.target, days: 90, limit: 40 }); }
    catch (e) { fail(st, e, rec); return "error"; }
    st.lastCheckAt = now();
    const seen = new Set(st.form4Ids || []);
    const first = !st.form4Ids;
    const fresh = first ? [] : pf.filings.filter((f) => !seen.has(f.accessionNumber));
    if (!first && !fresh.length) { recovered(st); persist(); return "checked"; }
    const f4Changes = fresh.slice(0, 8).map((f) => `Form 4 filed ${f.filedDate}: ${String(f.displayNames?.[0] || "reporting person").replace(/\s*\(CIK[^)]*\)\s*$/i, "")}`);
    if (fresh.length > 8) f4Changes.push(`...and ${fresh.length - 8} more`);
    if (!first && capReached(st)) { await alertOnly(rec, st, "filing", f4Changes); st.form4Ids = pf.ids; recovered(st); persist(); return "alert"; }
    if (!budget.allow()) { persist(); return "skip"; }
    try {
      const changes = f4Changes;
      await runFull(rec, st, first ? "welcome" : "filing", changes);
      st.form4Ids = pf.ids; persist();
      return "full";
    } catch (e) { fail(st, e, rec); return "error"; }
  }

  async function processSub(rec, opts) {
    const p = MONITOR_PRODUCTS[rec.product];
    if (!p) return "skip";
    const st = stateOf(rec.subId);
    st.product = rec.product; st.target = rec.target;
    if (!opts.force && st.nextAttemptAt && now() < st.nextAttemptAt) return "skip";
    if (p.kind === "domain") return processDomain(rec, st, opts);
    if (p.kind === "fund") return processFund(rec, st, opts);
    if (p.kind === "filing") return processFiling(rec, st, opts);
    if (p.kind === "token") return processToken(rec, st, opts);
    if (p.kind === "recall") return processRecall(rec, st, opts);
    if (p.kind === "ipo") return processIpo(rec, st, opts);
    if (p.kind === "research") return processResearch(rec, st, opts);
    if (p.kind === "insider") return processInsider(rec, st, opts);
    return "skip";
  }

  // --- the tick ---------------------------------------------------------------
  let ticking = false;
  async function tick({ force = false, subId = null } = {}) {
    if (ticking) return { skipped: "busy" };
    if (!acquireLock()) return { skipped: "locked" };
    ticking = true;
    const started = now();
    const summary = { full: 0, alert: 0, checked: 0, skip: 0, error: 0, deferred: 0, active: 0 };
    let fullCount = 0;
    const budget = { allow: () => { if (fullCount >= MAX_FULL_PER_TICK) { summary.deferred++; return false; } fullCount++; return true; } };
    try {
      const active = subs.listActive().filter((r) => !subId || r.subId === subId);
      summary.active = active.length;
      for (const rec of active) {
        let r;
        try { r = await processSub(rec, { force, budget }); }
        catch (e) { fail(stateOf(rec.subId), e); r = "error"; }
        summary[r] = (summary[r] || 0) + 1;
        // Keep the lock fresh ON DISK during long ticks (10 paid reports can
        // take longer than LOCK_STALE_MS) so another replica does not reclaim it.
        if (store.lock?.owner === me) { store.lock.at = now(); persist(); }
        await sleep(0);
      }
      // Drop state for subscriptions that no longer exist at all (not merely
      // canceled - a resubscribe reuses nothing, and canceled history is kept).
      store.lastTickAt = new Date(now()).toISOString();
      store.lastTick = { ...summary, ms: now() - started, owner: me };
      persist();
    } finally { ticking = false; releaseLock(); }
    log(`[monitors] tick: ${summary.active} active, ${summary.full} full, ${summary.alert} alerts, ${summary.checked} checked, ${summary.error} errors, ${summary.deferred} deferred (${now() - started}ms)`);
    return summary;
  }

  // --- read surfaces ------------------------------------------------------------
  // The delivered-report shape the report page polls (same as /api/r/:id).
  // A miss re-reads the shared store at most once per 5s (another replica may
  // have just delivered it) - an id scanner cannot turn every miss into a read.
  let lastMissReadAt = 0;
  function fromDisk(reportId) {
    if (now() - lastMissReadAt < 5000) return null;
    lastMissReadAt = now();
    return loadStore(path).reports[reportId] || null;
  }
  function reportView(reportId) {
    const r = (Object.hasOwn(store.reports, reportId) ? store.reports[reportId] : null) || fromDisk(reportId);
    if (!r) return null;
    if (!store.reports[reportId]) store.reports[reportId] = r;
    return {
      status: "done", kind: r.kind, title: r.title, report: r.report, sources: r.sources, tables: r.tables, at: r.at,
      monitor: { label: r.label, target: r.target, reason: r.reason, changes: r.changes || [] },
    };
  }
  const subIdOfReport = (reportId) => (store.reports[reportId] || fromDisk(reportId))?.subId || null;

  function status() {
    const active = subs.listActive();
    const rows = active.map((rec) => {
      const st = store.subs[rec.subId] || {};
      return {
        subId: rec.subId, product: rec.product, kind: MONITOR_PRODUCTS[rec.product]?.kind || null, target: rec.target,
        lastCheckAt: st.lastCheckAt ? new Date(st.lastCheckAt).toISOString() : null,
        lastFullAt: st.lastFullAt ? new Date(st.lastFullAt).toISOString() : null,
        lastReportId: st.lastReportId || null, failures: st.failures || 0, lastError: st.lastError || null,
        nextAttemptAt: st.nextAttemptAt ? new Date(st.nextAttemptAt).toISOString() : null,
        accession: st.accession || null, grade: st.signals?.grade ?? null, tlsDays: st.signals?.tls_days_remaining ?? null,
        fullsLast30d: fullsIn30d(st), capReached: capReached(st), problemNotifiedAt: st.problemNotifiedAt || null,
        runs: (st.runs || []).slice(-5),
      };
    });
    return { owner: me, lock: store.lock, lastTickAt: store.lastTickAt || null, lastTick: store.lastTick || null, active: rows.length, reports: Object.keys(store.reports).length, subs: rows };
  }

  let timer = null;
  function start() {
    if (timer) return timer;
    timer = setInterval(() => { tick().catch((e) => log(`[monitors] tick threw: ${errMsg(e)}`)); }, TICK_MS);
    timer.unref?.();
    // First tick shortly after boot so a fresh subscriber's welcome report is
    // not a 10-minute wait after a deploy.
    const first = setTimeout(() => { tick().catch((e) => log(`[monitors] first tick threw: ${errMsg(e)}`)); }, 90_000);
    first.unref?.();
    log(`[monitors] scheduler armed (tick ${TICK_MS / 60000}m, domain check ${DOMAIN_CHECK_MS / HOUR}h / full ${DOMAIN_FULL_MS / DAY}d, fund check ${FUND_CHECK_MS / HOUR}h, max ${MAX_FULL_PER_TICK} full/tick)`);
    return timer;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, reportView, subIdOfReport, status, start, stop, _store: () => store };
}
