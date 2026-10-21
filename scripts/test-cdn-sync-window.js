// Long requests through the CDN proxy (src/cdn-sync-window.js) and the cache
// policy for paid answers (src/paid-no-store.js), driven through the REAL paid
// server: a stub facilitator counts every verify and settle, and one stub
// upstream answers the premium image route (preloaded over api.openai.com) and
// the LLM gateway (preloaded over openrouter.ai) with a chosen delay, so a test
// boot can never spend.
//
// The bound is set low (CDN_SYNC_MAX_SECONDS=8) so the premium image route
// (run budget 75 s) counts as longer than the proxy waits. A CDN request is one
// whose edge-reported peer (the last X-Forwarded-For hop) is a CDN address.
//   - CDN + paid + no Prefer + a client that follows a 202 (agent402-client
//     0.8.16 or later): served as a job, settled once on the delivered result;
//   - CDN + paid + no Prefer + any other client: 504 before any gate, nothing
//     verified, settled or sent upstream;
//   - CDN + Prefer: respond-async: a job as before;
//   - direct (no CDN peer, even with a forged CF-Connecting-IP): synchronous
//     and settled exactly as before;
//   - the LLM gateway through the CDN ends a slow upstream wait inside the
//     bound with a 504 (not charged); reached directly the same call waits;
//   - every 402 carries Cache-Control: no-store, a paid answer
//     private, no-store, an operator answer private, no-store, and a public
//     free surface keeps its own header.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
import { followsJobAnswer, cdnSyncLeftMs, cdnSyncMaxSeconds, cdnSyncWindowMiddleware } from "../src/cdn-sync-window.js";
import express from "express";
import { requiredCacheControl, paidNoStoreMiddleware } from "../src/paid-no-store.js";
import { paymentWindowTimeoutMs } from "../src/tools/llm-gateway-kit.js";
import { cdnLinkTimeoutMs } from "../src/tools/llm-images-fast-kit.js";

