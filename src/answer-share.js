// Shared answer pages: the opt-in public link for a web.answer call.
//
// Off unless ANSWER_SHARE is exactly "on" (answerShareEnabled): off, share=true
// is ignored and no surface offers it, while pages already made keep serving
// until they expire.
//
// A caller of GET /api/answer that passes share=true gets, beside the answer,
// `share: { url, cardUrl, expiresAt }`: a page on our origin that shows the
// question, the answer and its cited sources, with a 1200x630 card for link
// previews, so an agent can hand its human one link.
//
// SETTLEMENT ORDERING. The handler only reserves the link: an unguessable id
// and the record to store. Nothing is written until the paid response's
// outcome is known (src/hangup-settlement.js onResponseEnd on req.res), and
// then only when the FINAL status is 200 and the call settled (not a charge
// forgiven for a buyer who left, not a first-call allowance grant). A handler success whose settlement fails ends 402, a 4xx or
// 5xx is never settled, and in each case no page exists. Between the answer
// and the write the link answers 404, the same as an id that never existed.
//
// STORAGE. One record per share, kept for SHARE_TTL_MS (ANSWER_SHARE_TTL_DAYS,
// default 30): the `records` table (collection "answer-shares") when the
// state database is configured, else one JSON file per id under
// ANSWER_SHARE_DIR (default /data/answer-shares, or /tmp/answer-shares with
// no volume). At expiry the page answers 410; the hourly sweep (under a lease)
// replaces an expired record with a tombstone that holds only its expiry, so
// the 410 outlives the content, and drops the tombstone TOMBSTONE_MS later;
// from then the address reads as unknown (404), as /privacy says. The
// operator's takedown (removeShare) writes a tombstone at once: 410 "removed".
//
// WHAT A PAGE SHOWS. The answer text passes through sanitizeReportProse
// (src/report-grounding.js), the filter every report product's model prose
// passes: markup and images are removed and a link survives only to a cited
// source's host. The renderer below escapes everything and turns into a link
// only an http(s) URL on a cited host, so a hostile answer, snippet or
// question renders as text.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { sanitizeReportProse } from "./report-grounding.js";
import { stateDbEnabled, stateDbSchema, stateQuery, records, leased } from "./state-db.js";
import { payerFromRequest } from "./payer.js";
import { createLimiter } from "./rate-limit.js";
import { onResponseEnd } from "./hangup-settlement.js";
import { allowanceOf } from "./allowance-state.js";

