// First-call allowance (src/first-call-allowance.js), end to end in paid mode
// against a stub facilitator and REAL Redis: the paywall verifies every
// payment, and the stub counts every settle by nonce, so "not charged" is a
// settle that never reached the facilitator.
//
// Boot A (switch off): a fresh wallet's paid call settles as before, with no
// allowance header and no word on /api/gateway-status.
// Boot B (switch on; eligible routes named, small caps):
//   - a new wallet's first call is served, not settled, with the header, the
//     body field and no PAYMENT-RESPONSE; its re-sent payment is never
//     replayed from the idempotency store; its second call settles;
//   - five concurrent first calls from one wallet: exactly one grant;
//   - a handler 4xx takes nothing (released) and is not charged, and the
//     same wallet's next call is granted;
//   - a route over the price cap, a route not listed, a wallet with a prior
//     sale, our own wallet and a wallet whose balance is below the price all
//     settle normally;
//   - the per-address cap and the daily USD cap refuse further grants, which
//     then settle normally, and the public word reads "spent";
//   - a call asking for a share link (body or query) takes no grant and
//     settles normally;
//   - a granted call whose client leaves before its handler starts is given
//     back (not settled, nothing owed);
//   - nothing is booked for a grant: one usdc sale per settle, no refund row.
// Boot C (switch on, the web answer route eligible, its upstream stubbed and
// slow, no forgiveness ticket):
//   - a granted call whose client leaves while its handler runs is served
//     unsettled and booked as owed nowhere (no refund row, no
//     charged-but-not-served line);
//   - a call asking for a share link takes no grant, settles, and its link
//     is written.
// With STATE_DATABASE_URL set, boot B runs on the state database in a schema
// of its own (dropped afterwards), and a served grant is also a record there.
// Requires REDIS_URL (under CI a missing one fails).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { OUR_EVM_WALLETS } from "../src/revenue-live.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-first-call-allowance: no REDIS_URL; start a local Redis and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
const { createClient } = await import("redis");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_TOKEN = "first-call-allowance-test-operator-token-0123";
const PREFIX = `fca${process.pid}${Date.now().toString(36)}`;
const PG_URL = String(process.env.STATE_DATABASE_URL || "").trim();
const PG_SCHEMA = `fca_${process.pid}_${Date.now().toString(36)}`;
// Wallets are fresh per run, so a shared database never holds a prior sale or grant for one.
const RUN = randomBytes(8).toString("hex");
const POOR = "0x" + RUN + "b0".padStart(24, "0");
// Its balance read answers late (inside the read's bound), so a client can leave mid-call.
const SLOW = "0x" + RUN + "b1".padStart(24, "0");

// ---- stub facilitator: verify accepts a well-formed authorization, settle
// succeeds once per nonce; /rpc answers balanceOf (zero for POOR).
const settledNonces = new Set();
const settlesByPayer = new Map();
let settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p = {}; try { p = JSON.parse(body || "{}"); } catch { /* ignore */ }
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      const data = String(p?.params?.[0]?.data || "");
      const who = "0x" + data.slice(-40).toLowerCase();
      if (who === SLOW) return void setTimeout(() => reply({ jsonrpc: "2.0", id: p.id ?? 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") }), 600);
      return reply({ jsonrpc: "2.0", id: p.id ?? 1, result: "0x" + (who === POOR ? 0 : 1_000_000_000).toString(16).padStart(64, "0") });
    }
    const auth = p?.paymentPayload?.payload?.authorization || null;
    const payer = String(auth?.from || "").toLowerCase();
    if (req.url === "/verify") return reply({ isValid: true, payer: auth?.from });
    if (req.url === "/settle") {
      settles++;
      const nonce = String(auth?.nonce || "").toLowerCase();
      if (settledNonces.has(nonce)) return reply({ success: false, errorReason: "nonce already used", transaction: "", network: "eip155:8453", payer: auth?.from });
      settledNonces.add(nonce);
      settlesByPayer.set(payer, (settlesByPayer.get(payer) || 0) + 1);
      return reply({ success: true, transaction: "0x" + createHash("sha256").update(nonce).digest("hex"), network: "eip155:8453", payer: auth?.from });
    }
    reply({});
  });
});

