// Free email alerts - the lead magnet on the free report pages.
//
// A visitor on /reports/insider/NVDA (or a sample report) leaves an email and
// we watch that one target with the SAME free daily probe the paid monitors
// use, then email them when something changes - with the report to buy and the
// monitor to subscribe to in the same message. No card, no account.
//
// Rules, each enforced in code:
//   - DOUBLE OPT-IN: nothing is watched and nothing but the confirmation is
//     sent until the address clicks a signed link. A form on a public page can
//     be pointed at a stranger; the confirmation is the consent record.
//   - Every email carries an unsubscribe link signed with the server secret
//     (and List-Unsubscribe where the provider takes headers); one click ends it.
//   - At most one change email per alert per day; no email when nothing changed;
//     a probe failure never emails and backs off.
//   - Bounded: per-address alert cap, total-store cap, per-tick probe cap,
//     signup rate limit at the route. Probes are the free ones (EDGAR, openFDA,
//     DNS) - no LLM, no paid upstream, ever.
//   - The store keeps the address (it has to send), the target and timestamps.
//     Operator surfaces report counts only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const ALERT_KINDS = Object.freeze({
  insider: { product: "insider-monitor", family: "insider", noun: "insider filings", cta: (t) => `Email me when ${t} insiders file a Form 4`, subject: (t, n) => `${n} new Form 4 filing${n === 1 ? "" : "s"} for ${t}`, what: (t) => `Form 4 insider filings against ${t}` },
  filing: { product: "filing-monitor", family: "dossier", noun: "SEC filings", cta: (t) => `Email me when ${t} files a 10-K, 10-Q or 8-K`, subject: (t, n) => `${n} new SEC filing${n === 1 ? "" : "s"} from ${t}`, what: (t) => `10-K, 10-Q and 8-K filings from ${t}` },
  fund: { product: "fund-monitor", family: "fund", noun: "13F filings", cta: (t) => `Email me when ${t} files a new 13F`, subject: (t) => `New 13F filing from ${t}`, what: (t) => `13F holdings filings from ${t}` },
  domain: { product: "domain-monitor", family: null, noun: "security changes", cta: (t) => `Email me when ${t}'s security posture changes`, subject: (t) => `Security posture change on ${t}`, what: (t) => `email authentication, TLS and header changes on ${t}` },
  recall: { product: "recall-monitor", family: null, noun: "recalls", cta: (t) => `Email me when a new recall names ${t}`, subject: (t, n) => `${n} new FDA recall${n === 1 ? "" : "s"} naming ${t}`, what: (t) => `FDA recalls naming ${t}` },
});

const DAY = 24 * 60 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 320;
const MAX_TARGET = 200;
export const MAX_PER_EMAIL = 5;       // active + pending alerts one address may hold
export const MAX_STORE = 5000;        // total records (a public form must have a ceiling)
export const CHECK_MS = DAY;          // one free probe per alert per day
export const NOTIFY_MIN_GAP_MS = DAY; // never two change emails in a day
export const PENDING_TTL_MS = 3 * DAY; // an unconfirmed signup is forgotten
export const MAX_FAILURES = 5;        // then the alert pauses until a probe succeeds
export const TICK_PROBE_CAP = 200;    // per tick

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hdr = (s, n = 120) => String(s ?? "").replace(/[\r\n\t]/g, " ").slice(0, n);

export function defaultStorePath() {
  return join(existsSync("/data") ? "/data" : "/tmp", "free-alerts.json");
}

/**
 * @param {object} deps
 * @param {Record<string,(target:string)=>Promise<{ids:string[], items?:{label:string,url?:string}[]}>>} deps.probes
 *   per-kind free probe returning the CURRENT id set (accessions, recall numbers,
 *   a fingerprint) - the diff against the stored baseline is the alert.
 * @param {Record<string,(t:string)=>string|Promise<string>>} deps.validators per-kind target canonicalizer (throws buyerSafe 4xx)
 * @param {(m:{to:string,subject:string,html:string,text:string,headers?:object})=>Promise<boolean>} deps.sendEmail
 * @param {string} deps.secret HMAC key for confirm/unsubscribe links; without it signup is disabled
 */