const DAY_MS = 86_400_000;
/** The switch: shares are created only while ANSWER_SHARE is exactly "on" (read per call). */
export function answerShareEnabled() { return String(process.env.ANSWER_SHARE ?? "").trim() === "on"; }
const intEnv = (name, dflt, lo, hi) => {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
/** How long a shared answer stays readable. */
export const SHARE_TTL_DAYS = intEnv("ANSWER_SHARE_TTL_DAYS", 30, 1, 365);
export const SHARE_TTL_MS = SHARE_TTL_DAYS * DAY_MS;
/** How long an expired share keeps answering 410 before it reads as unknown. */
export const TOMBSTONE_DAYS = 90;
export const TOMBSTONE_MS = TOMBSTONE_DAYS * DAY_MS;
/** Shares one payer (signed wallet, Tempo sender, credits key, else IP) may create per hour. */
export const SHARES_PER_HOUR = intEnv("ANSWER_SHARE_PER_HOUR", 60, 1, 10_000);
export const COLLECTION = "answer-shares";

// Size caps on what is stored (the answer is already capped upstream by its
// token ceiling; these hold however the upstream behaves).
export const CAPS = Object.freeze({ question: 400, answer: 16_000, citations: 20, url: 2048, snippet: 600 });

// 18 random bytes = 144 bits, 24 base64url characters.
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{24}$/;
export const newShareId = () => randomBytes(18).toString("base64url");

/** True for the opt-in values a query string or a JSON body carries. */
export function wantsShare(v) {
  if (v === true) return true;
  return typeof v === "string" && /^(true|1|yes|on)$/i.test(v.trim());
}

let baseUrl = String(process.env.BASE_URL || "").replace(/\/+$/, "");
/** server.js sets the public origin once, when it mounts the routes. */
export function setShareBaseUrl(u) { baseUrl = String(u || "").replace(/\/+$/, ""); }
export const shareUrlOf = (id) => `${baseUrl}/answers/${id}`;
export const cardUrlOf = (id) => `${baseUrl}/answers/${id}/card.png`;

// ---- store ---------------------------------------------------------------
const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
function httpUrl(u) {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
// The same host test sanitizeReportProse applies (host with port, exact).
const hostOf = (u) => { try { return new URL(String(u)).host.toLowerCase(); } catch { return ""; } };

/** The record kept for one share (capped, no payer, no request detail). */
export function shareRecord({ id, query, answer, citations, now = Date.now() }) {
  const cites = (Array.isArray(citations) ? citations : []).slice(0, CAPS.citations).map((c, n) => ({
    url: clip(c?.url, CAPS.url),
    snippet: clip(c?.snippet, CAPS.snippet),
    number: Number.isInteger(c?.number) && c.number > 0 && c.number < 1000 ? c.number : n + 1,
  })).filter((c) => c.url);
  return { v: 1, id, question: clip(query, CAPS.question), answer: clip(answer, CAPS.answer), citations: cites, createdAt: now, expiresAt: now + SHARE_TTL_MS };
}

const fileDir = () => {
  const own = String(process.env.ANSWER_SHARE_DIR || "").trim();
  return own || join(existsSync("/data") ? "/data" : "/tmp", COLLECTION);
};

function createFileStore(dir) {
  const path = (id) => join(dir, `${id}.json`);
  const read = (id) => { try { return JSON.parse(readFileSync(path(id), "utf8")); } catch { return null; } };
  const write = (rec) => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path(rec.id)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, path(rec.id));
  };
  return {
    backend: "file",
    async get(id) { return SHARE_ID_RE.test(id) ? read(id) : null; },
    async put(rec) { write(rec); return true; },
    async sweep(now = Date.now()) {
      let files = [];
      try { files = readdirSync(dir); } catch { return { expired: 0, dropped: 0 }; }
      let expired = 0, dropped = 0;
      for (const f of files) {
        const id = f.endsWith(".json") ? f.slice(0, -5) : "";
        if (!SHARE_ID_RE.test(id)) continue;
        const rec = read(id);
        if (!rec) continue;
        if (rec.expiresAt + TOMBSTONE_MS <= now) { try { unlinkSync(path(id)); dropped++; } catch { /* gone */ } continue; }
        if (!rec.gone && rec.expiresAt <= now) { write({ v: 1, id, expiresAt: rec.expiresAt, gone: true }); expired++; }
      }
      return { expired, dropped };
    },
  };
}

function createPgStore() {
  const RT = () => `${stateDbSchema()}.records`;
  return {
    backend: "pg",
    async get(id) { return SHARE_ID_RE.test(id) ? records.get(COLLECTION, id) : null; },
    async put(rec) { return records.put(COLLECTION, rec.id, rec); },
    async sweep(now = Date.now()) {
      const exp = await stateQuery(
        `UPDATE ${RT()} SET body = jsonb_build_object('v', 1, 'id', id, 'expiresAt', body -> 'expiresAt', 'gone', true), updated_at = now()
         WHERE collection = $1 AND NOT (body ? 'gone') AND (body ->> 'expiresAt')::bigint <= $2`,
        [COLLECTION, now],
      );
      const drop = await stateQuery(
        `DELETE FROM ${RT()} WHERE collection = $1 AND (body ->> 'expiresAt')::bigint <= $2`,
        [COLLECTION, now - TOMBSTONE_MS],
      );
      return { expired: exp.rowCount, dropped: drop.rowCount };
    },
  };
}

let store = null;
export function shareStore() { return (store ??= stateDbEnabled() ? createPgStore() : createFileStore(fileDir())); }
/** Tests: point the module at a fresh store (null re-reads the environment). */
export function __setShareStore(s) { store = s; }
export const __createFileStore = createFileStore;

/** Read one share: { status: "ok", rec } | { status: "gone" | "removed", expiresAt } | { status: "unknown" }. */
export async function readShare(id, now = Date.now()) {
  if (!SHARE_ID_RE.test(String(id || ""))) return { status: "unknown" };
  const rec = await shareStore().get(String(id));
  if (!rec || rec.id !== id) return { status: "unknown" };
  if (rec.removed) return { status: "removed", expiresAt: rec.expiresAt };
  if (rec.gone || !(rec.expiresAt > now)) return { status: "gone", expiresAt: rec.expiresAt };
  return { status: "ok", rec };
}

