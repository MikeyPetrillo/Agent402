// Web Bot Auth verification (src/web-bot-auth.js) and the switch-off identity
// of the public surfaces for this batch's three switches.
//
// The RFC 9421 Ed25519 example (Appendix B.2.6) verifies through our signature
// base; a request signed per the web-bot-auth draft verifies once its agent's
// key directory is cached, and each rule refuses its case (no tag, authority
// or agent not covered, expired, created ahead, too long a window, unknown
// key, another algorithm, a replayed nonce, an agent that is not https, an
// altered request); fetches are bounded; the middleware never refuses. Then a
// paid boot with every switch on and one with every switch off answer
// /api/pricing, /openapi.json, /llms.txt and the 402s of the identity-bound
// routes byte for byte alike, signed or not.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash, generateKeyPairSync, sign as cryptoSign, createPublicKey, verify as cryptoVerify, randomBytes } from "node:crypto";
import * as wba from "../src/web-bot-auth.js";
import { bootPaidServer } from "./lib/paid-boot.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// --- RFC 9421 B.2.6: our signature base reproduces the published signature ----
{
  const req = {
    method: "POST", originalUrl: "/foo?param=Value&Pet=dog", protocol: "https",
    headers: { host: "example.com", date: "Tue, 20 Apr 2021 02:07:55 GMT", "content-type": "application/json", "content-length": "18" },
  };
  const input = 'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
  const parsed = wba.readSignatureHeaders({ "signature-input": input, signature: "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:" });
  const base = wba.signatureBase(req, parsed.inputs.get("sig-b26"), parsed, "sig-b26");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" }, format: "jwk" });
  ok(base && cryptoVerify(null, Buffer.from(base), key, parsed.sigs.get("sig-b26").v), "the RFC 9421 B.2.6 Ed25519 example verifies through our signature base");
  ok(wba.ed25519Thumbprint("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo") === "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "the RFC 8037 A.3 thumbprint example");
}

// --- a draft-shaped signer ---------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const X = publicKey.export({ format: "jwk" }).x;
const KID = wba.ed25519Thumbprint(X);
const other = generateKeyPairSync("ed25519");
const AGENT = "https://agent.example.test";
const DIRECTORY = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: X, kid: KID }] });
let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
const now = () => clock;
const nowS = () => Math.floor(clock / 1000);

function signed({ path = "/api/pricing", host = "agent402.example.test", agent = `"${AGENT}"`, agentKey = true, components, created = nowS(), expires = nowS() + 300, keyid = KID, alg = "ed25519", tag = "web-bot-auth", nonce, key = privateKey, alter } = {}) {
  const comps = components || ['"@authority"', agentKey ? '"signature-agent";key="sig1"' : '"signature-agent"'];
  const params = `;created=${created};expires=${expires};keyid="${keyid}"${alg ? `;alg="${alg}"` : ""}${nonce ? `;nonce="${nonce}"` : ""}${tag ? `;tag="${tag}"` : ""}`;
  const inner = `(${comps.join(" ")})${params}`;
  const agentHeader = agentKey ? `sig1=${agent}` : agent;
  const lines = comps.map((c) => {
    if (c === '"@authority"') return `"@authority": ${host}`;
    if (c === '"@method"') return `"@method": GET`;
    if (c === '"@path"') return `"@path": ${path}`;
    if (c.startsWith('"signature-agent"')) return `${c}: ${agent}`;
    throw new Error(c);
  });
  lines.push(`"@signature-params": ${inner}`);
  const sig = cryptoSign(null, Buffer.from(lines.join("\n")), key).toString("base64");
  const headers = { host: alter?.host || host, "signature-input": `sig1=${inner}`, signature: `sig1=:${sig}:`, "signature-agent": agentHeader };
  return { method: "GET", originalUrl: path, protocol: "https", headers };
}