let pass = 0, fail = 0, proc = null, facilitator = null, upstream = null;
const TMP = mkdtempSync(join(tmpdir(), "cdn-sync-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); } return cond(); };

// ---- unit ----
{
  const ua = (s) => ({ headers: { "user-agent": s } });
  ok(followsJobAnswer(ua("agent402-client/0.8.16")) && followsJobAnswer(ua("agent402-client/0.9.0")) && followsJobAnswer(ua("agent402-client/1.0.0")), "agent402-client 0.8.16 and later follow a 202");
  ok(!followsJobAnswer(ua("agent402-client/0.8.15")) && !followsJobAnswer(ua("curl/8.4.0")) && !followsJobAnswer(ua("")) && !followsJobAnswer(ua("not-agent402-client/9.9.9")) && !followsJobAnswer({ headers: {} }), "earlier SDKs and other clients do not");
  ok(cdnSyncMaxSeconds({}) === 90 && cdnSyncMaxSeconds({ CDN_SYNC_MAX_SECONDS: "60" }) === 60 && cdnSyncMaxSeconds({ CDN_SYNC_MAX_SECONDS: "junk" }) === 90, "CDN_SYNC_MAX_SECONDS defaults to 90");
  ok(cdnSyncLeftMs({}) === null && cdnSyncLeftMs(null) === null && cdnSyncLeftMs({ cdnSyncDeadlineMs: 5000 }, 1000) === 4000, "cdnSyncLeftMs is null off the CDN");

  // LLM attempt bound: off the CDN (and no EVM credential) the default stands.
  ok(paymentWindowTimeoutMs({ headers: {} }, 90_000) === 90_000, "LLM attempt timeout is unchanged off the CDN");
  const near = paymentWindowTimeoutMs({ headers: {}, cdnSyncDeadlineMs: Date.now() + 30_000 }, 90_000);
  ok(near > 20_000 && near <= 25_000, `LLM attempt timeout is capped under the CDN wait (${near} ms)`);
  let threw = null;
  const late = { headers: {}, cdnSyncDeadlineMs: Date.now() + 8_000 };
  paymentWindowTimeoutMs(late, 90_000);
  try { paymentWindowTimeoutMs(late, 90_000); } catch (e) { threw = e; }
  ok(threw?.statusCode === 504 && /connection waits/.test(threw.message) && /not charged/.test(threw.message), "a further LLM attempt that cannot finish in the CDN wait is a 504, not charged");

  // Image tiers: first link always starts, a fallback link only with time left.
  ok(cdnLinkTimeoutMs({}, 45_000, 1) === 45_000, "image link timeout unchanged off the CDN");
  const t1 = cdnLinkTimeoutMs({ cdnSyncDeadlineMs: Date.now() + 30_000 }, 45_000, 0);
  ok(t1 > 20_000 && t1 <= 25_000, `the first image link is capped under the CDN wait (${t1})`);
  ok(cdnLinkTimeoutMs({ cdnSyncDeadlineMs: Date.now() + 10_000 }, 45_000, 1) === null, "a fallback image link is not started without time to finish");

  // Cache policy.
  ok(requiredCacheControl({ status: 402, path: "/api/x", paidRequest: false, responseHeaders: { "cache-control": "public, max-age=60" } }) === "no-store", "a 402 is never cacheable, whatever the handler set");
  ok(requiredCacheControl({ status: 200, path: "/api/x", paidRequest: true, responseHeaders: {} }) === "private, no-store", "a paid answer is private, no-store");
  ok(requiredCacheControl({ status: 200, path: "/api/x", paidRequest: false, responseHeaders: { "payment-response": "abc" } }) === "private, no-store", "an answer carrying a receipt is private, no-store");
  ok(requiredCacheControl({ status: 200, path: "/api/x", paidRequest: true, responseHeaders: { "cache-control": "no-store" } }) === null, "an existing no-store is kept");
  ok(requiredCacheControl({ status: 200, path: "/__operator/x.json", paidRequest: false, responseHeaders: {} }) === "private, no-store", "an operator answer is private, no-store");
  ok(requiredCacheControl({ status: 200, path: "/api/pricing", paidRequest: false, responseHeaders: { "cache-control": "public, max-age=60" } }) === null, "a public free surface keeps its header");

  // The middleware over real HTTP: a handler that marks a 402 or a paid answer
  // public is overridden, the writeHead(status, headers) form included; a free
  // public answer keeps its header. (The booted server below already sends
  // no-store on these paths; this proves the backstop on its own.)
  {
    const app = express();
    app.use(paidNoStoreMiddleware());
    app.get("/q402", (_req, res) => res.status(402).set("Cache-Control", "public, max-age=600").json({}));
    app.get("/paid", (_req, res) => res.set("Cache-Control", "public, max-age=600").json({ ok: true }));
    app.get("/inline", (_req, res) => { res.writeHead(200, { "Cache-Control": "public, max-age=600", "Content-Type": "application/json" }); res.end("{}"); });
    app.get("/free", (_req, res) => res.set("Cache-Control", "public, max-age=600").json({}));
    app.get("/__operator/x.json", (_req, res) => res.json({}));
    const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const cc = async (p, h = {}) => (await fetch(`${base}${p}`, { headers: h })).headers.get("cache-control");
    ok(await cc("/q402") === "no-store", "middleware: a 402 marked public goes out no-store");
    ok(await cc("/paid", { "payment-signature": "x" }) === "private, no-store", "middleware: a paid answer marked public goes out private, no-store");
    ok(await cc("/inline", { authorization: "Payment abc" }) === "private, no-store", "middleware: the writeHead(status, headers) form is covered");
    ok(await cc("/free") === "public, max-age=600", "middleware: a free public answer keeps its header");
    ok(await cc("/__operator/x.json") === "private, no-store", "middleware: an operator answer is private, no-store");
    srv.close();
  }

  // The window middleware never touches a direct request.
  let nexted = false;
  cdnSyncWindowMiddleware({ asyncRouteOf: () => ({ slug: "s", asyncProfile: { maxSeconds: 999 } }), wantsAsync: () => false, carriesPaymentAttempt: () => true, maxSeconds: 1 })({ viaCdn: false, method: "POST", headers: {} }, {}, () => { nexted = true; });
  ok(nexted, "the window middleware passes a direct request through");
}

requireUpstreamCosts("test-cdn-sync-window");

// ---- booted server ----
const [PORT, FAC_PORT, UP_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const OP = "op-test-token-" + "z".repeat(24);

const fac = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const payer = p.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const up = { images: 0, chat: 0, imageDelayMs: 300, chatDelayMs: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
upstream = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    const send = (status, obj, delay) => setTimeout(() => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }, delay);
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      up.chat++;
      return send(200, { id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }, up.chatDelayMs);
    }
    if (req.method === "POST" && url.startsWith("/v1/images")) {
      up.images++;
      return send(200, { created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } }, up.imageDelayMs);
    }
    send(404, { error: { message: "not stubbed" } }, 0);
  });
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

