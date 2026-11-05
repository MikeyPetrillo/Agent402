// Express "trust proxy" (src/trust-proxy.js). Every per-IP limiter keys on
// req.ip, so a server reached directly must not read a client-written
// X-Forwarded-For as the client address:
//   - TRUST_PROXY_HOPS unset reads 0 (with a boot warning naming the
//     variable), an explicit 0 is honored, a value that is not a whole number
//     from 0 to 10 reads 0 with a warning;
//   - booted with it unset, a spoofed X-Forwarded-For does not mint a fresh
//     bucket in the MCP transport limiter once the real address is spent;
//   - booted with TRUST_PROXY_HOPS=1 (behind one edge), the forwarded entry is
//     the client, as before;
//   - with no hop trusted, only a genuine loopback replay (the secret its
//     caller proves) takes the buyer address it carries; anything else keeps
//     the socket address.
//
//   node scripts/test-trust-proxy.js
import { randomBytes } from "node:crypto";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { trustProxyHops, replayClientIpMiddleware } from "../src/trust-proxy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. the value read
{
  const warns = [];
  const w = (m) => warns.push(m);
  ok(trustProxyHops({}, w) === 0 && /TRUST_PROXY_HOPS is unset/.test(warns[0] || ""), "unset reads 0 and warns, naming TRUST_PROXY_HOPS");
  ok(trustProxyHops({ TRUST_PROXY_HOPS: "" }, w) === 0, "empty reads 0");
  warns.length = 0;
  ok(trustProxyHops({ TRUST_PROXY_HOPS: "0" }, w) === 0 && warns.length === 0, "an explicit 0 is honored without a warning");
  ok(trustProxyHops({ TRUST_PROXY_HOPS: "1" }, w) === 1 && warns.length === 0, "1 reads 1");
  ok(trustProxyHops({ TRUST_PROXY_HOPS: " 2 " }, w) === 2, "whitespace around a number is ignored");
  for (const bad of ["-1", "1.5", "abc", "11", "true", "0x1"]) {
    warns.length = 0;
    ok(trustProxyHops({ TRUST_PROXY_HOPS: bad }, w) === 0 && warns.length === 1, `"${bad}" reads 0 with a warning`);
  }
}

// --- 2. the replay middleware
{
  const run = (req, isReplay) => { replayClientIpMiddleware({ isReplay })(req, null, () => {}); return req.ip; };
  const mk = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {}, ip: peer });
  ok(run(mk("127.0.0.1", "198.51.100.7"), () => true) === "198.51.100.7", "a genuine replay on a loopback socket takes the address it carries");
  ok(run(mk("127.0.0.1", "198.51.100.7"), () => false) === "127.0.0.1", "a loopback request that is not a proven replay keeps the socket address");
  ok(run(mk("203.0.113.5", "198.51.100.7"), () => true) === "203.0.113.5", "a non-loopback peer keeps its socket address whatever it claims");
  ok(run(mk("127.0.0.1", "not-an-ip"), () => true) === "127.0.0.1", "a forwarded entry that is not an address is ignored");
  ok(run(mk("::1", "10.0.0.1, 198.51.100.8"), () => true) === "198.51.100.8", "the last entry (the one our replay appended) is read");
}

// --- 3. two boots: TRUST_PROXY_HOPS unset, and 1
const CAP = 3;
const [P0, P1] = await getFreePorts(2);
const procs = [];
const boot = (port, extra, label) => {
  const env = { ...process.env, ...ownStoreEnv(label), PORT: String(port), FREE_MODE: "true", X402_SYNC_ON_START: "false",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", REDIS_URL: "", SHARED_LIMITS: "off",
    AGENT402_MCP_REQ_PER_MIN: String(CAP), AGENT402_MCP_REQ_PER_HOUR: "1000", ...extra };
  if (!("TRUST_PROXY_HOPS" in extra)) delete env.TRUST_PROXY_HOPS;
  const p = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  p.log = [];
  p.stdout.on("data", (d) => p.log.push(String(d)));
  p.stderr.on("data", (d) => p.log.push(String(d)));
  procs.push(p);
  return p;
};
const killAll = () => { for (const p of procs) try { p.kill("SIGKILL"); } catch { /* gone */ } };
setTimeout(() => { console.error("FAIL - timed out"); killAll(); process.exit(1); }, 150_000).unref();

const initBody = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trust-proxy-test", version: "1" } } });
const mcp = (port, id, xff, extra = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(xff ? { "X-Forwarded-For": xff } : {}), ...extra },
  body: initBody(id),
}).then(async (r) => { await r.arrayBuffer(); return r.status; });
const healthy = async (port, p) => {
  for (let i = 0; i < 200; i++) {
    if (p.exitCode !== null) return false;
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* booting */ }
    await sleep(500);
  }
  return false;
};

try {
  const s0 = boot(P0, {}, "trust-proxy-unset");
  const s1 = boot(P1, { TRUST_PROXY_HOPS: "1" }, "trust-proxy-one");
  const [u0, u1] = await Promise.all([healthy(P0, s0), healthy(P1, s1)]);
  ok(u0 && u1, `both servers booted (unset ${u0}, one hop ${u1})`);
  if (!u0 || !u1) for (const p of [s0, s1]) console.error(p.log.join("").slice(-1500));

  ok(/TRUST_PROXY_HOPS is unset/.test(s0.log.join("")), "the unset boot logs a warning naming TRUST_PROXY_HOPS");
  ok(!/TRUST_PROXY_HOPS is unset/.test(s1.log.join("")), "the boot that sets it logs no such warning");

  // Unset: spend the real address's transport budget, then rotate the header.
  const spent0 = [];
  for (let i = 0; i < CAP; i++) spent0.push(await mcp(P0, i + 1));
  ok(spent0.every((s) => s !== 429), `the first ${CAP} requests are served (${spent0.join(",")})`);
  ok((await mcp(P0, 10)) === 429, "the next request from the same address is limited");
  const spoof0 = [await mcp(P0, 11, "198.51.100.77"), await mcp(P0, 12, "198.51.100.78")];
  ok(spoof0.every((s) => s === 429), `unset: a spoofed X-Forwarded-For does not mint a fresh bucket (${spoof0.join(",")})`);
  // A forged replay marker (an async-loopback token or an MCP marker this
  // process did not mint) must not let a loopback client choose its address.
  const forged0 = [
    await mcp(P0, 13, "198.51.100.91", { "x-agent402-async-loopback": randomBytes(24).toString("hex") }),
    await mcp(P0, 14, "198.51.100.92", { "x-agent402-async-loopback": "" }),
    await mcp(P0, 15, "198.51.100.93", { "X-Agent402-Via": `mcp;k=${randomBytes(24).toString("hex")}` }),
    await mcp(P0, 16, "198.51.100.94", { "X-Agent402-Via": "mcp" }),
  ];
  ok(forged0.every((s) => s === 429), `unset: a forged async token or MCP marker keeps the socket address (${forged0.join(",")})`);

  // One hop trusted: the forwarded entry is the client, as behind the edge.
  for (let i = 0; i < CAP; i++) await mcp(P1, i + 1);
  ok((await mcp(P1, 10)) === 429, "one hop: the loopback address's budget is spent");
  const fwd1 = [await mcp(P1, 11, "198.51.100.77"), await mcp(P1, 12, "198.51.100.78")];
  ok(fwd1.every((s) => s !== 429), `one hop: each forwarded client has its own bucket, as before (${fwd1.join(",")})`);
} finally {
  killAll();
}

console.log(`\ntest-trust-proxy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
