#!/usr/bin/env node
// The AWS Marketplace front door (/aws/<slug>, src/aws-marketplace-gate.js).
//
// Part 1, in this process, against a stub of the AWS Marketplace payment
// service's signing keys (a local JWKS) and a test quote key generated here:
//   - the settings: off without the key, off with a setting unusable;
//   - the 402 carries exactly one offer, `exact` on aws:base in iso4217:USD,
//     whose quote verifies against the published JWKS, and the same quote
//     with its price altered does not (and is refused as a payment);
//   - a valid payment token is served once and booked once, on the rail
//     "aws", its transaction the payment id;
//   - a replayed, expired or DPoP-unproven token is refused and not booked;
//   - an input refusal and a failed run leave the payment usable (bounded);
//   - an unpaid HEAD never runs the tool.
// Part 2, booted servers in paid mode: with the switch off /aws answers as an
// unknown path and the direct routes' 402s are byte-identical with the switch
// on; with it on, the bought call is served and booked once.
//
//   node scripts/test-aws-marketplace-gate.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, createSign, createVerify, createPublicKey, randomUUID } from "node:crypto";
import express from "express";
import { bootPaidServer } from "./lib/paid-boot.js";
import { notChargedOn } from "../src/not-charged.js";

const gateMod = await import("../src/aws-marketplace-gate.js");
const { awsMarketplaceConfig, awsMarketplaceConfigProblem, awsIneligibility, awsRoutes, createAwsPaymentClaims, createAwsMarketplaceGate, paymentJwksBase, AWS_DEFAULT_SLUGS } = gateMod;
const { PRIVATE_RAILS, COUNTED_RAILS, isCountedRail, isPaidRail, UNCOUNTED_PRIVATE_RAILS } = await import("../src/paid-rails.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const claimsOf = (jwt) => JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8"));
function signJwt(header, payload, privateKey) {
  const input = `${b64u(header)}.${b64u(payload)}`;
  const s = createSign("SHA256"); s.update(input);
  return `${input}.${s.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function verifyJwt(jwt, jwk) {
  const [h, p, sig] = String(jwt).split(".");
  const v = createVerify("SHA256"); v.update(`${h}.${p}`);
  return v.verify({ key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
}

// The quote-signing key (the seller's) and the stand-in payment service's key: both made here, never stored.
const seller = generateKeyPairSync("ec", { namedCurve: "P-256" });
const SELLER_PEM = seller.privateKey.export({ type: "pkcs8", format: "pem" });
const service = generateKeyPairSync("ec", { namedCurve: "P-256" });
const SERVICE_KID = "stub-service-1";
const serviceJwk = { ...service.publicKey.export({ format: "jwk" }), kid: SERVICE_KID, alg: "ES256", use: "sig" };
const ISSUER = "awsmp-agentpay.amazonaws.com";
const PRODUCT = "prod-testproduct01";

const jwksStub = createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [serviceJwk] })); }
  res.writeHead(404); res.end();
});
await new Promise((r) => jwksStub.listen(0, "127.0.0.1", r));
const JWKS_BASE = `http://127.0.0.1:${jwksStub.address().port}`;

function paymentToken(quoteToken, { id = `awsmp-${randomUUID()}`, expIn = 300, cnf = null, issuer = ISSUER } = {}) {
  const q = claimsOf(quoteToken);
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ alg: "ES256", kid: SERVICE_KID, typ: "JWT" }, { iss: issuer, sub: "buyer-test", aud: q.iss, iat: now - 1, exp: now + expIn, jti: id, payment_id: id, quote_token: quoteToken, ...(cnf ? { cnf } : {}) }, service.privateKey);
  return { token, id };
}
const paymentHeader = (required, token) => Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { paymentToken: token, paymentId: "buyer-set-anything" } })).toString("base64");
const readRequired = (r) => JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8"));

const ENV = { AWS_MARKETPLACE_QUOTE_KEY: Buffer.from(SELLER_PEM).toString("base64"), AWS_MARKETPLACE_QUOTE_KEY_ID: "quote-test-1", AWS_MARKETPLACE_PRODUCT_ID: PRODUCT, AWS_MARKETPLACE_SLUGS: "echo,flaky,binary,ident", AWS_MARKETPLACE_PAYMENT_JWKS_URL: JWKS_BASE };

