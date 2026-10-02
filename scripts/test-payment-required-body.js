#!/usr/bin/env node
// The 402 JSON body carries the same PaymentRequired object as the
// PAYMENT-REQUIRED header (src/payment-required-body.js).
//
// x402 v2 puts the offer in the header and the paywall used to answer `{}` (or
// only the fields this server adds), so a reader of the body found no accepts.
// The body now carries the decoded header object with our own fields kept.
// The header stays authoritative, and the two must never disagree.
//
// Part 1 (offline) pins the merge: header keys win, our keys are kept and stay
// first, a body that explains itself (a hint, or a problem's detail) carries
// the offer but no `error`, anything undecodable or non-JSON goes out
// byte-identical, and the mount precedes every middleware that can patch the
// body into an MPP problem.
//
// Part 2 boots a PAID server against a stub facilitator and reads real 402s:
// the unpaid ask on a proof-of-work tool, a GET and its HEAD, a retired
// converter, a per-request metered quote, a gate refusal, both facilitator
// verify-refusal shapes, an MPP refusal as problem+json, and a settle refusal
// (which carries no PAYMENT-REQUIRED header, so it must carry no offer). Every
// refusal is also read the way an `error`-first client reads it (the OpenAI
// SDK's message rule, and agent402-client's failure text): the message must be
// our explanation, never the header's one-line error. Two controls prove
// nothing a buyer does changed: an unmodified x402 client and an mppx client
// both still pay.
//
// Part 3 boots the same server with PAYMENT_REQUIRED_BODY=off and requires the
// PAYMENT-REQUIRED header to be byte-identical for the same requests: the
// mirror writes the body and never the header.
import { spawn } from "node:child_process";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { getFreePorts } from "./lib/free-port.js";
import {
  decodePaymentRequired,
  explainsItself,
  mergePaymentRequiredBody,
  paymentRequiredBodyMiddleware,
  withoutPaymentRequired,
  MIRRORED_STATUSES,
  PAYMENT_REQUIRED_OFFER_KEYS,
} from "../src/payment-required-body.js";
import { REJECTION_REASONS } from "../src/payment-reject.js";
import { Agent402 } from "../client/index.js";
import { x402TestPage } from "../src/x402-test-page.js";

