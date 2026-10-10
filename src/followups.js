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
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { trackStoreReady, leased } from "./state-db.js";

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
  // The store is one JSON document: on the volume as a file, in the state
  // database when one is configured (first load imports the file once).
  const doc = createJsonDocument({ file: storePath, log });
  const shape = (j) => (j && typeof j === "object" && j.seqs ? j : { seqs: {} });
  // With the database two containers can hold this store at once (a deploy's
  // overlap). Each one re-reads the row at the start of every tick, and every
  // write is a versioned read-modify-write of the record it changes, applied
  // to the fresh row (never a whole-body put of a copy that may be stale):
  // a stop on one container is never undone by the other's save, and a step
  // is claimed in the row before its email goes, so it is sent once.
  const PG = doc.backend === "pg";
  let store = shape(doc.loadSync(null));
  const ready = trackStoreReady(PG ? doc.load(null).then((j) => { store = shape(j); }) : Promise.resolve());
  function persist() {
    void doc.save(store).then((stored) => { if (!stored) log(`[followups] persist failed: ${String(doc.lastError || "").slice(0, 120)}`); });
  }
  const pending = new Set();
  /** Apply `change(seqs)` to the stored row (database mode) and adopt the fresh row. Resolves the update result. */
  function write(change) {
    const p = doc.update((b) => { const body = shape(b); return change(body.seqs) === SKIP_UPDATE ? SKIP_UPDATE : body; }, { fallback: { seqs: {} } })
      .then((r) => { if (r.ok) store = shape(r.body); else log(`[followups] write failed: ${String(r.error || "").slice(0, 120)}`); return r; });
    pending.add(p); p.finally(() => pending.delete(p));
    return p;
  }
  /** Re-read the row (database mode). False when it could not be read. */
  async function refresh() {
    if (!PG) return true;
    const r = await doc.read();
    if (!r.ok) return false;
    store = shape(r.exists ? r.body : null);
    return true;
  }
  let ticking = false;
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
    store.seqs[rec.id] = rec;
    if (PG) void write((seqs) => { if (Object.hasOwn(seqs, sid)) return SKIP_UPDATE; seqs[sid] = { ...rec, sent: {} }; });
    else persist();
    return rec;
  }

  /** A buyer who came back is not re-sold: stop every open sequence for the address. */
  function markRepeat(email) {
    const em = normEmail(email); let n = 0;
    const stopAll = (seqs) => { let k = 0; for (const r of Object.values(seqs)) if (r.email === em && !r.stopped) { r.stopped = true; r.stoppedReason = "repeat-buyer"; r.email = null; k++; } return k; };
    n = stopAll(store.seqs);
    // Database mode: the row may hold sequences for this address this
    // container has not seen yet, so the stop runs on the row whatever n is.
    if (PG) { if (em) void write((seqs) => (stopAll(seqs) ? undefined : SKIP_UPDATE)); }
    else if (n) persist();
    return n;
  }

  function stop(id, k) {
    const at = now();
    const stopRow = (seqs) => { const x = Object.hasOwn(seqs, id) ? seqs[id] : null; if (!x || x.stopped) return SKIP_UPDATE; x.stopped = true; x.stoppedReason = "link"; x.stoppedAt = at; x.email = null; };
    const r = recOf(id);
    // Database mode: a signed stop link for a sequence this container has not
    // read yet (made on the other one) still stops it, on the row.
    if (!r && PG && ID_RE.test(String(id)) && verify(id, k)) { void write(stopRow); return { ok: true }; }
    if (!r || !verify(id, k)) return { ok: false };
    if (!r.stopped) {
      r.stopped = true; r.stoppedReason = "link"; r.stoppedAt = at; r.email = null;
      if (PG) void write(stopRow);
      else persist();
      emit("followup_stopped");
    }
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
  // Under a lease: two containers (a deploy's overlap, a second replica)
  // never run this tick at once; without a database it is the plain tick.
  const tick = leased("followups-tick", { ttlMs: 600000, log: log }, tickUnleased);
  async function tickUnleased({ limit = 200 } = {}) {
    await ready;
    if (ticking || !enabled()) return { skipped: "ticking-or-disabled" };
    ticking = true;
    const out = { monitor: 0, another: 0, skipped: 0, failed: 0 };
    try {
      // Database mode: start from the row as it is now (the other container
      // may have stopped, added or sent since this one last read it).
      if (!(await refresh())) return { skipped: "store-unreadable" };
      let n = 0;
      for (const r of Object.values(store.seqs)) {
        if (r.stopped || n >= limit) continue;
        const age = now() - r.createdAt;
        if (!r.sent.monitor && age >= STEP_DELAYS_MS.monitor) {
          n++;
          const mon = monitorFor(r.kind);
          if (!mon) { if (await settle(r, "monitor", "no-monitor")) out.skipped++; }
          else {
            const mine = await claim(r, "monitor");
            if (!mine) { out.skipped++; continue; }
            const sent = await sendMonitorOffer(mine, mon);
            if (sent) { await finish(r, "monitor", mine, now()); out.monitor++; emit("followup_monitor_sent", { kind: r.kind }); } else { await release(r, "monitor", mine); out.failed++; }
          }
          continue; // one email per sequence per tick
        }
        if (!r.sent.another && age >= STEP_DELAYS_MS.another) {
          n++;
          const mine = await claim(r, "another");
          if (!mine) { out.skipped++; continue; }
          const sent = await sendAnother(mine);
          if (sent) { await finish(r, "another", mine, now()); out.another++; emit("followup_another_sent", { kind: r.kind }); } else { await release(r, "another", mine); out.failed++; }
        }
      }
      if (!PG) persist();
    } finally { ticking = false; }
    return out;
  }

  // A step's send is claimed in the row first: the claim is a versioned
  // write that only succeeds while the sequence is open and the step unsent,
  // so of two containers ticking at once exactly one sends. A claim whose
  // send never confirms (a crash between the two) stays claimed: the step is
  // skipped rather than risk a second email. File mode has one writer and
  // marks the step in memory as before.
  async function claim(r, step) {
    if (!PG) return r;
    const mark = `sending:${now()}:${Math.random().toString(36).slice(2, 10)}`;
    const res = await write((seqs) => { const x = Object.hasOwn(seqs, r.id) ? seqs[r.id] : null; if (!x || x.stopped || x.sent?.[step]) return SKIP_UPDATE; x.sent = { ...(x.sent || {}), [step]: mark }; });
    if (!res.ok || !res.changed) return null;
    const fresh = res.body.seqs[r.id];
    if (!fresh || fresh.sent?.[step] !== mark || !fresh.email) return null;
    const sent = { ...fresh.sent }; delete sent[step]; // the email reads the steps already sent, not this claim
    return { ...fresh, sent, _claim: mark };
  }
  async function finish(r, step, mine, value) {
    if (!PG) { r.sent[step] = value; return true; }
    const res = await write((seqs) => { const x = Object.hasOwn(seqs, r.id) ? seqs[r.id] : null; if (!x || x.sent?.[step] !== mine._claim) return SKIP_UPDATE; x.sent[step] = value; });
    return res.ok;
  }
  async function release(r, step, mine) {
    if (!PG) return true;
    const res = await write((seqs) => { const x = Object.hasOwn(seqs, r.id) ? seqs[r.id] : null; if (!x || x.sent?.[step] !== mine._claim) return SKIP_UPDATE; delete x.sent[step]; });
    return res.ok;
  }
  async function settle(r, step, value) {
    if (!PG) { r.sent[step] = value; return true; }
    const res = await write((seqs) => { const x = Object.hasOwn(seqs, r.id) ? seqs[r.id] : null; if (!x || x.sent?.[step]) return SKIP_UPDATE; x.sent = { ...(x.sent || {}), [step]: value }; });
    return res.ok && res.changed;
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
    const drop = (seqs) => {
      let changed = false;
      for (const [id, r] of Object.entries(seqs)) {
        const done = r.stopped || (r.sent.monitor && r.sent.another);
        if (done && now() - r.createdAt > 30 * DAY) { delete seqs[id]; changed = true; }
      }
      return changed;
    };
    const changed = drop(store.seqs);
    if (PG) { if (changed) void write((seqs) => (drop(seqs) ? undefined : SKIP_UPDATE)); }
    else if (changed) persist();
  }

  function stats() {
    const rs = Object.values(store.seqs);
    return { total: rs.length, open: rs.filter((r) => !r.stopped && !(r.sent.monitor && r.sent.another)).length, stopped: rs.filter((r) => r.stopped).length, monitorSent: rs.filter((r) => typeof r.sent.monitor === "number").length, anotherSent: rs.filter((r) => typeof r.sent.another === "number").length, enabled: enabled(), storePath };
  }

  // The link routes' async form: with the database a record the other
  // container made since this one last read the row is read first.
  async function stopAsync(id, k) { if (PG && typeof id === "string" && !recOf(id)) await refresh().catch(() => false); return stop(id, k); }

  let timer = null;
  function start({ intervalMs = 60 * 60_000, firstMs = 3 * 60_000 } = {}) {
    if (timer || !enabled()) return false;
    const run = () => tick().then((r) => { if (r.monitor || r.another) log(`[followups] tick ${JSON.stringify(r)}`); }).catch((e) => log(`[followups] tick failed: ${String(e?.message || e).slice(0, 120)}`));
    timer = setInterval(run, intervalMs); timer.unref?.(); const f = setTimeout(run, firstMs); f.unref?.();
    return true;
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  return { stopAsync, enqueue, markRepeat, stop, sendFailed, tick, prune, stats, start, stopTimer, enabled, ready: () => ready, flush: async () => { while (pending.size) await Promise.allSettled([...pending]); await doc.flush(); }, refresh, _claimStep: (id, step) => claim({ id }, step), _store: () => store };
}
