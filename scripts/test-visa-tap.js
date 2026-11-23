#!/usr/bin/env node
// Trusted Agent Protocol signatures from Visa CLI agents (src/web-bot-auth.js,
// tags agent-browser-auth and agent-payer-auth): a label only.
//
// Offline, with a stub registry: each profile verifies once its key is cached
// and names the agent; each rule refuses its case (window per profile, created
// ahead, expired, components not covered, a payment header not covered, a
// credential covered by the identity profile, another algorithm, a keyid that
// is not a thumbprint, a Signature-Agent outside the two directory origins, the
// Host header in place of BASE_URL, an altered body against Content-Digest, a
// body over 1 MiB, a replayed nonce, a nonce store that does not answer, a
// registry that refuses, a simulated or inactive listing, a key whose
// thumbprint is not the keyid); the registry is the pinned origin, read in the
// background at most 60 s, 4 at once and 30 a minute, and no check waits on it.
// The middleware hashes the body as the body parser reads it (the parser still
// gets every byte) and always continues.
// Then a paid boot with WEB_BOT_AUTH=on whose registry reads come from a
// preload: a verified signature (the analytics rollup says so: the control)
// gets the same answers as no signature on a proof-of-work tool, a paid tool
// and an identity-bound route. And no module but web-bot-auth.js reads the
// label.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as wba from "../src/web-bot-auth.js";
import { createMemoryLimits } from "../src/shared-limits.js";
import { bootPaidServer } from "./lib/paid-boot.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const X = publicKey.export({ format: "jwk" }).x;
const JKT = wba.ed25519Thumbprint(X);
const other = generateKeyPairSync("ed25519");
const pemB64 = (k) => Buffer.from(k.export({ format: "pem", type: "spki" })).toString("base64");
const listing = ({ jkt = JKT, key = publicKey, isActive = true, simulated, status = "active", algorithm = "ed25519", expirationDate = "2099-01-01T00:00:00.000Z" } = {}) => JSON.stringify({
  id: "agent-1", name: "Test agent", isActive, ...(simulated ? { simulated: true } : {}),
  keys: [{ id: "k1", directory: { directoryOrigin: "https://agenticdirectory.visa.com" }, agentId: "agent-1", keyName: jkt, status, algorithm, publicKey: pemB64(key), jkt, expirationDate }],
});
const ORIGIN = { authority: "agent402.example.test", scheme: "https" };
let clock = Date.UTC(2026, 10, 22, 12, 0, 0);
const now = () => clock;
const nowS = () => Math.floor(clock / 1000);
const digestOf = (body) => `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

/** A request signed as a TAP agent would sign it. */
function tap({ tag = "agent-browser-auth", method = "GET", path = "/api/pricing", query = "", body = "", authority = ORIGIN.authority, host = authority, created = nowS(), expires, keyid = JKT, alg = "ed25519", nonce = randomBytes(32).toString("base64"), key = privateKey, components, extraHeaders = {}, digest, signatureAgent, alterBody } = {}) {
  const exp = expires ?? created + (tag === "agent-browser-auth" ? 60 : 480);
  const headers = { host, ...extraHeaders };
  if (body || tag === "agent-browser-auth" || digest) headers["content-digest"] = digest ?? digestOf(body);
  if (body) headers["content-length"] = String(Buffer.byteLength(body));
  if (signatureAgent) headers["signature-agent"] = `sig2=${signatureAgent}`;
  const comps = components || (tag === "agent-browser-auth"
    ? ["@method", "@scheme", "@authority", "@path", "@query", "content-digest"]
    : ["@method", "@authority", "@path", ...(body ? ["content-digest"] : []), ...Object.keys(extraHeaders).filter((h) => ["authorization", "payment-signature", "x-payment"].includes(h))]);
  const value = (c) => {
    if (c === "@method") return method;
    if (c === "@scheme") return ORIGIN.scheme;
    if (c === "@authority") return authority;
    if (c === "@path") return path;
    if (c === "@query") return query || "?";
    return headers[c];
  };
  const params = `;created=${created};expires=${exp};keyid="${keyid}"${alg ? `;alg="${alg}"` : ""}${nonce ? `;nonce="${nonce}"` : ""};tag="${tag}"`;
  const inner = `(${comps.map((c) => `"${c}"`).join(" ")})${params}`;
  const base = [...comps.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${inner}`].join("\n");
  const sig = cryptoSign(null, Buffer.from(base), key).toString("base64");
  return { req: { method, originalUrl: `${path}${query}`, protocol: "http", headers: { ...headers, "signature-input": `sig2=${inner}`, signature: `sig2=:${sig}:` } }, body: alterBody ?? body };
}

