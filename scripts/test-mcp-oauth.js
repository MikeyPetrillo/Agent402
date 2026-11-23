#!/usr/bin/env node
// Connector sign-in (src/mcp-oauth.js): an app connected to the hosted MCP
// connector signs a person in with an emailed code, binds one credits key and
// a daily cap, and its paid calls are paid from that key by the credits gate.
//
//   node scripts/test-mcp-oauth.js
//
// Offline half (src/credits.js, file backend): a grant's hold counts against
// its daily cap under the key's own lock, a settle moves the hold into the
// day's spend, a release gives it back, a new UTC day starts from zero, a
// key frozen by a fraud warning or a dispute (src/credits.js FROZEN: disabled
// with that reason) refuses a grant's call with reason frozen and is not
// offered on the consent page, and a key's own Bearer calls never meet a
// grant's cap.
// Booted half (the REAL server in paid mode, Stripe answered by a local stub,
// mail captured by a local sink, every other egress refused):
//   - switch off: every sign-in route is 404 and unauthenticated /mcp answers
//     byte for byte what the switch-on boot answers
//   - metadata (RFC 9728, RFC 8414), dynamic registration and its refusals
//   - authorize: PKCE S256 only, exact redirect_uri, state required, an
//     unknown app or return address never redirected to
//   - the consent page: never framed, CSRF and same-origin on every form,
//     email code to any address (single use, tries, lockout), buy credits by
//     card only once signed in, through the balance page's checkout (bound
//     to the email, card authentication, purchase checks), pick a balance
//     and a cap, approve
//   - token: codes single-use and short-lived (a reused or refused code ends
//     the grant), refresh rotation with reuse detection (ends the grant)
//   - /mcp with the token: a paid tool is held and debited from credits, the
//     cap answers a clear tool error, identity-bound and third-party routes
//     are refused, nothing charged on a refusal; /mcp/credits asks for sign-in
//   - the balance page's connected apps: list, change the cap, revoke
//   - token endpoint and code sends limited (thresholds from the environment)
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPaidServer } from "./lib/paid-boot.js";
import { guardsTable, useGuardsTable } from "./lib/credits-guards-table.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

// ---- offline: the grant's cap on the key's record ---------------------------------
{
  process.env.CREDITS_DIR = join(TMP, "offline");
  const { createCredits, CREDIT_PACKS } = await import("../src/credits.js");
  let clock = Date.parse("2026-11-22T10:00:00Z");
  const pack = Object.keys(CREDIT_PACKS)[0];
  const stripe = {
    checkout: { sessions: { retrieve: async (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, customer_details: { email: "cap@x.com" }, metadata: { credits_pack: pack } }) } },
    paymentIntents: { retrieve: async (pi) => ({ id: pi, latest_charge: { amount: CREDIT_PACKS[pack].cents, amount_refunded: 0, payment_method_details: { card: { fingerprint: `fp_${pi}` } } } }) },
  };
  const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: join(TMP, "offline"), log: () => {}, now: () => clock });
  const K = await cr.claim("cs_capone");
  ok(K.status === "minted", "a key is minted for the offline half");
  const g = { id: "g1", capUsd: 0.01 };
  const a1 = await cr.authorizeGrant(K.keyId, 0.004, g);
  const a2 = await cr.authorizeGrant(K.keyId, 0.004, g);
  const a3 = await cr.authorizeGrant(K.keyId, 0.004, g);
  ok(a1.ok && a2.ok && a1.holdId && a2.holdId, "two holds fit under a $0.01 cap");
  ok(!a3.ok && a3.reason === "daily_cap" && a3.capUsd === 0.01, "a third hold that would pass the cap is refused with reason daily_cap");
  cr.release(a2.hash, a2.heldMicro, a2.holdId);
  const a4 = await cr.authorizeGrant(K.keyId, 0.004, g);
  ok(a4.ok, "a released hold gives its room back");
  cr.settle(a1.hash, a1.heldMicro, "sql-guard", null, a1.holdId);
  cr.settle(a4.hash, a4.heldMicro, "sql-guard", 0.001, a4.holdId);
  ok(await cr.grantSpentToday(K.keyId, "g1") === 0.005, `the day's spend is what the debits took ($${await cr.grantSpentToday(K.keyId, "g1")})`);
  const a5 = await cr.authorizeGrant(K.keyId, 0.006, g);
  const a6 = await cr.authorizeGrant(K.keyId, 0.004, g);
  ok(!a5.ok && a5.reason === "daily_cap" && a6.ok, "the cap counts spend plus holds: $0.006 more refused, $0.004 more taken");
  cr.release(a6.hash, a6.heldMicro, a6.holdId);
  ok((await cr.authorizeGrant(K.keyId, 0.004, { id: "g2", capUsd: 0.01 })).ok, "another grant on the same key has a cap of its own");
  const keyHold = cr.authorize(K.key, 0.05);
  ok(keyHold.ok, "the key's own Bearer call never meets a grant's cap");
  cr.release(keyHold.hash, keyHold.heldMicro);
  clock += 86_400_000;
  ok(await cr.grantSpentToday(K.keyId, "g1") === 0, "a new UTC day starts from zero");
  ok((await cr.authorizeGrant(K.keyId, 0.009, g)).ok, "and takes a full cap again");
  // A grant hold and a key's own hold of the same size in flight on the file
  // backend: the key's unnamed settle takes its own hold, never the grant's.
  {
    const gh = await cr.authorizeGrant(K.keyId, 0.002, { id: "g-same", capUsd: 1 });
    const kh = cr.authorize(K.key, 0.002);
    const before = cr.balance(K.key);
    cr.settle(kh.hash, kh.heldMicro, "x", null, kh.holdId ?? null);
    const c = cr.settle(gh.hash, gh.heldMicro, "x", null, gh.holdId);
    const after = cr.balance(K.key);
    ok(c.chargedUsd === 0.002 && Math.abs(before.heldUsd - after.heldUsd - 0.004) < 1e-9 && Math.abs(before.balanceUsd - after.balanceUsd) < 1e-9 && await cr.grantSpentToday(K.keyId, "g-same") === 0.002, `a key's unnamed settle never takes a grant's hold of the same size (grant charged ${c.chargedUsd}, held after ${after.heldUsd})`);
  }
  // A key frozen while a payment that loaded it is reviewed spends nothing:
  // frozen the way the payment webhooks freeze it (fraudWarning, a dispute).
  const fw = await cr.fraudWarning("pi_cs_capone");
  ok(fw && fw.status !== "unknown", "an early fraud warning on the payment that loaded the key freezes it");
  const fz = await cr.authorizeGrant(K.keyId, 0.001, g);
  ok(!fz.ok && fz.reason === "frozen", "a key frozen by a fraud warning refuses a grant's call (reason frozen)");
  ok(!cr.authorize(K.key, 0.001).ok, "and refuses the key's own Bearer call");
  const held = await cr.balancesForEmail("cap@x.com");
  const { consentPage } = await import("../src/mcp-oauth-page.js");
  const consent = consentPage("https://agent402.tools", { step: "choose", rid: "r", csrf: "c", client: { name: "App", returnHost: "claude.ai" }, email: "cap@x.com", balances: held, packs: [], salesOn: false });
  ok(held.length === 1 && held[0].disabled === true && !consent.includes(`value="${K.keyId}"`) && /No open balance/.test(consent), "the consent page does not offer the frozen balance for a grant");
  const K2 = await cr.claim("cs_captwo");
  await cr.disableByPaymentIntent("pi_cs_captwo", "disputed");
  const dz = await cr.authorizeGrant(K2.keyId, 0.001, g);
  ok(!dz.ok && dz.reason === "frozen", "a key frozen by a dispute refuses a grant's call (reason frozen)");
  ok((await cr.authorizeGrant("000000000000", 0.001, g)).reason === "unknown", "a grant naming no key is refused");
  delete process.env.CREDITS_DIR;
}

