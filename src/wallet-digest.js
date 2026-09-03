// Weekly spend digest for buyers, keyed by the identity they already pay with.
//
// Ninety-two of the 250 wallets that bought in the last sixty days bought
// once, and nothing ever spoke to them again: a wallet has no inbox, and the
// site never asked for one. This is the one place it does. A buyer subscribes
// an email to a payer identity - an EVM wallet (proved by signing a message
// with it) or a prepaid credits key (proved by presenting the key, or by the
// signed link in the key's own claim email) - and gets one email a week:
// calls, dollars, the tools they used, the chains they paid on, and for a
// credits key its balance and a top-up link. Nothing is sent for a quiet
// week after the first digest.
//
// Same posture as free-alerts.js: DOUBLE OPT-IN (the confirmation click is the
// consent record; nothing is stored as active before it), one HMAC-signed
// unsubscribe link in every email that drops the address, counts-only
// operator surface, bounded store, per-address cap. The proof requirement is
// what keeps this from being a way to email a stranger: a wallet signature or
// a live credits key is needed to point a digest at an address, and the
// address itself still has to click.
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DAY = 86_400_000;
export const DIGEST_PERIOD_MS = 7 * DAY;
export const MAX_PER_EMAIL = 3;
export const MAX_STORE = 5000;
export const PENDING_TTL_MS = 3 * DAY;
export const PROOF_MAX_AGE_MS = 15 * 60_000;
export const TICK_SEND_CAP = 200;
const ID_RE = /^dg_[A-Za-z0-9_-]{8,16}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function defaultDigestStorePath() {
  return join(existsSync("/data") ? "/data" : "/tmp", "wallet-digest.json");
}

/** The exact text a wallet signs. Includes the email and a timestamp so a
 *  signature cannot be replayed onto another address or later. */