async function boot(extraEnv, { preload = null } = {}) {
  const [port, facPort] = await getFreePorts(2);
  if (!facilitator.listening) await new Promise((r) => facilitator.listen(facPort, "127.0.0.1", r));
  const fac = `http://127.0.0.1:${facilitator.address().port}`;
  const log = [];
  const proc = spawn(process.execPath, [...(preload ? ["--import", preload] : []), join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: fac, AGENT402_BASE_RPC: `${fac}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
      PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATE_DATABASE_URL: "", REDIS_URL: REDIS, SHARED_LIMITS_PREFIX: PREFIX,
      SALES_LEDGER_DB: join(mkdtempSync(join(tmpdir(), "fca-sales-")), "sales.db"),
      REFUND_DB_DIR: mkdtempSync(join(tmpdir(), "fca-refunds-")),
      HANGUP_FORGIVE_FILE: "off", STATS_ALLOW_EPHEMERAL: "true",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
      AGENT402_OPERATOR_TOKEN: OP_TOKEN, PORT: String(port), FREE_MODE: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const st of [proc.stdout, proc.stderr]) st.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) log.push(l.slice(0, 300)); if (log.length > 200) log.splice(0, log.length - 200); });
  const B = `http://127.0.0.1:${port}`;
  const quote = () => fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello world" }) }).catch(() => null);
  let r = null;
  for (let i = 0; i < 120; i++) { r = await quote(); if (r?.status === 402) break; await sleep(500); }
  if (r?.status !== 402) { for (const l of log.slice(-30)) console.error("  server:", l); throw new Error(`server did not come up with a paywall (${r?.status})`); }
  return { B, proc, log };
}

let nonceN = 0;
const wallet = (n) => "0x" + RUN + n.toString(16).padStart(24, "0");
async function acceptFor(B, path, method, body) {
  const r = await fetch(`${B}${path}`, { method, headers: { "content-type": "application/json" }, body });
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf-8") || "{}");
  return (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
}
const credential = (accept, from, nonce = "0x" + randomBytes(32).toString("hex")) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce } },
})).toString("base64");

const ROUTES = {
  hash: { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "hello world" }) },
  hashShare: { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "hello world", share: true }) },
  hashShareQ: { path: "/api/hash?share=1", method: "POST", body: JSON.stringify({ text: "hello world" }) },
  hashBad: { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "hello world", algo: "nope" }) },
  radar: { path: "/api/demand-radar?limit=1", method: "GET" },
  audit: { path: "/api/x402-audit?url=http%3A%2F%2F127.0.0.1%2Fpaid", method: "GET" },
  base64: { path: "/api/base64", method: "POST", body: JSON.stringify({ text: "hi", mode: "encode" }) },
};
async function payCall(B, route, from, { ip, cred } = {}) {
  const rt = ROUTES[route];
  const accept = await acceptFor(B, rt.path, rt.method, rt.body);
  const c = cred || credential(accept, from);
  const r = await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", "payment-signature": c, ...(ip ? { "x-forwarded-for": ip } : {}) }, body: rt.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, headers: r.headers, json, text, cred: c };
}
const granted = (r) => r.headers.get("x-agent402-allowance") === "first-call";
const opJson = async (B, path) => (await fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).json();