function verifier({ listings = { [JKT]: listing() }, store = createMemoryLimits(), fetched = [], notes = [], maxAgeS = 60, fetchImpl } = {}) {
  const v = wba.createWebBotAuth({
    now, note: (n) => notes.push(n), nonceStore: store, origin: () => ORIGIN,
    fetchDirectory: async () => { throw new Error("no directory reads here"); },
    fetchRegistryKey: fetchImpl || (async (url) => { fetched.push(url); const id = url.split("/").pop(); if (!listings[id]) throw new Error("404"); return { text: listings[id], maxAgeS }; }),
  });
  return { v, fetched, notes, store };
}
const check = (v, t) => v.checkTap(t.req, Buffer.from(t.body));

// --- the two profiles --------------------------------------------------------------
{
  const { v, fetched } = verifier();
  let r = await check(v, tap());
  ok(r.verified === false && r.reason === "tap-registry-pending", `first sight of a key: unverified, registry read scheduled (${r.reason})`);
  await tick();
  ok(fetched.length === 1 && fetched[0] === `https://auth.visacli.sh/v1/tap/registry/keys/${JKT}`, `the key is read from the pinned registry origin by its thumbprint (${fetched[0]})`);
  r = await check(v, tap());
  ok(r.verified === true && r.agent === "visa-cli" && r.agentId === "agent-1" && r.keyid === JKT && r.tag === "agent-browser-auth" && r.directory === "production", `agent-browser-auth verifies and names the agent (${JSON.stringify(r)})`);
  const body = JSON.stringify({ q: "paid" });
  r = await check(v, tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, extraHeaders: { authorization: "Payment abc" } }));
  ok(r.verified === true && r.tag === "agent-payer-auth", `agent-payer-auth verifies over the body and the payment credential (${r.reason || "ok"})`);
  r = await check(v, tap({ tag: "agent-payer-auth" }));
  ok(r.verified === true, `agent-payer-auth with no body needs no Content-Digest (${r.reason || "ok"})`);
  ok((await check(v, tap({ query: "?a=1" }))).verified === true, "the query is covered as sent");
  ok((await check(v, tap({ alg: null }))).verified === true, "alg may be omitted");

  const refuses = async (t, reason, m) => { const x = await check(v, t); ok(x.verified === false && x.reason === reason, `${m} (${x.reason})`); };
  await refuses(tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, alterBody: body.replace("paid", "free") }), "tap-digest-mismatch", "a body other than the one digested is refused");
  await refuses(tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, digest: digestOf("other") }), "tap-digest-mismatch", "a Content-Digest of another body is refused (the signature itself is good)");
  await refuses(tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, components: ["@method", "@authority", "@path"] }), "tap-component-not-covered", "a request with a body whose digest is not covered is refused");
  await refuses(tap({ tag: "agent-payer-auth", extraHeaders: { authorization: "Payment abc" }, components: ["@method", "@authority", "@path"] }), "tap-payment-header-not-covered", "a payment credential header not covered is refused");
  await refuses(tap({ tag: "agent-payer-auth", extraHeaders: { "x-payment": "abc" }, components: ["@method", "@authority", "@path"] }), "tap-payment-header-not-covered", "and the same for X-PAYMENT");
  await refuses(tap({ extraHeaders: { authorization: "Bearer t" }, components: ["@method", "@scheme", "@authority", "@path", "@query", "content-digest", "authorization"] }), "tap-credential-covered", "the identity profile never covers a credential");
  await refuses(tap({ components: ["@method", "@authority", "@path", "content-digest"] }), "tap-component-not-covered", "the identity profile must cover @scheme and @query");
  await refuses(tap({ created: nowS() - 5, expires: nowS() + 56 }), "tap-window-too-long", "agent-browser-auth over 60 s is refused");
  ok((await check(v, tap({ tag: "agent-payer-auth", created: nowS() - 10, expires: nowS() + 470 }))).verified === true, "agent-payer-auth at 480 s verifies");
  await refuses(tap({ tag: "agent-payer-auth", created: nowS() - 10, expires: nowS() + 471 }), "tap-window-too-long", "agent-payer-auth over 480 s is refused");
  await refuses(tap({ created: nowS() + 31 }), "tap-created-in-future", "created more than 30 s ahead is refused");
  await refuses(tap({ created: nowS() - 70, expires: nowS() - 10 }), "tap-expired", "an expired signature is refused");
  await refuses(tap({ alg: "rsa-pss-sha512" }), "tap-unsupported-alg", "another algorithm is not read");
  await refuses(tap({ keyid: "7734ef13-4c78-47dc-ba49-fadc72537282" }), "tap-unsupported-keyid", "a keyid that is not a thumbprint is not read");
  await refuses(tap({ nonce: null }), "tap-no-nonce", "the identity profile needs a nonce");
  await refuses(tap({ key: other.privateKey }), "tap-bad-signature", "a signature by another key fails");
  await refuses(tap({ signatureAgent: '"https://evil.example.test"' }), "tap-signature-agent-not-allowed", "a Signature-Agent outside the directory origins is refused, never fetched");
  ok((await check(v, tap({ signatureAgent: '"https://agenticdirectory.visa.com"', components: ["@method", "@scheme", "@authority", "@path", "@query", "content-digest", "signature-agent"] }))).verified === true, "a Signature-Agent naming the directory is accepted");
  ok(fetched.length === 1, `no Signature-Agent URL was ever fetched (${fetched.length} registry read)`);
  // @authority is BASE_URL's: a request signed for the Host it was sent with, but not for us, fails.
  await refuses(tap({ authority: "evil.example.test" }), "tap-bad-signature", "a signature over another authority fails, whatever the Host header says");
  ok((await check(v, tap({ host: "evil.example.test" }))).verified === true, "the Host header is not read: a request signed for BASE_URL's authority verifies");
  const nonce = randomBytes(32).toString("base64");
  ok((await check(v, tap({ nonce }))).verified === true && (await check(v, tap({ nonce }))).reason === "tap-replayed", "a nonce is accepted once");
  const big = "x".repeat(wba.TAP_BODY_MAX + 1);
  await refuses(tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body: big }), "tap-body-too-large", "a body over 1 MiB is not hashed");
  ok((await v.checkTap({ headers: { "signature-input": "((((", signature: "x" } })).verified === false, "malformed headers are refused without throwing");
}
{
  // The nonce store: a store that does not answer leaves the request unverified.
  for (const [name, store] of [["answers not ok", { counterAdd: async () => ({ ok: false, error: "down" }) }], ["throws", { counterAdd: async () => { throw new Error("down"); } }]]) {
    const { v } = verifier({ store });
    await check(v, tap()); await tick();
    const r = await check(v, tap());
    ok(r.verified === false && r.reason === "tap-nonce-store-unavailable", `a nonce store that ${name}: unverified (${r.reason})`);
  }
}
{
  // The registry: refusals, listings that do not count, and the cache bound.
  const bad = {
    "refuses (404)": null,
    simulated: listing({ simulated: true }),
    inactive: listing({ isActive: false }),
    "a revoked key": listing({ status: "revoked" }),
    "an expired key": listing({ expirationDate: "2020-01-01T00:00:00.000Z" }),
    "another algorithm": listing({ algorithm: "ecdsa-p256-sha256" }),
    "a key whose thumbprint is not the keyid": listing({ key: other.publicKey }),
    "not JSON": "<html>",
  };
  for (const [name, text] of Object.entries(bad)) {
    const { v } = verifier({ listings: text == null ? {} : { [JKT]: text } });
    await check(v, tap()); await tick();
    const r = await check(v, tap());
    ok(r.verified === false && r.reason === "tap-unknown-key", `a registry listing that is ${name}: unverified (${r.reason})`);
  }
  const { v, fetched } = verifier();
  await check(v, tap()); await tick();
  ok((await check(v, tap())).verified === true, "cached key verifies");
  clock += 60_001;
  ok((await check(v, tap())).reason === "tap-registry-pending" && (await tick(), fetched.length === 2), "a key is cached at most 60 s, then read again");
  ok((await check(v, tap())).verified === true, "and verifies once read again");
  const short = verifier({ maxAgeS: 10 });
  await check(short.v, tap()); await tick();
  clock += 10_001;
  ok((await check(short.v, tap())).reason === "tap-registry-pending", "a shorter max-age from the registry is kept");
  // Bounded reads, never awaited by a request.
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const slow = verifier({ fetchImpl: async () => { calls++; await gate; throw new Error("404"); } });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await check(slow.v, tap({ keyid: wba.ed25519Thumbprint(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x) }));
  ok(performance.now() - t0 < 1_000, "checks never wait on a registry read");
  await tick(5);
  ok(calls === 4, `at most 4 registry reads at once (${calls})`);
  release(); await tick();
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 4; i++) await check(slow.v, tap({ keyid: wba.ed25519Thumbprint(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x) }));
    await tick(5);
  }
  ok(calls === Math.floor(wba.TAP_FETCH_PER_MIN / 2), `keys never seen before take at most half the minute's registry reads (${calls})`);
}
// A flood of keys never seen cannot starve the refresh of a key that verified before.
{
  const { v, fetched } = verifier();
  await check(v, tap()); await tick();
  ok((await check(v, tap())).verified === true, "setup: a known key verifies");
  clock += 60_001; // its cache entry is now stale
  for (let i = 0; i < wba.TAP_FETCH_PER_MIN * 2; i++) { await check(v, tap({ keyid: wba.ed25519Thumbprint(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x) })); await tick(); }
  const before = fetched.length;
  await check(v, tap()); await tick();
  ok(fetched.length === before + 1 && (await check(v, tap())).verified === true, `after a flood of unknown keys, the known key is still read again and verifies (${fetched.length - before} read)`);
}