// ---- settings ------------------------------------------------------------------
{
  ok(awsMarketplaceConfig({}, { baseUrl: "https://example.test" }) === null && awsMarketplaceConfigProblem({}) === null, "no quote key: the gate is off and nothing is said");
  for (const name of ["AWS_MARKETPLACE_QUOTE_KEY_ID", "AWS_MARKETPLACE_PRODUCT_ID"]) {
    const env = { ...ENV, [name]: "" };
    ok(awsMarketplaceConfig(env, { baseUrl: "https://example.test" }) === null && /missing/.test(awsMarketplaceConfigProblem(env)), `${name} missing: off, and the reason names it`);
  }
  ok(awsMarketplaceConfig({ ...ENV, AWS_MARKETPLACE_QUOTE_KEY: "not a key" }, { baseUrl: "https://example.test" }) === null, "a quote key that is not a PEM: off");
  ok(awsMarketplaceConfig({ ...ENV, AWS_MARKETPLACE_PRODUCT_ID: "12345" }, { baseUrl: "https://example.test" }) === null, "a product id that is not prod-...: off");
  ok(awsMarketplaceConfig({ ...ENV, AWS_MARKETPLACE_PAYMENT_JWKS_URL: "https://keys.example.test" }, { baseUrl: "https://example.test" }) === null, "payment-service keys read from a host that is not AWS's: off");
  ok(paymentJwksBase("https://agenticcommerce-marketplace.us-east-1.api.aws") === "https://agenticcommerce-marketplace.us-east-1.api.aws" && paymentJwksBase("http://127.0.0.1:9") === "http://127.0.0.1:9" && paymentJwksBase("http://10.0.0.1") === undefined, "the payment-service key host: AWS over https, or loopback");
  const cfg = awsMarketplaceConfig(ENV, { baseUrl: "https://example.test/x" });
  ok(cfg && cfg.serviceUrl === "https://example.test/aws" && cfg.productId === PRODUCT && cfg.quoteSeconds === 300 && cfg.retryMax === 2, "a usable configuration: the quote issuer is the origin plus /aws");
  const dflt = awsMarketplaceConfig({ ...ENV, AWS_MARKETPLACE_SLUGS: "" }, { baseUrl: "https://example.test" });
  ok(dflt && dflt.slugs.join(",") === AWS_DEFAULT_SLUGS.join(","), "with no slug list, the first listing is the default set");
}

// ---- eligibility ---------------------------------------------------------------
const handlerRuns = { echo: 0, flaky: 0 };
let flakyFailures = 0;
const DEFS = {
  "POST /api/echo": { route: "POST /api/echo", slug: "echo", name: "Echo", category: "text", price: "$0.003", description: "Echo text.", discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "hi" } }, handler: async (i) => { handlerRuns.echo++; return { echo: i.text }; } },
  "POST /api/flaky": { route: "POST /api/flaky", slug: "flaky", name: "Flaky", category: "text", price: "$0.002", description: "Fails on demand.", discovery: { inputSchema: { properties: { text: { type: "string" } } }, input: { text: "x" } }, handler: async (_i, req) => { handlerRuns.flaky++; if (flakyFailures > 0) { flakyFailures--; throw Object.assign(new Error(`upstream unavailable.${notChargedOn(req)} Retry shortly.`), { statusCode: 502 }); } return { fine: true }; } },
  "POST /api/binary": { route: "POST /api/binary", slug: "binary", name: "Binary", category: "media", price: "$0.002", mimeType: "image/png", description: "Bytes.", discovery: { input: {} }, handler: async () => ({}) },
  "POST /api/ident": { route: "POST /api/ident", slug: "ident", name: "Ident", category: "memory", price: "$0.002", description: "Wallet memory.", discovery: { input: {} }, handler: async () => ({}) },
};
{
  ok(awsIneligibility(DEFS["POST /api/echo"]) === null, "a fixed-price JSON tool is eligible");
  ok(/identity-bound/.test(awsIneligibility(DEFS["POST /api/ident"], { identityBound: true })), "an identity-bound route is refused");
  ok(/bytes/.test(awsIneligibility(DEFS["POST /api/binary"])), "a tool that answers bytes is refused");
  ok(/model/.test(awsIneligibility({ ...DEFS["POST /api/echo"], modelBacked: true })), "a model-backed tool is refused");
  ok(/model tier/.test(awsIneligibility({ ...DEFS["POST /api/echo"], category: "llm" })), "a model tier is refused");
  ok(/priced per request/.test(awsIneligibility({ ...DEFS["POST /api/echo"], quote: () => 0.01 })), "a tool priced per request is refused");
  ok(/outlives/.test(awsIneligibility(DEFS["POST /api/echo"], { lastingEffect: true })) && /outside seller/.test(awsIneligibility(DEFS["POST /api/echo"], { paysThirdParty: true })) && /long-running/.test(awsIneligibility(DEFS["POST /api/echo"], { longRunning: true })), "lasting effect, outside seller and long-running are refused");
  ok(/own host/.test(awsIneligibility({ ...DEFS["POST /api/echo"], discovery: { input: { url: "https://agent402.tools/x" } } }, {}, { ownHosts: ["agent402.tools"] })), "a tool whose example names this host is refused");
}

