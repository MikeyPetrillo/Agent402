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
  const out2 = await svc.revoke(s2.token);
  ok(out2?.signedOut === true && out2.shared === null && svc.sessionOf(s2.token).error === "signed_out", "sign-out ends the session (no shared store: this process's record)");
  ok((await svc.revoke(s2.token))?.signedOut === true && (await svc.revoke("a402ws1.x.y"))?.signedOut === false, "signing out twice is the same answer; a token that is not a session signs nothing out");
  ok(svc.sessionOf("x".repeat(5000)).error === "malformed" && svc.sessionOf("a.b").error === "malformed", "malformed tokens are refused without work");
}

// --- sign-out across instances (one shared store) ---------------------------------
// Two services with one secret are two containers: a token minted on one is
// honored by both, so a sign-out on one must end it on the other. The store
// is the shared flag store's own interface (src/shared-limits.js).
{
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const mem = createMemoryLimits();
  const calls = { put: 0, get: 0 };
  let putFails = false, getFails = false, getThrows = false;
  const revocations = {
    put: async (jti, untilMs) => { calls.put++; if (putFails) return { ok: false, error: "store down" }; return mem.flagSet("wsess-out", jti, untilMs, { now: now() }); },
    get: async (jti) => { calls.get++; if (getThrows) throw new Error("store down"); if (getFails) return { ok: false, error: "store down" }; return mem.flagGet("wsess-out", jti, { now: now() }); },
  };
  const a = ws.createWalletSignIn({ env, baseUrl: BASE, now, revocations });
  const b = ws.createWalletSignIn({ env, baseUrl: BASE, now, revocations });
  const s = await signIn(a);
  ok(b.sessionOf(s.token).session?.address === alice.address.toLowerCase() && await b.syncRevocation?.(s.token) === "clean" && b.sessionOf(s.token).session, "CONTROL: a token minted on one instance is honored by the other, before and after it reads the store");
  const out = await a.revoke(s.token);
  ok(out?.signedOut === true && out.shared === true && calls.put === 1, `sign-out writes the shared record and waits for it (${JSON.stringify(out)})`);
  ok(a.sessionOf(s.token).error === "signed_out", "the instance that took the sign-out refuses the token");
  ok(await b.syncRevocation?.(s.token) === "revoked" && b.sessionOf(s.token).error === "signed_out", "the OTHER instance refuses it once it has read the shared record");
  const gets = calls.get;
  ok(await b.syncRevocation?.(s.token) === "revoked" && calls.get === gets, "a token this process knows to be signed out is not read again");
  // The record lives exactly as long as the token could.
  const exp = a.sessionOf((await signIn(a)).token).session.exp * 1000;
  const s3 = await signIn(a);
  await a.revoke(s3.token);
  const jti3 = JSON.parse(Buffer.from(s3.token.split(".")[1], "base64url").toString("utf8")).jti;
  const kept = await mem.flagGet("wsess-out", jti3, { now: now() });
  ok(kept.until > now() && kept.until <= now() + 3600_000 && Math.abs(kept.until - exp) <= 1000, "the shared record expires with the token (at most an hour)");
  ok((await mem.flagGet("wsess-out", jti3, { now: kept.until + 1 })).until === 0, "and is gone after that");
  // Only a token this server signed, still alive, reaches the store.
  const before = calls.get;
  await b.syncRevocation?.("a402ws1.x.y"); await b.syncRevocation?.(s.token.slice(0, -2) + "AA"); await b.syncRevocation?.("x".repeat(5000)); await b.syncRevocation?.(null);
  ok(calls.get === before, "an unsigned, altered, oversized or missing token never reaches the store");
  // A store that does not answer a READ: this process's own record decides
  // (the documented rule), the session is not refused, and the miss is reported.
  const s4 = await signIn(a);
  const misses = [];
  const c = ws.createWalletSignIn({ env, baseUrl: BASE, now, revocations, onStoreMiss: (op, r) => misses.push([op, r?.error]) });
  getFails = true;
  ok(await c.syncRevocation?.(s4.token) === "unread" && c.sessionOf(s4.token).session && misses.length === 1 && misses[0][0] === "read", `a store that does not answer a read leaves a valid session valid, and says so (${JSON.stringify(misses)})`);
  getFails = false; getThrows = true;
  ok(await c.syncRevocation?.(s4.token) === "unread" && c.sessionOf(s4.token).session, "a store read that throws is the same");
  getThrows = false;
  // A store that does not take the WRITE: this process refuses the token at
  // once, the caller is told the sign-out is not everywhere, and a repeat
  // writes it again.
  putFails = true;
  const half = await c.revoke(s4.token);
  ok(half?.signedOut === true && half.shared === false && c.sessionOf(s4.token).error === "signed_out", `a sign-out the store did not take still ends the session here, and reports shared: false (${JSON.stringify(half)})`);
  ok(await b.syncRevocation?.(s4.token) === "clean" && b.sessionOf(s4.token).session, "CONTROL: the other instance has not learned of it");
  putFails = false;
  const again = await c.revoke(s4.token);
  ok(again?.signedOut === true && again.shared === true && await b.syncRevocation?.(s4.token) === "revoked" && b.sessionOf(s4.token).error === "signed_out", "the repeated sign-out reaches the store, and the other instance refuses the token");
  // The server wires the shared flag store, and reads it before any route.
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/revocations: sharedLimitsEnabled\(\) \? \{/.test(src) && /sharedLimits\.flagSet\("wsess-out", jti, untilMs\)/.test(src) && /sharedLimits\.flagGet\("wsess-out", jti\)/.test(src), "server.js hands the service the shared flag store when one is configured");
  const mod = readFileSync(new URL("../src/wallet-sign-in.js", import.meta.url), "utf8");
  ok(/app\.use\(\(req, res, next\) => \{[\s\S]{0,400}svc\.syncRevocation\(/.test(mod), "the mounted middleware reads the shared record before any route resolves the session");
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

// --- outstanding nonces: per caller, per network, global ----------------------------
// A caller spread over many addresses and networks cannot fill the map and
// get every other sign-in refused: each bound expires the oldest nonce in it
// early, and the full map gives up the oldest nonce of the busiest network.
{
  const flood = ws.createWalletSignIn({ env, baseUrl: BASE, now });
  const verifyWith = async (n) => { const message = msgFor(n); return flood.verify({ message, signature: await alice.signMessage({ message }) }); };
  const signWith = (n) => verifyWith(n).catch((e) => ({ refused: e.code || String(e) }));
  ok(ws.nonceNetworkOf("203.0.113.9") === "203.0.113.0/24" && ws.nonceNetworkOf("::ffff:203.0.113.9") === "203.0.113.0/24" && ws.nonceNetworkOf("2001:db8:1:2::/64") === "2001:db8:1::/48" && ws.nonceNetworkOf("?") === "?", "networks: an IPv4 /24 (mapped or not), an IPv6 /48 from the folded /64, any other key as given");

  // One address: its own oldest nonces go, nobody else's.
  const other = flood.issueNonce({ caller: "198.51.100.7" });
  const own = Array.from({ length: ws.NONCE_PER_CALLER_MAX + 4 }, () => flood.issueNonce({ caller: "198.51.100.8" }));
  ok(await refusedWith(verifyWith(own[0]), "nonce_unknown") === true, `one address past ${ws.NONCE_PER_CALLER_MAX} outstanding nonces loses its own oldest`);
  ok((await signWith(own.at(-1))).address === alice.address.toLowerCase(), "its newest nonce still signs in");
  ok((await signWith(other)).address === alice.address.toLowerCase(), "a neighbor's nonce on the same network is untouched");

  // One network, many addresses: held to the network's bound.
  for (let h = 0; h < 40; h++) for (let i = 0; i < 4; i++) flood.issueNonce({ caller: `192.0.2.${h + 1}` });
  ok(flood._nonceCount() <= ws.NONCE_PER_NETWORK_MAX + ws.NONCE_PER_CALLER_MAX, `many addresses in one /24 hold at most ${ws.NONCE_PER_NETWORK_MAX} nonces there (map holds ${flood._nonceCount()})`);
  // IPv6: addresses inside one /64 are one caller.
  for (let i = 0; i < ws.NONCE_PER_CALLER_MAX * 3; i++) flood.issueNonce({ caller: `2001:db8:aa:bb:${(i + 1).toString(16)}::1` });
  ok(flood._nonceCount() <= ws.NONCE_PER_NETWORK_MAX + 2 * ws.NONCE_PER_CALLER_MAX, `rotating addresses inside one IPv6 /64 counts as one caller (map holds ${flood._nonceCount()})`);

  // Many networks, many addresses: past the global ceiling.
  const nets = Math.ceil((ws.NONCE_MAX * 1.3) / ws.NONCE_PER_NETWORK_MAX);
  let refused = 0;
  const fill = (round) => {
    for (let a = 0; a < nets; a++) for (let h = 0; h < 8; h++) for (let i = 0; i < 8; i++) {
      const net = a + round * nets;   // each round from networks of its own
      try { flood.issueNonce({ caller: `10.${(net >> 8) & 255}.${net & 255}.${h + 1}` }); } catch { refused++; }
    }
  };
  fill(0);
  ok(flood._nonceCount() <= ws.NONCE_MAX && refused === 0, `a flood from ${nets} networks keeps the map at its ceiling and refuses nobody (map ${flood._nonceCount()}, refused ${refused})`);
  let fresh = null, freshErr = null;
  try { fresh = flood.issueNonce({ caller: "203.0.113.50" }); } catch (e) { freshErr = e; }
  ok(fresh && !freshErr, `a fresh address gets a nonce while the map is full (${freshErr ? `${freshErr.statusCode} ${freshErr.code}` : "issued"})`);
  fill(1);
  const freshIn = await signWith(fresh);
  ok(freshIn.address === alice.address.toLowerCase(), `and signs in with it after a second flood from new networks: the busiest networks gave up their nonces first (${freshIn.refused || "signed in"})`);
  ok(flood._nonceCount() <= ws.NONCE_MAX && refused === 0, `the map never passes its ceiling (${flood._nonceCount()})`);
  // Expiry still clears every index.
  clock += 6 * 60_000;
  flood.issueNonce({ caller: "203.0.113.51" });
  for (let i = 0; i < ws.NONCE_PER_CALLER_MAX; i++) flood.issueNonce({ caller: "203.0.113.51" });
  const idx = flood._nonceIndexSizes();
  ok(idx.callers === 1 && idx.networks === 1 && flood._nonceCount() === ws.NONCE_PER_CALLER_MAX, `expired nonces leave every index: one caller's ${ws.NONCE_PER_CALLER_MAX} remain (${JSON.stringify(idx)}, map ${flood._nonceCount()})`);
  clock -= 6 * 60_000;
}

// --- HTTP: on and off boots -------------------------------------------------------
const bootEnv = { FREE_MODE: "true", BASE_URL: BASE, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", POSTHOG_API_KEY: "" };
{
  const srv = await bootServer({ env: { ...bootEnv, SIWE_SESSION_SECRET: SECRET, TRUST_PROXY_HOPS: "1" }, stores: "wallet-sign-in-on" });
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
    // The route names its caller: one address past its bound loses its own
    // oldest nonce over HTTP, and its newest still signs in.
    const xff = { "x-forwarded-for": "198.51.100.9" };
    const many = [];
    for (let i = 0; i <= ws.NONCE_PER_CALLER_MAX; i++) many.push(await (await fetch(`${srv.url}/api/wallet-session/nonce`, { headers: xff })).json());
    const post = async (nn) => { const msg = createSiweMessage({ domain: nn.domain, address: alice.address, statement: nn.statement, uri: nn.uri, version: "1", chainId: 8453, nonce: nn.nonce, issuedAt: new Date() }); return fetch(`${srv.url}/api/wallet-session`, { method: "POST", headers: { "content-type": "application/json", ...xff }, body: JSON.stringify({ message: msg, signature: await alice.signMessage({ message: msg }) }) }); };
    const oldest = await post(many[0]);
    const newest = await post(many.at(-1));
    ok(oldest.status === 401 && (await oldest.json()).code === "nonce_unknown" && newest.status === 200, `on: the nonce route bounds each caller: past ${ws.NONCE_PER_CALLER_MAX} outstanding its oldest nonce is gone, its newest signs in (${oldest.status}, ${newest.status})`);
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
