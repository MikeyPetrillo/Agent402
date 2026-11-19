// Wallet sign-in (EIP-4361) for the identity-bound routes (src/wallet-sign-in.js):
// a nonce works once and expires; a message for another domain, another URI,
// an unlisted chain, a past Expiration Time, a future Not Before or Issued At,
// an extra line, or a signature by another key is refused; the session token
// expires, cannot be altered, is bound to this host and ends at sign-out; a
// signed payer always wins and a session naming another wallet is refused;
// proof-of-work and trial calls take no session; grants stay payer-only.
// Off (no SIWE_SESSION_SECRET): no route mounts and the routes answer exactly
// as before. Two FREE_MODE boots drive the HTTP path.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { bootServer } from "./lib/boot-server.js";
import * as ws from "../src/wallet-sign-in.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const refusedWith = async (p, code) => { try { await p; return false; } catch (e) { return e.code === code ? true : `${e.code}: ${e.message}`; } };

const BASE = "https://agent402.example.test";
const SECRET = randomBytes(32).toString("hex");
const env = { SIWE_SESSION_SECRET: SECRET };
const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
const now = () => clock;

const msgFor = (n, over = {}) => createSiweMessage({
  domain: n.domain, address: alice.address, statement: n.statement, uri: n.uri, version: "1", chainId: 8453,
  nonce: n.nonce, issuedAt: new Date(clock), ...over,
});
async function signIn(svc, over = {}, signer = alice) {
  const n = svc.issueNonce();
  const message = msgFor(n, over);
  return svc.verify({ message, signature: await signer.signMessage({ message }) });
}

// --- off ------------------------------------------------------------------------
{
  ok(ws.walletSignInEnabled({}) === false && ws.walletSignInEnabled({ SIWE_SESSION_SECRET: "short" }) === false, "off without a secret of at least 32 characters");
  ok(ws.createWalletSignIn({ env: {}, baseUrl: BASE }) === null && ws.configureWalletSignIn({ env: {}, baseUrl: BASE }) === null, "off: no service");
  const req = { headers: { "x-wallet-session": "a402ws1.x.y" } };
  const r = ws.resolveRouteIdentity(req, "my-usage", "0x" + "1".repeat(40));
  const r0 = ws.resolveRouteIdentity(req, "my-usage", null);
  ok(r.wallet === "0x" + "1".repeat(40) && !r.error && r0.wallet === null && !r0.error, "off: the header is not read; the payer (or nothing) as before");
  ok(ws.mountWalletSignIn({ get() { throw new Error("mounted"); } }, {}) === false, "off: nothing mounts");
}

// --- sign-in rules ----------------------------------------------------------------
const svc = ws.createWalletSignIn({ env, baseUrl: BASE, now });
{
  const n = svc.issueNonce();
  ok(/^[0-9a-f]{32}$/.test(n.nonce) && n.domain === "agent402.example.test" && n.uri === BASE && n.chainIds.includes(8453), "a nonce carries the domain, URI and chains to sign");
  const message = msgFor(n);
  const signature = await alice.signMessage({ message });
  const out = await svc.verify({ message, signature });
  ok(out.address === alice.address.toLowerCase() && out.chainId === 8453 && typeof out.token === "string", "a signed message for this domain yields a session for the signer");
  ok(Date.parse(out.expiresAt) - clock === 900_000, "the session lasts 15 minutes by default");
  ok(await refusedWith(svc.verify({ message, signature }), "nonce_unknown") === true, "replay: the same signed message is refused the second time");

  ok(await refusedWith(signIn(svc, { domain: "evil.example.test" }), "wrong_domain") === true, "cross-domain: a message for another domain is refused");
  ok(await refusedWith(signIn(svc, { uri: "https://evil.example.test/login" }), "wrong_uri") === true, "a URI on another origin is refused");
  ok(await refusedWith(signIn(svc, { chainId: 99999 }), "wrong_chain") === true, "wrong chain: an unlisted chain id is refused");
  ok(await refusedWith(signIn(svc, { expirationTime: new Date(clock - 1000) }), "expired") === true, "an expired message is refused");
  ok(await refusedWith(signIn(svc, { notBefore: new Date(clock + 3_600_000) }), "not_yet_valid") === true, "a message not valid yet is refused");
  ok(await refusedWith(signIn(svc, { issuedAt: new Date(clock + 3_600_000) }), "bad_time") === true, "an Issued At in the future is refused");
  ok(await refusedWith(signIn(svc, {}, mallory), "bad_signature") === true, "a signature by another key is refused");
  {
    const n2 = svc.issueNonce();
    const m2 = msgFor(n2).replace("\nURI: ", "\nURI: https://evil.example.test\nURI: ");
    ok(await refusedWith(svc.verify({ message: m2, signature: await alice.signMessage({ message: m2 }) }), "bad_message") === true, "an extra line (a second URI) is refused by the layout check");
  }
  {
    const m3 = msgFor({ ...svc.issueNonce(), nonce: "deadbeefdeadbeefdeadbeefdeadbeef" });
    ok(await refusedWith(svc.verify({ message: m3, signature: await alice.signMessage({ message: m3 }) }), "nonce_unknown") === true, "a nonce this server never issued is refused");
  }
  {
    const n4 = svc.issueNonce();
    clock += 301_000;
    const m4 = msgFor(n4, { issuedAt: new Date(clock) });
    ok(await refusedWith(svc.verify({ message: m4, signature: await alice.signMessage({ message: m4 }) }), "nonce_unknown") === true, "an expired nonce is refused");
  }
  ok(await refusedWith(svc.verify({ message: "x".repeat(3000), signature: "0x" + "1".repeat(130) }), "bad_message") === true && await refusedWith(svc.verify({ message: "hi", signature: "0x12" }), "bad_signature") === true, "oversized messages and malformed signatures are refused before any work");
  const short = await signIn(svc, { expirationTime: new Date(clock + 60_000) });
  ok(Date.parse(short.expiresAt) <= clock + 60_000, "a session never outlives the message's own Expiration Time");
}