let pass = 0, proc = null, facilitator = null;
const serverLog = [];
const fail = (m) => {
  console.error("FAIL:", m);
  if (serverLog.length) { console.error("--- server output (last lines) ---"); for (const l of serverLog.slice(-40)) console.error(l); console.error("--- end server output ---"); }
  proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");

// ---------------------------------------------------------------------------
// Part 1: the merge, offline
// ---------------------------------------------------------------------------
const PR = {
  x402Version: 2,
  error: "No matching payment requirements",
  resource: { url: "http://127.0.0.1/api/hash", description: "SHA-256 of text", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
  extensions: { bazaar: { info: { input: { type: "http", method: "POST" } } } },
};
const HDR = b64(PR);
const parse = (s) => JSON.parse(s);
const mirrors = (body, pr) => Object.keys(pr).every((k) => isDeepStrictEqual(body[k], pr[k]));

// U1 an empty body becomes the header object itself
{
  const out = parse(mergePaymentRequiredBody("{}", HDR));
  ok(isDeepStrictEqual(out, PR), "U1 `{}` + header -> the body deep-equals the decoded header");
}
// U2 altPayment kept, and first
{
  const out = parse(mergePaymentRequiredBody(JSON.stringify({ altPayment: { protocol: "proof-of-work", info: "x" } }), HDR));
  ok(mirrors(out, PR), "U2 every decoded header key is in the body, deep-equal");
  ok(out.altPayment?.protocol === "proof-of-work" && Object.keys(out)[0] === "altPayment", "U2 altPayment is kept and stays the first key");
}
// The offer keys of the header, i.e. every key but `error`.
const { error: _prError, ...PR_OFFER } = PR;
const mirrorsOffer = (body, pr) => Object.keys(pr).filter((k) => k !== "error").every((k) => isDeepStrictEqual(body[k], pr[k]));
// U3 a gate refusal: our explanation first, the offer after it, and NO error
// (neither the header's nor our "Payment rejected" fallback), so an
// error-first client reads the hint rather than a one-line sentence.
{
  const body = { error: "Payment rejected", reason: "requirements-mismatch", hint: "Echo the accepts entry verbatim.", retry: "rebuild-payment" };
  const out = parse(mergePaymentRequiredBody(JSON.stringify(body), HDR));
  ok(!("error" in out), `U3 a body with a hint carries no error (got ${JSON.stringify(out.error)})`);
  ok(out.reason === body.reason && out.hint === body.hint && out.retry === body.retry, "U3 reason, hint and retry are kept");
  ok(isDeepStrictEqual(Object.keys(out), ["reason", "hint", "retry", ...Object.keys(PR_OFFER)]), `U3 our fields first, then the offer (${Object.keys(out).join(",")})`);
  ok(mirrorsOffer(out, PR), "U3 every other header key is mirrored, deep-equal");
}
// U3b the verify hint's shape (hint, retry, a balance, no error of its own)
{
  const body = { hint: "The wallet holds too little USDC on Base; fund it.", retry: "fund-wallet", payerUsdcOnBase: 0 };
  const out = parse(mergePaymentRequiredBody(JSON.stringify(body), HDR));
  ok(!("error" in out) && out.hint === body.hint && out.payerUsdcOnBase === 0 && mirrorsOffer(out, PR), "U3b a verify hint gets the offer and no error");
}
// U3c a blank hint explains nothing: the header's error is mirrored
{
  const out = parse(mergePaymentRequiredBody(JSON.stringify({ hint: "  ", retry: "x" }), HDR));
  ok(out.error === PR.error && mirrors(out, PR), "U3c a blank hint is not an explanation: every header key, error included, is mirrored");
  ok(explainsItself({ hint: "h" }) && explainsItself({ detail: "d" }) && !explainsItself({ hint: "" }) && !explainsItself({ detail: 7 }) && !explainsItself({ altPayment: { info: "x" } }) && !explainsItself(null) && !explainsItself([]), "U3c explainsItself: a non-empty hint or detail string, nothing else");
}
// U4 an RFC 9457 problem document explains itself through `detail`
{
  const problem = { type: "https://paymentauth.org/problems/malformed-credential", title: "Malformed Credential", status: 402, detail: "Credential is malformed.", hint: "Use a supported wallet." };
  const out = parse(mergePaymentRequiredBody(JSON.stringify(problem), HDR));
  ok(["type", "title", "status", "detail", "hint"].every((k) => out[k] === problem[k]), "U4 the problem members are kept");
  ok(!("error" in out), "U4 a problem document carries no error");
  ok(mirrorsOffer(out, PR) && isDeepStrictEqual(Object.keys(out).slice(0, 4), ["type", "title", "status", "detail"]), "U4 the offer is mirrored after the problem members");
  const noDetail = parse(mergePaymentRequiredBody(JSON.stringify({ type: problem.type, title: problem.title, status: 402 }), HDR));
  ok(noDetail.error === PR.error, "U4 a problem with no detail and no hint mirrors the header's error");
}
// U5 a stale body offer never survives
{
  const out = parse(mergePaymentRequiredBody(JSON.stringify({ accepts: [], x402Version: 1 }), HDR));
  ok(isDeepStrictEqual(out.accepts, PR.accepts) && out.x402Version === 2, "U5 a body's own accepts/x402Version are replaced by the header's");
}
// U6 an undecodable or wrongly shaped header leaves the body alone
for (const [label, h] of [["null", null], ["empty", ""], ["not base64", "!!!"], ["not json", b64("not json")], ["an array", b64("[1]")], ["no x402Version", b64('{"accepts":[]}')], ["no accepts", b64('{"x402Version":2}')], ["a string version", b64('{"x402Version":"2","accepts":[]}')], ["a header array", [HDR]]]) {
  ok(mergePaymentRequiredBody("{}", h) === null && decodePaymentRequired(h) === null, `U6 header ${label} -> body unchanged`);
}
// U7 a body that is not a JSON object is never rewritten
for (const [label, body] of [["HTML", "<!doctype html><html><body>Pay</body></html>"], ["an array", "[]"], ["a string", '"x"'], ["empty", ""], ["broken JSON", "{broken"], ["not a string", Buffer.from("{}")]]) {
  ok(mergePaymentRequiredBody(body, HDR) === null, `U7 body ${label} -> unchanged`);
}
// U8 base64url decodes too
{
  const doc = { ...PR, resource: { ...PR.resource, description: "???>>>~~~ ???>>>~~~ ???>>>" } };
  const std = b64(doc);
  ok(/[+/]/.test(std), "U8 control: the standard encoding carries + or / (so the url form differs)");
  const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  ok(isDeepStrictEqual(decodePaymentRequired(url), doc) && isDeepStrictEqual(parse(mergePaymentRequiredBody("{}", url)), doc), "U8 a base64url header decodes to the same object");
}
// U9 the middleware against a fake response
{
  const fake = ({ status = 402, header = HDR, sent = false, throwing = false } = {}) => {
    const res = {
      statusCode: status, headersSent: sent, sentChunks: [],
      getHeader(n) { if (throwing) throw new Error("boom"); return String(n).toLowerCase() === "payment-required" ? header : undefined; },
      send(chunk) { this.sentChunks.push(chunk); return this; },
    };
    let nexted = false;
    paymentRequiredBodyMiddleware()({}, res, () => { nexted = true; });
    if (!nexted) fail("U9 middleware did not call next()");
    return res;
  };
  const r402 = fake(); r402.send("{}");
  ok(isDeepStrictEqual(parse(r402.sentChunks[0]), PR), "U9 402 + header -> merged");
  const r412 = fake({ status: 412 }); r412.send("{}");
  ok(isDeepStrictEqual(parse(r412.sentChunks[0]), PR), "U9 412 (permit2_allowance_required) + header -> merged");
  const noHdr = fake({ header: null }); noHdr.send('{"error":"x"}');
  ok(noHdr.sentChunks[0] === '{"error":"x"}', "U9 402 without the header -> identical");
  const r200 = fake({ status: 200 }); r200.send('{"ok":true}');
  ok(r200.sentChunks[0] === '{"ok":true}', "U9 200 + header -> identical");
  const r403 = fake({ status: 403 }); r403.send("{}");
  ok(r403.sentChunks[0] === "{}", "U9 another 4xx + header -> identical");
  const sent = fake({ sent: true }); sent.send("{}");
  ok(sent.sentChunks[0] === "{}", "U9 headers already sent -> identical");
  const buf = Buffer.from("{}"); const rb = fake(); rb.send(buf);
  ok(rb.sentChunks[0] === buf, "U9 a Buffer chunk -> identical");
  let threw = false; const rt = fake({ throwing: true });
  try { rt.send("{}"); } catch { threw = true; }
  ok(!threw && rt.sentChunks[0] === "{}", "U9 getHeader throwing -> the original body goes out and nothing throws");
  ok(MIRRORED_STATUSES.has(402) && MIRRORED_STATUSES.has(412) && MIRRORED_STATUSES.size === 2, "U9 exactly 402 and 412 are mirrored");
}
// U10 stripping for text relays
{
  const mirrored = { error: "Payment rejected", reason: "unsupported-scheme", hint: "h", ...PR };
  const stripped = withoutPaymentRequired(mirrored);
  ok(PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in stripped)) && stripped.error === PR.error && stripped.reason === "unsupported-scheme" && stripped.hint === "h", "U10 the offer keys go, error/reason/hint stay");
  ok("x402Version" in mirrored, "U10 the input is not mutated");
  const other = { error: "bad input", accepts: ["kept"] };
  ok(withoutPaymentRequired(other) === other, "U10 a body without a numeric x402Version is returned untouched");
  ok(withoutPaymentRequired(null) === null && withoutPaymentRequired("x") === "x", "U10 non-objects are returned untouched");
}
// U11 the mount precedes every middleware that can call markMppProblem
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = (needle) => src.indexOf(needle);
  const mount = at("app.use(paymentRequiredBodyMiddleware())");
  ok(mount > -1, "U11 server.js mounts paymentRequiredBodyMiddleware");
  for (const later of ["app.use(mppShim)", "app.use(tempoGate)", "app.use(stripeGate)"]) {
    ok(at(later) > -1 && mount < at(later), `U11 the mount comes before ${later}`);
  }
  ok(mount > at("app.use(createHangupSettlementHook("), "U11 the mount sits in the paid gate block (after the hang-up hook)");
}