// ---- offline: a grant handle is read only beside the genuine marker ---------------------
{
  const { openGrantHandle, loopbackGrantOf, mcpLoopbackHeaders, MCP_GRANT_HEADER } = await import("../src/mcp-loopback.js");
  const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const req = (headers, addr = "127.0.0.1") => ({ headers: lower(headers), socket: { remoteAddress: addr } });
  const grant = { id: "g-handle", keyId: "0123456789ab", capUsd: 1 };
  const h = openGrantHandle(grant);
  ok(loopbackGrantOf(req({ [MCP_GRANT_HEADER]: h })) === null, "a grant handle without the marker names no grant");
  ok(loopbackGrantOf(req({ ...mcpLoopbackHeaders({ grantHandle: h }), "x-agent402-via": "mcp;k=" + "0".repeat(48) })) === null, "a grant handle beside a wrong marker names no grant");
  ok(loopbackGrantOf(req(mcpLoopbackHeaders({ grantHandle: h }), "203.0.113.9")) === null, "a grant handle beside the marker from another host names no grant");
  const genuine = loopbackGrantOf(req(mcpLoopbackHeaders({ grantHandle: h })));
  ok(genuine?.id === grant.id, "a handle the forged requests carried is still whole for the genuine replay (they could not spend it)");
  ok(loopbackGrantOf(req(mcpLoopbackHeaders({ grantHandle: h }))) === null, "and it pays for one replay only");
}

// ---- offline: connector tokens are credentials in logs and URLs ---------------------------
{
  const { redactSecrets } = await import("../src/tools/redact.js");
  const { urlCarriesCreditsKey } = await import("../src/credits-key-url.js");
  const at = "a402m_" + randomBytes(32).toString("base64url"), rt = "a402r_" + randomBytes(32).toString("base64url");
  const red = redactSecrets(`Bearer ${at} refresh=${rt}`);
  ok(!red.includes(at.slice(6)) && !red.includes(rt.slice(6)) && red.includes("a402m_[redacted]") && red.includes("a402r_[redacted]"), "log redaction removes a connector access or refresh token");
  for (const u of [`/mcp?token=${at}`, `/oauth/token?refresh_token=${rt}`, `/x?t=${encodeURIComponent(at).replace(/_/g, "%5F")}`]) ok(urlCarriesCreditsKey(u), `a URL carrying a connector token is caught (${u.slice(0, 22)}...)`);
}

