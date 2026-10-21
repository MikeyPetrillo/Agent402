// The client address behind the hosting edge, with or without the CDN proxy in
// front of it (src/cdn-client-ip.js).
//
// Unit: the resolver reads CF-Connecting-IP only from a peer inside the CDN's
// published ranges (IPv4 and IPv6, plus CF_IP_RANGES_EXTRA), only when it
// parses as an address, and never from any other peer.
//
// End to end through a booted server: the hosting edge is simulated by
// X-Forwarded-For (trust proxy reads its last hop), and the checkout limiter
// (6 a minute per client address, keyed before the body parser) shows which
// address a limiter sees:
//   - a direct request with a forged CF-Connecting-IP keeps its own bucket;
//   - a request whose edge-reported peer is a CDN address is keyed on
//     CF-Connecting-IP, so two clients behind one CDN address do not share;
//   - a malformed CF-Connecting-IP from a CDN peer falls back to the peer;
//   - the same holds for an IPv6 CDN peer.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { buildCdnRanges, resolveClientIp, inCdnRanges, normalizeIp, cdnClientIpMiddleware, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "../src/cdn-client-ip.js";

let pass = 0;
let proc = null;
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

  const direct = resolveClientIp("203.0.113.7", "198.51.100.9", R);
  ok(direct.ip === "203.0.113.7" && direct.viaCdn === false, `a forged CF-Connecting-IP from a non-CDN peer is ignored (${JSON.stringify(direct)})`);
  const via = resolveClientIp("104.16.0.5", "198.51.100.9", R);
  ok(via.ip === "198.51.100.9" && via.viaCdn === true, `a CDN peer's CF-Connecting-IP is the client (${JSON.stringify(via)})`);
  const via6 = resolveClientIp("2606:4700::1", "2001:db8::42", R);
  ok(via6.ip === "2001:db8::42" && via6.viaCdn === true, "IPv6 peer and IPv6 client work");
  for (const bad of ["not-an-ip", "198.51.100.9, 1.2.3.4", "", "999.1.1.1", "x".repeat(80), undefined]) {
    const r = resolveClientIp("104.16.0.5", bad, R);
    ok(r.ip === "104.16.0.5" && r.viaCdn === true, `a malformed CF-Connecting-IP (${JSON.stringify(String(bad).slice(0, 20))}) falls back to the peer`);
  }
  ok(resolveClientIp("104.16.0.5", ["198.51.100.1", "198.51.100.2"], R).ip === "198.51.100.1", "a repeated header uses its first value only when valid");
  const X = buildCdnRanges("10.250.0.0/16, fd00:cd::/32 bogus/99");
  ok(inCdnRanges("10.250.3.4", X) && inCdnRanges("fd00:cd::1", X) && !inCdnRanges("10.251.0.1", X), "CF_IP_RANGES_EXTRA adds IPv4 and IPv6 ranges and skips a bad entry");

  // The middleware: req.ip is redefined only for a CDN peer.
  const run = (edgeIp, cf) => {
    const proto = { get ip() { return edgeIp; } };
    const req = Object.create(proto);
    req.headers = cf === undefined ? {} : { "cf-connecting-ip": cf };
    let called = false;
    cdnClientIpMiddleware({ ranges: R })(req, {}, () => { called = true; });
    return { req, called };
  };
  const a = run("203.0.113.7", "198.51.100.9");
  ok(a.called && a.req.ip === "203.0.113.7" && a.req.viaCdn === false && !Object.hasOwn(a.req, "ip"), "middleware: a direct request keeps req.ip untouched");
  const b = run("104.16.0.5", "198.51.100.9");
  ok(b.called && b.req.ip === "198.51.100.9" && b.req.viaCdn === true && b.req.cdnPeerIp === "104.16.0.5", "middleware: a CDN request's req.ip is the client");
}

// ---- end to end ----
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", CF_IP_RANGES_EXTRA: "" },
  stdio: "ignore",
});
const buy = (headers) => fetch(`${B}/api/buy`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{" })
  .then((r) => r.status).catch(() => 0);
const burst = async (n, headersOf) => { const out = []; for (let i = 0; i < n; i++) out.push(await buy(headersOf(i))); return out; };

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "server booted");

  // 1. Direct (peer 203.0.113.7), a different forged CF-Connecting-IP on every
  //    call: one bucket, the 7th is limited.
  const s1 = await burst(7, (i) => ({ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": `198.51.100.${i + 1}` }));
  ok(s1.slice(0, 6).every((s) => s !== 429) && s1[6] === 429, `a forged CF-Connecting-IP from a direct peer never mints a fresh bucket (${s1.join(",")})`);

  // 2. Through a CDN peer, distinct clients: each its own bucket.
  const s2 = await burst(8, (i) => ({ "x-forwarded-for": "104.16.0.5", "cf-connecting-ip": `198.51.100.${100 + i}` }));
  ok(s2.every((s) => s !== 429), `distinct clients behind one CDN address are keyed apart (${s2.join(",")})`);
  // ... and one client behind it is limited on its own address.
  const s2b = await burst(7, () => ({ "x-forwarded-for": "104.16.0.5", "cf-connecting-ip": "198.51.100.200" }));
  ok(s2b.slice(0, 6).every((s) => s !== 429) && s2b[6] === 429, `one client behind the CDN is limited on its own address (${s2b.join(",")})`);
  // The resolved address is the client's, not the CDN peer's: the same client
  // reached directly shares that bucket.
  const s2c = await buy({ "x-forwarded-for": "198.51.100.200" });
  ok(s2c === 429, `the resolved client address is the bucket (direct call from it: ${s2c})`);

  // 3. A malformed header from a CDN peer falls back to the peer.
  const s3 = await burst(7, (i) => ({ "x-forwarded-for": "104.16.0.6", "cf-connecting-ip": i % 2 ? "not-an-ip" : "300.1.1.1" }));
  ok(s3.slice(0, 6).every((s) => s !== 429) && s3[6] === 429, `a malformed CF-Connecting-IP keys on the CDN peer (${s3.join(",")})`);

  // 4. IPv6 CDN peer, IPv6 clients.
  const s4 = await burst(8, (i) => ({ "x-forwarded-for": "2606:4700::10", "cf-connecting-ip": `2001:db8:${(i + 1).toString(16)}::1` }));
  ok(s4.every((s) => s !== 429), `IPv6 clients (distinct /64s) behind an IPv6 CDN peer are keyed apart (${s4.join(",")})`);
  const s4b = await burst(7, () => ({ "x-forwarded-for": "2606:4700::10", "cf-connecting-ip": "2001:db8::ff" }));
  ok(s4b[6] === 429, `one IPv6 client behind the CDN is limited on its own address (${s4b.join(",")})`);

  // 5. A forged CF-Connecting-IP naming an exhausted client, from a direct
  //    peer, is not that client.
  const s5 = await buy({ "x-forwarded-for": "203.0.113.99", "cf-connecting-ip": "198.51.100.200" });
  ok(s5 !== 429, `a forged CF-Connecting-IP cannot borrow another client's address (got ${s5})`);

  console.log(`\n${pass} passed`);
} finally {
  proc.kill("SIGKILL");
}
process.exit(0);
