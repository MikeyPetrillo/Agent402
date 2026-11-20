#!/usr/bin/env node
// Signed receipts on the paid paths beyond a one-piece answer
// (src/receipt-signing.js, src/credits.js, src/human-checkout.js):
//
//   1. A streamed answer, over real HTTP: a settled event stream ends with an
//      `: agent402-receipt <receipt>` comment line whose digest covers every
//      byte streamed before it, and which an event-stream parser skips (it
//      dispatches the same events as the stream without it, so a client that
//      parses every event's data as JSON never sees the receipt); a client
//      that sent `TE: trailers` also gets the receipt as
//      an HTTP trailer; a stream that is neither an event stream nor asked
//      for trailers, a non-200 and an unsettled stream carry none; a changed
//      byte fails the check; the client helpers agree with the server.
//   2. Credits: a final 200 is debited BEFORE its answer ends, the receipt
//      names rail credits, the key id (never the key) and the debit id the
//      key's history records; a 500 and a cache-served answer get none and
//      take nothing; with receipts off the debit stays on finish.
//   3. A card-bought report: the delivered record carries a receipt over the
//      checkout and the report's text, naming the payment intent and the
//      amount collected; a 100%-off session gets none; the report page and
//      the ready email show it, a public view never does.
//   4. A paid server with a key: a streamed chat answer on every wire ends
//      with a receipt comment that verifies end to end (client helper and POST
//      /api/receipts/verify) and adds no event to the stream; a credits key's
//      200 carries the header, its stream the comment; the conformance cells
//      read signed on credits and card checkout; a signed paid answer logs no
//      listener-leak warning. Without a key no stream carries the comment.
import "./lib/offline-stores.js";
import "./lib/file-mode.js";
import http from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { textNamesUrl } from "./lib/url-host.js";
import { loadReceiptKeys, verifyReceipt, receiptSignerMiddleware, splitSseReceipt, createCheckoutReceipt, requestDigest, RECEIPT_HEADER, RECEIPT_SSE_COMMENT, RECEIPT_VERIFY_PATH, RECEIPT_KEYS_PATH, SIGNED_RAILS, CHECKOUT_RECEIPT_PATH } from "../src/receipt-signing.js";
import { verifyStreamedReceipt, splitStreamedReceipt, verifyReceipt as clientVerify, RECEIPT_SSE_COMMENT as CLIENT_SSE_COMMENT } from "../client/receipt.js";
import { createCredits, hashKey } from "../src/credits.js";
import { createHumanCheckout } from "../src/human-checkout.js";
import { buildReportReadyEmail } from "../src/email.js";
import { reportDoneHtml } from "../src/report-prerender.js";
import { CONFORMANCE_PATH } from "../src/conformance.js";
import { withSignedReceipt, MCP_SIGNED_RECEIPT_META } from "../src/mcp-http.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const pemB64 = (keyObject) => Buffer.from(keyObject.export({ format: "pem", type: "pkcs8" })).toString("base64");
const A = generateKeyPairSync("ed25519");
const ENV_A = { RECEIPT_SIGNING_KEY: pemB64(A.privateKey), RECEIPT_SIGNING_KEY_ID: "r1-stream" };
const { signer, keys } = loadReceiptKeys(ENV_A);
const SETTLED = { rail: "x402", network: "eip155:8453", payer: null, settlement: "0x" + "ab".repeat(32), priceUsd: 0.003, slug: "chat", replay: false };

// One request over a real socket: status, head, body bytes and trailers.
const call = (port, path, { te = false, body = "{}", headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...(te ? { te: "trailers" } : {}), ...headers } }, (res) => {
    const parts = [];
    res.on("data", (c) => parts.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, trailers: res.trailers, body: Buffer.concat(parts) }));
  });
  r.on("error", reject);
  r.end(body);
});
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });

