// The client address behind the hosting edge, with or without the CDN proxy in
// front of it (src/cdn-client-ip.js).
//
// Unit: CDN_PROXY off, the middleware only calls next(). On, the resolver reads
// CF-Connecting-IP only from a peer inside the CDN's published ranges (IPv4 and
// IPv6, plus CF_IP_RANGES_EXTRA) that also carries the origin secret in
// X-Origin-Auth, only when it parses as an address, and never otherwise.
//
// End to end through booted servers: the hosting edge is simulated by
// X-Forwarded-For (trust proxy reads its last hop), and the checkout limiter
// (6 a minute per client address, keyed before the body parser) and the
// proof-of-work challenge limiter (120 a minute per address) show which
// address a limiter sees.
//   CDN_PROXY off (the default):
//   - a CDN-range peer with a rotating CF-Connecting-IP keeps its own bucket,
//     on both limiters;
//   CDN_PROXY on, CDN_ORIGIN_SECRET set:
//   - a direct request with a forged CF-Connecting-IP keeps its own bucket;
//   - a CDN peer carrying the secret is keyed on CF-Connecting-IP, so two
//     clients behind one CDN address do not share;
//   - a CDN peer without the secret, or with a wrong one, keeps its own bucket;
//   - a malformed CF-Connecting-IP from a CDN peer falls back to the peer;
//   - the same holds for an IPv6 CDN peer.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { buildCdnRanges, resolveClientIp, inCdnRanges, normalizeIp, cdnClientIpMiddleware, cdnProxyEnabled, cdnOriginSecret, originAuthOk, cdnOriginStatus, refreshCdnOriginShared, __resetCdnOriginStatus, CDN_ORIGIN_UNAUTH_ALERT, ORIGIN_AUTH_HEADER, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "../src/cdn-client-ip.js";

