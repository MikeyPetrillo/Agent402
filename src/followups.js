// Post-purchase email sequence for card buyers - two emails, then silence.
//
// A one-shot buyer used to get exactly one email (the report link) and never
// hear from us again, so nothing pulled them back to a monitor or a second
// report. This queue sends, per delivered report:
//   day 0  (on failure only) "your report failed, you were refunded"
//   day 2  the matching monitor for the SAME target, if one exists
//   day 7  "another one?" with the free samples and the storefront
// Every follow-up carries a signed stop link that ends the sequence; a buyer
// who bought again or subscribed is not re-sold what they already have. Never
// more than these two follow-ups per purchase, never anything promotional
// outside them. The store keeps the address (it has to send), the product,
// the target and timestamps - operator surfaces report counts only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DAY = 24 * 60 * 60_000;
export const STEP_DELAYS_MS = Object.freeze({ monitor: 2 * DAY, another: 7 * DAY });
export const MAX_STORE = 20_000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hdr = (s, n = 120) => String(s ?? "").replace(/[\r\n\t]/g, " ").slice(0, n);

export function defaultStorePath() {
  return join(existsSync("/data") ? "/data" : "/tmp", "followups.json");
}

/**
 * @param {object} deps
 * @param {(kind:string)=>({product:string,label:string,priceUsd:string}|null)} deps.monitorFor the monitor that watches this report kind
 * @param {()=>{product:string,label:string,url:string}[]} deps.samples the free sample pages to point a repeat buyer at
 * @param {(m:{to:string,subject:string,html:string,text:string,headers?:object})=>Promise<boolean>} deps.sendEmail
 */
