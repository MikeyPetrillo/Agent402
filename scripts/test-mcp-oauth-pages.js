#!/usr/bin/env node
// The connector sign-in pages (src/mcp-oauth-page.js), read the way a person
// and a screen reader meet them: the REAL server in paid mode (Stripe
// answered by a local stub, mail caught by a local sink), each step's HTML
// fetched as a browser would and checked for
//   - exactly one h1 on every step and on the error page
//   - an error line with role="alert", tied to its field (aria-describedby,
//     aria-invalid), whose color after the cascade is the error token
//   - a lockout that disables the code form and offers a new code
//   - Allow (or the purchase) before Deny on the choose step
//   - the balance page named as a link, and no "key" said to the person
//   - names and addresses that wrap between words, never inside one
//
//   node scripts/test-mcp-oauth-pages.js
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { bootPaidServer } from "./lib/paid-boot.js";
import { guardsTable } from "./lib/credits-guards-table.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- a small reading of the page: tags, the open-element chain, the cascade ----
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const attrsOf = (s) => Object.fromEntries([...String(s).matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1].toLowerCase(), m[2] ?? ""]));
/** Every element with its attributes and the chain of open elements above it. */
function elements(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  const out = [], stack = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) { const i = stack.map((e) => e.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
    const el = { tag, attrs: attrsOf(m[3]), at: m.index, parents: [...stack] };
    out.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(el);
  }
  return out;
}
const classesOf = (el) => String(el.attrs.class || "").split(/\s+/).filter(Boolean);
// A compound selector (tag, classes, id) against one element.
function compoundMatches(sel, el) {
  const m = /^([a-z0-9*]+)?((?:[.#][A-Za-z0-9_-]+)*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && m[1] !== "*" && m[1] !== el.tag) return false;
  for (const part of m[2].match(/[.#][A-Za-z0-9_-]+/g) || []) {
    if (part[0] === "." && !classesOf(el).includes(part.slice(1))) return false;
    if (part[0] === "#" && el.attrs.id !== part.slice(1)) return false;
  }
  return true;
}
// A descendant selector: the last part names the element, the rest its ancestors in order.
function selectorMatches(selector, el) {
  const parts = selector.replace(/\s*>\s*/g, " ").trim().split(/\s+/);
  if (parts.some((p) => /[:[\]]/.test(p))) return false;
  if (!compoundMatches(parts.at(-1), el)) return false;
  let i = el.parents.length - 1;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (i >= 0 && !compoundMatches(parts[p], el.parents[i])) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}
const specificity = (selector) => {
  const s = selector.replace(/\s*>\s*/g, " ");
  return [(s.match(/#/g) || []).length, (s.match(/\./g) || []).length, s.split(/\s+/).filter((p) => /^[a-z]/.test(p)).length];
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// The style sheet less its at-rule blocks (media queries, keyframes): the
// cascade read here is the default one, the light scheme at full width.
function withoutAtRules(css) {
  let out = "", i = 0;
  while (i < css.length) {
    const at = css.indexOf("@", i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = css.indexOf("{", at), semi = css.indexOf(";", at);
    if (j < 0 || (semi >= 0 && semi < j)) { i = semi < 0 ? css.length : semi + 1; continue; }
    let depth = 0;
    for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
    i = j + 1;
  }
  return out;
}
/** The `prop` value the page's style sheets give `el` (inline style first). */
function cascaded(html, el, prop) {
  const inline = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(el.attrs.style || "");
  if (inline) return inline[1].trim();
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const flat = withoutAtRules(css);
  let best = null, order = 0;
  for (const rule of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    order++;
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule[2]);
    if (!decl) continue;
    for (const sel of rule[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!selectorMatches(sel, el)) continue;
      const spec = specificity(sel);
      if (!best || cmp(spec, best.spec) > 0 || (cmp(spec, best.spec) === 0 && order >= best.order)) best = { spec, order, value: decl[1].trim(), sel };
    }
  }
  return best?.value ?? null;
}
const h1s = (html) => elements(html).filter((e) => e.tag === "h1");

// ---- stubs: Stripe and mail ----------------------------------------------------------------
const sessions = new Map();
const stripeStub = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, "http://x");
    if (req.method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const f = new URLSearchParams(body);
      const id = `cs_test_${randomBytes(6).toString("hex")}`;
      sessions.set(id, { id, object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, customer_email: f.get("customer_email"), customer_details: { email: f.get("customer_email") }, metadata: { credits_pack: f.get("metadata[credits_pack]"), ...(f.get("metadata[credits_account]") ? { credits_account: f.get("metadata[credits_account]") } : {}) }, success_url: f.get("success_url"), cancel_url: f.get("cancel_url") });
      return send(200, { id, object: "checkout.session", url: `https://checkout.stripe.com/c/${id}` });
    }
    let m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (m && sessions.has(m[1])) return send(200, sessions.get(m[1]));
    m = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (m) return send(200, { id: m[1], object: "payment_intent", latest_charge: { id: `ch_${m[1]}`, object: "charge", amount: 2000, amount_refunded: 0, payment_method_details: { card: { fingerprint: `fp_${m[1]}` } } } });
    send(404, { error: { type: "invalid_request_error", message: `stub: ${req.method} ${u.pathname}` } });
  });
});
await new Promise((r) => stripeStub.listen(0, "127.0.0.1", r));
const mails = [];
const mailSink = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => { try { const j = JSON.parse(body); mails.push({ to: j.to?.[0]?.email_address?.address, subject: j.subject, text: j.textbody }); } catch { /* not ours */ } res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
});
await new Promise((r) => mailSink.listen(0, "127.0.0.1", r));
const waitCode = async (to, n) => {
  for (let i = 0; i < 100; i++) {
    const got = mails.filter((m) => m.to === to && /sign-in code/.test(m.subject || ""));
    if (got.length >= n) return (/\b(\d{6})\b/.exec(got[n - 1].text || "") || [])[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

const OL = guardsTable().mcpOAuth;
const srv = await bootPaidServer({ label: "mcp-oauth-pages", args: ["--import", "./scripts/lib/stripe-stub-preload.js"], env: {
  STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_STUB_PORT: String(stripeStub.address().port), STRIPE_WEBHOOK_SECRET: "",
  CREDITS_SALES: "on", MCP_OAUTH: "on", CREDITS_GUARDS_JSON: process.env.CREDITS_GUARDS_JSON,
  ZEPTOMAIL_URL: `http://127.0.0.1:${mailSink.address().port}/send`, ZEPTOMAIL_TOKEN: "t", RESEND_API_KEY: "", EMAIL_FROM: "credits@agent402.tools", COMPANY_POSTAL_ADDRESS: "PO Box 1, Test Town, NC 00000",
  BASE_URL: "https://agent402.tools", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
} });
const B = srv.url;
const same = { "sec-fetch-site": "same-origin" };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// One error line: role=alert, tied to `field`, and the error color after the cascade.
function errorLine(html, field, label) {
  const els = elements(html);
  const alert = els.find((e) => e.attrs.role === "alert");
  ok(Boolean(alert), `${label}: the error line has role="alert"`);
  if (!alert) return;
  const input = els.find((e) => e.attrs.id === field);
  const tied = input && alert.attrs.id && String(input.attrs["aria-describedby"] || "").split(/\s+/).includes(alert.attrs.id) && input.attrs["aria-invalid"] === "true";
  ok(Boolean(tied), `${label}: the error is tied to its field (#${field} aria-describedby, aria-invalid)`);
  const color = cascaded(html, alert, "color");
  ok(color === "var(--bad)", `${label}: the error line's color after the cascade is the error token (${color})`);
}
const oneH1 = (html, label) => { const n = h1s(html).length; ok(n === 1, `${label}: one h1 (${n})`); };
// Every button on a sign-in step is a 44px target after the cascade (a person
// signs in from a phone): min-height, or the padding and line box that make it.
function tapTargets(html, label) {
  const btns = elements(html).filter((e) => e.tag === "button" && e.parents.some((p) => classesOf(p).includes("oc-wrap")));
  const short = btns.filter((b) => !(parseFloat(cascaded(html, b, "min-height") || "0") >= 44)).map((b) => `button.${classesOf(b).join(".")}${b.attrs.value ? `[${b.attrs.value}]` : ""}`);
  ok(btns.length > 0 && short.length === 0, `${label}: ${btns.length} buttons are at least 44px tall${short.length ? ` (not: ${short.join(" | ")})` : ""}`);
}
const csrfIn = (html) => (/name="csrf" value="([^"]+)"/.exec(html) || [])[1];

try {
  const reg = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }) })).json();
  const start = async () => {
    const v = randomBytes(32).toString("base64url");
    const a = await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state: "st", code_challenge_method: "S256", code_challenge: createHash("sha256").update(v).digest("base64url") })}`, { redirect: "manual" });
    return { rid: new URL(a.headers.get("location"), B).searchParams.get("rid"), cookie: (a.headers.get("set-cookie") || "").split(";")[0] };
  };
  const page = async (s) => (await fetch(`${B}/oauth/consent?rid=${s.rid}`, { headers: { cookie: s.cookie } })).text();
  const post = async (s, fields, html) => { const r = await fetch(`${B}/oauth/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie, ...same }, body: new URLSearchParams({ rid: s.rid, csrf: csrfIn(html), ...fields }).toString() }); return { status: r.status, location: r.headers.get("location"), html: await r.text() }; };

  // ---- the email step ----
  const S = await start();
  let html = await page(S);
  oneH1(html, "email step");
  tapTargets(html, "email step");
  ok(!elements(html).some((e) => e.attrs.role === "alert"), "email step: no error line before anything went wrong");
  const app = elements(html).find((e) => classesOf(e).includes("oc-app"));
  const wrap = app ? cascaded(html, app, "overflow-wrap") : null;
  ok(app && wrap && wrap !== "anywhere" && cascaded(html, app, "word-break") !== "break-all", `the app's name and address wrap between words, never inside one (overflow-wrap ${wrap})`);
  let r = await post(S, { action: "email", email: "not-an-email" }, html);
  ok(r.status === 400, "email step: a bad address is refused");
  errorLine(r.html, "oc-email", "email step");
  oneH1(r.html, "email step with an error");

  // ---- the code step ----
  const email = "pages@example.com";
  r = await post(S, { action: "email", email }, r.html);
  oneH1(r.html, "code step");
  const code = await waitCode(email, 1);
  ok(/^\d{6}$/.test(code || ""), "setup: a code is mailed");
  const wrong = code === "000000" ? "111111" : "000000";
  r = await post(S, { action: "code", code: wrong }, r.html);
  ok(r.status === 400, "code step: a wrong code is refused");
  errorLine(r.html, "oc-code", "code step");
  ok(/name="action" value="email"/.test(r.html) && /Send a new code/.test(r.html), "code step: a new code can be asked for in place");

  // ---- lockout: the code form is disabled, a new code is offered ----
  let L = await start();
  let lh = await page(L);
  lh = (await post(L, { action: "email", email: "locked@example.com" }, lh)).html;
  let locked = null;
  for (let i = 0; i < OL.failsPerEmail + OL.emailCodeTries + 2 && !locked; i++) {
    const x = await post(L, { action: "code", code: String(100000 + i) }, lh);
    if (x.status === 429) { locked = x; break; }
    lh = x.html;
    if (!/id="oc-code"/.test(lh)) lh = (await post(L, { action: "email", email: "locked@example.com" }, lh)).html;
    if (!/id="oc-code"/.test(lh)) { L = await start(); lh = await page(L); lh = (await post(L, { action: "email", email: "locked@example.com" }, lh)).html; }
  }
  ok(Boolean(locked), "setup: wrong codes lock the email out");
  if (locked) {
    const els = elements(locked.html);
    const input = els.find((e) => e.attrs.id === "oc-code");
    const submit = input && els.find((e) => e.tag === "button" && e.parents.includes(input.parents.find((p) => p.tag === "form")));
    ok(input && "disabled" in input.attrs && submit && "disabled" in submit.attrs, "lockout: the code field and its button are disabled");
    ok(/Send a new code/.test(locked.html) && /Use another email/.test(locked.html), "lockout: a new code and another email are offered");
    errorLine(locked.html, "oc-code", "lockout");
    oneH1(locked.html, "lockout");
    tapTargets(locked.html, "lockout");
  }

  // ---- the choose step, empty: buying comes before Deny ----
  const cd = await waitCode(email, 1);
  r = await post(S, { action: "code", code: cd }, r.html);
  oneH1(r.html, "choose step, no balance");
  tapTargets(r.html, "choose step, no balance");
  const buyAt = r.html.indexOf("Buy by card"), denyAt = r.html.indexOf(">Deny<");
  ok(buyAt > 0 && denyAt > buyAt, "choose step, no balance: the purchase comes before Deny");
  const pack = (/name="pack"><option value="([^"]+)"/.exec(r.html) || [])[1];
  const buy = await post(S, { action: "buy", pack }, r.html);
  const sess = [...sessions.values()].at(-1);
  ok(buy.status === 303 && sess, "setup: a balance is bought by card");
  html = await (await fetch(`${B}/oauth/consent/bought?rid=${S.rid}&session=${sess.id}`, { headers: { cookie: S.cookie } })).text();

  // ---- the choose step with a balance ----
  oneH1(html, "choose step");
  tapTargets(html, "choose step");
  const allowAt = html.indexOf(">Allow<"), denyAt2 = html.indexOf(">Deny<");
  ok(allowAt > 0 && denyAt2 > allowAt, "choose step: Allow comes before Deny");
  const link = elements(html).find((e) => e.tag === "a" && e.attrs.href === "/credits/account");
  ok(Boolean(link) && /balance page<\/a>/.test(html), "choose step: the balance page is a link to /credits/account");
  const pcard = html.slice(html.indexOf('class="pcard"'), html.indexOf("</section>"));
  ok(!/\bkeys?\b/i.test(pcard.replace(/<[^>]+>/g, " ")), "choose step: the person is told nothing about a key");
  ok(/cannot read or move the balance/.test(html), "choose step: the promise the 402 keeps (the balance is never told to the app)");
  const keyId = (/name="keyId" value="([0-9a-f]{12})"/.exec(html) || [])[1];
  r = await post(S, { action: "approve", keyId, capUsd: "0" }, html);
  ok(r.status === 400, "choose step: a bad cap is refused");
  errorLine(r.html, "oc-cap", "choose step");
  oneH1(r.html, "choose step with an error");

  // ---- the error page ----
  const gone = await fetch(`${B}/oauth/consent?rid=${"0".repeat(32)}`);
  const gh = await gone.text();
  ok(gone.status === 400, "setup: an unknown sign-in answers the error page");
  oneH1(gh, "error page");
} catch (e) {
  fail++;
  console.error(`FAIL - threw: ${e?.stack || e}\n${srv.log().slice(-3000)}`);
} finally {
  await srv.stop();
  stripeStub.close(); mailSink.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