// ---------------------------------------------------------------------------
// Part 2: a booted paid server
// ---------------------------------------------------------------------------
const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mpp-secret";
const AGG3 = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
const PAYER = "0x00000000000000000000000000000000000000a1";
let verifyMode = "ok"; // ok | graceful | throw
let settleMode = "ok"; // ok | refuse
const fac = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = PAYER; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* not json */ }
    // exact AND upto on Base (X402_UPTO_NETWORKS below), the configuration the
    // /x402-test sample reflects, so the refusal B5 reads is the one that page
    // prints ("Offered: exact, upto.").
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "upto", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") {
      fac.verify++;
      if (verifyMode === "graceful") return reply(200, { isValid: false, invalidReason: "insufficient_funds", payer });
      if (verifyMode === "throw") return reply(400, { isValid: false, invalidReason: "invalid_payload: contract call failed: execution reverted", payer });
      return reply(200, { isValid: true, payer });
    }
    if (req.url === "/settle") {
      fac.settle++;
      if (settleMode === "refuse") return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer });
      return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer });
    }
    // The balance read batches through Multicall3 aggregate3: answer every
    // inner balanceOf with a zero balance, so the hint says "fund the wallet".
    if (req.url === "/rpc") {
      try {
        const data = JSON.parse(body)?.params?.[0]?.data;
        const { args } = decodeFunctionData({ abi: AGG3, data });
        const zero = "0x" + "00".repeat(32);
        return reply(200, { jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: args[0].map(() => ({ success: true, returnData: zero })) }) });
      } catch { return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" }); }
    }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

