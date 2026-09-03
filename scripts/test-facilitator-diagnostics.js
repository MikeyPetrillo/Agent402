// Offline tests for src/facilitator-diagnostics.js.
//
// The bug being guarded: on 2026-08-07 every settle failure logged 200
// characters of `<html><head><title>Coinbase</title><meta robots...>` and
// nothing else, so a facilitator outage and an edge refusing our egress IP
// were indistinguishable. These assertions fail if the diagnosis stops naming
// which one it is, or if the wrapper ever touches the response it describes.
import { describeErrorResponse, textFromHtml, installFacilitatorDiagnostics } from "../src/facilitator-diagnostics.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The real page shape, reconstructed from the production log line. The first
// 200 chars - all the old code kept - are entirely markup.
const CF_BLOCK = `<html> <head> <title>Coinbase</title> <meta name="robots" content="noindex"> <meta property="viewport" name="viewport" content="width=device-width, initial-scale=1.0" /> <style type="text/css">html,body{margin:0;padding:0;font-family:sans-serif;background:#fff;color:#0a0b0d}.wrap{max-width:600px}</style> </head> <body> <div class="wrap"><h1>Access denied</h1><p>You have been blocked. Cloudflare Ray ID: 8f2c1d4e5a6b7c8d</p></div> </body> </html>`;

{
  const t = textFromHtml(CF_BLOCK);
  ok(!t.includes("<"), "markup is stripped");
  ok(!/font-family|margin:0/.test(t), "inline CSS is removed rather than counted against the budget");
  ok(t.includes("Access denied") && t.includes("Ray ID"), "the words that diagnose survive");
  ok(t.length < 200, `the whole message fits where the old 200-char excerpt saw only boilerplate (${t.length} chars)`);
}

{
  const line = describeErrorResponse({
    url: "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    status: 502,
    headers: { "server": "cloudflare", "cf-ray": "8f2c1d4e5a6b7c8d-ATL", "content-type": "text/html" },
    body: CF_BLOCK,
  });
  ok(/access denied|blocked/i.test(line), `names the block rather than quoting the doctype (got: ${line.slice(0, 90)}…)`);
  ok(line.includes("cf-ray=8f2c1d4e5a6b7c8d-ATL"), "carries the ray id, which is what a provider asks for");
  ok(line.includes("server=cloudflare"), "names whose edge answered");
  ok(line.includes("502"), "keeps the status");
  ok(!line.includes("<html>"), "does not echo markup");
}

{
  // The distinction that actually matters: an origin failing behind the edge
  // is a THEIR-outage; a challenge page is OUR egress being refused.
  const origin = describeErrorResponse({
    url: "https://f.example/settle", status: 502,
    headers: { server: "cloudflare", "content-type": "text/html" },
    body: "<html><body><h1>Bad gateway</h1><p>The origin is unreachable.</p></body></html>",
  });
  ok(/origin error/i.test(origin), `an origin failure reads as an origin failure (got: ${origin.slice(60, 130)})`);

  const challenge = describeErrorResponse({
    url: "https://f.example/settle", status: 403,
    headers: { server: "cloudflare", "cf-mitigated": "challenge", "content-type": "text/html" },
    body: "<html><body>Checking your browser before accessing.</body></html>",
  });
  ok(/challenge|block/i.test(challenge), "a challenge page reads as a challenge, not an outage");
  ok(challenge !== origin, "the two are not collapsed into one verdict");

  const limited = describeErrorResponse({
    url: "https://f.example/settle", status: 429,
    headers: { "retry-after": "30", "content-type": "text/plain" },
    body: "Too Many Requests",
  });
  ok(/rate limited/i.test(limited) && limited.includes("retry-after=30"),
    "a rate limit is named and its retry-after preserved");
}

{
  const empty = describeErrorResponse({ url: "https://f.example/settle", status: 502, headers: {}, body: "" });
  ok(empty.includes("<empty>"), "an empty body says so instead of pretending to diagnose");
}

// --- the wrapper must never affect the call it describes ---------------------
{
  const logged = [];
  const fakeBody = CF_BLOCK;
  const stub = async () => new Response(fakeBody, { status: 502, headers: { "content-type": "text/html", server: "cloudflare" } });
  const wrapped = installFacilitatorDiagnostics(["https://api.cdp.coinbase.com/x"], { log: (l) => logged.push(l), fetchImpl: stub });

  const res = await wrapped("https://api.cdp.coinbase.com/platform/v2/x402/settle", { method: "POST" });
  ok(logged.length === 1, `one diagnostic line for one failure (got ${logged.length})`);
  const body = await res.text();
  ok(body === fakeBody, "THE CALLER'S BODY IS STILL READABLE - the diagnostic cloned rather than consumed");
  ok(res.status === 502, "status is passed through untouched");
}