{
  const fetched = [];
  const notes = [];
  const v = wba.createWebBotAuth({ now, fetchDirectory: async (u) => { fetched.push(u); return DIRECTORY; }, note: (n) => notes.push(n) });
  let r = v.check(signed());
  ok(r.verified === false && r.reason === "directory-pending", "first sight of an agent: unverified, directory fetch scheduled");
  await new Promise((res) => setTimeout(res, 20));
  ok(fetched.length === 1 && fetched[0] === `${AGENT}/.well-known/http-message-signatures-directory`, "the directory is the agent origin's well-known path");
  r = v.check(signed());
  ok(r.verified === true && r.agent === AGENT && r.keyid === KID, "a draft-shaped signature verifies and names its agent");
  ok(v.check(signed({ agentKey: false })).verified === true, "the legacy bare-string Signature-Agent is read");
  ok(v.check(signed({ alter: { host: "evil.example.test" } })).reason === "bad-signature", "a request for another authority fails the signature");
  ok(v.check(signed({ key: other.privateKey })).reason === "bad-signature", "a signature by another key fails");
  ok(v.check(signed({ tag: "other" })).reason === "no-web-bot-auth-tag", "a signature without the web-bot-auth tag is not read");
  ok(v.check(signed({ components: ['"@path"', '"signature-agent";key="sig1"'] })).reason === "authority-not-covered", "authority not covered: refused");
  ok(v.check(signed({ components: ['"@authority"'] })).reason === "signature-agent-not-covered", "Signature-Agent not covered: refused");
  ok(v.check(signed({ created: nowS() - 600, expires: nowS() - 1 })).reason === "expired", "an expired signature is refused");
  ok(v.check(signed({ created: nowS() + 600 })).reason === "created-in-future", "created in the future is refused");
  ok(v.check(signed({ created: nowS() - 10, expires: nowS() + 90_000 })).reason === "window-too-long", "a window over 24 hours is refused");
  ok(v.check(signed({ keyid: "x".repeat(43) })).reason === "unknown-key", "a keyid not in the directory is refused");
  ok(v.check(signed({ alg: "rsa-pss-sha512" })).reason === "unsupported-alg", "another algorithm is not read");
  ok(v.check(signed({ alg: null })).verified === true, "alg may be omitted");
  ok(v.check(signed({ agent: '"http://agent.example.test"' })).reason === "agent-not-https", "an agent that is not https is refused");
  ok(v.check(signed({ agent: '"https://10.0.0.1"' })).reason === "agent-not-https", "an agent named by address is refused");
  const nonce = randomBytes(16).toString("base64url");
  ok(v.check(signed({ nonce })).verified === true && v.check(signed({ nonce })).reason === "replayed", "a nonce is accepted once");
  ok(v.check({ headers: { "signature-input": "((((", signature: "x" } }).reason === "malformed", "malformed headers are refused without throwing");

  const mw = v.middleware();
  let nexts = 0;
  const req = signed();
  mw(req, {}, () => nexts++);
  const plain = { headers: {} };
  mw(plain, {}, () => nexts++);
  ok(nexts === 2 && req.webBotAuth?.verified === true && plain.webBotAuth === undefined, "the middleware records the outcome on the request and always continues");
  ok(notes.length === 1 && notes[0].verified === true && notes[0].agent === AGENT, "the outcome is counted for analytics");

  const p = wba.directoryOf("https://agent.example.test/keys/dir.json?x=1#f");
  ok(p.fetchUrl === "https://agent.example.test/keys/dir.json?x=1" && p.identity === "https://agent.example.test/keys/dir.json", "a Signature-Agent with a path is fetched as given and recorded without its query");
  ok(wba.directoryOf("https://user:pw@agent.example.test") === null, "credentials in the agent URL are refused");
}
{
  // Bounded fetching: 30 a minute, 4 in flight, never awaited by a request.
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const v = wba.createWebBotAuth({ now, fetchDirectory: async () => { calls++; await gate; return DIRECTORY; }, note: () => {} });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) v.check(signed({ agent: `"https://a${i}.example.test"` }));
  ok(performance.now() - t0 < 500, "checks never wait on a directory fetch");
  await new Promise((r) => setTimeout(r, 10));
  ok(calls === 4, `at most 4 directory fetches at once (${calls})`);
  release();
  await new Promise((r) => setTimeout(r, 20));
  // Rounds that let each fetch finish, so only the per-minute budget can stop them.
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 4; i++) v.check(signed({ agent: `"https://b${round}-${i}.example.test"` }));
    await new Promise((r) => setTimeout(r, 5));
  }
  ok(calls === 30, `at most 30 directory fetches a minute (${calls})`);
  clock += 61_000;
  v.check(signed({ agent: '"https://next-minute.example.test"' }));
  await new Promise((r) => setTimeout(r, 5));
  ok(calls === 31, "the budget renews the next minute");
  const bad = wba.createWebBotAuth({ now, fetchDirectory: async () => { throw new Error("nope"); }, note: () => {} });
  bad.check(signed());
  await new Promise((r) => setTimeout(r, 10));
  ok(bad.check(signed()).reason === "directory-unavailable", "a failed directory fetch reads unavailable (not retried at once)");
  const keys = wba.keysFromDirectory(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: X, exp: nowS() - 1 }] }), clock);
  ok(keys.size === 0, "an expired directory key is not used");
}
{
  // Header readers are bounded on hostile input.
  const big = "a=(" + '"x" '.repeat(30_000) + ")";
  const t0 = performance.now();
  for (const v of [big, "(".repeat(100_000), '"'.repeat(100_000), "sig1=:" + "A".repeat(100_000), "a=1;" + "b;".repeat(50_000)]) wba.readSignatureHeaders({ "signature-input": v, signature: v, "signature-agent": v });
  ok(performance.now() - t0 < 200, "hostile header values are read in bounded time");
}