// ---- the rail ------------------------------------------------------------------
ok(PRIVATE_RAILS.includes("aws") && UNCOUNTED_PRIVATE_RAILS.includes("aws") && !COUNTED_RAILS.includes("aws") && !isCountedRail("aws") && !isPaidRail("aws"), "aws is a private rail that no public figure counts and no paying-rail reader sees");
ok(isCountedRail("referral") && PRIVATE_RAILS.includes("referral"), "referral keeps its place: private and counted");

// ---- the gate in this process ---------------------------------------------------
const config = awsMarketplaceConfig(ENV, { baseUrl: "http://127.0.0.1:1" });
const routes = awsRoutes(config, DEFS, (d) => ({ identityBound: d.slug === "ident" }), { ownHosts: ["agent402.tools"] });
ok(routes.defs.size === 2 && routes.refused.length === 2 && routes.refused.every((r) => r.reason), "boot checks: two listed tools served, two refused with a reason");
const sales = [];
const claims = createAwsPaymentClaims({ log: () => {} });
const gate = await createAwsMarketplaceGate({
  config, defs: routes.defs, claims,
  recordSale: (row) => { sales.push(row); },
  preValidate: (def, req) => (def.slug === "echo" && !(req.body && typeof req.body.text === "string") ? { status: 400, body: { error: "Missing required parameter: text", howToCall: { url: "https://agent402.tools/api/echo" }, docs: "https://agent402.tools/docs" } } : null),
  ownHosts: ["agent402.tools"], log: () => {},
});
const app = express();
app.use(express.json());
app.all(["/aws", "/aws/:slug"], (req, res, next) => gate.handler(req, res, next));
app.use((req, res) => res.status(404).json({ error: "not found" }));
const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

async function quote(path = "/aws/echo") {
  const r = await post(path, undefined);
  return { r, required: r.status === 402 ? readRequired(r) : null };
}