const preload = join(TMP, "openai-stub.mjs");
writeFileSync(preload, `
const STUB = ${JSON.stringify(`http://127.0.0.1:${UP_PORT}`)};
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && url.startsWith("https://api.openai.com/")) return real.call(this, STUB + url.slice("https://api.openai.com".length), init);
  return real.call(this, input, init);
};
`);
proc = spawn(process.execPath, ["--import", "./scripts/lib/openrouter-stub-preload.js", "--import", preload, "src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "",
    OPENROUTER_STUB_URL: `http://127.0.0.1:${UP_PORT}`, OPENROUTER_FLEX: "off",
    CDN_SYNC_MAX_SECONDS: "8", CF_IP_RANGES_EXTRA: "", AGENT402_OPERATOR_TOKEN: OP,
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"), AGENT402_MCP_TASK_TTL_MS: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 150_000).unref();

const IMG = { path: "/api/image-gen-premium", body: JSON.stringify({ prompt: "a red fox in the snow" }) };
const CHAT = { path: "/v1/nano/chat/completions", body: JSON.stringify({ messages: [{ role: "user", content: "say ok" }], max_tokens: 16 }) };
const accepts = {};
let nonce = 0;
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const acceptFor = async (t) => {
  if (accepts[t.path]) return accepts[t.path];
  const r = await fetch(`${B}${t.path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.77.0.1" }, body: t.body });
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8"));
  accepts[t.path] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  return accepts[t.path];
};
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0xc000 + ++nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
// A CDN request: the edge-reported peer (last XFF hop) is a CDN address.
const CDN = (client) => ({ "x-forwarded-for": "104.16.0.9", "cf-connecting-ip": client });
const post = async (t, headers, payer) => fetch(`${B}${t.path}`, { method: "POST", headers: { "content-type": "application/json", ...headers, ...(payer ? { "payment-signature": credential(await acceptFor(t), payer) } : {}) }, body: t.body });

try {
  let up_ = false;
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) { up_ = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up_, "paid server booted with stub upstreams");

  // 402s: no-store, through the CDN or not.
  const r402 = await post(IMG, CDN("198.51.100.1"));
  ok(r402.status === 402 && r402.headers.get("cache-control") === "no-store", `a CDN 402 is no-store (${r402.status}, ${r402.headers.get("cache-control")})`);
  const r402d = await post(CHAT, { "x-forwarded-for": "10.77.0.2" });
  ok(r402d.status === 402 && r402d.headers.get("cache-control") === "no-store", `a direct /v1 402 is no-store (${r402d.headers.get("cache-control")})`);

  // 1. CDN + paid + no Prefer + a stock client: refused before any gate.
  {
    const v = fac.verify, s = fac.settle, u = up.images;
    const r = await post(IMG, { ...CDN("198.51.100.2"), "user-agent": "curl/8.4.0" }, wallet(1));
    const j = await r.json();
    ok(r.status === 504 && j.error === "sync_answer_too_slow_for_connection" && /Prefer: respond-async/.test(j.hint) && /Nothing was charged/.test(j.hint), `a CDN sync call to a long route from a stock client is a 504 naming the header (${r.status} ${j.error})`);
    ok(fac.verify === v && fac.settle === s && up.images === u, "and nothing was verified, settled or sent upstream");
    ok(r.headers.get("cache-control") === "no-store", "the refusal is no-store");
    const r15 = await post(IMG, { ...CDN("198.51.100.3"), "user-agent": "agent402-client/0.8.15" }, wallet(2));
    ok(r15.status === 504, `an SDK before 0.8.16 is refused the same way (${r15.status})`);
  }

  // 2. CDN + paid + no Prefer + an SDK that follows a 202: served as a job.
  {
    const s = fac.settle;
    const r = await post(IMG, { ...CDN("198.51.100.4"), "user-agent": "agent402-client/0.8.16" }, wallet(3));
    const j = await r.json();
    ok(r.status === 202 && /^\/api\/jobs\/[0-9a-f]{48}$/.test(r.headers.get("location") || "") && r.headers.get("preference-applied") === "respond-async", `a CDN call from agent402-client 0.8.16 is answered 202 with a job link (${r.status})`);
    ok(fac.settle === s, "nothing settles on the 202");
    await waitFor(async () => ["succeeded", "failed"].includes((await (await fetch(`${B}${j.statusUrl}`)).json()).state));
    const g = await (await fetch(`${B}${j.statusUrl}`)).json();
    ok(g.state === "succeeded" && g.result?.httpStatus === 200 && fac.settle === s + 1, `the job delivers the answer and settles exactly once (state ${g.state}, settles ${fac.settle - s})`);
  }

  // 3. CDN + Prefer from any client: a job, as before.
  {
    const r = await post(IMG, { ...CDN("198.51.100.5"), "user-agent": "curl/8.4.0", prefer: "respond-async" }, wallet(4));
    ok(r.status === 202, `a CDN call that asks for a job gets one (${r.status})`);
    const j = await r.json();
    await waitFor(async () => ["succeeded", "failed"].includes((await (await fetch(`${B}${j.statusUrl}`)).json()).state));
  }

  // 4. Direct, even with a forged CF-Connecting-IP: synchronous, as today.
  {
    const s = fac.settle;
    const r = await post(IMG, { "x-forwarded-for": "203.0.113.20", "cf-connecting-ip": "198.51.100.6", "user-agent": "curl/8.4.0" }, wallet(5));
    ok(r.status === 200 && fac.settle === s + 1, `a direct call (forged CF-Connecting-IP) is served synchronously and settled once (${r.status})`);
    ok(/no-store/.test(r.headers.get("cache-control") || "") && /private/.test(r.headers.get("cache-control") || ""), `a paid answer is private, no-store (${r.headers.get("cache-control")})`);
  }

  // 5. LLM gateway: a slow upstream through the CDN ends inside the bound.
  {
    up.chatDelayMs = 12_000;
    const s = fac.settle;
    const t0 = Date.now();
    const r = await post(CHAT, CDN("198.51.100.7"), wallet(6));
    const ms = Date.now() - t0;
    const body = await r.text();
    ok(r.status === 504 && ms < 9_000 && /connection waits/.test(body), `a slow /v1 call through the CDN ends with a 504 inside the bound (${r.status} after ${ms} ms)`);
    ok(fac.settle === s, "and is not charged");
    up.chatDelayMs = 9_500;
    const t1 = Date.now();
    const rd = await post(CHAT, { "x-forwarded-for": "203.0.113.21" }, wallet(7));
    const msd = Date.now() - t1;
    ok(rd.status === 200 && msd >= 9_000 && fac.settle === s + 1, `the same call reached directly waits for the answer (${rd.status} after ${msd} ms)`);
    up.chatDelayMs = 0;
  }

  // 6. Cache policy on other surfaces.
  {
    const op = await fetch(`${B}/__operator/followups.json`, { headers: { authorization: `Bearer ${OP}`, "x-forwarded-for": "10.77.0.9" } });
    ok(/no-store/.test(op.headers.get("cache-control") || ""), `an operator answer is no-store (${op.status}, ${op.headers.get("cache-control")})`);
    const pr = await fetch(`${B}/api/pricing`, { headers: { "x-forwarded-for": "10.77.0.10" } });
    const cc = pr.headers.get("cache-control") || "";
    ok(!/no-store/.test(cc), `a public free surface keeps its own header (${cc || "none"})`);
  }
} finally {
  proc?.kill("SIGKILL"); facilitator?.close(); upstream?.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) { for (const l of serverLog.slice(-25)) console.error("  server:", l); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