/**
 * Operator takedown: replace a share with a tombstone that answers 410
 * "removed" (kept, like an expiry's, until TOMBSTONE_MS past the original
 * expiry). The note stays in the tombstone; the log line names the id's
 * first characters only (the id is the page's bearer).
 * Returns { status: "removed" | "already_removed" | "unknown" }.
 */
export async function removeShare(id, note = "", { now = Date.now(), log = console.log } = {}) {
  const sid = String(id || "");
  if (!SHARE_ID_RE.test(sid)) return { status: "unknown" };
  const rec = await shareStore().get(sid);
  if (!rec || rec.id !== sid) return { status: "unknown" };
  if (rec.removed) return { status: "already_removed" };
  const cleanNote = String(note ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  await shareStore().put({ v: 1, id: sid, expiresAt: rec.expiresAt, gone: true, removed: true, removedAt: now, note: cleanNote });
  htmlCache.delete(sid);
  log(`[answer-share] removed ${sid.slice(0, 6)}... by operator${cleanNote ? `: ${cleanNote}` : ""}`);
  return { status: "removed" };
}

// ---- creation (from the answer handler) ------------------------------------
const createLimit = createLimiter("answer-share", { perMin: Math.max(1, Math.ceil(SHARES_PER_HOUR / 3)), perHour: SHARES_PER_HOUR });
const shareKeyOf = (req) => payerFromRequest(req)
  || (req?.mppTempoSender ? `tempo:${req.mppTempoSender}` : null)
  || (req?.creditsKeyId ? `credits:${req.creditsKeyId}` : null)
  || `ip:${req?.ip || "?"}`;

const RESERVATION = Symbol("a402.answerShare");

/**
 * Before the paid work: claim one of the payer's shares for this call.
 * Counted at claim time, so parallel calls cannot overshoot the budget; the
 * claim is given back when the call does not end in a settled 200. A payer
 * over its budget is refused 429 (a 429 is never charged). Returns the
 * reservation, or null when no link can be kept: the switch is off, the
 * request has no response whose outcome can be watched (a direct in-process
 * call), or the call is a first-call allowance grant (never settled).
 */
export function reserveShare(req, { log = console.warn } = {}) {
  if (!answerShareEnabled()) return null;
  if (!req || typeof req !== "object") return null;
  const res = req.res;
  if (!res || typeof res.once !== "function") return null;
  if (allowanceOf(req)?.granted) return null;
  if (Object.hasOwn(req, RESERVATION)) return req[RESERVATION];
  const key = shareKeyOf(req);
  if (createLimit.check(key).limited) {
    const e = new Error(`Share limit reached (${SHARES_PER_HOUR} shared answers an hour per payer). Call again without share, or later. Not charged.`);
    e.statusCode = 429;
    throw e;
  }
  const slot = { key, rec: null };
  const watched = onResponseEnd(req, res, (info) => {
    const settled = !info?.forgiven && !info?.allowance && res.statusCode === 200;
    if (!settled || !slot.rec) { createLimit.refund(key); return; }
    shareStore().put(slot.rec).catch((e) => log(`[answer-share] write failed: ${String(e?.message || e).slice(0, 160)}`));
  });
  if (!watched) { createLimit.refund(key); return null; }
  Object.defineProperty(req, RESERVATION, { value: slot, enumerable: false });
  return slot;
}

/**
 * Fill this call's reservation with the answer. Returns { url, cardUrl,
 * expiresAt } for the answer body, or null when the call holds no reservation
 * (no outcome hook, a grant, the switch off): a link that could never be
 * written is never handed out.
 */
export function prepareShare(req, { query, answer, citations }, { now = Date.now() } = {}) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, RESERVATION)) return null;
  const slot = req[RESERVATION];
  if (slot.rec) return null;
  const id = newShareId();
  slot.rec = shareRecord({ id, query, answer, citations, now });
  return { url: shareUrlOf(id), cardUrl: cardUrlOf(id), expiresAt: new Date(slot.rec.expiresAt).toISOString() };
}