{
  const { r, required } = await quote();
  ok(r.status === 402 && required, "an unpaid request with no input: 402 with PAYMENT-REQUIRED");
  const a = required.accepts;
  ok(a.length === 1 && a[0].scheme === "exact" && a[0].network === "aws:base" && a[0].asset === "iso4217:USD" && a[0].amount === "0.003" && a[0].payTo === "urn:x402:agentic-commerce:see-quote", "one offer only: exact on aws:base, USD, the list price, the product inside the quote");
  const body = await r.text();
  const resourceUrl = new URL(required.resource.url);
  ok(JSON.stringify(JSON.parse(body)) === JSON.stringify({ error: "Payment required" }) && resourceUrl.origin === BASE && resourceUrl.pathname === "/aws/echo" && required.extensions === undefined, "the 402 body is the bare refusal, its resource is the route itself, and it declares no extension");
  const q = a[0].extra.quoteToken;
  const claims0 = claimsOf(q);
  ok(claims0.iss === config.serviceUrl && claims0.aud === "aws:marketplace" && claims0.price?.amount === "0.003" && claims0.price?.currency === "USD" && claims0.settlement?.product_id === PRODUCT && claims0.payTo === PRODUCT && claims0.network === "aws:base" && claims0.scheme === "exact" && claims0.reference === "echo", "the quote's claims: issuer, audience, price, product, scheme, network, route");
  const jwk = gate.jwks.keys.find((k) => k.kid === "quote-test-1");
  ok(jwk && !("d" in jwk), "the published JWKS holds the quote key's public half under its key id");
  ok(verifyJwt(q, jwk), "a signed quote verifies against the published key");
  const [h, , sig] = q.split(".");
  const altered = `${h}.${b64u({ ...claims0, price: { amount: "0.0001", currency: "USD" } })}.${sig}`;
  ok(!verifyJwt(altered, jwk), "the same quote with its price altered does not verify");
  // ... and paying with it is refused, nothing run or booked.
  const before = handlerRuns.echo;
  const { token } = paymentToken(altered);
  const paid = await post("/aws/echo", { text: "hi" }, { "payment-signature": paymentHeader(required, token) });
  ok(paid.status === 402 && handlerRuns.echo === before && sales.length === 0, "a payment carrying the altered quote: refused (402), not run, not booked");
}

{
  const { required } = await quote();
  const { token, id } = paymentToken(required.accepts[0].extra.quoteToken);
  const hdr = paymentHeader(required, token);
  const r = await post("/aws/echo", { text: "hello" }, { "payment-signature": hdr });
  const j = await r.json();
  await new Promise((res) => setTimeout(res, 20));
  ok(r.status === 200 && j.echo === "hello", "a valid payment token: served");
  ok(sales.length === 1 && sales[0].tx === id && sales[0].rail === "aws" && sales[0].network === "aws:base" && sales[0].priceUsd === 0.003 && sales[0].payer === null && sales[0].slug === "echo", "booked once: rail aws, the payment id as the transaction, the list price, no payer");
  const pr = r.headers.get("payment-response");
  ok(pr && JSON.parse(Buffer.from(pr, "base64").toString("utf8")).transaction === id, "the receipt names the payment id");
  const runs = handlerRuns.echo;
  const again = await post("/aws/echo", { text: "hello" }, { "payment-signature": hdr });
  const aj = await again.json();
  await new Promise((res) => setTimeout(res, 20));
  ok(again.status === 409 && aj.errorReason === "payment_replayed" && handlerRuns.echo === runs && sales.length === 1, "the same payment again: refused (409), not run, not booked again");
}

{
  const { required } = await quote();
  const { token } = paymentToken(required.accepts[0].extra.quoteToken, { expIn: -30 });
  const runs = handlerRuns.echo;
  const r = await post("/aws/echo", { text: "x" }, { "payment-signature": paymentHeader(required, token) });
  ok(r.status === 402 && readRequired(r).error === "payment_expired" && handlerRuns.echo === runs && sales.length === 1, "an expired payment token: 402 payment_expired, not run, not booked");
  const forged = paymentToken(required.accepts[0].extra.quoteToken, { issuer: "someone-else" });
  const f = await post("/aws/echo", { text: "x" }, { "payment-signature": paymentHeader(required, forged.token) });
  ok(f.status === 402 && handlerRuns.echo === runs && sales.length === 1, "a token from another issuer: refused, not run, not booked");
}