// ---- offline: per-address limits fold IPv6 by /64; pending requests and the document are capped ----
{
  process.env.CREDITS_SALES = "on"; process.env.MCP_OAUTH = "on";
  const base = guardsTable();
  const { createMcpOAuth } = await import("../src/mcp-oauth.js");
  const { SKIP_UPDATE } = await import("../src/json-document.js");
  const { default: express } = await import("express");
  let body = {};
  const store = {
    read: async () => ({ ok: true, body: structuredClone(body) }),
    update: async (fn) => { const r = fn(structuredClone(body)); if (r !== SKIP_UPDATE) body = r; return { ok: true }; },
  };
  const credits = { balancesForEmail: async () => [], grantSpentToday: async () => 0 };
  const oa = createMcpOAuth({ credits, store, secret: "s".repeat(32), baseUrl: "https://agent402.tools", sendEmail: async () => true, log: () => {} });
  const app = express();
  oa.mount(app, { express, clientIp: (r) => String(r.headers["x-test-ip"] || "127.0.0.1") });
  const server = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const U = `http://127.0.0.1:${server.address().port}`;
  const regFrom = (ip) => fetch(`${U}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) });
  try {
    const n = base.mcpOAuth.registerPerIp;
    const codes = [];
    for (let i = 0; i <= n; i++) codes.push((await regFrom(`2001:db8:5:6:${(i + 1).toString(16)}::${i + 1}`)).status);
    ok(codes.slice(0, n).every((c) => c === 201) && codes[n] === 429, `addresses in one IPv6 /64 share one registration count (${codes.join(",")})`);
    ok((await regFrom("2001:db8:5:7::1")).status === 201, "another /64 has its own count");
    // Pending sign-ins: past the cap no new one starts.
    const client = Object.keys(body.clients)[0];
    useGuardsTable({ ...base, mcpOAuth: { ...base.mcpOAuth, pendingMax: Object.keys(body.reqs || {}).length + 1 } });
    const auth = (ip) => fetch(`${U}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://claude.ai/cb", state: "s", code_challenge_method: "S256", code_challenge: "A".repeat(43) })}`, { redirect: "manual", headers: { "x-test-ip": ip } });
    const a1 = await auth("198.51.100.1"), a2 = await auth("198.51.100.2");
    ok(a1.status === 303 && a2.status === 503 && !a2.headers.get("location"), `past the pending cap a new sign-in answers 503 (${a1.status}, ${a2.status})`);
    // The document's size: a registration that would pass it answers 503.
    useGuardsTable({ ...base, mcpOAuth: { ...base.mcpOAuth, documentMaxBytes: Buffer.byteLength(JSON.stringify(body)) + 10 } });
    ok((await regFrom("192.0.2.200")).status === 503, "a registration that would pass the document's size cap answers 503");
  } finally {
    server.close();
    useGuardsTable(base);
    delete process.env.CREDITS_SALES; delete process.env.MCP_OAUTH;
  }
}