let pass = 0;
let proc = null;
const SECRET = "origin-secret-for-tests-" + "q".repeat(16);
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- unit ----
{
  const R = buildCdnRanges("");
  ok(CLOUDFLARE_IPV4.length >= 10 && CLOUDFLARE_IPV6.length >= 5, "the published ranges are embedded");
  ok(inCdnRanges("104.16.0.5", R) && inCdnRanges("172.71.1.1", R) && inCdnRanges("162.159.200.1", R), "IPv4 CDN addresses are inside the ranges");
  ok(inCdnRanges("2606:4700::6810:1", R) && inCdnRanges("2a06:98c0:3600::103", R), "IPv6 CDN addresses are inside the ranges");
  ok(!inCdnRanges("203.0.113.7", R) && !inCdnRanges("2001:db8::1", R) && !inCdnRanges("10.0.0.1", R) && !inCdnRanges("127.0.0.1", R), "other addresses are outside");
  ok(inCdnRanges("::ffff:104.16.0.5", R) && normalizeIp("::ffff:1.2.3.4") === "1.2.3.4", "an IPv4-mapped IPv6 peer is normalized");
  ok(!inCdnRanges("not-an-ip", R) && !inCdnRanges("", R) && !inCdnRanges(undefined, R), "a non-address is never inside");

  const direct = resolveClientIp("203.0.113.7", "198.51.100.9", R, true);
  ok(direct.ip === "203.0.113.7" && direct.viaCdn === false, `a forged CF-Connecting-IP from a non-CDN peer is ignored (${JSON.stringify(direct)})`);
  const via = resolveClientIp("104.16.0.5", "198.51.100.9", R, true);
  ok(via.ip === "198.51.100.9" && via.viaCdn === true, `a CDN peer's CF-Connecting-IP is the client (${JSON.stringify(via)})`);
  const via6 = resolveClientIp("2606:4700::1", "2001:db8::42", R, true);
  ok(via6.ip === "2001:db8::42" && via6.viaCdn === true, "IPv6 peer and IPv6 client work");
  for (const bad of ["not-an-ip", "198.51.100.9, 1.2.3.4", "", "999.1.1.1", "x".repeat(80), undefined]) {
    const r = resolveClientIp("104.16.0.5", bad, R, true);
    ok(r.ip === "104.16.0.5" && r.viaCdn === true, `a malformed CF-Connecting-IP (${JSON.stringify(String(bad).slice(0, 20))}) falls back to the peer`);
  }
  ok(resolveClientIp("104.16.0.5", ["198.51.100.1", "198.51.100.2"], R, true).ip === "198.51.100.1", "a repeated header uses its first value only when valid");
  const X = buildCdnRanges("10.250.0.0/16, fd00:cd::/32 bogus/99");
  ok(inCdnRanges("10.250.3.4", X) && inCdnRanges("fd00:cd::1", X) && !inCdnRanges("10.251.0.1", X), "CF_IP_RANGES_EXTRA adds IPv4 and IPv6 ranges and skips a bad entry");

  const noAuth = resolveClientIp("104.16.0.5", "198.51.100.9", R);
  ok(noAuth.ip === "104.16.0.5" && noAuth.viaCdn === false, `a CDN peer without the origin secret keeps its own address (${JSON.stringify(noAuth)})`);

  // The switch and the secret.
  ok(!cdnProxyEnabled({}) && !cdnProxyEnabled({ CDN_PROXY: "off" }) && !cdnProxyEnabled({ CDN_PROXY: "1" }) && cdnProxyEnabled({ CDN_PROXY: "cloudflare" }) && cdnProxyEnabled({ CDN_PROXY: " On " }), "CDN_PROXY is off unless it is cloudflare or on");
  ok(cdnOriginSecret({}) === "" && cdnOriginSecret({ CDN_ORIGIN_SECRET: "short" }) === "" && cdnOriginSecret({ CDN_ORIGIN_SECRET: SECRET }) === SECRET, "a short or unset CDN_ORIGIN_SECRET counts as unset");
  ok(originAuthOk(SECRET, SECRET) && !originAuthOk(SECRET + "x", SECRET) && !originAuthOk("", SECRET) && !originAuthOk(undefined, SECRET) && !originAuthOk([SECRET, SECRET], SECRET) && !originAuthOk(SECRET, ""), "the origin secret must match exactly, once, and be configured");

  // The middleware.
  const run = (edgeIp, headers, opts) => {
    const proto = { get ip() { return edgeIp; } };
    const req = Object.create(proto);
    req.headers = { ...headers };
    let called = false;
    cdnClientIpMiddleware({ ranges: R, log: () => {}, ...opts })(req, {}, () => { called = true; });
    return { req, called };
  };
  const off = run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: SECRET }, { enabled: false, secret: SECRET });
  ok(off.called && off.req.ip === "104.16.0.5" && !Object.hasOwn(off.req, "ip") && off.req.viaCdn === undefined && off.req.headers[ORIGIN_AUTH_HEADER] === SECRET, "middleware off: a CDN peer's request is untouched (req.ip, viaCdn and headers as they came)");
  const ON = { enabled: true, secret: SECRET };
  const a = run("203.0.113.7", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: SECRET }, ON);
  ok(a.called && a.req.ip === "203.0.113.7" && a.req.viaCdn === false && !Object.hasOwn(a.req, "ip"), "middleware on: a direct request keeps req.ip untouched, even carrying the secret");
  const b = run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: SECRET }, ON);
  ok(b.called && b.req.ip === "198.51.100.9" && b.req.viaCdn === true && b.req.cdnPeerIp === "104.16.0.5", "middleware on: a CDN request with the secret has the client as req.ip");
  ok(!(ORIGIN_AUTH_HEADER in b.req.headers), "middleware on: the origin secret is removed from the headers");
  const c = run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9" }, ON);
  ok(c.req.ip === "104.16.0.5" && c.req.viaCdn === false && !Object.hasOwn(c.req, "ip"), "middleware on: a CDN peer without the secret keeps its own address");
  const d = run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: "wrong-secret-value-0000" }, ON);
  ok(d.req.ip === "104.16.0.5" && d.req.viaCdn === false && !(ORIGIN_AUTH_HEADER in d.req.headers), "middleware on: a wrong secret is ignored and removed");
  const e = run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: "" }, { enabled: true, secret: "" });
  ok(e.req.ip === "104.16.0.5" && e.req.viaCdn === false, "middleware on with no secret configured: the header is never trusted");
  // The status word: CDN-range peers without a valid secret read
  // unauthenticated for an hour once they reach the alert count; a direct
  // peer without one, or a CDN peer with it, does not count; off while the
  // resolver is off.
  __resetCdnOriginStatus();
  ok(CDN_ORIGIN_UNAUTH_ALERT >= 1 && cdnOriginStatus({ enabled: false }).status === "off" && cdnOriginStatus({ enabled: true, secret: SECRET }).status === "ok", "cdnOrigin reads off while the resolver is off and ok with nothing counted");
  run("203.0.113.7", { "cf-connecting-ip": "198.51.100.9" }, { enabled: true, secret: SECRET });
  run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: SECRET }, { enabled: true, secret: SECRET });
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 1 }).status === "ok", "a direct peer without the secret and a CDN peer with it do not count");
  run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9" }, { enabled: true, secret: SECRET });
  const w = cdnOriginStatus({ enabled: true, secret: SECRET, full: true, threshold: 1 });
  ok(w.status === "unauthenticated" && w.unauthenticatedInWindow === 1 && w.threshold === 1 && w.scope === "instance" && w.secretConfigured === true && Object.keys(cdnOriginStatus({ enabled: true, secret: SECRET })).join(",") === "status", `a CDN-range peer without the secret reads unauthenticated at the count; the public word carries no count (${JSON.stringify(w)})`);
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 2 }).status === "ok" && cdnOriginStatus({ enabled: true, secret: SECRET, full: true, threshold: 2 }).unauthenticatedInWindow === 1, "below the alert count the word stays ok (a probe reaching the origin host directly is not a lost secret); the operator still sees the count");
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 1, now: Date.now() + 61 * 60_000 }).status === "ok", "...and the word clears once the hour has passed");
  run("104.16.0.5", { "cf-connecting-ip": "198.51.100.9", [ORIGIN_AUTH_HEADER]: "x" }, { enabled: true, secret: "" });
  ok(cdnOriginStatus({ enabled: true, secret: "", full: true }).secretConfigured === false, "with no secret configured the operator view says so");
  __resetCdnOriginStatus();

  // Two replicas behind one proxy: the count is kept in a shared hour window
  // (src/shared-limits.js) and the word reads it, so a replica that served
  // none of the unauthenticated requests still answers the same word.
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const store = createMemoryLimits();
  const SHARED = { enabled: true, secret: SECRET, shared: store };
  for (let i = 0; i < 3; i++) run("104.16.0.5", { "cf-connecting-ip": `198.51.100.${10 + i}` }, SHARED);
  await sleep(20);
  ok((await store.windowRead("cdn-origin-unauth", "all", { windowMs: 3_600_000 })).count === 3, "each unauthenticated CDN-range request is one entry in the shared hour window");
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 3 }).status === "unauthenticated" && cdnOriginStatus({ enabled: true, secret: SECRET, full: true, threshold: 3 }).scope === "shared", "the replica that served them reads unauthenticated at the count");
  __resetCdnOriginStatus(); // the sibling replica: nothing counted here
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 3 }).status === "ok", "a replica that served none of them, before it reads the window, counts nothing");
  await refreshCdnOriginShared();
  const shared = cdnOriginStatus({ enabled: true, secret: SECRET, full: true, threshold: 3 });
  ok(shared.status === "unauthenticated" && shared.unauthenticatedInWindow === 3, `...and reads the same word once it has read the shared window (${JSON.stringify(shared)})`);
  ok(cdnOriginStatus({ enabled: true, secret: SECRET, threshold: 3, now: Date.now() + 6 * 60_000 }).status === "ok", "a shared reading older than a few minutes is not reused");
  __resetCdnOriginStatus();
  cdnClientIpMiddleware({ ranges: R, log: () => {}, enabled: true, secret: SECRET }); // detach the store
}