export function digestProofMessage({ address, email, ts }) {
  return `Agent402 weekly digest: send the spend digest for ${String(address).toLowerCase()} to ${String(email).trim().toLowerCase()} (${ts})`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toFixed(Number(n || 0) >= 1 ? 2 : 4)}`;

/**
 * @param {object} deps
 * @param {(payer:string, opts:{days:number})=>{totals:{calls:number,paidUsd:number},bySlug:{slug:string,calls:number,usd:number}[],byNetwork:Record<string,{calls:number,usd:number}>}} deps.usage
 * @param {(keyId:string)=>number|null|Promise<number|null>} [deps.creditsBalance] USD balance for a credits key id, null when unknown
 * @param {(p:{address:string,message:string,signature:string})=>Promise<boolean>} deps.verifySignature EIP-191 personal_sign check
 * @param {(key:string)=>string|null} [deps.creditsKeyId] resolves a presented credits key to its id (null = unknown key)
 */
export function createWalletDigest({ storePath = defaultDigestStorePath(), sendEmail, secret = "", baseUrl = "https://agent402.tools", now = () => Date.now(), log = console.log, usage, creditsBalance = null, verifySignature, creditsKeyId = null, onEvent = null } = {}) {
  let store = load();
  let ticking = false;

  function load() {
    try { const j = JSON.parse(readFileSync(storePath, "utf8")); return j && typeof j === "object" && j.subs ? j : { subs: {} }; } catch { return { subs: {} }; }
  }
  function persist() {
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(store));
      renameSync(tmp, storePath);
    } catch (e) { log(`[wallet-digest] persist failed: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const emit = (step, extra = {}) => { try { onEvent?.({ step, ...extra }); } catch { /* telemetry never breaks a signup */ } };
  const sign = (id, purpose) => createHmac("sha256", secret).update(`digest:${purpose}:${id}`).digest("base64url").slice(0, 32);
  const verify = (id, purpose, k) => {
    if (!secret || typeof k !== "string" || !id) return false;
    const a = Buffer.from(sign(id, purpose)); const b = Buffer.from(String(k));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const link = (id, purpose) => `${baseUrl}/digest/${purpose}?id=${encodeURIComponent(id)}&k=${sign(id, purpose)}`;
  const enabled = () => Boolean(secret) && typeof sendEmail === "function" && typeof usage === "function";
  const bad = (msg, code = 400) => Object.assign(new Error(msg), { statusCode: code, buyerSafe: true });
  const recOf = (id) => (typeof id === "string" && ID_RE.test(id) && Object.hasOwn(store.subs, id) ? store.subs[id] : null);
  const normEmail = (e) => String(e ?? "").trim().toLowerCase();
  const newId = () => `dg_${randomBytes(9).toString("base64url")}`;

  function findExisting(payer, email) {
    return Object.values(store.subs).find((s) => s.payer === payer && s.email === email && s.status !== "unsubscribed") || null;
  }

  /** Create-or-resend for a proven payer + address. Returns {ok, status}. */
  async function enrol({ kind, payer, email, source = "" }) {
    if (!enabled()) throw bad("Digests are not available right now.", 503);
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail) || mail.length > 254) throw bad("Enter a valid email address.");
    const dup = findExisting(payer, mail);
    if (dup) {
      if (dup.status === "active") return { ok: true, status: "active" };
      const sends = dup.confirmSends || 0;
      if (sends < 3 && (!dup.confirmSentAt || now() - dup.confirmSentAt >= 10 * 60_000)) {
        if (await sendConfirm(dup)) { dup.confirmSends = sends + 1; dup.confirmSentAt = now(); persist(); }
      }
      return { ok: true, status: "pending" };
    }
    const mine = Object.values(store.subs).filter((s) => s.email === mail && s.status !== "unsubscribed");
    if (mine.length >= MAX_PER_EMAIL) throw bad(`That address already has ${MAX_PER_EMAIL} digests. Unsubscribe from one first.`);
    if (Object.keys(store.subs).length >= MAX_STORE) throw bad("Digest signups are full right now. Please try again later.", 503);
    const rec = { id: newId(), kind, payer, email: mail, status: "pending", createdAt: now(), source: String(source || "").slice(0, 40), sends: 0, lastSentAt: null };
    store.subs[rec.id] = rec;
    persist();
    if (!(await sendConfirm(rec))) { delete store.subs[rec.id]; persist(); throw bad("We could not send the confirmation email right now. Please try again in a few minutes.", 503); }
    rec.confirmSends = 1; rec.confirmSentAt = now(); persist();
    emit("digest_signup", { kind });
    return { ok: true, status: "pending" };
  }

  /** Public signup: a wallet proves itself with a signature over
   *  digestProofMessage; a credits key proves itself by being presented. */
  async function signup({ email, wallet, message, signature, creditsKey, source = "" } = {}) {
    if (!enabled()) throw bad("Digests are not available right now.", 503);
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail)) throw bad("Enter a valid email address.");
    if (typeof creditsKey === "string" && creditsKey.trim()) {
      if (typeof creditsKeyId !== "function") throw bad("Credits keys cannot subscribe here.", 503);
      const keyId = creditsKeyId(creditsKey.trim());
      if (!keyId) throw bad("That credits key is not recognised.", 403);
      return enrol({ kind: "credits", payer: `credits:${keyId}`, email: mail, source });
    }
    const address = String(wallet || "").trim();
    if (!EVM_RE.test(address)) throw bad("Enter the wallet address you pay from (an EVM address), or a credits key.");
    if (typeof verifySignature !== "function") throw bad("Wallet signatures cannot be verified right now.", 503);
    const m = String(message || "");
    const ts = Number((m.match(/\((\d{10,16})\)$/) || [])[1]);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > PROOF_MAX_AGE_MS) throw bad("The signed message has expired. Sign a fresh one.");
    if (m !== digestProofMessage({ address, email: mail, ts })) throw bad("The signed message does not match this wallet and email.");
    let okSig = false;
    try { okSig = await verifySignature({ address, message: m, signature: String(signature || "") }); } catch { okSig = false; }
    if (!okSig) throw bad("The signature does not verify for that wallet.", 403);
    return enrol({ kind: "wallet", payer: address.toLowerCase(), email: mail, source });
  }

  /** Server-side pre-enrolment for a freshly minted credits key: creates the
   *  pending record and returns the confirm link to put in the claim email.
   *  Consent is still the click. Returns null when disabled. */
  function preEnrolCredits({ keyId, email }) {
    if (!enabled()) return null;
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail) || !keyId) return null;
    const payer = `credits:${String(keyId)}`;
    let rec = findExisting(payer, mail);
    if (!rec) {
      if (Object.keys(store.subs).length >= MAX_STORE) return null;
      rec = { id: newId(), kind: "credits", payer, email: mail, status: "pending", createdAt: now(), source: "credits-claim", sends: 0, lastSentAt: null, confirmSends: 1, confirmSentAt: now() };
      store.subs[rec.id] = rec; persist();
    }
    return rec.status === "active" ? null : link(rec.id, "confirm");
  }

  async function sendConfirm(rec) {
    const url = link(rec.id, "confirm");
    const who = rec.kind === "credits" ? "your credits key" : `wallet ${rec.payer.slice(0, 6)}…${rec.payer.slice(-4)}`;
    const subject = "Confirm your weekly Agent402 spend digest";
    const text = `Confirm to receive one email a week with what ${who} spent on Agent402: calls, dollars, the tools and chains.\n\n${url}\n\nNothing is sent for a quiet week. If you did not ask for this, ignore it and nothing will be sent.`;
    const html = shell(`<h2 style="margin:0 0 10px;font-size:18px;">Confirm your weekly digest</h2>
<p>One email a week with what ${esc(who)} spent on Agent402: calls, dollars, the tools and the chains.</p>
<p style="margin:18px 0;"><a href="${esc(url)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Confirm the digest</a></p>
<p style="color:#5C6963;font-size:13px;">Nothing is sent for a quiet week. If you did not ask for this, ignore it and nothing will be sent.</p>`);
    return sendEmail({ to: rec.email, subject, html, text });
  }

  function confirm(id, k) {
    const rec = recOf(id);
    if (!rec || !verify(id, "confirm", k)) return { ok: false, reason: "invalid" };
    if (rec.status === "unsubscribed") return { ok: false, reason: "unsubscribed" };
    if (rec.status !== "active") { rec.status = "active"; rec.confirmedAt = now(); persist(); emit("digest_confirmed", { kind: rec.kind }); }
    return { ok: true, kind: rec.kind };
  }

  function unsubscribe(id, k) {
    const rec = recOf(id);
    if (!rec || !verify(id, "unsubscribe", k)) return { ok: false, reason: "invalid" };
    if (rec.status !== "unsubscribed") { rec.status = "unsubscribed"; rec.unsubscribedAt = now(); rec.email = null; persist(); emit("digest_unsubscribed", { kind: rec.kind }); }
    return { ok: true, kind: rec.kind };
  }

  function sweep() {
    let changed = false;
    for (const [id, s] of Object.entries(store.subs)) {
      if (s.status === "pending" && now() - s.createdAt > PENDING_TTL_MS) { delete store.subs[id]; changed = true; }
    }
    if (changed) persist();
  }

  /** The digest for one record, or null when there is nothing worth sending. */
  async function buildDigest(rec) {
    const payer = rec.kind === "credits" ? rec.payer.slice("credits:".length) : rec.payer;
    const u = await usage(payer, { days: 7 });
    const calls = Number(u?.totals?.calls || 0);
    if (!calls && rec.sends > 0) return null; // quiet week after the first digest: nothing sent
    const top = (u?.bySlug || []).slice().sort((a, b) => (b.usd || 0) - (a.usd || 0) || (b.calls || 0) - (a.calls || 0)).slice(0, 5);
    const chains = Object.entries(u?.byNetwork || {}).sort((a, b) => (b[1].usd || 0) - (a[1].usd || 0)).slice(0, 4);
    let balanceUsd = null;
    if (rec.kind === "credits" && typeof creditsBalance === "function") { try { balanceUsd = await creditsBalance(payer); } catch { balanceUsd = null; } }
    return { calls, paidUsd: Number(u?.totals?.paidUsd || 0), top, chains, balanceUsd };
  }

  async function sendDigest(rec, d) {
    const unsub = link(rec.id, "unsubscribe");
    const who = rec.kind === "credits" ? "your credits key" : `${rec.payer.slice(0, 6)}…${rec.payer.slice(-4)}`;
    const subject = d.calls ? `Agent402 this week: ${d.calls} call${d.calls === 1 ? "" : "s"}, ${money(d.paidUsd)}` : "Agent402 this week: no calls yet";
    const topText = d.top.length ? d.top.map((t) => `  ${t.slug}: ${t.calls} call${t.calls === 1 ? "" : "s"}, ${money(t.usd)}`).join("\n") : "  (no calls this week)";
    const chainText = d.chains.length ? d.chains.map(([n, v]) => `  ${n}: ${v.calls} call${v.calls === 1 ? "" : "s"}, ${money(v.usd)}`).join("\n") : "";
    const balanceText = d.balanceUsd == null ? "" : `\nCredits balance: ${money(d.balanceUsd)}. Top up: ${baseUrl}/credits\n`;
    const text = `Spend for ${who} on Agent402, last 7 days:\n\nCalls: ${d.calls}\nPaid: ${money(d.paidUsd)}\n\nTop tools:\n${topText}\n${chainText ? `\nChains:\n${chainText}\n` : ""}${balanceText}\nFull history (paid, wallet-keyed): ${baseUrl}/tools/my-usage\n\nUnsubscribe: ${unsub}`;
    const rows = d.top.map((t) => `<tr><td style="padding:4px 10px 4px 0;font-family:ui-monospace,Menlo,monospace;font-size:13px;">${esc(t.slug)}</td><td style="padding:4px 10px;text-align:right;">${t.calls}</td><td style="padding:4px 0;text-align:right;">${money(t.usd)}</td></tr>`).join("");
    const chainRows = d.chains.map(([n, v]) => `<tr><td style="padding:4px 10px 4px 0;font-family:ui-monospace,Menlo,monospace;font-size:13px;">${esc(n)}</td><td style="padding:4px 10px;text-align:right;">${v.calls}</td><td style="padding:4px 0;text-align:right;">${money(v.usd)}</td></tr>`).join("");
    const html = shell(`<h2 style="margin:0 0 6px;font-size:18px;">Your week on Agent402</h2>
<p style="margin:0 0 14px;color:#5C6963;">${esc(who)}, last 7 days</p>
<p style="font-size:22px;margin:0 0 16px;"><b>${d.calls}</b> call${d.calls === 1 ? "" : "s"} &middot; <b>${money(d.paidUsd)}</b></p>
${rows ? `<h3 style="font-size:14px;margin:16px 0 6px;">Top tools</h3><table style="border-collapse:collapse;">${rows}</table>` : "<p>No calls this week.</p>"}
${chainRows ? `<h3 style="font-size:14px;margin:16px 0 6px;">Chains</h3><table style="border-collapse:collapse;">${chainRows}</table>` : ""}
${d.balanceUsd == null ? "" : `<p style="margin:16px 0 0;">Credits balance: <b>${money(d.balanceUsd)}</b> &middot; <a href="${esc(baseUrl)}/credits">top up</a></p>`}
<p style="margin:18px 0 0;font-size:13px;color:#5C6963;">Full history, paid and wallet-keyed: <a href="${esc(baseUrl)}/tools/my-usage">my-usage</a>. <a href="${esc(unsub)}">Unsubscribe</a>.</p>`);
    return sendEmail({ to: rec.email, subject, html, text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  }

  /** Weekly cadence per record: a digest is due 7 days after the last one (or at once for a fresh confirmation). */
  async function tick({ limit = TICK_SEND_CAP, force = false } = {}) {
    if (ticking) return { skipped: "busy" };
    ticking = true;
    const out = { due: 0, sent: 0, quiet: 0, failed: 0 };
    try {
      sweep();
      const t = now();
      const due = Object.values(store.subs).filter((s) => s.status === "active" && (force || !s.lastSentAt || t - s.lastSentAt >= DIGEST_PERIOD_MS)).slice(0, limit);
      out.due = due.length;
      for (const rec of due) {
        let d = null;
        try { d = await buildDigest(rec); } catch (e) { out.failed++; log(`[wallet-digest] build failed for ${rec.id}: ${String(e?.message || e).slice(0, 120)}`); continue; }
        if (!d) { rec.lastSentAt = t; out.quiet++; continue; } // a quiet week still advances the clock
        if (await sendDigest(rec, d)) { rec.sends = (rec.sends || 0) + 1; rec.lastSentAt = t; out.sent++; emit("digest_sent", { kind: rec.kind }); }
        else out.failed++;
      }
      persist();
    } finally { ticking = false; }
    return out;
  }

  function shell(inner) {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#141A17;max-width:520px;">
<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#5C6963;margin-bottom:14px;">agent402 &middot; weekly digest</div>
${inner}
</div>`;
  }

  /** Counts only - never addresses or payers. */
  function stats() {
    const by = { pending: 0, active: 0, unsubscribed: 0 };
    const byKind = {};
    let sent = 0;
    for (const s of Object.values(store.subs)) { by[s.status] = (by[s.status] || 0) + 1; byKind[s.kind] = (byKind[s.kind] || 0) + (s.status === "active" ? 1 : 0); sent += s.sends || 0; }
    return { total: Object.keys(store.subs).length, ...by, activeByKind: byKind, digestsSent: sent, enabled: enabled(), storePath };
  }

  let timer = null;
  function start({ intervalMs = 60 * 60_000, firstMs = 10 * 60_000 } = {}) {
    if (timer || !enabled()) return false;
    const run = () => tick().then((r) => { if (r.due) log(`[wallet-digest] tick ${JSON.stringify(r)}`); }).catch((e) => log(`[wallet-digest] tick failed: ${String(e?.message || e).slice(0, 120)}`));
    timer = setInterval(run, intervalMs); timer.unref?.();
    const first = setTimeout(run, firstMs); first.unref?.();
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { signup, preEnrolCredits, confirm, unsubscribe, tick, stats, start, stop, enabled, sign, _store: () => store };
}
