// The credits balance page for people: sign in by email, then buy credits
// (every purchase is made signed in, bound to that email), see each balance
// and its history, top it up, set its spending limits, export a CSV, ask for
// the unspent balance back, issue a new key for a lost one, or revoke a key. Served
// only while credits are on sale (CREDITS_SALES); with sales off every route
// here falls through as if it did not exist.
//
// Sign-in is a link emailed to the purchase address: a signed token (HMAC over
// the address, an expiry SIGN_IN_TTL_MS out and a random nonce), used once
// (the nonce is recorded until the expiry). Opening the link shows a button;
// pressing it (a same-origin POST) spends the token, so a mail scanner that
// fetches the link signs nobody in. A request for a link answers the same for
// every well-formed address and every address gets the link (a new buyer
// signs in before a first purchase); the send runs after the answer, so
// neither the body nor the timing says whether an address holds a balance. Requests are rate-limited per address and per
// client address.
//
// The session is an opaque random id in an HttpOnly, SameSite=Strict cookie
// scoped to /credits/account (Secure on an https site); the server keeps only
// a digest of it with the address, an idle deadline (SESSION_IDLE_MS, moved by
// use) and an absolute one (SESSION_MAX_MS). Signing out removes it. Every
// write carrying the cookie must come from one of our own pages
// (Sec-Fetch-Site same-origin, or an Origin equal to the site's).
//
// No key is needed to manage a balance and no key is ever put in a URL: the
// page acts on the key id, and a new key is answered once in a POST response.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { SKIP_UPDATE } from "./json-document.js";
import { escapeHtml, headerText } from "./email-text.js";

export const ACCOUNT_PATH = "/credits/account";
export const ACCOUNT_COOKIE = "a402_acct";
import { SIGN_IN_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, signInLifeWords, lowBalanceWords, lowBalanceUsd } from "./credits-figures.js";
export { SIGN_IN_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS };
const TOUCH_MS = 60_000;
/** A new key is issued only to a session whose sign-in link was used this recently. */
export const NEW_KEY_FRESH_SIGN_IN_MS = 10 * 60_000;
/** How often ended sessions and expired link records are deleted from the store. */
export const ACCOUNT_SWEEP_MS = 10 * 60_000;
export const SIGN_IN_ANSWER = `A sign-in link is on its way to that address. It works once, for ${signInLifeWords()}.`;
const LINK_LIFE_NOTE = () => `Sign-in links work once, for ${signInLifeWords()}.`;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/;
const SID_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_RE = /^[0-9a-f]{12}$/;
export const normEmail = (e) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);
const digest = (s) => createHash("sha256").update(String(s)).digest("hex");
const b64 = (s) => Buffer.from(s).toString("base64url");
const unb64 = (s) => { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch { return ""; } };
const sameBytes = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/** The signing key the page's tokens use, derived from the card processor's secret (no extra variable to set). */
export const accountSecretFrom = (stripeSecret) => (stripeSecret ? createHmac("sha256", String(stripeSecret)).update("credits-account-signing").digest() : null);

// ---- emails (plain HTML: mail clients strip stylesheets, so the few styles
// are palette literals; sendEmail appends the company postal address) -------
// design-tokens: literal-start (email HTML)
const mailWrap = (title, inner) => `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111315"><h2 style="font-weight:700;color:#111315">${escapeHtml(title)}</h2>${inner}</div>`;
const mailP = (t) => `<p style="color:#3A3F45;line-height:1.55">${t}</p>`;
const mailFine = (t) => `<p style="color:#626970;font-size:12px;margin-top:26px">${t}</p>`;
const mailLink = (url, label) => `<a href="${escapeHtml(url)}" style="color:#0F5E43">${escapeHtml(label)}</a>`;
// design-tokens: literal-end
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export function buildSignInEmail({ link }) {
  const subject = "Sign in to your Agent402 credits balance";
  const lead = `Open this link to buy prepaid credits or manage your balance: see what it holds and what it paid for, add to it, set its spending limits, ask for the unspent balance back, or issue a new key. It works once, for ${signInLifeWords()}.`;
  const why = "You are getting this because someone asked to sign in with this email address at agent402.tools/credits/account. If that was not you, you can ignore this email; nothing changes.";
  const html = mailWrap(subject, `${mailP(escapeHtml(lead))}${mailP(mailLink(link, "Sign in to your balance"))}${mailFine(escapeHtml(why))}`);
  const text = `${subject}\n\n${lead}\n\n${link}\n\n${why}\n\nAgent402`;
  return { subject, html, text };
}