// --- the middleware: a passive tap on the body, never refusing --------------------
{
  const express = (await import("express")).default;
  const { v, notes } = verifier();
  await check(v, tap()); await tick();
  const app = express();
  app.use(v.middleware());
  app.use(express.json());
  const seen = [];
  app.all("/api/x", (req, res) => { seen.push(req); res.json({ echo: req.body ?? null }); });
  app.get("/api/pricing", (req, res) => { seen.push(req); res.json({ ok: true }); });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const at = `http://127.0.0.1:${srv.address().port}`;
  try {
    const body = JSON.stringify({ q: "x".repeat(70_000) });
    const t = tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, extraHeaders: { "content-type": "application/json" } });
    const { host: _h, "content-length": _l, ...headers } = t.req.headers;
    const r = await fetch(`${at}/api/x`, { method: "POST", headers, body });
    const j = await r.json();
    await tick(30);
    ok(r.status === 200 && j.echo?.q?.length === 70_000, "the body parser still reads the whole body");
    ok(seen[0]?.webBotAuth?.verified === true && seen[0]?.visaCliAgent?.agentId === "agent-1", `a verified payer signature over a streamed body sets the label (${JSON.stringify(seen[0]?.webBotAuth)})`);
    const t2 = tap({ tag: "agent-payer-auth", method: "POST", path: "/api/x", body, extraHeaders: { "content-type": "application/json" } });
    const { host: _h2, "content-length": _l2, ...h2 } = t2.req.headers;
    const r2 = await fetch(`${at}/api/x`, { method: "POST", headers: h2, body: body.replace("x", "y") });
    await r2.arrayBuffer(); await tick(30);
    ok(r2.status === 200 && seen[1]?.webBotAuth?.reason === "tap-digest-mismatch" && seen[1]?.visaCliAgent === undefined, `an altered body is served the same and not labeled (${seen[1]?.webBotAuth?.reason})`);
    const g = tap();
    const { host: _h3, ...h3 } = g.req.headers;
    const r3 = await fetch(`${at}/api/pricing`, { headers: h3 });
    await r3.arrayBuffer(); await tick(30);
    ok(r3.status === 200 && seen[2]?.webBotAuth?.verified === true, "a signed GET with no body is labeled");
    const r4 = await fetch(`${at}/api/pricing`, { headers: { ...h3, signature: "sig2=:AAAA:" } });
    ok(r4.status === 200, "a bad signature is served exactly the same");
    ok(notes.some((n) => n.verified && n.agent === "visa-cli") && notes.some((n) => !n.verified && n.reason === "tap-digest-mismatch"), "outcomes are counted for analytics, unverified ones without an agent");
  } finally { srv.close(); }
}