{
  // A DPoP-bound token without its proof, then with one.
  const buyer = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const bj = buyer.publicKey.export({ format: "jwk" });
  const jkt = createHash("sha256").update(JSON.stringify({ crv: bj.crv, kty: bj.kty, x: bj.x, y: bj.y })).digest("base64url");
  const { required } = await quote();
  const { token, id } = paymentToken(required.accepts[0].extra.quoteToken, { cnf: { jkt } });
  const runs = handlerRuns.echo;
  const r = await post("/aws/echo", { text: "p" }, { "payment-signature": paymentHeader(required, token) });
  ok(r.status === 402 && readRequired(r).error === "dpop_required" && handlerRuns.echo === runs, "a key-bound token with no DPoP proof: refused before verification, not run");
  const proof = signJwt({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: bj.kty, crv: bj.crv, x: bj.x, y: bj.y } }, { jti: randomUUID(), htm: "POST", htu: `${BASE}/aws/echo`, iat: Math.floor(Date.now() / 1000), ath: createHash("sha256").update(token).digest("base64url") }, buyer.privateKey);
  const p = await post("/aws/echo", { text: "p" }, { "payment-signature": paymentHeader(required, token), dpop: proof });
  await new Promise((res) => setTimeout(res, 20));
  ok(p.status === 200 && sales.some((s) => s.tx === id), "with its proof: served and booked");
}

{
  // Input refused before the run: the payment stays usable.
  const { required } = await quote();
  const { token, id } = paymentToken(required.accepts[0].extra.quoteToken);
  const hdr = paymentHeader(required, token);
  const runs = handlerRuns.echo;
  const r = await post("/aws/echo", { nope: 1 }, { "payment-signature": hdr });
  const j = await r.json();
  ok(r.status === 400 && j.paymentUsed === false && handlerRuns.echo === runs && !("howToCall" in j) && !("docs" in j), "a paid request with an input refused: 400, payment not used, nothing pointing elsewhere");
  const good = await post("/aws/echo", { text: "fixed" }, { "payment-signature": hdr });
  await new Promise((res) => setTimeout(res, 20));
  ok(good.status === 200 && sales.filter((s) => s.tx === id).length === 1, "the same payment with the input corrected: served and booked once");
}

{
  // A run that fails gives the payment back, at most retryMax times.
  const { required } = await quote("/aws/flaky");
  const { token, id } = paymentToken(required.accepts[0].extra.quoteToken);
  const hdr = paymentHeader(required, token);
  flakyFailures = 1;
  const r1 = await post("/aws/flaky", { text: "a" }, { "payment-signature": hdr });
  const j1 = await r1.json();
  ok(r1.status === 502 && j1.paymentUsed === false && j1.attemptsLeft === 2, "a failed run: the error, and the payment usable for two more attempts");
  // The payment was taken before the handler ran: a handler's "Nothing was
  // charged" (src/not-charged.js, printed on a route call) is not passed on.
  ok(j1.error === "upstream unavailable. Retry shortly." && !/charged/i.test(JSON.stringify(j1)), `a failed run's error drops the handler's not-charged sentence (${j1.error})`);
  const r2 = await post("/aws/flaky", { text: "a" }, { "payment-signature": hdr });
  await new Promise((res) => setTimeout(res, 20));
  ok(r2.status === 200 && sales.filter((s) => s.tx === id).length === 1, "the resend: served and booked once");

  const second = await quote("/aws/flaky");
  const t2 = paymentToken(second.required.accepts[0].extra.quoteToken);
  const h2 = paymentHeader(second.required, t2.token);
  flakyFailures = 5;
  const outs = [];
  const bodies = [];
  for (let i = 0; i < 4; i++) { const r = await post("/aws/flaky", { text: "b" }, { "payment-signature": h2 }); outs.push(r.status); bodies.push(await r.json().catch(() => ({}))); }
  await new Promise((res) => setTimeout(res, 20));
  ok(outs.join(",") === "502,502,502,409" && !sales.some((s) => s.tx === t2.id), "three failed attempts spend it: the fourth is refused, nothing booked");
  ok(bodies[2].paymentUsed === true && !/\b(?:not|never) charged\b|nothing (?:was|is) charged/i.test(JSON.stringify(bodies[2])), "the attempt that spends the payment says it was used and never that nothing was charged");
  ok(gate.failed().some((f) => f.paymentId === t2.id) && gate.stats().chargedWithoutAnswer === 1, "the spent payment is on the operator record of paid runs without an answer");
  flakyFailures = 0;
}