{
  // Only facilitator hosts, and only non-JSON: a JSON error is already
  // reported well upstream, and logging every unrelated 404 would be noise.
  const logged = [];
  const stub = async (u) => (String(u).includes("json")
    ? new Response('{"error":"nope"}', { status: 400, headers: { "content-type": "application/json" } })
    : new Response("<html>Access denied</html>", { status: 403, headers: { "content-type": "text/html" } }));
  const wrapped = installFacilitatorDiagnostics(["https://f.example/"], { log: (l) => logged.push(l), fetchImpl: stub });

  await wrapped("https://elsewhere.example/whatever");
  ok(logged.length === 0, "a non-facilitator host is ignored");
  await wrapped("https://f.example/json");
  ok(logged.length === 0, "a JSON error body is left to the upstream reporter");
  await wrapped("https://f.example/settle");
  ok(logged.length === 1, "a facilitator HTML error is diagnosed");
}

{
  const logged = [];
  const stub = async () => new Response("ok", { status: 200 });
  const wrapped = installFacilitatorDiagnostics(["https://f.example/"], { log: (l) => logged.push(l), fetchImpl: stub });
  await wrapped("https://f.example/settle");
  ok(logged.length === 0, "a successful response is never logged");
}

{
  // A diagnostic that can break settlement is worse than the blindness it
  // cures, so every internal failure is swallowed and the response still flows.
  const stub = async () => ({ ok: false, status: 502, headers: null, clone() { throw new Error("boom"); } });
  const wrapped = installFacilitatorDiagnostics(["https://f.example/"], { log: () => { throw new Error("log exploded"); }, fetchImpl: stub });
  let threw = null, out = null;
  try { out = await wrapped("https://f.example/settle"); } catch (e) { threw = e; }
  ok(!threw && out?.status === 502, "a throwing clone/logger cannot break the request it describes");
}

{
  ok(installFacilitatorDiagnostics([], { fetchImpl: async () => new Response("x") }) === null,
    "no configured hosts is a no-op, not a global fetch wrap");
}


// --- hosts must keep growing after the first install --------------------------
// Facilitators register one at a time, so an install-once-then-ignore design
// would watch only whichever registered first: the wrapper would exist and
// quietly cover nothing. That is the failure mode this whole session keeps
// finding, so it gets an assertion rather than a comment.
{
  const { watchedHosts } = await import("../src/facilitator-diagnostics.js");
  installFacilitatorDiagnostics(["https://first.example/x"]);
  installFacilitatorDiagnostics(["https://second.example/y"]);
  const w = watchedHosts();
  ok(w.includes("first.example") && w.includes("second.example"),
    `a host registered AFTER the wrapper is installed is still watched (got ${w.join(",")})`);
}


// --- the facilitator must name itself in its own errors ----------------------
// The 2026-08-07 confusion: failures on Solana/Polygon/Arbitrum all read as
// Coinbase's words, though the boot log routes those to PayAI and only Base to
// CDP. Clients are tried in order, so the surfacing error is the FIRST client
// tried, not the chain's owner - unknowable without the label.
{
  const { labelFacilitatorErrors } = await import("../src/facilitator-diagnostics.js");
  const { isPreBroadcastSettleRejection } = await import("../src/payments.js");

  const client = {
    async settle() { throw new Error("Facilitator settle failed (402): payment-method-required"); },
    async verify() { return { ok: true }; },
  };
  labelFacilitatorErrors("CDP (Base)", client);

  let err = null;
  try { await client.settle(); } catch (e) { err = e; }
  ok(/^\[CDP \(Base\)\]/.test(err.message), `the error names the facilitator that threw it (got: ${err.message.slice(0, 40)})`);
  ok(err.__a402Facilitator === "CDP (Base)", "the label is also attached structurally, not only in prose");

  // The safety classification must survive the prefix. If it did not, a
  // pre-broadcast 402 would stop being re-settled through the fallback - a
  // silent revenue loss caused by a logging change.
  ok(isPreBroadcastSettleRejection(err) === true,
    "a prefixed 402 is STILL classified as a safe-to-retry pre-broadcast rejection");

  ok((await client.verify()).ok === true, "a successful call is passed through untouched");

  // Double-wrapping must not double-prefix, and an outer client must not
  // overwrite an inner one that already named itself.
  labelFacilitatorErrors("Solvador", client);
  let err2 = null;
  try { await client.settle(); } catch (e) { err2 = e; }
  ok((err2.message.match(/CDP \(Base\)/g) || []).length === 1 && !err2.message.includes("Solvador"),
    `first label wins and is applied once (got: ${err2.message.slice(0, 60)})`);
}

{
  // A label is a nicety; it must never turn a facilitator error into a
  // different failure.
  const { labelFacilitatorErrors } = await import("../src/facilitator-diagnostics.js");
  const frozen = Object.freeze(new Error("Facilitator settle failed (502): <html>"));
  const client = { async settle() { throw frozen; } };
  labelFacilitatorErrors("Frozen", client);
  let caught = null;
  try { await client.settle(); } catch (e) { caught = e; }
  ok(caught === frozen, "an unwritable error is rethrown unchanged rather than swallowed");
}