// The events a conforming event-stream parser dispatches (WHATWG HTML,
// "Interpreting an event stream"): a line that starts with ":" is a comment
// and dispatches nothing; `data:` lines build an event that a blank line
// dispatches; an event still open when the stream ends is dropped. A client
// that JSON-parses every event's data (the AI SDK's OpenAI-compatible
// provider) reads exactly these.
const sseEvents = (bytes) => {
  const lines = Buffer.from(bytes).toString("utf8").split(/\r\n|\r|\n/);
  lines.pop(); // the bytes after the last line end: an unfinished line
  const out = [];
  let data = null, event = "";
  for (const line of lines) {
    if (line === "") { if (data) out.push({ event: event || "message", data: data.join("\n") }); data = null; event = ""; continue; }
    if (line.startsWith(":")) continue;
    const at = line.indexOf(":");
    const field = at < 0 ? line : line.slice(0, at);
    let value = at < 0 ? "" : line.slice(at + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") (data ||= []).push(value);
    else if (field === "event") event = value;
  }
  return out;
};
const strictJson = (events) => events.every((e) => e.data === "[DONE]" || (() => { try { JSON.parse(e.data); return true; } catch { return false; } })());

// ---- 1. streamed answers over real HTTP ----
{
  let describe = () => SETTLED;
  const app = express();
  app.use(express.json());
  app.use(receiptSignerMiddleware({ describe: (q, s) => describe(q, s), signer: () => signer, onError: (e) => { throw e; } }));
  const FRAMES = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo ✓"}}]}\n\n', "data: [DONE]\n\n"];
  app.post("/sse", (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" }); for (const f of FRAMES) res.write(f); res.end(); });
  // The last frame written by end(chunk), and a stream that stops mid-line.
  app.post("/sse-end-chunk", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write(FRAMES[0]); res.end(Buffer.from(FRAMES[2])); });
  app.post("/sse-open-line", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write("data: partial"); res.end(); });
  app.post("/ndjson", (_req, res) => { res.setHeader("Content-Type", "application/x-ndjson"); res.write('{"a":1}\n'); res.end('{"b":2}\n'); });
  app.post("/sse-500", (_req, res) => { res.writeHead(500, { "Content-Type": "text/event-stream" }); res.write(FRAMES[0]); res.end(); });
  app.post("/json", (_req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  const port = srv.address().port;
  try {
    const want = Buffer.from(FRAMES.join(""), "utf8");
    const r = await call(port, "/sse");
    const sp = splitSseReceipt(r.body);
    await ok(r.status === 200 && !r.headers[RECEIPT_HEADER.toLowerCase()] && sp.receipt && sp.body.equals(want), "a settled event stream ends with the receipt after the streamed bytes, which arrive unchanged");
    await ok(r.body.toString("utf8").endsWith(`\n: ${RECEIPT_SSE_COMMENT} ${sp.receipt}\n`) && RECEIPT_SSE_COMMENT === "agent402-receipt" && CLIENT_SSE_COMMENT === RECEIPT_SSE_COMMENT, "the receipt rides as an SSE comment line, `: agent402-receipt <receipt>`, the same tag in the server and the client");
    await ok(JSON.stringify(sseEvents(r.body)) === JSON.stringify(sseEvents(want)) && sseEvents(r.body).length === 3 && strictJson(sseEvents(r.body)), `an event-stream parser dispatches the same events with the receipt as without it, each JSON or [DONE] (${sseEvents(r.body).map((e) => e.event).join(", ")})`);
    const v = verifyReceipt(sp.receipt, { keys, responseBody: sp.body, request: { method: "POST", path: "/sse", body: {} } });
    await ok(v.valid && v.checks.response && v.checks.request && v.record.rail === "x402" && v.record.settlement === SETTLED.settlement, `the receipt verifies against the bytes streamed before it and the request sent (${v.reason})`);
    const cv = await verifyStreamedReceipt(r.body, { keys, request: { method: "POST", path: "/sse", body: {} } });
    const cs = splitStreamedReceipt(r.body);
    await ok(cv.valid && cs.receipt === sp.receipt && Buffer.from(cs.body).equals(sp.body), "the client's verifyStreamedReceipt and splitStreamedReceipt agree");
    // Tamper: one streamed byte changed, a frame dropped, a forged receipt line.
    const flipped = Buffer.from(r.body); flipped[10] ^= 1;
    await ok((await verifyStreamedReceipt(flipped, { keys })).reason === "response_mismatch", "a changed streamed byte fails the check");
    const dropped = Buffer.concat([Buffer.from(FRAMES[0] + FRAMES[2]), r.body.subarray(want.length)]);
    await ok((await verifyStreamedReceipt(dropped, { keys })).reason === "response_mismatch", "a dropped frame fails the check");
    await ok((await verifyStreamedReceipt(want, { keys })).reason === "no_stream_receipt", "a stream with no receipt line reads no_stream_receipt");
    const forged = Buffer.concat([want, Buffer.from(`\n: ${RECEIPT_SSE_COMMENT} ${sp.receipt.slice(0, -4)}AAAA\n`)]);
    await ok(!(await verifyStreamedReceipt(forged, { keys })).valid, "a changed signature in the receipt line fails");
    const notLast = Buffer.concat([r.body, Buffer.from("data: {}\n\n")]);
    await ok(!splitSseReceipt(notLast).receipt && !splitStreamedReceipt(notLast).receipt, "a receipt line that is not the stream's last line is not read as its receipt");

    const rt = await call(port, "/sse", { te: true });
    const tsp = splitSseReceipt(rt.body);
    const tr = rt.trailers[RECEIPT_HEADER.toLowerCase()];
    await ok(rt.headers.trailer === RECEIPT_HEADER && rt.headers["transfer-encoding"] === "chunked" && tr && tsp.receipt === tr, "with TE: trailers the stream declares the trailer and sends the same receipt as the trailer and the receipt line");
    await ok(verifyReceipt(tr, { keys, responseBody: tsp.body }).valid, "the trailer receipt verifies against the streamed bytes");

    const ec = await call(port, "/sse-end-chunk");
    const esp = splitSseReceipt(ec.body);
    await ok(esp.receipt && esp.body.equals(Buffer.from(FRAMES[0] + FRAMES[2])) && verifyReceipt(esp.receipt, { keys, responseBody: esp.body }).valid, "a last frame written by end() is digested and precedes the receipt line");
    const ol = await call(port, "/sse-open-line");
    const osp = splitSseReceipt(ol.body);
    await ok(osp.receipt && osp.body.toString() === "data: partial" && verifyReceipt(osp.receipt, { keys, responseBody: osp.body }).valid, "a stream that stops mid-line: the receipt line's leading newline ends that line and is not digested");
    await ok(sseEvents(ol.body).length === 0, `...and the receipt completes no event the stream left open (${JSON.stringify(sseEvents(ol.body))})`);

    const nd = await call(port, "/ndjson");
    await ok(nd.status === 200 && !nd.headers.trailer && !nd.trailers[RECEIPT_HEADER.toLowerCase()] && nd.body.toString() === '{"a":1}\n{"b":2}\n', "a stream that is not an event stream and did not ask for trailers: untouched, no receipt");
    const ndt = await call(port, "/ndjson", { te: true });
    const ndr = ndt.trailers[RECEIPT_HEADER.toLowerCase()];
    await ok(ndt.body.toString() === '{"a":1}\n{"b":2}\n' && ndr && verifyReceipt(ndr, { keys, responseBody: ndt.body }).valid, "the same stream with TE: trailers: the body untouched, the receipt as a trailer that verifies");

    const e5 = await call(port, "/sse-500", { te: true });
    await ok(e5.status === 500 && !splitSseReceipt(e5.body).receipt && !e5.trailers[RECEIPT_HEADER.toLowerCase()] && !e5.headers.trailer, "a 500 stream carries no receipt and declares no trailer");
    describe = () => null;
    const un = await call(port, "/sse", { te: true });
    await ok(un.status === 200 && !splitSseReceipt(un.body).receipt && !un.trailers[RECEIPT_HEADER.toLowerCase()] && un.body.equals(want), "an unsettled stream carries no receipt and its bytes are unchanged");
    describe = () => ({ ...SETTLED, rail: "card-checkout" });
    await ok(!splitSseReceipt((await call(port, "/sse")).body).receipt, "a rail the response signer does not sign (card checkout signs at delivery) gets none");
    describe = () => SETTLED;
    const one = await call(port, "/json", { te: true });
    await ok(!!one.headers[RECEIPT_HEADER.toLowerCase()] && !one.headers.trailer && verifyReceipt(one.headers[RECEIPT_HEADER.toLowerCase()], { keys, responseBody: one.body }).valid, "a one-piece answer keeps the header and declares no trailer");
  } finally { srv.close(); }
  await ok(SIGNED_RAILS.join() === "x402,gateway-batched,mpp-evm,mpp-tempo,mpp-stripe,credits,card-checkout,card-subscription,mpp-subscription", "the signed rails include credits and card checkout");
}

// ---- 1b. the MCP connector's relay ----
{
  const out = { content: [{ type: "text", text: "{}" }] };
  const hdr = (v) => ({ get: (k) => (String(k).toLowerCase() === "agent402-receipt" ? v : null) });
  await ok(withSignedReceipt(out, { status: 200, headers: hdr("a.b.c") })._meta?.[MCP_SIGNED_RECEIPT_META] === "a.b.c", "the connector relays a 200's receipt in _meta");
  await ok(withSignedReceipt(out, { status: 402, headers: hdr("a.b.c") }) === out && withSignedReceipt({ ...out, isError: true }, { status: 200, headers: hdr("a.b.c") })._meta === undefined, "a refusal or an error result carries none");
  const broken = { status: 200, headers: { get: () => { throw new Error("header store broke"); } } };
  await ok(withSignedReceipt(out, broken) === out, "a header store that throws leaves the result as it was (the relay never throws)");
}

// ---- 2. credits: the debit lands before the answer ends ----
{
  const dir = mkdtempSync(join(tmpdir(), "a402-receipt-credits-"));
  const debits = [];
  const cr = createCredits({ stripe: {}, baseUrl: "https://agent402.tools", storeDir: dir, onDebit: (d) => debits.push(d), onLoad: () => {}, log: () => {} });
  const KEY = `a402_${randomBytes(16).toString("hex")}`;
  writeFileSync(join(dir, `k_${hashKey(KEY)}.json`), JSON.stringify({ keyId: "kid_receipts", balanceMicro: 1_000_000, loadedMicro: 1_000_000, spentMicro: 0, calls: 0, createdAt: new Date().toISOString(), pack: "credits-20", sessions: [], paymentIntents: [], lastUsedAt: null }));
  let on = true;
  let seenAtEnd = null;
  const describe = (req) => {
    seenAtEnd = { debitId: req.creditsDebitId ?? null, balance: null };
    if (!req.creditsSettled || typeof req.creditsDebitId !== "string") return null;
    return { rail: "credits", network: null, payer: req.creditsKeyId, settlement: req.creditsDebitId, priceUsd: req.creditsCharged, slug: "hash", replay: false };
  };
  const app = express();
  app.use(express.json());
  app.use(receiptSignerMiddleware({ describe, signer: () => signer, onError: (e) => { throw e; } }));
  app.use(cr.gate(() => ({ priceUsd: 0.01, slug: "hash" }), { settleBeforeEnd: () => on }));
  app.post("/hash", (_req, res) => res.json({ sha256: "x" }));
  app.post("/boom", (_req, res) => res.status(500).json({ error: "x" }));
  app.post("/stream", (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: 1\n\n"); res.end("data: [DONE]\n\n"); });
  const srv = await listen(app);
  const port = srv.address().port;
  const auth = { authorization: `Bearer ${KEY}` };
  const bal = () => cr.balance(KEY);
  const hist = () => JSON.parse(readFileSync(join(dir, `k_${hashKey(KEY)}.json`), "utf8")).history || [];
  try {
    const r = await call(port, "/hash", { headers: auth });
    const jws = r.headers[RECEIPT_HEADER.toLowerCase()];
    const v = verifyReceipt(jws || "", { keys, responseBody: r.body });
    const debit = hist().filter((e) => e.k === "charge").at(-1);
    await ok(r.status === 200 && v.valid && v.record.rail === "credits" && v.record.payer === "kid_receipts" && v.record.priceUsd === "0.01", `a credits 200 carries a receipt: rail credits, the key id as payer, the amount debited (${v.reason}, ${v.record?.payer}, ${v.record?.priceUsd})`);
    await ok(/^cd_[A-Za-z0-9_-]{16}$/.test(v.record.settlement) && debit?.d === v.record.settlement && seenAtEnd.debitId === v.record.settlement, `the settlement is the debit id the key's history records (${v.record.settlement})`);
    await ok(!JSON.stringify(v.record).includes(KEY.slice(5)) && !JSON.stringify(v.record).includes(hashKey(KEY).slice(0, 12)), "the receipt carries neither the key nor its hash");
    await ok(bal().balanceUsd === 0.99 && bal().heldUsd === 0 && debits.length === 1, "the debit landed once and nothing is held");
    await new Promise((res) => setTimeout(res, 50));
    await ok(debits.length === 1 && bal().balanceUsd === 0.99, "the finish that follows takes nothing more");

    const s = await call(port, "/stream", { headers: auth });
    const sv = await verifyStreamedReceipt(s.body, { keys });
    await ok(s.status === 200 && sv.valid && sv.record.rail === "credits" && hist().filter((e) => e.k === "charge").at(-1)?.d === sv.record.settlement && bal().balanceUsd === 0.98, `a credits stream ends with a receipt line naming its debit (${sv.reason})`);

    const b = await call(port, "/boom", { headers: auth });
    await new Promise((res) => setTimeout(res, 50));
    await ok(b.status === 500 && !b.headers[RECEIPT_HEADER.toLowerCase()] && bal().balanceUsd === 0.98 && bal().heldUsd === 0 && debits.length === 2, "a 500 carries no receipt, takes nothing and releases the hold");

    on = false;
    const off = await call(port, "/hash", { headers: auth });
    await new Promise((res) => setTimeout(res, 50));
    await ok(off.status === 200 && !off.headers[RECEIPT_HEADER.toLowerCase()] && bal().balanceUsd === 0.97 && debits.length === 3 && seenAtEnd.debitId === null, "with receipts off: no receipt, the debit lands on finish as before");
  } finally { srv.close(); }
}

// ---- 3. a card-bought report ----
{
  const root = mkdtempSync(join(tmpdir(), "a402-receipt-card-"));
  const dir = join(root, "human-checkout");
  mkdirSync(dir, { recursive: true });
  const sessions = {
    cs_receipt_paid: { id: "cs_receipt_paid", payment_status: "paid", payment_intent: "pi_receipt_1", amount_total: 150, metadata: { product: "dossier", input: "AAPL" } },
    // A 100%-off code: nothing collected (a payment intent is named here so
    // the paid-status rule, not a missing intent, is what withholds it).
    cs_receipt_free: { id: "cs_receipt_free", payment_status: "no_payment_required", payment_intent: "pi_receipt_free", amount_total: 0, metadata: { product: "dossier", input: "MSFT" } },
  };
  const stripe = { checkout: { sessions: { retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; } } }, refunds: { create: async () => ({ id: "re_1" }) } };
  const generate = async (_kind, slug, input) => ({ report: `# REPORT (${slug})\n\nAnalysis of ${input}. [1]`, title: `T:${input}`, sources: [], tables: [] });
  const hc = createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: dir, onSale: () => {}, signDelivery: (d) => createCheckoutReceipt({ iss: "https://agent402.tools", ...d }, signer), log: () => {} });
  const done = async (id) => { for (let i = 0; i < 100; i++) { const r = await hc.fulfill(id); if (r.status !== "generating") return r; await new Promise((res) => setTimeout(res, 10)); } return hc.fulfill(id); };
  const rec = await done("cs_receipt_paid");
  const v = verifyReceipt(rec.receipt || "", { keys, responseBody: rec.report, request: { method: "POST", path: CHECKOUT_RECEIPT_PATH, body: { product: "dossier", input: "AAPL" } } });
  await ok(rec.status === "done" && v.valid && v.checks.response && v.checks.request, `a delivered card report carries a receipt over the checkout and the report's text (${v.reason})`);
  await ok(v.record.rail === "card-checkout" && v.record.settlement === "pi_receipt_1" && v.record.priceUsd === "1.5" && v.record.slug === "dossier" && v.record.payer === null && v.record.iat === rec.at, `it names rail card-checkout, the payment intent, the amount collected and the delivery time (${v.record.priceUsd}, ${v.record.settlement})`);
  await ok(verifyReceipt(rec.receipt, { keys, responseBody: rec.report + " " }).reason === "response_mismatch", "a changed report text fails the check");
  await ok(createCheckoutReceipt({ product: "dossier", input: "AAPL", reportText: "x", priceUsd: 1, paymentIntent: "pi_x", deliveredAt: rec.at }, signer) === createCheckoutReceipt({ product: "dossier", input: "AAPL", reportText: "x", priceUsd: 1, paymentIntent: "pi_x", deliveredAt: rec.at }, signer), "the same purchase signs to the same receipt (re-shown, never re-issued)");
  await ok(createCheckoutReceipt({ product: "dossier", input: "AAPL", reportText: "x", priceUsd: 1, paymentIntent: null }, signer) === null && createCheckoutReceipt({ product: "dossier", input: "AAPL", reportText: "x", priceUsd: 1, paymentIntent: "pi_x" }, null) === null, "no payment intent, or signing off: no receipt");
  const free = await done("cs_receipt_free");
  await ok(free.status === "done" && !("receipt" in free), "a 100%-off session (nothing paid) gets no receipt");
  const stored = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("cs_receipt_paid"))), "utf8"));
  await ok(stored.receipt === rec.receipt, "the receipt is stored on the record, so the report link shows it again");
  const page = reportDoneHtml(rec, { origin: "https://agent402.tools" });
  await ok(page.includes('id="purchase-receipt"') && page.includes(rec.receipt) && page.includes("/api/receipts/verify"), "the report page shows the receipt and where to check it");
  const pub = reportDoneHtml({ ...rec, publicView: true }, { origin: "https://agent402.tools" });
  await ok(!pub.includes(rec.receipt) && !pub.includes("purchase-receipt"), "a public view of the report never shows it");
  const mail = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_receipt_paid", productLabel: "Dossier", subjectOf: "AAPL", kind: "dossier", baseUrl: "https://agent402.tools", receipt: rec.receipt });
  await ok(mail.text.includes(rec.receipt) && mail.html.includes(rec.receipt) && textNamesUrl(mail.text, "agent402.tools", "/api/receipts/verify"), "the ready email carries the receipt and where to check it");
  const plain = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/x", productLabel: "Dossier", subjectOf: "AAPL", kind: "dossier", baseUrl: "https://agent402.tools" });
  await ok(!/Signed receipt/.test(plain.text + plain.html), "an email with no receipt says nothing about one");
  await ok(requestDigest("POST", CHECKOUT_RECEIPT_PATH, { product: "dossier", input: "AAPL" }) === v.record.requestSha256, "the request digest is the checkout's product and input");
}