{
  const runs = handlerRuns.echo;
  const h = await fetch(`${BASE}/aws/echo`, { method: "HEAD" });
  ok(h.status === 405 && h.headers.get("allow") === "POST" && handlerRuns.echo === runs, "an unpaid HEAD: 405, the tool not run");
  const g = await fetch(`${BASE}/aws/echo`);
  ok(g.status === 405, "a GET of a POST tool: 405");
  const bad = await post("/aws/echo", { nope: 1 });
  const bj = await bad.json();
  ok(bad.status === 400 && !bad.headers.get("payment-required") && !("howToCall" in bj), "an unpaid request with an input that cannot run: 400 before any quote");
  const bare = await quote("/aws");
  ok(bare.r.status === 402 && bare.required.accepts[0].extra.quoteToken && claimsOf(bare.required.accepts[0].extra.quoteToken).reference === "echo", "the endpoint URL itself answers 402 (the first listed tool)");
  const nope = await post("/aws/binary", {});
  ok(nope.status === 404, "a refused slug is not served");
  const cased = await post("/AWS/echo", {});
  ok(cased.status === 404, "only the canonical spelling is served");
}

{
  // The shared record over a Redis-shaped client: one claim per payment id across two instances.
  const store = new Map();
  const fake = { async set(k, v, o) { if (o?.NX && store.has(k)) return null; store.set(k, v); return "OK"; }, async incr(k) { const n = (Number(store.get(k)) || 0) + 1; store.set(k, String(n)); return n; }, async pExpire() { return 1; }, async del(k) { return store.delete(k) ? 1 : 0; } };
  const a = createAwsPaymentClaims({ getClient: async () => fake, log: () => {} });
  const b = createAwsPaymentClaims({ getClient: async () => fake, log: () => {} });
  const until = Date.now() + 60_000;
  ok((await a.begin("p1", until, 0)) === "ok" && (await b.begin("p1", until, 0)) === "used", "one payment id, two instances: the second is refused");
  ok((await a.seenProof("j1")) === false && (await b.seenProof("j1")) === true, "a DPoP proof id is recorded once across instances");
  const broken = createAwsPaymentClaims({ getClient: async () => ({ set: async () => { throw new Error("down"); } }), log: () => {} });
  ok((await broken.begin("p2", until, 0)) === "ok" && (await broken.begin("p2", until, 0)) === "used", "Redis failing: this process's record still takes each payment once");
}
await new Promise((r) => srv.close(r));