// --- the session token -----------------------------------------------------------
{
  const s = await signIn(svc);
  ok(svc.sessionOf(s.token).session?.address === alice.address.toLowerCase(), "the token reads back as the wallet");
  const [a, b, c] = s.token.split(".");
  const forged = JSON.parse(Buffer.from(b, "base64url").toString());
  forged.sub = mallory.address.toLowerCase();
  ok(svc.sessionOf(`${a}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${c}`).error === "bad_signature", "an altered token is refused");
  ok(svc.sessionOf(s.token.slice(0, -2) + "AA").error === "bad_signature", "a token with another MAC is refused");
  const other = ws.createWalletSignIn({ env, baseUrl: "https://other.example.test", now });
  ok(other.sessionOf(s.token).error === "wrong_audience", "a token is bound to the host that issued it");
  const otherSecret = ws.createWalletSignIn({ env: { SIWE_SESSION_SECRET: randomBytes(32).toString("hex") }, baseUrl: BASE, now });
  ok(otherSecret.sessionOf(s.token).error === "bad_signature", "a token from another secret is refused");
  clock += 901_000;
  ok(svc.sessionOf(s.token).error === "expired", "expired token: refused after its life");
  const s2 = await signIn(svc);
  ok(svc.revoke(s2.token) === true && svc.sessionOf(s2.token).error === "signed_out", "sign-out ends the session");
  ok(svc.sessionOf("x".repeat(5000)).error === "malformed" && svc.sessionOf("a.b").error === "malformed", "malformed tokens are refused without work");
}

// --- route identity ---------------------------------------------------------------
{
  ws.configureWalletSignIn({ env, baseUrl: BASE, now });
  const s = await signIn(ws.walletSignInService());
  const me = alice.address.toLowerCase(), them = mallory.address.toLowerCase();
  const req = (h = {}, resHeaders = {}) => ({ headers: { "x-wallet-session": s.token, ...h }, res: { getHeader: (n) => resHeaders[n] } });
  let r = ws.resolveRouteIdentity(req(), "my-usage", null);
  ok(r.wallet === me && r.via === "session", "no signed payer: the session names the wallet");
  r = ws.resolveRouteIdentity(req(), "my-usage", me);
  ok(r.wallet === me && r.via === "payment", "the same wallet paying: the payer is the identity");
  r = ws.resolveRouteIdentity(req(), "receipts", them);
  ok(r.error?.status === 400 && !r.wallet, "a session naming another wallet than the signed payer is refused");
  r = ws.resolveRouteIdentity(req(), "attest", them);
  ok(r.wallet === them && !r.error, "a route outside the session scopes keeps the payer and ignores the session");
  r = ws.resolveRouteIdentity(req(), "", null);
  ok(r.wallet === null && !r.error, "an unscoped memory route (grants) takes no session");
  r = ws.resolveRouteIdentity(req({ "x-pow-accepted": "1" }), "memory-read", null);
  ok(r.error?.status === 402, "a proof-of-work call takes no session");
  r = ws.resolveRouteIdentity(req({}, { "X-Trial-Accepted": "1" }), "memory-read", null);
  ok(r.error?.status === 402, "a trial call takes no session");
  r = ws.resolveRouteIdentity({ headers: { "x-wallet-session": "a402ws1.bad.bad" } }, "memory-read", null);
  ok(r.error?.status === 401, "an invalid token is a 401 (a 4xx is never charged)");
  ok(!ws.MEMORY_SESSION_SLUGS.includes("memory-grant") && !ws.MEMORY_SESSION_SLUGS.includes("memory-revoke"), "memory grants and revocations stay payer-only");
  // A session is read-only: its scopes are reads, and every memory route that
  // changes state refuses a session with no signed payer.
  ok(JSON.stringify(ws.SESSION_SCOPES) === JSON.stringify(["my-usage", "receipts", "memory-read"]), "session scopes are reads only");
  ok(JSON.stringify(ws.MEMORY_SESSION_SLUGS) === JSON.stringify(["memory-read", "memory-grants"]), "memory session slugs are the read and the grants listing only");
  ok(JSON.stringify(s.scopes) === JSON.stringify(["my-usage", "receipts", "memory-read"]), "the signed token carries the read-only scopes");
  ok(/read-only/i.test(ws.walletSignInService().issueNonce().statement) && !/write/i.test(ws.walletSignInService().issueNonce().statement.replace(/writes still need a signed payment/i, "")), "the signed statement says read-only");
  for (const slug of ["memory-write", "memory-incr", "memory-cas", "memory-log", "memory-remember", "memory-forget", "memory-grant", "memory-revoke"]) {
    const w = ws.resolveRouteIdentity(req(), ws.memoryScopeOf(slug), null);
    ok(w.error?.status === 403 && !w.wallet, `a session cannot write: ${slug} is refused 403 without a signed payer`);
    const p = ws.resolveRouteIdentity(req(), ws.memoryScopeOf(slug), them);
    ok(p.wallet === them && p.via === "payment", `${slug}: the signed payer still writes, the session unread`);
  }
  for (const slug of ["memory-read", "memory-grants"]) {
    const rd = ws.resolveRouteIdentity(req(), ws.memoryScopeOf(slug), null);
    ok(rd.wallet === me && rd.via === "session", `${slug}: a session reads the wallet's own namespace`);
  }
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const kit = readFileSync(new URL("../src/tools/usage-kit.js", import.meta.url), "utf8");
  ok(/resolveRouteIdentity\(req, memoryScopeOf\(slug\), identityPayerOf\(req\)\)/.test(src), "memory reads the payer first through identityPayerOf");
  ok((kit.match(/resolveRouteIdentity\(req, "(my-usage|receipts)", identityPayerOf\(req\)\)/g) || []).length === 2, "my-usage and receipts read the payer first through identityPayerOf");
  ok(!/resolveRouteIdentity/.test(readFileSync(new URL("../src/payer.js", import.meta.url), "utf8")), "payer.js (attribution) is unchanged");
}