// ---- 4. a paid server with a key ----
const { bootPaidWires, WIRES } = await import("./lib/paid-wires-rig.js");
const CHAT_FRAMES = ['data: {"id":"g1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"The"}}]}\n\n', 'data: {"id":"g1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" answer"},"finish_reason":"stop"}]}\n\n', 'data: {"id":"g1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"cost":0.000001}}\n\n', "data: [DONE]\n\n"];
const CHAT = { method: "POST", path: "/v1/chat/completions", body: { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true, model_fallback: false } };
const HASH = { method: "POST", path: "/api/hash", body: { text: "receipt" } };
const credStores = mkdtempSync(join(tmpdir(), "a402-receipt-rig-credits-"));
const CREDIT_KEY = `a402_${randomBytes(16).toString("hex")}`;
writeFileSync(join(credStores, `k_${hashKey(CREDIT_KEY)}.json`), JSON.stringify({ keyId: "kid_rig", balanceMicro: 5_000_000, loadedMicro: 5_000_000, spentMicro: 0, calls: 0, createdAt: new Date().toISOString(), pack: "credits-20", sessions: [], paymentIntents: [], lastUsedAt: null }));
rig = await bootPaidWires({ label: "receipt-streams", env: { ...ENV_A, STRIPE_SECRET_KEY: "sk_test_receipt_streams_never_used", STRIPE_PROFILE_ID: "profile_test_receipt_streams", STRIPE_WEBHOOK_SECRET: "", STRIPE_TOKEN_STUB: "on", CREDITS_DIR: credStores } });
try {
  const keyDoc = await (await fetch(`${rig.url}${RECEIPT_KEYS_PATH}`)).json();
  rig.st.llmStreamFrames = () => CHAT_FRAMES;
  for (const wire of WIRES) {
    const w = await rig.wallet(wire);
    rig.fund(w, 10n ** 12n);
    const r = await rig.pay(w, CHAT);
    const bytes = Buffer.from(r.text, "utf8");
    const cv = await verifyStreamedReceipt(bytes, { keys: keyDoc.keys, request: { method: "POST", path: CHAT.path, body: CHAT.body } });
    const { body, receipt } = splitStreamedReceipt(bytes);
    await ok(r.status === 200 && /text\/event-stream/.test(r.headers.get("content-type") || "") && Buffer.from(body).toString().includes('"content":" answer"') && cv.valid, `${wire}: a settled streamed chat answer ends with a receipt line that verifies against the bytes streamed and the request sent (${r.status}, ${cv.reason})`);
    await ok(JSON.stringify(sseEvents(bytes)) === JSON.stringify(sseEvents(body)) && strictJson(sseEvents(bytes)) && sseEvents(bytes).at(-1)?.data === "[DONE]", `${wire}: a client that JSON-parses every event reads the answer's events and [DONE] last, never the receipt (${sseEvents(bytes).length} events)`);
    const settleRef = r.headers.get("payment-response") ? JSON.parse(Buffer.from(r.headers.get("payment-response"), "base64").toString("utf8")).transaction : r.headers.get("payment-receipt") ? JSON.parse(Buffer.from(r.headers.get("payment-receipt"), "base64url").toString("utf8")).reference : null;
    await ok(cv.record.settlement && cv.record.settlement === settleRef && cv.record.slug && cv.record.priceUsd, `${wire}: rail ${cv.record.rail}, the settlement the wire's own receipt names`);
    const api = await (await fetch(`${rig.url}${RECEIPT_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt, body: Buffer.from(body).toString("utf8") }) })).json();
    await ok(api.valid === true && api.checks.response === true, `${wire}: POST ${RECEIPT_VERIFY_PATH} agrees on the streamed bytes`);
    // A one-piece paid tool answer on the same wire: signed, and on an EVM
    // wire kept for the audit report (the keeper's finish listener rides a
    // response that already carries the tool path's own).
    const h = await rig.pay(w, HASH);
    await ok(h.status === 200 && verifyReceipt(h.headers.get(RECEIPT_HEADER) || "", { keys: keyDoc.keys, responseBody: h.text }).valid, `${wire}: a paid ${HASH.path} answer carries a receipt that verifies (${h.status})`);
  }
  // Credits on the booted server: the header on a one-piece answer, the receipt line on a stream.
  {
    const auth = { authorization: `Bearer ${CREDIT_KEY}`, "content-type": "application/json" };
    const r = await fetch(`${rig.url}${HASH.path}`, { method: "POST", headers: auth, body: JSON.stringify(HASH.body) });
    const text = await r.text();
    const v = verifyReceipt(r.headers.get(RECEIPT_HEADER) || "", { keys: keyDoc.keys, responseBody: text, request: { method: "POST", path: HASH.path, body: HASH.body } });
    await ok(r.status === 200 && v.valid && v.record.rail === "credits" && v.record.payer === "kid_rig" && /^cd_/.test(v.record.settlement) && Number(v.record.priceUsd) > 0, `credits: the booted server's 200 carries a receipt naming the key id and its debit (${r.status}, ${v.reason}, ${v.record?.settlement})`);
    const hist = JSON.parse(readFileSync(join(credStores, `k_${hashKey(CREDIT_KEY)}.json`), "utf8")).history || [];
    await ok(hist.some((e) => e.k === "charge" && e.d === v.record.settlement), "credits: the key's history records the debit the receipt names");
    const s = await fetch(`${rig.url}${CHAT.path}`, { method: "POST", headers: auth, body: JSON.stringify(CHAT.body) });
    const sbytes = Buffer.from(await s.arrayBuffer());
    const sv = await verifyStreamedReceipt(sbytes, { keys: keyDoc.keys, request: { method: "POST", path: CHAT.path, body: CHAT.body } });
    await ok(s.status === 200 && sv.valid && sv.record.rail === "credits", `credits: a streamed chat answer ends with a receipt line that verifies (${s.status}, ${sv.reason})`);
    const cl = await clientVerify(v.record ? r.headers.get(RECEIPT_HEADER) : "", { baseUrl: rig.url, body: text });
    await ok(cl.valid, "credits: the client fetches the keys and agrees");
    // An answer served without a run (a keyed replay of the same call) is
    // not debited, so it carries no receipt; the first one covers its bytes.
    const idem = { ...auth, "Idempotency-Key": `receipt-credits-${Date.now()}` };
    const first = await fetch(`${rig.url}${HASH.path}`, { method: "POST", headers: idem, body: JSON.stringify(HASH.body) });
    const firstText = await first.text();
    await new Promise((res) => setTimeout(res, 300));
    const balanceOf = () => JSON.parse(readFileSync(join(credStores, `k_${hashKey(CREDIT_KEY)}.json`), "utf8")).balanceMicro;
    const beforeReplay = balanceOf();
    const again = await fetch(`${rig.url}${HASH.path}`, { method: "POST", headers: idem, body: JSON.stringify(HASH.body) });
    const againText = await again.text();
    await new Promise((res) => setTimeout(res, 300));
    await ok(balanceOf() === beforeReplay, `credits: the keyed replay takes nothing from the key (${beforeReplay} -> ${balanceOf()})`);
    const fv = verifyReceipt(first.headers.get(RECEIPT_HEADER) || "", { keys: keyDoc.keys, responseBody: againText });
    await ok(again.status === 200 && again.headers.get("x-idempotent-replay") === "true" && !again.headers.get(RECEIPT_HEADER) && fv.valid && firstText === againText, `credits: a keyed replay is not debited and carries no new receipt; the first verifies against its bytes (${fv.reason})`);
  }
  const doc = await (await fetch(`${rig.url}${CONFORMANCE_PATH}`)).json();
  for (const id of ["credits", "card:checkout"]) {
    const row = doc.rails.find((r) => r.id === id);
    await ok(row?.features.signedReceipt.supported === true && /Agent402-Receipt|receipt/.test(row.features.signedReceipt.detail), `${id}: the conformance cell reads signed`);
  }
  // Every paid answer above was signed, and the EVM ones kept for the audit
  // report: the keeper's finish listener logs no listener-leak warning.
  const leaks = rig.log().split("\n").filter((l) => /MaxListenersExceededWarning/.test(l) && /\bfinish listeners\b/.test(l));
  await ok(leaks.length === 0, `no signed paid answer logs a finish-listener leak warning (${leaks.length}${leaks.length ? `: ${leaks[0].slice(0, 160)}` : ""})`);
} finally { await rig.stop(); rig = null; }

// Without a key: a settled stream carries no receipt line.
rig = await bootPaidWires({ label: "receipt-streams-off" });
try {
  rig.st.llmStreamFrames = () => CHAT_FRAMES;
  const w = await rig.wallet("evm");
  rig.fund(w, 10n ** 12n);
  const r = await rig.pay(w, CHAT);
  await ok(r.status === 200 && !r.text.includes(RECEIPT_SSE_COMMENT) && r.text.endsWith("data: [DONE]\n\n"), "no key: a settled stream ends as streamed, with no receipt line");
} finally { await rig.stop(); rig = null; }

console.log(`\n${pass} checks passed`);