// ---- page ------------------------------------------------------------------
const REL = "nofollow noopener noreferrer ugc";
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Inline text of a sanitized answer: escaped, with links only to cited hosts and [n] to its source. */
function renderInline(text, hosts, numbers) {
  const linkable = (u) => { const h = httpUrl(u); return h && hosts.has(hostOf(h)) ? h : null; };
  const out = [];
  // One left-to-right pass over the three token shapes; everything between
  // them is plain text. Bounded classes only: no nested quantifiers.
  const TOKEN = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)|\[(\d{1,3})\]|(https?:\/\/[^\s<>()"'\]]{1,2048})/g;
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out.push(plain(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const u = linkable(m[2]);
      out.push(u ? `<a href="${esc(u)}" rel="${REL}">${plain(m[1])}</a>` : plain(m[1]));
    } else if (m[3] !== undefined) {
      out.push(numbers.has(Number(m[3])) ? `<a href="#source-${Number(m[3])}" class="as-cite">[${Number(m[3])}]</a>` : esc(m[0]));
    } else {
      const trimmed = m[4].replace(/[.,;:!?]+$/, "");
      const u = linkable(trimmed);
      out.push(u ? `<a href="${esc(u)}" rel="${REL}">${esc(trimmed)}</a>${esc(m[4].slice(trimmed.length))}` : esc(m[4]));
    }
  }
  out.push(plain(text.slice(last)));
  return out.join("");
}
/** Tests: the renderer's own link rule, apart from the sanitizer in front of it. */
export const __renderInline = (text, citations) => renderInline(String(text), new Set(citations.map((c) => hostOf(httpUrl(c?.url) || "")).filter(Boolean)), new Set(citations.map((c) => c?.number)));
// Escaped text with **bold** kept as <strong> (the markers survive escaping unchanged).
const plain = (s) => esc(s).replace(/\*\*([^*\n]{1,400})\*\*/g, "<strong>$1</strong>");

/** The sanitized answer as HTML blocks: paragraphs, bullet lists, and short headings. */
export function renderAnswerHtml(answer, citations) {
  const cites = Array.isArray(citations) ? citations : [];
  const clean = sanitizeReportProse(String(answer || ""), cites);
  const hosts = new Set(cites.map((c) => hostOf(httpUrl(c?.url) || "")).filter(Boolean));
  const numbers = new Set(cites.map((c) => c?.number).filter(Number.isInteger));
  const blocks = clean.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*(?:[-*•]|\d{1,2}[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, ""), hosts, numbers)}</li>`).join("");
      return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    const heading = /^#{1,6}\s+(.{1,200})$/.exec(b);
    if (heading) return `<h3>${renderInline(heading[1], hosts, numbers)}</h3>`;
    return `<p>${lines.map((l) => renderInline(l.replace(/^#{1,6}\s+/, ""), hosts, numbers)).join("<br>")}</p>`;
  }).join("\n");
}

const PAGE_CSS = `
.as-wrap{max-width:1180px;margin:0 auto;padding:44px 30px 56px}
.as-crumb{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:0 0 18px}
.as-crumb a{color:var(--muted);text-decoration:none}
.as-asked{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:0 0 8px}
.as-q{font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1.1;letter-spacing:-.02em;color:var(--ink);margin:0;max-width:76ch;text-wrap:balance;overflow-wrap:break-word}
.as-note{font-size:var(--fs-md);color:var(--muted);margin:14px 0 0;max-width:76ch}
.as-answer{max-width:76ch;margin:30px 0 0;font-size:var(--fs-lg);line-height:1.6;color:var(--ink);overflow-wrap:break-word}
.as-answer p,.as-answer ul,.as-answer ol{margin:0 0 16px}
.as-answer h3{font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);margin:22px 0 10px}
.as-answer a{color:var(--accent)}
.as-cite{font-family:var(--font-mono);font-size:var(--fs-sm);text-decoration:none}
.as-sources{max-width:76ch;margin:36px 0 0;padding:22px 0 0;border-top:1px solid var(--hairline)}
.as-sources h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);margin:0 0 14px;color:var(--ink)}
.as-sources ol{list-style:none;margin:0;padding:0}
.as-sources li{padding:12px 0;border-bottom:1px solid var(--hairline)}
.as-src-n{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin-right:8px}
.as-src-link{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);overflow-wrap:break-word}
.as-src-snip{font-size:var(--fs-md);color:var(--muted);margin:6px 0 0}
.as-foot{max-width:76ch;margin:30px 0 0;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint)}
.as-foot a{color:var(--ink)}
@media(max-width:600px){.as-wrap{padding:30px 16px 40px}.as-q{font-size:var(--fs-2xl)}}
`;

/** The public page for one live share. `price` is the tool's catalog price ("$0.08"). */
export function answerSharePage(rec, { baseUrl: origin = baseUrl, price = "" } = {}) {
  const canonical = `${origin}/answers/${rec.id}`;
  const cites = Array.isArray(rec.citations) ? rec.citations : [];
  const sources = cites.map((c) => {
    const u = httpUrl(c.url);
    const label = esc(u ? (hostOf(u) || u) : c.url);
    const link = u ? `<a class="as-src-link" href="${esc(u)}" rel="${REL}">${label}</a>` : `<span class="as-src-link">${label}</span>`;
    return `<li id="source-${Number(c.number)}"><span class="as-src-n">[${Number(c.number)}]</span>${link}${c.snippet ? `<p class="as-src-snip">${esc(c.snippet)}</p>` : ""}</li>`;
  }).join("");
  const body = `
<div class="as-wrap">
  <nav class="as-crumb" aria-label="Breadcrumb"><a href="/">agent402</a> / <a href="/tools/answer">web.answer</a> / shared answer</nav>
  <p class="as-asked">Asked by the caller</p>
  <h1 class="as-q">${esc(rec.question)}</h1>
  <p class="as-note">A model-backed answer from web.answer, grounded in a live web search and generated for the caller who shared it on ${esc(day(rec.createdAt))}. This page is kept until ${esc(day(rec.expiresAt))}.</p>
  <div class="as-answer">${renderAnswerHtml(rec.answer, cites)}</div>
  ${sources ? `<section class="as-sources"><h2>Sources</h2><ol>${sources}</ol></section>` : ""}
  <p class="as-foot"><a href="/tools/answer">web.answer</a>${price ? ` · ${esc(price)} per call` : ""}</p>
</div>${ledgerFooterCompact()}`;
  return ledgerShell({
    title: `${rec.question.length > 70 ? `${rec.question.slice(0, 68)}…` : rec.question} - shared answer`,
    description: `A cited, model-backed answer from Agent402 web.answer with ${cites.length} source${cites.length === 1 ? "" : "s"}.`,
    canonical, baseUrl: origin, activePath: "__none__", robots: "noindex, nofollow",
    ogImage: `${origin}/answers/${rec.id}/card.png`, extraCss: PAGE_CSS, body,
  });
}

/** The 410 page for an expired or removed share. */
export function answerShareGonePage({ baseUrl: origin = baseUrl, removed = false } = {}) {
  const body = `<div style="max-width:640px;margin:0 auto;padding:96px 26px 80px;text-align:center;">
      <div style="font-family:var(--font-mono);font-weight:500;font-size:var(--fs-hero);line-height:1;letter-spacing:-.03em;color:var(--ink);margin-bottom:14px;">410</div>
      <h1 style="font-weight:800;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">${removed ? "This shared answer was removed" : "This shared answer has expired"}</h1>
      ${removed ? "" : `<p style="color:var(--muted);margin:0 0 28px;font-weight:300;">Shared answers are kept for ${SHARE_TTL_DAYS} days.</p>`}
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <a class="btn btn-secondary" href="/tools/answer">web.answer</a>
        <a class="btn btn-secondary" href="/">Home</a>
      </div>
    </div>${ledgerFooterCompact()}`;
  const what = removed ? "removed" : "expired";
  return ledgerShell({ title: `Shared answer ${what} - Agent402`, description: `Shared answer ${what}`, canonical: `${origin}/`, baseUrl: origin, activePath: "__none__", robots: "noindex, nofollow", body });
}

// ---- card ------------------------------------------------------------------
/** Greedy word wrap to at most `maxLines` of `width` characters; the last line ends in "…" when cut. */
export function wrapLines(text, width, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    if (w.length > width) w = `${w.slice(0, width - 1)}…`;
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) { cur = next; continue; }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) { lines.push(cur); cur = ""; i = words.length; }
  if (i < words.length || cur) {
    const lastLine = lines[maxLines - 1] || "";
    lines[maxLines - 1] = `${lastLine.length >= width ? lastLine.slice(0, width - 1) : lastLine}…`;
  }
  return lines.slice(0, maxLines);
}