// ===============================================================================
// Part 2: booted servers
// ===============================================================================
const SERVER_ENV = { AWS_MARKETPLACE_QUOTE_KEY: ENV.AWS_MARKETPLACE_QUOTE_KEY, AWS_MARKETPLACE_QUOTE_KEY_ID: "quote-test-1", AWS_MARKETPLACE_PRODUCT_ID: PRODUCT, AWS_MARKETPLACE_SLUGS: "redact,sql-guard", AWS_MARKETPLACE_PAYMENT_JWKS_URL: JWKS_BASE };
const BLANK = Object.fromEntries(Object.keys(SERVER_ENV).map((k) => [k, ""]));
const OP = "test-operator-token-aws-gate-0001";
// The direct routes compared with the switch off and on: unpaid, bare and with input, both verbs.
const DIRECT = [["POST", "/api/redact", { text: "call 555-0100" }], ["POST", "/api/redact", undefined], ["POST", "/api/sql-guard", { sql: "select 1" }], ["GET", "/api/uuid", undefined], ["POST", "/api/email-guard", { email: "a@b.test" }]];
async function snapshot(url) {
  const out = [];
  for (const [method, path, body] of DIRECT) {
    const r = await fetch(`${url}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const headers = [...r.headers.entries()].filter(([k]) => !["date", "x-request-id", "x-response-time", "etag", "server-timing", "connection", "keep-alive"].includes(k)).sort();
    out.push({ status: r.status, headers, body: await r.text() });
  }
  return out;
}
const off = await bootPaidServer({ label: "aws-off", env: { ...BLANK, AGENT402_OPERATOR_TOKEN: OP } });
let on = null;
try {
  for (const p of ["/aws", "/aws/redact", "/aws/.well-known/jwks.json"]) {
    const r = await fetch(`${off.url}${p}`, { method: p === "/aws/redact" ? "POST" : "GET" });
    const unknown = await fetch(`${off.url}/zz-not-a-route`, { method: p === "/aws/redact" ? "POST" : "GET" });
    ok(r.status === 404 && unknown.status === 404 && (await r.text()).replace(/\/aws[^"]*/g, "") === (await unknown.text()).replace(/\/zz-not-a-route/g, ""), `switch off: ${p} answers as an unknown path`);
  }
  const offOp = await (await fetch(`${off.url}/__operator/aws.json`, { headers: { "x-operator-token": OP } })).json();
  ok(offOp.enabled === false, "switch off: the operator view says so");
  const snapOff = await snapshot(off.url);
  const snapOff2 = await snapshot(off.url);
  ok(JSON.stringify(snapOff) === JSON.stringify(snapOff2), "control: the direct routes' 402s are stable between two reads");

  on = await bootPaidServer({ label: "aws-on", env: { ...SERVER_ENV, AGENT402_OPERATOR_TOKEN: OP } });
  const snapOn = await snapshot(on.url);
  const same = snapOn.every((s, i) => s.status === snapOff[i].status && JSON.stringify(s.headers) === JSON.stringify(snapOff[i].headers) && s.body === snapOff[i].body);
  ok(same && snapOn.some((s) => s.status === 402), "switch on: every direct route's 402 (status, headers, body) is byte-identical to the switch off");
  const offers = snapOn.flatMap((s) => { const h = s.headers.find(([k]) => k === "payment-required"); return h ? JSON.parse(Buffer.from(h[1], "base64").toString("utf8")).accepts : []; });
  ok(offers.length > 0 && offers.every((a) => a.network !== "aws:base" && a.asset !== "iso4217:USD"), "and no direct 402 carries the AWS offer");

  const jw = await fetch(`${on.url}/aws/.well-known/jwks.json`);
  const jwks = await jw.json();
  ok(jw.status === 200 && jwks.keys?.[0]?.kid === "quote-test-1" && !("d" in jwks.keys[0]), "switch on: the JWKS is served with the public key only");
  const q = await fetch(`${on.url}/aws/redact`, { method: "POST" });
  ok(q.status === 402, "switch on: an unpaid /aws/redact is a 402");
  const required = readRequired(q);
  ok(required.accepts.length === 1 && required.accepts[0].network === "aws:base", "with the AWS offer only");
  const { token } = paymentToken(required.accepts[0].extra.quoteToken);
  const hdr = paymentHeader(required, token);
  const paid = await fetch(`${on.url}/aws/redact`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": hdr }, body: JSON.stringify({ text: "call 555-0100 now" }) });
  const pj = await paid.json();
  ok(paid.status === 200 && typeof JSON.stringify(pj) === "string", "a valid payment: the tool's answer");
  const again = await fetch(`${on.url}/aws/redact`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": hdr }, body: JSON.stringify({ text: "call 555-0100 now" }) });
  ok(again.status === 409, "the same payment again: 409");
  await new Promise((r) => setTimeout(r, 200));
  const opv = await (await fetch(`${on.url}/__operator/aws.json`, { headers: { "x-operator-token": OP } })).json();
  ok(opv.enabled === true && opv.sinceBoot.booked === 1 && opv.sinceBoot.served === 1 && opv.sinceBoot.replayed === 1, "booked once, served once, the replay counted");
  const opNo = await fetch(`${on.url}/__operator/aws.json`);
  ok(opNo.status === 404, "the operator view without the token: 404");
  const pricing = await (await fetch(`${on.url}/api/pricing`)).text();
  ok(!pricing.includes("aws:base") && !pricing.includes("/aws/redact"), "the public pricing names no AWS route or network");
} finally {
  await off.stop();
  if (on) await on.stop();
  await new Promise((r) => jwksStub.close(r));
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