// --- switch-off identity of the public surfaces -----------------------------------
const SURFACES = [["GET", "/api/pricing"], ["GET", "/openapi.json"], ["GET", "/llms.txt"], ["POST", "/api/my-usage"], ["POST", "/api/receipts"], ["POST", "/api/memory"], ["GET", "/api/memory?key=k"]];
async function readAll(url, headers = {}) {
  const out = {};
  for (const [m, p] of SURFACES) {
    const r = await fetch(`${url}${p}`, { method: m, headers: { "content-type": "application/json", ...headers }, ...(m === "POST" ? { body: "{}" } : {}) });
    const body = await r.text();
    out[`${m} ${p}`] = { status: r.status, pr: r.headers.get("payment-required") || "", body: createHash("sha256").update(body.replace(/"(generatedAt|asOf|now|updatedAt|ts)":"[^"]*"/g, "")).digest("hex") };
  }
  return out;
}
{
  const common = { BASE_URL: "https://agent402.example.test", POSTHOG_API_KEY: "" };
  const off = await bootPaidServer({ label: "b9-off", env: { ...common, SIWE_SESSION_SECRET: "", WEB_BOT_AUTH: "" } });
  let a, b, c;
  try { a = await readAll(off.url); } finally { await off.stop(); }
  const on = await bootPaidServer({ label: "b9-on", env: { ...common, SIWE_SESSION_SECRET: randomBytes(32).toString("hex"), WEB_BOT_AUTH: "on" } });
  try {
    b = await readAll(on.url);
    const s = signed();
    c = await readAll(on.url, { "signature-input": s.headers["signature-input"], signature: s.headers.signature, "signature-agent": s.headers["signature-agent"] });
  } finally { await on.stop(); }
  for (const k of Object.keys(a)) {
    ok(JSON.stringify(a[k]) === JSON.stringify(b[k]), `${k}: switches on and off answer alike (${a[k].status})`);
    ok(JSON.stringify(b[k]) === JSON.stringify(c[k]), `${k}: a signed request is answered as an unsigned one`);
  }
  ok(a["POST /api/my-usage"].status === 402 && a["POST /api/my-usage"].pr, "control: the identity-bound route answers its 402 with an offer");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