// --- HTTP: on and off boots -------------------------------------------------------
const bootEnv = { FREE_MODE: "true", BASE_URL: BASE, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", POSTHOG_API_KEY: "" };
{
  const srv = await bootServer({ env: { ...bootEnv, SIWE_SESSION_SECRET: SECRET }, stores: "wallet-sign-in-on" });
  try {
    const nr = await fetch(`${srv.url}/api/wallet-session/nonce`);
    const n = await nr.json();
    ok(nr.status === 200 && nr.headers.get("cache-control") === "no-store" && n.domain === "agent402.example.test", "on: the nonce route answers, never cached");
    const message = createSiweMessage({ domain: n.domain, address: alice.address, statement: n.statement, uri: n.uri, version: "1", chainId: 8453, nonce: n.nonce, issuedAt: new Date() });
    const signature = await alice.signMessage({ message });
    const vr = await fetch(`${srv.url}/api/wallet-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
    const v = await vr.json();
    ok(vr.status === 200 && v.address === alice.address.toLowerCase(), "on: a signed message yields a session over HTTP");
    const again = await fetch(`${srv.url}/api/wallet-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
    ok(again.status === 401 && (await again.json()).code === "nonce_unknown", "on: the replayed message is refused over HTTP");
    const u = await fetch(`${srv.url}/api/my-usage`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": v.token }, body: "{}" });
    const ub = await u.json();
    ok(u.status === 200 && ub.wallet === alice.address.toLowerCase(), `on: my-usage answers for the session's wallet (${u.status})`);
    const w = await fetch(`${srv.url}/api/memory`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": v.token }, body: JSON.stringify({ key: "k1", value: "v1" }) });
    const rd = await fetch(`${srv.url}/api/memory?key=k1`, { headers: { "x-wallet-session": v.token } });
    const rb = await rd.json().catch(() => ({}));
    ok(w.status === 403 && /read-only/.test((await w.json()).error || ""), `on: a session cannot write memory (${w.status})`);
    ok(rd.status === 404 && !JSON.stringify(rb).includes("v1"), `on: a session reads the session wallet's namespace, where the refused write left nothing (${rd.status})`);
    const bad = await fetch(`${srv.url}/api/my-usage`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": v.token + "x" }, body: "{}" });
    ok(bad.status === 401, "on: an altered token is a 401");
    const out = await fetch(`${srv.url}/api/wallet-session`, { method: "DELETE", headers: { "x-wallet-session": v.token } });
    const after = await fetch(`${srv.url}/api/my-usage`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": v.token }, body: "{}" });
    ok((await out.json()).signedOut === true && after.status === 401, "on: after sign-out the token is refused");
  } finally { await srv.stop(); }
}
{
  const srv = await bootServer({ env: { ...bootEnv, SIWE_SESSION_SECRET: "" }, stores: "wallet-sign-in-off" });
  try {
    const nr = await fetch(`${srv.url}/api/wallet-session/nonce`);
    ok(nr.status === 404, `off: the nonce route is not mounted (${nr.status})`);
    const u = await fetch(`${srv.url}/api/my-usage`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": "a402ws1.x.y" }, body: "{}" });
    const ub = await u.json();
    ok(u.status === 400 && /FREE_MODE/.test(ub.error || ""), "off: my-usage answers exactly as before, the header unread");
  } finally { await srv.stop(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
