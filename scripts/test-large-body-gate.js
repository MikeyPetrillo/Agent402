#!/usr/bin/env node
// The large-body routes (image edits, vision/locate/long judging, frame
// checks, transcriptions) read no compressed body, read no unpaid body over
// 100 KB whose price does not depend on it, bound the unpaid bodies they do
// read per client, and hold every parse to one in-flight byte budget
// (src/large-body-gate.js). A paid call with a large body still reaches its
// handler.
//
//   node scripts/test-large-body-gate.js   (unit checks, then a paid-mode boot
//                                           on port 0 against a stub facilitator)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLargeBodyGate, unlessBodyUnread, UNPAID_BODY_MAX_BYTES } from "../src/large-body-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- unit ------------------------------------------------------------------
{
  const fakeRes = () => {
    const r = new EventEmitter();
    r.statusCode = 200; r.headers = {}; r.body = null;
    r.status = (c) => { r.statusCode = c; return r; };
    r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  const fakeReq = (headers, path = "/big") => ({ method: "POST", path, headers });
  const run = (gate, req) => { const res = fakeRes(); let nexted = false; gate(req, res, () => { nexted = true; }); return { res, nexted, req }; };
  let limited = false;
  const gate = createLargeBodyGate({
    routes: [["/big", 10_000_000], ["/quoted", 10_000_000]],
    isPaid: (req) => req.headers["x-paid"] === "1",
    bodyQuoted: (req) => req.path === "/quoted",
    unpaidLimiter: { check: () => ({ limited }) },
    maxInflightBytes: 5_000_000,
  });
  const big = String(UNPAID_BODY_MAX_BYTES + 1);
  let r = run(gate, fakeReq({ "content-encoding": "gzip", "content-length": "100" }));
  ok(!r.nexted && r.res.statusCode === 415, "a Content-Encoding is refused with a 415 before the body is read");
  r = run(gate, fakeReq({ "content-encoding": "identity", "content-length": "100", "x-paid": "1" }));
  ok(r.nexted, "Content-Encoding: identity passes");
  r = run(gate, fakeReq({ "content-length": big }));
  ok(r.nexted && r.req.__bodyUnread === true && JSON.stringify(r.req.body) === "{}", "an unpaid body over 100 KB on an unquoted route is left unread and served an empty input");
  r = run(gate, fakeReq({ "content-length": big, "x-paid": "1" }));
  ok(r.nexted && !r.req.__bodyUnread, "a paid body over 100 KB is read");
  r = run(gate, fakeReq({ "content-length": big }, "/quoted"));
  ok(r.nexted && !r.req.__bodyUnread, "an unpaid body over 100 KB on a route priced from its body is read (its 402 needs it)");
  limited = true;
  r = run(gate, fakeReq({ "content-length": big }, "/quoted"));
  ok(!r.nexted && r.res.statusCode === 429, "...through the per-client limiter");
  r = run(gate, fakeReq({ "content-length": "500" }, "/quoted"));
  ok(r.nexted, "a small unpaid body is not limited");
  limited = false;
  const base = gate.inFlightBytes();
  const a = run(gate, fakeReq({ "content-length": "3000000", "x-paid": "1" }));
  ok(a.nexted && gate.inFlightBytes() === base + 3_000_000, "a parse reserves its declared size");
  const b = run(gate, fakeReq({ "content-length": "3000000", "x-paid": "1" }));
  ok(!b.nexted && b.res.statusCode === 503 && b.res.headers["retry-after"] === "5", "a parse past the in-flight budget is refused 503 with Retry-After");
  a.res.emit("finish"); a.res.emit("close");
  ok(gate.inFlightBytes() === base, "the reservation is released once when the response ends");
  const c = run(gate, fakeReq({ "transfer-encoding": "chunked", "x-paid": "1" }));
  ok(!c.nexted && c.res.statusCode === 503, "a body with no declared length reserves the route's limit");
  r = run(gate, fakeReq({ "content-length": "20000000", "x-paid": "1" }));
  ok(r.nexted && gate.inFlightBytes() === base, "a body declared over the route limit is left to the parser's 413 and reserves nothing");
  r = run(gate, fakeReq({ "content-length": big }, "/BIG/"));
  ok(r.req.__bodyUnread === true, "the route match ignores case and a trailing slash, as routing does");
  const free = createLargeBodyGate({ routes: [["/big", 10_000_000]], isPaid: () => false, freeMode: true });
  r = run(free, fakeReq({ "content-length": big }));
  ok(r.nexted && !r.req.__bodyUnread, "FREE_MODE reads every body");
  let parsed = false;
  unlessBodyUnread(() => { parsed = true; })({ __bodyUnread: true }, {}, () => {});
  ok(!parsed, "a parser skips a body the gate left unread");
}

// --- the caller path: a paid-mode boot with a stub facilitator ---------------
const fac = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* not JSON */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(String(auth?.nonce)).digest("hex"), network: "eip155:8453", payer });
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => fac.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${fac.address().port}`;
const OP_TOKEN = "large-body-test-operator-token-0123456789";
const srv = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: "0", FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    UNPAID_QUOTE_BUDGET_PER_HOUR: "0", LARGE_BODY_INFLIGHT_MAX_MB: "4", AGENT402_OPERATOR_TOKEN: OP_TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => { log += d; });
srv.stderr.on("data", (d) => { log += d; });
try {
  let B = null;
  for (let i = 0; i < 180 && !B; i++) { const m = log.match(/listening on :(\d+)/); if (m) B = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
  if (!B) throw new Error(`server never came up:\n${log.slice(-600)}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }

  const post = async (path, body, headers = {}) => {
    const r = await fetch(B + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    const pr = r.headers.get("payment-required");
    const accept = pr ? (JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts || []).find((x) => x.network === "eip155:8453") : null;
    return { status: r.status, text, json, accept, headers: r.headers };
  };
  let nonceN = 0;
  const cred = (accept) => Buffer.from(JSON.stringify({ x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000a1", to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } } })).toString("base64");

  // 1. Compressed bodies are refused before they are read, paid or not.
  const gz = gzipSync(JSON.stringify({ prompt: "x", images: ["data:image/png;base64," + "A".repeat(4 * 1024 * 1024)] }));
  for (const path of ["/v1/images/edits", "/v1/judge/vision", "/api/html-frames", "/v1/audio/transcriptions"]) {
    const r = await post(path, gz, { "content-encoding": "gzip" });
    ok(r.status === 415, `${path}: a gzip body is refused 415 (got ${r.status})`);
  }

  // 2. An unpaid large image edit gets the same 402 as a small one, unread.
  const small = JSON.stringify({ prompt: "make it blue", images: ["data:image/png;base64,AAAA"] });
  // The paywall answers once the facilitator's supported kinds are loaded.
  for (let i = 0; i < 60 && (await post("/v1/images/edits", small)).status !== 402; i++) await sleep(500);
  const img = Buffer.alloc(1800 * 1024, 7).toString("base64");
  const big = JSON.stringify({ prompt: "make it blue", images: ["data:image/png;base64," + img] });
  const q1 = await post("/v1/images/edits", small);
  const q2 = await post("/v1/images/edits", big);
  ok(q1.status === 402 && q2.status === 402 && q1.accept && JSON.stringify(q1.accept) === JSON.stringify(q2.accept), `an unpaid large image edit gets the small body's 402 (${q1.status}/${q2.status})`);

  // 3. The paid retry with the large body reaches the handler (its answer, not a gate's).
  const paid = await post("/v1/images/edits", big, { "payment-signature": cred(q2.accept) });
  ok(paid.status !== 402 && paid.status !== 413 && paid.status !== 415 && paid.status !== 429 && paid.json?.error !== "busy" && (paid.json?.tool === "v1-images-edit" || paid.status === 200 || paid.status >= 500),
    `a paid large image edit reaches the handler (${paid.status} ${paid.text.slice(0, 120)})`);

  // 4. A paid transcription (multipart) reaches the handler.
  const Bd = "----a402bodygate";
  const mp = Buffer.concat([
    Buffer.from(`--${Bd}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
    Buffer.from(`--${Bd}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`), Buffer.alloc(300 * 1024, 1), Buffer.from(`\r\n--${Bd}--\r\n`),
  ]);
  const ct = `multipart/form-data; boundary=${Bd}`;
  const t1 = await post("/v1/audio/transcriptions", mp, { "content-type": ct });
  ok(t1.status === 402 && t1.accept, `an unpaid transcription upload is answered 402 (got ${t1.status})`);
  const t2 = await post("/v1/audio/transcriptions", mp, { "content-type": ct, "payment-signature": cred(t1.accept) });
  ok(t2.status !== 402 && t2.status !== 413 && t2.status !== 415 && t2.status !== 429 && t2.json?.error !== "busy",
    `a paid transcription reaches the handler (${t2.status} ${t2.text.slice(0, 120)})`);

  // 5. A route priced from its body still reads an unpaid large body for its 402.
  const html = "<!doctype html><script>window.renderAt=()=>{}</script>" + " ".repeat(200 * 1024);
  const f1 = await post("/api/html-frames", JSON.stringify({ html, times: [0] }));
  const f2 = await post("/api/html-frames", JSON.stringify({ html, times: [0], compare: { baselineUrl: "https://example.com/a" } }));
  ok(f1.status === 402 && f2.status === 402 && Number(f2.accept?.amount) === 2 * Number(f1.accept?.amount), `html-frames quotes a large unpaid body from what it says (${f1.accept?.amount} vs ${f2.accept?.amount})`);

  // 6. A paid body past the in-flight budget (4 MB on this boot) is refused 503, unread and uncharged.
  const huge = JSON.stringify({ prompt: "x", images: ["data:image/png;base64," + Buffer.alloc(3600 * 1024, 7).toString("base64")] });
  const over = await post("/v1/images/edits", huge, { "payment-signature": cred(q2.accept) });
  ok(over.status === 503 && over.json?.error === "busy" && over.headers.get("retry-after") === "5", `a paid body past the in-flight budget is a 503 with Retry-After (got ${over.status})`);

  // 7. The operator route checks the token before reading its body.
  const sv = await post("/__operator/seller-verification", JSON.stringify({ rows: "x".repeat(500 * 1024) }));
  ok(sv.status === 404, `seller-verification without the token is a 404, unread (got ${sv.status})`);
  const svGz = await post("/__operator/seller-verification", gzipSync("{}"), { "x-operator-token": OP_TOKEN, "content-encoding": "gzip" });
  ok(svGz.status === 415, `seller-verification takes no Content-Encoding (got ${svGz.status})`);
  ok(srv.exitCode === null, "the server is still up");
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  srv.kill("SIGKILL");
  fac.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