// --- nothing reads the label --------------------------------------------------------
{
  const src = new URL("../src/", import.meta.url);
  const readers = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js") && !p.endsWith("web-bot-auth.js") && /(\.|\[["'`])(visaCliAgent|webBotAuth)\b/.test(readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1"))) readers.push(p); } };
  walk(fileURLToPath(src));
  ok(readers.length === 0, `no module but web-bot-auth.js reads req.webBotAuth or req.visaCliAgent (${readers.join(", ") || "none"})`);
}

// --- a paid boot: a verified signature is answered as no signature -----------------
{
  const out = join(tmpdir(), `visa-tap-${process.pid}.jsonl`);
  writeFileSync(out, "");
  const BASE = "https://agent402.example.test";
  const srv = await bootPaidServer({
    label: "visa-tap", args: ["--import", "./scripts/lib/tap-registry-preload.js"],
    env: { BASE_URL: BASE, WEB_BOT_AUTH: "on", POSTHOG_API_KEY: "", TAP_TEST_REGISTRY: JSON.stringify({ [JKT]: listing() }), TAP_TEST_OUT: out },
  });
  clock = Date.now();
  const SURFACES = [["GET", "/api/uuid"], ["POST", "/api/hash", { text: "a", algorithm: "sha256" }], ["GET", "/api/whois?domain=example.com"], ["POST", "/api/my-usage", {}], ["POST", "/api/memory", { key: "k", value: "v" }]];
  const readAll = async (signed) => {
    const res = {};
    for (const [m, p, b] of SURFACES) {
      const body = b ? JSON.stringify(b) : "";
      const [path, q] = p.split("?");
      const headers = { "content-type": "application/json" };
      if (signed) {
        clock = Date.now();
        const t = tap({ tag: signed, method: m, path, query: q ? `?${q}` : "", body, authority: new URL(BASE).host });
        for (const [k, v] of Object.entries(t.req.headers)) if (k !== "host" && k !== "content-length") headers[k] = v;
      }
      const r = await fetch(`${srv.url}${p}`, { method: m, headers, ...(body ? { body } : {}) });
      const text = await r.text();
      res[`${m} ${p}`] = { status: r.status, pr: r.headers.get("payment-required") || "", www: (r.headers.get("www-authenticate") || "").replace(/id="[^"]*"|expires="[^"]*"|challenge="[^"]*"/g, ""), body: createHash("sha256").update(text.replace(/"(generatedAt|asOf|now|updatedAt|ts|expires|id|challenge|nonce|salt|seed)":"[^"]*"/g, "")).digest("hex").slice(0, 12) };
    }
    return res;
  };
  let plain, warm, signedB, signedP, lines = [];
  try {
    plain = await readAll(null);
    warm = await readAll("agent-browser-auth"); // the first sight of the key schedules its registry read
    await tick(300);
    signedB = await readAll("agent-browser-auth");
    signedP = await readAll("agent-payer-auth");
    await tick(400);
    lines = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } finally { await srv.stop(); rmSync(out, { force: true }); }
  const verified = lines.filter((l) => l.event === "web_bot_auth" && l.verified === true && l.agent === "visa-cli").reduce((n, l) => n + (l.count || 0), 0);
  ok(lines.some((l) => l.registry === `https://auth.visacli.sh/v1/tap/registry/keys/${JKT}`), "control: the booted server read the key from the pinned registry origin");
  ok(verified >= SURFACES.length * 2, `control: the booted server verified the signed requests (${verified} verified)`);
  ok(warm && Object.keys(plain).length === SURFACES.length, "every surface answered");
  for (const k of Object.keys(plain)) {
    ok(JSON.stringify(plain[k]) === JSON.stringify(signedB[k]) && JSON.stringify(plain[k]) === JSON.stringify(signedP[k]), `${k}: a verified signature is answered as no signature (${plain[k].status})`);
  }
  ok(plain["GET /api/uuid"].status === 402 && plain["POST /api/my-usage"].status === 402, "control: unpaid calls answer 402 (proof of work and payment still apply)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