export function createFreeAlerts({ storePath = defaultStorePath(), probes = {}, validators = {}, sendEmail, secret = "", baseUrl = "https://agent402.tools", now = () => Date.now(), log = console.log, onEvent = null } = {}) {
  let store = load();
  let ticking = false;

  function load() {
    try { const j = JSON.parse(readFileSync(storePath, "utf8")); return j && typeof j === "object" && j.alerts ? j : { alerts: {} }; } catch { return { alerts: {} }; }
  }
  function persist() {
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(store));
      renameSync(tmp, storePath);
    } catch (e) { log(`[free-alerts] persist failed: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const emit = (step, extra = {}) => { try { onEvent?.({ step, ...extra }); } catch { /* telemetry never breaks a signup */ } };

  const sign = (id, purpose) => createHmac("sha256", secret).update(`${purpose}:${id}`).digest("base64url").slice(0, 32);
  const verify = (id, purpose, k) => {
    if (!secret || typeof k !== "string" || !id) return false;
    const a = Buffer.from(sign(id, purpose)); const b = Buffer.from(String(k));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const link = (id, purpose) => `${baseUrl}/alerts/${purpose}?id=${encodeURIComponent(id)}&k=${sign(id, purpose)}`;
  const enabled = () => Boolean(secret) && typeof sendEmail === "function";

  const bad = (msg, code = 400) => Object.assign(new Error(msg), { statusCode: code, buyerSafe: true });
  // ids come from query strings on public routes: shape-check and own-property
  // lookup only, so "__proto__" / "constructor" can never reach the store.
  const ID_RE = /^al_[A-Za-z0-9_-]{8,16}$/;
  const recOf = (id) => (typeof id === "string" && ID_RE.test(id) && Object.hasOwn(store.alerts, id) ? store.alerts[id] : null);
  const normEmail = (e) => String(e ?? "").trim().toLowerCase();

  /** Public signup. Always answers the same shape for an existing address
   *  (no enumeration); sends the confirmation email for a new or pending one. */
  async function signup({ email, kind, target, source = "" } = {}) {
    if (!enabled()) throw bad("Email alerts are not available on this server.", 503);
    const em = normEmail(email);
    if (!em || em.length > MAX_EMAIL || !EMAIL_RE.test(em)) throw bad("Enter a valid email address.");
    const def = ALERT_KINDS[kind];
    if (!def) throw bad("Unknown alert kind.");
    const raw = String(target ?? "").trim();
    if (!raw || raw.length > MAX_TARGET) throw bad("Enter what to watch.");
    const validate = validators[kind];
    let canon = raw;
    if (typeof validate === "function") {
      try { canon = String(await validate(raw)); }
      catch (e) { if (e?.buyerSafe) throw bad(String(e.message).slice(0, 160), e.statusCode || 400); throw bad("We could not validate that target. Check it and try again."); }
    }
    sweep();
    const mine = Object.values(store.alerts).filter((a) => a.email === em && (a.status === "active" || a.status === "pending"));
    const dup = mine.find((a) => a.kind === kind && a.target === canon);
    if (dup) {
      // A lost confirmation is the common case; a stranger's address hammered
      // through this form is the abuse case. Resend at most every 10 minutes
      // and at most 3 times per pending record (then the record waits for its
      // TTL); the route adds a per-address limiter on top of the per-IP one.
      if (dup.status === "pending") {
        const sends = dup.confirmSends || 0;
        if (sends < 3 && (!dup.confirmSentAt || now() - dup.confirmSentAt >= 10 * 60_000)) {
          if (await sendConfirm(dup)) { dup.confirmSends = sends + 1; dup.confirmSentAt = now(); persist(); }
        }
      }
      return { ok: true, status: dup.status, kind, target: canon };
    }
    if (mine.length >= MAX_PER_EMAIL) throw bad(`That address already has ${MAX_PER_EMAIL} alerts. Unsubscribe from one first, or subscribe to a monitor for unlimited targets.`, 429);
    if (Object.keys(store.alerts).length >= MAX_STORE) throw bad("Alerts are full right now. Please try again later.", 503);
    const id = `al_${randomBytes(9).toString("base64url")}`;
    const rec = { id, email: em, kind, target: canon, product: def.product, source: hdr(source, 80), status: "pending", createdAt: now(), baseline: null, lastCheckAt: null, lastNotifiedAt: null, notified: 0, failures: 0 };
    store.alerts[id] = rec;
    persist();
    emit("alert_signup", { kind });
    // No confirmation email = no alert: a record nobody can confirm would sit
    // pending until the sweep, and the visitor would wait for mail that never
    // comes. Tell them now, keep nothing.
    if (!(await sendConfirm(rec))) { delete store.alerts[id]; persist(); throw bad("We could not send the confirmation email right now. Please try again in a few minutes.", 503); }
    rec.confirmSends = 1; rec.confirmSentAt = now(); persist();
    return { ok: true, status: "pending", kind, target: canon };
  }

  async function sendConfirm(rec) {
    const def = ALERT_KINDS[rec.kind];
    const url = link(rec.id, "confirm");
    const subject = `Confirm your ${def.noun} alert for ${rec.target}`;
    const text = `Confirm to start receiving email when there are new ${def.what(rec.target)}:\n\n${url}\n\nOne email per day at most, only when something changes. If you did not ask for this, ignore it and nothing will be sent.`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">Confirm your alert</h2>
<p>Click to start receiving email when there are new ${esc(def.what(rec.target))}.</p>
<p style="margin:18px 0;"><a href="${esc(url)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Confirm alerts for ${esc(rec.target)}</a></p>
<p style="color:#5C6963;font-size:13px;">One email per day at most, only when something changes. If you did not ask for this, ignore it and nothing will be sent.</p>`);
    return sendEmail({ to: rec.email, subject: hdr(subject), html, text });
  }

  function confirm(id, k) {
    const rec = recOf(id);
    if (!rec || !verify(id, "confirm", k)) return { ok: false, reason: "invalid" };
    if (rec.status === "unsubscribed") return { ok: false, reason: "unsubscribed" };
    if (rec.status !== "active") { rec.status = "active"; rec.confirmedAt = now(); persist(); emit("alert_confirmed", { kind: rec.kind }); }
    return { ok: true, kind: rec.kind, target: rec.target, product: rec.product };
  }

  function unsubscribe(id, k) {
    const rec = recOf(id);
    if (!rec || !verify(id, "unsubscribe", k)) return { ok: false, reason: "invalid" };
    // The address is dropped with the consent: nothing is left to email, and
    // nothing rides the next backup. The target stays for the counts.
    if (rec.status !== "unsubscribed") { rec.status = "unsubscribed"; rec.unsubscribedAt = now(); rec.email = null; persist(); emit("alert_unsubscribed", { kind: rec.kind }); }
    return { ok: true, kind: rec.kind, target: rec.target };
  }

  /** Forget unconfirmed signups past their TTL. */
  function sweep() {
    let changed = false;
    for (const [id, a] of Object.entries(store.alerts)) {
      if (a.status === "pending" && now() - a.createdAt > PENDING_TTL_MS) { delete store.alerts[id]; changed = true; }
    }
    if (changed) persist();
  }

  /** One pass: probe every active alert that is due, email on NEW ids only. */
  async function tick({ limit = TICK_PROBE_CAP, force = false } = {}) {
    if (ticking) return { skipped: "ticking" };
    ticking = true;
    const out = { checked: 0, baselined: 0, notified: 0, unchanged: 0, failed: 0, skipped: 0 };
    try {
      sweep();
      const due = Object.values(store.alerts).filter((a) => a.status === "active" && (force || !a.lastCheckAt || now() - a.lastCheckAt >= CHECK_MS)).slice(0, limit);
      for (const a of due) {
        const probe = probes[a.kind];
        if (typeof probe !== "function") { out.skipped++; continue; }
        // Back-off: after MAX_FAILURES consecutive failures wait a day per failure.
        if (!force && a.failures >= MAX_FAILURES && a.lastCheckAt && now() - a.lastCheckAt < DAY * Math.min(a.failures, 7)) { out.skipped++; continue; }
        out.checked++;
        let r;
        try { r = await probe(a.target); }
        catch (e) { a.failures++; a.lastCheckAt = now(); a.lastError = String(e?.message || e).slice(0, 120); out.failed++; continue; }
        const ids = Array.isArray(r?.ids) ? r.ids.map(String) : [];
        a.lastCheckAt = now(); a.failures = 0; a.lastError = null;
        if (!Array.isArray(a.baseline)) { a.baseline = ids; out.baselined++; continue; }
        const seen = new Set(a.baseline);
        const fresh = ids.filter((x) => !seen.has(x));
        if (!fresh.length) { out.unchanged++; continue; }
        if (a.lastNotifiedAt && now() - a.lastNotifiedAt < NOTIFY_MIN_GAP_MS) { out.skipped++; continue; } // keep the baseline: tomorrow's email carries it
        const sent = await sendChange(a, fresh, r);
        if (sent) { a.baseline = ids; a.lastNotifiedAt = now(); a.notified++; out.notified++; emit("alert_sent", { kind: a.kind }); }
        else { out.failed++; }
      }
      persist();
    } finally { ticking = false; }
    return out;
  }

  async function sendChange(a, fresh, r) {
    const def = ALERT_KINDS[a.kind];
    const n = fresh.length;
    const subject = def.subject(a.target, n);
    const items = (Array.isArray(r?.items) ? r.items : []).filter((it) => fresh.includes(String(it.id ?? ""))).slice(0, 8);
    const reportUrl = def.family ? `${baseUrl}/reports/${def.family}/${encodeURIComponent(a.target)}` : `${baseUrl}/reports`;
    const monitorUrl = `${baseUrl}/monitors?product=${encodeURIComponent(a.product)}&target=${encodeURIComponent(a.target)}`;
    const unsub = link(a.id, "unsubscribe");
    const lines = items.map((it) => `- ${it.label}${it.url ? ` ${it.url}` : ""}`).join("\n");
    const text = `${subject}.\n\n${lines ? lines + "\n\n" : ""}Read the free page and get the full report: ${reportUrl}\nHave this re-run and emailed automatically: ${monitorUrl}\n\nYou asked for this alert on agent402.tools. Unsubscribe: ${unsub}`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">${esc(subject)}</h2>
${items.length ? `<ul style="padding-left:18px;margin:0 0 14px;">${items.map((it) => `<li>${it.url && /^https:\/\//.test(it.url) ? `<a href="${esc(it.url)}" style="color:#0F5E43;">${esc(it.label)}</a>` : esc(it.label)}</li>`).join("")}</ul>` : ""}
<p style="margin:18px 0 8px;"><a href="${esc(reportUrl)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Read the free page and get the full report</a></p>
<p style="margin:0 0 18px;font-size:14px;">Or have it re-run and emailed automatically: <a href="${esc(monitorUrl)}" style="color:#0F5E43;">subscribe to the monitor</a>.</p>
<p style="color:#5C6963;font-size:12px;">You asked for this alert on agent402.tools. <a href="${esc(unsub)}" style="color:#5C6963;">Unsubscribe</a>.</p>`);
    return sendEmail({ to: a.email, subject: hdr(subject), html, text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  }

  function shell(inner) {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#141A17;max-width:520px;">
<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#5C6963;margin-bottom:14px;">agent402 · free alert</div>
${inner}
</div>`;
  }

  /** Counts only - never addresses. */
  function stats() {
    const by = { pending: 0, active: 0, unsubscribed: 0 };
    const byKind = {};
    let notified = 0;
    for (const a of Object.values(store.alerts)) { by[a.status] = (by[a.status] || 0) + 1; byKind[a.kind] = (byKind[a.kind] || 0) + (a.status === "active" ? 1 : 0); notified += a.notified || 0; }
    return { total: Object.keys(store.alerts).length, ...by, activeByKind: byKind, emailsSent: notified, enabled: enabled(), storePath };
  }

  let timer = null;
  function start({ intervalMs = 6 * 60 * 60_000, firstMs = 5 * 60_000 } = {}) {
    if (timer || !enabled()) return false;
    const run = () => tick().then((r) => { if (r.checked) log(`[free-alerts] tick ${JSON.stringify(r)}`); }).catch((e) => log(`[free-alerts] tick failed: ${String(e?.message || e).slice(0, 120)}`));
    timer = setInterval(run, intervalMs); timer.unref?.();
    const first = setTimeout(run, firstMs); first.unref?.();
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { signup, confirm, unsubscribe, tick, stats, start, stop, enabled, sign, _store: () => store };
}

/** The signup form for a page. CSP: behavior lives in /js/alert-signup.js. */
export function alertFormHtml({ kind, target, source = "" } = {}) {
  const def = ALERT_KINDS[kind];
  if (!def || !target) return "";
  const fid = `al-${kind}-${String(target).replace(/[^a-z0-9]/gi, "").slice(0, 24)}`;
  return `<form class="al-form" data-kind="${esc(kind)}" data-target="${esc(target)}" data-source="${esc(source)}" style="margin:22px 0 6px;padding:16px 18px;border:1px solid var(--hairline);background:var(--card);">
  <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;">free alert</div>
  <label for="${fid}" style="display:block;font-weight:600;margin:0 0 10px;">${esc(def.cta(target))}</label>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <input id="${fid}" class="field al-email" type="email" required autocomplete="email" placeholder="you@example.com" style="flex:1 1 220px;" aria-label="Email address">
    <input class="al-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;">
    <button class="btn btn-primary al-submit" type="submit">Email me</button>
  </div>
  <div class="al-msg" role="status" style="font-size:13px;color:var(--muted);margin-top:8px;"></div>
  <p style="font-size:12px;color:var(--faint);margin:8px 0 0;">Free. One email a day at most, only when something changes. Confirm by email first; unsubscribe with one click. <a href="/privacy" style="color:var(--faint);">Privacy</a>.</p>
</form>`;
}

/** Which alert kind a report kind maps to (the sample and delivery pages). */
export const ALERT_KIND_FOR_REPORT_KIND = Object.freeze({ insider: "insider", dossier: "filing", filing: "filing", ticker: "insider", fund: "fund", domain: "domain", recall: "recall" });
