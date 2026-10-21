// A free call (proof-of-work or trial) skips x402 verification, so a payment
// header riding on it is unverified. Every free-accept branch must drop it
// before the handler, as the MPP and credits gates do, or payerFromRequest()
// reads its authorization.from as the payer: a forged header naming one of our
// wallets would move an outside call's outcome onto our own traffic's lane.
//
// Two halves:
//   - wiring: each branch in src/server.js that sets X-Pow-Accepted or
//     X-Trial-Accepted calls dropUnverifiedPaymentHeaders(req) before its
//     next(), and the helper removes both header spellings;
//   - live: a paid-mode server (stub facilitator, real Redis) serves a valid
//     proof-of-work call that also carries a forged payment header naming our
//     own wallet, and the failure monitor counts its outcome on the OUTSIDE
//     lane. The lanes are read from the snapshot the monitor publishes to
//     Redis (every outcome, ok included, per lane). Control: a paid call that
//     really settles from our own wallet lands on the synthetic lane, so the
//     lane is observable and an own-wallet payer does move it.
// Requires REDIS_URL (under CI a missing one fails).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { OUR_EVM_WALLETS } from "../src/revenue-live.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wiring
const src = readFileSync(join(ROOT, "src", "server.js"), "utf8");
const helper = /function dropUnverifiedPaymentHeaders\(req\) \{([\s\S]*?)\n\}/.exec(src);
ok(!!helper, "dropUnverifiedPaymentHeaders is defined");
ok(helper && ["payment-signature", "x-payment"].every((h) => helper[1].includes(`"${h}"`)), "the helper drops both payment header spellings");
const accepts = [...src.matchAll(/res\.setHeader\("X-(Pow|Trial)-Accepted", "true"\);/g)];
ok(accepts.length >= 3, `every free-accept branch found (got ${accepts.length})`);
for (const m of accepts) {
  const rest = src.slice(m.index);
  const nextAt = rest.search(/return next\(\);/);
  const line = src.slice(0, m.index).split("\n").length;
  ok(nextAt > 0 && rest.slice(0, nextAt).includes("dropUnverifiedPaymentHeaders(req);"), `X-${m[1]}-Accepted at server.js:${line} drops payment headers before next()`);
}

// ---- live
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-free-call-payment-headers: no REDIS_URL for the live half; start a local Redis (redis-server --port 26379 --save '') and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
const { createServer } = await import("node:http");
const { createClient } = await import("redis");
const [PORT, FAC_PORT] = await getFreePorts(2);
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = `fcph${process.pid}${Date.now().toString(36)}`;
// Stub facilitator: accepts every verify and settle, so the control call
// really settles; nothing leaves loopback.
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const payer = p.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") return reply({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer });
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    X402_INDEX_CRAWL: "off",
    MPP_INDEX_CRAWL: "off",
    STATE_DATABASE_URL: "",
    REDIS_URL: REDIS,
    SHARED_LIMITS_PREFIX: PREFIX,
    TOOL_FAILURE_PUBLISH_MS: "200",
    LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
    FREE_MODE: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
for (const st of [proc.stdout, proc.stderr]) st.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 300)); });
function solve(challenge, difficulty) {
  for (let n = 0; n < 5_000_000; n++) {
    const h = createHash("sha256").update(challenge + ":" + n).digest();
    let bits = 0;
    for (const byte of h) { if (byte === 0) { bits += 8; continue; } bits += Math.clz32(byte) - 24; break; }
    if (bits >= difficulty) return n;
  }
  throw new Error("solver gave up");
}
const redis = createClient({ url: REDIS });
await redis.connect();
// The hash slug's counts per lane, summed over this server's published
// buckets: { outside, synthetic } of ok answers.
const lanes = async () => {
  const keys = await redis.keys(`tfm:${PREFIX}:snap:*`);
  const out = { outside: 0, synthetic: 0, snapshots: keys.length };
  for (const k of keys) {
    let snap = null; try { snap = JSON.parse(await redis.get(k)); } catch { snap = null; }
    for (const row of Object.values(snap?.tools?.hash || {})) { out.outside += row.o?.[0] || 0; out.synthetic += row.s?.[0] || 0; }
  }
  return out;
};
const waitLanes = async (cond) => { let l = await lanes(); for (let i = 0; i < 100 && !cond(l); i++) { await sleep(100); l = await lanes(); } return l; };
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const ours = [...OUR_EVM_WALLETS][0];
  ok(typeof ours === "string" && ours.startsWith("0x"), "an own EVM wallet to forge");
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from: ours, to: "0x000000000000000000000000000000000000dEaD", value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } } })).toString("base64");
  const ch = await (await fetch(`${BASE}/api/pow/challenge?slug=hash`)).json();
  const nonce = solve(ch.challenge, ch.difficulty);
  const r = await fetch(`${BASE}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": `${ch.token}:${nonce}`, "X-Payment": forged, "Payment-Signature": forged },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(r.status === 200 && r.headers.get("x-pow-accepted") === "true", `proof-of-work call with a forged payment header is served (got ${r.status})`);
  const body = await r.json().catch(() => ({}));
  ok(typeof body.hex === "string" && body.hex.startsWith("b94d27b9"), "the answer is the tool's own");
  const l1 = await waitLanes((l) => l.outside + l.synthetic >= 1);
  ok(l1.snapshots >= 1, `the monitor published its snapshot to Redis (${l1.snapshots})`);
  ok(l1.outside === 1 && l1.synthetic === 0, `the forged header does not move the free call onto our own lane (outside ${l1.outside}, synthetic ${l1.synthetic})`);

  // Control: a paid call that settles from our own wallet IS our own traffic.
  // The paywall answers 402 once its facilitator's supported kinds are read.
  const quote = () => fetch(`${BASE}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello world" }) });
  let unpaid = await quote();
  for (let i = 0; i < 60 && unpaid.status !== 402; i++) { await sleep(500); unpaid = await quote(); }
  const offer = JSON.parse(Buffer.from(unpaid.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
  const accepted = (offer.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(unpaid.status === 402 && !!accepted, `the paid control has a Base offer (${unpaid.status})`);
  const credential = Buffer.from(JSON.stringify({
    x402Version: 2, resource: offer.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: ours, to: accepted?.payTo, value: accepted?.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "c1".repeat(32) } },
  })).toString("base64");
  const paid = await fetch(`${BASE}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "Payment-Signature": credential }, body: JSON.stringify({ text: "hello world" }) });
  ok(paid.status === 200, `the paid control from our own wallet is served (${paid.status})`);
  const l2 = await waitLanes((l) => l.synthetic >= 1);
  ok(l2.synthetic === 1 && l2.outside === 1, `an own-wallet paid call lands on the synthetic lane (outside ${l2.outside}, synthetic ${l2.synthetic})`);
} finally {
  if (fail) for (const l of serverLog.slice(-30)) console.error("  server:", l);
  proc.kill();
  facilitator.close();
  try { const keys = await redis.keys(`*${PREFIX}*`); if (keys.length) await redis.del(keys); } catch { /* best effort */ }
  await redis.quit().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