// ---- end to end ----

const boot = async (extraEnv) => {
  const PORT = await getFreePort();
  const B = `http://127.0.0.1:${PORT}`;
  proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", CF_IP_RANGES_EXTRA: "", CDN_PROXY: "", CDN_ORIGIN_SECRET: "", POW_CHALLENGE_PER_MIN: "", ...extraEnv },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, `server booted (${JSON.stringify(extraEnv)})`);
  const buy = (headers) => fetch(`${B}/api/buy`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{" })
    .then((r) => r.status).catch(() => 0);
  const cdnWord = async () => (await (await fetch(`${B}/api/gateway-status`)).json()).cdnOrigin?.status;
  const burst = async (n, headersOf) => { const out = []; for (let i = 0; i < n; i++) out.push(await buy(headersOf(i))); return out; };
  const challenges = async (n, headersOf) => { const out = []; for (let i = 0; i < n; i++) out.push(await fetch(`${B}/api/pow/challenge?slug=hash`, { headers: headersOf(i) }).then((r) => r.status).catch(() => 0)); return out; };
  return { buy, burst, challenges, cdnWord };
};
const limited7 = (s) => s.slice(0, 6).every((x) => x !== 429) && s[6] === 429;
const auth = { [ORIGIN_AUTH_HEADER]: SECRET };

try {
  // ---- CDN_PROXY off (the default): main's behavior ----
  {
    const { burst, challenges, cdnWord } = await boot({});
    const s0 = await burst(7, (i) => ({ "x-forwarded-for": "104.16.0.5", "cf-connecting-ip": `198.51.100.${i + 1}`, ...auth }));
    ok(limited7(s0), `off: a CDN-range peer with a rotating CF-Connecting-IP keeps its own checkout bucket (${s0.join(",")})`);
    const p0 = await challenges(140, (i) => ({ "x-forwarded-for": "104.16.0.7", "cf-connecting-ip": `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`, ...auth }));
    const p429 = p0.filter((x) => x === 429).length;
    ok(p0.slice(0, 120).every((x) => x !== 429) && p429 === 20, `off: 140 challenge calls from one CDN-range peer with rotating CF-Connecting-IP are limited on the peer (${p429} of 140 got 429)`);
    ok((await cdnWord()) === "off", "off: /api/gateway-status reads cdnOrigin off");
    proc.kill("SIGKILL"); proc = null;
  }

  // ---- CDN_PROXY on, with the origin secret (the word turns at 5 unauthenticated requests an hour) ----
  const { buy, burst, challenges, cdnWord } = await boot({ CDN_PROXY: "cloudflare", CDN_ORIGIN_SECRET: SECRET, CDN_ORIGIN_UNAUTH_ALERT: "5" });

  // 1. Direct (peer 203.0.113.7), a different forged CF-Connecting-IP on every
  //    call (and the secret): one bucket, the 7th is limited.
  const s1 = await burst(7, (i) => ({ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": `198.51.100.${i + 1}`, ...auth }));
  ok(limited7(s1), `a forged CF-Connecting-IP from a direct peer never mints a fresh bucket (${s1.join(",")})`);

  // 2. Through a CDN peer with the secret, distinct clients: each its own bucket.
  const s2 = await burst(8, (i) => ({ "x-forwarded-for": "104.16.0.5", "cf-connecting-ip": `198.51.100.${100 + i}`, ...auth }));
  ok(s2.every((s) => s !== 429), `distinct clients behind one CDN address are keyed apart (${s2.join(",")})`);
  // ... and one client behind it is limited on its own address.
  const s2b = await burst(7, () => ({ "x-forwarded-for": "104.16.0.5", "cf-connecting-ip": "198.51.100.200", ...auth }));
  ok(limited7(s2b), `one client behind the CDN is limited on its own address (${s2b.join(",")})`);
  // The resolved address is the client's, not the CDN peer's: the same client
  // reached directly shares that bucket.
  const s2c = await buy({ "x-forwarded-for": "198.51.100.200" });
  ok(s2c === 429, `the resolved client address is the bucket (direct call from it: ${s2c})`);

  // So far every CDN-range peer carried the secret: the status word is ok.
  ok((await cdnWord()) === "ok", "on: with every CDN peer authenticated, /api/gateway-status reads cdnOrigin ok");

  // 2b. A CDN-range peer without the secret, or with a wrong one, is not
  //     trusted: it keeps its own bucket. One such request (a probe calling
  //     the origin host directly) leaves the word ok; past the alert count
  //     it turns.
  const s2pre = await buy({ "x-forwarded-for": "104.16.0.12", "cf-connecting-ip": "198.51.100.149" });
  ok(s2pre !== 429 && (await cdnWord()) === "ok", `on, no secret: one unauthenticated CDN-range request leaves the public word ok (${s2pre})`);
  const s2d = await burst(7, (i) => ({ "x-forwarded-for": "104.16.0.8", "cf-connecting-ip": `198.51.100.${150 + i}` }));
  ok(limited7(s2d), `on, no secret: a CDN-range peer's CF-Connecting-IP is ignored (${s2d.join(",")})`);
  ok((await cdnWord()) === "unauthenticated", "on: CDN-range peers without the secret past the alert count turn the public word unauthenticated (the heartbeat and the status Worker page on it)");
  const s2e = await burst(7, (i) => ({ "x-forwarded-for": "104.16.0.9", "cf-connecting-ip": `198.51.100.${160 + i}`, [ORIGIN_AUTH_HEADER]: SECRET.slice(0, -1) + "x" }));
  ok(limited7(s2e), `on, wrong secret: a CDN-range peer's CF-Connecting-IP is ignored (${s2e.join(",")})`);
  const p1 = await challenges(140, (i) => ({ "x-forwarded-for": "104.16.0.10", "cf-connecting-ip": `198.52.${Math.floor(i / 250)}.${(i % 250) + 1}` }));
  ok(p1.filter((x) => x === 429).length === 20, `on, no secret: 140 challenge calls with rotating CF-Connecting-IP are limited on the peer (${p1.filter((x) => x === 429).length} got 429)`);
  const p2 = await challenges(140, (i) => ({ "x-forwarded-for": "104.16.0.11", "cf-connecting-ip": `198.53.${Math.floor(i / 250)}.${(i % 250) + 1}`, ...auth }));
  ok(p2.every((x) => x !== 429), `on, with the secret: each client behind the CDN has its own challenge budget (${p2.filter((x) => x === 429).length} got 429)`);

  // 3. A malformed header from a CDN peer falls back to the peer.
  const s3 = await burst(7, (i) => ({ "x-forwarded-for": "104.16.0.6", "cf-connecting-ip": i % 2 ? "not-an-ip" : "300.1.1.1", ...auth }));
  ok(limited7(s3), `a malformed CF-Connecting-IP keys on the CDN peer (${s3.join(",")})`);

  // 4. IPv6 CDN peer, IPv6 clients.
  const s4 = await burst(8, (i) => ({ "x-forwarded-for": "2606:4700::10", "cf-connecting-ip": `2001:db8:${(i + 1).toString(16)}::1`, ...auth }));
  ok(s4.every((s) => s !== 429), `IPv6 clients (distinct /64s) behind an IPv6 CDN peer are keyed apart (${s4.join(",")})`);
  const s4b = await burst(7, () => ({ "x-forwarded-for": "2606:4700::10", "cf-connecting-ip": "2001:db8::ff", ...auth }));
  ok(s4b[6] === 429, `one IPv6 client behind the CDN is limited on its own address (${s4b.join(",")})`);

  // 5. A forged CF-Connecting-IP naming an exhausted client, from a direct
  //    peer, is not that client.
  const s5 = await buy({ "x-forwarded-for": "203.0.113.99", "cf-connecting-ip": "198.51.100.200", ...auth });
  ok(s5 !== 429, `a forged CF-Connecting-IP cannot borrow another client's address (got ${s5})`);

  console.log(`\n${pass} passed`);
} finally {
  proc?.kill("SIGKILL");
}
process.exit(0);