export function createFollowups({ storePath = defaultStorePath(), sendEmail, monitorFor = () => null, samples = () => [], secret = "", baseUrl = "https://agent402.tools", now = () => Date.now(), log = console.log, onEvent = null } = {}) {
  let store = load();
  let ticking = false;
  function load() { try { const j = JSON.parse(readFileSync(storePath, "utf8")); return j && typeof j === "object" && j.seqs ? j : { seqs: {} }; } catch { return { seqs: {} }; } }
  function persist() {
    try { mkdirSync(dirname(storePath), { recursive: true }); const tmp = `${storePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(store)); renameSync(tmp, storePath); }
    catch (e) { log(`[followups] persist failed: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const emit = (step, extra = {}) => { try { onEvent?.({ step, ...extra }); } catch { /* telemetry never breaks delivery */ } };
  const sign = (id) => createHmac("sha256", secret).update(`stop:${id}`).digest("base64url").slice(0, 32);
  const verify = (id, k) => { if (!secret || !id || typeof k !== "string") return false; const a = Buffer.from(sign(id)); const b = Buffer.from(k); return a.length === b.length && timingSafeEqual(a, b); };
  const stopLink = (id) => `${baseUrl}/followups/stop?id=${encodeURIComponent(id)}&k=${sign(id)}`;
  const enabled = () => Boolean(secret) && typeof sendEmail === "function";
  const normEmail = (e) => String(e ?? "").trim().toLowerCase();
  // ids (Stripe session ids) come from query strings on a public route:
  // shape-check + own-property lookup, never a bare object index.
  const ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
  const recOf = (id) => (typeof id === "string" && ID_RE.test(id) && Object.hasOwn(store.seqs, id) ? store.seqs[id] : null);

  /** Called when a report is delivered. Idempotent on sessionId. */
  function enqueue({ sessionId, email, product, kind, label, input } = {}) {
    if (!enabled()) return null;
    const em = normEmail(email);
    const sid = String(sessionId || "");
    if (!em || !ID_RE.test(sid)) return null;
    if (recOf(sid)) return recOf(sid);
    if (Object.keys(store.seqs).length >= MAX_STORE) prune();
    const rec = { id: sid, email: em, product: String(product || ""), kind: String(kind || ""), label: String(label || "report"), input: hdr(input, 200), createdAt: now(), sent: {}, stopped: false };
    store.seqs[rec.id] = rec; persist();
    return rec;
  }

  /** A buyer who came back is not re-sold: stop every open sequence for the address. */
  function markRepeat(email) {
    const em = normEmail(email); let n = 0;
    for (const r of Object.values(store.seqs)) if (r.email === em && !r.stopped) { r.stopped = true; r.stoppedReason = "repeat-buyer"; r.email = null; n++; }
    if (n) persist();
    return n;
  }

  function stop(id, k) {
    const r = recOf(id);
    if (!r || !verify(id, k)) return { ok: false };
    if (!r.stopped) { r.stopped = true; r.stoppedReason = "link"; r.stoppedAt = now(); r.email = null; persist(); emit("followup_stopped"); }
    return { ok: true };
  }

  /** Immediate: the buyer's report failed and the refund is on its way. */
  async function sendFailed({ email, label, refunded }) {
    if (!enabled()) return false;
    const to = normEmail(email); if (!to) return false;
    const subject = `Your ${hdr(label || "report", 60)} could not be completed`;
    const body = refunded ? "Your payment has been refunded in full; the refund appears on your statement within a few business days." : "Your refund is being processed and will appear on your statement within a few business days.";
    const text = `We could not complete your ${label || "report"}. ${body}\n\nIf you want to try again with a different input: ${baseUrl}/reports\n\nAgent402`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">Your ${esc(label || "report")} could not be completed</h2><p>${esc(body)}</p><p style="margin:18px 0 0;font-size:14px;">If you want to try again with a different input: <a href="${esc(baseUrl)}/reports" style="color:#0F5E43;">agent402.tools/reports</a></p>`);
    const okSent = await sendEmail({ to, subject, html, text });
    if (okSent) emit("followup_failed_sent");
    return okSent;
  }

  /** One pass over the queue: send whichever steps are due. */
  async function tick({ limit = 200 } = {}) {
    if (ticking || !enabled()) return { skipped: "ticking-or-disabled" };
    ticking = true;
    const out = { monitor: 0, another: 0, skipped: 0, failed: 0 };
    try {
      let n = 0;
      for (const r of Object.values(store.seqs)) {
        if (r.stopped || n >= limit) continue;
        const age = now() - r.createdAt;
        if (!r.sent.monitor && age >= STEP_DELAYS_MS.monitor) {
          n++;
          const mon = monitorFor(r.kind);
          if (!mon) { r.sent.monitor = "no-monitor"; out.skipped++; }
          else {
            const sent = await sendMonitorOffer(r, mon);
            if (sent) { r.sent.monitor = now(); out.monitor++; emit("followup_monitor_sent", { kind: r.kind }); } else { out.failed++; }
          }
          continue; // one email per sequence per tick
        }
        if (!r.sent.another && age >= STEP_DELAYS_MS.another) {
          n++;
          const sent = await sendAnother(r);
          if (sent) { r.sent.another = now(); out.another++; emit("followup_another_sent", { kind: r.kind }); } else { out.failed++; }
        }
      }
      persist();
    } finally { ticking = false; }
    return out;
  }

  async function sendMonitorOffer(r, mon) {
    const url = `${baseUrl}/monitors?product=${encodeURIComponent(mon.product)}&target=${encodeURIComponent(r.input)}`;
    const subject = `Keep ${hdr(r.input, 40) || "it"} watched: the ${hdr(mon.label, 40)}`;
    const text = `Two days ago you bought a ${r.label} on ${r.input}. The ${mon.label} re-runs it when something changes and emails you the new report, ${mon.priceUsd} a month, cancel any time:\n${url}\n\nStop these emails: ${stopLink(r.id)}\n\nAgent402`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">Keep ${esc(r.input || "it")} watched</h2>
<p>Two days ago you bought a ${esc(r.label)} on ${esc(r.input)}. The ${esc(mon.label)} re-runs it when something changes and emails you the new report, ${esc(mon.priceUsd)} a month, cancel any time.</p>
<p style="margin:18px 0;"><a href="${esc(url)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Start the ${esc(mon.label)}</a></p>
${footer(r)}`);
    return sendEmail({ to: r.email, subject, html, text, headers: unsubHeaders(r) });
  }

  async function sendAnother(r) {
    const list = samples().slice(0, 4);
    const subject = `Another report? Read the free samples first`;
    const lines = list.map((s) => `- ${s.label}: ${s.url}`).join("\n");
    const text = `A week ago you bought a ${r.label}. If you need another one, every report type has a real, free sample you can read before paying:\n${lines}\n\nAll reports: ${baseUrl}/reports\n\nStop these emails: ${stopLink(r.id)}\n\nAgent402`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">Another report?</h2>
<p>A week ago you bought a ${esc(r.label)}. If you need another one, every report type has a real, free sample you can read before paying:</p>
<ul style="padding-left:18px;">${list.map((s) => `<li><a href="${esc(s.url)}" style="color:#0F5E43;">${esc(s.label)}</a></li>`).join("")}</ul>
<p style="margin:18px 0;"><a href="${esc(baseUrl)}/reports" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">All reports</a></p>
${footer(r)}`);
    return sendEmail({ to: r.email, subject, html, text, headers: unsubHeaders(r) });
  }

  const unsubHeaders = (r) => ({ "List-Unsubscribe": `<${stopLink(r.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  const footer = (r) => `<p style="color:#5C6963;font-size:12px;">You are getting this because you bought a report on agent402.tools. This is the ${r.sent.monitor ? "last" : "first of at most two"} follow-ups. <a href="${esc(stopLink(r.id))}" style="color:#5C6963;">Stop these emails</a>.</p>`;
  function shell(inner) { return `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#141A17;max-width:520px;"><div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#5C6963;margin-bottom:14px;">agent402 · reports</div>${inner}</div>`; }

  /** Drop finished sequences older than 30 days so the store stays bounded. */
  function prune() {
    let changed = false;
    for (const [id, r] of Object.entries(store.seqs)) {
      const done = r.stopped || (r.sent.monitor && r.sent.another);
      if (done && now() - r.createdAt > 30 * DAY) { delete store.seqs[id]; changed = true; }
    }
    if (changed) persist();
  }

  function stats() {
    const rs = Object.values(store.seqs);
    return { total: rs.length, open: rs.filter((r) => !r.stopped && !(r.sent.monitor && r.sent.another)).length, stopped: rs.filter((r) => r.stopped).length, monitorSent: rs.filter((r) => typeof r.sent.monitor === "number").length, anotherSent: rs.filter((r) => typeof r.sent.another === "number").length, enabled: enabled(), storePath };
  }

  let timer = null;
  function start({ intervalMs = 60 * 60_000, firstMs = 3 * 60_000 } = {}) {
    if (timer || !enabled()) return false;
    const run = () => tick().then((r) => { if (r.monitor || r.another) log(`[followups] tick ${JSON.stringify(r)}`); }).catch((e) => log(`[followups] tick failed: ${String(e?.message || e).slice(0, 120)}`));
    timer = setInterval(run, intervalMs); timer.unref?.(); const f = setTimeout(run, firstMs); f.unref?.();
    return true;
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  return { enqueue, markRepeat, stop, sendFailed, tick, prune, stats, start, stopTimer, enabled, _store: () => store };
}