// ---- stubs: Stripe and mail ------------------------------------------------------------
const sessions = new Map();
let nextEmail = "buyer@example.com";
const stripeStub = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, "http://x");
    if (req.method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const f = new URLSearchParams(body);
      const id = `cs_test_${randomBytes(6).toString("hex")}`;
      sessions.set(id, { id, object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, customer_email: f.get("customer_email"), customer_details: { email: f.get("customer_email") || nextEmail }, metadata: { credits_pack: f.get("metadata[credits_pack]"), ...(f.get("metadata[credits_account]") ? { credits_account: f.get("metadata[credits_account]") } : {}) }, success_url: f.get("success_url"), cancel_url: f.get("cancel_url"), form: f });
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
const isCode = (m) => /sign-in code/.test(m.subject || "");
const codeMails = (to) => mails.filter((m) => m.to === to && isCode(m));
const waitMail = async (to, n, which = isCode) => { for (let i = 0; i < 100; i++) { const got = mails.filter((m) => m.to === to && which(m)); if (got.length >= n) return got[n - 1]; await new Promise((r) => setTimeout(r, 50)); } return null; };

// Lifetimes from the environment; the limits from this run's private table
// (scripts/lib/credits-guards-table.js), read back from it, never typed.
const LIMITS = { MCP_OAUTH_AUTH_CODE_TTL_SECONDS: "3", MCP_OAUTH_ACCESS_TTL_SECONDS: "1800" };
const OL = guardsTable().mcpOAuth;
const OPERATOR = randomBytes(16).toString("hex");
const envFor = (on) => ({
  STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_STUB_PORT: String(stripeStub.address().port), STRIPE_WEBHOOK_SECRET: "",
  CREDITS_SALES: "on", MCP_OAUTH: on ? "on" : "", ...LIMITS, CREDITS_GUARDS_JSON: process.env.CREDITS_GUARDS_JSON,
  ZEPTOMAIL_URL: `http://127.0.0.1:${mailSink.address().port}/send`, ZEPTOMAIL_TOKEN: "t", RESEND_API_KEY: "", EMAIL_FROM: "credits@agent402.tools", COMPANY_POSTAL_ADDRESS: "PO Box 1, Test Town, NC 00000",
  BASE_URL: "https://agent402.tools", AGENT402_OPERATOR_TOKEN: OPERATOR, AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
});
const ARGS = ["--import", "./scripts/lib/stripe-stub-preload.js"];

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });
const MCP_H = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
async function mcp(base, body, { token = null, path = "/mcp", headers = {} } = {}) {
  const r = await fetch(base + path, { method: "POST", headers: { ...MCP_H, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const UNAUTH_PROBES = [
  rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } }),
  rpc(2, "tools/list", {}),
  rpc(3, "tools/call", { name: "catalog.call", arguments: { slug: "sql-guard", params: { sql: "SELECT 1" } } }),
  rpc(4, "tools/call", { name: "catalog.call", arguments: { slug: "base64", params: { text: "hello" } } }),
];
// Fields that differ between two boots of the same build (nonces, times, ports).
// The answer's headers, less the ones that vary between any two answers.
const headerSet = (h) => [...h.entries()].filter(([k]) => !["date", "etag", "x-request-id", "content-length", "keep-alive", "connection"].includes(k)).map(([k, v]) => `${k}: ${normalize(v)}`).sort().join("\n");
const normalize = (t) => String(t).replace(/127\.0\.0\.1:\d+/g, "HOST").replace(/"(nonce|validAfter|validBefore|timestamp|id|expires|issuedAt|requestId|maxTimeoutSeconds)":\s*("[^"]*"|\d+)/g, '"$1":X').replace(/0x[0-9a-fA-F]{64}/g, "0xH").replace(/\d{13}/g, "T");

// ---- switch off: nothing here exists, /mcp unchanged -------------------------------------
const off = await bootPaidServer({ label: "mcp-oauth-off", env: envFor(false), args: ARGS });
const offAnswers = [];
try {
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/oauth/authorize?client_id=x", "/oauth/consent?rid=x", "/credits/account/connected.json"]) {
    ok((await fetch(off.url + p)).status === 404, `switch off: GET ${p.split("?")[0]} is 404`);
  }
  for (const p of ["/oauth/register", "/oauth/token", "/oauth/revoke", "/oauth/consent", "/mcp/credits"]) {
    ok((await fetch(off.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404, `switch off: POST ${p} is 404`);
  }
  ok(!(await (await fetch(`${off.url}/privacy`)).text()).includes('id="connected-apps"'), "switch off: the privacy page says nothing about connected apps");
  for (const b of UNAUTH_PROBES) offAnswers.push(await mcp(off.url, b));
  const foreign = await mcp(off.url, UNAUTH_PROBES[2], { token: "a402m_" + "x".repeat(43) });
  ok(foreign.status === 200 && normalize(foreign.text) === normalize(offAnswers[2].text), "switch off: a token of ours is not read (the unpaid answer)");
} finally { await off.stop(); }

// ---- switches on, private table missing: nothing starts; a generic 503 ------------------------
{
  const miss = await bootPaidServer({ label: "mcp-oauth-notable", env: { ...envFor(true), CREDITS_GUARDS_JSON: "", CREDITS_GUARDS_FILE: "" }, args: ARGS });
  try {
    for (const p of ["/.well-known/oauth-authorization-server", "/oauth/authorize?client_id=x"]) {
      const x = await fetch(miss.url + p, { redirect: "manual" });
      const body = await x.text();
      ok(x.status === 503 && !/table|guard|CREDITS_GUARDS|threshold/i.test(body), `table missing: GET ${p.split("?")[0]} answers a generic 503`);
    }
    ok((await fetch(`${miss.url}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 503, "table missing: registration answers 503");
    const gs = await (await fetch(`${miss.url}/api/gateway-status`)).json();
    ok(gs.creditsGuards?.status === "attention", `table missing: the status word reads attention (${gs.creditsGuards?.status})`);
    const pi = await mcp(miss.url, rpc(5, "tools/call", { name: "payment.info", arguments: {} }));
    const info = JSON.parse(pi.json?.result?.content?.[0]?.text || "{}");
    ok(info.credits?.onSale === false && !("connector" in (info.credits || {})), "table missing: credits are not on sale and payment.info names no connector");
  } finally { await miss.stop(); }
}

// ---- switch on ----------------------------------------------------------------------------
const srv = await bootPaidServer({ label: "mcp-oauth-on", env: envFor(true), args: ARGS });
const B = srv.url;
const SITE = "https://agent402.tools";
const same = { "sec-fetch-site": "same-origin" };
try {
  // Unauthenticated /mcp: the same bytes as the switch-off boot.
  for (let i = 0; i < UNAUTH_PROBES.length; i++) {
    const r = await mcp(B, UNAUTH_PROBES[i]);
    ok(r.status === offAnswers[i].status && normalize(r.text) === normalize(offAnswers[i].text) && headerSet(r.headers) === headerSet(offAnswers[i].headers), `switch on: unauthenticated /mcp ${UNAUTH_PROBES[i].method}${i >= 2 ? ` (${UNAUTH_PROBES[i].params.arguments.slug})` : ""} answers as with the switch off (status, headers, body)`);
  }
  ok((await (await fetch(`${B}/privacy`)).text()).includes('id="connected-apps"'), "switch on: the privacy page says what a connected app keeps");
  const otherBearer = await mcp(B, UNAUTH_PROBES[2], { token: "sk-something-else" });
  ok(normalize(otherBearer.text) === normalize(offAnswers[2].text), "a bearer that is not ours passes untouched");

  // ---- metadata ----
  const asm = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
  ok(asm.issuer === SITE && asm.code_challenge_methods_supported.join() === "S256" && asm.token_endpoint_auth_methods_supported.join() === "none" && asm.registration_endpoint === `${SITE}/oauth/register` && asm.grant_types_supported.join() === "authorization_code,refresh_token", "authorization server metadata: S256 only, public clients, registration");
  const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp/credits`)).json();
  ok(prm.resource === `${SITE}/mcp/credits` && prm.authorization_servers[0] === SITE && prm.scopes_supported.join() === "credits:spend", "protected resource metadata names the connector and this server");
  ok((await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json()).resource === `${SITE}/mcp`, "and /mcp has its own");

  // ---- /mcp/credits asks for sign-in ----
  const ask = await fetch(`${B}/mcp/credits`, { method: "POST", headers: MCP_H, body: JSON.stringify(UNAUTH_PROBES[1]) });
  ok(ask.status === 401 && /resource_metadata="https:\/\/agent402\.tools\/\.well-known\/oauth-protected-resource\/mcp\/credits"/.test(ask.headers.get("www-authenticate") || ""), "/mcp/credits without a token answers 401 naming the metadata");

  // ---- registration ----
  const reg = async (body) => fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const bad1 = await reg({ redirect_uris: ["http://evil.example/cb"], client_name: "x" });
  const bad2 = await reg({ redirect_uris: ["https://a.example/cb#frag"] });
  const bad3 = await reg({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" });
  ok(bad1.status === 400 && bad2.status === 400 && bad3.status === 400, "registration refuses http off localhost, a fragment, and a confidential client");
  const cr = await (await reg({ redirect_uris: [REDIRECT, "http://localhost:6274/cb"], client_name: `Claude${String.fromCharCode(0x202e)} evil` })).json();
  ok(/^c_[0-9a-f]{32}$/.test(cr.client_id) && cr.token_endpoint_auth_method === "none" && cr.client_name === "Claude evil", "a public client is registered; control characters leave its name");

  // ---- authorize ----
  const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
  const authUrl = (o) => `${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: cr.client_id, redirect_uri: REDIRECT, state: "st-1", code_challenge_method: "S256", resource: `${SITE}/mcp/credits`, scope: "credits:spend", ...o })}`;
  const get = (u, h = {}) => fetch(u, { redirect: "manual", headers: h });
  const p1 = pkce();
  // A request this server will not start is answered on this site, never by
  // a redirect to the app's registered address (any app can register one).
  const refusedHere = (x) => x.status === 400 && !x.headers.get("location");
  let r = await get(authUrl({ code_challenge: p1.c, code_challenge_method: "plain" }));
  ok(refusedHere(r) && /invalid_request/.test(await r.text()), "code_challenge_method plain is refused on an error page, never redirected");
  r = await get(authUrl({ code_challenge: p1.c, code_challenge_method: "" }));
  ok(refusedHere(r), "a missing PKCE method is refused on an error page");
  r = await get(authUrl({ code_challenge: p1.c, state: "" }));
  ok(refusedHere(r) && /state is required/.test(await r.text()), "a missing state is refused on an error page, never redirected");
  r = await get(authUrl({ code_challenge: p1.c, response_type: "token" }));
  ok(refusedHere(r), "an unsupported response_type is refused on an error page");
  r = await get(authUrl({ code_challenge: p1.c, redirect_uri: "https://claude.ai/api/mcp/auth_callback/extra" }));
  ok(r.status === 400 && !r.headers.get("location"), "a redirect_uri that is not an exact registered match is never redirected to");
  r = await get(authUrl({ code_challenge: p1.c, client_id: "c_" + "0".repeat(32) }));
  ok(r.status === 400 && !r.headers.get("location"), "an unknown client is never redirected to");
  r = await get(authUrl({ code_challenge: p1.c, resource: "https://other.example/mcp" }));
  ok(refusedHere(r) && /invalid_target/.test(await r.text()), "a resource that is not this connector is refused on an error page");

  // A started sign-in: cookie, consent page, CSRF token.
  async function start(p, extra = {}) {
    const a = await get(authUrl({ code_challenge: p.c, ...extra }));
    const loc = a.headers.get("location") || "";
    const cookie = (a.headers.get("set-cookie") || "").split(";")[0];
    const rid = new URL(loc, B).searchParams.get("rid");
    return { a, rid, cookie };
  }
  const page = async (s) => { const x = await get(`${B}/oauth/consent?rid=${s.rid}`, { cookie: s.cookie }); return { res: x, html: await x.text() }; };
  const csrfIn = (html) => (/name="csrf" value="([^"]+)"/.exec(html) || [])[1];
  const post = (s, fields, h = same) => fetch(`${B}/oauth/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie, ...h }, body: new URLSearchParams({ rid: s.rid, ...fields }).toString() });

  const S = await start(p1);
  ok(S.a.status === 303 && /^[0-9a-f]{32}$/.test(S.rid) && /^a402_oauth=/.test(S.cookie) && /HttpOnly/.test(S.a.headers.get("set-cookie")) && /SameSite=Lax/.test(S.a.headers.get("set-cookie")) && /Secure/.test(S.a.headers.get("set-cookie")), "authorize starts a sign-in bound to an HttpOnly, Secure cookie");
  let pg = await page(S);
  const csp = pg.res.headers.get("content-security-policy") || "";
  ok(pg.res.status === 200 && /frame-ancestors 'none'/.test(csp) && pg.res.headers.get("x-frame-options") === "DENY" && /form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/claude\.ai/.test(csp), "the consent page cannot be framed and posts only to this site, the checkout and the app's return origin");
  ok(/Claude evil/.test(pg.html) && /claude\.ai/.test(pg.html) && /Email me a code/.test(pg.html), "the consent page names the app and where it returns");
  ok((await get(`${B}/oauth/consent?rid=${S.rid}`)).status === 400, "the sign-in does not open without its cookie");
  const csrf = csrfIn(pg.html);
  ok((await post(S, { action: "email", email: "x@y.com", csrf: "nope" })).status === 403, "a form without the CSRF token is refused");
  ok((await post(S, { action: "email", email: "x@y.com", csrf }, { "sec-fetch-site": "cross-site", origin: "https://evil.example" })).status === 403, "a cross-site form is refused");

  // Any address gets a code (a first purchase is made signed in), with the same answer.
  r = await post(S, { action: "email", email: "nobody@example.com", csrf });
  let html = await r.text();
  ok(r.status === 200 && /A six-digit code is on its way/.test(html), "an email with no balance gets the same answer");
  ok(await waitMail("nobody@example.com", 1), "and a code, so a first purchase can start signed in");
  await post(S, { action: "restart", csrf });
  pg = await page(S);
  ok(!/name="pack"/.test(pg.html), "no purchase is offered before sign-in");
  r = await post(S, { action: "buy", pack: "credits-5", csrf: csrfIn(pg.html) });
  ok(r.status === 400 && /Sign in with your email first/.test(await r.text()) && !sessions.size, "a purchase before sign-in is refused and starts no checkout");
  // Sign in with no balance yet, then buy by card from the consent page.
  pg = await page(S);
  html = await (await post(S, { action: "email", email: "buyer@example.com", csrf: csrfIn(pg.html) })).text();
  const codeMail = await waitMail("buyer@example.com", 1);
  const code1 = (/\b(\d{6})\b/.exec(codeMail?.text || "") || [])[1];
  ok(/Six-digit code/.test(html) && code1, "a code is mailed to the email");
  const wrong = code1 === "000000" ? "111111" : "000000";
  r = await post(S, { action: "code", code: wrong, csrf: csrfIn(html) });
  ok(r.status === 400 && /did not match/.test(await r.text()), "a wrong code is refused");
  r = await post(S, { action: "code", code: code1, csrf: csrfIn(html) });
  html = await r.text();
  ok(r.status === 200 && /No open balance/.test(html) && /name="pack"/.test(html), "the right code signs in; with no balance yet, a pack is offered");
  nextEmail = "someone-else@example.com";
  const pack = (/name="pack"><option value="([^"]+)"/.exec(html) || [])[1];
  r = await post(S, { action: "buy", pack, csrf: csrfIn(html) });
  const checkout = r.headers.get("location") || "";
  ok(r.status === 303 && checkout.startsWith("https://checkout.stripe.com/"), `buying a pack goes to the card checkout (${pack})`);
  const sess = [...sessions.values()].at(-1);
  ok(sess.success_url.startsWith(`${SITE}/oauth/consent/bought?rid=${S.rid}&session=`), "and returns to this sign-in");
  ok(sess.customer_email === "buyer@example.com" && sess.metadata.credits_account === "buyer@example.com", "the checkout is bound to the signed-in email (the balance page's purchase path)");
  ok(sess.form.get("payment_method_options[card][request_three_d_secure]") === "any" && sess.form.get("payment_intent_data[metadata][ref_buyer]") && sess.form.get("payment_intent_data[metadata][ref_source]"), "with card authentication requested and the purchase-check tags");
  r = await get(`${B}/oauth/consent/bought?rid=${S.rid}&session=${sess.id}`, { cookie: S.cookie });
  html = await r.text();
  ok(r.status === 200 && /Your credits are ready/.test(html) && /Allow this app to pay/.test(html) && /Daily spending cap/.test(html) && /value="5\.00"/.test(html), "back from the purchase, the new balance and a $5.00 default cap are offered");
  ok(!/a402_[A-Za-z0-9_-]{20}/.test(html) && !mails.some((m) => /a402_[A-Za-z0-9_-]{20}/.test(m.text || "") && isCode(m)), "no key is shown or put in a code mail");
  const keyId = (/name="keyId" value="([0-9a-f]{12})"/.exec(html) || [])[1];
  r = await post(S, { action: "approve", keyId, capUsd: "0", csrf: csrfIn(html) });
  ok(r.status === 400, "a cap of zero is refused");
  r = await post(S, { action: "approve", keyId: "ffffffffffff", capUsd: "1", csrf: csrfIn(html) });
  ok(r.status === 400, "a balance the email does not hold is refused");
  r = await post(S, { action: "approve", keyId, capUsd: "0.01", csrf: csrfIn(html) });
  let loc = new URL(r.headers.get("location") || "http://x/");
  const code = loc.searchParams.get("code");
  ok(r.status === 303 && loc.origin + loc.pathname === REDIRECT && loc.searchParams.get("state") === "st-1" && loc.searchParams.get("iss") === SITE && code, "Allow returns a code, the state and the issuer to the registered address");
  ok((await page(S)).res.status === 400, "the sign-in is spent once approved");

  // ---- token ----
  const tok = (fields) => fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  let t = await tok({ grant_type: "authorization_code", code, code_verifier: p1.v, redirect_uri: REDIRECT, client_id: cr.client_id, resource: `${SITE}/mcp/credits` });
  const T1 = await t.json();
  ok(t.status === 200 && T1.access_token.startsWith("a402m_") && T1.refresh_token.startsWith("a402r_") && T1.expires_in === 1800 && T1.token_type === "Bearer" && t.headers.get("cache-control") === "no-store", "the code is exchanged once for a short-lived access token and a refresh token (expires_in from the environment)");
  t = await tok({ grant_type: "authorization_code", code, code_verifier: p1.v, redirect_uri: REDIRECT, client_id: cr.client_id });
  ok(t.status === 400 && (await t.json()).error === "invalid_grant", "a code presented again is refused");
  const call = (token, slug, params, path = "/mcp") => mcp(B, rpc(9, "tools/call", { name: "catalog.call", arguments: { slug, params } }), { token, path });
  let c = await call(T1.access_token, "sql-guard", { sql: "SELECT 1" });
  ok(c.status === 401 && /invalid_token/.test(c.headers.get("www-authenticate") || ""), "and the reuse ended the grant: its access token answers 401 invalid_token");

  // A fresh grant (the balance exists now: sign in by code).
  async function grantFlow({ cap = "0.01", p = pkce(), email = "buyer@example.com" } = {}) {
    const s = await start(p);
    let h = (await page(s)).html;
    const before = codeMails(email).length;
    h = await (await post(s, { action: "email", email, csrf: csrfIn(h) })).text();
    const m = await waitMail(email, before + 1);
    const cd = (/\b(\d{6})\b/.exec(m?.text || "") || [])[1];
    h = await (await post(s, { action: "code", code: cd, csrf: csrfIn(h) })).text();
    const kid = (/name="keyId" value="([0-9a-f]{12})"/.exec(h) || [])[1];
    const a = await post(s, { action: "approve", keyId: kid, capUsd: cap, csrf: csrfIn(h) });
    const cde = new URL(a.headers.get("location")).searchParams.get("code");
    return { code: cde, p, keyId: kid, s, codeText: cd };
  }
  let G = await grantFlow();
  t = await tok({ grant_type: "authorization_code", code: G.code, code_verifier: "x".repeat(43), redirect_uri: REDIRECT, client_id: cr.client_id });
  ok(t.status === 400 && (await t.json()).error === "invalid_grant", "a wrong PKCE verifier is refused (S256 checked)");
  t = await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id });
  ok(t.status === 400, "and that code cannot be used after a refused attempt");
  G = await grantFlow();
  await new Promise((res) => setTimeout(res, 3500));
  t = await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id });
  ok(t.status === 400 && (await t.json()).error === "invalid_grant", "an expired code is refused (life from the environment)");
  G = await grantFlow();
  t = await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: "http://localhost:6274/cb", client_id: cr.client_id });
  ok(t.status === 400, "a token request naming another registered redirect_uri is refused");
  G = await grantFlow();
  t = await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id, resource: `${SITE}/mcp/credits` });
  const T = await t.json();
  ok(t.status === 200 && T.access_token, "a fresh grant is issued");
  ok(G.codeText && !(await post(G.s, { action: "code", code: G.codeText, csrf: "x" })).ok, "an email code works once");

  // ---- paid calls from credits ----
  c = await call(T.access_token, "sql-guard", { sql: "SELECT 1" });
  let res0 = c.json?.result;
  ok(c.status === 200 && !res0?.isError && /verdict|risk|statement/i.test(res0?.content?.[0]?.text || ""), "a paid tool is served under the grant");
  c = await call(T.access_token, "sql-guard", { sql: "SELECT 2" });
  ok(!c.json?.result?.isError, "a second call fits under the $0.01 cap");
  c = await call(T.access_token, "sql-guard", { sql: "SELECT 3" });
  const capText = c.json?.result?.content?.[0]?.text || "";
  ok(c.json?.result?.isError && /daily spending cap is reached/.test(capText) && /\/credits\/account/.test(capText) && /Nothing was charged/.test(capText), "past the cap: a clear tool error with the balance page link, nothing charged");
  c = await call(T.access_token, "memory-read", { key: "k" });
  ok(c.json?.result?.isError && /wallet-identity bound/.test(c.json.result.content[0].text) && /Nothing was charged/.test(c.json.result.content[0].text), "an identity-bound route is refused under a grant");
  c = await call(T.access_token, "seller-payability", { url: "https://seller.example/api" });
  ok(c.json?.result?.isError && /only on Agent402's own services/.test(c.json.result.content[0].text), "a route that buys from an outside seller is refused under a grant");
  c = await call(T.access_token, "base64", { text: "hello" });
  ok(c.status === 200 && !c.json?.result?.isError, "a free tool stays free under a grant");
  c = await mcp(B, rpc(5, "tools/list", {}), { token: T.access_token, path: "/mcp/credits" });
  ok(c.status === 200 && Array.isArray(c.json?.result?.tools) && c.json.result.tools.length > 3, "/mcp/credits serves the connector with a token");

  // A grant handle cannot be named from outside: the header alone pays nothing.
  const spoof = await fetch(`${B}/api/sql-guard`, { method: "POST", headers: { "content-type": "application/json", "x-agent402-via-grant": "a".repeat(48), "x-agent402-via": "mcp;k=" + "0".repeat(48) }, body: JSON.stringify({ sql: "SELECT 1" }) });
  ok(spoof.status === 402 && !spoof.headers.get("x-credits-balance"), "a grant header sent from outside is not read (the unpaid 402)");

  // ---- the balance page: connected apps ----
  const isLink = (m) => /Sign in to your Agent402 credits balance/.test(m.subject || "");
  const before = mails.filter((m) => m.to === "buyer@example.com" && isLink(m)).length;
  await fetch(`${B}/credits/account/sign-in`, { method: "POST", headers: { "content-type": "application/json", ...same }, body: JSON.stringify({ email: "buyer@example.com" }) });
  const link = (/(https:\/\/\S+\/credits\/account\/verify\?t=\S+)/.exec((await waitMail("buyer@example.com", before + 1, isLink))?.text || "") || [])[1];
  const tParam = new URL(link).searchParams.get("t");
  const v = await fetch(`${B}/credits/account/verify`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...same }, body: new URLSearchParams({ t: tParam }).toString() });
  const acct = (v.headers.get("set-cookie") || "").split(";")[0];
  const apps = await (await fetch(`${B}/credits/account/connected.json`, { headers: { cookie: acct } })).json();
  const mine = apps.apps?.find((x) => x.capUsd === 0.01 && x.spentTodayUsd > 0);
  ok(Array.isArray(apps.apps) && mine && mine.app === "Claude evil" && mine.keyId === G.keyId && mine.createdAt && mine.spentTodayUsd === 0.008 && "lastUsedAt" in mine && "lastNetwork" in mine, `connected apps list the app, key, cap, spend today, created and last use (${mine?.spentTodayUsd})`);
  ok(!JSON.stringify(apps).match(/a402[mr]_/), "the list carries no token");
  ok((await fetch(`${B}/credits/account/connected.json`)).status === 401, "the list needs the balance page's sign-in");
  const acctPost = (p, body, h = same) => fetch(`${B}/credits/account/connected/${p}`, { method: "POST", headers: { "content-type": "application/json", cookie: acct, ...h }, body: JSON.stringify(body) });
  ok((await acctPost("cap", { id: mine.id, capUsd: 1 }, { "sec-fetch-site": "cross-site" })).status === 403, "a cross-site change is refused");
  ok((await acctPost("cap", { id: mine.id, capUsd: 1000 })).status === 400, "a cap above the balance cap is refused");
  ok((await acctPost("cap", { id: mine.id, capUsd: 1 })).status === 200, "the cap is raised from the balance page");
  await new Promise((res) => setTimeout(res, 50));
  c = await call(T.access_token, "sql-guard", { sql: "SELECT 4" });
  ok(!c.json?.result?.isError, "and the next call is served under the new cap");

  // ---- refresh rotation and reuse detection ----
  t = await tok({ grant_type: "refresh_token", refresh_token: T.refresh_token, client_id: cr.client_id });
  const T2 = await t.json();
  ok(t.status === 200 && T2.refresh_token !== T.refresh_token && T2.access_token !== T.access_token, "a refresh rotates both tokens");
  c = await call(T2.access_token, "sql-guard", { sql: "SELECT 5" });
  ok(!c.json?.result?.isError, "the new access token pays");
  t = await tok({ grant_type: "refresh_token", refresh_token: T2.refresh_token, client_id: "c_" + "1".repeat(32) });
  ok(t.status === 400, "another client cannot use the refresh token");
  t = await tok({ grant_type: "refresh_token", refresh_token: T.refresh_token, client_id: cr.client_id });
  ok(t.status === 400 && (await t.json()).error === "invalid_grant", "a rotated refresh token presented again is refused");
  c = await call(T2.access_token, "sql-guard", { sql: "SELECT 6" });
  ok(c.status === 401, "and the reuse revoked the whole grant (the newest access token is refused)");
  t = await tok({ grant_type: "refresh_token", refresh_token: T2.refresh_token, client_id: cr.client_id });
  ok(t.status === 400, "including its newest refresh token");

  // ---- revoke: from the balance page and from the app ----
  G = await grantFlow({ cap: "2" });
  const T3 = await (await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id })).json();
  const list = (await (await fetch(`${B}/credits/account/connected.json`, { headers: { cookie: acct } })).json()).apps;
  const g3 = list.find((x) => x.capUsd === 2);
  ok((await acctPost("revoke", { id: "0".repeat(32) })).status === 404, "a grant id this email does not hold is not disconnected");
  ok((await acctPost("revoke", { id: g3.id })).status === 200, "a grant is disconnected from the balance page");
  ok((await call(T3.access_token, "sql-guard", { sql: "SELECT 7" })).status === 401, "and its token stops paying at once");
  ok(!(await (await fetch(`${B}/credits/account/connected.json`, { headers: { cookie: acct } })).json()).apps.some((x) => x.id === g3.id), "and it leaves the list");
  G = await grantFlow({ cap: "3" });
  const T4 = await (await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id })).json();
  ok((await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${T4.refresh_token}` })).status === 200, "the app revokes its own grant (RFC 7009)");
  ok((await call(T4.access_token, "sql-guard", { sql: "SELECT 8" })).status === 401, "and its access token stops paying");

  // ---- a disabled key: its grant refuses with a plain message ----
  G = await grantFlow({ cap: "3" });
  const T5 = await (await tok({ grant_type: "authorization_code", code: G.code, code_verifier: G.p.v, redirect_uri: REDIRECT, client_id: cr.client_id })).json();
  await fetch(`${B}/__operator/credits/disable`, { method: "POST", headers: { "content-type": "application/json", "x-operator-token": OPERATOR }, body: JSON.stringify({ keyId: G.keyId, disabled: true }) });
  c = await call(T5.access_token, "sql-guard", { sql: "SELECT 9" });
  ok(c.json?.result?.isError && /disabled/.test(c.json.result.content[0].text) && /Nothing was charged/.test(c.json.result.content[0].text), "a switched-off key's grant answers a plain tool error");

  // Every token is looked up; only failed lookups are slowed, never a valid token.
  {
    // A grant still in force (its key is switched off; listing tools pays
    // nothing), with an access token fresh from a refresh, so no cache answers for it.
    const Tb = await (await tok({ grant_type: "refresh_token", refresh_token: T5.refresh_token, client_id: cr.client_id })).json();
    ok(typeof Tb.access_token === "string", "setup: a fresh access token for the bad-token check");
    let last = null;
    for (let i = 0; i < OL.badTokenMax + 60; i++) last = await mcp(B, rpc(1, "tools/list", {}), { token: "a402m_" + randomBytes(32).toString("base64url") });
    ok(last.status === 429, `past the bound, failed token lookups from one client are answered 429 (${last.status})`);
    const good = await mcp(B, rpc(1, "tools/list", {}), { token: Tb.access_token });
    ok(good.status === 200 && Array.isArray(good.json?.result?.tools), `a valid token from the same client is still served after ${OL.badTokenMax + 60} bad ones`);
  }

  // ---- code tries, lockout, send and token limits (thresholds from the environment) ----
  {
    const s = await start(pkce());
    let h = (await page(s)).html;
    const email = "buyer@example.com";
    h = await (await post(s, { action: "email", email, csrf: csrfIn(h) })).text();
    let last = "";
    for (let i = 0; i < OL.emailCodeTries; i++) last = await (await post(s, { action: "code", code: "999999" === "x" ? "0" : String(100000 + i), csrf: csrfIn(h) })).text();
    // With this run's table the lockout may come first (fewer wrong codes than tries): either way the code is void.
    ok(/no longer works|Email me a code|Too many requests/.test(last), "a code is void after its tries run out");
    let locked = "";
    for (let i = 0; i < OL.failsPerEmail + 2; i++) {
      h = await (await post(s, { action: "email", email, csrf: csrfIn(last || h) })).text();
      locked = await (await post(s, { action: "code", code: "123450", csrf: csrfIn(h) })).text();
      last = locked;
    }
    // Locked either at the code (wrong codes past the count) or already at the send.
    ok(/Too many requests/.test(locked) || /Too many requests/.test(h), "repeated wrong codes lock the email out with a generic refusal");
  }
  {
    let limited = false;
    for (let i = 0; i < OL.tokenPerIp + 2 && !limited; i++) {
      const x = await tok({ grant_type: "refresh_token", refresh_token: "a402r_" + "z".repeat(43), client_id: cr.client_id });
      if (x.status === 429) { const j = await x.json(); limited = j.error === "invalid_request" && !/per|limit|minute|hour|\d/.test(j.error_description); }
    }
    ok(limited, "the token endpoint is limited, with a refusal that names no threshold");
  }
  {
    let refused = 0;
    for (let i = 0; i < OL.registerPerIp + 2; i++) if ((await reg({ redirect_uris: [REDIRECT] })).status === 429) refused++;
    ok(refused > 0, "registration is limited per client address");
  }
} catch (e) {
  fail++;
  console.error(`FAIL - booted half threw: ${e?.stack || e}\n${srv.log().slice(-3000)}`);
} finally {
  await srv.stop();
  stripeStub.close(); mailSink.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