/** 1200x630 SVG card for a share; `brand` is server.js's BRAND set (fonts and defs passed in). */
export function answerShareCardSvg(rec, { BRAND, BRAND_DEFS = "", BRAND_FONT_STYLE = "" }) {
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mono = JSON.stringify(BRAND.mono);
  const display = JSON.stringify(BRAND.display);
  const q = wrapLines(rec.question, 32, 3);
  const n = Array.isArray(rec.citations) ? rec.citations.length : 0;
  const lines = q.map((l, i) => `<text x="72" y="${262 + i * 76}" font-size="62" font-weight="600" font-family=${display} letter-spacing="-2" fill="${BRAND.ink}">${x(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${BRAND_FONT_STYLE}${BRAND_DEFS}
  <rect width="1200" height="630" fill="${BRAND.paper}"/>
  <rect x="72" y="64" width="44" height="44" rx="12" fill="url(#milled)"/>
  <text x="132" y="96" font-size="30" font-weight="600" font-family=${display} letter-spacing="-0.5" fill="${BRAND.ink}">Agent402</text>
  <text x="1128" y="95" font-size="20" font-family=${mono} text-anchor="end" fill="${BRAND.faint}">web.answer · ${x(day(rec.createdAt))}</text>
  <text x="72" y="178" font-size="22" font-family=${mono} fill="${BRAND.faint}">Asked by the caller</text>
  ${lines}
  <line x1="72" y1="520" x2="1128" y2="520" stroke="${BRAND.hairline}" stroke-width="2"/>
  <text x="72" y="566" font-size="24" font-family=${mono} fill="${BRAND.accent}">${n} cited source${n === 1 ? "" : "s"}</text>
  <text x="1128" y="566" font-size="24" font-family=${mono} text-anchor="end" fill="${BRAND.muted}">model-backed answer</text>
</svg>`;
}

// ---- routes ----------------------------------------------------------------
// Rendered pages by id. A record never changes once written, so a hostile
// answer is sanitized once, not on every view. Bounded (oldest dropped); the
// store is still read first on every view, so an expiry or a takedown is seen
// at once, and a takedown also drops the entry here.
const HTML_CACHE_MAX = 128;
const htmlCache = new Map();
function cachedPage(rec, render) {
  let html = htmlCache.get(rec.id);
  if (html !== undefined) { htmlCache.delete(rec.id); htmlCache.set(rec.id, html); return html; }
  html = render();
  htmlCache.set(rec.id, html);
  if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
  return html;
}
/** Tests: the rendered-page cache. */
export const __htmlCache = htmlCache;
const secondsLeft = (rec, now) => Math.max(1, Math.floor((rec.expiresAt - now) / 1000));
// Public content kept briefly in caches, so an operator removal takes effect
// within minutes; the lifetime never outlasts the share.
const SHARE_CACHE_SECONDS = 300;
const cacheFor = (rec, now) => `public, max-age=${Math.min(SHARE_CACHE_SECONDS, secondsLeft(rec, now))}`;
const NOINDEX = "noindex, nofollow";

/**
 * Mount GET /answers/:id (the page), /answers/:id.json (the record),
 * /answers/:id/card.png and /answers/:id/card.svg, and the hourly sweep.
 * deps: { baseUrl, notFoundPage(res, opts), rasterizeSvg(svg, size), brand: { BRAND, BRAND_DEFS, BRAND_FONT_STYLE }, priceOf() }
 */
export function mountAnswerShares(app, { baseUrl: origin, notFoundPage, rasterizeSvg, brand, priceOf = () => "", now = () => Date.now(), sweepEveryMs = 3_600_000 } = {}) {
  setShareBaseUrl(origin);
  const pageLimit = createLimiter("answer-share-page", { perMin: 60, perHour: 600 });
  const cardLimit = createLimiter("answer-share-card", { perMin: 20, perHour: 200 });
  const cards = new Map(); // id -> Promise<Buffer>, at most CARD_CACHE entries
  const CARD_CACHE = 64;
  let rendering = 0;
  const MAX_RENDERS = 2;

  const limited = (lim, req, res) => {
    if (!lim.check(req.ip).limited) return false;
    res.set("Retry-After", "60").set("Cache-Control", "no-store").status(429).type("text/plain").send("Too many requests, please slow down.");
    return true;
  };
  const lookup = async (req, res, kind, id = String(req.params.id || "")) => {
    const t = now();
    let r;
    try { r = await readShare(id, t); }
    catch { res.set("Cache-Control", "no-store").set("Retry-After", "30").status(503).type("text/plain").send("Shared answers are briefly unavailable."); return null; }
    res.set("X-Robots-Tag", NOINDEX);
    if (r.status === "ok") return { rec: r.rec, t };
    res.set("Cache-Control", "no-store");
    const removed = r.status === "removed";
    const gone = removed || r.status === "gone";
    if (kind === "json") res.status(gone ? 410 : 404).json({ status: removed ? "removed" : gone ? "expired" : "not_found" });
    else if (kind === "card") res.status(gone ? 410 : 404).type("text/plain").send(removed ? "Removed" : gone ? "Expired" : "Not found");
    else if (gone) res.status(410).type("html").send(answerShareGonePage({ baseUrl: origin, removed }));
    else notFoundPage(res, { what: "Shared answer", href: "/tools/answer", label: "web.answer" });
    return null;
  };

  // One route for both forms: the JSON record lives at its own address
  // (/answers/<id>.json), so a cache never has to choose by Accept.
  app.get("/answers/:id", async (req, res) => {
    if (limited(pageLimit, req, res)) return;
    const raw = String(req.params.id || "");
    const json = raw.endsWith(".json");
    const hit = await lookup(req, res, json ? "json" : "page", json ? raw.slice(0, -5) : raw);
    if (!hit) return;
    const { rec, t } = hit;
    res.set("Cache-Control", cacheFor(rec, t));
    if (json) {
      return res.json({
        question: rec.question, answer: rec.answer, citations: rec.citations,
        createdAt: new Date(rec.createdAt).toISOString(), expiresAt: new Date(rec.expiresAt).toISOString(),
        modelBacked: true, tool: "web.answer", url: `${origin}/answers/${rec.id}`,
      });
    }
    res.type("html").send(cachedPage(rec, () => answerSharePage(rec, { baseUrl: origin, price: priceOf() })));
  });
  app.get("/answers/:id/card.svg", async (req, res) => {
    if (limited(cardLimit, req, res)) return;
    const hit = await lookup(req, res, "card");
    if (!hit) return;
    res.set("Cache-Control", cacheFor(hit.rec, hit.t)).type("image/svg+xml").send(answerShareCardSvg(hit.rec, brand));
  });
  app.get("/answers/:id/card.png", async (req, res) => {
    if (limited(cardLimit, req, res)) return;
    const hit = await lookup(req, res, "card");
    if (!hit) return;
    const { rec, t } = hit;
    let p = cards.get(rec.id);
    if (!p) {
      // The browser pool is shared with paid work: a render beyond the bound
      // is served the SVG card instead of waiting for a slot.
      if (rendering >= MAX_RENDERS) return res.redirect(302, `/answers/${rec.id}/card.svg`);
      rendering++;
      p = Promise.resolve().then(() => rasterizeSvg(answerShareCardSvg(rec, brand), { width: 1200, height: 630 })).finally(() => { rendering--; });
      cards.set(rec.id, p);
      if (cards.size > CARD_CACHE) cards.delete(cards.keys().next().value);
      p.catch(() => cards.delete(rec.id));
    }
    try {
      const png = await p;
      res.set("Cache-Control", cacheFor(rec, t)).type("image/png").send(png);
    } catch {
      res.redirect(302, `/answers/${rec.id}/card.svg`);
    }
  });

  const sweep = leased("answer-shares-sweep", {}, async () => {
    try {
      const r = await shareStore().sweep(now());
      if (r.expired || r.dropped) console.log(`[answer-share] sweep: ${r.expired} expired, ${r.dropped} dropped`);
      return r;
    } catch (e) { console.warn(`[answer-share] sweep failed: ${String(e?.message || e).slice(0, 160)}`); return null; }
  });
  if (sweepEveryMs > 0) setInterval(() => { sweep().catch(() => {}); }, sweepEveryMs).unref();
  return { sweep };
}