// A fixed BASE_URL, so the resource URL in the header does not depend on the
// port and Part 3 can compare headers from two boots byte for byte.
const BASE_URL = "http://agent402.test";
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 120) serverLog.splice(0, serverLog.length - 120); };
const bootServer = (port, extraEnv = {}) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "", BASE_URL,
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: SECRET, PAYMENT_REQUIRED_BODY: "", X402_UPTO_NETWORKS: "eip155:8453",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
      STATS_ALLOW_EPHEMERAL: "true", OPENROUTER_TTS_ENABLED: "true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", keepLog); child.stderr.on("data", keepLog);
  return child;
};
const waitUp = async (base) => {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* booting */ } await sleep(500); }
  return false;
};
proc = bootServer(PORT);

let parsePaymentRequired;
try { ({ parsePaymentRequired } = await import("@x402/core/schemas")); } catch (e) { fail(`@x402/core/schemas is not installed: ${e?.message || e}`); }

const decodeHeader = (res) => {
  const h = res.headers.get("payment-required");
  return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null;
};
// The keys a PaymentRequired header may carry. Anything else in the decoded
// header would be one of OUR body fields written back into the challenge a
// buyer pays from.
const PROTOCOL_KEYS = new Set(["x402Version", "error", "resource", "accepts", "extensions"]);
const BODY_ONLY_KEYS = ["altPayment", "replacement", "reason", "hint", "retry", "payerUsdcOnBase", "type", "title", "detail", "status"];
/** The header carries protocol keys only, none of ours. */
const assertHeaderUntouched = (label, decoded) => {
  const extra = Object.keys(decoded).filter((k) => !PROTOCOL_KEYS.has(k));
  ok(extra.length === 0 && BODY_ONLY_KEYS.every((k) => !(k in decoded)), `${label}: the header carries protocol keys only (${Object.keys(decoded).join(",")})`);
};
/** The body carries every key the header carries, deep-equal, and parses as a
 *  PaymentRequired under the protocol's own schema. A body that explains
 *  itself (`explained`: a hint or a problem detail) carries every key but
 *  `error`, and no `error` at all. Returns [body, decoded]. */