const redis = createClient({ url: REDIS });
await redis.connect();
let A = null, Bt = null, C = null;
try {
  // ---------------- Boot A: switch off ----------------
  A = await boot({ FIRST_CALL_ALLOWANCE: "", FIRST_CALL_ALLOWANCE_SLUGS: "hash" });
  {
    const s0 = settles;
    const r = await payCall(A.B, "hash", wallet(0xa0), { ip: "10.1.0.1" });
    ok(r.status === 200 && !granted(r) && settles === s0 + 1 && r.headers.get("payment-response"), `off: a new wallet's paid call settles as today (status ${r.status}, settles +${settles - s0})`);
    ok(!r.json?.firstCallAllowance, "off: no allowance field in the body");
    const gs = await (await fetch(`${A.B}/api/gateway-status`)).json();
    ok(!("firstCallAllowance" in gs), "off: /api/gateway-status carries no allowance word");
  }
  A.proc.kill("SIGKILL"); A = null;

  // ---------------- Boot B: switch on ----------------
  Bt = await boot({
    FIRST_CALL_ALLOWANCE: "on",
    FIRST_CALL_ALLOWANCE_SLUGS: "hash,demand-radar,x402-audit",
    FIRST_CALL_ALLOWANCE_MAX_USD: "0.005", // x402-audit ($0.01) is over it
    FIRST_CALL_ALLOWANCE_DAILY_USD: "0.01", // five grants of hash ($0.001) and one of demand-radar ($0.005)
    FIRST_CALL_ALLOWANCE_IP_PER_DAY: "1",
    // No forgiveness ticket: a granted call's hang-up reaches the debt recorder.
    HANGUP_FORGIVE: "off",
    ANSWER_SHARE: "on",
    ...(PG_URL ? { STATE_DATABASE_URL: PG_URL, STATE_DB_SCHEMA: PG_SCHEMA } : {}),
  });
  const B = Bt.B;
  const salesBase = (await opJson(B, "/__operator/sales.json")).totals?.byRail?.["external:usdc"] ?? 0;
  const settlesBase = settles;
  let grants = 0, grantUsd = 0;
  const denied = async () => (await opJson(B, "/__operator/refunds.json")).firstCallAllowance?.deniedToday || {};

  // 1. First call from a new wallet: served, not settled.
  const wA = wallet(0xa1);
  const s1 = settles;
  const r1 = await payCall(B, "hash", wA, { ip: "10.2.0.1" });
  ok(r1.status === 200 && granted(r1) && settles === s1, `on: a new wallet's first call is served and not settled (status ${r1.status}, settles +${settles - s1})`);
  ok(r1.json?.hex?.startsWith("b94d27b9") && r1.json?.firstCallAllowance?.charged === false, "the answer is the tool's own, with the allowance field saying nothing was charged");
  ok(!r1.headers.get("payment-response"), "no PAYMENT-RESPONSE on a grant (nothing settled)");
  ok(/no-store/.test(r1.headers.get("cache-control") || ""), "the granted answer is still no-store");
  grants++; grantUsd += 0.001;
  // 1b. The same signed payment re-sent: never replayed from the idempotency store.
  const s1b = settles;
  const r1b = await payCall(B, "hash", wA, { ip: "10.2.0.1", cred: r1.cred });
  ok(r1b.headers.get("x-replayed-answer") !== "1" && r1b.headers.get("x-idempotent-replay") !== "true" && !granted(r1b), `the granted payment re-sent is not served from the idempotency store (status ${r1b.status})`);
  // Inside the replay window the granted payment's nonce reads consumed: the
  // re-send is refused 409 before any facilitator call, so nothing settles.
  ok(r1b.status === 409 && settles === s1b && r1b.headers.get("x-payment-replay") === "consumed", `and is refused 409 as a consumed payment, not charged (status ${r1b.status}, settles +${settles - s1b}, x-payment-replay ${r1b.headers.get("x-payment-replay")})`);
  // 2. Second call from the same wallet settles normally.
  const s2 = settles;
  const r2 = await payCall(B, "hash", wA, { ip: "10.2.0.2" });
  ok(r2.status === 200 && !granted(r2) && settles === s2 + 1 && !!r2.headers.get("payment-response") && !r2.json?.firstCallAllowance, `the same wallet's second call settles normally (status ${r2.status}, settles +${settles - s2})`);

  // 3. Five concurrent first calls from one wallet: exactly one grant.
  const wC = wallet(0xc1);
  const s3 = settles;
  const conc = await Promise.all([0, 1, 2, 3, 4].map((i) => payCall(B, "hash", wC, { ip: `10.3.0.${i + 1}` })));
  const nGranted = conc.filter(granted).length;
  ok(conc.every((r) => r.status === 200) && nGranted === 1 && settles === s3 + 4, `concurrent first calls from one wallet: exactly one grant (granted ${nGranted}, settled ${settles - s3}, statuses ${conc.map((r) => r.status).join(",")})`);
  ok(((await denied())["wallet already granted"] || 0) >= 5, "the losers (and the first wallet's later calls) were refused as already granted");
  grants++; grantUsd += 0.001;

  // 4. A handler 4xx: no grant consumed, not charged; the next call is granted.
  const wD = wallet(0xd1);
  const before4 = (await opJson(B, "/__operator/refunds.json")).firstCallAllowance;
  const s4 = settles;
  const r4 = await payCall(B, "hashBad", wD, { ip: "10.4.0.1" });
  ok(r4.status === 400 && !granted(r4) && settles === s4, `a handler 400 under a claimed grant is not charged (status ${r4.status}, settles +${settles - s4})`);
  let after4 = null;
  for (let i = 0; i < 20; i++) { after4 = (await opJson(B, "/__operator/refunds.json")).firstCallAllowance; if (after4?.processToday?.released > (before4?.processToday?.released || 0)) break; await sleep(100); }
  ok(after4?.processToday?.claimed === (before4?.processToday?.claimed || 0) + 1 && after4?.processToday?.released === (before4?.processToday?.released || 0) + 1 && after4?.today?.grants === before4?.today?.grants && after4?.today?.usd === before4?.today?.usd,
    `the 400 claimed and released its grant: today's count and USD unchanged (${JSON.stringify(after4?.processToday)}, today ${JSON.stringify(after4?.today)})`);
  const r4b = await payCall(B, "hash", wD, { ip: "10.4.0.1" });
  ok(r4b.status === 200 && granted(r4b) && settles === s4, `the same wallet's next call is granted: the 400 consumed nothing (status ${r4b.status})`);
  grants++; grantUsd += 0.001;

  // 4b. A grant on a wallet-only route books nothing on the settle-failure
  // breaker (its outcomes are on the shared store, keyed by wallet); the same
  // wallet's next, settled call does.
  const wR = wallet(0xd2);
  const brk = async (name) => (await redis.zCard(`sl:${PREFIX}:${name}:${wR}`)) || 0;
  const s4c = settles;
  const r4c = await payCall(B, "radar", wR, { ip: "10.4.0.2" });
  ok(r4c.status === 200 && granted(r4c) && settles === s4c, `a wallet-only route's first call is granted (status ${r4c.status})`);
  grants++; grantUsd += 0.005;
  await sleep(300);
  ok(await brk("gwb-ok") === 0 && await brk("gwb-fail") === 0, "the grant is neither a settled nor a failed outcome on the breaker");
  const r4d = await payCall(B, "radar", wR, { ip: "10.4.0.3" });
  ok(r4d.status === 200 && !granted(r4d) && settles === s4c + 1, `its second call settles (status ${r4d.status})`);
  let okN = 0;
  for (let i = 0; i < 20 && okN === 0; i++) { okN = await brk("gwb-ok"); if (!okN) await sleep(100); }
  ok(okN === 1 && await brk("gwb-fail") === 0, `the settled call is the breaker's one outcome for the wallet (ok ${okN})`);

  // 5. Settles normally: over the price cap, not listed, prior sale, our own wallet, low balance.
  const s5 = settles;
  const capBefore = (await denied())["over the price cap"] || 0;
  const r5a = await payCall(B, "audit", wallet(0xe1), { ip: "10.5.0.1" });
  // Charged exactly as today: settled on a 200, never on an error.
  const expect5 = r5a.status === 200 ? 1 : 0;
  ok(!granted(r5a) && settles === s5 + expect5 && ((await denied())["over the price cap"] || 0) === capBefore + 1, `a listed route over the price cap takes no grant and is paid as today (status ${r5a.status}, settles +${settles - s5})`);
  const r5b = await payCall(B, "base64", wallet(0xe2), { ip: "10.5.0.2" });
  ok(r5b.status === 200 && !granted(r5b) && settles === s5 + expect5 + 1, `a route not listed settles normally (status ${r5b.status})`);
  // r5b booked a sale for 0xe2: its first hash call is not new.
  for (let i = 0; i < 20; i++) { const n = (await opJson(B, "/__operator/sales.json")).totals?.byRail?.["external:usdc"] ?? 0; if (n >= salesBase + (settles - settlesBase)) break; await sleep(100); }
  const r5c = await payCall(B, "hash", wallet(0xe2), { ip: "10.5.0.3" });
  ok(r5c.status === 200 && !granted(r5c) && settles === s5 + expect5 + 2 && (await denied())["paid before"] === 1, `a wallet with a prior paid sale gets no grant (status ${r5c.status})`);
  const ours = [...OUR_EVM_WALLETS][0];
  const r5d = await payCall(B, "hash", ours, { ip: "10.5.0.4" });
  ok(r5d.status === 200 && !granted(r5d) && settles === s5 + expect5 + 3 && (await denied())["own wallet"] === 1, `our own wallet gets no grant (status ${r5d.status})`);
  const r5e = await payCall(B, "hash", POOR, { ip: "10.5.0.5" });
  ok(r5e.status === 200 && !granted(r5e) && settles === s5 + expect5 + 4 && (await denied())["balance"] === 1, `a wallet whose balance is below the price gets no grant (status ${r5e.status})`);

  // 5b. A call asking for a share link takes no grant: the link would be
  // written only on a settled 200. It settles normally.
  for (const [route, ip, n] of [["hashShare", "10.5.1.1", 1], ["hashShareQ", "10.5.1.2", 2]]) {
    const sS = settles;
    const r = await payCall(B, route, wallet(0xe5 + n), { ip });
    ok(r.status === 200 && !granted(r) && settles === sS + 1 && !!r.headers.get("payment-response") && (await denied())["share"] === n, `share asked (${route}) takes no grant and settles normally (status ${r.status}, settles +${settles - sS})`);
  }

  // 5c. A granted call whose client leaves before its handler starts: given
  // back, not settled, nothing owed.
  {
    const before5 = (await opJson(B, "/__operator/refunds.json")).firstCallAllowance?.processToday || {};
    const sH = settles;
    const rt = ROUTES.hash;
    const accept = await acceptFor(B, rt.path, rt.method, rt.body);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 200);
    await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", "payment-signature": credential(accept, SLOW), "x-forwarded-for": "10.5.2.1" }, body: rt.body, signal: ac.signal }).then((x) => x.text()).catch(() => null);
    clearTimeout(t);
    let served = false;
    for (let i = 0; i < 40 && !served; i++) { served = Bt.log.some((l) => /\[hangup\] (NOT CHARGED|CHARGED-BUT-NOT-SERVED)/.test(l)); if (!served) await sleep(100); }
    const st5 = await opJson(B, "/__operator/refunds.json");
    ok(served && settles === sH, `a granted call whose client left before its handler was not settled (hang-up recorded ${served}, settles +${settles - sH})`);
    ok(!Bt.log.some((l) => l.includes("CHARGED-BUT-NOT-SERVED")) && (st5.refunds || []).length === 0 && st5.totals?.owed?.n === 0, `and no debt is booked for it (owed ${st5.totals?.owed?.n})`);
    const p5 = st5.firstCallAllowance?.processToday || {};
    ok(p5.released === (before5.released || 0) + 1 && p5.served === (before5.served || 0), `its grant was given back, not kept (${JSON.stringify(p5)})`);
  }

  // 6. Per-address cap: a second new wallet from a granted address settles.
  const s6 = settles;
  const r6a = await payCall(B, "hash", wallet(0xf1), { ip: "10.6.0.1" });
  ok(r6a.status === 200 && granted(r6a) && settles === s6, "a new wallet from a new address is granted");
  grants++; grantUsd += 0.001;
  const r6b = await payCall(B, "hash", wallet(0xf2), { ip: "10.6.0.1" });
  ok(r6b.status === 200 && !granted(r6b) && settles === s6 + 1 && (await denied())["address cap"] === 1, `a second new wallet from the same address settles normally (status ${r6b.status})`);

  // 7. Daily USD cap: the next grant spends it; the new wallet after it settles.
  const r7a = await payCall(B, "hash", wallet(0xf3), { ip: "10.7.0.1" });
  ok(r7a.status === 200 && granted(r7a), "the grant that reaches the daily cap is served");
  grants++; grantUsd += 0.001;
  const s7 = settles;
  const r7b = await payCall(B, "hash", wallet(0xf4), { ip: "10.7.0.2" });
  ok(r7b.status === 200 && !granted(r7b) && settles === s7 + 1 && (await denied())["daily cap"] === 1, `past the daily cap a new wallet settles normally (status ${r7b.status})`);
  const gs = await (await fetch(`${B}/api/gateway-status`)).json();
  ok(gs.firstCallAllowance?.status === "spent" && Object.keys(gs.firstCallAllowance).length === 1, `/api/gateway-status says "spent" and nothing else (${JSON.stringify(gs.firstCallAllowance)})`);

  // 8. Nothing booked for a grant.
  let st = null;
  for (let i = 0; i < 20; i++) { st = await opJson(B, "/__operator/refunds.json"); if (st.firstCallAllowance?.processToday?.served === grants) break; await sleep(100); }
  const fca = st.firstCallAllowance;
  ok(fca?.enabled === true && fca?.today?.grants === grants && Math.abs(fca?.today?.usd - grantUsd) < 1e-9 && fca?.dailyCapUsd === 0.01,
    `the operator view counts ${grants} grants at list price (${JSON.stringify(fca?.today)})`);
  ok((st.refunds || []).length === 0 && ["owed", "paid", "void", "sending"].every((k) => st.totals?.[k]?.n === 0), `no refund row anywhere (${JSON.stringify(st.totals)})`);
  const settledHere = settles - settlesBase;
  let sales = -1;
  for (let i = 0; i < 30; i++) { sales = ((await opJson(B, "/__operator/sales.json")).totals?.byRail?.["external:usdc"] ?? 0) - salesBase; if (sales >= settledHere - 1) break; await sleep(100); }
  // Our own wallet's settle books on the internal side; every other settle is one external sale.
  ok(sales === settledHere - 1, `one sale per settle and none for a grant (external usdc sales ${sales}, settles ${settledHere} incl. one own-wallet)`);
  const failedSettle = Bt.log.filter((l) => /SETTLE failed|settle REJECTED|CHARGED-BUT-NOT-SERVED/.test(l) && !/nonce already used/.test(l));
  ok(failedSettle.length === 0, `no settle failure or charged-but-not-served line (${failedSettle.slice(0, 2).join(" | ")})`);
  ok(Bt.log.some((l) => l.includes("[allowance] first-call grant served on hash")), "the server logs each grant without naming the wallet");
  ok(!Bt.log.some((l) => l.includes("[allowance]") && /0x[0-9a-f]{40}/i.test(l)), "no allowance log line names a wallet");
  // The grant keys are on the shared store.
  const wkey = await redis.get(`sl:${PREFIX}:fca-w:${wA}`);
  ok(typeof wkey === "string" && wkey.startsWith("granted:"), `the wallet's grant is persisted on the shared store (${wkey})`);
  if (PG_URL) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    try {
      const rows = (await c.query(`SELECT id FROM ${PG_SCHEMA}.records WHERE collection = 'first-call-allowance'`)).rows.map((r) => r.id).sort();
      ok(rows.length === grants && rows.includes(wA) && !rows.includes(wallet(0xf4)), `with the state database, each served grant is a record (${rows.length} of ${grants})`);
    } finally { await c.end().catch(() => {}); }
  } else console.log("skip - state database records (no STATE_DATABASE_URL)");
  Bt.proc.kill("SIGKILL"); Bt = null;

  // ---------------- Boot C: a slow handler, no forgiveness ticket ----------------
  // A preload wraps the web answer stub with a delay, so a client can leave
  // while the handler runs (after the claim, before the answer).
  // The preload marks a file when the handler reaches the upstream, so the
  // client leaves once the handler is running, however long the gates took.
  const preDir = mkdtempSync(join(tmpdir(), "fca-preload-"));
  const pre = join(preDir, "slow-answer.mjs");
  const handlerMark = join(preDir, "handler-started");
  writeFileSync(pre, `import ${JSON.stringify(join(ROOT, "scripts", "lib", "brave-answer-stub-preload.js"))};
import { writeFileSync as markFile } from "node:fs";
const stubbed = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (url.startsWith("https://api.search.brave.com/res/v1/chat/completions")) {
    markFile(${JSON.stringify(handlerMark)}, "1");
    await new Promise((r) => setTimeout(r, 800));
  }
  return stubbed(input, init);
};
`);
  C = await boot({
    FIRST_CALL_ALLOWANCE: "on", FIRST_CALL_ALLOWANCE_SLUGS: "answer", FIRST_CALL_ALLOWANCE_MAX_USD: "0.1",
    FIRST_CALL_ALLOWANCE_DAILY_USD: "1", FIRST_CALL_ALLOWANCE_IP_PER_DAY: "100",
    HANGUP_FORGIVE: "off", BRAVE_API_KEY: "stub-never-sent", BRAVE_ANSWERS_API_KEY: "",
    ANSWER_SHARE: "on", ANSWER_SHARE_DIR: mkdtempSync(join(tmpdir(), "fca-share-")),
  }, { preload: pre });
  {
    const path = "/api/answer?q=what%20is%20x402";
    const accept = await acceptFor(C.B, path, "GET");
    const sC = settles;
    const ac = new AbortController();
    const call = fetch(`${C.B}${path}`, { headers: { "payment-signature": credential(accept, wallet(0x71)), "x-forwarded-for": "10.9.1.1" }, signal: ac.signal }).then((x) => x.text()).catch(() => null);
    let started = false;
    for (let i = 0; i < 200 && !started; i++) { started = existsSync(handlerMark); if (!started) await sleep(25); }
    ok(started, "the slow handler reached its upstream (the client leaves only after that)");
    ac.abort();
    await call;
    let st = null;
    for (let i = 0; i < 40; i++) { st = await opJson(C.B, "/__operator/refunds.json"); if (st.firstCallAllowance?.processToday?.served >= 1 || st.firstCallAllowance?.processToday?.released >= 1) break; await sleep(100); }
    await sleep(200);
    st = await opJson(C.B, "/__operator/refunds.json");
    const pc = st.firstCallAllowance?.processToday || {};
    ok(pc.served === 1 && pc.released === 0 && settles === sC, `a granted call whose client left during the handler is served unsettled (${JSON.stringify(pc)}, settles +${settles - sC})`);
    ok(C.log.some((l) => /\[hangup\] NOT CHARGED/.test(l)) && !C.log.some((l) => l.includes("CHARGED-BUT-NOT-SERVED")), "the hang-up is recorded as not charged");
    ok((st.refunds || []).length === 0 && st.totals?.owed?.n === 0, `and no debt is booked for it (owed ${st.totals?.owed?.n})`);

    // share=true: no grant, a normal settle, and the link it hands out is written.
    const sharePath = "/api/answer?q=what%20is%20x402&share=true";
    const sS = settles;
    const r = await fetch(`${C.B}${sharePath}`, { headers: { "payment-signature": credential(await acceptFor(C.B, sharePath, "GET"), wallet(0x72)), "x-forwarded-for": "10.9.1.2" } });
    const j = await r.json().catch(() => null);
    ok(r.status === 200 && r.headers.get("x-agent402-allowance") !== "first-call" && settles === sS + 1 && !j?.firstCallAllowance, `a share=true call takes no grant and settles (status ${r.status}, settles +${settles - sS})`);
    let page = null;
    const link = j?.share?.url ? j.share.url.replace(/^https?:\/\/[^/]+/, C.B) : null;
    for (let i = 0; i < 20 && link; i++) { page = await fetch(link); if (page.status === 200) break; await sleep(100); }
    ok(Boolean(link) && page?.status === 200, `and the share link it hands out is written (${page?.status})`);
  }
} catch (e) {
  failed++;
  console.error("FAIL -", e?.stack || e);
} finally {
  if (failed) for (const l of (C || Bt || A)?.log?.slice(-40) || []) console.error("  server:", l);
  A?.proc.kill("SIGKILL");
  C?.proc.kill("SIGKILL");
  Bt?.proc.kill("SIGKILL");
  facilitator.close();
  try { const keys = await redis.keys(`*${PREFIX}*`); if (keys.length) await redis.del(keys); } catch { /* best effort */ }
  if (PG_URL) {
    try { const { default: pg } = await import("pg"); const c = new pg.Client({ connectionString: PG_URL }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`); await c.end(); } catch { /* best effort */ }
  }
  await redis.quit().catch(() => {});
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