export function buildReceiptEmail({ kind, amountUsd, balanceUsd, keyId, at, paymentIntent, accountUrl, termsUrl, termsVersion }) {
  const what = kind === "topup" ? "Top-up" : "Purchase";
  const subject = `Your Agent402 credits receipt: ${usd(amountUsd)} ${kind === "topup" ? "added" : "loaded"}`;
  const ref = paymentIntent ? String(paymentIntent).slice(-10) : null;
  const rows = [
    ["Item", `Agent402 prepaid credits (${what.toLowerCase()})`],
    ["Amount paid", `${usd(amountUsd)}, North Carolina sales tax included where it applies`],
    ["Balance now", usd(balanceUsd)],
    ["Key id", keyId],
    ["Date", String(at).slice(0, 10)],
    ...(ref ? [["Payment reference", `...${ref}`]] : []),
    ...(termsVersion ? [["Terms accepted", `version ${termsVersion}`]] : []),
  ];
  const terms = "Credits are spent only on Agent402's own services, at list price, and only when a call succeeds. They never expire, carry no fees, and the unspent balance is refunded to the card that paid on request.";
  // design-tokens: literal-start (email HTML)
  const table = `<table style="border-collapse:collapse;font-size:14px;color:#3A3F45">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#626970">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`).join("")}</table>`;
  // design-tokens: literal-end
  const html = mailWrap(subject, `${table}${mailP(escapeHtml(terms))}${mailP(`${mailLink(accountUrl, "Manage your balance")} · ${mailLink(termsUrl, "Terms of Service")}`)}`);
  const text = `${subject}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${terms}\n\nManage your balance: ${accountUrl}\nTerms of Service: ${termsUrl}\n\nAgent402`;
  return { subject, html, text };
}

export function buildLowBalanceEmail({ balanceUsd, keyId, accountUrl, unsubscribeUrl }) {
  const subject = `Your Agent402 credits balance is low: ${usd(balanceUsd)} left`;
  const lead = `The prepaid credits balance on key ${keyId} is down to ${usd(balanceUsd)}. Calls it cannot cover answer 402 with the balance and nothing is charged. Add to it from your balance page.`;
  const why = `We send this once each time the balance drops under ${lowBalanceWords()}. You can turn this notice off for this balance with the link below; receipts and sign-in links still arrive.`;
  const html = mailWrap(subject, `${mailP(escapeHtml(lead))}${mailP(mailLink(accountUrl, "Add to your balance"))}${mailFine(`${escapeHtml(why)} ${mailLink(unsubscribeUrl, "Stop low-balance emails")}`)}`);
  const text = `${subject}\n\n${lead}\n\nAdd to your balance: ${accountUrl}\n\n${why}\nStop low-balance emails: ${unsubscribeUrl}\n\nAgent402`;
  return { subject, html, text };
}

export function buildSpendLimitEmail({ keyId, limitUsd, accountUrl, unsubscribeUrl }) {
  const subject = "Your Agent402 credits key reached its daily limit";
  const lead = `A call on key ${keyId} was refused because it would pass the ${usd(limitUsd)} daily limit set on this balance. Nothing was charged. The limit resets at 00:00 UTC; change it from your balance page.`;
  const why = "We send this at most once a day per balance. You can turn off these notices with the link below; receipts and sign-in links still arrive.";
  const html = mailWrap(subject, `${mailP(escapeHtml(lead))}${mailP(mailLink(accountUrl, "Your balance page"))}${mailFine(`${escapeHtml(why)} ${mailLink(unsubscribeUrl, "Stop these emails")}`)}`);
  const text = `${subject}\n\n${lead}\n\nYour balance page: ${accountUrl}\n\n${why}\nStop these emails: ${unsubscribeUrl}\n\nAgent402`;
  return { subject, html, text };
}

export function buildNewKeyEmail({ keyId, accountUrl }) {
  const subject = "A new key was issued for your Agent402 credits balance";
  const lead = `A new key was issued from your balance page for the balance with key id ${keyId}. The previous key no longer works; the balance and its history moved to the new key, which was shown once on the page.`;
  const why = "If that was not you, sign in to your balance page and issue another key, then reply to this email.";
  const html = mailWrap(subject, `${mailP(escapeHtml(lead))}${mailP(mailLink(accountUrl, "Your balance page"))}${mailFine(escapeHtml(why))}`);
  const text = `${subject}\n\n${lead}\n\nYour balance page: ${accountUrl}\n\n${why}\n\nAgent402`;
  return { subject, html, text };
}

/**
 * @param {object} d
 * @param {object} d.credits      createCredits() (balancesForEmail, historyFor, ...)
 * @param {string} d.baseUrl
 * @param {Buffer|string|null} d.secret  signing key (accountSecretFrom); without it the page signs nobody in
 * @param {(m:object)=>Promise<boolean>} d.sendEmail
 * @param {object} d.store        a json-document (createJsonDocument) for sessions and spent tokens
 * @param {{check:(k:string)=>{limited:boolean}}} d.ipLimiter
 * @param {{check:(k:string)=>{limited:boolean}}} d.emailLimiter
 */
export function createCreditsAccount({ credits, baseUrl, secret, sendEmail, store, ipLimiter, emailLimiter, termsVersion = () => null, now = () => Date.now(), log = console.log, sweepEveryMs = ACCOUNT_SWEEP_MS }) {
  const mac = (purpose, body) => createHmac("sha256", secret).update(`${purpose}|${body}`).digest("base64url");
  const accountUrl = `${baseUrl}${ACCOUNT_PATH}`;

  function signInToken(email, at = now()) {
    const body = b64(JSON.stringify({ e: normEmail(email), x: at + SIGN_IN_TTL_MS, n: randomBytes(12).toString("base64url") }));
    return `${body}.${mac("signin", body)}`;
  }
  // The token's claims when its signature holds and it has not expired, else null.
  function readToken(token) {
    if (!secret || typeof token !== "string" || token.length > 600) return null;
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const body = token.slice(0, dot), sig = token.slice(dot + 1);
    if (!sameBytes(sig, mac("signin", body))) return null;
    let c;
    try { c = JSON.parse(unb64(body)); } catch { return null; }
    if (!c || typeof c.e !== "string" || typeof c.n !== "string" || !Number.isFinite(c.x) || c.x < now()) return null;
    return c;
  }
  const signInLink = (email) => `${accountUrl}/verify?t=${encodeURIComponent(signInToken(email))}`;

  // Low-balance notice off, by link: signed over the key id, no expiry (an
  // unsubscribe link keeps working).
  const noticeSig = (keyId) => mac("low-notice-off", keyId).slice(0, 32);
  const noticeOffLink = (keyId) => `${baseUrl}/credits/low-balance/off?key=${encodeURIComponent(keyId)}&k=${noticeSig(keyId)}`;
  const noticeOffValid = (keyId, k) => Boolean(secret) && KEY_ID_RE.test(String(keyId || "")) && typeof k === "string" && sameBytes(k, noticeSig(keyId));

  // ---- the store: { sessions: { <sid digest>: { e, exp, idle, touched } }, used: { <nonce>: exp } }
  // An ended session (idle or past its maximum) and the record of a used link
  // past its expiry are deleted: by every read and write of the store below
  // and by a sweep every ACCOUNT_SWEEP_MS, as /privacy says.
  const live = (s, t) => Boolean(s) && s.exp > t && s.idle > t;
  const prune = (b, t) => {
    b.sessions = Object.fromEntries(Object.entries(b.sessions || {}).filter(([, s]) => live(s, t)));
    b.used = Object.fromEntries(Object.entries(b.used || {}).filter(([, x]) => Number(x) > t));
    return b;
  };
  const stale = (b, t) => Object.values(b?.sessions || {}).some((s) => !live(s, t)) || Object.values(b?.used || {}).some((x) => !(Number(x) > t));
  /** Delete every ended session and expired link record now; answers how many went. */
  async function sweep() {
    const t = now();
    let removed = 0;
    await store.update((b) => {
      if (!b || typeof b !== "object" || !stale(b, t)) return SKIP_UPDATE;
      const before = Object.keys(b.sessions || {}).length + Object.keys(b.used || {}).length;
      prune(b, t);
      removed = before - Object.keys(b.sessions).length - Object.keys(b.used).length;
      return b;
    }, { fallback: {} });
    return removed;
  }
  const sweepQuietly = () => sweep().catch((e) => { log(`[credits-account] sweep failed: ${String(e?.message || e).slice(0, 160)}`); return 0; });
  let sweepTimer = null;
  if (store && sweepEveryMs > 0) { sweepTimer = setInterval(sweepQuietly, sweepEveryMs); sweepTimer.unref?.(); }

  /** Ask for a sign-in link. Answers { status, message } at once; the lookup and the send run after. */
  function requestSignIn(rawEmail, ip) {
    if (!secret) return { status: 503, message: "Signing in is not available on this server." };
    if (ipLimiter?.check(String(ip || "?")).limited) return { status: 429, message: "Too many requests. Please try again in a few minutes." };
    const email = normEmail(rawEmail);
    if (!validEmail(email)) return { status: 400, message: "Enter your email address." };
    if (emailLimiter?.check(`e:${digest(email).slice(0, 32)}`).limited) return { status: 429, message: "Too many requests. Please try again in a few minutes." };
    const work = (async () => {
      await sweepQuietly();
      const sent = await sendEmail({ to: email, ...buildSignInEmail({ link: signInLink(email) }) });
      if (!sent) log("[credits-account] a sign-in email was not sent");
      return sent;
    })().catch((e) => { log(`[credits-account] sign-in request failed: ${String(e?.message || e).slice(0, 160)}`); return false; });
    return { status: 200, message: SIGN_IN_ANSWER, work };
  }

  /** Spend a sign-in token: a new session id, or null (bad, expired or already used). */
  async function redeem(token) {
    const c = readToken(token);
    if (!c) return null;
    const sid = randomBytes(32).toString("base64url");
    const t = now();
    let fresh = false;
    const r = await store.update((b) => {
      b = prune(b && typeof b === "object" ? b : {}, t);
      if (Object.hasOwn(b.used, c.n)) { fresh = false; return SKIP_UPDATE; }
      fresh = true;
      b.used[c.n] = c.x;
      b.sessions[digest(sid)] = { e: c.e, exp: t + SESSION_MAX_MS, idle: t + SESSION_IDLE_MS, touched: t, at: t };
      return b;
    }, { fallback: {} });
    if (!r.ok || !fresh) return null;
    return { sid, email: c.e };
  }

  /** The signed-in address for a session id (its idle deadline moves), or null. */
  async function sessionEmail(sid) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
    const id = digest(sid);
    const t = now();
    let email = null;
    const r = await store.update((b) => {
      b = b && typeof b === "object" ? b : {};
      const s = b.sessions && Object.hasOwn(b.sessions, id) ? b.sessions[id] : null;
      const old = stale(b, t);
      if (old) prune(b, t);
      if (!live(s, t)) { email = null; return old ? b : SKIP_UPDATE; }
      email = s.e;
      if (t - (Number(s.touched) || 0) < TOUCH_MS) return old ? b : SKIP_UPDATE;
      b.sessions[id] = { ...s, idle: Math.min(s.exp, t + SESSION_IDLE_MS), touched: t };
      return b;
    }, { fallback: {} });
    return r.ok ? email : null;
  }

  /** Whether this live session's sign-in link was used within `ms` (read only;
   *  a session stored before the sign-in time was recorded is not fresh). */
  async function signedInWithin(sid, ms) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) return false;
    const id = digest(sid);
    const t = now();
    const r = await store.read().catch(() => null);
    const b = r?.ok ? r.body : null;
    const s = b?.sessions && Object.hasOwn(b.sessions, id) ? b.sessions[id] : null;
    const at = Number(s?.at);
    return live(s, t) && Number.isFinite(at) && at <= t && t - at <= ms;
  }

  async function signOut(sid) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) return;
    const id = digest(sid);
    const t = now();
    await store.update((b) => {
      const mine = Boolean(b?.sessions) && Object.hasOwn(b.sessions, id);
      if (!mine && !stale(b, t)) return SKIP_UPDATE;
      if (mine) delete b.sessions[id];
      return prune(b, t);
    }, { fallback: {} });
  }

  // ---- the notices credits.js raises (wired in server.js) -----------------
  function sendLowBalance({ keyId, email, balanceUsd }) {
    if (!email || !secret) return Promise.resolve(false);
    const unsub = noticeOffLink(keyId);
    const m = buildLowBalanceEmail({ balanceUsd, keyId, accountUrl, unsubscribeUrl: unsub });
    return sendEmail({ to: email, subject: headerText(m.subject), html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }).catch(() => false);
  }
  function sendSpendLimit({ keyId, email, limitUsd }) {
    if (!email || !secret) return Promise.resolve(false);
    const unsub = noticeOffLink(keyId);
    const m = buildSpendLimitEmail({ keyId, limitUsd, accountUrl, unsubscribeUrl: unsub });
    return sendEmail({ to: email, subject: headerText(m.subject), html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }).catch(() => false);
  }
  function sendReceipt(r) {
    if (!r?.email) return Promise.resolve(false);
    const m = buildReceiptEmail({ ...r, accountUrl, termsUrl: `${baseUrl}/terms`, termsVersion: termsVersion() });
    return sendEmail({ to: r.email, subject: headerText(m.subject), html: m.html, text: m.text }).catch(() => false);
  }
  function sendNewKeyNotice({ keyId, email }) {
    if (!email) return Promise.resolve(false);
    const m = buildNewKeyEmail({ keyId, accountUrl });
    return sendEmail({ to: email, subject: headerText(m.subject), html: m.html, text: m.text }).catch(() => false);
  }

  return { requestSignIn, redeem, sessionEmail, signedInWithin, signOut, sweep, stopSweep: () => { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; }, signInToken, readToken, signInLink, noticeOffLink, noticeOffValid, sendLowBalance, sendSpendLimit, sendReceipt, sendNewKeyNotice, enabled: () => Boolean(secret) };
}

// ---- HTTP ---------------------------------------------------------------------
const readCookie = (req, name) => {
  const raw = req.headers?.cookie;
  if (typeof raw !== "string") return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
};
// A write must come from one of our own pages.
export function sameOriginWrite(req, siteOrigin) {
  if (String(req.headers?.["sec-fetch-site"] || "").toLowerCase() === "same-origin") return true;
  const origin = req.headers?.origin;
  return Boolean(siteOrigin) && typeof origin === "string" && origin === siteOrigin;
}
// History as CSV: one row per entry, newest first; a cell that a spreadsheet
// would read as a formula is quoted with a leading apostrophe.
export function historyCsv(h) {
  const cell = (v) => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["date", "type", "tool", "amount_usd"].join(",")];
  for (const r of [...(h.holds || []), ...(h.rows || [])]) lines.push([r.at, r.type, r.tool ?? "", Number(r.amountUsd || 0).toFixed(6)].map(cell).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Mount the page's routes. Every route answers only while `salesOn()`; with
 * sales off each one calls next() and the site answers as if it were absent.
 */
export function mountCreditsAccount(app, { express, account, credits, baseUrl, salesOn, clientIp, page, writeLimiter, packs, capUsd, log = console.log }) {
  const siteOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
  const secure = /^https:/i.test(baseUrl);
  const cookie = (v, maxAgeS) => `${ACCOUNT_COOKIE}=${v}; Path=${ACCOUNT_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  const noStore = (res) => res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  const form = express.urlencoded({ extended: false, limit: "4kb" });
  const refuseCross = (req, res) => {
    if (sameOriginWrite(req, siteOrigin)) return false;
    res.status(403).json({ error: "This request must come from the balance page." });
    return true;
  };
  // A signed-in request: the address, or a 401 answer.
  const who = async (req, res) => {
    const email = await account.sessionEmail(readCookie(req, ACCOUNT_COOKIE)).catch(() => null);
    if (!email) { noStore(res); res.status(401).json({ error: "Sign in to manage your balance.", signIn: `${ACCOUNT_PATH}` }); return null; }
    return email;
  };
  const keyIdOf = (v) => (KEY_ID_RE.test(String(v || "")) ? String(v) : null);
  const limited = (req, res) => {
    if (!writeLimiter?.check(clientIp(req)).limited) return false;
    res.status(429).json({ error: "Too many requests, please slow down. Nothing moved." });
    return true;
  };

  app.get(`${ACCOUNT_PATH}/app.js`, (req, res, next) => {
    if (!salesOn()) return next();
    let buf;
    try { buf = readFileSync(new URL("../assets/credits/account.js", import.meta.url)); } catch { return next(); }
    res.set("Cache-Control", "public, max-age=300").type("application/javascript").send(buf);
  });
  app.get(ACCOUNT_PATH, (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res).type("html").send(page.account());
  });
  app.post(`${ACCOUNT_PATH}/sign-in`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const r = account.requestSignIn(req.body?.email, clientIp(req));
    res.status(r.status).json(r.status === 200 ? { ok: true, message: r.message } : { error: r.message });
  });
  app.get(`${ACCOUNT_PATH}/verify`, (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res).set("Referrer-Policy", "no-referrer");
    const t = String(req.query.t || "");
    if (!account.readToken(t)) return res.status(400).type("html").send(page.notice("This sign-in link has expired", `<p>${LINK_LIFE_NOTE()} <a href="${ACCOUNT_PATH}">Ask for a new one</a>.</p>`));
    res.type("html").send(page.verify(t));
  });
  app.post(`${ACCOUNT_PATH}/verify`, form, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res).set("Referrer-Policy", "no-referrer");
    if (!sameOriginWrite(req, siteOrigin)) return res.status(403).type("html").send(page.notice("Open the link again", `<p>Sign in from the link in your email. <a href="${ACCOUNT_PATH}">Back to your balance</a>.</p>`));
    const s = await account.redeem(String(req.body?.t || "")).catch(() => null);
    if (!s) return res.status(400).type("html").send(page.notice("This sign-in link has expired", `<p>${LINK_LIFE_NOTE()} <a href="${ACCOUNT_PATH}">Ask for a new one</a>.</p>`));
    res.setHeader("Set-Cookie", cookie(s.sid, Math.floor(SESSION_MAX_MS / 1000)));
    res.redirect(303, ACCOUNT_PATH);
  });
  app.post(`${ACCOUNT_PATH}/sign-out`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    await account.signOut(readCookie(req, ACCOUNT_COOKIE)).catch(() => {});
    res.setHeader("Set-Cookie", cookie("", 0));
    res.json({ ok: true });
  });
  app.get(`${ACCOUNT_PATH}/session.json`, async (req, res, next) => {
    if (!salesOn()) return next();
    const email = await who(req, res);
    if (!email) return;
    noStore(res).json({ email, balances: await credits.balancesForEmail(email), packs: packs(), capUsd: capUsd(), lowNoticeUsd: lowBalanceUsd() });
  });
  app.get(`${ACCOUNT_PATH}/history.json`, async (req, res, next) => {
    if (!salesOn()) return next();
    const email = await who(req, res);
    if (!email) return;
    const h = keyIdOf(req.query.key) ? await credits.historyFor(keyIdOf(req.query.key), email) : null;
    if (!h) return noStore(res).status(404).json({ error: "No balance with that id is on this account." });
    noStore(res).json(h);
  });
  app.get(`${ACCOUNT_PATH}/history.csv`, async (req, res, next) => {
    if (!salesOn()) return next();
    const email = await who(req, res);
    if (!email) return;
    const id = keyIdOf(req.query.key);
    const h = id ? await credits.historyFor(id, email) : null;
    if (!h) return noStore(res).status(404).json({ error: "No balance with that id is on this account." });
    noStore(res).set("Content-Disposition", `attachment; filename="agent402-credits-${id}.csv"`).type("text/csv").send(historyCsv(h));
  });
  app.post(`${ACCOUNT_PATH}/top-up`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    try { res.json({ url: (await credits.createTopupCheckout(keyIdOf(req.body?.key), email, req.body?.pack, { ip: clientIp(req) })).url }); }
    catch (e) {
      if (e?.buyerSafe) return res.status(e.statusCode || 400).json({ error: String(e.message).slice(0, 300), ...(e.roomUsd != null ? { roomUsd: e.roomUsd, capUsd: e.capUsd } : {}) });
      log(`[credits-account] top-up checkout failed: ${String(e?.message || e).slice(0, 160)}`);
      res.status(500).json({ error: "Could not start checkout. Please try again in a moment." });
    }
  });
  // A new purchase, made signed in: the checkout is bound to this email.
  app.post(`${ACCOUNT_PATH}/buy`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    try { res.json({ url: (await credits.createCheckout(req.body?.pack, { email, ip: clientIp(req) })).url }); }
    catch (e) {
      if (e?.buyerSafe) return res.status(e.statusCode || 400).json({ error: String(e.message).slice(0, 300), ...(e.validPacks ? { validPacks: e.validPacks } : {}) });
      log(`[credits-account] checkout failed: ${String(e?.message || e).slice(0, 160)}`);
      res.status(500).json({ error: "Could not start checkout. Please try again in a moment." });
    }
  });
  // The holder's spending limits on one balance.
  app.post(`${ACCOUNT_PATH}/limits`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    const dailyUsd = num(req.body?.dailyUsd), perCallUsd = num(req.body?.perCallUsd);
    if ([dailyUsd, perCallUsd].some((v) => v !== null && !(Number.isFinite(v) && v >= 0))) return res.status(400).json({ error: "A limit is a number of dollars, zero or more; leave it empty for no limit." });
    const id = keyIdOf(req.body?.key);
    const r = id ? await credits.setLimits(id, email, { dailyUsd, perCallUsd }) : { status: "unknown" };
    if (r.status !== "set") return res.status(404).json({ error: "No balance with that id is on this account." });
    res.json(r);
  });
  // Revoke a balance's key: it stops working at once; nothing is spent.
  app.post(`${ACCOUNT_PATH}/revoke`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    const id = keyIdOf(req.body?.key);
    const r = id ? await credits.revokeFor(id, email) : { status: "unknown" };
    if (r.status !== "revoked") return res.status(404).json({ error: "No balance with that id is on this account." });
    res.json({ ...r, message: "The key is revoked and no longer works. The unspent balance stays refundable to the card that paid, from this page." });
  });
  const REFUND_SAID = {
    refunded: (r) => `The unspent balance was refunded to the card that paid ($${Number(r.refundedUsd || 0).toFixed(2)}); the balance is closed.`,
    nothing_to_refund: () => "This balance holds nothing unspent; nothing was refunded.",
    pending: (r) => `The refund of $${Number(r.refundUsd || 0).toFixed(2)} is recorded and the balance is closed, but the card refund has not gone through yet. Ask again to retry; if it still cannot be sent, we refund it by hand.`,
    in_flight: () => "A call on this balance is still running; ask again when it ends. Nothing moved.",
    disputed: () => "The payment for this balance is under a dispute, so the dispute settles what goes back to the card.",
    unknown: () => "No balance with that id is on this account.",
  };
  const REFUND_HTTP = { refunded: 200, nothing_to_refund: 200, pending: 202, in_flight: 409, disputed: 409, unknown: 404 };
  app.post(`${ACCOUNT_PATH}/refund`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    const id = keyIdOf(req.body?.key);
    let r;
    try { r = id ? await credits.requestRefundFor(id, email) : { status: "unknown" }; }
    catch (e) { log(`[credits-account] refund request failed: ${String(e?.message || e).slice(0, 160)}`); return res.status(503).json({ status: "error", error: "Could not take the refund request right now; nothing moved. Retry shortly." }); }
    res.status(REFUND_HTTP[r.status] || 500).json({ ...r, message: (REFUND_SAID[r.status] || (() => ""))(r) });
  });
  app.post(`${ACCOUNT_PATH}/new-key`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    if (limited(req, res)) return;
    // A new key is a credential: it is issued only on a fresh sign-in (a link
    // used in the last NEW_KEY_FRESH_SIGN_IN_MS), not on a long-lived session.
    const fresh = await account.signedInWithin(readCookie(req, ACCOUNT_COOKIE), NEW_KEY_FRESH_SIGN_IN_MS).catch(() => false);
    if (!fresh) return res.status(403).json({ status: "sign_in_again", error: `Issuing a new key needs a fresh sign-in: request a new sign-in link and use it, then issue the key within ${NEW_KEY_FRESH_SIGN_IN_MS / 60_000} minutes. The current key still works.`, signIn: `${ACCOUNT_PATH}` });
    const id = keyIdOf(req.body?.key);
    let r;
    try { r = id ? await credits.issueNewKey(id, email) : { status: "unknown" }; }
    catch (e) { log(`[credits-account] new key failed: ${String(e?.message || e).slice(0, 160)}`); return res.status(503).json({ status: "error", error: "Could not issue a new key right now; the current key still works. Retry shortly." }); }
    if (r.status === "issued") return res.json(r);
    res.status(r.status === "in_flight" ? 409 : 404).json({ status: r.status, error: r.status === "in_flight" ? "A call on this balance is still running; try again when it ends. The current key still works." : "No balance with that id is on this account." });
  });
  app.post(`${ACCOUNT_PATH}/low-notice`, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    if (refuseCross(req, res)) return;
    const email = await who(req, res);
    if (!email) return;
    const id = keyIdOf(req.body?.key);
    const held = id ? (await credits.balancesForEmail(email)).some((b) => b.keyId === id) : false;
    if (!held) return res.status(404).json({ error: "No balance with that id is on this account." });
    await credits.setLowNotice(id, req.body?.on === true);
    res.json({ ok: true, lowNotice: req.body?.on === true });
  });
  // The low-balance email's own link: GET shows a button, POST (the button,
  // or a mail client's one-click unsubscribe) turns the notice off.
  app.get("/credits/low-balance/off", (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    const id = String(req.query.key || ""), k = String(req.query.k || "");
    if (!account.noticeOffValid(id, k)) return res.status(400).type("html").send(page.notice("That link did not work", `<p>The link is invalid. Turn the notice off from <a href="${ACCOUNT_PATH}">your balance page</a>.</p>`));
    res.type("html").send(page.noticeOff(id, k));
  });
  app.post("/credits/low-balance/off", form, async (req, res, next) => {
    if (!salesOn()) return next();
    noStore(res);
    const id = String(req.query.key || req.body?.key || ""), k = String(req.query.k || req.body?.k || "");
    const ok = account.noticeOffValid(id, k) && await credits.setLowNotice(id, false).catch(() => false);
    if (/application\/json/.test(String(req.get("accept") || "")) || !req.is("application/x-www-form-urlencoded") || !req.body?.confirm) return res.status(ok ? 200 : 400).json({ ok: !!ok });
    res.status(ok ? 200 : 400).type("html").send(ok ? page.notice("Low-balance emails are off", `<p>We will not email you when this balance runs low. Receipts and sign-in links still arrive. <a href="${ACCOUNT_PATH}">Your balance page</a></p>`) : page.notice("That link did not work", `<p>Turn the notice off from <a href="${ACCOUNT_PATH}">your balance page</a>.</p>`));
  });
}