const assertMirror = (label, res, text, { explained = false } = {}) => {
  const decoded = decodeHeader(res);
  ok(!!decoded, `${label}: PAYMENT-REQUIRED is present`);
  assertHeaderUntouched(label, decoded);
  let body;
  try { body = JSON.parse(text); } catch { fail(`${label}: the body is not JSON: ${String(text).slice(0, 200)}`); }
  const expectExplained = explained === "auto" ? explainsItself(body) : explained;
  ok(explainsItself(body) === expectExplained, `${label}: the body ${expectExplained ? "explains itself (hint or detail)" : "carries no hint or detail"}`);
  for (const k of Object.keys(decoded)) {
    if (expectExplained && k === "error") continue;
    if (!isDeepStrictEqual(body[k], decoded[k])) fail(`${label}: body.${k} differs from the header's (${JSON.stringify(body[k])?.slice(0, 160)} vs ${JSON.stringify(decoded[k])?.slice(0, 160)})`);
  }
  if (expectExplained) {
    ok(typeof decoded.error === "string" && !("error" in body), `${label}: every header key but error (${Object.keys(decoded).filter((k) => k !== "error").join(",")}) is in the body, deep-equal, and the body carries no error (the header's is "${decoded.error}")`);
  } else {
    ok(true, `${label}: every header key (${Object.keys(decoded).join(",")}) is in the body, deep-equal`);
  }
  const parsed = parsePaymentRequired(body);
  ok(parsed.success, `${label}: the body parses as a PaymentRequired (${parsed.success ? "ok" : parsed.error?.issues?.[0]?.message})`);
  return [body, decoded];
};
// How an `error`-first client turns a failed response into a message. The
// OpenAI SDK's rule (client.makeStatusError + APIError.makeMessage, unchanged
// across its 7.x releases): a body with a top-level `error` is described by
// that key alone; a body without one is stringified whole.
const errorFirstMessage = (status, text) => {
  let j; try { j = JSON.parse(text); } catch { return `${status} ${text}`; }
  const normalized = j && typeof j === "object" && j.error == null ? { error: j } : j;
  const e = normalized?.error;
  const msg = e?.message ? (typeof e.message === "string" ? e.message : JSON.stringify(e.message)) : e ? JSON.stringify(e) : undefined;
  return `${status} ${msg}`;
};
/** The two error-first readers both lead with our explanation, never with the
 *  header's one-line error. */
const assertErrorFirstReaders = async (label, status, text, decoded, explanation) => {
  const m = errorFirstMessage(status, text);
  ok(m !== `${status} ${JSON.stringify(decoded.error)}` && m.slice(0, 600).includes(JSON.stringify(explanation).slice(1, -1)), `${label}: an error-first SDK message leads with our explanation, not the header's "${decoded.error}" (${m.slice(0, 120)}...)`);
  const sdk = await new Agent402({ baseUrl: B, cache: false })._failureDetail("t", new Response(text, { status }));
  ok(sdk === `call "t" failed: HTTP ${status} - ${explanation}`, `${label}: agent402-client's failure text is the explanation (${sdk.slice(0, 160)})`);
};
let nonceN = 0;
const credential = (accepted, payer = PAYER) => b64({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
});