// --- we are logging a body we did not write ----------------------------------
// The excerpt goes straight into a log aggregator, from a host we authenticate
// to. An error page that echoes a request header or a signed payload would put
// a credential there permanently, so long hex/base64 runs are redacted. Nothing
// diagnostic is lost: a ray id is short, and no failure was ever explained by a
// 64-character blob.
{
  // The token fixture is SHAPE-ONLY, deliberately not a real JWT: a literal
  // eyJ-prefixed token in the repo trips our own gitleaks history scan, which
  // is exactly the rule working. The redaction is shape-based, so a synthetic
  // three-segment token exercises the same branch a real bearer token would.
  const fakeHex = "0x" + "ab".repeat(32);
  const fakeJwt = "hhhhhhhhhhhh.pppppppppppp.ssssssssssss";
  const secretish = `Error for key ${fakeHex} and token ${fakeJwt}`;
  const line = describeErrorResponse({ url: "https://f.example/settle", status: 502, headers: { server: "cloudflare" }, body: `<html><body>${secretish}</body></html>` });
  ok(!line.includes("abababab"), "a long hex run is redacted out of the logged excerpt");
  ok(!line.includes("pppppppppppp"), "a three-segment bearer-token shape is redacted too - the shape a plain long-run rule walks past");
  ok(line.includes("[redacted]"), "…and the redaction is visible rather than silent");
  ok(/Error for key/.test(line), "the surrounding words survive - the diagnosis is still readable");
  // A Cloudflare ray id is short and must NOT be swallowed by the redaction.
  const ray = describeErrorResponse({ url: "https://f.example/settle", status: 502, headers: { "cf-ray": "8f2c1d4e5a6b7c8d-ATL" }, body: "<html>Access denied</html>" });
  ok(ray.includes("8f2c1d4e5a6b7c8d-ATL"), "a ray id survives redaction - it is the thing a provider asks for");
}


// ---- one retry of a verify that died at the socket level ------------------
// (2026-09-02, seen twice in CI: a pooled keep-alive socket the facilitator
// closed during the post-listen stall; the verify was written to it and died
// UND_ERR_SOCKET with the facilitator having seen nothing, buyer told 402.)
{
  const { installFacilitatorDiagnostics, isRetryableFacilitatorRead, socketErrorCode } = await import("../src/facilitator-diagnostics.js");
  const sock = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  const hosts = new Set(["fac.example"]);
  ok(isRetryableFacilitatorRead("https://fac.example/verify", { method: "POST", body: "{}" }, sock(), hosts), "POST /verify + UND_ERR_SOCKET on a facilitator host is retryable");
  ok(isRetryableFacilitatorRead("https://fac.example/supported", { method: "GET" }, sock(), hosts), "GET /supported too");
  ok(!isRetryableFacilitatorRead("https://fac.example/settle", { method: "POST", body: "{}" }, sock(), hosts), "a SETTLE is never retried from here (it can move money)");
  ok(!isRetryableFacilitatorRead("https://other.example/verify", { method: "POST", body: "{}" }, sock(), hosts), "a non-facilitator host is never retried");
  ok(!isRetryableFacilitatorRead("https://fac.example/verify", { method: "POST", body: "{}" }, new Error("boom"), hosts), "a non-socket error is not retried");
  ok(!isRetryableFacilitatorRead("https://fac.example/verify", { method: "POST", body: new ReadableStream() }, sock(), hosts), "a stream body cannot be resent, so no retry");
  ok(socketErrorCode(sock()) === "UND_ERR_SOCKET" && socketErrorCode({ code: "ECONNRESET" }) === "ECONNRESET" && socketErrorCode(new Error("x")) === null, "the socket code is read from the error or its cause");
  const calls = []; const lines = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (first) { first = false; throw sock(); }
    return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const f = installFacilitatorDiagnostics(["https://fac.example"], { log: (l) => lines.push(l), fetchImpl });
  const r = await f("https://fac.example/verify", { method: "POST", body: "{}" });
  ok(r.status === 200 && calls.length === 2 && /retrying once/.test(lines[0] || ""), `a verify that died on the socket is resent once and the answer is the retry's (calls ${calls.length})`);
  calls.length = 0; first = true;
  let threw = null;
  try { await f("https://fac.example/settle", { method: "POST", body: "{}" }); } catch (e) { threw = e; }
  ok(threw && calls.length === 1, "the same failure on /settle propagates after ONE attempt");
  calls.length = 0;
  const twice = async () => { calls.push("x"); throw sock(); };
  const g = installFacilitatorDiagnostics(["https://fac.example"], { log: () => {}, fetchImpl: twice });
  let second = null;
  try { await g("https://fac.example/verify", { method: "POST", body: "{}" }); } catch (e) { second = e; }
  ok(second && calls.length === 2, "a verify that dies twice propagates after exactly two attempts (one retry, never a loop)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