try {
  ok(await waitUp(B), "the paid server booted within 60 s");

  // B1 unpaid POST on a proof-of-work tool
  const HASH = { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "x" }) };
  const call = (t, headers = {}) => fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json", ...headers }, body: t.body });
  {
    const r = await call(HASH);
    ok(r.status === 402, `B1 unpaid POST /api/hash -> 402 (got ${r.status})`);
    const [body] = assertMirror("B1", r, await r.text());
    ok(body.altPayment?.protocol === "proof-of-work" && Object.keys(body)[0] === "altPayment", "B1 the proof-of-work altPayment is kept, first");
    ok(/^application\/json/.test(r.headers.get("content-type") || ""), `B1 content-type stays application/json (${r.headers.get("content-type")})`);
  }

  // B2 GET, then HEAD of the same route
  {
    const r = await fetch(`${B}/api/uuid`, { headers: { "accept-encoding": "identity" } });
    ok(r.status === 402, `B2 unpaid GET /api/uuid -> 402 (got ${r.status})`);
    const text = await r.text();
    assertMirror("B2 GET", r, text);
    const h = await fetch(`${B}/api/uuid`, { method: "HEAD", headers: { "accept-encoding": "identity" } });
    const htext = await h.text();
    ok(h.status === 402 && !!h.headers.get("payment-required") && htext === "", `B2 HEAD /api/uuid -> 402, header present, empty body (got ${h.status}, ${htext.length} bytes)`);
    const cl = h.headers.get("content-length");
    ok(cl === null || Number(cl) === Buffer.byteLength(text), `B2 HEAD Content-Length reflects the mirrored body (${cl} vs ${Buffer.byteLength(text)})`);
  }

  // B3 a servable retired converter: altPayment + replacement kept
  {
    const r = await fetch(`${B}/api/convert/kilometers-to-miles?value=42`);
    ok(r.status === 402, `B3 retired converter -> 402 (got ${r.status})`);
    const [body, decoded] = assertMirror("B3", r, await r.text());
    ok(!!body.altPayment && !!body.replacement?.route, "B3 altPayment and replacement are kept");
    ok(body.resource?.url === decoded.resource?.url, `B3 body.resource.url is the header's (${body.resource?.url})`);
  }

  // B4 a per-request metered quote is mirrored, never re-quoted
  {
    const METERED = "/v1/metered/chat/completions";
    const floor = await fetch(`${B}${METERED}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(floor.status === 402, `B4 control: an empty metered body -> 402 (got ${floor.status})`);
    const [floorBody] = assertMirror("B4 floor", floor, await floor.text());
    const big = { model: "openai/gpt-4o-mini", max_tokens: 8000, messages: [{ role: "user", content: "Summarize the history of payment protocols. ".repeat(200) }] };
    const r = await fetch(`${B}${METERED}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(big) });
    ok(r.status === 402, `B4 a real metered body -> 402 (got ${r.status})`);
    const [body, decoded] = assertMirror("B4 quote", r, await r.text());
    const base = (x) => (x.accepts || []).find((a) => a.network === "eip155:8453");
    ok(base(body)?.amount === base(decoded)?.amount, `B4 the body's quote is the header's (${base(body)?.amount})`);
    ok(base(body)?.amount !== base(floorBody)?.amount, `B4 and it is this request's quote, not the floor (${base(body)?.amount} vs ${base(floorBody)?.amount})`);
  }

  // B5 a gate refusal before any facilitator: the sample /x402-test prints
  const WALLET_ONLY = { path: "/api/demand-radar?limit=1", method: "GET" };
  {
    const before = fac.verify;
    const header = b64({ x402Version: 2, accepted: { scheme: "lightning", network: "eip155:8453" }, payload: {} });
    const r = await call(WALLET_ONLY, { "payment-signature": header });
    ok(r.status === 402, `B5 an unsupported scheme -> 402 (got ${r.status})`);
    const text = await r.text();
    const [body, decoded] = assertMirror("B5", r, text, { explained: true });
    ok(fac.verify === before, "B5 refused by the gate: no facilitator verify");
    ok(REJECTION_REASONS.some((x) => x.reason === body.reason), `B5 body.reason is a published refusal class (${body.reason})`);
    ok(typeof body.hint === "string" && body.hint && typeof body.retry === "string" && body.retry, "B5 hint and retry are present");
    ok(isDeepStrictEqual(Object.keys(body).slice(0, 3), ["reason", "hint", "retry"]), `B5 the first three keys are reason, hint, retry (${Object.keys(body).join(",")})`);
    await assertErrorFirstReaders("B5", r.status, text, decoded, body.hint);
    ok((decoded.accepts || []).some((a) => a.scheme === "upto"), "B5 control: this boot offers upto on Base (the configuration the /x402-test sample reflects)");
    // The /x402-test page calls its sample "a real one": it must be this body,
    // key for key and word for word, with only the offer's values elided.
    const html = x402TestPage(BASE_URL);
    const pres = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    const sampleText = pres.find((t) => t.includes('"unsupported-scheme"'));
    let sample = null;
    try { sample = JSON.parse(String(sampleText).replace(/\{ \.\.\. \}|\[ \.\.\. \]/g, "null")); } catch { sample = null; }
    ok(!!sample && isDeepStrictEqual(Object.keys(sample), Object.keys(body)), `B5 the /x402-test sample has this body's keys, in order (${sample ? Object.keys(sample).join(",") : "unparsed"})`);
    ok(!!sample && ["reason", "hint", "retry", "x402Version"].every((k) => sample[k] === body[k]), `B5 the /x402-test sample's reason, hint and retry are this body's (${body.hint})`);
    console.log("   B5 body (the /x402-test sample):", JSON.stringify({ ...body, resource: "...", accepts: "...", extensions: "..." }));
  }

  // B6 + B7 both facilitator verify-refusal shapes keep the verify hint
  const acceptOf = async (t) => {
    const r = await call(t);
    return (decodeHeader(r)?.accepts || []).find((a) => a.network === "eip155:8453");
  };
  const hashAccept = await acceptOf(HASH);
  ok(!!hashAccept, "the /api/hash 402 offers exact on Base");
  for (const [label, mode] of [["B6 graceful isValid:false", "graceful"], ["B7 thrown verify", "throw"]]) {
    verifyMode = mode;
    const cred = credential(hashAccept);
    const before = fac.verify;
    const first = await call(HASH, { "payment-signature": cred });
    ok(first.status === 402 && fac.verify === before + 1, `${label}: 402 after one facilitator verify (got ${first.status}, verifies ${fac.verify - before})`);
    assertMirror(`${label} first`, first, await first.text(), { explained: "auto" });
    const again = await call(HASH, { "payment-signature": cred });
    ok(again.status === 402, `${label}: the same credential again -> 402`);
    const againText = await again.text();
    const [body, decoded] = assertMirror(`${label} retried`, again, againText, { explained: true });
    ok(body.retry === "fund-wallet" && typeof body.hint === "string" && body.payerUsdcOnBase === 0, `${label}: hint, retry and payerUsdcOnBase are kept (retry=${body.retry})`);
    const keys = Object.keys(body);
    ok(keys.indexOf("hint") > -1 && keys.indexOf("hint") < keys.indexOf("x402Version"), `${label}: the hint comes before the offer (${keys.join(",")})`);
    await assertErrorFirstReaders(label, again.status, againText, decoded, body.hint);
  }
  verifyMode = "ok";

  // B8 an MPP refusal: problem+json carrying the mirrored offer
  {
    const r = await fetch(`${B}/api/uuid`, { headers: { Authorization: "Payment !!!not-base64url!!!" } });
    ok(r.status === 402, `B8 malformed MPP credential -> 402 (got ${r.status})`);
    ok(/^application\/problem\+json/.test(r.headers.get("content-type") || ""), `B8 content-type stays application/problem+json (${r.headers.get("content-type")})`);
    const text = await r.text();
    const [body, decoded] = assertMirror("B8", r, text, { explained: true });
    ok(/\/malformed-credential$/.test(body.type || "") && body.status === 402 && typeof body.detail === "string" && body.detail, `B8 the problem members are kept (${body.type})`);
    await assertErrorFirstReaders("B8", r.status, text, decoded, body.detail);
    ok(/^Payment /i.test(r.headers.get("www-authenticate") || ""), "B8 fresh MPP challenges are still on WWW-Authenticate");
  }

  // B9 a settle refusal carries no PAYMENT-REQUIRED header, so no offer
  {
    settleMode = "refuse";
    const acc = await acceptOf(WALLET_ONLY);
    ok(!!acc, "the demand-radar 402 offers exact on Base");
    const before = fac.settle;
    const r = await call(WALLET_ONLY, { "payment-signature": credential(acc, "0x00000000000000000000000000000000000000b9") });
    const text = await r.text();
    ok(r.status === 402 && fac.settle === before + 1, `B9 verified, served, settle refused -> 402 (got ${r.status}, settles ${fac.settle - before})`);
    ok(!!r.headers.get("payment-response") && !r.headers.get("payment-required"), "B9 the settle-refusal 402 carries PAYMENT-RESPONSE and no PAYMENT-REQUIRED");
    let body = {}; try { body = JSON.parse(text); } catch { fail(`B9 body is not JSON: ${text.slice(0, 200)}`); }
    ok(PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in body)), `B9 the body states no offer (keys: ${Object.keys(body).join(",") || "none"})`);
    settleMode = "ok";
  }

  // B10 control: an unmodified x402 client still settles
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const v = fac.verify, s = fac.settle;
    const r = await wrapFetchWithPayment(fetch, client)(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "control" }) });
    ok(r.status === 200, `B10 control: a stock x402 client buys POST /api/hash (got ${r.status})`);
    ok(fac.verify === v + 1 && fac.settle === s + 1, `B10 exactly one verify and one settle (${fac.verify - v}/${fac.settle - s})`);
  }

  // B11 control: an mppx client still pays over the native MPP wire
  {
    const [{ Fetch, evm }] = await Promise.all([import("mppx/client")]);
    const account = privateKeyToAccount(generatePrivateKey());
    const mppFetch = Fetch.from({ methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
    const s = fac.settle;
    const r = await mppFetch(`${B}/api/uuid`);
    ok(r.status === 200 && fac.settle === s + 1, `B11 control: an mppx evm.charge client buys GET /api/uuid (got ${r.status}, settles ${fac.settle - s})`);
    ok(!!r.headers.get("payment-receipt"), "B11 and gets its Payment-Receipt");
  }

  // Part 3: the mirror writes the body, never the header. The same requests
  // against a boot with PAYMENT_REQUIRED_BODY=off get a byte-identical
  // PAYMENT-REQUIRED header, and there the body is the paywall's own.
  const capture = async (base) => {
    const at = (path, init = {}) => fetch(`${base}${path}`, init);
    const out = {};
    const keep = async (label, r) => { out[label] = { status: r.status, header: r.headers.get("payment-required"), text: await r.text() }; };
    await keep("unpaid POST /api/hash", await at(HASH.path, { method: "POST", headers: { "content-type": "application/json" }, body: HASH.body }));
    await keep("unpaid GET /api/uuid", await at("/api/uuid"));
    await keep("gate refusal", await at(WALLET_ONLY.path, { headers: { "payment-signature": b64({ x402Version: 2, accepted: { scheme: "lightning", network: "eip155:8453" }, payload: {} }) } }));
    const acc = (decodePaymentRequired(out["unpaid POST /api/hash"].header)?.accepts || []).find((a) => a.network === "eip155:8453");
    verifyMode = "graceful";
    const cred = credential(acc);
    await at(HASH.path, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred }, body: HASH.body }).then((r) => r.text());
    await keep("verify refusal", await at(HASH.path, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred }, body: HASH.body }));
    verifyMode = "ok";
    await keep("MPP problem", await at("/api/uuid", { headers: { Authorization: "Payment !!!not-base64url!!!" } }));
    return out;
  };
  const on = await capture(B);
  proc.kill("SIGKILL");
  await new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", r)));
  const [OFF_PORT] = await getFreePorts(1);
  const OFF_B = `http://127.0.0.1:${OFF_PORT}`;
  proc = bootServer(OFF_PORT, { PAYMENT_REQUIRED_BODY: "off" });
  ok(await waitUp(OFF_B), "P3 the PAYMENT_REQUIRED_BODY=off server booted within 60 s");
  const off = await capture(OFF_B);
  for (const [label, a] of Object.entries(on)) {
    const b = off[label];
    ok(a.status === 402 && b.status === 402 && typeof a.header === "string" && a.header.length > 0 && a.header === b.header,
      `P3 ${label}: the PAYMENT-REQUIRED header is byte-identical with the mirror on and off (${a.header?.length} bytes)`);
    const offBody = JSON.parse(b.text || "{}");
    ok(PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in offBody)) && "x402Version" in JSON.parse(a.text), `P3 ${label}: only the mirror puts the offer in the body (off: ${Object.keys(offBody).join(",") || "{}"})`);
  }

  console.log(`\nPASS - ${pass} checks (the 402 body carries the header's PaymentRequired object)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
